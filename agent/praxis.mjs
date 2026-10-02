#!/usr/bin/env node
// The job's side of a praxis run (cgwalters-bot/praxis-credential-broker's
// run tokens, INTERNALS.md "Run tokens"): the supervisor registers this
// job's run with an OIDC token, gives the agent only the run token it gets
// back, and ends the run when the agent is done, keeping its usage record
// for summary.json.
//
//   praxis.mjs register DIR      needs ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN
//   praxis.mjs configure DIR     writes runner-sandbox's opencode.json
//   praxis.mjs finish DIR        ends the run; DIR/usage.json is its record
//
// PRAXIS_BASE_URL is the broker's Responses base URL (http://HOST:PORT/v1);
// its runs endpoint is beside it. DIR is runner's own (mode 0700): it holds
// the run token, which reaches runner-sandbox only in its opencode.json.
//
// A broker from before run tokens has no runs endpoint (404). It needs no
// token and has none to give, so register marks DIR (LEGACY_FILE) and the
// agent keeps the placeholder key it always had: that grants nothing a
// broker with run tokens would honor, since that broker refuses requests
// without a run token and always answers registrations. This lets the
// workflow land before the broker's cutover; it goes once the broker has
// run tokens.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENCODE_CONFIG_DIR, installOpencodeConfig } from "./opencode-config.mjs";

// The audience praxis expects (its RUN_OIDC_AUDIENCE default).
export const AUDIENCE = "praxis-credential-broker";
export const TOKEN_FILE = "run-token";
export const USAGE_FILE = "usage.json";
export const RECORD_SCHEMA = "praxis-run-usage/v2";
// Marks DIR when the broker predates run tokens (holds no secret).
export const LEGACY_FILE = "legacy-broker";
// opencode's key for a broker without run tokens, which strips it.
const PLACEHOLDER_KEY = "unused";
// The environment that lets a process mint this job's OIDC tokens, and so
// register runs: never for the agent (scripts/runner-sandbox.mjs).
export const OIDC_REQUEST_VARS = ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
// A run token as praxis mints them, for redaction.
export const RUN_TOKEN_PATTERN = "praxis-run-[0-9a-f]{64}";
const HTTP_TIMEOUT_MS = 30_000;
// Registration is retried with the same OIDC token, which praxis answers
// with the same run (and a new token), so a lost reply costs nothing.
const REGISTER_ATTEMPTS = 4;
const RETRY_DELAY_MS = 3000;
export { OPENCODE_CONFIG_DIR };

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// The runs endpoint beside the Responses base URL.
export function runsUrl(baseUrl, path = "") {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/runs${path}`;
  return url.toString();
}

async function http(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

// A private directory of runner's; files in it are 0600.
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writePrivate(path, content) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readToken(dir) {
  const token = readFileSync(join(dir, TOKEN_FILE), "utf8").trim();
  if (!new RegExp(`^${RUN_TOKEN_PATTERN}$`).test(token)) throw new Error(`${join(dir, TOKEN_FILE)} holds no run token`);
  return token;
}

// The run token register got, or null if the broker predates run tokens.
export function runToken(dir) {
  return existsSync(join(dir, LEGACY_FILE)) ? null : readToken(dir);
}

// The policy entry the broker needs for this job's runs, for error messages.
function policyHint(env) {
  const workflow = env.GITHUB_WORKFLOW_REF || "OWNER/REPO/.github/workflows/agent.yml@refs/heads/main";
  const repoId = env.GITHUB_REPOSITORY_ID || "REPOSITORY_ID";
  return `the broker's run-token-policy.yaml must allow it (workflows: ["${workflow}"], `
    + `repository_ids: [${repoId}]), and this run must be a workflow_dispatch (the policy's default events)`;
}

// The answer of a broker that has run tokens but no registration policy.
const NOT_CONFIGURED = "run registration is not configured";

// Why a registration answered STATUS failed, for the job's log.
function registrationError(env, base, status, detail) {
  const at = `praxis at ${base}`;
  if (status === 503 && detail.startsWith(NOT_CONFIGURED)) {
    return `${at} has no run registration policy (HTTP 503: ${detail}): ${policyHint(env)}`;
  }
  switch (status) {
    case 403:
      return `${at} refused to register runs of this workflow (HTTP 403: ${detail}): ${policyHint(env)}`;
    case 401:
      return `${at} rejected this job's OIDC token (HTTP 401: ${detail}); its audience is ${AUDIENCE}, which the `
        + "policy's audience must match, and it must be issued after the broker started";
    case 409:
      return `${at} refused to register this job's run again (HTTP 409): it was registered with another OIDC token `
        + "or has already ended; a re-run of the workflow registers a new run attempt";
    default:
      return `registering the run with ${at} failed (HTTP ${status}: ${detail})`;
  }
}

// Whether a registration that answered STATUS with DETAIL is worth another
// try, with the same OIDC token: praxis answers that with the same run.
function retryable(status, detail) {
  if (status === 503) return !detail.startsWith(NOT_CONFIGURED);
  return status >= 500 || status === 429;
}

async function oidcToken(env) {
  const [url, bearer] = OIDC_REQUEST_VARS.map((name) => env[name]);
  if (!url || !bearer) throw new Error("no OIDC request credentials: the job needs permissions id-token: write");
  const request = new URL(url);
  request.searchParams.set("audience", AUDIENCE);
  const r = await http(request, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!r.ok) throw new Error(`requesting an OIDC token failed: HTTP ${r.status}`);
  const { value } = await r.json();
  if (typeof value !== "string" || !value) throw new Error("the OIDC token response has no token");
  return value;
}

// Registers this job's run and keeps its token in DIR. Environment:
// PRAXIS_BASE_URL, TIMEOUT_MINUTES, the OIDC request variables, and
// GITHUB_WORKFLOW_REF and GITHUB_REPOSITORY_ID for errors. Returns the
// run's initial usage record, or null for a broker without run tokens.
// The broker's policy sets the run's lifetime and caps; the request has no
// body.
export async function register(dir, { env = process.env, retryDelayMs = RETRY_DELAY_MS, log = console.log } = {}) {
  const base = env.PRAXIS_BASE_URL;
  const minutes = Number(env.TIMEOUT_MINUTES);
  if (!base) throw new Error("PRAXIS_BASE_URL is not set");
  if (!(minutes > 0)) throw new Error("TIMEOUT_MINUTES is not set");
  privateDir(dir);
  const jwt = await oidcToken(env);
  let last = "";
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt++) {
    let r;
    try {
      r = await http(runsUrl(base), { method: "POST", headers: { Authorization: `Bearer ${jwt}` } });
    } catch (e) {
      last = `can't reach praxis at ${base} (${e.cause?.code ?? e.message}); is this runner on the tailnet?`;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }
    if (r.status === 201) {
      const { token, usage } = await r.json();
      if (typeof token !== "string" || !new RegExp(`^${RUN_TOKEN_PATTERN}$`).test(token)) {
        throw new Error("praxis returned no run token");
      }
      // Masked in every later line of this job's log.
      log(`::add-mask::${token}`);
      writePrivate(join(dir, TOKEN_FILE), `${token}\n`);
      const expires = new Date(usage.expires_at_unix * 1000).toISOString();
      log(`Registered praxis run ${usage.run_id}/${usage.run_attempt}, until ${expires}`);
      // The policy's max_secs may be shorter than the agent's timeout: the
      // agent then loses inference before its own timeout.
      const deadline = Math.floor(Date.now() / 1000) + minutes * 60;
      if (!(usage.expires_at_unix >= deadline)) {
        log(`::warning::the praxis run expires at ${expires}, before the agent's ${minutes}-minute timeout; `
          + "the broker's max_secs is shorter, so its last requests will be refused");
      }
      return usage;
    }
    const detail = (await r.text()).trim().slice(0, 200);
    if (r.status === 404) {
      writePrivate(join(dir, LEGACY_FILE), "");
      log(`::warning::praxis at ${base} has no run registration (HTTP 404), so it predates run tokens `
        + "(cgwalters-bot/praxis-credential-broker#12), or PRAXIS_BASE_URL isn't its /v1: the agent runs "
        + "without a run token, and its tokens are neither capped nor counted by the broker");
      return null;
    }
    last = registrationError(env, base, r.status, detail);
    if (!retryable(r.status, detail)) break;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw new Error(last);
}

// Writes runner-sandbox's opencode configuration, readable only by it:
// homegit's (HOMEGIT_DIR, see opencode-config.mjs) with the run token as
// its API key, which the broker takes in place of the caller's.
function configure(dir) {
  const baseURL = process.env.PRAXIS_BASE_URL;
  if (!baseURL) fail("PRAXIS_BASE_URL is not set");
  if (!process.env.HOMEGIT_DIR) fail("HOMEGIT_DIR is not set: the homegit checkout with opencode's configuration");
  try {
    console.log(`opencode configuration: ${installOpencodeConfig(process.env.HOMEGIT_DIR, { baseURL, apiKey: runToken(dir) ?? PLACEHOLDER_KEY })}`);
  } catch (e) {
    fail(e.message);
  }
}

// Ends the run, so its token admits nothing more, and keeps the final usage
// record. Ending it again returns the same record, so this is safe to run
// from both the agent step and the always() step after it.
export async function finish(dir, { env = process.env, log = console.log } = {}) {
  const base = env.PRAXIS_BASE_URL;
  if (!existsSync(join(dir, TOKEN_FILE))) {
    log("No praxis run to end");
    return null;
  }
  if (!base) throw new Error("PRAXIS_BASE_URL is not set, so the praxis run can't be ended");
  // Until this succeeds the token may still be live, so nothing is uploaded
  // (agent.yml gates the uploads on it).
  const live = "; its token may still be live until the run expires";
  let r;
  try {
    r = await http(runsUrl(base, "/self"), {
      method: "DELETE", headers: { Authorization: `Bearer ${readToken(dir)}` },
    });
  } catch (e) {
    throw new Error(`can't reach praxis at ${base} to end the run (${e.cause?.code ?? e.message})${live}`);
  }
  // praxis answers 401 only for a token it doesn't know, by the same
  // lookup that admits inference, so the token admits nothing there: it
  // keeps runs in memory, and forgets them when it restarts.
  if (r.status === 401) {
    log(`::warning::praxis at ${base} doesn't know this run's token any more (HTTP 401; did it restart?), `
      + "so the token admits nothing, but there is no usage record of the run");
    return null;
  }
  if (!r.ok) throw new Error(`ending the praxis run failed: HTTP ${r.status}${live}`);
  const record = await r.json();
  if (record.schema !== RECORD_SCHEMA) throw new Error(`praxis returned ${record.schema}, not ${RECORD_SCHEMA}`);
  if (record.state === "active") throw new Error(`praxis still has the run active after ending it${live}`);
  writePrivate(join(dir, USAGE_FILE), `${JSON.stringify(record)}\n`);
  const t = record.tokens ?? {};
  log(`Ended praxis run ${record.run_id}/${record.run_attempt} (${record.state}): `
    + `${record.requests} request(s), ${t.total} tokens (${t.input} in + ${t.cache_read} cached / ${t.output} out), `
    + `${record.unmetered} without usage`);
  return record;
}

const COMMANDS = { register: (dir) => register(dir), configure, finish };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, dir] = process.argv.slice(2);
  if (!COMMANDS[command] || !dir) fail(`usage: praxis.mjs ${Object.keys(COMMANDS).join("|")} DIR`);
  Promise.resolve(COMMANDS[command](dir)).catch((e) => {
    // An annotation, so the reason shows on the run's page.
    console.log(`::error::${e.message.replace(/[\x00-\x1f\x7f]/g, " ")}`);
    process.exit(1);
  });
}
