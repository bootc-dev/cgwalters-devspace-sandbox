//! The registry of ACP agents (`agents.toml`): how to start each one's ACP
//! server on stdio, and how to tell it the model.
//!
//! ```toml
//! [claude]
//! command = ["claude-agent-acp"]
//! model-env = "ANTHROPIC_MODEL"
//!
//! [opencode]
//! command = ["opencode", "acp"]
//! ```
//!
//! An agent without `model-env` gets its model through its `model`
//! session config option (ACP's `session/set_config_option`).

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct AgentSpec {
    pub command: Vec<String>,
    /// Environment variables for the agent; never secrets, which behind a
    /// wrapper would be on the command line.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The environment variable that selects the agent's model.
    pub model_env: Option<String>,
}

fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Parses a registry and returns the entry NAME.
pub fn parse(text: &str, name: &str) -> Result<AgentSpec> {
    let mut agents: BTreeMap<String, AgentSpec> = toml::from_str(text)?;
    let known = agents.keys().cloned().collect::<Vec<_>>().join(", ");
    let spec = agents
        .remove(name)
        .ok_or_else(|| anyhow!("no agent '{name}' (known: {known})"))?;
    if spec.command.is_empty() {
        bail!("agent '{name}' has an empty command");
    }
    for var in spec.env.keys().chain(&spec.model_env) {
        if !valid_env_name(var) {
            bail!("agent '{name}': '{var}' is not a valid environment variable name");
        }
    }
    Ok(spec)
}

pub fn load(path: &Path, name: &str) -> Result<AgentSpec> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading the agent registry {}", path.display()))?;
    parse(&text, name).with_context(|| format!("in the agent registry {}", path.display()))
}

impl AgentSpec {
    /// The argv to spawn, and the environment to spawn it with. Behind a
    /// WRAPPER (a command such as `sudo run0 ... --` that runs its
    /// arguments elsewhere, and doesn't pass the environment on), env(1)
    /// sets the environment instead, and looks the command up in the
    /// wrapped PATH (run0 searches only its own).
    pub fn command(
        &self,
        wrapper: &[String],
        model: Option<&str>,
    ) -> (Vec<String>, BTreeMap<String, String>) {
        let mut env = self.env.clone();
        if let (Some(var), Some(model)) = (&self.model_env, model) {
            env.insert(var.clone(), model.to_owned());
        }
        if wrapper.is_empty() {
            return (self.command.clone(), env);
        }
        let mut argv = wrapper.to_vec();
        argv.push("env".to_owned());
        argv.extend(env.iter().map(|(k, v)| format!("{k}={v}")));
        argv.extend(self.command.iter().cloned());
        (argv, BTreeMap::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGISTRY: &str = r#"
[claude]
command = ["claude-agent-acp"]
model-env = "ANTHROPIC_MODEL"
env = { DISABLE_AUTOUPDATER = "1" }

[opencode]
command = ["opencode", "acp"]
"#;

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn commands() {
        let claude = parse(REGISTRY, "claude").unwrap();
        let opencode = parse(REGISTRY, "opencode").unwrap();
        let wrap = strings(&["sudo", "run0", "--"]);
        // (agent, wrapper, model, argv, environment)
        type Case<'a> = (
            &'a AgentSpec,
            &'a [String],
            Option<&'a str>,
            &'a [&'a str],
            &'a [(&'a str, &'a str)],
        );
        let cases: [Case; 5] = [
            (
                &claude,
                &[],
                None,
                &["claude-agent-acp"],
                &[("DISABLE_AUTOUPDATER", "1")],
            ),
            (
                &claude,
                &[],
                Some("m"),
                &["claude-agent-acp"],
                &[("ANTHROPIC_MODEL", "m"), ("DISABLE_AUTOUPDATER", "1")],
            ),
            (
                &claude,
                &wrap,
                Some("m"),
                &[
                    "sudo",
                    "run0",
                    "--",
                    "env",
                    "ANTHROPIC_MODEL=m",
                    "DISABLE_AUTOUPDATER=1",
                    "claude-agent-acp",
                ],
                &[],
            ),
            // The model is a session option: not in the environment.
            (&opencode, &[], Some("m"), &["opencode", "acp"], &[]),
            (
                &opencode,
                &wrap,
                None,
                &["sudo", "run0", "--", "env", "opencode", "acp"],
                &[],
            ),
        ];
        for (spec, wrapper, model, argv, env) in cases {
            let (a, e) = spec.command(wrapper, model);
            assert_eq!(a, strings(argv));
            let e: Vec<_> = e.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            assert_eq!(e, env);
        }
    }

    #[test]
    fn bad_registries() {
        let cases = [
            (
                REGISTRY,
                "codex",
                "no agent 'codex' (known: claude, opencode)",
            ),
            ("[a]\ncommand = []", "a", "empty command"),
            (
                "[a]\ncommand = [\"x\"]\nmodel-env = \"A=B\"",
                "a",
                "not a valid environment variable",
            ),
            (
                "[a]\ncommand = [\"x\"]\nenv = { \"1X\" = \"y\" }",
                "a",
                "not a valid environment variable",
            ),
            ("[a]\ncmd = [\"x\"]", "a", "unknown field"),
        ];
        for (text, name, want) in cases {
            let err = format!("{:#}", parse(text, name).unwrap_err());
            assert!(err.contains(want), "{text:?}: {err}");
        }
    }
}
