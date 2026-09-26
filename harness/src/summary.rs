//! `bot-harness summary`: summary.json (agent-run-summary/v1, defined in
//! docs/devspace-agent-runs.md in cgwalters-bot/homegit) from a recorded
//! run: its `acp.jsonl` and `harness.json`, plus what the supervisor
//! measured (META), the agent's `outcome.json` and the inference proxy's
//! `token-usage.jsonl`.

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::Path;

use crate::digest::{Digest, cut};
use crate::run::{EXIT_TIMEOUT, Outcome, Record, RunResult};

pub const SCHEMA: &str = "agent-run-summary/v1";
/// summary.json lists at most this many of the slowest tool calls.
const MAX_SLOWEST: usize = 10;
/// The fields META passes through as they are.
const META_FIELDS: &[&str] = &[
    "run_id",
    "run_attempt",
    "run_url",
    "item",
    "repo",
    "base",
    "workflow",
    "agent",
    "cores",
    "started_at",
    "finished_at",
    "duration_s",
    "aic_budget",
    "aic_pricing",
    "files",
    "egress_denied",
    "redactions",
];

/// Reads a JSON Lines file; lines that aren't JSON are skipped.
pub fn read_jsonl<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Vec<T>> {
    let f = std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut out = Vec::new();
    for line in std::io::BufReader::new(f).lines() {
        let line = line.with_context(|| format!("reading {}", path.display()))?;
        if let Ok(v) = serde_json::from_str(&line) {
            out.push(v);
        }
    }
    Ok(out)
}

/// Replays a recorded session through the digest.
pub fn replay(records: &[Record]) -> Digest {
    let mut d = Digest::new();
    for r in records {
        if let Some(msg) = &r.msg {
            d.feed(r.ts, r.dir, msg);
        }
    }
    d.finish();
    d
}

/// Token counts from the inference proxy's log, one request per line:
/// (turns, tokens). A turn is a request that offered the model tools; side
/// calls (titles, summaries) don't count.
fn proxy_usage(log: &[Value]) -> (u64, Value) {
    let sum = |k: &str| log.iter().filter_map(|r| r[k].as_u64()).sum::<u64>();
    let turns = log
        .iter()
        .filter(|r| r["tools"] != Value::Bool(false))
        .count() as u64;
    let tokens = json!({
        "input": sum("input_tokens"),
        "output": sum("output_tokens"),
        "cache_read": sum("cache_read_input_tokens"),
        "cache_write": sum("cache_creation_input_tokens"),
    });
    (turns, tokens)
}

/// Token counts from the `session/prompt` response (a draft ACP field).
fn acp_usage(usage: &Value) -> Value {
    json!({
        "input": usage["inputTokens"],
        "output": usage["outputTokens"],
        "cache_read": usage["cachedReadTokens"],
        "cache_write": usage["cachedWriteTokens"],
    })
}

pub struct Inputs<'a> {
    pub records: &'a [Record],
    /// None when the harness never wrote one (it was killed).
    pub result: Option<&'a RunResult>,
    pub meta: &'a Value,
    pub outcome: &'a Value,
    /// None without an inference proxy log.
    pub usage_log: Option<&'a [Value]>,
}

pub fn summarize(i: &Inputs) -> Value {
    let d = replay(i.records);
    let result = match i.result {
        Some(r) => r.result,
        None if i.meta["exit_code"].as_i64() == Some(EXIT_TIMEOUT.into()) => Outcome::Timeout,
        None => Outcome::Failure,
    };
    let message = i.result.and_then(|r| r.message.clone());

    let (turns, tokens) = match (i.usage_log, &d.usage) {
        (Some(log), _) if !log.is_empty() => {
            let (turns, tokens) = proxy_usage(log);
            (json!(turns), tokens)
        }
        (_, Some(u)) => (Value::Null, acp_usage(u)),
        _ => (
            Value::Null,
            json!({"input": null, "output": null, "cache_read": null, "cache_write": null}),
        ),
    };

    let mut tools: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
    for c in &d.calls {
        let t = tools.entry(c.display_name()).or_default();
        t.0 += 1;
        t.1 += u64::from(c.error == Some(true));
        t.2 += c.duration_s.unwrap_or(0);
    }
    let tools: Map<String, Value> = tools
        .into_iter()
        .map(|(k, (calls, errors, secs))| {
            (
                k,
                json!({"calls": calls, "errors": errors, "duration_s": secs}),
            )
        })
        .collect();
    let mut timed: Vec<_> = d.calls.iter().filter(|c| c.duration_s.is_some()).collect();
    timed.sort_by_key(|c| std::cmp::Reverse(c.duration_s));
    let slowest: Vec<Value> = timed
        .iter()
        .take(MAX_SLOWEST)
        .map(
            |c| json!({"tool": c.display_name(), "summary": c.summary, "duration_s": c.duration_s}),
        )
        .collect();

    let mut failures: Vec<Value> = d
        .calls
        .iter()
        .filter(|c| c.error == Some(true))
        .map(|c| {
            let m = format!(
                "{}: {}",
                c.display_name(),
                c.message.as_deref().unwrap_or("")
            );
            json!({"kind": "tool_error", "message": cut(&m)})
        })
        .collect();
    let why = |default: &str| cut(message.as_deref().unwrap_or(default));
    match result {
        Outcome::Timeout => {
            failures.push(json!({"kind": "timeout", "message": why("the agent hit the timeout")}))
        }
        Outcome::Budget => {
            failures.push(json!({"kind": "budget", "message": why("the agent went over budget")}))
        }
        Outcome::Failure | Outcome::Cancelled => {
            failures.push(json!({"kind": "agent_exit", "message": why("the agent failed")}))
        }
        Outcome::Success => {}
    }

    let tests: Vec<Value> = i.outcome["tests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t.is_object())
        .map(|t| {
            let command = match &t["command"] {
                Value::String(s) => cut(s),
                other => cut(&other.to_string()),
            };
            json!({"command": command, "exit_code": t["exit_code"], "duration_s": t["duration_s"]})
        })
        .collect();

    let mut s = Map::new();
    s.insert("schema".into(), json!(SCHEMA));
    for k in META_FIELDS {
        s.insert((*k).into(), i.meta[*k].clone());
    }
    // The model the agent says the session runs (its model config option),
    // else the one dispatched.
    let model = d
        .model
        .clone()
        .map_or_else(|| i.meta["model"].clone(), Value::String);
    s.insert("model".into(), model);
    s.insert("result".into(), json!(result.as_str()));
    s.insert("turns".into(), turns);
    s.insert("tokens".into(), tokens);
    // USD to AIC (1 AIC = $0.01), to a tenth.
    let aic = d.cost_usd.map(|usd| (usd * 1000.0).round() / 10.0);
    s.insert("aic".into(), json!(aic));
    s.insert("tools".into(), Value::Object(tools));
    s.insert("slowest".into(), json!(slowest));
    s.insert("failures".into(), json!(failures));
    s.insert("tests".into(), json!(tests));
    s.insert(
        "outcome".into(),
        json!({"status": null, "url": null, "why": null}),
    );
    // Additions of the ACP harness (the schema allows new fields).
    s.insert("acp_protocol".into(), json!(d.protocol_version));
    s.insert("agent_version".into(), json!(d.agent));
    s.insert("stop_reason".into(), json!(d.stop_reason));
    let denied: Vec<Value> = d
        .denied
        .iter()
        .map(|x| json!({"tool": x.tool, "summary": x.summary, "rule": x.rule}))
        .collect();
    s.insert(
        "permissions".into(),
        json!({"allowed": d.allowed, "denied": denied}),
    );
    Value::Object(s)
}

/// "1.2M", "40k" or "386"; "?" when unknown.
fn human_count(v: &Value) -> String {
    match v.as_u64() {
        None => "?".to_owned(),
        Some(n) if n >= 1_000_000 => format!("{}M", (n / 100_000) as f64 / 10.0),
        Some(n) if n >= 1000 => format!("{}k", n / 1000),
        Some(n) => n.to_string(),
    }
}

/// "42m", "1h05m" or "12s"; "?" when unknown.
fn human_duration(v: &Value) -> String {
    match v.as_u64() {
        None => "?".to_owned(),
        Some(s) if s >= 3600 => format!("{}h{:02}m", s / 3600, s % 3600 / 60),
        Some(s) if s >= 60 => format!("{}m", s / 60),
        Some(s) => format!("{s}s"),
    }
}

/// A value as inline code, safe in a Markdown table cell: the agent
/// chooses tool names and titles, so they're never rendered as Markdown.
fn code(v: &Value) -> String {
    let s = v.as_str().map_or_else(|| v.to_string(), str::to_owned);
    format!("`{}`", s.replace('`', "'").replace('|', "\\|"))
}

fn text(v: &Value) -> String {
    v.as_str().map_or_else(|| v.to_string(), str::to_owned)
}

fn row(cells: &[String]) -> String {
    format!("| {} |", cells.join(" | "))
}

/// The run's step summary (summary.md) from its summary.json.
pub fn markdown(s: &Value) -> String {
    let or = |v: &Value, d: &str| if v.is_null() { d.to_owned() } else { text(v) };
    let mut out = vec![
        format!(
            "## Agent run: {} on {} ({})",
            text(&s["item"]),
            text(&s["repo"]),
            text(&s["base"])
        ),
        String::new(),
        format!(
            "{}/{}, {} cores: **{}**",
            text(&s["agent"]),
            or(&s["model"], "default"),
            text(&s["cores"]),
            text(&s["result"])
        ),
        String::new(),
        row(&["Duration", "Turns", "Tokens in/out", "Est. AIC"].map(str::to_owned)),
        "|---|---|---|---|".to_owned(),
        row(&[
            human_duration(&s["duration_s"]),
            or(&s["turns"], "?"),
            format!(
                "{} / {}",
                human_count(&s["tokens"]["input"]),
                human_count(&s["tokens"]["output"])
            ),
            format!(
                "{} of {} ({})",
                or(&s["aic"], "?"),
                or(&s["aic_budget"], "?"),
                text(&s["aic_pricing"])
            ),
        ]),
    ];
    if let Some(url) = s["outcome"]["url"].as_str() {
        out.extend([String::new(), format!("Result: {url}")]);
    }
    if let Some(tools) = s["tools"].as_object().filter(|t| !t.is_empty()) {
        out.extend([
            String::new(),
            "| Tool | Calls | Errors | Time |".to_owned(),
            "|---|---|---|---|".to_owned(),
        ]);
        let mut tools: Vec<_> = tools.iter().collect();
        tools.sort_by_key(|(_, t)| std::cmp::Reverse(t["calls"].as_u64()));
        for (name, t) in tools {
            out.push(row(&[
                code(&json!(name)),
                text(&t["calls"]),
                text(&t["errors"]),
                human_duration(&t["duration_s"]),
            ]));
        }
    }
    let list = |key: &str| s[key].as_array().filter(|a| !a.is_empty());
    if let Some(slowest) = list("slowest") {
        out.extend([
            String::new(),
            "Slowest tool calls:".to_owned(),
            String::new(),
        ]);
        out.extend(slowest.iter().map(|c| {
            format!(
                "- {} {}: {}",
                human_duration(&c["duration_s"]),
                code(&c["tool"]),
                code(&c["summary"])
            )
        }));
    }
    if let Some(failures) = list("failures") {
        out.extend([String::new(), "Failures:".to_owned(), String::new()]);
        out.extend(
            failures
                .iter()
                .map(|f| format!("- {}: {}", text(&f["kind"]), code(&f["message"]))),
        );
    }
    if let Some(denied) = s["permissions"]["denied"]
        .as_array()
        .filter(|a| !a.is_empty())
    {
        out.extend([
            String::new(),
            "Denied by the policy:".to_owned(),
            String::new(),
        ]);
        out.extend(denied.iter().map(|d| {
            format!(
                "- {}: {} ({})",
                code(&d["tool"]),
                code(&d["summary"]),
                d["rule"]
                    .as_str()
                    .map_or("default".to_owned(), |r| format!("rule {r}"))
            )
        }));
    }
    if let Some(tests) = list("tests") {
        out.extend([String::new(), "Tests:".to_owned(), String::new()]);
        out.extend(
            tests
                .iter()
                .map(|t| format!("- {}: exit {}", code(&t["command"]), text(&t["exit_code"]))),
        );
    }
    if let Some(denied) = list("egress_denied") {
        let domains: Vec<String> = denied
            .iter()
            .map(|d| {
                format!(
                    "{} ({})",
                    code(&json!(cut(&text(&d["domain"])))),
                    text(&d["count"])
                )
            })
            .collect();
        out.extend([
            String::new(),
            format!("Denied egress: {}", domains.join(", ")),
        ]);
    }
    if let Some(n) = s["redactions"].as_u64().filter(|n| *n > 0) {
        out.extend([String::new(), format!("Redacted {n} string(s).")]);
    }
    out.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::digest::Dir;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name)
    }

    fn meta(exit_code: i64) -> Value {
        json!({
            "run_id": 1, "run_attempt": 1, "run_url": "https://example.com/1", "item": "PVTI_x",
            "repo": "o/r", "base": "main", "workflow": "branch", "agent": "claude", "model": "m-default",
            "cores": 4, "started_at": "2026-09-25T00:00:00Z", "finished_at": "2026-09-25T00:01:00Z",
            "duration_s": 60, "exit_code": exit_code, "aic_budget": 500, "aic_pricing": "mock",
            "files": ["MOCK.md"], "egress_denied": [], "redactions": 2,
        })
    }

    fn rec(ts: f64, dir: Dir, msg: Value) -> Record {
        Record {
            ts,
            dir,
            msg: Some(msg),
            line: None,
        }
    }

    #[test]
    fn human_units() {
        for (n, count, duration) in [
            (json!(null), "?", "?"),
            (json!(12), "12", "12s"),
            (json!(386), "386", "6m"),
            (json!(40_500), "40k", "11h15m"),
            (json!(3_900), "3k", "1h05m"),
            (json!(1_234_567), "1.2M", "342h56m"),
            (json!(2_000_000), "2M", "555h33m"),
        ] {
            assert_eq!(
                (human_count(&n), human_duration(&n)),
                (count.into(), duration.into()),
                "{n}"
            );
        }
    }

    #[test]
    fn markdown_summary() {
        let s = json!({
            "item": "PVTI_x", "repo": "o/r", "base": "main", "agent": "fake", "model": null,
            "cores": 4, "result": "failure", "duration_s": 75, "turns": null,
            "tokens": {"input": 1500, "output": null}, "aic": 1.0, "aic_budget": 500,
            "aic_pricing": "mock", "outcome": {"url": null},
            "tools": {"Read": {"calls": 1, "errors": 0, "duration_s": 0},
                      "Bash": {"calls": 2, "errors": 1, "duration_s": 3}},
            "slowest": [{"tool": "Bash", "summary": "a | b `c`", "duration_s": 3}],
            "failures": [{"kind": "tool_error", "message": "Bash: boom"}],
            "permissions": {"allowed": 2, "denied": [{"tool": "Bash", "summary": "git push", "rule": "no-push"}]},
            "tests": [], "egress_denied": [], "redactions": 1,
        });
        assert_eq!(
            markdown(&s),
            "## Agent run: PVTI_x on o/r (main)

fake/default, 4 cores: **failure**

| Duration | Turns | Tokens in/out | Est. AIC |
|---|---|---|---|
| 1m | ? | 1k / ? | 1.0 of 500 (mock) |

| Tool | Calls | Errors | Time |
|---|---|---|---|
| `Bash` | 2 | 1 | 3s |
| `Read` | 1 | 0 | 0s |

Slowest tool calls:

- 3s `Bash`: `a \\| b 'c'`

Failures:

- tool_error: `Bash: boom`

Denied by the policy:

- `Bash`: `git push` (rule no-push)

Redacted 1 string(s).
"
        );
    }

    #[test]
    fn killed_harness() {
        // No harness.json: the supervisor's exit status decides.
        let records = [rec(
            0.0,
            Dir::Send,
            json!({"jsonrpc": "2.0", "id": 0, "method": "initialize"}),
        )];
        for (exit, want, kind) in [(124, "timeout", "timeout"), (137, "failure", "agent_exit")] {
            let m = meta(exit);
            let s = summarize(&Inputs {
                records: &records,
                result: None,
                meta: &m,
                outcome: &json!({}),
                usage_log: None,
            });
            assert_eq!(s["result"], want);
            assert_eq!(s["failures"][0]["kind"], kind);
            assert_eq!(s["model"], "m-default");
            assert_eq!(s["tokens"]["input"], Value::Null);
            assert_eq!(s["turns"], Value::Null);
        }
    }

    #[test]
    fn proxy_usage_counts() {
        let log = [
            json!({"input_tokens": 10, "output_tokens": 2, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "tools": true}),
            json!({"input_tokens": 5, "output_tokens": 1, "tools": false}),
            json!({"input_tokens": 20, "output_tokens": 3, "cache_read_input_tokens": 7}),
        ];
        let (turns, tokens) = proxy_usage(&log);
        assert_eq!(turns, 2);
        assert_eq!(
            tokens,
            json!({"input": 35, "output": 6, "cache_read": 7, "cache_write": 0})
        );
    }

    /// The recorded mock runs' condensed log, per agent (`bot-harness run`
    /// printed the same during the run).
    fn mock_run_log(
        tool: fn(&str) -> String,
        agent: &str,
        model: &str,
        exit0: &str,
    ) -> Vec<String> {
        let cwd = "/home/runner-sandbox/work/cgwalters-devspace-sandbox";
        let (bash, read, write) = (tool("Bash"), tool("Read"), tool("Write"));
        vec![
            format!("start: {agent}, {model}, in {cwd}"),
            "» Mock run: exercising the tools, the sandbox and the redaction pass.".into(),
            format!("▶ {bash}: git log --oneline -1 && id -un ({exit0}, 0s)"),
            format!("▶ {read}: README.md (ok, 0s)"),
            format!("▶ {bash}: sudo -n true (exit 1, 0s)"),
            format!("⚠ tool error: {bash}: sudo: a password is required"),
            format!(
                "▶ {bash}: curl -sS -m 10 -o /dev/null -w '%{{http_code}}\\n' http://169.254.169.254/ (exit 7, 0s)"
            ),
            format!(
                "⚠ tool error: {bash}: curl: (7) Failed to connect to 169.254.169.254 port 80 after 0 ms: Could not connect to server"
            ),
            format!(
                "▶ {bash}: printf 'mock secret: gh%s_%s\\n' p MOCKREDACTIONCANARY0123456789abcdef ({exit0}, 0s)"
            ),
            format!("✎ {write} MOCK.md"),
            format!("✎ {write} /home/runner-sandbox/out/outcome.json"),
            "» Done: the mock run finished.".into(),
            "done: end_turn, 7 tool calls".into(),
        ]
    }

    /// Runs of the real agents (claude-agent-acp and opencode) recorded by
    /// `bot-harness run` on a devspace, against a scripted Messages API
    /// mock and redacted as uploaded, and direct runs over the timeout and
    /// the tool call budget. They keep the harness honest about what real
    /// adapters send, which the fake agent only imitates.
    #[test]
    fn recorded_runs() {
        struct Case {
            dir: &'static str,
            result: &'static str,
            stop_reason: &'static str,
            /// (tool, calls, errors)
            tools: &'static [(&'static str, u64, u64)],
            /// The failures other than tool errors.
            failure: Option<(&'static str, &'static str)>,
            turns: Option<u64>,
            log: Option<Vec<String>>,
        }
        let claude_tools = &[("Bash", 4, 2), ("Read", 1, 0), ("Write", 2, 0)];
        let cases = [
            Case {
                dir: "claude",
                result: "success",
                stop_reason: "end_turn",
                tools: claude_tools,
                failure: None,
                turns: Some(8),
                log: Some(mock_run_log(
                    str::to_owned,
                    "@agentclientprotocol/claude-agent-acp 0.81.2",
                    "claude-sonnet-4-5",
                    "ok",
                )),
            },
            Case {
                dir: "opencode",
                result: "success",
                stop_reason: "end_turn",
                tools: &[("bash", 4, 2), ("read", 1, 0), ("write", 2, 0)],
                failure: None,
                turns: Some(8),
                log: Some(mock_run_log(
                    str::to_lowercase,
                    "OpenCode 1.18.31",
                    "mock/claude-sonnet-4-5",
                    "exit 0",
                )),
            },
            Case {
                dir: "claude-timeout",
                result: "timeout",
                stop_reason: "cancelled",
                tools: &[("Bash", 1, 0)],
                failure: Some(("timeout", "hit the timeout")),
                turns: None,
                log: None,
            },
            Case {
                dir: "claude-budget",
                result: "budget",
                stop_reason: "cancelled",
                tools: &[("Bash", 2, 0), ("Read", 1, 0)],
                failure: Some(("budget", "over budget: more than 2 tool calls")),
                turns: None,
                log: None,
            },
        ];
        for c in cases {
            let dir = c.dir;
            let base = fixture(dir);
            let records: Vec<Record> = read_jsonl(&base.join("acp.jsonl")).unwrap();
            let result = RunResult::load(&base).unwrap();
            let usage: Option<Vec<Value>> = c
                .turns
                .map(|_| read_jsonl(&base.join("token-usage.jsonl")).unwrap());
            let m = meta(result.result.exit_code().into());
            let s = summarize(&Inputs {
                records: &records,
                result: Some(&result),
                meta: &m,
                outcome: &json!({"tests": [{"command": "git log", "exit_code": 0, "duration_s": 0}, "junk"]}),
                usage_log: usage.as_deref(),
            });
            assert_eq!(s["schema"], SCHEMA, "{dir}");
            assert_eq!(s["result"], c.result, "{dir}: {s:#}");
            assert_eq!(s["stop_reason"], c.stop_reason, "{dir}");
            assert_eq!(s["acp_protocol"], 1, "{dir}");
            let tools: Vec<_> = s["tools"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| {
                    (
                        k.as_str(),
                        v["calls"].as_u64().unwrap(),
                        v["errors"].as_u64().unwrap(),
                    )
                })
                .collect();
            assert_eq!(tools, c.tools, "{dir}");
            let other: Vec<_> = s["failures"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|f| f["kind"] != "tool_error")
                .map(|f| (f["kind"].as_str().unwrap(), f["message"].as_str().unwrap()))
                .collect();
            assert_eq!(other, c.failure.into_iter().collect::<Vec<_>>(), "{dir}");
            assert_eq!(s["turns"].as_u64(), c.turns, "{dir}");
            if c.turns.is_some() {
                assert!(s["tokens"]["input"].as_u64().unwrap() > 0, "{dir}");
            } else {
                // Without the proxy's log, from the prompt response.
                assert!(s["tokens"]["output"].as_u64().unwrap() > 0, "{dir}: {s:#}");
            }
            assert_eq!(
                s["tests"],
                json!([{"command": "git log", "exit_code": 0, "duration_s": 0}])
            );
            for k in META_FIELDS {
                assert!(s.get(*k).is_some(), "{dir}: {k}");
            }
            if let Some(want) = c.log {
                let mut d = Digest::new();
                let mut lines = Vec::new();
                for r in &records {
                    lines.extend(d.feed(r.ts, r.dir, r.msg.as_ref().unwrap()));
                }
                lines.extend(d.finish());
                assert_eq!(lines, want, "{dir}");
            }
        }
    }
}
