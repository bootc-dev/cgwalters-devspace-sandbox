#!/usr/bin/env node
// The agent step of agent.yml: run bot-harness (harness/) on a checkout of
// the target repository, with the agent as the unprivileged runner-sandbox
// user in a login session of its own, stream the condensed transcript into
// the job log, then collect the run's files for upload. Runs as runner
// (with sudo), after scripts/setup-runner-sandbox.mjs and
// scripts/public-repo.mjs. The artifact layout and summary.json are the
// contract in docs/devspace-agent-runs.md in cgwalters-bot/homegit.
//
// bot-harness is a client of the Agent Client Protocol
// (https://agentclientprotocol.com): it starts the agent from
// harness/agents.toml, answers its permission requests from
// harness/policy.toml, enforces the timeout and budget, records the
// protocol stream (acp.jsonl) as the transcript, and writes summary.json.
//
// Environment (from the workflow): ITEM REPO BASE AGENT MODEL CORES
// TIMEOUT_MINUTES BUDGET WORKFLOW BRIEF OUT, and the GITHUB_* run
// variables. Everything lands in OUT: run/ (the agent-run artifact) and
// transcript.tar.zst (agent-transcript).
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { agentCommand, asAgent, killAgent } from "../scripts/agent-lib.mjs";
import { SANDBOX_HOME, fail, run } from "../scripts/runner-sandbox.mjs";
import { makeRedactor, redactTree } from "./redact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Built by the workflow (cargo build --release -p bot-harness).
const HARNESS_BIN = join(ROOT, "target/release/bot-harness");
const HARNESS_DIR = join(ROOT, "harness");
// The files bot-harness run writes, which go into the transcript.
const HARNESS_FILES = ["acp.jsonl", "agent-stderr.log", "harness.json"];
// The agents that run without inference, which is all there is for now.
const AGENTS = ["fake"];
// Time bot-harness gets past the agent's timeout to cancel it and finish.
const HARNESS_GRACE_S = 90;
const LOG_GROUP = "agent (condensed)";
// Largest outcome.json taken from the agent.
const MAX_OUTCOME_BYTES = 65536;
const EXIT_TIMEOUT = 124;
// Egress is open, so nothing is denied; summary.json keeps the field.
const EGRESS_DENIED = [];
// No inference is billed: the fake agent reports a made-up cost.
const AIC_PRICING = "mock";
// The values of whatever tokens this step can see, for redaction.
const TOKEN_VARS = ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_TOKEN"];
const REQUIRED = ["ITEM", "REPO", "BASE", "AGENT", "CORES", "TIMEOUT_MINUTES", "BUDGET", "WORKFLOW", "BRIEF", "OUT",
  "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY"];

const env = process.env;
// On one line and without control characters: text from the target
// repository or the agent must not act as a workflow command.
const oneLine = (s) => s.replace(/[\x00-\x1f\x7f]/g, " ");

function validate() {
  for (const name of REQUIRED) {
    if (!env[name]) fail(`${name} is not set`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.REPO) || env.REPO.split("/").some((p) => /^\.+$/.test(p))) {
    fail("bad repository name");
  }
  // A branch or tag name for git clone --branch.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(env.BASE) || env.BASE.includes("..")) {
    fail("bad base ref (letters, digits and _ . / - only)");
  }
  if (!AGENTS.includes(env.AGENT)) {
    fail(`agent '${env.AGENT}' needs inference, which agent.yml doesn't provide yet (only ${AGENTS.join(", ")})`);
  }
  if (!existsSync(HARNESS_BIN)) fail(`${HARNESS_BIN} is missing (cargo build --release -p bot-harness)`);
}

// Runs the agent through bot-harness, which prints the condensed
// transcript: redacted here, to the log and CONDENSED. Returns its exit
// status.
async function runHarness({ workdir, redact, harnessOut, condensed, stderrLog, promptFile }) {
  writeFileSync(promptFile, `${env.BRIEF}\n`);
  // The agent runs as runner-sandbox, in a session of its own; bot-harness
  // appends its command to this.
  const [sudo, wrapper] = agentCommand([], { cwd: workdir });
  const limit = Number(env.TIMEOUT_MINUTES) * 60 + HARNESS_GRACE_S;
  const harness = spawn("timeout", ["--kill-after=30", `${limit}s`, HARNESS_BIN, "run",
    "--agent", env.AGENT, "--agents", join(HARNESS_DIR, "agents.toml"), ...(env.MODEL ? ["--model", env.MODEL] : []),
    "--cwd", workdir, "--prompt", promptFile, "--out", harnessOut,
    "--permissions", join(HARNESS_DIR, "policy.toml"),
    "--timeout", `${env.TIMEOUT_MINUTES}m`, "--budget-aic", env.BUDGET,
    "--", sudo, ...wrapper], { stdio: ["ignore", "pipe", openSync(stderrLog, "w")] });
  const closed = new Promise((resolve) => harness.on("close", (code) => resolve(code ?? 128)));
  const condensedOut = createWriteStream(condensed);
  // bot-harness keeps each line to one line of text; redact and check
  // again, since the agent's words are in them.
  for await (const line of createInterface({ input: harness.stdout })) {
    const clean = `${oneLine(redact(line))}\n`;
    process.stdout.write(clean);
    condensedOut.write(clean);
  }
  const status = await closed;
  await new Promise((resolve) => condensedOut.end(resolve));
  return status;
}

// Collects what the agent left, reading its files as the agent: as root, a
// link planted there could copy the runner's secrets into an artifact.
function collect({ workdir, runDir }) {
  const status = asAgent(["timeout", "60", "git", "-c", "core.fsmonitor=false", "-C", workdir,
    "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  const files = status.status === 0
    ? status.stdout.toString().split("\0").filter((e) => e.length > 3).map((e) => e.slice(3)).sort() : [];
  killAgent();
  // The agent's own outcome, if it's a JSON object of sane size.
  let outcome = {};
  const out = asAgent(["head", "-c", String(MAX_OUTCOME_BYTES + 1), `${SANDBOX_HOME}/out/outcome.json`]);
  if (out.status === 0 && out.stdout.length <= MAX_OUTCOME_BYTES) {
    try {
      const parsed = JSON.parse(out.stdout.toString());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) outcome = parsed;
    } catch { /* not JSON: none */ }
  }
  writeFileSync(join(runDir, "outcome.json"), `${JSON.stringify(outcome)}\n`);
  killAgent();
  return files;
}

async function main() {
  validate();
  const out = env.OUT;
  const runDir = join(out, "run");
  const tx = join(out, "transcript");
  const work = join(out, "work");
  for (const dir of [runDir, tx, work]) mkdirSync(dir, { recursive: true });
  const workdir = `${SANDBOX_HOME}/work/${env.REPO.split("/")[1]}`;
  const redact = makeRedactor(TOKEN_VARS.map((name) => env[name]).filter(Boolean));
  process.on("exit", killAgent);

  console.log(`::group::Check out ${env.REPO} (${env.BASE}) as runner-sandbox`);
  asAgent(["mkdir", "-p", `${SANDBOX_HOME}/work`, `${SANDBOX_HOME}/out`]);
  const clone = asAgent(["git", "clone", "--quiet", "--depth", "50", "--branch", env.BASE, `https://github.com/${env.REPO}`, workdir]);
  if (clone.status !== 0) fail(`cloning ${env.REPO} failed`);
  console.log(`head: ${oneLine(asAgent(["git", "-C", workdir, "log", "-1", "--format=%h %s"]).stdout.toString().trim())}`);
  console.log("::endgroup::");

  const started = new Date();
  // The condensed lines never span lines and start with bot-harness's own
  // markers, so none can be read as a workflow command.
  console.log(`::group::${LOG_GROUP}`);
  const condensed = join(runDir, "condensed.log");
  const harnessOut = join(work, "harness");
  const exitCode = await runHarness({ workdir, redact, harnessOut, condensed,
    stderrLog: join(work, "harness-stderr.log"), promptFile: join(work, "prompt.md") });
  // bot-harness says itself why it stopped, unless it was killed.
  if (exitCode !== 0 && !existsSync(join(harnessOut, "harness.json"))) {
    const line = exitCode === EXIT_TIMEOUT ? `⚠ agent timed out after ${env.TIMEOUT_MINUTES}m` : `⚠ bot-harness exited ${exitCode}`;
    console.log(line);
    appendFileSync(condensed, `${line}\n`);
  }
  console.log("::endgroup::");
  const finished = new Date();
  killAgent();

  console.log("::group::Collect the run's files");
  const files = collect({ workdir, runDir });
  for (const f of [...HARNESS_FILES.map((name) => join(harnessOut, name)), join(work, "harness-stderr.log")]) {
    if (existsSync(f)) copyFileSync(f, join(tx, basename(f)));
  }
  redactTree(redact, [tx, runDir]);
  console.log("::endgroup::");

  // What the supervisor measured; bot-harness summary adds the rest, from
  // the redacted copies in the transcript.
  const meta = {
    run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    run_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    item: env.ITEM, repo: env.REPO, base: env.BASE, workflow: env.WORKFLOW, agent: env.AGENT, model: env.MODEL || null,
    cores: Number(env.CORES), started_at: started.toISOString().replace(/\.\d+Z$/, "Z"),
    finished_at: finished.toISOString().replace(/\.\d+Z$/, "Z"),
    duration_s: Math.round((finished - started) / 1000), exit_code: exitCode, aic_budget: Number(env.BUDGET),
    aic_pricing: AIC_PRICING, files, egress_denied: EGRESS_DENIED, redactions: redact.count,
  };
  const metaFile = join(work, "meta.json");
  writeFileSync(metaFile, JSON.stringify(meta));
  const markdownFile = join(runDir, "summary.md");
  const summary = run(HARNESS_BIN, ["summary", "--dir", tx, "--meta", metaFile, "--outcome", join(runDir, "outcome.json"),
    "--markdown", markdownFile]);
  writeFileSync(join(runDir, "summary.json"), `${summary}\n`);

  // Public repositories only (scripts/public-repo.mjs), so the transcript
  // may be public as well; it's redacted like everything else.
  run("tar", ["--zstd", "-cf", join(out, "transcript.tar.zst"), "-C", tx, "."]);
  console.log(`Agent ${env.AGENT} exited ${exitCode}: ${JSON.parse(summary).result}`);
  process.exitCode = exitCode;
}

main().catch((e) => fail(e.message));
