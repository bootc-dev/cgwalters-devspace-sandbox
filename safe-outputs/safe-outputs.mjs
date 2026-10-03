#!/usr/bin/env node
// What an agent run may hand back, and the checks on it: gh-aw's
// "safe outputs" (https://github.github.com/gh-aw/reference/safe-outputs/)
// without its compiler. The agent leaves a JSONL file of typed requests
// (outputs.jsonl: create_pull_request, add_comment, noop, missing_tool,
// missing_data) and, for a pull request, a patch (aw-BRANCH.patch); this
// checks them the way gh-aw's own safe_outputs job would, with gh-aw's own
// code, vendored byte for byte in vendor/gh-aw/ (see UPSTREAM.json there):
//
//   - collect_ndjson_output.cjs, run as gh-aw's ingestion step runs it
//     (through a stand-in for the github-script globals it expects): parses
//     the JSONL, refuses types the policy doesn't list, counts the
//     per-type maximums, validates and sanitizes every field with the
//     generated validation rules (vendor/gh-aw/validation.json);
//   - manifest_file_helpers.cjs: checkFileProtection and
//     checkFileProtectionPostApply, create_pull_request's protected-files
//     policy, with the compiler's default lists (vendor/gh-aw/protected-files.json);
//   - patch_path_helpers.cjs and commit_sha_helpers.cjs: reading a patch's
//     paths and its X-GH-AW-Base-Commit header;
//   - glob_pattern_helpers.cjs: the glob syntax of the allowlist.
//
// What gh-aw doesn't check, and bot-runs apply used to check in shell
// (cgwalters-bot/homegit#82), is here: secret-shaped strings in a patch,
// symlinks, submodules, binaries and mode changes, plain relative paths,
// and the git and CI configuration paths its protection doesn't name.
// Counting the unique files of a patch is create_pull_request.cjs's
// enforcePullRequestLimits, which can't be loaded without the rest of that
// 3,000-line handler; it is a few lines here.
//
// The restrictions of a run are the workflow's dispatch inputs (repo, base,
// outputs, max_outputs), compiled against the static allowlist.json into a
// policy before anything is processed:
//   safe-outputs.mjs compile --repo R --base B --workflow W --outputs A,B --max-outputs N --out policy.json
//   safe-outputs.mjs check   --dir DIR --policy policy.json [--markdown FILE (appended)] [--json FILE]
//   safe-outputs.mjs unpack  --zip FILE --dir DIR --policy policy.json
//   safe-outputs.mjs post-apply --raw FILE --numstat FILE --diff FILE --policy policy.json
// Every command only reads and writes files (post-apply takes git's output
// from files rather than running git), so bot-runs runs them under node's
// permission model, without the right to start a process.
// bot-runs apply (cgwalters-bot/homegit) runs unpack, check and post-apply
// from the same commit of this repository as the run's workflow.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { SECRET_PATTERNS } from "../agent/redact.mjs";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "../vendor/gh-aw");
const vendored = (name) => require(join(VENDOR, name));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export const ALLOWLIST = readJson(join(HERE, "allowlist.json"));
// The files of a run's hand-back.
export const OUTPUTS_FILE = "outputs.jsonl";
export const BASE_FILE = "base.json";
const PATCH_FILE_RE = /^aw-[a-z0-9][a-z0-9._-]{0,99}\.patch$/;
const MAX_OUTPUTS_BYTES = 1 << 20;
const MAX_BASE_BYTES = 4096;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BASE_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
// The paths a change may touch: relative, of plain characters (no spaces,
// quotes or control characters; . and .. components are refused separately).
const PLAIN_PATH_RE = /^[A-Za-z0-9_.+@=,][A-Za-z0-9_.+@=,-]*(\/[A-Za-z0-9_.+@=,][A-Za-z0-9_.+@=,-]*)*$/;
// Paths never touched: git's own files at any depth (.git, .gitmodules,
// .gitattributes ...), and CI, hook and editor or shell configuration that
// gh-aw's top-level dot-folder rule doesn't reach (nested ones, and files).
const PROTECTED_PATH_RE = /(^|\/)\.git|(^|\/)\.husky\/|^\.pre-commit-config\.ya?ml$|^\.?lefthook\.ya?ml$|^\.circleci\/|^\.travis\.yml$|^\.tekton\/|^\.packit\.ya?ml$|^\.envrc$|^\.vscode\/|(^|\/)CODEOWNERS$/;
// Beyond agent/redact.mjs's patterns, what bot-runs apply refused.
const EXTRA_SECRET_PATTERNS = ["ghr_[A-Za-z0-9_]{20,}", "glpat-[A-Za-z0-9_-]{20,}", "AKIA[0-9A-Z]{16}", "AIza[0-9A-Za-z_-]{35}", "xox[abprs]-[A-Za-z0-9-]{10,}"];
const SECRET_RE = new RegExp([...SECRET_PATTERNS, ...EXTRA_SECRET_PATTERNS].map((p) => `(?:${p})`).join("|"));
const PLAIN_MODE = "100644";
const EXECUTABLE_MODE = "100755";
const KB = 1024;

// Whether `value` matches a glob of the allowlist, ignoring case (GitHub's
// names are).
function globMatches(patterns, value) {
  const { globPatternToRegex } = vendored("glob_pattern_helpers.cjs");
  return patterns.some((p) => globPatternToRegex(p.toLowerCase()).test(value.toLowerCase()));
}

// The policy of a run: its dispatch inputs checked against the static
// allowlist, and the gh-aw safe-outputs configuration (config.json) they
// compile to. Returns {errors} (all of them) or {policy}.
export function compilePolicy({ repo, base, workflow, outputs, maxOutputs }, allowlist = ALLOWLIST) {
  const errors = [];
  if (!REPO_RE.test(repo ?? "") || !globMatches(allowlist.repos, repo)) {
    errors.push(`repo '${repo}' is not on the allowlist (${allowlist.repos.join(", ")})`);
  }
  if (!BASE_RE.test(base ?? "") || base.includes("..") || !globMatches(allowlist.bases, base)) {
    errors.push(`base '${base}' is not on the allowlist (${allowlist.bases.join(", ")})`);
  }
  // "all": every type the allowlist has (an analysis run has no change to propose).
  const types = String(outputs).trim() === "all"
    ? Object.keys(allowlist.outputs).filter((t) => workflow !== "analysis" || t !== "create_pull_request")
    : [...new Set(String(outputs ?? "").split(",").map((t) => t.trim()).filter(Boolean))];
  if (types.length === 0) errors.push("outputs lists no output type");
  for (const type of types) {
    if (!Object.hasOwn(allowlist.outputs, type)) {
      errors.push(`output type '${type}' is not on the allowlist (${Object.keys(allowlist.outputs).join(", ")})`);
    }
  }
  if (workflow === "analysis" && types.includes("create_pull_request")) {
    errors.push("an analysis run hands back no change, so it can't create_pull_request");
  }
  // "max": as many as the allowlist has.
  const wanted = maxOutputs === "max" ? String(allowlist.max_outputs) : maxOutputs;
  const max = /^[1-9][0-9]{0,2}$/.test(wanted ?? "") ? Number(wanted) : null;
  if (max === null || max > allowlist.max_outputs) {
    errors.push(`max_outputs '${maxOutputs}' must be a number from 1 to ${allowlist.max_outputs}`);
  }
  if (errors.length > 0) return { errors };

  const safeOutputs = Object.fromEntries(types.map((t) => [t, { max: Math.min(allowlist.outputs[t].max, max) }]));
  if (types.includes("create_pull_request")) {
    safeOutputs.create_pull_request = {
      ...safeOutputs.create_pull_request, ...readJson(join(VENDOR, "protected-files.json")),
      draft: true, max_patch_size: allowlist.max_patch_bytes / KB, max_patch_files: allowlist.max_patch_files,
    };
  }
  return {
    policy: { repo, base, workflow, max_outputs: max, max_patch_bytes: allowlist.max_patch_bytes, safe_outputs: safeOutputs },
    errors,
  };
}

// --- gh-aw's ingestion -------------------------------------------------------

let ingestDir = null;

// Runs gh-aw's collect_ndjson_output.cjs on the JSONL TEXT under POLICY's
// safe-outputs configuration: {items, errors}, items normalized and
// sanitized as gh-aw would hand them to its handlers. The collector is
// written for actions/github-script, so its globals are stood in for;
// nothing else of it is changed. It stores its result in
// TMP_GH_AW_PATH (/tmp/gh-aw in gh-aw), which is a private directory here.
export async function ingest(text, policy) {
  ingestDir ??= mkdtempSync(join(tmpdir(), "safe-outputs-"));
  const outputsPath = join(ingestDir, "outputs.jsonl");
  const configPath = join(ingestDir, "config.json");
  writeFileSync(outputsPath, text);
  writeFileSync(configPath, JSON.stringify(policy.safe_outputs));
  const constants = vendored("constants.cjs");
  constants.TMP_GH_AW_PATH = join(ingestDir, "out");
  const result = {};
  const log = [];
  const [owner, repo] = policy.repo.split("/");
  Object.assign(globalThis, {
    core: {
      info: () => {}, warning: (m) => log.push(String(m)), error: (m) => log.push(String(m)), exportVariable: () => {},
      setOutput: (name, value) => { result[name] = value; },
      setFailed: (m) => { throw new Error(m); },
    },
    context: { repo: { owner, repo }, payload: {}, eventName: "workflow_dispatch" },
    // Looks mentions up on the issues of add_comment targets; no network here.
    github: { rest: { issues: { get: async () => { throw new Error("no GitHub API in the safe-outputs check"); } } } },
  });
  Object.assign(process.env, {
    GH_AW_SAFE_OUTPUTS: outputsPath, GH_AW_SAFE_OUTPUTS_CONFIG_PATH: configPath,
    GH_AW_VALIDATION_CONFIG_PATH: join(VENDOR, "validation.json"),
  });
  await vendored("collect_ndjson_output.cjs").main();
  if (typeof result.output !== "string" || result.output === "") throw new Error("gh-aw's collector produced no output");
  return JSON.parse(result.output);
}

// --- the checks --------------------------------------------------------------

// gh-aw's patch file name for a branch (git_patch_utils.cjs
// sanitizeForFilename, whose module needs git_helpers and more).
export const patchFileName = (branch) => `aw-${branch.replace(/[/\\:*?"<>|]/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").toLowerCase()}.patch`;

// Why a path may not be in a change; undefined when it may.
function pathProblem(path) {
  if (!PLAIN_PATH_RE.test(path) || /(^|\/)\.\.?(\/|$)/.test(path)) return "not a plain relative path";
  if (PROTECTED_PATH_RE.test(path)) return "protected path";
  return undefined;
}

// The problems of a format-patch patch, read from its text: what is
// checked again from git's own view once it is applied (postApply).
export function patchProblems(patch, policy, baseCommit) {
  const problems = [];
  const { extractDiffGitHeaderEntries } = vendored("patch_path_helpers.cjs");
  const { extractPatchBaseCommit } = vendored("commit_sha_helpers.cjs");
  const { checkFileProtection } = vendored("manifest_file_helpers.cjs");
  const entries = extractDiffGitHeaderEntries(patch);
  if (entries.length === 0) problems.push("the patch holds no change");
  const files = new Set();
  for (const entry of entries) {
    if (!entry.parseable) {
      problems.push(`unparseable header: ${JSON.stringify(entry.headerLine.slice(0, 120))}`);
      continue;
    }
    for (const path of [entry.oldPath, entry.newPath].filter((p) => p && p !== "dev/null")) {
      files.add(path);
      const why = pathProblem(path);
      if (why) problems.push(`${JSON.stringify(path)}: ${why}`);
    }
  }
  if (files.size > policy.safe_outputs.create_pull_request.max_patch_files) {
    problems.push(`the patch touches ${files.size} files, over ${policy.safe_outputs.create_pull_request.max_patch_files}`);
  }
  if (extractPatchBaseCommit(patch) !== baseCommit) {
    problems.push(`the patch's X-GH-AW-Base-Commit is not the base commit ${baseCommit}`);
  }
  // Only the headers after the first diff: the lines of a diff body start
  // with a space, + or -, so they can't be taken for these.
  const body = patch.slice(entries[0]?.headerIndex ?? 0);
  for (const line of body.split("\n")) {
    const mode = line.match(/^(new file mode|deleted file mode|index [0-9a-f]+\.\.[0-9a-f]+) (\d+)$/);
    if (/^(old|new) mode \d+$/.test(line)) problems.push(`mode change (${line})`);
    // A new file is plain; one that is changed or deleted keeps the mode it
    // had (an executable is no new executable), but never a link or submodule.
    else if (mode?.[1] === "new file mode" && mode[2] !== PLAIN_MODE) problems.push(`a new symlink, submodule, executable or special file (${line})`);
    else if (mode && ![PLAIN_MODE, EXECUTABLE_MODE].includes(mode[2])) problems.push(`symlink, submodule or special file (${line})`);
    else if (/^(GIT binary patch|Binary files )/.test(line)) problems.push("a binary file");
    else if (/^(rename|copy) (from|to) /.test(line)) problems.push(`a ${line.split(" ")[0]} (patches are made without them)`);
  }
  try {
    const verdict = checkFileProtection(patch, policy.safe_outputs.create_pull_request);
    if (verdict.action !== "allow") {
      problems.push(`protected files (${verdict.source ?? verdict.action}): ${verdict.files.join(", ")}`);
    }
  } catch (e) {
    problems.push(e.message);
  }
  return [...new Set(problems)];
}

// The most a file of a hand-back may hold.
const maxBytesOf = (name, policy) => (name === OUTPUTS_FILE ? MAX_OUTPUTS_BYTES : name === BASE_FILE ? MAX_BASE_BYTES : policy.max_patch_bytes);
const isHandbackFile = (name) => name === OUTPUTS_FILE || name === BASE_FILE || PATCH_FILE_RE.test(name);

function readSmall(dir, name, max, problems) {
  const path = join(dir, name);
  const st = lstatSync(path);
  if (!st.isFile()) return problems.push(`${name} is not a regular file`) && null;
  if (st.size > max) return problems.push(`${name} is ${st.size} bytes, over ${max}`) && null;
  return readFileSync(path);
}

// Checks a run's hand-back in DIR (outputs.jsonl, base.json, aw-*.patch)
// against POLICY. Returns {ok, errors, items, patch: {file, bytes, base_commit} | null}.
export async function checkOutputs(dir, policy) {
  const errors = [];
  const verdict = (extra = {}) => ({ ok: errors.length === 0, errors: [...new Set(errors)], items: [], patch: null, ...extra });
  const names = readdirSync(dir).sort();
  for (const name of names) {
    if (!isHandbackFile(name)) errors.push(`unexpected file ${JSON.stringify(name)}`);
  }
  const patchNames = names.filter((n) => PATCH_FILE_RE.test(n));
  const contents = {};
  for (const name of names.filter(isHandbackFile)) {
    contents[name] = readSmall(dir, name, maxBytesOf(name, policy), errors);
  }
  for (const [name, content] of Object.entries(contents)) {
    if (content && SECRET_RE.test(content.toString("latin1"))) errors.push(`a secret-shaped string in ${name}`);
  }
  if (errors.length > 0) return verdict();

  let items = [];
  if (contents[OUTPUTS_FILE]) {
    try {
      const ingested = await ingest(contents[OUTPUTS_FILE].toString("utf8"), policy);
      items = ingested.items;
      errors.push(...ingested.errors);
    } catch (e) {
      errors.push(`gh-aw's collector failed: ${e.message}`);
    }
  }
  if (items.length > policy.max_outputs) errors.push(`${items.length} outputs, over max_outputs ${policy.max_outputs}`);

  const prs = items.filter((i) => i.type === "create_pull_request");
  let patch = null;
  if (prs.length === 0 && patchNames.length > 0) errors.push("a patch without a create_pull_request");
  if (prs.length > 0) {
    const [pr] = prs;
    let base = null;
    try {
      base = JSON.parse(contents[BASE_FILE]?.toString("utf8") ?? "null");
    } catch { /* checked below */ }
    if (base?.repo?.toLowerCase() !== policy.repo.toLowerCase() || base?.ref !== policy.base || !SHA_RE.test(base?.commit ?? "")) {
      errors.push(`${BASE_FILE} is not {repo: ${policy.repo}, ref: ${policy.base}, commit: SHA}`);
    }
    const want = patchFileName(pr.branch);
    if (patchNames.length !== 1 || patchNames[0] !== want) {
      errors.push(`create_pull_request needs exactly one patch, ${want}; there is ${patchNames.join(", ") || "none"}`);
    } else if (base && SHA_RE.test(base.commit ?? "")) {
      const text = contents[want].toString("utf8");
      errors.push(...patchProblems(text, policy, base.commit).map((p) => `${want}: ${p}`));
      patch = { file: want, bytes: contents[want].length, base_commit: base.commit };
    }
  }
  return verdict({ items, patch });
}

// --- the artifact's zip ----------------------------------------------------------

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;
const ZIP_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const ZIP_MAX_ENTRIES = 8;
const ZIP_EOCD_SEARCH = 22 + 65535;

// The entries of a zip file's central directory: {name, method, crc, size,
// compressed, offset, mode}. Zip64 and anything odd is refused.
function zipEntries(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - ZIP_EOCD_SEARCH); i--) {
    if (zip.readUInt32LE(i) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff || zip.readUInt16LE(eocd + 4) !== 0) throw new Error("a zip64 or multi-disk zip");
  if (count > ZIP_MAX_ENTRIES) throw new Error(`${count} entries in the zip, over ${ZIP_MAX_ENTRIES}`);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== ZIP_CENTRAL) throw new Error("a damaged zip directory");
    const nameLength = zip.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (next > zip.length) throw new Error("a damaged zip directory");
    const attributes = zip.readUInt32LE(at + 38);
    entries.push({
      name: zip.toString("utf8", at + 46, at + 46 + nameLength), method: zip.readUInt16LE(at + 10), crc: zip.readUInt32LE(at + 16),
      compressed: zip.readUInt32LE(at + 20), size: zip.readUInt32LE(at + 24), offset: zip.readUInt32LE(at + 42),
      // The file type, if the zip was made on Unix (else it can't hold a link).
      mode: zip.readUInt8(at + 5) === ZIP_UNIX ? (attributes >>> 16) & S_IFMT : S_IFREG,
    });
    at = next;
  }
  return entries;
}

// Unpacks the artifact ZIP (a Buffer) into the empty DIR, which may hold
// only the files of a hand-back: regular files at the root with the right
// names, within their size caps as declared and as unpacked, once each.
// Returns the problems; nothing is written unless there are none.
export function unpackZip(zip, dir, policy) {
  if (typeof zlib.crc32 !== "function") return ["unpacking needs Node.js 22.2 or newer (zlib.crc32)"];
  const problems = [];
  const files = new Map();
  let entries;
  try {
    entries = zipEntries(zip);
  } catch (e) {
    return [e.message];
  }
  for (const e of entries) {
    const shown = JSON.stringify(e.name);
    if (!isHandbackFile(e.name)) problems.push(`unexpected entry ${shown}`);
    else if (files.has(e.name)) problems.push(`${shown} twice`);
    else if (e.mode !== S_IFREG) problems.push(`${shown} is not a regular file`);
    else if (![ZIP_STORED, ZIP_DEFLATED].includes(e.method)) problems.push(`${shown} is compressed in a way not accepted`);
    else if (e.size > maxBytesOf(e.name, policy)) problems.push(`${shown} is ${e.size} bytes, over ${maxBytesOf(e.name, policy)}`);
    else if (e.offset + 30 > zip.length || zip.readUInt32LE(e.offset) !== ZIP_LOCAL) problems.push(`${shown} has a damaged header`);
    else {
      const start = e.offset + 30 + zip.readUInt16LE(e.offset + 26) + zip.readUInt16LE(e.offset + 28);
      const raw = zip.subarray(start, start + e.compressed);
      try {
        // maxOutputLength bounds what a bomb can make; a size that doesn't
        // match the directory's is refused.
        const data = e.method === ZIP_STORED ? raw : zlib.inflateRawSync(raw, { maxOutputLength: e.size });
        if (data.length !== e.size || zlib.crc32(data) !== e.crc) problems.push(`${shown} doesn't match its size or checksum`);
        else files.set(e.name, data);
      } catch {
        problems.push(`${shown} can't be unpacked within its declared size`);
      }
    }
  }
  if (problems.length > 0) return problems;
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of files) writeFileSync(join(dir, name), data, { flag: "wx" });
  return [];
}

// git's own view of the change staged in the clone DIR, as postApplyProblems
// takes it: {raw, numstat, diff}, the NUL-separated output of `diff --cached
// --raw -z --no-renames --no-abbrev`, `--numstat -z --no-renames` and the
// plain diff, against HEAD. Hooks, the caller's configuration and fsmonitor
// are off.
export function gitView(dir) {
  const git = (...args) => {
    const r = spawnSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "diff", "--cached", "--no-renames", ...args, "HEAD"],
      { encoding: "buffer", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr.toString().trim()}`);
    return r.stdout.toString("utf8");
  };
  return { raw: git("--raw", "-z", "--no-abbrev"), numstat: git("--numstat", "-z"), diff: git() };
}

// The problems of a change as git sees it, once applied and staged (its
// gitView), not as a parser reads the patch: what patchProblems reads from
// the text, again, plus gh-aw's post-apply protection check. Pure, so that
// it can run without the right to start a process.
export function postApplyProblems({ raw, numstat, diff }, policy) {
  const nul = (text) => text.split("\0").filter((s, i, a) => s !== "" || i < a.length - 1);
  const binary = new Set(nul(numstat).filter((e) => e.startsWith("-\t-\t")).map((e) => e.slice(4)));
  const entries = nul(raw);
  const problems = [];
  const files = [];
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const [oldMode, newMode, , , status] = entries[i].slice(1).split(" ");
    const path = entries[i + 1];
    files.push(path);
    const why = pathProblem(path)
      ?? (/^1[26]0000$/.test(oldMode) || /^1[26]0000$/.test(newMode) ? "symlink or submodule" : undefined)
      ?? (status === "A" && newMode !== PLAIN_MODE ? `new file mode ${newMode}` : undefined)
      ?? (status === "M" && oldMode !== newMode ? `mode change ${oldMode} to ${newMode}` : undefined)
      ?? (!["A", "M", "D"].includes(status) ? `change of type ${status}` : undefined)
      ?? (binary.has(path) ? "binary" : undefined);
    if (why) problems.push(`${JSON.stringify(path)}: ${why}`);
  }
  if (files.length === 0) problems.push("the change is empty");
  if (files.length > policy.safe_outputs.create_pull_request.max_patch_files) {
    problems.push(`the change touches ${files.length} files, over ${policy.safe_outputs.create_pull_request.max_patch_files}`);
  }
  const { checkFileProtectionPostApply } = vendored("manifest_file_helpers.cjs");
  const verdict = checkFileProtectionPostApply(files, policy.safe_outputs.create_pull_request);
  if (verdict.action !== "allow") problems.push(`protected files (${verdict.source ?? verdict.action}): ${verdict.files.join(", ")}`);
  if (SECRET_RE.test(diff)) problems.push("a secret-shaped string in the change");
  return problems;
}

// A Markdown summary of a verdict, for the job summary.
export function markdown(verdict, policy) {
  const lines = [`### Safe outputs: ${verdict.ok ? "accepted" : "refused"}`, "",
    `Policy: ${policy.repo} @ ${policy.base}, outputs ${Object.keys(policy.safe_outputs).join(", ")}, at most ${policy.max_outputs}.`, ""];
  for (const item of verdict.items) lines.push(`- \`${item.type}\`${item.title ? `: ${item.title}` : item.message ? `: ${item.message}` : ""}`);
  if (verdict.items.length === 0) lines.push("- no outputs");
  if (verdict.patch) lines.push(`- patch \`${verdict.patch.file}\` (${verdict.patch.bytes} bytes) against ${verdict.patch.base_commit.slice(0, 12)}`);
  for (const e of verdict.errors) lines.push(`- refused: ${e}`);
  return `${lines.join("\n")}\n`;
}

// --- command line -------------------------------------------------------------

// --name value pairs: REQUIRED names must be given, OPTIONAL ones may be.
function parseFlags(argv, required, optional = []) {
  const flags = {};
  const known = [...required, ...optional];
  const usage = `usage: safe-outputs.mjs COMMAND ${known.map((n) => `--${n.replaceAll("_", "-")} X`).join(" ")}`;
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, "").replaceAll("-", "_");
    if (!argv[i]?.startsWith("--") || !known.includes(name) || i + 1 >= argv.length) throw new Error(usage);
    flags[name] = argv[i + 1];
  }
  const missing = required.filter((n) => !(n in flags));
  if (missing.length > 0) throw new Error(`missing --${missing.join(", --").replaceAll("_", "-")}; ${usage}`);
  return flags;
}

async function run() {
  const [command, ...argv] = process.argv.slice(2);
  const error = (m) => console.error(process.env.GITHUB_ACTIONS ? `::error::${m.replace(/[\r\n]+/g, " ")}` : `error: ${m}`);
  if (command === "compile") {
    const f = parseFlags(argv, ["repo", "base", "workflow", "outputs", "max_outputs", "out"]);
    const { errors, policy } = compilePolicy({ repo: f.repo, base: f.base, workflow: f.workflow, outputs: f.outputs, maxOutputs: f.max_outputs });
    if (errors.length > 0) {
      errors.forEach(error);
      return 1;
    }
    writeFileSync(f.out, `${JSON.stringify(policy, null, 2)}\n`);
    console.log(`policy: ${policy.repo}@${policy.base}, ${Object.entries(policy.safe_outputs).map(([t, c]) => `${t} (max ${c.max})`).join(", ")}`);
  } else if (command === "check") {
    const f = parseFlags(argv, ["dir", "policy"], ["markdown", "json"]);
    const policy = readJson(f.policy);
    const verdict = await checkOutputs(f.dir, policy);
    if (f.markdown) appendFileSync(f.markdown, markdown(verdict, policy));
    if (f.json) writeFileSync(f.json, `${JSON.stringify(verdict, null, 2)}\n`);
    verdict.errors.forEach(error);
    console.log(`${verdict.ok ? "accepted" : "refused"}: ${verdict.items.length} output(s)${verdict.patch ? `, patch ${verdict.patch.file}` : ""}`);
    return verdict.ok ? 0 : 1;
  } else if (command === "unpack") {
    const f = parseFlags(argv, ["zip", "dir", "policy"]);
    const problems = unpackZip(readFileSync(f.zip), f.dir, readJson(f.policy));
    problems.forEach(error);
    return problems.length === 0 ? 0 : 1;
  } else if (command === "post-apply") {
    const f = parseFlags(argv, ["raw", "numstat", "diff", "policy"]);
    const read = (path) => readFileSync(path, "utf8");
    const problems = postApplyProblems({ raw: read(f.raw), numstat: read(f.numstat), diff: read(f.diff) }, readJson(f.policy));
    problems.forEach((p) => console.error(`  ${p}`));
    return problems.length === 0 ? 0 : 1;
  } else {
    throw new Error("usage: safe-outputs.mjs compile|unpack|check|post-apply ...");
  }
  return 0;
}

async function main() {
  try {
    process.exitCode = await run();
  } finally {
    if (ingestDir) rmSync(ingestDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(2);
  });
}
