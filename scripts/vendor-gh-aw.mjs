#!/usr/bin/env node
// Refreshes vendor/gh-aw/: the parts of gh-aw's safe-outputs implementation
// that safe-outputs/safe-outputs.mjs reuses, copied byte for byte from one
// commit of a gh-aw checkout (the cgwalters-forge fork), plus two files the
// gh-aw compiler generates, taken from its compiled lock files at that
// commit. Nothing in vendor/gh-aw/ is edited by hand: UPSTREAM.json names
// the commit and the sha256 of every file, and safe-outputs/safe-outputs.test.mjs
// fails if they drift.
//   vendor-gh-aw.mjs GH_AW_CHECKOUT [REV]     (REV: default HEAD)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VENDOR_DIR = join(ROOT, "vendor/gh-aw");
const UPSTREAM_REPO = "https://github.com/cgwalters-forge/gh-aw";
const JS_DIR = "actions/setup/js";
// The entry points reused: the collector that parses and validates the
// agent's safe-outputs JSONL (and, through its requires, the sanitizer and
// the per-type validator), and the patch file-protection checks of
// create_pull_request (and the base commit a patch carries).
const ENTRY_POINTS = ["collect_ndjson_output.cjs", "manifest_file_helpers.cjs", "patch_path_helpers.cjs", "commit_sha_helpers.cjs"];
// The safe-output types an agent run may use (see safe-outputs/safe-outputs.mjs).
const TYPES = ["create_pull_request", "add_comment", "noop", "missing_tool", "missing_data"];
// A compiled lock file whose create_pull_request block holds the
// compiler's default file protection (the lists gh-aw generates).
const PROTECTION_SOURCE = ".github/workflows/archivx-agentic-workflows-analyzer.lock.yml";

function git(checkout, ...args) {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

// The files `file` requires with a relative path, transitively.
function closure(read, files) {
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const m of read(name).matchAll(/require\("\.\/([^"]+)"\)/g)) walk(m[1]);
  };
  files.forEach(walk);
  return [...seen].sort();
}

// The value of the block scalar `KEY: |` in a lock file, as JSON.
export function blockJson(lock, key) {
  const lines = lock.split("\n");
  const at = lines.findIndex((l) => l.trim() === `${key}: |`);
  if (at < 0) return null;
  const indent = lines[at].length - lines[at].trimStart().length;
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
    body.push(l.slice(indent + 2));
  }
  return JSON.parse(body.join("\n"));
}

// A double-quoted YAML scalar `KEY: "..."`, whose content is JSON, as JSON.
export function quotedJson(lock, key) {
  const m = lock.match(new RegExp(`^\\s+${key}: (".*")$`, "m"));
  return m ? JSON.parse(JSON.parse(m[1])) : null;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function main() {
  const [checkout, rev = "HEAD"] = process.argv.slice(2);
  if (!checkout) throw new Error("usage: vendor-gh-aw.mjs GH_AW_CHECKOUT [REV]");
  const commit = git(checkout, "rev-parse", "--verify", `${rev}^{commit}`).trim();
  const show = (path) => git(checkout, "show", `${commit}:${path}`);
  const names = closure((name) => show(`${JS_DIR}/${name}`), ENTRY_POINTS);

  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
  const files = {};
  const put = (name, text) => {
    writeFileSync(join(VENDOR_DIR, name), text);
    files[name] = sha256(text);
  };
  for (const name of names) put(name, show(`${JS_DIR}/${name}`));

  // The validation rules of each type, as the compiler generates them
  // (GH_AW_VALIDATION_JSON in a lock file that uses the type). Rules that
  // differ only in options a workflow switches on (a data schema) are the
  // same type's: the first is kept, with those options off.
  const locks = git(checkout, "ls-tree", "--name-only", commit, ".github/workflows/").split("\n")
    .filter((p) => p.endsWith(".lock.yml"));
  const validation = {};
  for (const path of locks) {
    const rules = blockJson(show(path), "GH_AW_VALIDATION_JSON") ?? {};
    for (const type of TYPES) {
      if (!(type in rules)) continue;
      const have = validation[type];
      if (have && JSON.stringify(have.rules.fields) !== JSON.stringify(rules[type].fields)) {
        console.warn(`warning: ${type} differs between ${have.from} and ${path}; keeping the first`);
      } else if (!have) {
        validation[type] = { from: path, rules: rules[type] };
      }
    }
  }
  const missing = TYPES.filter((t) => !(t in validation));
  if (missing.length > 0) throw new Error(`no lock file at ${commit} has validation rules for ${missing.join(", ")}`);
  put("validation.json", `${JSON.stringify(Object.fromEntries(Object.entries(validation).map(([t, v]) => [t, v.rules])), null, 2)}\n`);

  // The compiler's default file protection for create_pull_request.
  const handler = quotedJson(show(PROTECTION_SOURCE), "GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG").create_pull_request;
  const protection = Object.fromEntries(["protected_files", "protect_top_level_dot_folders", "protected_files_policy"]
    .map((k) => [k, handler[k]]));
  put("protected-files.json", `${JSON.stringify(protection, null, 2)}\n`);

  writeFileSync(join(VENDOR_DIR, "UPSTREAM.json"), `${JSON.stringify({
    repo: UPSTREAM_REPO, commit, source_dir: JS_DIR, entry_points: ENTRY_POINTS,
    generated: { "validation.json": "GH_AW_VALIDATION_JSON of the compiled lock files",
      "protected-files.json": `GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG of ${PROTECTION_SOURCE}` },
    files,
  }, null, 2)}\n`);
  console.log(`vendored ${names.length} files from ${UPSTREAM_REPO} at ${commit}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
