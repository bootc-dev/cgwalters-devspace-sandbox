#!/usr/bin/env node
// Check, from a workflow step (as runner), that the agent is contained,
// running things the way the agent step does (agentCommand): no sudo, no
// access to the runner's processes or files, no cloud metadata service,
// also not from a rootless container, and no tailscaled LocalAPI. On the
// tailnet, with --tailnet-allow (as given to setup-runner-sandbox.mjs), it
// reaches only that endpoint. With --egress-proxy, it reaches everything
// else only through the egress proxy (scripts/egress-proxy.mjs): reads and
// the toolchains' fetches work, writes to unlisted endpoints are refused,
// and going around the proxy fails, also from a container; without, its
// network is otherwise open.
// It gets none of the variables that mint the job's OIDC tokens. With
// --run-token-file (agent/praxis.mjs), the praxis run token reaches it only
// in its opencode configuration, which only it can read.
// Exits nonzero if any check fails.
//   agent-isolation-check.mjs [--tailnet-allow URL] [--run-token-file FILE] [--egress-proxy] CONTROL_URL
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { OIDC_REQUEST_VARS, OPENCODE_CONFIG_DIR } from "../agent/praxis.mjs";
import { asAgent } from "./agent-lib.mjs";
import { CA_CERT, PROXY_URL } from "./egress-proxy.mjs";
import { SANDBOX_HOME, SANDBOX_USER, fail } from "./runner-sandbox.mjs";

const METADATA_URL = "http://169.254.169.254/metadata/instance?api-version=2021-02-01";
// Azure's WireServer, which serves the VM's configuration.
const WIRESERVER_URL = "http://168.63.129.16/?comp=versions";
// With --egress-proxy: a write it must refuse, on a host that would take it.
const WRITE_URL = "https://example.com/";
const PUSH_URL = "https://github.com/bootc-dev/bootc.git/git-receive-pack";
const FETCH_REPO = "https://github.com/bootc-dev/bootc";
const PUBLIC_DNS = "8.8.8.8";
// What the toolchains fetch through the proxy: a crate and an npm package.
const CARGO_TOML = '[package]\nname = "egress-check"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nitoa = "1"\n';
const NPM_PACKAGE = "is-number";
const EGRESS_WORK = "egress-check";
// Where a container sees the proxy's CA.
const CONTAINER_CA = "/run/egress-ca.pem";
// Small, and has curl.
const CONTAINER_IMAGE = "registry.access.redhat.com/ubi10/ubi-minimal";
// Any uid other than root in the container maps to a subordinate uid.
const CONTAINER_UID = "1000";
// Where tailscaled listens, on runners that joined the tailnet; the socket
// itself is 0666, its directory root's only (setup-runner-sandbox.mjs).
const TAILSCALE_SOCKET = "/var/run/tailscale/tailscaled.sock";
const LOCALAPI_STATUS = "http://local-tailscaled.sock/localapi/v0/status";

// Another port on the broker's host, which the tailnet ACL may allow but
// runner-sandbox must not reach: SSH, which most hosts listen on.
const OTHER_TAILNET_PORT = 22;

const { values, positionals } = parseArgs({
  options: {
    "tailnet-allow": { type: "string" }, "run-token-file": { type: "string" },
    "egress-proxy": { type: "boolean", default: false },
  },
  allowPositionals: true,
});
const [control] = positionals;
if (!control || positionals.length > 1) {
  fail("usage: agent-isolation-check.mjs [--tailnet-allow URL] [--run-token-file FILE] [--egress-proxy] CONTROL_URL");
}
const egress = values["egress-proxy"];
const tailnetAllow = values["tailnet-allow"];
const runTokenFile = values["run-token-file"];
const OPENCODE_CONFIG = `${SANDBOX_HOME}/${OPENCODE_CONFIG_DIR}/opencode.json`;
// Where runner-sandbox can write, and so where a token handed to it could
// have been left: its home, the shared temporary directories, and its
// runtime directory.
const WRITABLE = [SANDBOX_HOME, "/tmp", "/var/tmp", "/dev/shm"];

// Quad-100, tailscaled's own address: MagicDNS (which answers PTR queries
// for every node) and its web ports.
const QUAD100 = ["100.100.100.100", "fd7a:115c:a1e0::53"];
const QUAD100_PORTS = [53, 80, 8080];

// argv that opens a plain TCP connection, whatever the service speaks.
const tcpProbe = (addr, port) => ["timeout", "10", "bash", "-c", 'exec 3<>"/dev/tcp/$1/$2"', "probe", addr, String(port)];

// tailscaled's status (as root), or {}.
function tailscaleStatus() {
  const r = spawnSync("sudo", ["tailscale", "status", "--json"], { encoding: "utf8", maxBuffer: 1 << 26 });
  try {
    return r.status === 0 ? JSON.parse(r.stdout) : {};
  } catch {
    return {};
  }
}

// The tailnet IPv6 address of the peer with IPv4 address ADDR, or null.
function tailnetV6(status, addr) {
  const ips = Object.values(status.Peer ?? {}).map((p) => p.TailscaleIPs ?? []).find((a) => a.includes(addr)) ?? [];
  return ips.find((ip) => ip.includes(":")) ?? null;
}

// [address, port] of this node's own peerapi, which is reached over lo.
function selfPeerapi(status) {
  return (status.Self?.PeerAPIURL ?? []).flatMap((u) => {
    try {
      const { hostname, port } = new URL(u);
      return [[hostname.replace(/^\[|\]$/g, ""), Number(port)]];
    } catch {
      return [];
    }
  });
}

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
// Not through the egress proxy, whatever the environment says.
const direct = (args) => curl(["--noproxy", "*", ...args]);
// Through it, failing on an error status (it answers 502 when it can't
// connect).
const proxied = (args) => curl(["--fail", ...args]);
// On the host's network; with the egress proxy, its CA is there too.
const inContainer = (cmd) => ["podman", "run", "--rm", "--network=host", "--user", CONTAINER_UID,
  ...(egress ? ["--security-opt", "label=disable", "-v", `${CA_CERT}:${CONTAINER_CA}:ro`] : []), CONTAINER_IMAGE, ...cmd];
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

// The OIDC request variables are in every step's environment, this one's
// too when the job has id-token: write; what runs as runner-sandbox starts
// without them.
// An agent with a run token got it with the job's OIDC token, so the
// variables must be here to be proven absent from the sandbox.
const oidcVars = OIDC_REQUEST_VARS.filter((name) => process.env[name]);
if (runTokenFile || oidcVars.length > 0) {
  expect("succeed", `this step has ${OIDC_REQUEST_VARS.join(" and ")} (control)`, oidcVars.length === OIDC_REQUEST_VARS.length);
} else {
  console.log("note: this step has no OIDC request variables (no id-token: write), so there are none to leak");
}
const agentEnv = asAgent(["env"]).stdout.toString("latin1");
expect("succeed", `${SANDBOX_USER} runs env (control)`, agentEnv.includes(`HOME=${SANDBOX_HOME}`));
expect("fail", `${SANDBOX_USER}'s environment has no ACTIONS_ variables`, /^ACTIONS_/m.test(agentEnv));
for (const name of OIDC_REQUEST_VARS) {
  const value = process.env[name];
  if (value) {
    expect("fail", `no process ${SANDBOX_USER} can read has ${name}'s value`, environs.includes(value));
  }
}

// The run token: runner's file is out of reach; runner-sandbox's copy is
// its opencode configuration, 0600 in a 0700 directory, and nowhere else it
// can write or read a process's environment or command line. The token
// goes to the searches on stdin, never on a command line.
if (runTokenFile) {
  let token = "";
  try {
    token = readFileSync(runTokenFile, "utf8").trim();
  } catch (e) {
    console.log(`note: ${e.message}`);
  }
  expect("succeed", `runner reads the run token (control)`, /^praxis-run-[0-9a-f]{64}$/.test(token));
  expect("fail", `${SANDBOX_USER} can't read ${runTokenFile}`, succeeds(["cat", runTokenFile]));
  const holds = (path) => asAgent(["grep", "-qsF", "-f", "-", "--", path], { input: `${token}\n` }).status === 0;
  expect("succeed", `${SANDBOX_USER}'s ${OPENCODE_CONFIG} holds the run token (control)`, holds(OPENCODE_CONFIG));
  const mode = (path) => {
    const r = spawnSync("sudo", ["stat", "-c", "%U %a", path], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const configDir = OPENCODE_CONFIG.replace(/\/[^/]*$/, "");
  expect("succeed", `${OPENCODE_CONFIG} is ${SANDBOX_USER}'s, mode 600`, mode(OPENCODE_CONFIG) === `${SANDBOX_USER} 600`);
  expect("succeed", `its directory is ${SANDBOX_USER}'s, mode 700`, mode(configDir) === `${SANDBOX_USER} 700`);
  const found = asAgent(["grep", "-rlsF", "-f", "-", "--", ...WRITABLE], { input: `${token}\n` })
    .stdout.toString().split("\n").filter(Boolean);
  expect("succeed", `${SANDBOX_USER} finds the token in no other file it can reach (${found.join(", ") || "only the configuration"})`,
    found.includes(OPENCODE_CONFIG) && found.every((f) => f === OPENCODE_CONFIG));
  const cmdlines = asAgent(["sh", "-c", "cat /proc/[0-9]*/cmdline 2>/dev/null; true"]).stdout.toString("latin1");
  expect("fail", `no process ${SANDBOX_USER} can read has the token in its environment or command line`,
    environs.includes(token) || cmdlines.includes(token));
  // Containers run rootless as runner-sandbox, whose own uid is their
  // root; any other uid in them is a subordinate one.
  const readInContainer = (uid) => succeeds(["podman", "run", "--rm", "--security-opt", "label=disable", "--user", uid,
    "-v", `${configDir}:/config:ro`, CONTAINER_IMAGE, "cat", "/config/opencode.json"]);
  expect("succeed", "a container as its root (runner-sandbox) reads the configuration (control)", readInContainer("0"));
  expect("fail", `a container as subordinate uid ${CONTAINER_UID} can't read the configuration`, readInContainer(CONTAINER_UID));
}
expect("succeed", `${SANDBOX_USER} reaches ${control} (control)`, succeeds(curl([control])));
expect("fail", `${SANDBOX_USER} can't reach the instance metadata service`,
  succeeds(direct(["-H", "Metadata:true", METADATA_URL])));
expect("succeed", `${SANDBOX_USER} pulls ${CONTAINER_IMAGE}`, succeeds(["podman", "pull", "-q", CONTAINER_IMAGE]));
// The control shows the container and its curl work, so the refusal is the
// filter on subordinate uids.
expect("succeed", `a container as subordinate uid ${CONTAINER_UID} reaches ${control} (control)`,
  succeeds(inContainer(curl([...(egress ? ["--cacert", CONTAINER_CA, "-x", PROXY_URL] : []), control]))));
expect("fail", `a container as subordinate uid ${CONTAINER_UID} can't reach the instance metadata service`,
  succeeds(inContainer(direct(["-H", "Metadata:true", METADATA_URL]))));
if (egress) await checkEgress();

// The egress proxy: the toolchains fetch through it, it refuses writes to
// unlisted endpoints (with its X-Egress-Denied header, so the refusal is
// the proxy's own), going around it fails, and it reaches nothing the
// sandbox may not, from a container either.
async function checkEgress() {
  // Headers from a curl run as the agent (or in a container), or "".
  const headers = (cmd) => asAgent(cmd).stdout.toString("latin1");
  const refusedByProxy = (out) => /^HTTP\/[\d.]+ 403\b/m.test(out) && /^x-egress-denied:/im.test(out);
  const head = ["curl", "-sS", "-m", "30", "-o", "/dev/null", "-D", "-"];
  const work = `${SANDBOX_HOME}/${EGRESS_WORK}`;
  asAgent(["rm", "-rf", work]);
  asAgent(["mkdir", "-p", `${work}/crate/src`, `${work}/npm`]);
  asAgent(["tee", `${work}/crate/Cargo.toml`], { input: CARGO_TOML });
  asAgent(["tee", `${work}/crate/src/main.rs`], { input: "fn main() {}\n" });

  expect("succeed", `${SANDBOX_USER} reads ${control} through the egress proxy`, succeeds(proxied(["--proxy", PROXY_URL, control])));
  expect("succeed", `${SANDBOX_USER} fetches a crate with cargo`,
    succeeds(["cargo", "fetch", "--manifest-path", `${work}/crate/Cargo.toml`]));
  expect("succeed", `${SANDBOX_USER} installs ${NPM_PACKAGE} with npm`,
    succeeds(["npm", "install", "--no-fund", "--prefix", `${work}/npm`, NPM_PACKAGE]));
  expect("succeed", `${SANDBOX_USER} fetches from git (POST git-upload-pack)`,
    succeeds(["timeout", "60", "git", "ls-remote", FETCH_REPO, "HEAD"]));

  expect("succeed", `the proxy refuses a POST to ${WRITE_URL}`,
    refusedByProxy(headers([...head, "-X", "POST", "-d", "egress-check", WRITE_URL])));
  expect("succeed", "the proxy refuses a git push (POST git-receive-pack)",
    refusedByProxy(headers([...head, "-X", "POST", "-d", "0000", PUSH_URL])));
  expect("succeed", "the proxy refuses a Host header naming another host than the connection's (domain fronting)",
    refusedByProxy(headers([...head, "-H", "Host: example.com", control])));
  expect("succeed", `a container as subordinate uid ${CONTAINER_UID} on the host's network is refused a POST too`,
    refusedByProxy(headers(inContainer([...head, "--cacert", CONTAINER_CA, "-x", PROXY_URL, "-X", "POST", "-d", "x", WRITE_URL]))));

  expect("fail", `${SANDBOX_USER} can't reach ${control} around the proxy`, succeeds(direct([control])));
  const { address } = await lookup(new URL(control).hostname, { family: 4 });
  expect("fail", `${SANDBOX_USER} can't open a TCP connection to ${address}:443 around the proxy`,
    succeeds(tcpProbe(address, 443)));
  expect("fail", `a container as subordinate uid ${CONTAINER_UID} can't reach ${control} around the proxy`,
    succeeds(inContainer(direct([control]))));
  expect("fail", `a container on its own network can't reach ${control}`,
    succeeds(["podman", "run", "--rm", CONTAINER_IMAGE, ...direct([control])]));
  expect("fail", `${SANDBOX_USER} can't resolve names (getent hosts)`, succeeds(["getent", "hosts", new URL(control).hostname]));
  expect("fail", `${SANDBOX_USER} can't reach a public DNS server (${PUBLIC_DNS}:53)`, succeeds(tcpProbe(PUBLIC_DNS, 53)));
  expect("fail", `${SANDBOX_USER} can't reach the WireServer`, succeeds(direct([WIRESERVER_URL])));
  expect("fail", "the proxy doesn't reach the instance metadata service", succeeds(proxied(["-H", "Metadata:true", METADATA_URL])));
  expect("fail", "the proxy doesn't reach the WireServer", succeeds(proxied([WIRESERVER_URL])));
  if (tailnetAllow) {
    expect("fail", `the proxy doesn't reach ${tailnetAllow} on the tailnet`,
      succeeds(proxied(["--proxy", PROXY_URL, "--noproxy", "", tailnetAllow])));
  }
  asAgent(["rm", "-rf", work]);
}

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

// The tailnet filter: the broker is reachable, and nothing else there, over
// IPv4 or IPv6, quad-100 (MagicDNS included) or this node's own address,
// whether dialed directly or through tailscaled. Where runner reaches a
// target, that's shown as a control; once the ACL is narrowed to the
// broker's port, only this node's own addresses have one.
if (tailnetAllow) {
  const url = new URL(tailnetAllow);
  const host = url.hostname;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  // Any HTTP response will do: the point is the connection.
  expect("succeed", `${SANDBOX_USER} reaches ${tailnetAllow} on the tailnet`, succeeds(curl([tailnetAllow])));
  expect("succeed", `a container as subordinate uid ${CONTAINER_UID} reaches ${tailnetAllow} on the tailnet`,
    succeeds(inContainer(curl([tailnetAllow]))));
  const status = tailscaleStatus();
  const hostV6 = tailnetV6(status, host);
  const targets = [
    [host, OTHER_TAILNET_PORT],
    ...(hostV6 ? [[hostV6, port], [hostV6, OTHER_TAILNET_PORT]] : []),
    ...QUAD100.flatMap((a) => QUAD100_PORTS.map((p) => [a, p])),
    ...selfPeerapi(status),
  ];
  let controlled = 0;
  for (const [addr, p] of targets) {
    const target = addr.includes(":") ? `[${addr}]:${p}` : `${addr}:${p}`;
    const probe = tcpProbe(addr, p);
    if (spawnSync(probe[0], probe.slice(1), { stdio: "ignore" }).status === 0) {
      controlled++;
      expect("succeed", `runner reaches ${target} (control)`, true);
    } else {
      console.log(`note: runner can't reach ${target} either (no control)`);
    }
    expect("fail", `${SANDBOX_USER} can't reach ${target}`, succeeds(probe));
    expect("fail", `a container as subordinate uid ${CONTAINER_UID} can't reach ${target}`, succeeds(inContainer(probe)));
  }
  if (controlled === 0) {
    console.log("note: runner reaches none of these either, so the tailnet ACL already refuses them");
  }
  expect("fail", `${SANDBOX_USER} can't dial ${host}:${OTHER_TAILNET_PORT} through tailscaled (tailscale nc)`,
    succeeds(["timeout", "10", "tailscale", "nc", host, String(OTHER_TAILNET_PORT)]));
}

decoy.kill();
if (failures > 0) fail(`${failures} isolation check(s) failed`);
