//! A run's budget: its wall time, the model requests its caller counts
//! for it, and the subagent tasks it starts. An agent cancelled at a limit
//! hands back nothing, so it is told while it can still act: notices at
//! `CONVERGE` and `FINISH` percent of the most used limit, an interruption
//! near it (`HAND_BACK` percent of the time, `HAND_BACK_REQUESTS` before
//! the last model request) to write its outcome, and only then the stop.
//!
//! This is the arithmetic and the words; `run` delivers them over ACP.

use std::time::Duration;

use crate::run::Limits;

/// Percent of a limit at which the agent is told to converge.
pub const CONVERGE: u64 = 60;
/// Percent at which it is told to finish the smallest correct change.
pub const FINISH: u64 = 80;
/// Percent of the timeout at which its turn is interrupted to hand back.
pub const HAND_BACK: u64 = 95;
/// The model requests kept for handing back, of a cap that has four times
/// as many: the hand-back takes a few itself, and the caller's count lags
/// behind what subagents are doing by its polling interval.
pub const HAND_BACK_REQUESTS: u64 = 10;
/// The notice levels, highest first.
const NOTICES: [u64; 2] = [FINISH, CONVERGE];
/// What every message of the harness to the agent starts with, so that
/// the task brief can say what they are.
pub const NOTICE_PREFIX: &str = "[bot-harness budget notice]";
/// The labels of the notices that aren't a percentage.
pub const LABEL_LAST_TASK: &str = "last task";
pub const LABEL_HAND_BACK: &str = "hand back";

/// Why the harness stopped the session.
#[derive(Debug, Clone, PartialEq)]
pub enum Stop {
    Timeout,
    /// With what was used up, as the run's result says it.
    Budget(String),
}

/// What a run has used so far.
#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub elapsed: Duration,
    /// None when nothing counts them.
    pub requests: Option<u64>,
    pub tasks: usize,
}

/// What the budget asks for, from one look at the usage.
#[derive(Debug, Clone, PartialEq)]
pub enum Signal {
    /// Tell the agent, without interrupting it.
    Notice { label: String, text: String },
    /// Interrupt its turn and have it hand back within `window`.
    HandBack {
        why: Stop,
        text: String,
        window: Duration,
    },
    /// The limit itself: end the session.
    Stop(Stop),
}

/// How much of one limit is used.
struct Share {
    percent: u64,
    /// Near enough to the limit to hand back.
    hand_back: bool,
    /// "45m of 1h15m", "90 of 150 model requests".
    used: String,
    stop: Stop,
}

/// "42m", "1h05m" or "12s".
fn human(d: Duration) -> String {
    match d.as_secs() {
        s if s >= 3600 => format!("{}h{:02}m", s / 3600, s % 3600 / 60),
        s if s >= 60 => format!("{}m", s / 60),
        s => format!("{s}s"),
    }
}

#[derive(Debug)]
pub struct Budget {
    limits: Limits,
    /// The highest notice level sent.
    noticed: u64,
    last_task_noticed: bool,
    handing_back: bool,
}

impl Budget {
    pub fn new(limits: Limits) -> Self {
        Budget {
            limits,
            noticed: 0,
            last_task_noticed: false,
            handing_back: false,
        }
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(self.limits.timeout_s)
    }

    /// How long the agent gets to hand back: what is left of the timeout
    /// when it is interrupted for the time, and as much for another limit.
    pub fn hand_back_window(&self) -> Duration {
        self.timeout() * (100 - HAND_BACK) as u32 / 100
    }

    /// How much of each limit is used, for those that have a share: the
    /// model requests if something counts them, then the time.
    fn shares(&self, u: &Usage) -> Vec<Share> {
        let requests = self.limits.max_requests.zip(u.requests).map(|(max, n)| {
            let used = format!("{n} of {max} model requests");
            Share {
                percent: n.saturating_mul(100) / max.max(1),
                hand_back: n.saturating_add(HAND_BACK_REQUESTS.min(max / 4)) >= max,
                stop: Stop::Budget(format!("used {used}")),
                used,
            }
        });
        let timeout = self.timeout();
        let percent = (u.elapsed.as_millis() * 100 / timeout.as_millis().max(1)) as u64;
        let time = Share {
            percent,
            hand_back: percent >= HAND_BACK,
            used: format!("{} of {}", human(u.elapsed), human(timeout)),
            stop: Stop::Timeout,
        };
        requests.into_iter().chain([time]).collect()
    }

    /// The next thing to do about USAGE, if anything: one signal a call,
    /// each sent once.
    pub fn check(&mut self, u: &Usage) -> Option<Signal> {
        let shares = self.shares(u);
        // The most used one; the time, if they are level.
        let top = shares.iter().max_by_key(|s| s.percent)?;
        if top.percent >= 100 {
            return Some(Signal::Stop(top.stop.clone()));
        }
        if self.handing_back {
            return None;
        }
        let window = self.hand_back_window();
        if let Some(max) = self.limits.max_tasks
            && u.tasks > max
        {
            self.handing_back = true;
            let used = format!("started more than {max} subagent tasks");
            return Some(Signal::HandBack {
                text: hand_back_text(&used, window),
                why: Stop::Budget(used),
                window,
            });
        }
        if let Some(near) = shares.iter().find(|s| s.hand_back) {
            self.handing_back = true;
            return Some(Signal::HandBack {
                text: hand_back_text(&format!("used {}", near.used), window),
                why: near.stop.clone(),
                window,
            });
        }
        if let Some(level) = NOTICES.into_iter().find(|l| top.percent >= *l)
            && level > self.noticed
        {
            self.noticed = level;
            return Some(Signal::Notice {
                label: format!("{level}%"),
                text: notice_text(level, &top.used),
            });
        }
        if self.limits.max_tasks == Some(u.tasks) && !self.last_task_noticed {
            self.last_task_noticed = true;
            return Some(Signal::Notice {
                label: LABEL_LAST_TASK.to_owned(),
                text: last_task_text(u.tasks),
            });
        }
        None
    }
}

/// A notice is queued behind the agent's turn, so it must not read as a
/// new task or ask for an answer.
const KEEP_WORKING: &str =
    "This is not a new task and needs no reply: keep working on the task you were given.";

fn notice_text(level: u64, used: &str) -> String {
    let advice = if level >= FINISH {
        "Stop exploring: finish the smallest correct change, run the cheapest verification that \
         covers it, write your outcome as your task brief says and stop."
    } else {
        "Converge: start no new line of investigation, and work towards a change you can hand \
         back."
    };
    format!(
        "{NOTICE_PREFIX} This run has used {level}% of its budget ({used}). {advice} Near the \
         limit you are interrupted to hand back, and at the limit the session ends. \
         {KEEP_WORKING}"
    )
}

fn last_task_text(tasks: usize) -> String {
    format!(
        "{NOTICE_PREFIX} This run has started {tasks} subagent tasks, the most it may: do the \
         rest of the work yourself. Starting another one interrupts the run to hand back. \
         {KEEP_WORKING}"
    )
}

fn hand_back_text(used: &str, window: Duration) -> String {
    format!(
        "{NOTICE_PREFIX} This run has {used}, so your work was interrupted. Hand back now: \
         start nothing new and run no more builds or tests. Leave the working tree as the \
         partial change you want collected, write your outcome as your task brief says (what \
         is done, what is not, how to continue, and why you stopped early), then stop. The \
         session ends in {}; whatever isn't written by then is lost.",
        human(window)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(max_requests: Option<u64>, max_tasks: Option<usize>) -> Limits {
        Limits {
            timeout_s: 1000,
            max_requests,
            max_tasks,
            ..Limits::default()
        }
    }

    fn usage(secs: u64, requests: Option<u64>, tasks: usize) -> Usage {
        Usage {
            elapsed: Duration::from_secs(secs),
            requests,
            tasks,
        }
    }

    /// What a signal is, without its words.
    fn kind(s: Option<Signal>) -> String {
        match s {
            None => "-".to_owned(),
            Some(Signal::Notice { label, .. }) => label,
            Some(Signal::HandBack { why, .. }) => format!("hand back: {why:?}"),
            Some(Signal::Stop(why)) => format!("stop: {why:?}"),
        }
    }

    #[test]
    fn signals() {
        struct Case {
            name: &'static str,
            limits: Limits,
            /// Each usage in turn, and the signal it gives.
            steps: Vec<(Usage, &'static str)>,
        }
        let cases = [
            Case {
                name: "time",
                limits: limits(None, None),
                steps: vec![
                    (usage(599, None, 0), "-"),
                    (usage(600, None, 0), "60%"),
                    (usage(700, None, 0), "-"),
                    (usage(800, None, 0), "80%"),
                    (usage(949, None, 0), "-"),
                    (usage(950, None, 0), "hand back: Timeout"),
                    (usage(990, None, 0), "-"),
                    (usage(1000, None, 0), "stop: Timeout"),
                ],
            },
            Case {
                name: "the most used limit counts, and a skipped level isn't sent late",
                limits: limits(Some(100), None),
                steps: vec![
                    (usage(100, Some(59), 0), "-"),
                    (usage(100, Some(85), 0), "80%"),
                    (usage(650, Some(89), 0), "-"),
                    (
                        usage(650, Some(90), 0),
                        "hand back: Budget(\"used 90 of 100 model requests\")",
                    ),
                    (
                        usage(650, Some(100), 0),
                        "stop: Budget(\"used 100 of 100 model requests\")",
                    ),
                ],
            },
            Case {
                name: "a small cap keeps a quarter of it to hand back in",
                limits: limits(Some(8), None),
                steps: vec![
                    (usage(10, Some(5), 0), "60%"),
                    (
                        usage(10, Some(6), 0),
                        "hand back: Budget(\"used 6 of 8 model requests\")",
                    ),
                    (
                        usage(10, Some(8), 0),
                        "stop: Budget(\"used 8 of 8 model requests\")",
                    ),
                ],
            },
            Case {
                name: "the requests left count even when more of the time is used",
                limits: limits(Some(100), None),
                steps: vec![(
                    usage(940, Some(90), 0),
                    "hand back: Budget(\"used 90 of 100 model requests\")",
                )],
            },
            Case {
                name: "requests nobody counts have no share",
                limits: limits(Some(100), None),
                steps: vec![(usage(10, None, 0), "-")],
            },
            Case {
                name: "tasks",
                limits: limits(None, Some(2)),
                steps: vec![
                    (usage(10, None, 1), "-"),
                    (usage(10, None, 2), "last task"),
                    (usage(10, None, 2), "-"),
                    (
                        usage(10, None, 3),
                        "hand back: Budget(\"started more than 2 subagent tasks\")",
                    ),
                    (usage(10, None, 4), "-"),
                    (usage(1000, None, 4), "stop: Timeout"),
                ],
            },
        ];
        for c in cases {
            let mut b = Budget::new(c.limits);
            for (i, (u, want)) in c.steps.iter().enumerate() {
                assert_eq!(kind(b.check(u)), *want, "{}: step {i}", c.name);
            }
        }
    }

    #[test]
    fn words() {
        let mut b = Budget::new(limits(Some(100), None));
        let Some(Signal::Notice { text, .. }) = b.check(&usage(60, Some(60), 0)) else {
            panic!("no notice");
        };
        assert!(text.starts_with(NOTICE_PREFIX), "{text}");
        assert!(text.contains("60% of its budget (60 of 100 model requests)"));
        let Some(Signal::HandBack { text, window, .. }) = b.check(&usage(960, Some(60), 0)) else {
            panic!("no hand-back");
        };
        assert!(text.contains("used 16m of 16m"), "{text}");
        assert_eq!(window, Duration::from_secs(50));
        assert!(text.contains("ends in 50s"), "{text}");
    }
}
