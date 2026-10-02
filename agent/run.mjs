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
// TIMEOUT_MINUTES BUDGET WORKFLOW BRIEF OUT, PRAXIS_BASE_URL and HOMEGIT_DIR
// (the homegit checkout) for agents that need inference, and the GITHUB_*
// run variables. Everything lands in
// OUT: run/ (the agent-run artifact) and transcript.tar.zst
// (agent-transcript).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { agentCommand, asAgent, killAgent } from "../scripts/agent-lib.mjs";
import { SANDBOX_HOME, fail, run } from "../scripts/runner-sandbox.mjs";
import { makeRedactor, redactTree } from "./redact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Built by the workflow (cargo build --release -p bot-harness).
const HARNESS_BIN = join(ROOT, "target/release/bot-harness");
const HARNESS_DIR = join(ROOT, "harness");
const SOCKET_STDIO = join(ROOT, "scripts/socket-stdio.mjs");
// The files bot-harness run writes, which go into the transcript.
const HARNESS_FILES = ["acp.jsonl", "agent-stderr.log", "harness.json"];
// The agents that need inference. They get it from the praxis credential
// broker on the tailnet (PRAXIS_BASE_URL), which holds the subscription
// login: nothing on this runner has a model credential.
const INFERENCE_AGENTS = ["opencode"];
const AGENTS = ["fake", ...INFERENCE_AGENTS];
// opencode's configuration is the bot's own, dotfiles/.config/opencode in
// the homegit checkout (HOMEGIT_DIR): its providers, model and
// instructions, as bot-opencode uses locally. Only that directory is copied
// to runner-sandbox. It must make the praxis broker the only provider;
// the base URL and sharing are set by OPENCODE_CONFIG_CONTENT, which
// outranks the file.
const OPENCODE_CONFIG_DIR = "dotfiles/.config/opencode";
const OPENCODE_CONFIG_FILE = "opencode.json";
const PRAXIS_PROVIDER = "praxis";
// The repository's instructions for agents. opencode doesn't load them
// itself here (OPENCODE_DISABLE_PROJECT_CONFIG, harness/agents.toml).
const INSTRUCTION_FILES = { opencode: ["AGENTS.md", "CLAUDE.md"] };
// Time bot-harness gets past the agent's timeout to cancel it and finish.
const HARNESS_GRACE_S = 90;
const LOG_GROUP = "agent (condensed)";
// Largest outcome.json taken from the agent.
const MAX_OUTCOME_BYTES = 65536;
// Largest change a branch run hands back (agent-out/changes.patch); a
// bigger one is dropped and the run says so.
const MAX_PATCH_BYTES = 8 << 20;
// Git, run as the agent on its checkout: none of the checkout's own hooks
// or fsmonitor.
const AGENT_GIT = ["timeout", "120", "git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
const EXIT_TIMEOUT = 124;
// Egress is open, so nothing is denied; summary.json keeps the field.
const EGRESS_DENIED = [];
// How a run's AIC is priced: the fake agent reports a made-up cost, and
// subscription inference through the broker has none per token (so only
// the timeout bounds it, until the broker counts tokens).
const AIC_PRICING = { fake: "mock", opencode: "subscription" };
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
    fail(`no agent '${env.AGENT}' (only ${AGENTS.join(", ")})`);
  }
  if (INFERENCE_AGENTS.includes(env.AGENT) && !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(env.PRAXIS_BASE_URL ?? "")) {
    fail(`agent '${env.AGENT}' needs PRAXIS_BASE_URL, the praxis broker's http(s) URL (the repository variable)`);
  }
  if (env.AGENT === "opencode" && !env.HOMEGIT_DIR) fail("agent 'opencode' needs HOMEGIT_DIR, the homegit checkout with its configuration");
  if (!existsSync(HARNESS_BIN)) fail(`${HARNESS_BIN} is missing (cargo build --release -p bot-harness)`);
}

// text with the comments and trailing commas of JSONC removed, ready for
// JSON.parse. String-aware, so a "//" in a URL stays.
function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// Checks homegit's opencode configuration: the broker its only provider,
// so that nothing the checkout holds can send the work elsewhere.
function checkOpencodeConfig(text) {
  let config;
  try {
    config = JSON.parse(stripJsonc(text));
  } catch (e) {
    fail(`homegit's ${OPENCODE_CONFIG_FILE} isn't valid JSONC: ${e.message}`);
  }
  const providers = Object.keys(config.provider ?? {});
  if (JSON.stringify(config.enabled_providers) !== JSON.stringify([PRAXIS_PROVIDER]) || providers.join() !== PRAXIS_PROVIDER) {
    fail(`homegit's ${OPENCODE_CONFIG_FILE} must enable only the ${PRAXIS_PROVIDER} provider`);
  }
}

// The regular files under dir (symlinks followed) as relative paths, each
// resolved to a real path inside root, so a link can't pull in anything
// from outside the checkout.
function configFiles(dir, root) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const real = realpathSync(path);
    const rel = relative(root, real);
    if (rel === "" || rel.split(sep)[0] === "..") fail(`${path} points outside the homegit checkout`);
    if (lstatSync(real).isDirectory()) out.push(...configFiles(path, root).map((f) => join(name, f)));
    else out.push(name);
  }
  return out;
}

// Gives runner-sandbox homegit's opencode configuration (and its global
// AGENTS.md), and returns the environment that points opencode at the
// broker: the config file's own baseURL is for the local use.
function configureInference() {
  if (env.AGENT !== "opencode") return {};
  const root = realpathSync(env.HOMEGIT_DIR);
  const dir = join(root, OPENCODE_CONFIG_DIR);
  if (!existsSync(join(dir, OPENCODE_CONFIG_FILE))) fail(`${OPENCODE_CONFIG_DIR}/${OPENCODE_CONFIG_FILE} is missing from ${env.HOMEGIT_DIR}`);
  checkOpencodeConfig(readFileSync(join(dir, OPENCODE_CONFIG_FILE), "utf8"));
  const files = configFiles(dir, root);
  const stage = mkdtempSync(join(env.OUT, "opencode-config-"));
  try {
    for (const f of files) {
      mkdirSync(dirname(join(stage, f)), { recursive: true });
      copyFileSync(join(dir, f), join(stage, f));
    }
    const tar = spawnSync("tar", ["-C", stage, "-cf", "-", "."], { maxBuffer: 1 << 26 });
    if (tar.status !== 0) fail("packing homegit's opencode configuration failed");
    const write = asAgent(["sh", "-c", 'mkdir -p "$HOME/.config/opencode" && tar -xf - -C "$HOME/.config/opencode"'], { input: tar.stdout });
    if (write.status !== 0) fail("writing runner-sandbox's opencode configuration failed");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const head = spawnSync("git", ["-C", root, "log", "-1", "--format=%h %s"], { encoding: "utf8" }).stdout.trim();
  console.log(`opencode configuration: ${env.HOMEGIT_DIR} (${oneLine(head)}), ${files.join(", ")}`);
  const overlay = { share: "disabled", provider: { [PRAXIS_PROVIDER]: { options: { baseURL: env.PRAXIS_BASE_URL } } } };
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay) };
}

// Runs the agent through bot-harness, which prints the condensed
// transcript: redacted here, to the log and CONDENSED. Returns its exit
// status.
async function runHarness({ agentEnv, workdir, redact, harnessOut, condensed, stderrLog, promptFile }) {
  // Checked as the agent: the checkout is runner-sandbox's.
  const instructions = (INSTRUCTION_FILES[env.AGENT] ?? [])
    .filter((name) => asAgent(["test", "-f", `${workdir}/${name}`]).status === 0);
  const preamble = instructions.length === 0 ? ""
    : `Before starting, read the repository's instructions for agents: ${instructions.join(" and ")}.\n\n`;
  writeFileSync(promptFile, `${preamble}${env.BRIEF}\n`);
  // The agent runs as runner-sandbox, in a session of its own; bot-harness
  // appends its command to this. bot-harness gives it pipes, which run0
  // can't hand to PID 1 from this service (see socket-stdio.mjs).
  const [sudo, wrapper] = agentCommand([], { cwd: workdir, env: agentEnv });
  const limit = Number(env.TIMEOUT_MINUTES) * 60 + HARNESS_GRACE_S;
  const harness = spawn("timeout", ["--kill-after=30", `${limit}s`, HARNESS_BIN, "run",
    "--agent", env.AGENT, "--agents", join(HARNESS_DIR, "agents.toml"), ...(env.MODEL ? ["--model", env.MODEL] : []),
    "--cwd", workdir, "--prompt", promptFile, "--out", harnessOut,
    "--permissions", join(HARNESS_DIR, "policy.toml"),
    "--timeout", `${env.TIMEOUT_MINUTES}m`, "--budget-aic", env.BUDGET,
    "--", process.execPath, SOCKET_STDIO, sudo, ...wrapper], { stdio: ["ignore", "pipe", openSync(stderrLog, "w")] });
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
function collect({ workdir, runDir, outDir }) {
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
  const patch = env.WORKFLOW === "branch" && files.length > 0 ? collectPatch({ workdir, outDir }) : null;
  killAgent();
  return { files, patch };
}

// A branch run's change, as a binary git diff against the commit it
// started from, for bot-runs apply to check again and turn into a branch:
// the runner has no credentials to push one. Untracked files are included
// (intent-to-add); nothing is committed. Returns what summary.json says
// about it.
function collectPatch({ workdir, outDir }) {
  const git = (...args) => asAgent([...AGENT_GIT, "-C", workdir, ...args]);
  const base = git("rev-parse", "HEAD").stdout.toString().trim();
  if (git("add", "--intent-to-add", "--all").status !== 0) return { error: "git add -N failed" };
  const diff = asAgent(["sh", "-c", `"$@" | head -c ${MAX_PATCH_BYTES + 1}`, "sh",
    ...AGENT_GIT, "-C", workdir, "diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD"]);
  if (diff.status !== 0) return { error: "git diff failed" };
  if (diff.stdout.length > MAX_PATCH_BYTES) return { base, error: `the change is over ${MAX_PATCH_BYTES} bytes` };
  writeFileSync(join(outDir, "changes.patch"), diff.stdout);
  writeFileSync(join(outDir, "base.json"), `${JSON.stringify({ repo: env.REPO, ref: env.BASE, commit: base })}\n`);
  return { base, bytes: diff.stdout.length };
}

async function main() {
  validate();
  const out = env.OUT;
  const runDir = join(out, "run");
  const tx = join(out, "transcript");
  // agent-out: what a branch run hands back (bot-runs apply).
  const outDir = join(out, "agent-out");
  const work = join(out, "work");
  for (const dir of [runDir, tx, work, outDir]) mkdirSync(dir, { recursive: true });
  const workdir = `${SANDBOX_HOME}/work/${env.REPO.split("/")[1]}`;
  const redact = makeRedactor(TOKEN_VARS.map((name) => env[name]).filter(Boolean));
  process.on("exit", killAgent);

  console.log(`::group::Check out ${env.REPO} (${env.BASE}) as runner-sandbox`);
  asAgent(["mkdir", "-p", `${SANDBOX_HOME}/work`, `${SANDBOX_HOME}/out`]);
  const clone = asAgent(["git", "clone", "--quiet", "--depth", "50", "--branch", env.BASE, `https://github.com/${env.REPO}`, workdir]);
  if (clone.status !== 0) fail(`cloning ${env.REPO} failed`);
  console.log(`head: ${oneLine(asAgent(["git", "-C", workdir, "log", "-1", "--format=%h %s"]).stdout.toString().trim())}`);
  console.log("::endgroup::");

  const agentEnv = configureInference();
  const started = new Date();
  // The condensed lines never span lines and start with bot-harness's own
  // markers, so none can be read as a workflow command.
  console.log(`::group::${LOG_GROUP}`);
  const condensed = join(runDir, "condensed.log");
  const harnessOut = join(work, "harness");
  const exitCode = await runHarness({ agentEnv, workdir, redact, harnessOut, condensed,
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
  const { files, patch } = collect({ workdir, runDir, outDir });
  if (patch?.error) console.log(`::warning::no change handed back: ${patch.error}`);
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
    aic_pricing: AIC_PRICING[env.AGENT], files, patch, egress_denied: EGRESS_DENIED, redactions: redact.count,
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
