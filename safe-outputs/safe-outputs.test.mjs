// Tests for safe-outputs/safe-outputs.mjs and the vendored gh-aw code it
// runs. Run with: node --test safe-outputs/*.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BASE_FILE, OUTPUTS_FILE, checkOutputs, compilePolicy, gitView, patchFileName, postApplyProblems, unpackZip } from "./safe-outputs.mjs";
import { BASE, REPO, makeZip, patchOf, repoWith, scratch, write } from "./test-helpers.mjs";

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "../vendor/gh-aw");
const BRANCH = "agent-run-7";
const PR = { type: "create_pull_request", title: "Fix the thing", body: "Why.", branch: BRANCH };

test("the vendored gh-aw files are the ones UPSTREAM.json names", () => {
  const upstream = JSON.parse(readFileSync(join(VENDOR, "UPSTREAM.json"), "utf8"));
  assert.match(upstream.commit, /^[0-9a-f]{40}$/);
  for (const [name, sha] of Object.entries(upstream.files)) {
    assert.equal(createHash("sha256").update(readFileSync(join(VENDOR, name))).digest("hex"), sha, name);
  }
});

const INPUTS = { repo: REPO, base: BASE, workflow: "branch", outputs: "create_pull_request,noop", maxOutputs: "3" };

test("compilePolicy: the dispatch inputs against the allowlist", () => {
  for (const [name, change, want] of [
    ["ok", {}, null],
    ["another owner", { repo: "evil/bootc" }, /repo 'evil\/bootc' is not on the allowlist/],
    ["a repo of another case", { repo: "BOOTC-DEV/bootc" }, null],
    ["a malformed repo", { repo: "bootc-dev/bootc/x" }, /repo/],
    ["a base not listed", { base: "release" }, /base 'release'/],
    ["a bot branch", { base: "bot/agent-run-praxis" }, null],
    ["a base with ..", { base: "bot/../main" }, /base/],
    ["a type not listed", { outputs: "create_pull_request,delete_repo" }, /output type 'delete_repo'/],
    ["no types", { outputs: " , " }, /no output type/],
    ["too many outputs", { maxOutputs: "6" }, /max_outputs/],
    ["no number", { maxOutputs: "many" }, /max_outputs/],
    ["a pull request from an analysis run", { workflow: "analysis" }, /analysis/],
    ["an analysis run's comments", { workflow: "analysis", outputs: "noop,add_comment" }, null],
    ["all types", { outputs: "all", maxOutputs: "max" }, null],
    ["all types of an analysis run", { workflow: "analysis", outputs: "all" }, null],
  ]) {
    const { errors, policy } = compilePolicy({ ...INPUTS, ...change });
    if (want) assert.match(errors.join("\n"), want, name);
    else assert.deepEqual(errors, [], name);
    assert.equal(policy === undefined, want !== null, name);
  }
  assert.deepEqual(Object.keys(compilePolicy({ ...INPUTS, outputs: "all" }).policy.safe_outputs).sort(),
    ["add_comment", "create_pull_request", "missing_data", "missing_tool", "noop"]);
  assert.equal(Object.hasOwn(compilePolicy({ ...INPUTS, workflow: "analysis", outputs: "all" }).policy.safe_outputs, "create_pull_request"), false);
  assert.equal(compilePolicy({ ...INPUTS, maxOutputs: "max" }).policy.max_outputs, 5);
  const { policy } = compilePolicy({ ...INPUTS, maxOutputs: "2" });
  assert.equal(policy.safe_outputs.noop.max, 1);
  assert.equal(policy.safe_outputs.create_pull_request.max, 1);
  assert.equal(policy.safe_outputs.create_pull_request.draft, true);
  assert.equal(policy.safe_outputs.create_pull_request.protected_files_policy, "blocked");
});

const POLICY = compilePolicy(INPUTS).policy;

// A hand-back directory: outputs.jsonl LINES, a base.json and the patch.
function handback({ lines, patch, base, baseJson, extra = {} }) {
  const dir = scratch();
  const items = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  if (items.length > 0) writeFileSync(join(dir, OUTPUTS_FILE), `${items.join("\n")}\n`);
  if (patch) writeFileSync(join(dir, patchFileName(BRANCH)), patch);
  if (base !== null) writeFileSync(join(dir, BASE_FILE), JSON.stringify(baseJson ?? { repo: REPO, ref: BASE, commit: base }));
  write(dir, extra);
  return dir;
}

const edit = (files) => (dir) => write(dir, files);
const GOOD = patchOf(edit({ "src/lib.rs": "fn main() { println!(\"hi\"); }\n", "src/new.rs": "pub fn f() {}\n" }));
// Changing and deleting a file that is already executable is no new executable.
const EDIT_EXECUTABLE = patchOf(edit({ "run.sh": "#!/bin/sh\necho hi\n" }), { "run.sh": "#!/bin/sh\n", "gone.sh": "x\n" }, ["run.sh", "gone.sh"]);
const DELETE_EXECUTABLE = patchOf((d) => rmSync(join(d, "gone.sh")), { "run.sh": "#!/bin/sh\n", "gone.sh": "x\n" }, ["run.sh", "gone.sh"]);

test("checkOutputs: what is accepted", async () => {
  const noop = { type: "noop", message: "Nothing to do." };
  for (const [name, args, want] of [
    ["a pull request", { lines: [PR], patch: GOOD.patch, base: GOOD.base }, { items: ["create_pull_request"], patch: true }],
    ["a pull request and a noop", { lines: [PR, noop], patch: GOOD.patch, base: GOOD.base }, { items: ["create_pull_request", "noop"], patch: true }],
    ["a change to an executable file", { lines: [PR], patch: EDIT_EXECUTABLE.patch, base: EDIT_EXECUTABLE.base }, { items: ["create_pull_request"], patch: true }],
    ["the deletion of an executable file", { lines: [PR], patch: DELETE_EXECUTABLE.patch, base: DELETE_EXECUTABLE.base }, { items: ["create_pull_request"], patch: true }],
    ["a noop alone", { lines: [noop], base: null }, { items: ["noop"], patch: false }],
    ["nothing", { lines: [], base: null }, { items: [], patch: false }],
  ]) {
    const verdict = await checkOutputs(handback(args), POLICY);
    assert.deepEqual(verdict.errors, [], name);
    assert.equal(verdict.ok, true, name);
    assert.deepEqual(verdict.items.map((i) => i.type), want.items, name);
    assert.equal(verdict.patch !== null, want.patch, name);
  }
});

test("checkOutputs: the sanitizer of gh-aw's collector runs on the fields", async () => {
  const dir = handback({ lines: [{ ...PR, body: "cc @octocat see https://evil.example/x" }], patch: GOOD.patch, base: GOOD.base });
  const { items } = await checkOutputs(dir, POLICY);
  assert.doesNotMatch(items[0].body, /https:\/\/evil\.example/);
  assert.doesNotMatch(items[0].body, / @octocat/);
});

test("checkOutputs: what is refused", async () => {
  const token = `ghp_${"a1B2".repeat(10)}`;
  const withPatch = (patch) => ({ lines: [PR], patch, base: GOOD.base });
  const bad = (files) => patchOf(edit(files));
  const executable = patchOf((d) => {
    write(d, { "run.sh": "#!/bin/sh\n" });
    chmodSync(join(d, "run.sh"), 0o755);
  }).patch;
  for (const [name, args, want] of [
    ["an output type not allowed", { lines: [{ type: "add_comment", body: "x", item_number: 1 }], base: null }, /Unexpected output type 'add_comment'/],
    ["a type nobody knows", { lines: [{ type: "delete_repo" }], base: null }, /Unexpected output type 'delete_repo'/],
    ["a line that is not JSON", { lines: ["rm -rf /"], base: null }, /Invalid JSON/],
    ["more of a type than its maximum", { lines: [PR, PR], patch: GOOD.patch, base: GOOD.base }, /Too many items of type 'create_pull_request'/],
    ["more outputs than max_outputs", { lines: [{ type: "noop", message: "a" }, PR, PR], patch: GOOD.patch, base: GOOD.base }, /Too many|over max_outputs/],
    ["a field gh-aw's rules require", { lines: [{ type: "create_pull_request", branch: BRANCH }], patch: GOOD.patch, base: GOOD.base }, /title|body/],
    ["a secret in a request", { lines: [{ type: "noop", message: `key ${token}` }], base: null }, /secret-shaped string in outputs\.jsonl/],
    ["a pull request without its patch", { lines: [PR], base: GOOD.base }, /needs exactly one patch/],
    ["a patch without a pull request", { lines: [], patch: GOOD.patch, base: GOOD.base }, /patch without a create_pull_request/],
    ["a pull request without base.json", { lines: [PR], patch: GOOD.patch, base: null }, /base\.json is not/],
    ["a base.json for another repo", { lines: [PR], patch: GOOD.patch, base: GOOD.base, baseJson: { repo: "bootc-dev/other", ref: BASE, commit: GOOD.base } }, /base\.json is not/],
    ["a base.json for another base", { lines: [PR], patch: GOOD.patch, base: GOOD.base, baseJson: { repo: REPO, ref: "bot/x", commit: GOOD.base } }, /base\.json is not/],
    ["a patch of another base commit", { lines: [PR], patch: GOOD.patch, base: "0".repeat(40) }, /X-GH-AW-Base-Commit/],
    ["a stray file", { lines: [], base: null, extra: { "notes.txt": "hi" } }, /unexpected file "notes\.txt"/],
    ["a protected file (README.md, gh-aw's list)", withPatch(bad({ "README.md": "x\n" }).patch), /protected files.*README\.md/],
    ["a manifest (package.json)", withPatch(bad({ "package.json": "{}\n" }).patch), /protected files.*package\.json/],
    ["CI (.github/)", withPatch(bad({ ".github/workflows/x.yml": "on: push\n" }).patch), /\.github/],
    ["a nested git file", withPatch(bad({ "sub/.gitattributes": "* -diff\n" }).patch), /protected path/],
    ["a path with a space", withPatch(bad({ "a b.rs": "x\n" }).patch), /not a plain relative path/],
    ["a new executable", withPatch(executable), /new symlink, submodule, executable/],
    ["a symlink", withPatch(patchOf((d) => symlinkSync("/etc/passwd", join(d, "link"))).patch), /symlink|special/],
    ["a binary file", withPatch(patchOf((d) => writeFileSync(join(d, "blob.bin"), Buffer.from([0, 1, 2, 255, 0]))).patch), /binary/],
    ["a secret in the patch", withPatch(bad({ "src/k.rs": `const K: &str = "${token}";\n` }).patch), /secret-shaped string in aw-/],
    ["a ghr_ token, which bot-runs apply refused in shell", { lines: [{ type: "noop", message: `ghr_${"a1B2".repeat(10)}` }], base: null }, /secret-shaped string in outputs\.jsonl/],
    ["a GitLab token", { lines: [{ type: "noop", message: `glpat-${"a1B2".repeat(6)}` }], base: null }, /secret-shaped string/],
    ["an AWS key id", { lines: [{ type: "noop", message: `AKIA${"A1B2".repeat(4)}` }], base: null }, /secret-shaped string/],
    ["more files than allowed", withPatch(patchOf((d) => write(d, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f/${i}.rs`, "x\n"])))).patch), /101 files/],
  ]) {
    if (args.lines === undefined) args = { ...args, lines: [PR], base: GOOD.base };
    const verdict = await checkOutputs(handback(args), POLICY);
    assert.equal(verdict.ok, false, name);
    assert.match(verdict.errors.join("\n"), want, name);
  }
});

// The staged change in a clone of the base, as bot-runs apply makes it.
function staged(change, files, executable) {
  const repo = repoWith(files, executable);
  change(repo.dir);
  repo.git(["add", "--all"]);
  return repo.dir;
}

test("postApplyProblems: git's own view of an applied change", () => {
  const exe = (d) => {
    write(d, { "run.sh": "#!/bin/sh\n" });
    chmodSync(join(d, "run.sh"), 0o755);
  };
  for (const [name, change, want] of [
    ["a plain change", edit({ "src/lib.rs": "fn main() { 1; }\n", "src/b.rs": "x\n" }), null],
    ["a deletion", (d) => rmSync(join(d, "src/lib.rs")), null],
    ["a symlink", (d) => symlinkSync("target", join(d, "l")), /symlink or submodule/],
    ["a new executable", exe, /new file mode 100755/],
    ["a binary file", (d) => writeFileSync(join(d, "x.bin"), Buffer.from([0, 255, 0, 1])), /binary/],
    ["a protected file", edit({ "AGENTS.md": "x\n" }), /protected files.*AGENTS\.md/],
    ["CI", edit({ ".github/workflows/x.yml": "x\n" }), /\.github/],
    ["a secret", edit({ "src/k.rs": `${"ghp_"}${"a1B2".repeat(10)}\n` }), /secret-shaped/],
    ["a ghr_ token", edit({ "src/k.rs": `ghr_${"a1B2".repeat(10)}\n` }), /secret-shaped/],
    ["no change", () => {}, /empty/],
  ]) {
    const problems = postApplyProblems(gitView(staged(change)), POLICY);
    if (want) assert.match(problems.join("\n"), want, name);
    else assert.deepEqual(problems, [], name);
  }
});

test("unpackZip", () => {
  const noop = '{"type":"noop","message":"m"}\n';
  const entry = (name, data = "x", extra = {}) => ({ name, data, ...extra });
  const bomb = { name: OUTPUTS_FILE, data: "0".repeat(5 << 20), claimedSize: 10 };
  for (const [name, entries, want] of [
    ["a hand-back", [entry(OUTPUTS_FILE, noop), entry(BASE_FILE, "{}"), entry(patchFileName(BRANCH), "patch")], null],
    ["stored entries", [entry(OUTPUTS_FILE, noop, { method: "stored" })], null],
    ["a regular file made on Unix", [entry(OUTPUTS_FILE, noop, { unixMode: 0o100644 })], null],
    ["an unexpected name", [entry("changes.patch")], /unexpected entry "changes\.patch"/],
    ["a path", [entry("../outputs.jsonl")], /unexpected entry/],
    ["a directory", [entry("sub/")], /unexpected entry/],
    ["the same name twice", [entry(BASE_FILE), entry(BASE_FILE)], /twice/],
    ["a symlink", [entry(OUTPUTS_FILE, "/etc/passwd", { unixMode: 0o120777 })], /not a regular file/],
    ["too big as declared", [entry(BASE_FILE, "x".repeat(5000))], /over 4096/],
    ["more than it declares (a bomb)", [bomb], /within its declared size|doesn't match/],
    ["too many entries", Array.from({ length: 9 }, (_, i) => entry(`aw-p${i}.patch`)), /entries in the zip/],
  ]) {
    const dir = join(scratch(), "out");
    const problems = unpackZip(makeZip(entries), dir, POLICY);
    if (want) assert.match(problems.join("\n"), want, name);
    else assert.deepEqual(problems, [], name);
    assert.deepEqual(existsSync(dir) ? readdirSync(dir).sort() : [], want ? [] : entries.map((e) => e.name).sort(), name);
  }
  assert.deepEqual(unpackZip(Buffer.from("not a zip at all, really not a zip"), scratch(), POLICY), ["not a zip file"]);
  // Nothing is written for a refused zip.
  const dir = join(scratch(), "out");
  assert.notDeepEqual(unpackZip(makeZip([entry(OUTPUTS_FILE, noop), entry("evil")]), dir, POLICY), []);
  assert.equal(existsSync(dir), false);
});

test("postApplyProblems: a change to an executable that is already one", () => {
  const dir = staged(edit({ "run.sh": "#!/bin/sh\necho hi\n" }), { "run.sh": "#!/bin/sh\n" }, ["run.sh"]);
  assert.deepEqual(postApplyProblems(gitView(dir), POLICY), []);
});

test("the command line", () => {
  const run = (...args) => spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "safe-outputs.mjs"), ...args], { encoding: "utf8" });
  const dir = scratch();
  const policyFile = join(dir, "policy.json");
  let r = run("compile", "--repo", REPO, "--base", BASE, "--workflow", "branch", "--outputs", "create_pull_request", "--max-outputs", "1", "--out", policyFile);
  assert.equal(r.status, 0, r.stderr);
  r = run("compile", "--repo", "evil/x", "--base", BASE, "--workflow", "branch", "--outputs", "create_pull_request", "--max-outputs", "1", "--out", join(dir, "no.json"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not on the allowlist/);
  const out = handback({ lines: [PR], patch: GOOD.patch, base: GOOD.base });
  r = run("check", "--dir", out, "--policy", policyFile, "--json", join(dir, "verdict.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")).ok, true);
  r = run("check", "--dir", handback({ lines: [{ type: "noop", message: "x" }], base: null }), "--policy", policyFile);
  assert.equal(r.status, 1, "noop is not in this policy");
  assert.equal(run("check", "--dir").status, 2);
});
