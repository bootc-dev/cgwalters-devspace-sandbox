//! `bot-harness run`: one ACP session, from spawning the agent to its
//! result, recorded as it goes.
//!
//! The harness is not a sandbox. The only boundary between it and the
//! agent is the wrapper command (`bot-harness run ... -- WRAPPER`), which
//! agent.yml sets to run the agent as another user, in a login session of
//! its own.
//! Without a wrapper, the agent runs as the harness's user and inherits
//! its environment, which is only fit for local testing.
//!
//! When the session ends, the SDK kills the process group it spawned: the
//! wrapper's, or the agent's without one. Processes the agent started in
//! their own group (Claude Code's shell commands), or under a wrapper
//! that starts it elsewhere (run0), may outlive it: stopping those is the
//! sandbox's job (agent.yml kills the agent user's sessions, later a
//! container).

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, Implementation, InitializeRequest, NewSessionRequest,
    PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionConfigOptionCategory, SessionId,
    SetSessionConfigOptionRequest, TextContent,
};
use agent_client_protocol::{
    AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo, Dispatch, Handled, LineDirection,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

use crate::agents::AgentSpec;
use crate::digest::{Digest, Dir};
use crate::policy::{self, Policy, Request, pick_option};

/// The files `run` writes to its output directory.
pub const ACP_LOG: &str = "acp.jsonl";
pub const STDERR_LOG: &str = "agent-stderr.log";
pub const RESULT_FILE: &str = "harness.json";
pub const RESULT_SCHEMA: &str = "bot-harness-result/v1";
/// How long the agent gets to wind down after `session/cancel`.
const CANCEL_GRACE: Duration = Duration::from_secs(30);
const CLIENT_NAME: &str = "bot-harness";

/// Exit statuses of `bot-harness run`, by result.
pub const EXIT_FAILURE: i32 = 1;
pub const EXIT_BUDGET: i32 = 3;
/// As timeout(1).
pub const EXIT_TIMEOUT: i32 = 124;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Success,
    Failure,
    Timeout,
    Budget,
    Cancelled,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Success => "success",
            Outcome::Failure => "failure",
            Outcome::Timeout => "timeout",
            Outcome::Budget => "budget",
            Outcome::Cancelled => "cancelled",
        }
    }

    pub fn exit_code(self) -> i32 {
        match self {
            Outcome::Success => 0,
            Outcome::Timeout => EXIT_TIMEOUT,
            Outcome::Budget => EXIT_BUDGET,
            Outcome::Failure | Outcome::Cancelled => EXIT_FAILURE,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Limits {
    pub timeout_s: u64,
    /// In AIC (1 AIC = $0.01), from the agent's `usage_update` cost.
    pub budget_aic: Option<f64>,
    /// ACP reports tool calls, not model turns, so this is the turn budget.
    pub max_tool_calls: Option<usize>,
}

/// `harness.json`: what `run` did, for `bot-harness summary`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunResult {
    pub schema: String,
    pub agent: String,
    pub command: Vec<String>,
    pub result: Outcome,
    pub stop_reason: Option<String>,
    pub message: Option<String>,
    pub started_at: String,
    pub finished_at: String,
    pub duration_s: u64,
    pub limits: Limits,
}

impl RunResult {
    pub fn load(dir: &Path) -> Result<Self> {
        let path = dir.join(RESULT_FILE);
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }
}

/// One line of `acp.jsonl`: a JSON-RPC message as it crossed the pipe,
/// parsed (so re-serialized, with its keys in order), or the raw line if
/// it wasn't JSON.
#[derive(Debug, Serialize, Deserialize)]
pub struct Record {
    pub ts: f64,
    pub dir: Dir,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
}

/// Why the harness stopped the session.
#[derive(Debug, Clone)]
enum Stop {
    Timeout,
    Budget(String),
}

pub struct RunOptions {
    pub name: String,
    pub agent: AgentSpec,
    pub model: Option<String>,
    pub cwd: PathBuf,
    pub prompt: String,
    pub out: PathBuf,
    pub policy: Policy,
    pub limits: Limits,
    pub wrapper: Vec<String>,
}

fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

/// Sees every line on the agent's stdio: records it, feeds the digest
/// (which prints the condensed log to stdout) and checks the budget.
struct Tap {
    inner: Mutex<TapInner>,
    limits: Limits,
    stop: watch::Sender<Option<Stop>>,
}

struct TapInner {
    acp: BufWriter<File>,
    stderr: BufWriter<File>,
    digest: Digest,
    /// The first write error; the run fails with it.
    error: Option<String>,
}

impl Tap {
    fn create(out: &Path, limits: Limits, stop: watch::Sender<Option<Stop>>) -> Result<Self> {
        let open = |name: &str| -> Result<BufWriter<File>> {
            let path = out.join(name);
            Ok(BufWriter::new(
                File::create(&path).with_context(|| format!("creating {}", path.display()))?,
            ))
        };
        Ok(Tap {
            inner: Mutex::new(TapInner {
                acp: open(ACP_LOG)?,
                stderr: open(STDERR_LOG)?,
                digest: Digest::new(),
                error: None,
            }),
            limits,
            stop,
        })
    }

    fn line(&self, line: &str, direction: LineDirection) {
        let ts = now();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let dir = match direction {
            LineDirection::Stderr => {
                let r = writeln!(inner.stderr, "{line}").and_then(|()| inner.stderr.flush());
                inner.note(r);
                return;
            }
            LineDirection::Stdin => Dir::Send,
            LineDirection::Stdout => Dir::Recv,
        };
        let msg = serde_json::from_str::<Value>(line).ok();
        let record = Record {
            ts,
            dir,
            line: msg.is_none().then(|| line.to_owned()),
            msg,
        };
        let r = serde_json::to_writer(&mut inner.acp, &record)
            .map_err(std::io::Error::from)
            .and_then(|()| writeln!(inner.acp))
            .and_then(|()| inner.acp.flush());
        inner.note(r);
        if let Some(msg) = &record.msg {
            let lines = inner.digest.feed(ts, dir, msg);
            print_lines(&lines);
            if let Some(stop) = self.over_budget(&inner.digest) {
                self.stop.send_if_modified(|s| {
                    let first = s.is_none();
                    if first {
                        *s = Some(stop);
                    }
                    first
                });
            }
        }
    }

    fn over_budget(&self, d: &Digest) -> Option<Stop> {
        if let Some(max) = self.limits.max_tool_calls
            && d.calls.len() > max
        {
            return Some(Stop::Budget(format!("more than {max} tool calls")));
        }
        let aic = d.cost_usd? * 100.0;
        let budget = self.limits.budget_aic?;
        (aic > budget).then(|| Stop::Budget(format!("spent {aic:.1} of {budget} AIC")))
    }
}

impl TapInner {
    fn note(&mut self, r: std::io::Result<()>) {
        if let Err(e) = r {
            self.error
                .get_or_insert_with(|| format!("writing the transcript: {e}"));
        }
    }
}

fn print_lines(lines: &[String]) {
    let mut out = std::io::stdout().lock();
    for l in lines {
        // The job log is best effort; the transcript has everything.
        let _ = writeln!(out, "{l}");
    }
    let _ = out.flush();
}

fn rfc3339(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Runs the session and writes `harness.json`.
pub async fn run(opts: RunOptions) -> Result<RunResult> {
    std::fs::create_dir_all(&opts.out)
        .with_context(|| format!("creating {}", opts.out.display()))?;
    let (stop_tx, stop_rx) = watch::channel(None);
    let tap = Arc::new(Tap::create(
        &opts.out,
        opts.limits.clone(),
        stop_tx.clone(),
    )?);
    let (argv, env) = opts.agent.command(&opts.wrapper, opts.model.as_deref());
    let config = AcpAgentConfig::new(&argv[0]).args(&argv[1..]).envs(env);
    let t = tap.clone();
    let agent = AcpAgent::new(config).with_debug(move |line, dir| t.line(line, dir));

    let policy = Arc::new(opts.policy);
    let cwd = opts.cwd.clone();
    let permission_stop = stop_rx.clone();
    let started = chrono::Utc::now();
    let timer = {
        let stop = stop_tx.clone();
        let timeout = Duration::from_secs(opts.limits.timeout_s);
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            stop.send_if_modified(|s| {
                let first = s.is_none();
                if first {
                    *s = Some(Stop::Timeout);
                }
                first
            });
        })
    };
    let session = Client
        .builder()
        .name(CLIENT_NAME)
        .on_receive_request(
            async move |req: RequestPermissionRequest, responder, _cx| {
                let stopped = permission_stop.borrow().is_some();
                responder.respond(answer_permission(&policy, &cwd, &req, stopped))
            },
            agent_client_protocol::on_receive_request!(),
        )
        // Everything else the agent sends. The tap has already recorded
        // it; unhandled, the SDK would queue session-scoped messages for
        // a session handler forever (growing without bound, and leaving
        // fs/* and terminal/* requests, which the harness doesn't
        // advertise, unanswered until the timeout).
        .on_receive_dispatch(
            async move |d: Dispatch, _cx| match d {
                Dispatch::Request(req, responder) => {
                    let method = req.method().to_owned();
                    responder.respond_with_error(
                        agent_client_protocol::Error::method_not_found().data(method),
                    )?;
                    Ok(Handled::Yes)
                }
                Dispatch::Notification(_) => Ok(Handled::Yes),
                // Responses to the harness's own requests.
                other => Ok(Handled::No {
                    message: other,
                    retry: false,
                }),
            },
            agent_client_protocol::on_receive_dispatch!(),
        )
        .connect_with(agent, async |cx: ConnectionTo<Agent>| {
            Ok(session(
                cx,
                &opts.cwd,
                opts.model.as_deref(),
                opts.agent.model_env.is_some(),
                &opts.prompt,
                stop_rx,
            )
            .await)
        })
        .await;
    timer.abort();
    let finished = chrono::Utc::now();

    // An error is the transport's: usually the agent exited, and the
    // error has its stderr tail (as agent-stderr.log does).
    let Ended {
        mut outcome,
        mut stop_reason,
        mut message,
    } = session.unwrap_or_else(|e| Ended::failure(format!("the agent failed: {e}")));
    {
        let mut inner = tap.inner.lock().unwrap_or_else(|e| e.into_inner());
        let lines = inner.digest.finish();
        print_lines(&lines);
        if stop_reason.is_none() {
            stop_reason = inner.digest.stop_reason.clone();
        }
        if let Some(e) = inner.error.take() {
            outcome = Outcome::Failure;
            message = Some(e);
        }
        // Why it didn't succeed, unless the digest already said.
        if let (Outcome::Failure, Some(m)) = (outcome, &message)
            && inner.digest.error.is_none()
        {
            print_lines(&[crate::digest::cut(&format!("⚠ {m}"))]);
        }
    }
    let result = RunResult {
        schema: RESULT_SCHEMA.to_owned(),
        agent: opts.name,
        command: argv,
        result: outcome,
        stop_reason,
        message: message.map(|m| crate::digest::cut(&m)),
        started_at: rfc3339(started),
        finished_at: rfc3339(finished),
        duration_s: (finished - started).num_seconds().max(0) as u64,
        limits: opts.limits,
    };
    let path = opts.out.join(RESULT_FILE);
    std::fs::write(&path, serde_json::to_string_pretty(&result)? + "\n")
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(result)
}

/// Answers a permission request from the policy; once the harness has
/// stopped the session (STOPPED), every request is cancelled, as ACP
/// requires after session/cancel.
fn answer_permission(
    policy: &Policy,
    cwd: &Path,
    req: &RequestPermissionRequest,
    stopped: bool,
) -> RequestPermissionResponse {
    let params = serde_json::to_value(req).unwrap_or(Value::Null);
    let verdict = policy.decide(&Request::from_params(&params, cwd));
    let picked = if stopped {
        None
    } else {
        pick_option(&params["options"], verdict.decision)
    };
    let (outcome, decision) = match picked {
        Some((id, d)) => (
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
            d.as_str(),
        ),
        // Stopped, no option for the decision, or a malformed request.
        None => (RequestPermissionOutcome::Cancelled, "cancelled"),
    };
    let meta = json!({
        policy::META_KEY: {"decision": decision, "rule": verdict.rule},
    });
    let meta = match meta {
        Value::Object(m) => m,
        _ => unreachable!("a JSON object literal"),
    };
    RequestPermissionResponse::new(outcome).meta(meta)
}

/// How a session ended.
struct Ended {
    outcome: Outcome,
    stop_reason: Option<String>,
    message: Option<String>,
}

impl Ended {
    fn failure(message: String) -> Self {
        Ended {
            outcome: Outcome::Failure,
            stop_reason: None,
            message: Some(message),
        }
    }
}

/// Why the harness stopped a session, as its result.
fn stopped(why: &Stop) -> (Outcome, String) {
    match why {
        Stop::Timeout => (Outcome::Timeout, "hit the timeout".to_owned()),
        Stop::Budget(m) => (Outcome::Budget, format!("over budget: {m}")),
    }
}

/// Waits until the harness decides to stop the session.
async fn wait_stop(stop: &mut watch::Receiver<Option<Stop>>) -> Option<Stop> {
    stop.wait_for(Option::is_some)
        .await
        .ok()
        .and_then(|s| s.clone())
}

/// initialize, session/new, then one prompt, all raced against the
/// timeout and the budget.
async fn session(
    cx: ConnectionTo<Agent>,
    cwd: &Path,
    model: Option<&str>,
    model_by_env: bool,
    prompt: &str,
    mut stop: watch::Receiver<Option<Stop>>,
) -> Ended {
    let sid = tokio::select! {
        r = setup(&cx, cwd, model, model_by_env) => match r {
            Ok(sid) => sid,
            Err(ended) => return ended,
        },
        why = wait_stop(&mut stop) => {
            // No session to cancel yet: the process is killed on return.
            let Some(why) = why else {
                return Ended::failure("the harness lost its stop signal".to_owned());
            };
            let (outcome, msg) = stopped(&why);
            print_lines(&[format!("⚠ {msg} (starting the session)")]);
            return Ended { outcome, stop_reason: None, message: Some(msg) };
        }
    };
    let request = PromptRequest::new(
        sid.clone(),
        vec![ContentBlock::Text(TextContent::new(prompt.to_owned()))],
    );
    let mut response = std::pin::pin!(cx.send_request(request).block_task());
    let why = tokio::select! {
        r = &mut response => return prompt_result(r),
        why = wait_stop(&mut stop) => why,
    };
    let Some(why) = why else {
        return Ended::failure("the harness lost its stop signal".to_owned());
    };
    let (outcome, msg) = stopped(&why);
    print_lines(&[format!("⚠ {msg}")]);
    // Ask the agent to stop, and give it a moment to answer the prompt
    // (with stopReason "cancelled"); permission requests from here on are
    // cancelled. The caller then closes the connection, and the SDK kills
    // the process group it spawned.
    let _ = cx.send_notification(CancelNotification::new(sid));
    let _ = tokio::time::timeout(CANCEL_GRACE, &mut response).await;
    Ended {
        outcome,
        stop_reason: None,
        message: Some(msg),
    }
}

/// initialize, session/new and the model: the session's id, or how it
/// failed.
async fn setup(
    cx: &ConnectionTo<Agent>,
    cwd: &Path,
    model: Option<&str>,
    model_by_env: bool,
) -> Result<SessionId, Ended> {
    let fail =
        |what: &str, e: agent_client_protocol::Error| Ended::failure(format!("{what} failed: {e}"));
    // fs and terminal are left unadvertised (the defaults), so agents use
    // their own tools inside the sandbox; ACP v2 drops them anyway.
    let init = InitializeRequest::new(ProtocolVersion::V1)
        .client_info(Implementation::new(CLIENT_NAME, env!("CARGO_PKG_VERSION")));
    cx.send_request(init)
        .block_task()
        .await
        .map_err(|e| fail("initialize", e))?;
    let new = cx
        .send_request(NewSessionRequest::new(cwd))
        .block_task()
        .await
        .map_err(|e| fail("session/new", e))?;
    let sid = new.session_id;
    // Where the agent has no environment variable for it, the model is a
    // session config option.
    if let (Some(model), false) = (model, model_by_env) {
        let option = new
            .config_options
            .iter()
            .flatten()
            .find(|o| o.category == Some(SessionConfigOptionCategory::Model))
            .ok_or_else(|| {
                Ended::failure(format!(
                    "the agent has no model option to select {model} with"
                ))
            })?;
        let req = SetSessionConfigOptionRequest::new(sid.clone(), option.id.clone(), model);
        cx.send_request(req)
            .block_task()
            .await
            .map_err(|e| fail(&format!("selecting model {model}"), e))?;
    }
    Ok(sid)
}

fn prompt_result(
    r: Result<agent_client_protocol::schema::v1::PromptResponse, agent_client_protocol::Error>,
) -> Ended {
    match r {
        Err(e) => Ended::failure(format!("session/prompt failed: {e}")),
        Ok(resp) => {
            let reason = serde_json::to_value(resp.stop_reason)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned));
            let outcome = match reason.as_deref() {
                Some("end_turn") => Outcome::Success,
                Some("cancelled") => Outcome::Cancelled,
                // The agent's own turn limit.
                Some("max_turn_requests") => Outcome::Budget,
                _ => Outcome::Failure,
            };
            let message = (outcome != Outcome::Success)
                .then(|| format!("the agent stopped: {}", reason.as_deref().unwrap_or("?")));
            Ended {
                outcome,
                stop_reason: reason,
                message,
            }
        }
    }
}
