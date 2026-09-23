use anyhow::{Context, Result, bail};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, de::DeserializeOwned};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use xshell::{Shell, cmd};

const REPO: &str = "bootc-dev/cgwalters-devspace-sandbox";
const WORKFLOW: &str = "devspace.yml";
const WORKFLOW_NAME: &str = "Development runner";
const WAIT: Duration = Duration::from_secs(180);

#[derive(Parser, Debug)]
#[command(about = "Manage disposable development runners.")]
struct Cli {
    #[command(subcommand)]
    command: CommandLine,
}

#[derive(Subcommand, Debug)]
enum CommandLine {
    /// Dispatch a disposable development runner.
    Start(StartArgs),
    /// List active workflow-dispatched development runners.
    List,
    /// Connect to a managed runner using ordinary OpenSSH.
    Ssh(RunArgs),
    /// Cancel a managed development runner.
    Stop(RunArgs),
}

#[derive(Args, Debug)]
struct StartArgs {
    /// Runner lifetime in minutes.
    #[arg(long, default_value_t = DurationMinutes::TwoForty, help = "Runner lifetime in minutes (30, 60, 120, or 240)")]
    duration: DurationMinutes,
    /// Runner CPU cores; choices are loaded from runner-sizes.json.
    #[arg(long, value_parser = parse_cores, default_value_t = 16, help = "Runner CPU cores loaded from runner-sizes.json (default: 16)")]
    cores: u32,
}

#[derive(Args, Debug)]
struct RunArgs {
    /// GitHub Actions database run ID.
    #[arg(value_parser = parse_run_id)]
    run_id: u64,
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq)]
enum DurationMinutes {
    #[value(name = "30")]
    Thirty,
    #[value(name = "60")]
    Sixty,
    #[value(name = "120")]
    OneTwenty,
    #[value(name = "240")]
    TwoForty,
}
impl DurationMinutes {
    fn as_str(self) -> &'static str {
        match self {
            Self::Thirty => "30",
            Self::Sixty => "60",
            Self::OneTwenty => "120",
            Self::TwoForty => "240",
        }
    }
}
impl std::fmt::Display for DurationMinutes {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Deserialize)]
struct Run {
    #[serde(rename = "databaseId")]
    database_id: Option<u64>,
    #[serde(rename = "createdAt")]
    created_at: DateTime<Utc>,
    #[serde(rename = "displayTitle")]
    display_title: String,
    status: String,
    url: String,
}
#[derive(Clone, Debug, Deserialize)]
struct Details {
    #[serde(rename = "workflowName")]
    workflow_name: String,
    status: String,
    conclusion: Option<String>,
}

fn parse_run_id(value: &str) -> std::result::Result<u64, String> {
    if value.is_empty() || !value.chars().all(|c| c.is_ascii_digit()) {
        return Err("run ID must be numeric".into());
    }
    value.parse().map_err(|_| "run ID is too large".into())
}
fn parse_cores(value: &str) -> std::result::Result<u32, String> {
    let cores: u32 = value
        .parse()
        .map_err(|_| "cores must be numeric".to_string())?;
    runner_sizes()
        .map_err(|error| format!("unable to validate cores: {error}"))?
        .contains_key(value)
        .then_some(cores)
        .ok_or_else(|| {
            format!("cores must be one of the choices in runner-sizes.json (got {value})")
        })
}

fn runner_sizes() -> Result<BTreeMap<String, String>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("runner-sizes.json");
    let sizes: BTreeMap<String, String> = serde_json::from_reader(
        File::open(&path).with_context(|| format!("opening {}", path.display()))?,
    )
    .context("parsing runner-sizes.json")?;
    if sizes.is_empty()
        || sizes
            .iter()
            .any(|(cores, label)| cores.parse::<u32>().is_err() || label.trim().is_empty())
    {
        bail!("runner-sizes.json must contain numeric core choices with non-empty labels");
    }
    Ok(sizes)
}

fn state_root() -> Result<PathBuf> {
    state_root_from(std::env::var_os("XDG_STATE_HOME"), std::env::var_os("HOME"))
}
fn state_root_from(
    xdg: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Result<PathBuf> {
    if let Some(path) = xdg.filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            return Ok(path.join("devspace"));
        }
    }
    let home = home.filter(|path| !path.is_empty()).map(PathBuf::from).filter(|path| path.is_absolute()).ok_or_else(|| anyhow::anyhow!("XDG_STATE_HOME is unusable and HOME is not a nonempty absolute path; cannot determine devspace state directory"))?;
    Ok(home.join(".local/state/devspace"))
}
fn state_path(id: u64) -> Result<PathBuf> {
    Ok(state_root()?.join(id.to_string()))
}
fn chmod(path: &Path, mode: u32) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .context("setting private permissions")
}
fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("creating {}", path.display()))?;
    chmod(path, 0o700)
}
struct PendingState {
    path: PathBuf,
    session: String,
    retained: bool,
}
impl PendingState {
    fn retain(&mut self) {
        self.retained = true;
    }
}
impl Drop for PendingState {
    fn drop(&mut self) {
        if !self.retained {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
fn random_session() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| anyhow::anyhow!("generating random session identifier: {error:?}"))?;
    Ok(format!(
        "session-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}
fn create_pending(root: &Path) -> Result<PendingState> {
    for _ in 0..16 {
        let session = random_session()?;
        let path = root.join(format!(".pending-{session}"));
        let mut builder = fs::DirBuilder::new();
        builder.recursive(false);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        match builder.create(&path) {
            Ok(()) => {
                if let Err(error) = chmod(&path, 0o700) {
                    let _ = fs::remove_dir_all(&path);
                    return Err(error);
                }
                if let Err(error) = write_session_file(&path, &session) {
                    let _ = fs::remove_dir_all(&path);
                    return Err(error);
                }
                return Ok(PendingState {
                    path,
                    session,
                    retained: false,
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("creating pending state {}", path.display()));
            }
        }
    }
    bail!("could not create a unique pending state directory after repeated collisions")
}
fn write_session_file(path: &Path, session: &str) -> Result<()> {
    let file = path.join("session");
    fs::write(&file, format!("{session}\n"))?;
    chmod(&file, 0o600)
}
#[derive(Debug)]
enum ExternalFailure {
    Spawn(String),
    Executed(String),
}
impl std::fmt::Display for ExternalFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(detail) | Self::Executed(detail) => formatter.write_str(detail),
        }
    }
}
fn external(program: &str, args: &[String]) -> std::result::Result<Output, ExternalFailure> {
    let child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            ExternalFailure::Spawn(format!(
                "required command {program} could not start: {error}"
            ))
        })?;
    let output = child.wait_with_output().map_err(|error| {
        ExternalFailure::Executed(format!(
            "{program} started but could not be collected: {error}"
        ))
    })?;
    if !output.status.success() {
        return Err(ExternalFailure::Executed(format!(
            "{program} failed: {}",
            diagnostic(&output)
        )));
    }
    Ok(output)
}
fn dispatch_result_requires_retention(error: &ExternalFailure) -> bool {
    matches!(error, ExternalFailure::Executed(_))
}
fn diagnostic(output: &Output) -> String {
    [output.stderr.as_slice(), output.stdout.as_slice()]
        .into_iter()
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
        .find(|text| !text.is_empty())
        .unwrap_or_else(|| "command failed without diagnostics".into())
}
fn parse_json<T: DeserializeOwned>(text: &str) -> Result<T> {
    serde_json::from_str(text).context("gh returned malformed JSON")
}
fn gh_json(args: &[&str]) -> Result<serde_json::Value> {
    let sh = Shell::new()?;
    let output = cmd!(sh, "gh").args(args).output().context("running gh")?;
    if !output.status.success() {
        bail!("gh failed: {}", diagnostic(&output));
    }
    parse_json(&String::from_utf8_lossy(&output.stdout))
}
fn dispatch_runs() -> Result<Vec<Run>> {
    let value = gh_json(&[
        "run",
        "list",
        "--repo",
        REPO,
        "--workflow",
        WORKFLOW,
        "--branch",
        "main",
        "--event",
        "workflow_dispatch",
        "--limit",
        "100",
        "--json",
        "databaseId,createdAt,displayTitle,status,url",
    ])?;
    let runs: Vec<Run> =
        serde_json::from_value(value).context("gh returned an unexpected run list")?;
    for run in &runs {
        classify_status(&run.status)?;
    }
    Ok(runs)
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum WorkflowState {
    Active,
    Completed,
}
fn classify_status(status: &str) -> Result<WorkflowState> {
    match status {
        "requested" | "waiting" | "pending" | "queued" | "in_progress" => Ok(WorkflowState::Active),
        "completed" => Ok(WorkflowState::Completed),
        other => bail!("unexpected workflow status {other:?}"),
    }
}
fn active_runs(runs: &[Run]) -> Result<Vec<&Run>> {
    let mut active = Vec::new();
    for run in runs {
        if classify_status(&run.status)? == WorkflowState::Active {
            active.push(run);
        }
    }
    Ok(active)
}
fn find_run<'a>(session: &str, since: DateTime<Utc>, runs: &'a [Run]) -> Option<&'a Run> {
    let mut matches = runs
        .iter()
        .filter(|r| r.display_title == format!("Devspace {session}") && r.created_at >= since);
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}
fn hostname(id: u64) -> String {
    format!("cgwalters-devspace-{id}")
}
fn is_managed(details: &Details) -> bool {
    details.workflow_name == WORKFLOW_NAME
}
fn format_run(run: &Run) -> String {
    format!(
        "{}\t{}\t{}\t{}",
        run.database_id.map_or("-".into(), |id| id.to_string()),
        if run.status.is_empty() {
            "-"
        } else {
            &run.status
        },
        if run.display_title.is_empty() {
            "-"
        } else {
            &run.display_title
        },
        if run.url.is_empty() { "-" } else { &run.url },
    )
}
fn dispatch_args(
    duration: DurationMinutes,
    cores: u32,
    public_key: &str,
    session: &str,
) -> Vec<String> {
    [
        "workflow", "run", WORKFLOW, "--repo", REPO, "--ref", "main", "-f",
    ]
    .into_iter()
    .map(String::from)
    .chain([
        format!("duration={}", duration.as_str()),
        "-f".into(),
        format!("cores={cores}"),
        "-f".into(),
        format!("ssh_public_key={public_key}"),
        "-f".into(),
        format!("session_name={session}"),
    ])
    .collect()
}
fn ssh_command(key: &Path, known_hosts: &Path, host: &str) -> Vec<String> {
    vec![
        "ssh".into(),
        "-i".into(),
        key.display().to_string(),
        "-o".into(),
        format!("UserKnownHostsFile={}", known_hosts.display()),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "IdentitiesOnly=yes".into(),
        format!("runner@{host}"),
    ]
}
fn ssh_probe_command(key: &Path, known_hosts: &Path, host: &str) -> Vec<String> {
    let mut args = ssh_command(key, known_hosts, host);
    args.splice(
        1..1,
        [
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            "ConnectTimeout=8".into(),
        ],
    );
    args.push("true".into());
    args
}

fn workflow_details(id: u64) -> Result<Details> {
    serde_json::from_value(gh_json(&[
        "run",
        "view",
        &id.to_string(),
        "--repo",
        REPO,
        "--json",
        "workflowName,status,conclusion",
    ])?)
    .context("gh returned an unexpected workflow status")
}
fn ensure_active(id: u64) -> Result<()> {
    let details = workflow_details(id)?;
    ensure_active_details(&details)
}
fn ensure_active_details(details: &Details) -> Result<()> {
    if !is_managed(details) {
        bail!("run is not a Development runner workflow");
    }
    match classify_status(&details.status)? {
        WorkflowState::Active => Ok(()),
        WorkflowState::Completed => bail!(
            "workflow completed ({})",
            details.conclusion.as_deref().unwrap_or("unknown")
        ),
    }
}

fn ssh_probe(key: &Path, known_hosts: &Path, host: &str) -> Result<bool> {
    let args = ssh_probe_command(key, known_hosts, host);
    let mut child = Command::new(&args[0])
        .args(&args[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("running ssh readiness probe")?;
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.success());
        }
        if Instant::now() >= deadline {
            child.kill()?;
            child.wait()?;
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn command_start(args: StartArgs) -> Result<()> {
    let sizes = runner_sizes()?;
    if !sizes.contains_key(&args.cores.to_string()) {
        bail!("runner-sizes.json does not define {} cores", args.cores);
    }
    let root = state_root()?;
    private_dir(&root)?;
    let mut pending = create_pending(&root)?;
    let key = pending.path.join("id_ed25519");
    if let Err(error) = external(
        "ssh-keygen",
        &[
            "-q".into(),
            "-t".into(),
            "ed25519".into(),
            "-N".into(),
            "".into(),
            "-f".into(),
            key.display().to_string(),
        ],
    ) {
        bail!("key generation failed: {error}");
    }
    chmod(&key, 0o600)?;
    let public_path = key.with_extension("pub");
    chmod(&public_path, 0o600)?;
    let public_key = fs::read_to_string(&public_path)
        .with_context(|| format!("reading generated public key {}", public_path.display()))?
        .trim()
        .to_string();
    let since = Utc::now() - ChronoDuration::seconds(2);
    let dispatch = dispatch_args(args.duration, args.cores, &public_key, &pending.session);
    match external("gh", &dispatch) {
        Ok(_) => pending.retain(),
        Err(error) if dispatch_result_requires_retention(&error) => {
            pending.retain();
            bail!(
                "dispatch result is uncertain ({error}); retain {} and locate session {} in GitHub",
                pending.path.display(),
                pending.session
            );
        }
        Err(error) => {
            return Err(anyhow::anyhow!("dispatch command could not start: {error}"));
        }
    }
    for _ in 0..30 {
        let runs = match dispatch_runs() {
            Ok(runs) => runs,
            Err(error) => bail!(
                "workflow was dispatched but correlation is uncertain ({error}); retain {} and locate session {} in GitHub",
                pending.path.display(),
                pending.session
            ),
        };
        if let Some(run) = find_run(&pending.session, since, &runs) {
            let id = match run.database_id {
                Some(id) => id,
                None => bail!(
                    "workflow was dispatched but correlation failed; retain {} and locate session {} in GitHub",
                    pending.path.display(),
                    pending.session
                ),
            };
            let destination = root.join(id.to_string());
            if destination.exists() {
                bail!(
                    "workflow was dispatched but local state already exists for run {id}; retain {} and locate session {} in GitHub",
                    pending.path.display(),
                    pending.session
                );
            }
            fs::rename(&pending.path, &destination).with_context(|| {
                format!(
                    "moving pending state {} to {}",
                    pending.path.display(),
                    destination.display()
                )
            })?;
            println!("Run {id}: {}", run.url);
            return Ok(());
        }
        thread::sleep(Duration::from_secs(2));
    }
    bail!(
        "workflow was dispatched but could not be correlated safely; retain {} and use GitHub to locate session {}",
        pending.path.display(),
        pending.session
    )
}
fn command_list() -> Result<()> {
    for run in active_runs(&dispatch_runs()?)? {
        println!("{}", format_run(run));
    }
    Ok(())
}
fn command_ssh(args: RunArgs) -> Result<()> {
    let key = state_path(args.run_id)?.join("id_ed25519");
    if !key.is_file() {
        bail!(
            "no managed key for run {}; it may have been started elsewhere",
            args.run_id
        );
    }
    let known_hosts = key.parent().unwrap().join("known_hosts");
    if !known_hosts.exists() {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&known_hosts)?;
    }
    chmod(&known_hosts, 0o600)?;
    let host = hostname(args.run_id);
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        ensure_active(args.run_id)?;
        if ssh_probe(&key, &known_hosts, &host)? {
            let command = ssh_command(&key, &known_hosts, &host);
            return Err(Command::new(&command[0]).args(&command[1..]).exec())
                .context("execing ssh");
        }
        thread::sleep(Duration::from_secs(2));
    }
    bail!(
        "ordinary SSH for workflow {} was not ready before timeout",
        args.run_id
    )
}
fn remove_state(id: u64) -> Result<()> {
    let path = state_path(id)?;
    match fs::remove_dir_all(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("removing state {}", path.display()));
        }
    }
    Ok(())
}
#[derive(Debug, PartialEq)]
enum StopDecision {
    Active,
    Completed,
}
fn stop_decision(details: &Details) -> Result<StopDecision> {
    if !is_managed(details) {
        bail!("run is not a Development runner workflow");
    }
    match classify_status(&details.status)? {
        WorkflowState::Active => Ok(StopDecision::Active),
        WorkflowState::Completed => Ok(StopDecision::Completed),
    }
}
fn command_stop(args: RunArgs) -> Result<()> {
    let details = workflow_details(args.run_id)?;
    if stop_decision(&details)? == StopDecision::Completed {
        remove_state(args.run_id)?;
        println!("Run {} already completed; removed local state", args.run_id);
        return Ok(());
    }
    if let Err(error) = external(
        "gh",
        &[
            "run".into(),
            "cancel".into(),
            args.run_id.to_string(),
            "--repo".into(),
            REPO.into(),
        ],
    ) {
        match stop_decision(&workflow_details(args.run_id)?)? {
            StopDecision::Active => return Err(anyhow::anyhow!(error.to_string())),
            StopDecision::Completed => {}
        }
        println!(
            "Run {} completed while cancellation was requested; removed local state",
            args.run_id
        );
        remove_state(args.run_id)?;
        return Ok(());
    }
    remove_state(args.run_id)?;
    println!("Cancelled run {}", args.run_id);
    Ok(())
}
fn main() -> Result<()> {
    match Cli::parse().command {
        CommandLine::Start(a) => command_start(a),
        CommandLine::List => command_list(),
        CommandLine::Ssh(a) => command_ssh(a),
        CommandLine::Stop(a) => command_stop(a),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    fn timestamp(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }
    fn run_with_status(id: u64, status: &str) -> Run {
        Run {
            database_id: Some(id),
            created_at: timestamp("2026-01-01T00:00:02Z"),
            display_title: "Devspace session-a".into(),
            status: status.into(),
            url: "url".into(),
        }
    }
    fn run(id: u64) -> Run {
        run_with_status(id, "in_progress")
    }
    fn find_yaml_key<'a>(
        value: &'a serde_yaml::Value,
        wanted: &str,
    ) -> Option<&'a serde_yaml::Value> {
        match value {
            serde_yaml::Value::Mapping(mapping) => {
                for (key, value) in mapping {
                    if key.as_str() == Some(wanted) {
                        return Some(value);
                    }
                    if let Some(found) = find_yaml_key(value, wanted) {
                        return Some(found);
                    }
                }
                None
            }
            serde_yaml::Value::Sequence(sequence) => sequence
                .iter()
                .find_map(|value| find_yaml_key(value, wanted)),
            _ => None,
        }
    }
    #[test]
    fn parsing_defaults_and_invalid_values() {
        let cli = Cli::try_parse_from(["devspace", "start"]).unwrap();
        if let CommandLine::Start(a) = cli.command {
            assert_eq!(a.cores, 16);
            assert_eq!(a.duration, DurationMinutes::TwoForty);
        } else {
            panic!()
        }
        assert!(Cli::try_parse_from(["devspace", "start", "--cores", "8"]).is_err());
        assert!(Cli::try_parse_from(["devspace", "start", "--duration", "45"]).is_err());
        for duration in ["30", "60", "120", "240"] {
            assert!(Cli::try_parse_from(["devspace", "start", "--duration", duration]).is_ok());
        }
        assert!(Cli::try_parse_from(["devspace", "ssh", "x"]).is_err());
    }
    #[test]
    fn correlation_and_hostname() {
        assert_eq!(
            find_run("session-a", timestamp("2026-01-01T00:00:01Z"), &[run(2)])
                .unwrap()
                .database_id,
            Some(2)
        );
        assert!(
            find_run(
                "session-a",
                timestamp("2026-01-01T00:00:01Z"),
                &[run(2), run(3)]
            )
            .is_none()
        );
        assert_eq!(hostname(2), "cgwalters-devspace-2");
    }
    #[test]
    fn correlation_uses_parsed_timestamps_and_rejects_fences() {
        let before = Run {
            created_at: timestamp("2025-12-31T23:59:59Z"),
            ..run(1)
        };
        let after = Run {
            created_at: timestamp("2026-01-01T00:00:03+00:00"),
            ..run(2)
        };
        assert!(find_run("session-a", timestamp("2026-01-01T00:00:00Z"), &[before]).is_none());
        assert_eq!(
            find_run("session-a", timestamp("2026-01-01T00:00:02Z"), &[after])
                .unwrap()
                .database_id,
            Some(2)
        );
        assert!(serde_json::from_str::<Run>(r#"{"databaseId": 1, "createdAt": "not-a-date", "displayTitle": "Devspace x", "status": "queued", "url": "u"}"#).is_err());
    }
    #[test]
    fn active_filter_and_status_validation() {
        for (id, status) in ["requested", "waiting", "pending", "queued", "in_progress"]
            .into_iter()
            .enumerate()
        {
            assert_eq!(classify_status(status).unwrap(), WorkflowState::Active);
            let details = Details {
                workflow_name: WORKFLOW_NAME.into(),
                status: status.into(),
                conclusion: None,
            };
            assert_eq!(stop_decision(&details).unwrap(), StopDecision::Active);
            assert_eq!(
                active_runs(&[run_with_status(id as u64, status)])
                    .unwrap()
                    .len(),
                1
            );
        }
        assert_eq!(
            classify_status("completed").unwrap(),
            WorkflowState::Completed
        );
        let runs = [
            run_with_status(1, "requested"),
            run_with_status(2, "in_progress"),
            run_with_status(3, "completed"),
        ];
        let active = active_runs(&runs).unwrap();
        assert_eq!(
            active.iter().map(|run| run.database_id).collect::<Vec<_>>(),
            [Some(1), Some(2)]
        );
        for status in ["", "cancelled", "unknown"] {
            assert!(classify_status(status).is_err());
            assert!(active_runs(&[run_with_status(4, status)]).is_err());
        }
    }
    #[test]
    fn state_permissions_and_argv() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("7");
        private_dir(&dir).unwrap();
        write_session_file(&dir, "session-a").unwrap();
        let key = dir.join("id_ed25519");
        fs::write(&key, "private").unwrap();
        chmod(&key, 0o600).unwrap();
        assert_eq!(dir.metadata().unwrap().mode() & 0o777, 0o700);
        assert_eq!(key.metadata().unwrap().mode() & 0o777, 0o600);
        let argv = ssh_command(&key, &dir.join("known hosts"), &hostname(7));
        assert!(argv.contains(&"StrictHostKeyChecking=accept-new".into()));
        assert!(argv.contains(&"IdentitiesOnly=yes".into()));
        assert_eq!(argv.last().unwrap(), "runner@cgwalters-devspace-7");
        let probe = ssh_probe_command(&key, &dir.join("known hosts"), &hostname(7));
        assert!(probe.contains(&"BatchMode=yes".into()));
        assert!(probe.contains(&"ConnectTimeout=8".into()));
        assert_eq!(probe.last().unwrap(), "true");
    }
    #[test]
    fn pending_state_is_random_and_cleanup_depends_on_dispatch() {
        let temp = tempfile::tempdir().unwrap();
        let first_path;
        let first_session;
        {
            let first = create_pending(temp.path()).unwrap();
            first_path = first.path.clone();
            first_session = first.session.clone();
            assert_eq!(first.path.metadata().unwrap().mode() & 0o777, 0o700);
            assert_eq!(
                first.path.join("session").metadata().unwrap().mode() & 0o777,
                0o600
            );
            assert!(first.session.starts_with("session-"));
            assert_eq!(first.session.len(), "session-".len() + 32);
        }
        assert!(!first_path.exists());
        let second = create_pending(temp.path()).unwrap();
        assert_ne!(first_session, second.session);
        let retained_path = second.path.clone();
        let mut second = second;
        second.retain();
        drop(second);
        assert!(retained_path.exists());
        fs::remove_dir_all(retained_path).unwrap();
    }
    #[test]
    fn state_root_and_diagnostics_are_safe() {
        for (xdg, home) in [
            (None, None),
            (Some(""), Some("/home/user")),
            (Some("relative"), Some("/home/user")),
            (Some("/state"), None),
            (None, Some("")),
            (None, Some("relative")),
        ] {
            let result = state_root_from(xdg.map(Into::into), home.map(Into::into));
            if let Err(error) = result {
                assert!(error.to_string().contains("absolute"));
            }
        }
        let fallback = PathBuf::from("/home/user/.local/state/devspace");
        assert_eq!(
            state_root_from(Some("".into()), Some("/home/user".into())).unwrap(),
            fallback
        );
        assert_eq!(
            state_root_from(Some("relative".into()), Some("/home/user".into())).unwrap(),
            fallback
        );
        assert_eq!(
            state_root_from(None, Some("/home/user".into())).unwrap(),
            PathBuf::from("/home/user/.local/state/devspace")
        );
        assert_eq!(
            state_root_from(Some("/tmp/state".into()), None).unwrap(),
            PathBuf::from("/tmp/state/devspace")
        );
        let output = Output {
            status: std::process::ExitStatus::default(),
            stdout: b"stdout detail".into(),
            stderr: b"stderr detail".into(),
        };
        assert_eq!(diagnostic(&output), "stderr detail");
        let output = Output {
            status: std::process::ExitStatus::default(),
            stdout: b"stdout detail".into(),
            stderr: Vec::new(),
        };
        assert_eq!(diagnostic(&output), "stdout detail");
        assert!(parse_json::<Run>("not json").is_err());
        assert!(
            serde_json::from_str::<Details>(r#"{"workflowName":"Development runner"}"#).is_err()
        );
    }
    #[test]
    fn dispatch_spawn_failure_cleans_but_executed_failure_retains() {
        assert!(!dispatch_result_requires_retention(
            &ExternalFailure::Spawn("not found".into())
        ));
        assert!(dispatch_result_requires_retention(
            &ExternalFailure::Executed("network error".into())
        ));
        let stderr = external(
            "sh",
            &[
                "-c".into(),
                "printf stdout; printf stderr >&2; exit 7".into(),
            ],
        )
        .unwrap_err();
        assert!(matches!(&stderr, ExternalFailure::Executed(detail) if detail.contains("stderr")));
        assert!(dispatch_result_requires_retention(&stderr));
        let stdout = external("sh", &["-c".into(), "printf stdout; exit 7".into()]).unwrap_err();
        assert!(matches!(&stdout, ExternalFailure::Executed(detail) if detail.contains("stdout")));
        assert!(matches!(
            external("/definitely/missing/devspace-command", &[]),
            Err(ExternalFailure::Spawn(_))
        ));
    }
    #[test]
    fn sizes_match_workflow() {
        let workflow = fs::read_to_string(".github/workflows/devspace.yml").unwrap();
        let choices = workflow
            .lines()
            .find(|line| line.contains("options: [\"4\""))
            .unwrap();
        for (cores, label) in runner_sizes().unwrap() {
            assert!(workflow.contains(&format!("\"{cores}\":\"{label}\"")));
            assert!(choices.contains(&format!("\"{cores}\"")));
        }
        let workflow_yaml: serde_yaml::Value = serde_yaml::from_str(&workflow).unwrap();
        let dispatch = find_yaml_key(&workflow_yaml, "workflow_dispatch").unwrap();
        let inputs = find_yaml_key(dispatch, "inputs").unwrap();
        let cores_input = find_yaml_key(inputs, "cores").unwrap();
        assert_eq!(
            find_yaml_key(cores_input, "default").unwrap().as_str(),
            Some("16")
        );
        let options = find_yaml_key(cores_input, "options")
            .unwrap()
            .as_sequence()
            .unwrap();
        let workflow_cores: std::collections::BTreeSet<_> = options
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        let sizes = runner_sizes().unwrap();
        assert_eq!(workflow_cores, sizes.keys().cloned().collect());
        assert!(sizes.contains_key("16"));
        let expression = find_yaml_key(&workflow_yaml, "runs-on")
            .unwrap()
            .as_str()
            .unwrap();
        let mapping = expression
            .split("fromJSON('")
            .nth(1)
            .unwrap()
            .split("')[inputs.cores]")
            .next()
            .unwrap();
        let mapping: std::collections::BTreeMap<String, String> =
            serde_json::from_str(mapping).unwrap();
        assert_eq!(mapping, sizes);
        let actionlint: serde_yaml::Value =
            serde_yaml::from_str(&fs::read_to_string(".github/actionlint.yaml").unwrap()).unwrap();
        let labels: std::collections::BTreeSet<_> = find_yaml_key(&actionlint, "labels")
            .unwrap()
            .as_sequence()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        assert_eq!(labels, sizes.values().cloned().collect());
    }
    #[test]
    fn durations_match_workflow() {
        let workflow = fs::read_to_string(".github/workflows/devspace.yml").unwrap();
        let workflow_yaml: serde_yaml::Value = serde_yaml::from_str(&workflow).unwrap();
        let dispatch = find_yaml_key(&workflow_yaml, "workflow_dispatch").unwrap();
        let inputs = find_yaml_key(dispatch, "inputs").unwrap();
        let duration_input = find_yaml_key(inputs, "duration").unwrap();
        assert_eq!(
            find_yaml_key(duration_input, "default").unwrap().as_str(),
            Some("240")
        );
        let choices: Vec<_> = find_yaml_key(duration_input, "options")
            .unwrap()
            .as_sequence()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(choices, ["30", "60", "120", "240"]);
        assert_eq!(
            find_yaml_key(&workflow_yaml, "timeout-minutes")
                .unwrap()
                .as_i64(),
            Some(270)
        );
    }
    #[test]
    fn justfile_pins_homegit_with_renovate_annotation() {
        let justfile = fs::read_to_string("Justfile").unwrap();
        let annotation = "# renovate: datasource=git-refs depName=https://github.com/cgwalters-bot/homegit branch=main";
        let mut lines = justfile.lines().skip_while(|line| *line != annotation);
        assert!(lines.next().is_some(), "Justfile is missing {annotation:?}");
        let rev_line = lines.next().unwrap();
        let rev = rev_line
            .strip_prefix("homegit_rev := \"")
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or_else(|| panic!("unexpected homegit_rev line {rev_line:?}"));
        assert!(
            rev.len() == 40 && rev.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
            "homegit_rev must be a full commit SHA, got {rev:?}"
        );
        // The runner's umask is 000; dotfiles must not be installed world-writable.
        let umask = justfile
            .find("    umask 022\n")
            .expect("init must set umask 022");
        assert!(umask < justfile.find("git clone").unwrap());
        assert!(umask < justfile.find("make -C \"$homegit\" install").unwrap());
    }
    #[test]
    fn workflow_initializes_homegit_before_openssh() {
        let workflow = fs::read_to_string(".github/workflows/devspace.yml").unwrap();
        let checkout = "uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
        let epel = "epel-release-latest-10.noarch.rpm";
        let dependencies = "sudo dnf install -y git just make rsync";
        let init = "sudo -u runner -H just init";
        let openssh = "- name: Prepare OpenSSH and keep the devspace available";
        assert!(workflow.contains(checkout));
        assert!(workflow.contains("persist-credentials: false"));
        assert!(workflow.contains(epel));
        assert!(workflow.contains(dependencies));
        assert!(workflow.contains(init));
        assert!(workflow.find(checkout).unwrap() < workflow.find(init).unwrap());
        assert!(workflow.find(init).unwrap() < workflow.find(openssh).unwrap());
    }
    #[test]
    fn list_format_and_dispatch_arguments_are_stable() {
        assert_eq!(
            format_run(&run(7)),
            "7\tin_progress\tDevspace session-a\turl"
        );
        assert_eq!(
            dispatch_args(DurationMinutes::Sixty, 64, "ssh-ed25519 key", "session-a"),
            [
                "workflow",
                "run",
                WORKFLOW,
                "--repo",
                REPO,
                "--ref",
                "main",
                "-f",
                "duration=60",
                "-f",
                "cores=64",
                "-f",
                "ssh_public_key=ssh-ed25519 key",
                "-f",
                "session_name=session-a",
            ]
        );
    }
    #[test]
    fn workflow_ownership_and_lifecycle_guard() {
        let managed = Details {
            workflow_name: WORKFLOW_NAME.into(),
            status: "in_progress".into(),
            conclusion: None,
        };
        let unrelated = Details {
            workflow_name: "Other workflow".into(),
            status: "in_progress".into(),
            conclusion: None,
        };
        assert!(is_managed(&managed));
        assert!(!is_managed(&unrelated));
        assert!(ensure_active_details(&managed).is_ok());
        let completed = Details {
            status: "completed".into(),
            conclusion: Some("failure".into()),
            ..managed.clone()
        };
        assert!(
            ensure_active_details(&completed)
                .unwrap_err()
                .to_string()
                .contains("failure")
        );
        assert_eq!(stop_decision(&managed).unwrap(), StopDecision::Active);
        assert_eq!(stop_decision(&completed).unwrap(), StopDecision::Completed);
        assert!(stop_decision(&unrelated).is_err());
        let race = Details {
            status: "cancelled".into(),
            ..managed
        };
        assert!(stop_decision(&race).is_err());
    }
}
