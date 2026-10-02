#!/usr/bin/env node
// The egress proxy runner-sandbox's network goes through in agent runs: a
// mitmproxy (mitmdump) with agent/egress/addon.py, which terminates TLS
// with its own CA, leaves reads open but for a threat feed, allows writes
// (POST and the like) only to the endpoints in agent/egress/policy.toml,
// and logs what was reached, without headers or query strings.
// setup-runner-sandbox.mjs --egress-proxy then points runner-sandbox at it
// and rejects everything else it sends out.
//
//   egress-proxy.mjs start          as root: install and start it
//   egress-proxy.mjs collect DEST [OFFSET]
//                                   copy its access log (from byte OFFSET)
//                                   to DEST, and print summary.json's
//                                   egress_denied
//
// It runs as its own system user, EGRESS_USER, as a transient systemd
// service: runner-sandbox can't signal it, read its CA key or change its
// policy, and the nftables rules keep that uid off the tailnet, the cloud
// metadata service, the host's WireServer and private addresses.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, run } from "./runner-sandbox.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(ROOT, "agent/egress");
const SOURCE_FILES = ["addon.py", "policy.py", "policy.toml"];
const REQUIREMENTS = join(SOURCE_DIR, "requirements.txt");

export const EGRESS_USER = "egress-proxy";
export const PROXY_HOST = "127.0.0.1";
export const PROXY_PORT = 3128;
export const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;
// Root's: the venv and a copy of the addon and policy (runner's checkout
// is private to runner).
const INSTALL_DIR = "/opt/egress-proxy";
const POLICY_DIR = join(INSTALL_DIR, "policy");
const DENYLIST = join(INSTALL_DIR, "denylist.txt");
// The proxy's own (systemd's StateDirectory and LogsDirectory): its CA key
// stays in STATE_DIR, mode 0700.
const UNIT = "egress-proxy.service";
const STATE_DIR = `/var/lib/${EGRESS_USER}`;
const LOG_DIR = `/var/log/${EGRESS_USER}`;
const ACCESS_LOG = join(LOG_DIR, "access.jsonl");
// mitmproxy writes its CA into its confdir on first start.
const CA_CERT_GENERATED = join(STATE_DIR, "mitmproxy-ca-cert.pem");
// What runner-sandbox trusts: the CA alone (for NODE_EXTRA_CA_CERTS), and
// the system bundle plus the CA (for everything that replaces the bundle).
const PUBLIC_DIR = "/etc/egress-proxy";
export const CA_CERT = join(PUBLIC_DIR, "ca.pem");
export const CA_BUNDLE = join(PUBLIC_DIR, "ca-bundle.pem");
const SYSTEM_BUNDLES = ["/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/certs/ca-certificates.crt"];
// HaGeZi's Threat Intelligence Feeds, medium (about 700k domains, each with
// its subdomains): known malware, phishing and C2 hosts. It deliberately
// lists none of the big platforms, so it complements the write allowlist
// rather than replacing it. A fetch that fails leaves the feed empty, with
// a warning: it's hardening, not the boundary.
const DENYLIST_URL = "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.medium-onlydomains.txt";
const DENYLIST_MIN_ENTRIES = 1000;
const START_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;

// The unit's sandboxing: it needs only its state and log directories.
const UNIT_PROPERTIES = [
  `User=${EGRESS_USER}`, `Group=${EGRESS_USER}`,
  `StateDirectory=${EGRESS_USER}`, "StateDirectoryMode=0700",
  `LogsDirectory=${EGRESS_USER}`, "LogsDirectoryMode=0750",
  "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes",
  "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectControlGroups=yes", "RestrictSUIDSGID=yes",
  "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX", "CapabilityBoundingSet=", "LockPersonality=yes",
  "Restart=on-failure", `Environment=HOME=${STATE_DIR}`, "UMask=0077",
];

function mitmdumpArgs() {
  return [join(INSTALL_DIR, "bin/mitmdump"), "--mode", "regular", "--listen-host", PROXY_HOST,
    "--listen-port", String(PROXY_PORT), "--set", `confdir=${STATE_DIR}`,
    // Connect upstream only for a request the policy allows; without raw
    // TCP, whatever goes through a tunnel is parsed as HTTP, so other
    // protocols fail instead of passing unseen.
    "--set", "connection_strategy=lazy", "--set", "rawtcp=false",
    "--set", "flow_detail=0", "--set", "termlog_verbosity=warn",
    "-s", join(POLICY_DIR, "addon.py"), "--set", `egress_policy=${join(POLICY_DIR, "policy.toml")}`,
    "--set", `egress_denylist=${existsSync(DENYLIST) ? DENYLIST : ""}`, "--set", `egress_log=${ACCESS_LOG}`];
}

function install() {
  if (spawnSync("id", [EGRESS_USER], { stdio: "ignore" }).status !== 0) {
    run("useradd", ["--system", "--no-create-home", "--home-dir", STATE_DIR, "--shell", "/sbin/nologin", EGRESS_USER]);
  }
  run("python3", ["-m", "venv", INSTALL_DIR]);
  run(join(INSTALL_DIR, "bin/pip"), ["install", "--quiet", "--disable-pip-version-check", "-r", REQUIREMENTS]);
  mkdirSync(POLICY_DIR, { recursive: true, mode: 0o755 });
  for (const name of SOURCE_FILES) copyFileSync(join(SOURCE_DIR, name), join(POLICY_DIR, name));
}

async function fetchDenylist() {
  try {
    const r = await fetch(DENYLIST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const entries = text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).length;
    if (entries < DENYLIST_MIN_ENTRIES) throw new Error(`only ${entries} entries`);
    writeFileSync(DENYLIST, text, { mode: 0o644 });
    console.log(`threat feed: ${entries} domains from ${DENYLIST_URL}`);
  } catch (e) {
    console.log(`::warning::egress proxy runs without a threat feed: fetching ${DENYLIST_URL} failed (${e.message})`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listening() {
  return new Promise((resolve) => {
    const s = createConnection({ host: PROXY_HOST, port: PROXY_PORT }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

function unitActive() {
  return spawnSync("systemctl", ["is-active", "--quiet", UNIT]).status === 0;
}

// Waits until the proxy listens and has written its CA.
async function waitStarted() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(CA_CERT_GENERATED) && await listening()) return;
    if (!unitActive()) break;
    await sleep(500);
  }
  spawnSync("journalctl", ["-u", UNIT, "--no-pager", "-n", "50"], { stdio: "inherit" });
  throw new Error(`${UNIT} didn't start listening on ${PROXY_URL}`);
}

// Publishes the CA certificate, alone and appended to the system bundle.
function publishCa() {
  const system = SYSTEM_BUNDLES.find((p) => existsSync(p));
  if (!system) throw new Error(`no system CA bundle (${SYSTEM_BUNDLES.join(", ")})`);
  const ca = readFileSync(CA_CERT_GENERATED, "utf8");
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error(`${CA_CERT_GENERATED} holds no certificate`);
  mkdirSync(PUBLIC_DIR, { recursive: true, mode: 0o755 });
  writeFileSync(CA_CERT, ca, { mode: 0o644 });
  writeFileSync(CA_BUNDLE, `${readFileSync(system, "utf8").trimEnd()}\n${ca}`, { mode: 0o644 });
}

async function start() {
  if (process.getuid() !== 0) throw new Error("must run as root");
  install();
  await fetchDenylist();
  run("systemd-run", [`--unit=${UNIT}`, "--service-type=exec", "--collect",
    ...UNIT_PROPERTIES.map((p) => `--property=${p}`), "--", ...mitmdumpArgs()]);
  await waitStarted();
  publishCa();
  console.log(`egress proxy listening on ${PROXY_URL} as ${EGRESS_USER}; CA in ${CA_CERT}`);
}

// summary.json's egress_denied: refused requests per host, most first.
export function egressDenied(log) {
  const counts = new Map();
  for (const line of log.split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.decision !== "deny" || typeof entry.host !== "string") continue;
    counts.set(entry.host, (counts.get(entry.host) ?? 0) + 1);
  }
  return [...counts].map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

// The access log's size now (0 without one), to collect what comes later.
export function logOffset() {
  const r = spawnSync("sudo", ["stat", "-c", "%s", ACCESS_LOG], { encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}

// Copies the access log (root's), from byte OFFSET on, to DEST; returns
// egress_denied, or null when there is no log (no proxy ran).
export function collect(dest, offset = 0) {
  if (spawnSync("sudo", ["test", "-e", ACCESS_LOG]).status !== 0) return null;
  const r = spawnSync("sudo", ["tail", "-c", `+${offset + 1}`, ACCESS_LOG], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`can't read ${ACCESS_LOG}`);
  writeFileSync(dest, r.stdout);
  return egressDenied(r.stdout);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "start" && args.length === 0) {
      await start();
    } else if (command === "collect" && (args.length === 1 || args.length === 2)) {
      console.log(JSON.stringify(collect(args[0], Number(args[1] ?? 0))));
    } else {
      fail("usage: egress-proxy.mjs start | collect DEST [OFFSET]");
    }
  } catch (e) {
    fail(`${process.argv[1]}: ${e.message}`);
  }
}
