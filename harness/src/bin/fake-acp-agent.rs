//! fake-acp-agent: a scripted agent speaking the Agent Client Protocol on
//! stdio, with no model behind it. It plays a fixed session, so agent.yml
//! can run end to end (the harness, the sandbox, the permission policy and
//! the redaction pass) without inference or credentials, and bot-harness's
//! tests can drive it through what real agents don't readily do. It writes
//! the JSON-RPC by hand rather than through the SDK, so it can misbehave.
//!
//! ```text
//! fake-acp-agent demo          play the built-in session (fake-agent-demo.json)
//! fake-acp-agent script FILE   play the session in FILE
//! fake-acp-agent fs            send fs/* and terminal/* requests the client
//!                              doesn't advertise, expecting each answered
//! fake-acp-agent flood N       send N agent_message_chunk notifications
//! fake-acp-agent grace         make three tool calls, then ask permission
//!                              after the client must have cancelled the
//!                              session (run with --max-tool-calls 2)
//! fake-acp-agent slow-init     never answer initialize
//! ```
//!
//! A session is a JSON list of steps, run in order in `session/prompt`,
//! each tool call behind a `session/request_permission`:
//!
//! ```json
//! [{"say": "text"},
//!  {"execute": {"title": "Bash", "command": "git status"}},
//!  {"read": {"title": "Read", "path": "{cwd}/README.md", "lines": 5}},
//!  {"write": {"title": "Write", "path": "{cwd}/x", "content": "..."}},
//!  {"cost": {"usd": 0.01}}]
//! ```
//!
//! `{cwd}` is the session's working directory and `{home}` is `$HOME`.
//! Commands run with `sh -c` in the session's working directory.

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

const DEMO: &str = include_str!("../../fake-agent-demo.json");
const NAME: &str = "fake-acp-agent";
const SESSION: &str = "fake-session";
const MODEL_OPTION: &str = "model";
const DEFAULT_MODEL: &str = "fake";
/// How long a scripted request waits for the client's answer.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
/// How long `fs` mode waits for each answer: an unanswered request hangs.
const FS_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `grace` mode waits before its late permission request.
const GRACE_DELAY: Duration = Duration::from_secs(1);
const ALLOW: &str = "allow";
const REJECT: &str = "reject";

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum Step {
    Say(String),
    Execute {
        title: String,
        command: String,
    },
    Read {
        title: String,
        path: String,
        lines: Option<usize>,
    },
    Write {
        title: String,
        path: String,
        content: String,
    },
    Cost {
        usd: f64,
    },
}

enum Mode {
    Script(Vec<Step>),
    Fs,
    Flood(usize),
    Grace,
    SlowInit,
}

fn parse_mode(args: &[String]) -> Result<Mode> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(match args.as_slice() {
        ["demo"] => Mode::Script(parse_script(DEMO).context("in the built-in demo")?),
        ["script", file] => {
            let text = std::fs::read_to_string(file).with_context(|| format!("reading {file}"))?;
            Mode::Script(parse_script(&text).with_context(|| format!("in {file}"))?)
        }
        ["fs"] => Mode::Fs,
        ["flood", n] => Mode::Flood(n.parse().with_context(|| format!("flood: bad count {n}"))?),
        ["grace"] => Mode::Grace,
        ["slow-init"] => Mode::SlowInit,
        _ => bail!("usage: {NAME} demo | script FILE | fs | flood N | grace | slow-init"),
    })
}

fn parse_script(text: &str) -> Result<Vec<Step>> {
    Ok(serde_json::from_str(text)?)
}

/// The JSON-RPC connection to the client: stdout, and stdin read on a
/// thread so that waits can time out.
struct Conn {
    rx: Receiver<Value>,
    next_id: u64,
    /// The client sent session/cancel.
    cancelled: bool,
}

impl Conn {
    fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                match serde_json::from_str(&line) {
                    Ok(v) => {
                        if tx.send(v).is_err() {
                            break;
                        }
                    }
                    Err(e) => eprintln!("{NAME}: ignoring a line that isn't JSON: {e}"),
                }
            }
        });
        Conn {
            rx,
            next_id: 1,
            cancelled: false,
        }
    }

    fn send(&self, msg: Value) {
        let mut out = std::io::stdout().lock();
        // The client closing the pipe ends the run anyway.
        let _ = writeln!(out, "{msg}").and_then(|()| out.flush());
    }

    fn respond(&self, id: &Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn update(&self, update: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": SESSION, "update": update}}));
    }

    /// The next message, or None after TIMEOUT. Exits when the client
    /// closes stdin.
    fn recv(&mut self, timeout: Option<Duration>) -> Option<Value> {
        let msg = match timeout {
            None => self.rx.recv().ok(),
            Some(t) => match self.rx.recv_timeout(t) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => return None,
                Err(RecvTimeoutError::Disconnected) => None,
            },
        };
        let Some(msg) = msg else {
            std::process::exit(0);
        };
        if msg["method"] == "session/cancel" {
            self.cancelled = true;
        }
        Some(msg)
    }

    /// Takes in what the client sent meanwhile (a cancel), without waiting.
    fn poll(&mut self) {
        while self.recv(Some(Duration::ZERO)).is_some() {}
    }

    /// Sends a request and waits for its response; other messages in
    /// between are only noted (a cancel).
    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let end = Instant::now() + timeout;
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let msg = self
                .recv(Some(left))
                .ok_or_else(|| anyhow!("no response to {method} (request {id})"))?;
            if msg["id"] == id && msg.get("method").is_none() {
                return Ok(msg);
            }
        }
    }
}

fn model_options(current: &str) -> Value {
    json!([{
        "id": MODEL_OPTION, "name": "Model", "category": "model", "type": "select",
        "currentValue": current, "options": [{"value": current, "name": current}],
    }])
}

/// Serves requests until the client closes stdin, as a real agent does:
/// exiting after the prompt turn would race the client's cancel.
fn serve(conn: &mut Conn, mode: &Mode) -> Result<()> {
    let mut cwd = PathBuf::from(".");
    loop {
        let Some(msg) = conn.recv(None) else {
            unreachable!("recv without a timeout exits at the end of stdin")
        };
        let id = msg["id"].clone();
        match msg["method"].as_str() {
            Some("initialize") => {
                if matches!(mode, Mode::SlowInit) {
                    continue;
                }
                conn.respond(
                    &id,
                    json!({"protocolVersion": 1,
                        "agentInfo": {"name": NAME, "version": env!("CARGO_PKG_VERSION")}}),
                );
            }
            Some("session/new") => {
                if let Some(c) = msg["params"]["cwd"].as_str() {
                    cwd = PathBuf::from(c);
                }
                conn.respond(
                    &id,
                    json!({"sessionId": SESSION, "configOptions": model_options(DEFAULT_MODEL)}),
                );
            }
            Some("session/set_config_option") => {
                let value = msg["params"]["value"].as_str().unwrap_or(DEFAULT_MODEL);
                conn.respond(&id, json!({"configOptions": model_options(value)}));
            }
            Some("session/prompt") => {
                conn.cancelled = false;
                let stop = prompt(conn, mode, &cwd)?;
                conn.respond(&id, json!({"stopReason": stop}));
            }
            // Notifications (a cancel before the prompt) need no answer.
            _ if id.is_null() => {}
            Some(other) => conn.send(json!({"jsonrpc": "2.0", "id": id,
                "error": {"code": -32601, "message": format!("{NAME} doesn't handle {other}")}})),
            None => {}
        }
    }
}

/// Runs one prompt turn; returns its stop reason.
fn prompt(conn: &mut Conn, mode: &Mode, cwd: &Path) -> Result<&'static str> {
    match mode {
        Mode::Script(steps) => {
            let home = std::env::var("HOME").unwrap_or_default();
            let fill = |s: &str| {
                s.replace("{cwd}", &cwd.to_string_lossy())
                    .replace("{home}", &home)
            };
            for (i, step) in steps.iter().enumerate() {
                conn.poll();
                if conn.cancelled {
                    return Ok("cancelled");
                }
                play(conn, &format!("call-{i}"), step, cwd, &fill)?;
            }
        }
        Mode::Fs => {
            for (method, params) in [
                (
                    "fs/read_text_file",
                    json!({"sessionId": SESSION, "path": "/etc/passwd"}),
                ),
                (
                    "terminal/create",
                    json!({"sessionId": SESSION, "command": "id"}),
                ),
                ("fs/read_text_file", json!({"path": "/etc/passwd"})),
            ] {
                conn.request(method, params, FS_TIMEOUT)?;
            }
        }
        Mode::Flood(n) => {
            let chunk = "x".repeat(1000);
            for _ in 0..*n {
                conn.update(json!({"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": chunk}}));
            }
        }
        Mode::Grace => {
            for i in 0..3 {
                conn.update(
                    json!({"sessionUpdate": "tool_call", "toolCallId": format!("t{i}"),
                    "title": "Bash", "kind": "execute", "status": "pending",
                    "rawInput": {"command": "true"}}),
                );
            }
            std::thread::sleep(GRACE_DELAY);
            let call =
                json!({"toolCallId": "t2", "kind": "execute", "rawInput": {"command": "true"}});
            ask_permission(conn, call)?;
        }
        Mode::SlowInit => unreachable!("never gets a session"),
    }
    Ok(if conn.cancelled {
        "cancelled"
    } else {
        "end_turn"
    })
}

/// Asks the client's permission for a tool call: whether it was granted.
fn ask_permission(conn: &mut Conn, call: Value) -> Result<bool> {
    let answer = conn.request(
        "session/request_permission",
        json!({"sessionId": SESSION, "toolCall": call, "options": [
            {"optionId": ALLOW, "name": "Allow", "kind": "allow_once"},
            {"optionId": REJECT, "name": "Reject", "kind": "reject_once"},
        ]}),
        ANSWER_TIMEOUT,
    )?;
    let outcome = &answer["result"]["outcome"];
    Ok(outcome["outcome"] == "selected" && outcome["optionId"] == ALLOW)
}

fn text_content(text: &str) -> Value {
    json!([{"type": "content", "content": {"type": "text", "text": text}}])
}

/// Plays one step as tool call ID.
fn play(
    conn: &mut Conn,
    id: &str,
    step: &Step,
    cwd: &Path,
    fill: &dyn Fn(&str) -> String,
) -> Result<()> {
    let (title, kind, input) = match step {
        Step::Say(text) => {
            conn.update(json!({"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": text}}));
            return Ok(());
        }
        Step::Cost { usd } => {
            conn.update(
                json!({"sessionUpdate": "usage_update", "used": 0, "size": 0,
                "cost": {"amount": usd, "currency": "USD"}}),
            );
            return Ok(());
        }
        Step::Execute { title, command } => (title, "execute", json!({"command": fill(command)})),
        Step::Read { title, path, lines } => {
            (title, "read", json!({"path": fill(path), "lines": lines}))
        }
        Step::Write {
            title,
            path,
            content,
        } => (
            title,
            "edit",
            json!({"path": fill(path), "content": fill(content)}),
        ),
    };
    let call = json!({"toolCallId": id, "title": title, "kind": kind, "rawInput": input});
    let mut update = call.clone();
    update["sessionUpdate"] = json!("tool_call");
    update["status"] = json!("pending");
    conn.update(update);
    if !ask_permission(conn, call)? {
        conn.update(
            json!({"sessionUpdate": "tool_call_update", "toolCallId": id,
            "status": "failed", "content": text_content("The client refused permission")}),
        );
        return Ok(());
    }
    conn.update(
        json!({"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "in_progress"}),
    );
    let (ok, text, raw_output) = match step {
        Step::Execute { .. } => {
            let command = input["command"].as_str().unwrap_or_default();
            match Command::new("sh")
                .args(["-c", command])
                .current_dir(cwd)
                .output()
            {
                Ok(out) => {
                    let code = out.status.code().unwrap_or(-1);
                    let (stdout, stderr) = (
                        String::from_utf8_lossy(&out.stdout),
                        String::from_utf8_lossy(&out.stderr),
                    );
                    // A failure's first line is what the log shows: its error.
                    let text = if code == 0 {
                        format!("{stdout}{stderr}")
                    } else {
                        format!("{stderr}{stdout}")
                    };
                    (code == 0, text, json!({"exit_code": code}))
                }
                Err(e) => (false, format!("running sh: {e}"), Value::Null),
            }
        }
        Step::Read { lines, .. } => {
            let path = input["path"].as_str().unwrap_or_default();
            match std::fs::read_to_string(path) {
                Ok(t) => {
                    let n = lines.unwrap_or(usize::MAX);
                    (
                        true,
                        t.lines().take(n).collect::<Vec<_>>().join("\n"),
                        Value::Null,
                    )
                }
                Err(e) => (false, format!("reading {path}: {e}"), Value::Null),
            }
        }
        Step::Write { .. } => {
            let path = input["path"].as_str().unwrap_or_default();
            let content = input["content"].as_str().unwrap_or_default();
            match std::fs::write(path, content) {
                Ok(()) => (true, format!("wrote {path}"), Value::Null),
                Err(e) => (false, format!("writing {path}: {e}"), Value::Null),
            }
        }
        Step::Say(_) | Step::Cost { .. } => unreachable!("handled above"),
    };
    let mut done = json!({"sessionUpdate": "tool_call_update", "toolCallId": id,
        "status": if ok { "completed" } else { "failed" }, "content": text_content(&text)});
    if !raw_output.is_null() {
        done["rawOutput"] = raw_output;
    }
    conn.update(done);
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let r = parse_mode(&args).and_then(|mode| serve(&mut Conn::new(), &mode));
    if let Err(e) = r {
        eprintln!("{NAME}: error: {e:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_parses() {
        let steps = parse_script(DEMO).unwrap();
        assert!(matches!(steps.first(), Some(Step::Say(_))));
        assert!(steps.iter().any(|s| matches!(s, Step::Cost { .. })));
    }

    #[test]
    fn modes() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        for (argv, ok) in [
            (&["demo"][..], true),
            (&["fs"], true),
            (&["flood", "3"], true),
            (&["flood", "x"], false),
            (&["script"], false),
            (&["nope"], false),
            (&[], false),
        ] {
            assert_eq!(parse_mode(&args(argv)).is_ok(), ok, "{argv:?}");
        }
        let bad = r#"[{"say": "x"}, {"execute": {"command": "true"}}]"#;
        assert!(parse_script(bad).is_err());
    }
}
