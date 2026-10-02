#!/usr/bin/env node
// Create the unprivileged user that SSH sessions and agent runs use, and
// close what would let it reach the runner user's credentials. Run as root.
//
// Every step runs as runner, which has passwordless sudo; the running steps'
// environments hold ACTIONS_ID_TOKEN_REQUEST_TOKEN, which mints the OIDC
// tokens the Tailscale login trusts. The boundary is the separate uid: it
// can't read another uid's /proc/PID/environ or memory, and has no sudo.
// What else it needs is kept to real exposures of this runner image, which
// is built with umask 000.
//
//   setup-runner-sandbox.mjs [--init JUSTFILE] [--tailnet-allow URL]... [--egress-proxy]
//
// With --init, it then runs JUSTFILE's init recipe as runner-sandbox, in
// its home directory (devspace.yml: the bot's dotfiles).
// With --tailnet-allow, runner-sandbox's uids reach the tailnet only at
// each URL's address and port (agent.yml: the inference broker); not
// MagicDNS either, which would name every node, so the host's resolver must
// be off the tailnet (agent.yml: --accept-dns=false). That's defence in
// depth under the tailnet ACL for the runner's tag, which is the real
// control and today is broader.
// With --egress-proxy (agent.yml), once egress-proxy.mjs has started it,
// runner-sandbox's uids reach the network only through that proxy, the
// --tailnet-allow endpoints and loopback; anything else they send is
// rejected, DNS included (the proxy resolves names), so the proxy can't be
// bypassed, from a container either. Their commands get the proxy and its
// CA in their environment (SANDBOX_ENV_FILE), with the --tailnet-allow
// hosts in NO_PROXY: the broker is reached directly, so the run token
// never passes through the proxy. The proxy's own uid is kept off the
// tailnet, the metadata service, the WireServer and private addresses, so
// the proxy can't be used to reach them either.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isIPv4 } from "node:net";
import { parseArgs } from "node:util";
import { CA_BUNDLE, CA_CERT, EGRESS_USER, PROXY_URL } from "./egress-proxy.mjs";
import { SANDBOX_ENV_FILE, SANDBOX_HOME, SANDBOX_USER, run, sandboxCommand } from "./runner-sandbox.mjs";

// /dev/kvm is already 0666; the group documents the intent. Not libvirt:
// its polkit rule grants all of qemu:///system, which is root-equivalent.
const SANDBOX_GROUPS = "kvm";
// The runner's .credentials and the hosted compute agent's token
// (/opt/hca/.settings, RHEL runners only) are world-readable.
const PRIVATE_DIRS = ["/home/runner", "/opt/hca"];
// Sticky world-writable directories, meant to stay that way.
const SHARED_TMP = ["/tmp", "/var/tmp"];
const NFT_TABLE = "runner_sandbox";
// The image leaves this group-writable, and ssh refuses to run with a
// group-writable included config: plain ssh and git over ssh fail for
// runner-sandbox.
const SSH_CRYPTO_POLICY = "/etc/crypto-policies/back-ends/openssh.config";
// The image's /etc/environment sets XDG_RUNTIME_DIR to runner's, and PAM
// hands that to every session, runner-sandbox's SSH logins and systemd user
// manager included, which breaks their session bus and rootless podman.
// TODO: drop this once the runner image stops setting it:
// https://github.com/actions/runner-images/issues/14649
const ENVIRONMENT = "/etc/environment";
const IMAGE_ENV_VARS = ["XDG_RUNTIME_DIR"];
const METADATA_ADDRESS = "169.254.169.254";
// runner-sandbox is in no sudoers rule or admin group; this makes that
// explicit (the last matching sudoers rule wins, hence the name).
const SUDOERS_DENY = "/etc/sudoers.d/zz-runner-sandbox";
// And polkit says no to it before any other rule is consulted, which also
// covers pkexec.
const POLKIT_RULES_DIR = "/etc/polkit-1/rules.d";
const POLKIT_DENY = `${POLKIT_RULES_DIR}/00-runner-sandbox.rules`;
// tailscaled's LocalAPI socket is 0666, and the API has no permission check
// for dialing: through it (tailscale nc, tailscale status), any user reaches
// every node the runner's tag may, as tailscaled rather than as itself, and
// sees the whole tailnet. Only root needs it. tailscaled leaves an existing
// directory's mode alone when it restarts.
const TAILSCALE_RUN_DIR = "/var/run/tailscale";
// Tailscale's address ranges and its interface. The filter matches both:
// the interface because with --accept-routes, which the Tailscale action
// passes, subnet routes send other addresses there too, and the ranges
// because the node's own tailnet address (tailscaled's peerapi) is reached
// over lo.
const TAILNET_V4 = "100.64.0.0/10";
const TAILNET_V6 = "fd7a:115c:a1e0::/48";
const TAILSCALE_IF = "tailscale0";
const DEFAULT_PORTS = { "http:": 80, "https:": 443 };

// The "ADDRESS . PORT" nftables element for a tailnet URL, such as
// http://100.101.102.103:18080/v1. Only IPv4 literals: nftables matches
// addresses, and a name could resolve elsewhere later.
function tailnetEndpoint(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`--tailnet-allow: '${url}' is not a URL`);
  }
  const port = u.port ? Number(u.port) : DEFAULT_PORTS[u.protocol];
  if (!port) throw new Error(`--tailnet-allow: '${url}' is not an http or https URL`);
  const [a, b] = u.hostname.split(".").map(Number);
  if (!isIPv4(u.hostname) || a !== 100 || b < 64 || b > 127) {
    throw new Error(`--tailnet-allow: '${u.hostname}' is not a tailnet IPv4 address (${TAILNET_V4})`);
  }
  return `${u.hostname} . ${port}`;
}

// Where the egress proxy may not connect, whatever a name resolves to:
// loopback, private, link-local (the metadata service), shared (the
// tailnet), multicast and reserved addresses, and Azure's WireServer, which
// serves the VM's configuration. DNS is allowed before these, so the
// proxy can use the host's resolver.
const WIRESERVER = "168.63.129.16";
const PROXY_DENIED_V4 = ["0.0.0.0/8", "10.0.0.0/8", TAILNET_V4, "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3", WIRESERVER];
const PROXY_DENIED_V6 = ["::1/128", "::ffff:0:0/96", "fc00::/7", "fe80::/10", "ff00::/8"];
const DNS_PORT = 53;

// The output rules for runner-sandbox's uids: no metadata service and,
// with ALLOWED endpoints, nothing out of the Tailscale interface or to a
// tailnet address (quad-100 and this node's own included) but those.
// With PROXY_UID (--egress-proxy), nothing else at all but loopback (not
// its DNS), where the proxy listens; and the proxy's uid opens
// connections only to DNS and public addresses (its answers to
// runner-sandbox go over loopback). Rejected rather than dropped, so a blocked
// connection fails at once. The tailnet rules are defence in depth: the
// tailnet ACL for the runner's tag is the real control, and connections
// tailscaled makes itself (its LocalAPI, closed to other users) aren't
// runner-sandbox's.
function sandboxRules(uids, allowed, proxyUid) {
  const tailnet = allowed.length === 0 ? "" : `
  set tailnet_allowed { type ipv4_addr . inet_service; elements = { ${allowed.join(", ")} } }`;
  const tailnetRules = allowed.length === 0 ? "" : `
    meta skuid @sandbox_uids ip daddr . tcp dport @tailnet_allowed accept
    meta skuid @sandbox_uids oifname "${TAILSCALE_IF}" counter reject
    meta skuid @sandbox_uids ip daddr ${TAILNET_V4} counter reject
    meta skuid @sandbox_uids ip6 daddr ${TAILNET_V6} counter reject`;
  const egressRules = proxyUid === undefined ? "" : `
    meta skuid @sandbox_uids oifname "lo" meta l4proto { tcp, udp } th dport ${DNS_PORT} counter reject
    meta skuid @sandbox_uids oifname "lo" ip daddr 127.0.0.0/8 accept
    meta skuid @sandbox_uids oifname "lo" ip6 daddr ::1 accept
    meta skuid @sandbox_uids counter reject
    meta skuid ${proxyUid} ct state established,related accept
    meta skuid ${proxyUid} oifname "${TAILSCALE_IF}" counter reject
    meta skuid ${proxyUid} ip daddr ${TAILNET_V4} counter reject
    meta skuid ${proxyUid} ip6 daddr ${TAILNET_V6} counter reject
    meta skuid ${proxyUid} meta l4proto { tcp, udp } th dport ${DNS_PORT} accept
    meta skuid ${proxyUid} ip daddr { ${PROXY_DENIED_V4.join(", ")} } counter reject
    meta skuid ${proxyUid} ip6 daddr { ${PROXY_DENIED_V6.join(", ")} } counter reject`;
  return `table inet ${NFT_TABLE}
delete table inet ${NFT_TABLE}
table inet ${NFT_TABLE} {
  set sandbox_uids { type uid; flags interval; elements = { ${uids.join(", ")} } }${tailnet}
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid @sandbox_uids ip daddr ${METADATA_ADDRESS} counter reject${tailnetRules}${egressRules}
  }
}
`;
}

// The environment runner-sandbox's commands get to use the egress proxy
// (runner-sandbox.mjs reads it): the proxy, but not for loopback and the
// DIRECT hosts (--tailnet-allow), and its CA in the forms the usual tools
// read. SSL_CERT_FILE and the like replace the system bundle, so they get
// the bundle with the CA added.
function proxyEnvironment(direct) {
  const noProxy = ["localhost", "127.0.0.1", "::1", ...direct].join(",");
  const bundle = ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "CARGO_HTTP_CAINFO", "GIT_SSL_CAINFO", "REQUESTS_CA_BUNDLE",
    "PIP_CERT"];
  return {
    HTTP_PROXY: PROXY_URL, HTTPS_PROXY: PROXY_URL, http_proxy: PROXY_URL, https_proxy: PROXY_URL,
    NO_PROXY: noProxy, no_proxy: noProxy,
    // Node's own fetch uses the proxy variables only with this.
    NODE_USE_ENV_PROXY: "1", NODE_EXTRA_CA_CERTS: CA_CERT,
    ...Object.fromEntries(bundle.map((name) => [name, CA_BUNDLE])),
  };
}

// Writes ENV (or, with none, removes the file) for runner-sandbox.mjs.
function writeSandboxEnvironment(env) {
  if (!env) {
    rmSync(SANDBOX_ENV_FILE, { force: true });
    return;
  }
  mkdirSync(dirname(SANDBOX_ENV_FILE), { recursive: true, mode: 0o755 });
  installConfig(SANDBOX_ENV_FILE, `${JSON.stringify(env, null, 2)}\n`, 0o644);
}

// The egress proxy's uid, once egress-proxy.mjs has started it.
function proxyUid() {
  for (const path of [CA_CERT, CA_BUNDLE]) {
    if (!existsSync(path)) throw new Error(`--egress-proxy: ${path} is missing (start it with egress-proxy.mjs start)`);
  }
  return Number(run("id", ["-u", EGRESS_USER]));
}

// Loads an nftables ruleset, from a file.
function nftApply(ruleset) {
  const dir = mkdtempSync(join(tmpdir(), "runner-sandbox-nft-"));
  try {
    writeFileSync(join(dir, "rules.nft"), ruleset);
    run("nft", ["-f", join(dir, "rules.nft")]);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

// Removes IMAGE_ENV_VARS from /etc/environment, keeping everything else.
function dropImageEnvironment() {
  if (!existsSync(ENVIRONMENT)) return;
  const lines = readFileSync(ENVIRONMENT, "utf8").split("\n");
  const kept = lines.filter((l) => !IMAGE_ENV_VARS.some((v) => l.trim().startsWith(`${v}=`)));
  if (kept.length === lines.length) return;
  const tmp = `${ENVIRONMENT}.runner-sandbox`;
  writeFileSync(tmp, kept.join("\n"), { mode: statSync(ENVIRONMENT).mode & 0o7777 });
  renameSync(tmp, ENVIRONMENT);
  run("restorecon", [ENVIRONMENT]);
}

// Installs a root-owned config file with MODE, once VALIDATE (an argv to
// which the path is appended), if given, accepts it.
function installConfig(path, content, mode, validate) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  try {
    if (validate) run(validate[0], [...validate.slice(1), tmp]);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  run("restorecon", [path]);
}

// Takes away runner-sandbox's sudo access, and its polkit access if polkit
// is installed.
function denyPrivileges() {
  installConfig(SUDOERS_DENY, `${SANDBOX_USER} ALL=(ALL:ALL) !ALL\n`, 0o440, ["visudo", "-q", "-c", "-f"]);
  if (existsSync(POLKIT_RULES_DIR)) {
    installConfig(POLKIT_DENY, `polkit.addRule(function(action, subject) {
  if (subject.user == "${SANDBOX_USER}") return polkit.Result.NO;
});
`, 0o644);
  }
}

// uid and subordinate uid ranges ("start-end") of a user.
function sandboxUids(user, subuid) {
  const ranges = subuid.split("\n").map((line) => line.split(":"))
    .filter(([name, start, count]) => name === user && start && count)
    .map(([, start, count]) => `${start}-${Number(start) + Number(count) - 1}`);
  if (ranges.length === 0) {
    throw new Error(`${user} has no subordinate uids in /etc/subuid, which rootless podman needs`);
  }
  return ranges;
}

// Runs JUSTFILE's init recipe as runner-sandbox. The checkout is private to
// runner, so the Justfile goes through a readable copy.
function init(justfile) {
  const dir = mkdtempSync(join(tmpdir(), "runner-sandbox-init-"));
  try {
    chmodSync(dir, 0o755);
    const copy = join(dir, "Justfile");
    copyFileSync(justfile, copy);
    chmodSync(copy, 0o644);
    const [bin, args] = sandboxCommand(["just", "--justfile", copy, "--working-directory", SANDBOX_HOME, "init"]);
    const r = spawnSync(bin, args, { input: "", stdio: "pipe", maxBuffer: 1 << 28 });
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    if (r.status !== 0) {
      throw new Error(`just init as ${SANDBOX_USER} failed (${r.error ?? `exit ${r.status}`})`);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      init: { type: "string" }, "tailnet-allow": { type: "string", multiple: true, default: [] },
      "egress-proxy": { type: "boolean", default: false },
    },
  });
  const allowed = values["tailnet-allow"].map(tailnetEndpoint);
  if (process.getuid() !== 0) {
    throw new Error("must run as root");
  }
  if (spawnSync("id", [SANDBOX_USER], { stdio: "ignore" }).status !== 0) {
    // useradd assigns subordinate uids and gids too.
    run("useradd", ["--create-home", "--user-group", "--groups", SANDBOX_GROUPS, SANDBOX_USER]);
  }
  const uid = Number(run("id", ["-u", SANDBOX_USER]));
  const subuids = sandboxUids(SANDBOX_USER, readFileSync("/etc/subuid", "utf8"));
  denyPrivileges();
  dropImageEnvironment();

  for (const dir of [...PRIVATE_DIRS, TAILSCALE_RUN_DIR].filter((d) => existsSync(d))) {
    chmodSync(dir, 0o700);
  }
  // World-writable system files include ones root loads code from:
  // runner-sandbox could add a polkit rule granting itself anything, and so become root.
  const prune = SHARED_TMP.flatMap((d) => ["-path", d, "-o"]);
  run("find", ["/", "-xdev", "(", ...prune, "-false", ")", "-prune", "-o",
    "(", "-type", "f", "-o", "-type", "d", ")", "-perm", "-0002", "!", "-perm", "-1000",
    "-exec", "chmod", "o-w", "{}", "+"]);
  if (existsSync(SSH_CRYPTO_POLICY)) {
    chmodSync(SSH_CRYPTO_POLICY, statSync(SSH_CRYPTO_POLICY).mode & 0o7757);
  }

  // Hardening only (the uid split is the boundary): the image lets any
  // process attach to any other of its uid.
  writeFileSync("/proc/sys/kernel/yama/ptrace_scope", "1\n");
  // Nothing runner-sandbox does needs the cloud metadata service; its
  // rootless containers run as its subordinate uids.
  const proxy = values["egress-proxy"] ? proxyUid() : undefined;
  writeSandboxEnvironment(proxy === undefined ? null
    : proxyEnvironment(values["tailnet-allow"].map((u) => new URL(u).hostname)));
  nftApply(sandboxRules([uid, ...subuids], allowed, proxy));
  if (proxy !== undefined) console.log(`${SANDBOX_USER} reaches the network only through the egress proxy, ${PROXY_URL}`);
  console.log(`Unprivileged user ${SANDBOX_USER}: ${run("id", [SANDBOX_USER])}`);
  if (values.init) {
    init(values.init);
  }
}

try {
  main();
} catch (e) {
  console.error(`error: ${process.argv[1]}: ${e.message}`);
  process.exit(1);
}
