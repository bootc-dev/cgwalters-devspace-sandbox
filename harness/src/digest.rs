//! Follows an ACP session from its JSON-RPC messages, in both directions,
//! to produce the condensed log lines (one per event, for the job log) and
//! the numbers summary.json reports. It reads only the protocol, so it
//! works the same for every agent, and the same live as on a recorded
//! `acp.jsonl`.

use serde_json::Value;
use std::collections::HashMap;

use crate::policy::{self, PATH_KEYS};

/// Free text in log lines and the summary is cut to this many characters.
pub const MAX_TEXT: usize = 200;
/// Tool kinds whose calls the log shows as edits.
const EDIT_KINDS: &[&str] = &["edit", "delete", "move"];

/// Which way a message went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dir {
    /// From the harness to the agent.
    Send,
    /// From the agent to the harness.
    Recv,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub summary: String,
    pub start: f64,
    pub end: Option<f64>,
    /// Whole seconds, once it finished.
    pub duration_s: Option<u64>,
    pub error: Option<bool>,
    /// The first line of a failed call's output.
    pub message: Option<String>,
    title: String,
    /// The title the call started with: some agents (opencode) put the
    /// tool's name there.
    first_title: String,
    raw_input: Value,
    raw_output: Value,
    content: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Denial {
    pub tool: String,
    pub summary: String,
    pub rule: Option<String>,
}

#[derive(Debug, Default)]
pub struct Digest {
    cwd: String,
    /// Requests awaiting a response, by JSON-encoded id: the method, for
    /// requests either side sent, and the params of the agent's.
    sent: HashMap<String, String>,
    received: HashMap<String, (String, Value)>,
    /// The agent message not yet logged: only its first non-blank line
    /// is, so only that is kept, and only as much as the log shows.
    text: MessageLine,
    index: HashMap<String, usize>,
    pub calls: Vec<ToolCall>,
    pub agent: Option<String>,
    pub protocol_version: Option<u64>,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub stop_reason: Option<String>,
    /// The `session/prompt` response's usage, where the agent reports it.
    pub usage: Option<Value>,
    /// The error a request to the agent failed with.
    pub error: Option<String>,
    /// The session's cumulative cost in USD, from `usage_update`.
    pub cost_usd: Option<f64>,
    pub allowed: u64,
    pub denied: Vec<Denial>,
}

/// On one line (so nothing an agent writes can start a line of the job
/// log, and so act as a workflow command) and cut to MAX_TEXT characters.
pub fn cut(s: &str) -> String {
    let one: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if one.chars().count() > MAX_TEXT {
        let mut t: String = one.chars().take(MAX_TEXT - 1).collect();
        t.push('…');
        t
    } else {
        one
    }
}

fn first_line(s: &str) -> &str {
    s.lines().find(|l| !l.trim().is_empty()).unwrap_or("")
}

fn id_key(v: &Value) -> String {
    v.to_string()
}

/// The text of a tool call's `content`: its text blocks, joined.
fn content_text(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["content"]["text"].as_str().or(c["text"].as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A tool's output lines that say something: not blank, and not the
/// Markdown code fences some agents wrap output in.
fn output_lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("```"))
}

/// The line that says what went wrong: a failed shell command's output
/// often starts with "Exit code N", which the log line already shows.
fn error_line(text: &str) -> String {
    cut(output_lines(text)
        .find(|l| exit_code_line(l).is_none())
        .unwrap_or(""))
}

/// Claude Code starts a failed command's output with "Exit code N".
fn exit_code_line(line: &str) -> Option<i64> {
    line.strip_prefix("Exit code ")?.parse().ok()
}

/// A shell command's exit status, where the agent reports one: in its
/// output's first line, or in rawOutput (opencode: metadata.exit).
fn exit_status(text: &str, raw_output: &Value) -> Option<i64> {
    output_lines(text)
        .next()
        .and_then(exit_code_line)
        .or(raw_output["metadata"]["exit"].as_i64())
        .or(raw_output["exit_code"].as_i64())
}

/// A title that is a tool name rather than a description.
fn is_tool_name(title: &str) -> bool {
    !title.is_empty()
        && title
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

impl ToolCall {
    fn new(id: String, start: f64) -> Self {
        ToolCall {
            id,
            name: String::new(),
            kind: String::new(),
            summary: String::new(),
            start,
            end: None,
            duration_s: None,
            error: None,
            message: None,
            title: String::new(),
            first_title: String::new(),
            raw_input: Value::Null,
            raw_output: Value::Null,
            content: Value::Null,
        }
    }

    fn merge(&mut self, fields: &Value) {
        if let Some(t) = fields["title"].as_str() {
            self.title = t.to_owned();
            if self.first_title.is_empty() {
                self.first_title = t.to_owned();
            }
        }
        if let Some(k) = fields["kind"].as_str() {
            self.kind = k.to_owned();
        }
        if !fields["rawInput"].is_null() {
            self.raw_input = fields["rawInput"].clone();
        }
        if !fields["content"].is_null() {
            self.content = fields["content"].clone();
        }
        if !fields["rawOutput"].is_null() {
            self.raw_output = fields["rawOutput"].clone();
        }
        // ACP v1 has no tool name; `name` is a draft field, and agents put
        // theirs in _meta (claude-agent-acp: claudeCode.toolName).
        if let Some(n) = fields["name"]
            .as_str()
            .or(fields["_meta"]["claudeCode"]["toolName"].as_str())
        {
            self.name = n.to_owned();
        }
    }

    fn finish_summary(&mut self, cwd: &str) {
        let rel = |p: &str| {
            p.strip_prefix(cwd)
                .and_then(|r| r.strip_prefix('/'))
                .filter(|_| !cwd.is_empty())
                .unwrap_or(p)
                .to_owned()
        };
        let input = &self.raw_input;
        let summary = if let Some(c) = input["command"].as_str() {
            first_line(c).to_owned()
        } else if let Some(p) = PATH_KEYS.iter().find_map(|k| input[*k].as_str()) {
            rel(p)
        } else if let Some(p) = input["pattern"].as_str().or(input["url"].as_str()) {
            p.to_owned()
        } else {
            first_line(&self.title).to_owned()
        };
        self.summary = cut(&summary);
    }

    /// Its name, else its first title if that looks like a name, else its
    /// kind.
    pub fn display_name(&self) -> String {
        // The agent picks the name: keep it to one short line too.
        let name = if !self.name.is_empty() {
            &self.name
        } else if is_tool_name(&self.first_title) {
            &self.first_title
        } else if !self.kind.is_empty() {
            &self.kind
        } else {
            "tool"
        };
        cut(name)
    }
}

impl Digest {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one JSON-RPC message; returns the log lines it produced.
    pub fn feed(&mut self, ts: f64, dir: Dir, msg: &Value) -> Vec<String> {
        let mut out = Vec::new();
        let method = msg["method"].as_str();
        let id = msg.get("id").filter(|v| !v.is_null());
        match (dir, method, id) {
            // A request (or notification) the harness sent.
            (Dir::Send, Some(m), id) => {
                if let Some(id) = id {
                    self.sent.insert(id_key(id), m.to_owned());
                }
                match m {
                    "session/new" => {
                        if let Some(cwd) = msg["params"]["cwd"].as_str() {
                            self.cwd = cwd.to_owned();
                        }
                    }
                    "session/cancel" => {
                        self.flush_text(&mut out);
                        out.push("⚠ cancelling the session".to_owned());
                    }
                    _ => {}
                }
            }
            // The harness's response to a request of the agent's.
            (Dir::Send, None, Some(id)) => {
                if let Some((m, params)) = self.received.remove(&id_key(id))
                    && m == "session/request_permission"
                {
                    self.permission(&params, &msg["result"], &mut out);
                }
            }
            // A request or notification from the agent.
            (Dir::Recv, Some(m), id) => {
                if let Some(id) = id {
                    self.received
                        .insert(id_key(id), (m.to_owned(), msg["params"].clone()));
                }
                if m == "session/update" {
                    self.update(ts, &msg["params"]["update"], &mut out);
                }
            }
            // The agent's response to a request of the harness's.
            (Dir::Recv, None, Some(id)) => {
                if let Some(m) = self.sent.remove(&id_key(id)) {
                    self.response(&m, msg, &mut out);
                }
            }
            _ => {}
        }
        out
    }

    /// Logs what's left at the end of the session.
    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        self.flush_text(&mut out);
        out
    }

    fn response(&mut self, method: &str, msg: &Value, out: &mut Vec<String>) {
        if let Some(e) = msg.get("error") {
            let text = e["message"].as_str().unwrap_or("unknown error");
            let line = cut(&format!("{method} failed: {text}"));
            out.push(format!("⚠ {line}"));
            self.error.get_or_insert(line);
            return;
        }
        let result = &msg["result"];
        match method {
            "initialize" => {
                self.protocol_version = result["protocolVersion"].as_u64();
                let info = &result["agentInfo"];
                self.agent = info["name"]
                    .as_str()
                    .map(|n| match info["version"].as_str() {
                        Some(v) => format!("{n} {v}"),
                        None => n.to_owned(),
                    });
            }
            "session/new" => {
                self.session_id = result["sessionId"].as_str().map(str::to_owned);
                self.model = current_model(result);
                out.push(cut(&format!(
                    "start: {}, {}, in {}",
                    self.agent.as_deref().unwrap_or("unknown agent"),
                    self.model.as_deref().unwrap_or("default model"),
                    self.cwd
                )));
            }
            "session/set_config_option" => {
                if let Some(m) = current_model(result) {
                    self.model = Some(m);
                }
            }
            "session/prompt" => {
                self.flush_text(out);
                self.stop_reason = result["stopReason"].as_str().map(str::to_owned);
                if !result["usage"].is_null() {
                    self.usage = Some(result["usage"].clone());
                }
                out.push(cut(&format!(
                    "done: {}, {} tool calls",
                    self.stop_reason.as_deref().unwrap_or("?"),
                    self.calls.len()
                )));
            }
            _ => {}
        }
    }

    fn update(&mut self, ts: f64, update: &Value, out: &mut Vec<String>) {
        let kind = update["sessionUpdate"].as_str().unwrap_or_default();
        if kind != "agent_message_chunk" {
            self.flush_text(out);
        }
        match kind {
            "agent_message_chunk" => {
                if let Some(t) = update["content"]["text"].as_str() {
                    self.text.push(t);
                }
            }
            "tool_call" => {
                let id = update["toolCallId"].as_str().unwrap_or_default().to_owned();
                // A repeated tool_call updates the one already seen.
                let i = *self.index.entry(id.clone()).or_insert_with(|| {
                    self.calls.push(ToolCall::new(id, ts));
                    self.calls.len() - 1
                });
                self.calls[i].merge(update);
                self.tool_status(i, ts, update, out);
            }
            "tool_call_update" => {
                let id = update["toolCallId"].as_str().unwrap_or_default();
                if let Some(&i) = self.index.get(id) {
                    self.calls[i].merge(update);
                    self.tool_status(i, ts, update, out);
                }
            }
            "usage_update" => {
                // The budget is in AIC, so only a cost in USD counts.
                let cost = &update["cost"];
                if cost["currency"]
                    .as_str()
                    .is_none_or(|c| c.eq_ignore_ascii_case("USD"))
                    && let Some(a) = cost["amount"].as_f64()
                {
                    self.cost_usd = Some(a);
                }
            }
            "plan" => {
                let n = update["entries"].as_array().map_or(0, Vec::len);
                out.push(format!("plan: {n} entries"));
            }
            _ => {}
        }
    }

    fn tool_status(&mut self, i: usize, ts: f64, update: &Value, out: &mut Vec<String>) {
        let status = update["status"].as_str().unwrap_or_default();
        if !matches!(status, "completed" | "failed") || self.calls[i].end.is_some() {
            return;
        }
        let cwd = self.cwd.clone();
        let call = &mut self.calls[i];
        call.finish_summary(&cwd);
        let secs = (ts - call.start).max(0.0).floor() as u64;
        let text = content_text(&call.content);
        let exit = exit_status(&text, &call.raw_output);
        let failed = status == "failed" || exit.is_some_and(|n| n != 0);
        call.end = Some(ts);
        call.duration_s = Some(secs);
        call.error = Some(failed);
        let name = call.display_name();
        if EDIT_KINDS.contains(&call.kind.as_str()) && !failed {
            out.push(format!("✎ {name} {}", call.summary));
        } else {
            let note = match exit {
                Some(n) => format!("exit {n}"),
                None if failed => "error".to_owned(),
                None => "ok".to_owned(),
            };
            out.push(cut(&format!(
                "▶ {name}: {} ({note}, {secs}s)",
                call.summary
            )));
        }
        if failed {
            let message = error_line(&text);
            out.push(cut(&format!("⚠ tool error: {name}: {message}")));
            call.message = Some(message);
        }
    }

    fn permission(&mut self, params: &Value, result: &Value, out: &mut Vec<String>) {
        let selected = result["outcome"]["optionId"].as_str();
        let kind = params["options"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|o| o["optionId"].as_str() == selected && selected.is_some())
            .and_then(|o| o["kind"].as_str())
            .unwrap_or("cancelled");
        if kind.starts_with("allow") {
            self.allowed += 1;
            return;
        }
        let call = &params["toolCall"];
        let mut tc = ToolCall::new(String::new(), 0.0);
        // The permission request may carry less than the tool call.
        if let Some(i) = call["toolCallId"]
            .as_str()
            .and_then(|id| self.index.get(id))
        {
            tc = self.calls[*i].clone();
        }
        tc.merge(call);
        tc.finish_summary(&self.cwd.clone());
        let rule = result["_meta"][policy::META_KEY]["rule"]
            .as_str()
            .map(str::to_owned);
        let name = tc.display_name();
        out.push(cut(&format!(
            "⛔ denied {name}: {} ({})",
            tc.summary,
            rule.as_deref()
                .map_or("default".to_owned(), |r| format!("rule {r}"))
        )));
        self.denied.push(Denial {
            tool: name,
            summary: tc.summary,
            rule,
        });
    }

    fn flush_text(&mut self, out: &mut Vec<String>) {
        let text = std::mem::take(&mut self.text);
        if !text.line.trim().is_empty() {
            out.push(cut(&format!("» {}", text.line)));
        }
    }
}

/// The first non-blank line of a message streamed in chunks, in bounded
/// memory however long the message: at most MAX_TEXT characters and one
/// more, so cut() still marks it as cut.
#[derive(Debug, Default)]
struct MessageLine {
    line: String,
    chars: usize,
    /// The line has ended: the rest of the message is dropped.
    done: bool,
}

impl MessageLine {
    fn push(&mut self, chunk: &str) {
        for c in chunk.chars() {
            if self.done {
                return;
            }
            if c == '\n' {
                if self.line.trim().is_empty() {
                    self.line.clear();
                    self.chars = 0;
                } else {
                    self.done = true;
                }
            } else if self.chars <= MAX_TEXT {
                self.line.push(c);
                self.chars += 1;
            }
        }
    }
}

/// The model a session runs: its `model` config option (stable ACP), else
/// the draft `models` state.
fn current_model(result: &Value) -> Option<String> {
    result["configOptions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|o| o["category"] == "model")
        .and_then(|o| o["currentValue"].as_str())
        .or(result["models"]["currentModelId"].as_str())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cut_text() {
        assert_eq!(cut("a\nb\tc"), "a b c");
        let long = "x".repeat(300);
        let c = cut(&long);
        assert_eq!(c.chars().count(), MAX_TEXT);
        assert!(c.ends_with('…'));
        assert_eq!(
            cut("::error::x\r\n::warning::y"),
            "::error::x  ::warning::y"
        );
    }

    #[test]
    fn error_lines() {
        for (text, want) in [
            (
                "Exit code 1\nsudo: a password is required",
                "sudo: a password is required",
            ),
            ("\n\nboom\nmore", "boom"),
            ("Exit code 2", ""),
            (
                "```\nUser refused permission\n```",
                "User refused permission",
            ),
            ("", ""),
        ] {
            assert_eq!(error_line(text), want, "{text:?}");
        }
    }

    /// A session as the lines it logs, from (dir, message) pairs one
    /// second apart.
    fn lines(msgs: &[(Dir, Value)]) -> (Digest, Vec<String>) {
        let mut d = Digest::new();
        let mut out = Vec::new();
        for (i, (dir, m)) in msgs.iter().enumerate() {
            out.extend(d.feed(i as f64, *dir, m));
        }
        out.extend(d.finish());
        (d, out)
    }

    fn update(u: Value) -> (Dir, Value) {
        (
            Dir::Recv,
            json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": u}}),
        )
    }

    #[test]
    fn session() {
        let (d, out) = lines(&[
            (
                Dir::Send,
                json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}),
            ),
            (
                Dir::Recv,
                json!({"jsonrpc": "2.0", "id": 0, "result": {"protocolVersion": 1, "agentInfo": {"name": "a", "version": "1.0"}}}),
            ),
            (
                Dir::Send,
                json!({"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": {"cwd": "/w/r", "mcpServers": []}}),
            ),
            (
                Dir::Recv,
                json!({"jsonrpc": "2.0", "id": 1, "result": {"sessionId": "s", "models": {"currentModelId": "m1"}}}),
            ),
            (
                Dir::Send,
                json!({"jsonrpc": "2.0", "id": 2, "method": "session/prompt", "params": {}}),
            ),
            update(
                json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Hello "}}),
            ),
            update(
                json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "there\nsecond line"}}),
            ),
            update(
                json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Terminal", "kind": "execute", "status": "pending", "_meta": {"claudeCode": {"toolName": "Bash"}}}),
            ),
            update(
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "rawInput": {"command": "cargo test\n--all"}}),
            ),
            update(
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "content": [{"type": "content", "content": {"type": "text", "text": "ok"}}]}),
            ),
            update(
                json!({"sessionUpdate": "tool_call", "toolCallId": "t2", "title": "Write", "kind": "edit", "status": "in_progress", "rawInput": {"file_path": "/w/r/src/x.rs"}}),
            ),
            update(
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "t2", "status": "completed"}),
            ),
            update(
                json!({"sessionUpdate": "tool_call", "toolCallId": "t3", "title": "`sudo -n true`", "kind": "execute", "status": "pending", "rawInput": {"command": "sudo -n true"}, "_meta": {"claudeCode": {"toolName": "Bash"}}}),
            ),
            update(
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "t3", "status": "failed", "content": [{"type": "content", "content": {"type": "text", "text": "Exit code 1\nsudo: a password is required"}}]}),
            ),
            // A permission request, denied by a rule.
            (
                Dir::Recv,
                json!({"jsonrpc": "2.0", "id": 7, "method": "session/request_permission", "params": {"sessionId": "s", "toolCall": {"toolCallId": "t4", "title": "git push", "kind": "execute", "rawInput": {"command": "git push"}}, "options": [{"optionId": "y", "name": "Yes", "kind": "allow_once"}, {"optionId": "n", "name": "No", "kind": "reject_once"}]}}),
            ),
            (
                Dir::Send,
                json!({"jsonrpc": "2.0", "id": 7, "result": {"outcome": {"outcome": "selected", "optionId": "n"}, "_meta": {"botHarness": {"decision": "deny", "rule": "no-push"}}}}),
            ),
            (
                Dir::Recv,
                json!({"jsonrpc": "2.0", "id": 8, "method": "session/request_permission", "params": {"sessionId": "s", "toolCall": {"toolCallId": "t5", "title": "ls", "kind": "execute"}, "options": [{"optionId": "y", "name": "Yes", "kind": "allow_once"}]}}),
            ),
            (
                Dir::Send,
                json!({"jsonrpc": "2.0", "id": 8, "result": {"outcome": {"outcome": "selected", "optionId": "y"}}}),
            ),
            // opencode's shape: the name as the first title, the exit
            // status in rawOutput.
            update(
                json!({"sessionUpdate": "tool_call", "toolCallId": "t6", "title": "bash", "kind": "execute", "status": "pending"}),
            ),
            update(
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "t6", "status": "completed", "title": "false", "rawInput": {"command": "false"}, "rawOutput": {"output": "", "metadata": {"exit": 1}}}),
            ),
            update(
                json!({"sessionUpdate": "usage_update", "used": 10, "size": 100, "cost": {"amount": 0.25, "currency": "USD"}}),
            ),
            update(
                json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done."}}),
            ),
            (
                Dir::Recv,
                json!({"jsonrpc": "2.0", "id": 2, "result": {"stopReason": "end_turn", "usage": {"inputTokens": 5, "outputTokens": 7}}}),
            ),
        ]);
        assert_eq!(
            out,
            [
                "start: a 1.0, m1, in /w/r",
                "» Hello there",
                "▶ Bash: cargo test (ok, 2s)",
                "✎ Write src/x.rs",
                "▶ Bash: sudo -n true (exit 1, 1s)",
                "⚠ tool error: Bash: sudo: a password is required",
                "⛔ denied execute: git push (rule no-push)",
                "▶ bash: false (exit 1, 1s)",
                "⚠ tool error: bash: ",
                "» Done.",
                "done: end_turn, 4 tool calls",
            ]
        );
        assert_eq!(d.agent.as_deref(), Some("a 1.0"));
        assert_eq!(d.protocol_version, Some(1));
        assert_eq!(d.model.as_deref(), Some("m1"));
        assert_eq!(d.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(d.cost_usd, Some(0.25));
        assert_eq!(d.usage, Some(json!({"inputTokens": 5, "outputTokens": 7})));
        assert_eq!((d.allowed, d.denied.len()), (1, 1));
        assert_eq!(d.denied[0].rule.as_deref(), Some("no-push"));
        let calls: Vec<_> = d
            .calls
            .iter()
            .map(|c| (c.display_name(), c.summary.as_str(), c.duration_s, c.error))
            .collect();
        assert_eq!(
            calls,
            [
                ("Bash".into(), "cargo test", Some(2), Some(false)),
                ("Write".into(), "src/x.rs", Some(1), Some(false)),
                ("Bash".into(), "sudo -n true", Some(1), Some(true)),
                ("bash".into(), "false", Some(1), Some(true)),
            ]
        );
    }

    #[test]
    fn errors_and_cancel() {
        let (d, out) = lines(&[
            (
                Dir::Send,
                json!({"jsonrpc": "2.0", "id": 0, "method": "session/prompt", "params": {}}),
            ),
            update(
                json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "sleep", "kind": "execute", "status": "in_progress"}),
            ),
            (
                Dir::Send,
                json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "s"}}),
            ),
            (
                Dir::Recv,
                json!({"jsonrpc": "2.0", "id": 0, "error": {"code": -32603, "message": "Internal error\nat foo"}}),
            ),
        ]);
        assert_eq!(
            out,
            [
                "⚠ cancelling the session",
                "⚠ session/prompt failed: Internal error at foo"
            ]
        );
        assert_eq!(
            d.error.as_deref(),
            Some("session/prompt failed: Internal error at foo")
        );
        assert_eq!(d.calls[0].end, None);
    }

    #[test]
    fn message_first_line() {
        let long = "y".repeat(5 * MAX_TEXT);
        let cases: [(&[&str], Option<String>); 5] = [
            (&["Hello ", "there\nsecond"], Some("» Hello there".into())),
            (
                &["\n  \n", "", "first", " line\n", "more\n"],
                Some("» first line".into()),
            ),
            (&["   ", "\n"], None),
            (&[], None),
            (&[&long, "\nmore"], Some(cut(&format!("» {long}")))),
        ];
        for (chunks, want) in cases {
            let mut m = MessageLine::default();
            for c in chunks {
                m.push(c);
            }
            assert!(m.line.chars().count() <= MAX_TEXT + 1, "{chunks:?}");
            let mut d = Digest::new();
            d.text = m;
            assert_eq!(
                d.finish(),
                want.into_iter().collect::<Vec<_>>(),
                "{chunks:?}"
            );
        }
        // However much comes after the first line, nothing more is kept.
        let mut m = MessageLine::default();
        m.push("first\n");
        for _ in 0..1000 {
            m.push(&long);
        }
        assert_eq!((m.line.as_str(), m.done), ("first", true));
    }

    #[test]
    fn cost_currency() {
        for (cost, want) in [
            (json!({"amount": 0.5, "currency": "USD"}), Some(0.5)),
            (json!({"amount": 0.5}), Some(0.5)),
            (json!({"amount": 0.5, "currency": "EUR"}), None),
        ] {
            let (d, _) = lines(&[update(
                json!({"sessionUpdate": "usage_update", "used": 1, "size": 2, "cost": cost}),
            )]);
            assert_eq!(d.cost_usd, want, "{cost}");
        }
    }
}
