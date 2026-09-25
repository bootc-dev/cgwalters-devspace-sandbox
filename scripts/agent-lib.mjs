// Shared by the scripts that run and check the agent: running a command as
// runner-sandbox (scripts/runner-sandbox.mjs), and stopping all of it.
import { spawnSync } from "node:child_process";
import { SANDBOX_USER, asSandbox, sandboxCommand } from "./runner-sandbox.mjs";

// The agent runs like any other runner-sandbox command: each in a login
// session of its own (run0), whose scope is under user-UID.slice.
export { sandboxCommand as agentCommand, asSandbox as asAgent };

// runner-sandbox's login sessions, the agent's among them.
function sandboxSessions() {
  const r = spawnSync("loginctl", ["show-user", SANDBOX_USER, "--property=Sessions", "--value"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\s+/).filter(Boolean) : [];
}

// Stops everything the agent started. Its sessions go first: a session
// scope holds every process started in it, including ones that left their
// process group (setsid, double forks). Then, as backstops, the user slice
// (the user manager, and services it started), a user manager it may have
// kept by enabling lingering, and stray processes of its uid.
export function killAgent() {
  const uid = spawnSync("id", ["-u", SANDBOX_USER], { encoding: "utf8" }).stdout.trim();
  const sessions = sandboxSessions();
  const steps = [
    ...(sessions.length > 0
      ? [["loginctl", "kill-session", "--signal=KILL", ...sessions], ["loginctl", "terminate-session", ...sessions]] : []),
    ...(uid ? [["systemctl", "kill", "--signal=KILL", `user-${uid}.slice`]] : []),
    ["loginctl", "disable-linger", SANDBOX_USER], ["loginctl", "terminate-user", SANDBOX_USER],
    ["pkill", "-KILL", "-u", SANDBOX_USER],
    // Killed like that, the user manager is left failed.
    ...(uid ? [["systemctl", "reset-failed", `user@${uid}.service`]] : []),
  ];
  for (const args of steps) {
    spawnSync("sudo", args, { stdio: "ignore" });
  }
}
