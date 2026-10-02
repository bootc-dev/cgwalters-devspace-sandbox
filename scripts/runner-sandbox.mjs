// The unprivileged runner-sandbox user that SSH sessions and agent runs use
// (created by setup-runner-sandbox.mjs): who it is, and how a workflow step
// runs a command as it, with nothing of the step's environment.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const SANDBOX_USER = "runner-sandbox";
export const SANDBOX_HOME = `/home/${SANDBOX_USER}`;
const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin";
// Where agent.yml installs the Rust toolchain (rustup's proxies are in
// /usr/local/bin); CARGO_HOME stays the user's own, in its home.
const RUSTUP_HOME = "/opt/rustup";
// run0 sets these as sudo would, and tools that see them may act as if run
// under sudo; --setenv can't unset them.
const SUDO_VARS = ["SUDO_USER", "SUDO_UID", "SUDO_GID"];
// What lets a process mint the job's OIDC tokens (every step of a job with
// id-token: write has them). run0 passes on none of the caller's
// environment, so they never reach runner-sandbox; they are refused in ENV
// and unset all the same, so that stays true if the wrapper changes.
const FORBIDDEN_VARS = /^ACTIONS_/;
const OIDC_REQUEST_VARS = ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
// Root's: what every runner-sandbox command gets in its environment, as a
// JSON object of strings. setup-runner-sandbox.mjs --egress-proxy writes
// it (the proxy and its CA).
export const SANDBOX_ENV_FILE = "/etc/runner-sandbox/environment.json";

// The variables in SANDBOX_ENV_FILE, if there is one.
function sandboxEnvironment() {
  if (!existsSync(SANDBOX_ENV_FILE)) return {};
  const env = JSON.parse(readFileSync(SANDBOX_ENV_FILE, "utf8"));
  if (!env || typeof env !== "object" || Object.values(env).some((v) => typeof v !== "string")) {
    throw new Error(`${SANDBOX_ENV_FILE} must be a JSON object of strings`);
  }
  return env;
}

export function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// Runs a command, returning its stdout; throws if it fails.
export function run(cmd, args, { input } = {}) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.error ?? `exit ${r.status}`})`);
  }
  return r.stdout.trim();
}

// The argv that runs CMD as runner-sandbox in a login session of its own,
// with only a fixed environment plus ENV. run0 starts it as a transient
// systemd service through its PAM stack (which has no pam_env), so nothing
// of the calling step's environment or cgroup comes along, and pam_systemd
// gives it what an SSH login gets: XDG_RUNTIME_DIR, the user's systemd
// manager and session bus, which rootless podman relies on. The command
// runs in that session's scope, under user-UID.slice. Its environment
// includes SANDBOX_ENV_FILE's variables. Unlike machinectl
// shell, which always allocates a pty, stdio stays pipes (binary safe,
// stderr apart, EOF on stdin) and the exit status comes back. They must be
// sockets: run0 hands them to PID 1 over D-Bus, which refuses regular
// files, and SELinux keeps PID 1 from reading a pipe this service made.
// spawnSync's 'pipe' stdio is a socketpair; elsewhere, scripts/socket-stdio.mjs.
export function sandboxCommand(cmd, { cwd = SANDBOX_HOME, env = {} } = {}) {
  const forbidden = Object.keys(env).filter((k) => FORBIDDEN_VARS.test(k));
  if (forbidden.length > 0) throw new Error(`refusing to pass ${forbidden.join(", ")} to ${SANDBOX_USER}`);
  const vars = { LANG: "C.UTF-8", PATH: SANDBOX_PATH, RUSTUP_HOME, ...sandboxEnvironment(), ...env };
  // Unlike systemd-run --collect, run0 leaves a failed unit behind for
  // every command that exits nonzero.
  const argv = ["run0", "--pipe", "--no-ask-password", "--shell-prompt-prefix=", `--user=${SANDBOX_USER}`,
    "--property=CollectMode=inactive-or-failed", `--chdir=${cwd}`, ...Object.entries(vars).map(([k, v]) => `--setenv=${k}=${v}`), "--",
    "env", ...[...SUDO_VARS, ...OIDC_REQUEST_VARS].flatMap((v) => ["-u", v]), "--", ...cmd];
  return process.getuid() === 0 ? [argv[0], argv.slice(1)] : ["sudo", argv];
}

// Runs CMD as runner-sandbox; returns {status, stdout} (stdout as a Buffer;
// stderr is dropped).
export function asSandbox(cmd, opts = {}) {
  const [bin, args] = sandboxCommand(cmd, opts);
  const r = spawnSync(bin, args, { input: opts.input ?? "", stdio: "pipe", maxBuffer: 1 << 30 });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0) };
}
