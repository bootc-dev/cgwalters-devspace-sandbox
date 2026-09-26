//! bot-harness against the scripted fake agent (src/bin/fake-acp-agent.rs):
//! a whole session through the permission policy and into summary.json,
//! and protocol behavior the real agents don't readily show.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const HARNESS: &str = env!("CARGO_BIN_EXE_bot-harness");
const FAKE_AGENT: &str = env!("CARGO_BIN_EXE_fake-acp-agent");

struct Run {
    status: i32,
    elapsed: Duration,
    /// The condensed log bot-harness printed.
    stdout: String,
    result: Value,
    /// acp.jsonl
    records: Vec<Value>,
    dir: tempfile::TempDir,
}

impl Run {
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// The first request of METHOD the agent sent.
    fn request(&self, method: &str) -> &Value {
        self.records
            .iter()
            .find(|r| r["dir"] == "recv" && r["msg"]["method"] == method)
            .unwrap_or_else(|| panic!("the agent sent no {method}"))
    }

    /// The harness's response to the agent's request ID.
    fn response_to(&self, id: &Value) -> &Value {
        self.records
            .iter()
            .find(|r| r["dir"] == "send" && &r["msg"]["id"] == id && r["msg"]["method"].is_null())
            .unwrap_or_else(|| panic!("no response to request {id}"))
    }
}

/// Runs bot-harness on the fake agent in MODE (its arguments), in a new
/// directory that holds `work/` (the agent's cwd), `out/` and FILES.
fn run(mode: &[&str], files: &[(&str, &str)], args: &[&str]) -> Run {
    let dir = tempfile::tempdir().unwrap();
    let path = |name: &str| -> PathBuf { dir.path().join(name) };
    let command: Vec<String> = std::iter::once(FAKE_AGENT)
        .chain(mode.iter().copied())
        .map(|a| a.replace("{dir}", &dir.path().to_string_lossy()))
        .collect();
    let registry = format!("[fake]\ncommand = {}\n", json!(command));
    std::fs::write(path("agents.toml"), registry).unwrap();
    std::fs::write(path("prompt.md"), "Do the fake task.\n").unwrap();
    std::fs::create_dir(path("work")).unwrap();
    for (name, content) in files {
        let content = content.replace("{dir}", &dir.path().to_string_lossy());
        std::fs::write(path(name), content).unwrap();
    }
    let start = Instant::now();
    let out = Command::new(HARNESS)
        .args(["run", "--agent", "fake"])
        .arg("--cwd")
        .arg(path("work"))
        .arg("--agents")
        .arg(path("agents.toml"))
        .arg("--prompt")
        .arg(path("prompt.md"))
        .arg("--out")
        .arg(path("out"))
        .args(
            args.iter()
                .map(|a| a.replace("{dir}", &dir.path().to_string_lossy())),
        )
        .output()
        .unwrap();
    let elapsed = start.elapsed();
    let read = |name: &str| std::fs::read_to_string(path("out").join(name)).unwrap();
    let result: Value = serde_json::from_str(&read("harness.json")).unwrap();
    let records = read("acp.jsonl")
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    Run {
        status: out.status.code().unwrap(),
        elapsed,
        stdout: String::from_utf8(out.stdout).unwrap(),
        result,
        records,
        dir,
    }
}

fn assert_result(r: &Run, status: i32, result: &str) {
    assert_eq!(
        (r.status, r.result["result"].as_str()),
        (status, Some(result)),
        "{:#}\n{}",
        r.result,
        r.stdout
    );
}

/// `bot-harness summary` of a run.
fn summary(r: &Run) -> Value {
    let meta = json!({"run_id": 1, "item": "PVTI_x", "repo": "o/r", "agent": "fake",
        "model": null, "exit_code": r.status, "files": [], "egress_denied": [], "redactions": 0});
    std::fs::write(r.path("meta.json"), meta.to_string()).unwrap();
    let out = Command::new(HARNESS)
        .arg("summary")
        .arg("--dir")
        .arg(r.path("out"))
        .arg("--meta")
        .arg(r.path("meta.json"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

const SCRIPT: &str = r#"[
  {"say": "Scripted."},
  {"execute": {"title": "Bash", "command": "echo hi > hi.txt"}},
  {"execute": {"title": "Bash", "command": "echo failing >&2; exit 3"}},
  {"execute": {"title": "Bash", "command": "git push origin main"}},
  {"read": {"title": "Read", "path": "{cwd}/hi.txt"}},
  {"write": {"title": "Write", "path": "{cwd}/new.txt", "content": "new\n"}},
  {"write": {"title": "Write", "path": "/elsewhere/x", "content": "x"}},
  {"cost": {"usd": 0.5}},
  {"say": "Done."}
]"#;

const POLICY: &str = r#"default = "allow"

[[rule]]
name = "no-push"
decision = "deny"
kind = ["execute"]
command = '\bgit\b.*\bpush\b'

[[rule]]
name = "writes-in-work-only"
decision = "deny"
kind = ["edit"]
outside = ["{dir}/work"]
"#;

#[test]
fn scripted_session() {
    let r = run(
        &["script", "{dir}/script.json"],
        &[("script.json", SCRIPT), ("policy.toml", POLICY)],
        &[
            "--timeout",
            "60s",
            "--permissions",
            "{dir}/policy.toml",
            "--budget-aic",
            "100",
        ],
    );
    assert_result(&r, 0, "success");
    let work = r.path("work");
    assert_eq!(
        std::fs::read_to_string(work.join("new.txt")).unwrap(),
        "new\n"
    );
    assert_eq!(
        std::fs::read_to_string(work.join("hi.txt")).unwrap(),
        "hi\n"
    );
    assert!(!Path::new("/elsewhere/x").exists());
    let log: Vec<&str> = r.stdout.lines().collect();
    assert_eq!(
        &log[1..],
        [
            "» Scripted.",
            "▶ Bash: echo hi > hi.txt (exit 0, 0s)",
            "▶ Bash: echo failing >&2; exit 3 (exit 3, 0s)",
            "⚠ tool error: Bash: failing",
            "⛔ denied Bash: git push origin main (rule no-push)",
            "▶ Bash: git push origin main (error, 0s)",
            "⚠ tool error: Bash: The client refused permission",
            "▶ Read: hi.txt (ok, 0s)",
            "✎ Write new.txt",
            "⛔ denied Write: /elsewhere/x (rule writes-in-work-only)",
            "▶ Write: /elsewhere/x (error, 0s)",
            "⚠ tool error: Write: The client refused permission",
            "» Done.",
            "done: end_turn, 6 tool calls",
        ],
        "{}",
        r.stdout
    );
    assert!(log[0].starts_with("start: fake-acp-agent "), "{}", log[0]);
    let s = summary(&r);
    assert_eq!(s["result"], "success");
    assert_eq!(s["model"], "fake");
    assert_eq!(s["aic"], 50.0);
    assert_eq!(
        s["tools"],
        json!({
            "Bash": {"calls": 3, "errors": 2, "duration_s": 0},
            "Read": {"calls": 1, "errors": 0, "duration_s": 0},
            "Write": {"calls": 2, "errors": 1, "duration_s": 0},
        })
    );
    assert_eq!(s["permissions"]["allowed"], 4);
    let rules: Vec<_> = s["permissions"]["denied"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["rule"].as_str().unwrap())
        .collect();
    assert_eq!(rules, ["no-push", "writes-in-work-only"]);
}

/// The cost the agent reports goes over the budget; the next tool call
/// asks permission after the harness cancelled the session.
const OVER_BUDGET: &str = r#"[
  {"cost": {"usd": 0.5}},
  {"execute": {"title": "Bash", "command": "touch after"}},
  {"say": "Not reached."}
]"#;

#[test]
fn reported_cost_over_budget() {
    let r = run(
        &["script", "{dir}/script.json"],
        &[("script.json", OVER_BUDGET)],
        &["--timeout", "60s", "--budget-aic", "10"],
    );
    assert_result(&r, 3, "budget");
    assert!(
        r.stdout.contains("⚠ over budget: spent 50.0 of 10 AIC"),
        "{}",
        r.stdout
    );
    assert!(!r.path("work/after").exists());
    assert!(!r.stdout.contains("Not reached"), "{}", r.stdout);
    let s = summary(&r);
    assert_eq!(
        s["failures"].as_array().unwrap().last().unwrap()["kind"],
        "budget"
    );
    assert_eq!(s["stop_reason"], "cancelled");
}

#[test]
fn unadvertised_requests_are_refused() {
    // Each would hang for the fake agent's 5s if left unanswered.
    let r = run(&["fs"], &[], &["--timeout", "60s"]);
    assert_result(&r, 0, "success");
    let requests: Vec<&Value> = r
        .records
        .iter()
        .filter(|x| {
            x["dir"] == "recv"
                && x["msg"]["method"]
                    .as_str()
                    .is_some_and(|m| m.starts_with("fs/") || m.starts_with("terminal/"))
        })
        .collect();
    assert_eq!(requests.len(), 3);
    for req in requests {
        let id = &req["msg"]["id"];
        assert_eq!(
            r.response_to(id)["msg"]["error"]["code"],
            -32601,
            "request {id}"
        );
    }
    assert!(r.elapsed < Duration::from_secs(5), "took {:?}", r.elapsed);
}

#[test]
fn update_flood() {
    // A smoke test: unhandled, these piled up in the SDK's retry queue,
    // which shows in memory (about 1 GB for 200k), not in the result.
    let r = run(&["flood", "20000"], &[], &["--timeout", "120s"]);
    assert_result(&r, 0, "success");
    assert!(r.records.len() > 20000);
}

#[test]
fn permission_after_cancel() {
    let r = run(
        &["grace"],
        &[],
        &["--timeout", "60s", "--max-tool-calls", "2"],
    );
    assert_result(&r, 3, "budget");
    let request = r.request("session/request_permission");
    let answer = &r.response_to(&request["msg"]["id"])["msg"]["result"];
    assert_eq!(answer["outcome"]["outcome"], "cancelled", "{answer}");
    assert_eq!(answer["_meta"]["botHarness"]["decision"], "cancelled");
    // The cancel went out before the request came in.
    let position = |pred: &dyn Fn(&Value) -> bool| r.records.iter().position(pred).unwrap();
    let cancel = position(&|x| x["msg"]["method"] == "session/cancel");
    let asked = position(&|x| std::ptr::eq(x, request));
    assert!(cancel < asked);
}

#[test]
fn timeout_before_the_session() {
    let r = run(&["slow-init"], &[], &["--timeout", "2s"]);
    assert_result(&r, 124, "timeout");
    assert!(r.elapsed < Duration::from_secs(10), "took {:?}", r.elapsed);
}
