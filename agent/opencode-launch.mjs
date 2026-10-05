// Installed in /usr/local/bin as a readable Node script, so the ACP command
// can run it after entering runner-sandbox, without access to runner's checkout.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// The XDG variables that move where opencode reads its configuration and
// keeps its state. The login session's own (XDG_RUNTIME_DIR, XDG_SESSION_*,
// from pam_systemd) stay: the agent's commands need them for rootless podman
// and the user's systemd manager.
const XDG_BASE_DIRS = ["XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_STATE_HOME", "XDG_CACHE_HOME"];

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("OPENCODE_") || XDG_BASE_DIRS.includes(name)) delete env[name];
}
env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
env.OPENCODE_DISABLE_MODELS_FETCH = "1";

// HOME is the sandbox user's home. Never resolve a relative profile against
// the target repository, and leave global configuration selection alone when
// the optional runner profile isn't installed.
if (!env.HOME || !isAbsolute(env.HOME)) {
  console.error("opencode launcher: HOME must be an absolute path");
  process.exit(1);
}
const profile = join(env.HOME, ".config/opencode/opencode-runner.json");
try {
  if (statSync(profile).isFile()) env.OPENCODE_CONFIG = profile;
} catch (error) {
  if (error.code !== "ENOENT") {
    console.error(`opencode launcher: checking ${profile}: ${error.message}`);
    process.exit(1);
  }
}

const child = spawn("opencode", ["acp", ...process.argv.slice(2)], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`opencode launcher: starting opencode: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exitCode = code;
});
