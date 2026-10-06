// Installed in /usr/local/bin as a readable Node script, so the ACP command
// can run it after entering runner-sandbox, without access to runner's checkout.
// Starts Claude Code's ACP adapter with the run's environment
// (claude-config.mjs: the praxis broker and the run token), which is in a
// file because a command line is public.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// What selects Claude Code's provider, credential, model and configuration.
// Only the model survives from the caller (harness/agents.toml).
const CONFIG_VARS = /^(ANTHROPIC|CLAUDE)_/;
const KEPT_VARS = ["ANTHROPIC_MODEL"];
// The only variables the run's environment may set.
const RUN_VARS = /^ANTHROPIC_[A-Z_]+$/;

function fail(message) {
  console.error(`claude launcher: ${message}`);
  process.exit(1);
}

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (CONFIG_VARS.test(name) && !KEPT_VARS.includes(name)) delete env[name];
}
// HOME is the sandbox user's home; never resolve the run's environment
// against the target repository.
if (!env.HOME || !isAbsolute(env.HOME)) fail("HOME must be an absolute path");
const runFile = join(env.HOME, ".config/claude-runner/run.json");
let run;
try {
  run = JSON.parse(readFileSync(runFile, "utf8")).env;
} catch (error) {
  // Without it Claude Code would look for a login of its own.
  fail(`reading ${runFile}: ${error.message}`);
}
if (!run || typeof run !== "object" || Object.entries(run).some(([name, value]) => !RUN_VARS.test(name) || typeof value !== "string")) {
  fail(`${runFile} must hold an "env" object of ANTHROPIC_* strings`);
}
// Also in the managed settings (claude-config.mjs), for the adapter itself.
Object.assign(env, run, { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });

const child = spawn("claude-agent-acp", process.argv.slice(2), { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`claude launcher: starting claude-agent-acp: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exitCode = code;
});
