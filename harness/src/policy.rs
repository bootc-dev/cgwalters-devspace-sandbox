//! Answers `session/request_permission` from a policy file.
//!
//! The sandbox (an unprivileged user, later a container or VM) is the
//! security boundary; this policy is for keeping the agent away from
//! actions a task shouldn't take (`git push`, writes outside the work
//! tree) and for an audit trail: every decision is recorded in the ACP
//! transcript, with the rule that made it.
//!
//! ```toml
//! default = "allow"
//!
//! [[rule]]
//! name = "no-push"
//! decision = "deny"
//! kind = ["execute"]
//! command = '\bgit\b.*\bpush\b'
//!
//! [[rule]]
//! name = "writes-in-work-only"
//! decision = "deny"
//! kind = ["edit", "delete", "move"]
//! outside = ["/home/runner-sandbox/work"]
//! ```
//!
//! Rules are tried in order and the first one that matches decides; with
//! none, `default` does. Every condition a rule sets must hold:
//!
//! - `kind`: the tool call's ACP kind is one of these (`read`, `edit`,
//!   `delete`, `move`, `search`, `execute`, `think`, `fetch`,
//!   `switch_mode`, `other`);
//! - `command`: a regex that matches the command of an `execute` call;
//! - `paths`: some path the call touches is at or under one of these;
//! - `outside`: some path the call touches is under none of these, or
//!   the call names no paths at all (so a deny rule fails closed);
//! - `paths` never matches a call that names no paths.
//!
//! An allow is answered with the agent's "allow once" option, never
//! "allow always", so every call comes back to the policy; an agent that
//! offers no "allow once" gets a rejection instead.

use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// The tool call kinds ACP v1 defines.
const KINDS: &[&str] = &[
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
];
/// Keys of a tool call's `rawInput` that hold a path, across agents
/// (Claude Code uses `file_path`, opencode `filePath`).
pub const PATH_KEYS: &[&str] = &["file_path", "filePath", "notebook_path", "path"];
/// The `_meta` key under which the harness records its decision in the
/// permission response, so the transcript says why.
pub const META_KEY: &str = "botHarness";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Deny => "deny",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyFile {
    default: Decision,
    #[serde(default)]
    rule: Vec<RuleFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleFile {
    name: String,
    decision: Decision,
    #[serde(default)]
    kind: Vec<String>,
    command: Option<String>,
    #[serde(default)]
    paths: Vec<PathBuf>,
    #[serde(default)]
    outside: Vec<PathBuf>,
}

#[derive(Debug)]
struct Rule {
    name: String,
    decision: Decision,
    kinds: Vec<String>,
    command: Option<Regex>,
    paths: Vec<PathBuf>,
    outside: Vec<PathBuf>,
}

#[derive(Debug)]
pub struct Policy {
    default: Decision,
    rules: Vec<Rule>,
}

/// What a permission request asks for, taken from its `toolCall`.
#[derive(Debug, Default, PartialEq)]
pub struct Request {
    pub kind: String,
    pub title: String,
    pub command: Option<String>,
    /// Absolute and lexically normalized.
    pub paths: Vec<PathBuf>,
}

/// A decision and the rule that made it (`None`: the default).
#[derive(Debug, PartialEq)]
pub struct Verdict {
    pub decision: Decision,
    pub rule: Option<String>,
}

impl Policy {
    /// Allows everything; for runs without a policy file.
    pub fn allow_all() -> Self {
        Policy {
            default: Decision::Allow,
            rules: Vec::new(),
        }
    }

    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading the permission policy {}", path.display()))?;
        Self::parse(&text).with_context(|| format!("in the permission policy {}", path.display()))
    }

    pub fn parse(text: &str) -> Result<Self> {
        let file: PolicyFile = toml::from_str(text)?;
        let rules = file
            .rule
            .into_iter()
            .map(|r| {
                for kind in &r.kind {
                    if !KINDS.contains(&kind.as_str()) {
                        bail!(
                            "rule {}: unknown tool kind '{kind}' (one of: {})",
                            r.name,
                            KINDS.join(", ")
                        );
                    }
                }
                for p in r.paths.iter().chain(&r.outside) {
                    if !p.is_absolute() {
                        bail!("rule {}: path {} is not absolute", r.name, p.display());
                    }
                }
                let command = r
                    .command
                    .as_deref()
                    .map(Regex::new)
                    .transpose()
                    .with_context(|| format!("rule {}: bad command regex", r.name))?;
                Ok(Rule {
                    decision: r.decision,
                    kinds: r.kind,
                    command,
                    paths: r.paths.iter().map(|p| normalize(p)).collect(),
                    outside: r.outside.iter().map(|p| normalize(p)).collect(),
                    name: r.name,
                })
            })
            .collect::<Result<_>>()?;
        Ok(Policy {
            default: file.default,
            rules,
        })
    }

    pub fn decide(&self, req: &Request) -> Verdict {
        self.rules
            .iter()
            .find(|r| r.matches(req))
            .map(|r| Verdict {
                decision: r.decision,
                rule: Some(r.name.clone()),
            })
            .unwrap_or(Verdict {
                decision: self.default,
                rule: None,
            })
    }
}

impl Rule {
    fn matches(&self, req: &Request) -> bool {
        let under = |prefixes: &[PathBuf], p: &Path| prefixes.iter().any(|d| p.starts_with(d));
        (self.kinds.is_empty() || self.kinds.contains(&req.kind))
            && self
                .command
                .as_ref()
                .is_none_or(|re| req.command.as_deref().is_some_and(|c| re.is_match(c)))
            && (self.paths.is_empty() || req.paths.iter().any(|p| under(&self.paths, p)))
            && (self.outside.is_empty()
                || req.paths.is_empty()
                || req.paths.iter().any(|p| !under(&self.outside, p)))
    }
}

impl Request {
    /// From the params of a `session/request_permission` request; relative
    /// paths are taken relative to CWD.
    pub fn from_params(params: &Value, cwd: &Path) -> Self {
        let call = &params["toolCall"];
        let input = &call["rawInput"];
        let command = match &input["command"] {
            Value::String(s) => Some(s.clone()),
            Value::Array(a) => Some(
                a.iter()
                    .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            _ => None,
        };
        let locations = call["locations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| l["path"].as_str());
        let inputs = PATH_KEYS.iter().filter_map(|k| input[*k].as_str());
        let mut paths: Vec<PathBuf> = locations
            .chain(inputs)
            .map(|p| normalize(&cwd.join(p)))
            .collect();
        paths.sort();
        paths.dedup();
        Request {
            kind: call["kind"].as_str().unwrap_or("other").to_owned(),
            title: call["title"].as_str().unwrap_or_default().to_owned(),
            command,
            paths,
        }
    }
}

/// Resolves `.` and `..` lexically, so `/work/../etc` is `/etc`. Symlinks
/// are not followed: the agent can plant them, and this is not the
/// security boundary.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// The option to select for DECISION among a request's `options`, and
/// the decision it carries out. An allow takes only "allow once", so
/// every call is decided (and recorded) on its own: without one, the
/// call is rejected. None: no option fits, and the request is cancelled.
pub fn pick_option(options: &Value, decision: Decision) -> Option<(String, Decision)> {
    let options = options.as_array()?;
    let find = |kind: &str| {
        options
            .iter()
            .find(|o| o["kind"] == kind)
            .and_then(|o| o["optionId"].as_str())
            .map(str::to_owned)
    };
    let allow = match decision {
        Decision::Allow => find("allow_once").map(|id| (id, Decision::Allow)),
        Decision::Deny => None,
    };
    allow.or_else(|| {
        find("reject_once")
            .or_else(|| find("reject_always"))
            .map(|id| (id, Decision::Deny))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const POLICY: &str = r#"
default = "allow"

[[rule]]
name = "no-push"
decision = "deny"
kind = ["execute"]
command = '\bgit\b.*\bpush\b'

[[rule]]
name = "writes-in-work-only"
decision = "deny"
kind = ["edit", "delete", "move"]
outside = ["/home/sandbox/work", "/home/sandbox/out"]

[[rule]]
name = "no-ssh-keys"
decision = "deny"
paths = ["/home/sandbox/.ssh"]
"#;

    fn params(kind: &str, input: Value, locations: &[&str]) -> Value {
        json!({
            "sessionId": "s",
            "toolCall": {
                "toolCallId": "t",
                "title": "a tool",
                "kind": kind,
                "rawInput": input,
                "locations": locations.iter().map(|p| json!({"path": p})).collect::<Vec<_>>(),
            },
            "options": [],
        })
    }

    #[test]
    fn decide() {
        let policy = Policy::parse(POLICY).unwrap();
        let cwd = Path::new("/home/sandbox/work/repo");
        let cases = [
            (
                "execute",
                json!({"command": "cargo test"}),
                vec![],
                "allow",
                None,
            ),
            (
                "execute",
                json!({"command": "git push origin HEAD"}),
                vec![],
                "deny",
                Some("no-push"),
            ),
            (
                "execute",
                json!({"command": "cd x && git  push -f"}),
                vec![],
                "deny",
                Some("no-push"),
            ),
            (
                "execute",
                json!({"command": ["git", "push"]}),
                vec![],
                "deny",
                Some("no-push"),
            ),
            // Only execute calls are checked for commands.
            (
                "other",
                json!({"command": "git push"}),
                vec![],
                "allow",
                None,
            ),
            (
                "execute",
                json!({"command": "git pushy"}),
                vec![],
                "allow",
                None,
            ),
            (
                "execute",
                json!({"command": "git -C repo push"}),
                vec![],
                "deny",
                Some("no-push"),
            ),
            (
                "execute",
                json!({"command": "git -c a=b push"}),
                vec![],
                "deny",
                Some("no-push"),
            ),
            (
                "edit",
                json!({"file_path": "src/main.rs"}),
                vec![],
                "allow",
                None,
            ),
            (
                "edit",
                json!({}),
                vec!["/home/sandbox/out/outcome.json"],
                "allow",
                None,
            ),
            (
                "edit",
                json!({"filePath": "/etc/passwd"}),
                vec![],
                "deny",
                Some("writes-in-work-only"),
            ),
            // Lexically outside, whatever it's spelled like.
            (
                "edit",
                json!({"file_path": "../../../../etc/motd"}),
                vec![],
                "deny",
                Some("writes-in-work-only"),
            ),
            (
                "delete",
                json!({}),
                vec!["/home/sandbox/work/repo", "/tmp/x"],
                "deny",
                Some("writes-in-work-only"),
            ),
            // Reads anywhere, except where a later rule says.
            (
                "read",
                json!({"file_path": "/etc/os-release"}),
                vec![],
                "allow",
                None,
            ),
            (
                "read",
                json!({}),
                vec!["/home/sandbox/.ssh/id_ed25519"],
                "deny",
                Some("no-ssh-keys"),
            ),
            // No paths: `outside` fails closed, `paths` doesn't match.
            (
                "edit",
                json!({}),
                vec![],
                "deny",
                Some("writes-in-work-only"),
            ),
            ("read", json!({}), vec![], "allow", None),
        ];
        for (kind, input, locations, want, rule) in cases {
            let req = Request::from_params(&params(kind, input.clone(), &locations), cwd);
            let v = policy.decide(&req);
            assert_eq!(
                v.decision.as_str(),
                want,
                "{kind} {input} {locations:?}: {req:?}"
            );
            assert_eq!(v.rule.as_deref(), rule, "{kind} {input} {locations:?}");
        }
    }

    #[test]
    fn deny_by_default() {
        let policy = Policy::parse(
            "default = \"deny\"\n[[rule]]\nname = \"reads\"\ndecision = \"allow\"\nkind = [\"read\", \"search\"]\n",
        )
        .unwrap();
        let cwd = Path::new("/w");
        for (kind, want) in [
            ("read", "allow"),
            ("search", "allow"),
            ("execute", "deny"),
            ("fetch", "deny"),
        ] {
            let req = Request::from_params(&params(kind, json!({}), &[]), cwd);
            assert_eq!(policy.decide(&req).decision.as_str(), want, "{kind}");
        }
    }

    #[test]
    fn bad_policies() {
        let cases = [
            ("default = \"maybe\"", "unknown variant"),
            (
                "default = \"allow\"\n[[rule]]\nname = \"x\"\ndecision = \"deny\"\nkind = [\"exec\"]",
                "unknown tool kind 'exec'",
            ),
            (
                "default = \"allow\"\n[[rule]]\nname = \"x\"\ndecision = \"deny\"\ncommand = \"(\"",
                "bad command regex",
            ),
            (
                "default = \"allow\"\n[[rule]]\nname = \"x\"\ndecision = \"deny\"\npaths = [\"work\"]",
                "not absolute",
            ),
            (
                "default = \"allow\"\n[[rule]]\nname = \"x\"\ndecision = \"deny\"\nkinds = []",
                "unknown field",
            ),
        ];
        for (text, want) in cases {
            let err = format!("{:#}", Policy::parse(text).unwrap_err());
            assert!(err.contains(want), "{text:?}: {err}");
        }
    }

    #[test]
    fn options() {
        let options = json!([
            {"optionId": "always", "name": "Always", "kind": "allow_always"},
            {"optionId": "once", "name": "Allow", "kind": "allow_once"},
            {"optionId": "no", "name": "Reject", "kind": "reject_once"},
        ]);
        let only_always = json!([
            {"optionId": "a", "name": "Always", "kind": "allow_always"},
            {"optionId": "r", "name": "Reject", "kind": "reject_always"},
        ]);
        let no_reject = json!([{"optionId": "a", "name": "Always", "kind": "allow_always"}]);
        let cases = [
            (&options, Decision::Allow, Some(("once", Decision::Allow))),
            (&options, Decision::Deny, Some(("no", Decision::Deny))),
            // Never "allow always": reject instead.
            (&only_always, Decision::Allow, Some(("r", Decision::Deny))),
            (&no_reject, Decision::Allow, None),
            (&no_reject, Decision::Deny, None),
            (&json!(null), Decision::Allow, None),
        ];
        for (opts, decision, want) in cases {
            let got = pick_option(opts, decision);
            let got = got.as_ref().map(|(id, d)| (id.as_str(), *d));
            assert_eq!(got, want, "{opts} {decision:?}");
        }
    }
}
