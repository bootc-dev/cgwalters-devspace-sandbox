// Safe outputs, step 1 of 2: validate an agent's proposals.
//
// Runs in the apply job's sandbox (as runner-sandbox, with no token), on
// the JSONL the agent job uploaded, which is the agent's data and
// untrusted. Every line is checked against the config the privileged
// phase shared (types, fields, targets, sizes, counts) and scanned for
// secrets, and the accepted ones are sanitized. The result is staged for
// apply.cjs, which re-checks the hard limits before it writes anything.
//
// The proposal format follows gh-aw's safe outputs (`type` plus the
// fields of that type, one JSON object per line), so an agent prompted
// for gh-aw's tools can write it.
//
// Usage: node validate.cjs CONFIG PROPOSALS_DIR OUT_DIR
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const PROPOSALS_FILE = "outputs.jsonl";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_LINES = 100;
const MAX_REASON = 200;

// Token shapes that must never leave the job, from bot-harness's redaction
// list and gh-aw's secret redaction.
const SECRET_PATTERNS = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
  [/\bpraxis-run-[A-Za-z0-9_-]{8,}/, "praxis run token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, "Anthropic key"],
];

// The fields each type may have, besides `type`; a proposal with any
// other field is refused rather than silently trimmed.
const TYPES = {
  add_comment: { required: ["body"], optional: ["item_number", "repo"] },
  noop: { required: ["message"], optional: [] },
};

// The proposals file, wherever the artifact and the share nested it, at
// most a few directories down; never through a symlink.
function findProposals(dir, depth = 3) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name === PROPOSALS_FILE) return path.join(dir, e.name);
  }
  if (depth === 0) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const found = findProposals(path.join(dir, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

// gh-aw's sanitize_content, the parts that matter for a comment: no
// @mentions that would notify anyone, no hidden HTML comments, no
// control characters, and no line that a workflow log would read as a
// command.
function sanitize(text) {
  return text
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9._-]+)?)/g, "$1`@$2`")
    .replace(/^::/gm, ": :");
}

function checkProposal(p, config, repo) {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return "not a JSON object";
  const spec = TYPES[p.type];
  const allowed = config.types[p.type];
  if (!spec || !allowed) return `type ${JSON.stringify(String(p.type))} is not enabled`;
  for (const k of Object.keys(p)) {
    if (k !== "type" && !spec.required.includes(k) && !spec.optional.includes(k)) return `unknown field ${JSON.stringify(k)}`;
  }
  for (const k of spec.required) if (typeof p[k] !== "string" || p[k].trim() === "") return `${k} must be a non-empty string`;
  for (const [re, what] of SECRET_PATTERNS) {
    if (Object.values(p).some((v) => typeof v === "string" && re.test(v))) return `threat detection: looks like a ${what}`;
  }
  if (p.type === "add_comment") {
    if (p.repo !== undefined && p.repo !== repo) return `repo ${JSON.stringify(String(p.repo))} is not ${repo}`;
    const target = p.item_number ?? config.types.add_comment.default_target;
    if (!Number.isInteger(target) || !allowed.targets.includes(target)) {
      return `target ${JSON.stringify(target)} is not in the allowed targets [${allowed.targets.join(", ")}]`;
    }
    if (Buffer.byteLength(p.body) > allowed.max_body_bytes) return `body is over ${allowed.max_body_bytes} bytes`;
  }
  return null;
}

function main() {
  const [configPath, dir, outDir] = process.argv.slice(2);
  if (!configPath || !dir || !outDir) throw new Error("usage: validate.cjs CONFIG PROPOSALS_DIR OUT_DIR");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const repo = config.repo;
  const accepted = [];
  const rejected = [];
  const counts = {};
  const file = findProposals(dir);
  if (!file) throw new Error(`no ${PROPOSALS_FILE} in ${dir}`);
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error(`${PROPOSALS_FILE} is over ${MAX_FILE_BYTES} bytes`);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  lines.forEach((line, i) => {
    const n = i + 1;
    const reject = (type, reason) => rejected.push({ line: n, type: String(type ?? "?").slice(0, 40), reason: reason.slice(0, MAX_REASON) });
    if (n > MAX_LINES) return reject(null, `over the cap of ${MAX_LINES} proposals`);
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return reject(null, `line is over ${MAX_LINE_BYTES} bytes`);
    let p;
    try {
      p = JSON.parse(line);
    } catch {
      return reject(null, "not valid JSON");
    }
    const why = checkProposal(p, config, repo);
    if (why) return reject(p?.type, why);
    const max = config.types[p.type].max;
    if ((counts[p.type] ?? 0) >= max) return reject(p.type, `over the cap of ${max} ${p.type} per run`);
    if (accepted.length >= config.max_total) return reject(p.type, `over the cap of ${config.max_total} outputs per run`);
    counts[p.type] = (counts[p.type] ?? 0) + 1;
    if (p.type === "add_comment") {
      accepted.push({ type: p.type, item_number: p.item_number ?? config.types.add_comment.default_target, body: sanitize(p.body) });
    } else {
      accepted.push({ type: p.type, message: sanitize(p.message).slice(0, 500) });
    }
  });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "validated.json"), `${JSON.stringify({ accepted, rejected }, null, 2)}\n`);
  console.log(`${lines.length} proposals: ${accepted.length} accepted, ${rejected.length} rejected`);
  for (const r of rejected) console.log(`rejected line ${r.line} (${r.type}): ${r.reason}`);
}

try {
  main();
} catch (e) {
  console.error(`validate: ${e.message}`);
  process.exit(1);
}
