//! bot-harness: run one task with any agent that speaks the Agent Client
//! Protocol (https://agentclientprotocol.com), recording the protocol
//! stream as the transcript, answering permission requests from a policy,
//! and enforcing a timeout and budget. `summary` then turns a recorded run
//! into summary.json for bot-runs.

mod agents;
mod digest;
mod policy;
mod run;
mod summary;

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    version,
    about = "Run an ACP agent on one task, recorded and within limits."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run AGENT on a prompt. Writes acp.jsonl (the protocol stream, both
    /// directions, timestamped, each message parsed), agent-stderr.log and
    /// harness.json to OUT,
    /// and prints the condensed transcript. Exits 0 on success, 124 on
    /// timeout, 3 over budget, 1 when the agent failed and 2 when the
    /// harness did.
    Run(RunArgs),
    /// Print summary.json (agent-run-summary/v1) for a run recorded in DIR,
    /// and optionally write its Markdown step summary.
    Summary(SummaryArgs),
}

#[derive(Args)]
struct RunArgs {
    /// The agent: an entry in the registry.
    #[arg(long)]
    agent: String,
    /// The agent registry.
    #[arg(long, default_value = "agents.toml")]
    agents: PathBuf,
    /// The model (default: the agent's own).
    #[arg(long)]
    model: Option<String>,
    /// The agent's working directory.
    #[arg(long)]
    cwd: PathBuf,
    /// A file with the task prompt ('-' for stdin).
    #[arg(long)]
    prompt: PathBuf,
    /// Where the run's files go.
    #[arg(long)]
    out: PathBuf,
    /// The permission policy (default: allow everything).
    #[arg(long)]
    permissions: Option<PathBuf>,
    /// Wall-clock limit, like 90m, 2h or 300s.
    #[arg(long, value_parser = parse_duration)]
    timeout: u64,
    /// Spend cap in AIC (1 AIC = $0.01), from the cost the agent reports.
    #[arg(long)]
    budget_aic: Option<f64>,
    /// Most tool calls the agent may make.
    #[arg(long)]
    max_tool_calls: Option<usize>,
    /// A command that runs the agent's argv elsewhere (for example as
    /// another user), such as `sudo run0 ... --`.
    ///
    /// The wrapper is the only boundary between the harness and the agent:
    /// without one, the agent runs as the harness's user and inherits its
    /// environment, which is only fit for local testing.
    #[arg(last = true)]
    wrapper: Vec<String>,
}

#[derive(Args)]
struct SummaryArgs {
    /// The run's output directory (acp.jsonl and harness.json).
    #[arg(long)]
    dir: PathBuf,
    /// A JSON object with what the supervisor measured: run_id,
    /// run_attempt, run_url, item, repo, base, workflow, agent, model,
    /// cores, started_at, finished_at, duration_s, exit_code, aic_budget,
    /// aic_pricing, files, egress_denied and redactions.
    #[arg(long)]
    meta: PathBuf,
    /// The agent's outcome.json.
    #[arg(long)]
    outcome: Option<PathBuf>,
    /// The inference proxy's per-request log.
    #[arg(long)]
    usage_log: Option<PathBuf>,
    /// Also write the summary as Markdown here, for the job's step summary.
    #[arg(long)]
    markdown: Option<PathBuf>,
}

/// "90m", "2h", "300s" or "300" (seconds).
fn parse_duration(s: &str) -> Result<u64, String> {
    let (num, unit) = match s.char_indices().last() {
        Some((i, c)) if c.is_ascii_alphabetic() => (&s[..i], c),
        _ => (s, 's'),
    };
    let n: u64 = num
        .parse()
        .map_err(|_| format!("'{s}' is not a duration like 90m"))?;
    let mult = match unit {
        's' => 1,
        'm' => 60,
        'h' => 3600,
        _ => return Err(format!("'{s}': the unit must be s, m or h")),
    };
    match n.checked_mul(mult) {
        Some(0) | None => Err(format!("'{s}' is out of range")),
        Some(secs) => Ok(secs),
    }
}

fn read_json(path: &Path) -> Result<Value> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
}

async fn cmd_run(a: RunArgs) -> Result<ExitCode> {
    if let Some(b) = a.budget_aic
        && !(b.is_finite() && b >= 0.0)
    {
        bail!("--budget-aic must be a number of AIC, not {b}");
    }
    let prompt = if a.prompt == Path::new("-") {
        std::io::read_to_string(std::io::stdin()).context("reading the prompt from stdin")?
    } else {
        std::fs::read_to_string(&a.prompt)
            .with_context(|| format!("reading the prompt {}", a.prompt.display()))?
    };
    let spec = agents::load(&a.agents, &a.agent)?;
    let policy = match &a.permissions {
        Some(p) => policy::Policy::load(p)?,
        None => policy::Policy::allow_all(),
    };
    let cwd =
        std::path::absolute(&a.cwd).with_context(|| format!("resolving {}", a.cwd.display()))?;
    let result = run::run(run::RunOptions {
        name: a.agent,
        agent: spec,
        model: a.model,
        cwd,
        prompt,
        out: a.out,
        policy,
        limits: run::Limits {
            timeout_s: a.timeout,
            budget_aic: a.budget_aic,
            max_tool_calls: a.max_tool_calls,
        },
        wrapper: a.wrapper,
    })
    .await?;
    if let Some(m) = &result.message {
        eprintln!("bot-harness: {}: {m}", result.result.as_str());
    }
    Ok(ExitCode::from(result.result.exit_code() as u8))
}

fn cmd_summary(a: SummaryArgs) -> Result<ExitCode> {
    let records: Vec<run::Record> = summary::read_jsonl(&a.dir.join(run::ACP_LOG))?;
    // A harness killed from outside wrote none.
    let result = match run::RunResult::load(&a.dir) {
        Ok(r) => Some(r),
        Err(e) if a.dir.join(run::RESULT_FILE).exists() => return Err(e),
        Err(_) => None,
    };
    let meta = read_json(&a.meta)?;
    if !meta.is_object() {
        bail!("{} is not a JSON object", a.meta.display());
    }
    // The agent writes outcome.json: anything but an object is none.
    let outcome = a
        .outcome
        .as_deref()
        .and_then(|p| read_json(p).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()));
    let usage: Option<Vec<Value>> = match &a.usage_log {
        Some(p) if p.exists() => Some(summary::read_jsonl(p)?),
        _ => None,
    };
    let s = summary::summarize(&summary::Inputs {
        records: &records,
        result: result.as_ref(),
        meta: &meta,
        outcome: &outcome,
        usage_log: usage.as_deref(),
    });
    if let Some(path) = &a.markdown {
        std::fs::write(path, summary::markdown(&s))
            .with_context(|| format!("writing {}", path.display()))?;
    }
    println!("{}", serde_json::to_string(&s)?);
    Ok(ExitCode::SUCCESS)
}

#[tokio::main]
async fn main() -> ExitCode {
    let r = match Cli::parse().command {
        Command::Run(a) => cmd_run(a).await,
        Command::Summary(a) => cmd_summary(a),
    };
    r.unwrap_or_else(|e| {
        eprintln!("bot-harness: error: {e:#}");
        ExitCode::from(2)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        for (s, want) in [
            ("90m", Ok(5400)),
            ("2h", Ok(7200)),
            ("300s", Ok(300)),
            ("45", Ok(45)),
            ("0m", Err("out of range")),
            ("5d", Err("unit must be")),
            ("m", Err("not a duration")),
            ("-1m", Err("not a duration")),
        ] {
            match (parse_duration(s), want) {
                (Ok(got), Ok(w)) => assert_eq!(got, w, "{s}"),
                (Err(e), Err(w)) => assert!(e.contains(w), "{s}: {e}"),
                (got, w) => panic!("{s}: got {got:?}, want {w:?}"),
            }
        }
    }
}
