#!/usr/bin/env node
// Check, from a workflow step (as runner), that the agent is contained,
// running things the way the agent step does (agentCommand): no sudo, no
// access to the runner's processes or files, no cloud metadata service,
// also not from a rootless container, and no tailscaled LocalAPI. Its
// network is otherwise open.
// Exits nonzero if any check fails.
//   agent-isolation-check.mjs CONTROL_URL
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { asAgent } from "./agent-lib.mjs";
import { SANDBOX_HOME, SANDBOX_USER, fail } from "./runner-sandbox.mjs";

const METADATA_URL = "http://169.254.169.254/metadata/instance?api-version=2021-02-01";
// Small, and has curl.
const CONTAINER_IMAGE = "registry.access.redhat.com/ubi10/ubi-minimal";
// Any uid other than root in the container maps to a subordinate uid.
const CONTAINER_UID = "1000";
// Where tailscaled listens, on runners that joined the tailnet; the socket
// itself is 0666, its directory root's only (setup-runner-sandbox.mjs).
const TAILSCALE_SOCKET = "/var/run/tailscale/tailscaled.sock";
const LOCALAPI_STATUS = "http://local-tailscaled.sock/localapi/v0/status";

const [control] = process.argv.slice(2);
if (!control) fail("usage: agent-isolation-check.mjs CONTROL_URL");

// A process of runner's whose environment holds a value only it has, as
// a stand-in for the tokens in real step environments.
const canary = `isolation-canary-${randomBytes(12).toString("hex")}`;
const decoy = spawn("sleep", ["300"], { env: { ...process.env, AGENT_ISOLATION_CANARY: canary }, stdio: "ignore" });
const decoyHasCanary = () => {
  try {
    return readFileSync(`/proc/${decoy.pid}/environ`, "latin1").includes(canary);
  } catch {
    return false;
  }
};
for (let i = 0; i < 50 && !decoyHasCanary(); i++) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

let failures = 0;
function expect(want, what, ok) {
  if (ok === (want === "succeed")) {
    console.log(`ok: ${what}`);
  } else {
    console.log(`FAIL: ${what}`);
    failures++;
  }
}
const succeeds = (cmd) => asAgent(cmd).status === 0;
const curl = (args) => ["curl", "-sS", "-m", "30", "-o", "/dev/null", ...args];
const inContainer = (cmd) => ["podman", "run", "--rm", "--network=host", "--user", CONTAINER_UID, CONTAINER_IMAGE, ...cmd];
// Every process environment the agent can read, NUL-separated.
const environs = asAgent(["sh", "-c", "cat /proc/[0-9]*/environ 2>/dev/null; true"]).stdout.toString("latin1");

expect("fail", `${SANDBOX_USER} has no sudo`, succeeds(["sudo", "-n", "true"]));
for (const [pid, what] of [[process.pid, "this step's"], [decoy.pid, "a runner process's"]]) {
  expect("fail", `${SANDBOX_USER} can't read ${what} environment`, succeeds(["cat", `/proc/${pid}/environ`]));
}
expect("succeed", "runner reads the canary in its own process's environment (control)", decoyHasCanary());
expect("succeed", `${SANDBOX_USER} reads its own processes' environments (control)`, environs.includes(`HOME=${SANDBOX_HOME}`));
expect("fail", `no environment ${SANDBOX_USER} can read holds the canary or ACTIONS_ variables`,
  environs.includes(canary) || environs.includes("ACTIONS_"));
expect("fail", `${SANDBOX_USER} can't list the runner's home`, succeeds(["ls", "/home/runner"]));
expect("succeed", `${SANDBOX_USER} reaches ${control} (control)`, succeeds(curl([control])));
expect("fail", `${SANDBOX_USER} can't reach the instance metadata service`,
  succeeds(curl(["-H", "Metadata:true", METADATA_URL])));
expect("succeed", `${SANDBOX_USER} pulls ${CONTAINER_IMAGE}`, succeeds(["podman", "pull", "-q", CONTAINER_IMAGE]));
// The control shows the container and its curl work, so the refusal is the
// filter on subordinate uids.
expect("succeed", `a container as subordinate uid ${CONTAINER_UID} reaches ${control} (control)`,
  succeeds(inContainer(curl([control]))));
expect("fail", `a container as subordinate uid ${CONTAINER_UID} can't reach the instance metadata service`,
  succeeds(inContainer(curl(["-H", "Metadata:true", METADATA_URL]))));

// Through the LocalAPI, tailscaled would dial and list the tailnet for
// anyone, whatever the packet filter says.
if (spawnSync("sudo", ["test", "-S", TAILSCALE_SOCKET]).status === 0) {
  expect("succeed", "root uses tailscaled's LocalAPI (control)",
    spawnSync("sudo", ["tailscale", "status", "--self"], { stdio: "ignore" }).status === 0);
  expect("fail", `${SANDBOX_USER} can't run tailscale status`, succeeds(["tailscale", "status"]));
  expect("fail", `${SANDBOX_USER} can't call tailscaled's LocalAPI`,
    succeeds(["curl", "-sS", "-m", "10", "-o", "/dev/null", "--unix-socket", TAILSCALE_SOCKET, LOCALAPI_STATUS]));
} else {
  console.log("ok: no tailscaled on this runner, so no LocalAPI to reach");
}

decoy.kill();
if (failures > 0) fail(`${failures} isolation check(s) failed`);
