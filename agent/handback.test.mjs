// Tests for agent/handback.mjs. Run with: node --test agent/*.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildOutputs, defaultPullRequest, runBranch, writeHandback } from "./handback.mjs";
import { checkOutputs, compilePolicy } from "../safe-outputs/safe-outputs.mjs";
import { BASE, REPO, repoWith, scratch, write } from "../safe-outputs/test-helpers.mjs";

const ALLOWED = ["create_pull_request", "noop"];
const BRANCH = runBranch(42);

test("buildOutputs", () => {
  const outcome = { summary: "Fix the parser.\nIt dropped the last line." };
  for (const [name, args, want] of [
    ["nothing", { agentText: "", hasChanges: false }, { text: "", wantsPatch: false }],
    ["a change the agent didn't request", { agentText: "", hasChanges: true },
      { lines: [{ type: "create_pull_request", title: "Fix the parser.", body: outcome.summary, branch: BRANCH }], wantsPatch: true }],
    ["the agent's own request gets the run's branch", { agentText: '{"type":"create_pull_request","title":"T","body":"B","branch":"evil/../x"}\n', hasChanges: true },
      { lines: [{ type: "create_pull_request", title: "T", body: "B", branch: BRANCH }], wantsPatch: true }],
    ["dashes in the type", { agentText: '{"type":"create-pull-request","title":"T","body":"B"}', hasChanges: true },
      { lines: [{ type: "create-pull-request", title: "T", body: "B", branch: BRANCH }], wantsPatch: true }],
    ["a noop without changes", { agentText: '{"type":"noop","message":"m"}', hasChanges: false },
      { lines: [{ type: "noop", message: "m" }], wantsPatch: false }],
    ["a request without changes has no patch", { agentText: '{"type":"create_pull_request","title":"T","body":"B"}', hasChanges: false },
      { lines: [{ type: "create_pull_request", title: "T", body: "B", branch: BRANCH }], wantsPatch: false }],
    ["a line that isn't JSON stays for the check", { agentText: "oops\n", hasChanges: false }, { raw: "oops\n", wantsPatch: false }],
  ]) {
    const got = buildOutputs({ allowed: ALLOWED, branch: BRANCH, outcome, runId: 42, ...args });
    assert.equal(got.wantsPatch, want.wantsPatch, name);
    assert.equal(got.text, want.raw ?? (want.lines ? `${want.lines.map((l) => JSON.stringify(l)).join("\n")}\n` : want.text), name);
  }
  // Not allowed: no pull request is made up for the change.
  assert.equal(buildOutputs({ allowed: ["noop"], branch: BRANCH, agentText: "", hasChanges: true, outcome, runId: 42 }).wantsPatch, false);
});

test("defaultPullRequest", () => {
  assert.equal(defaultPullRequest({}, 9).title, "Agent run 9");
  assert.equal(defaultPullRequest({ summary: "x".repeat(300) }, 9).title.length, 100);
  assert.equal(defaultPullRequest({ summary: "  one\n\ntwo  " }, 9).title, "one");
});

const policyFor = (outputs) => compilePolicy({ repo: REPO, base: BASE, workflow: "branch", outputs, maxOutputs: "3" }).policy;

test("writeHandback: a change becomes outputs a check accepts", async () => {
  const { dir, git, base } = repoWith();
  write(dir, { "src/lib.rs": "fn main() { 2; }\n", "docs/x.md": "hi\n" });
  const outDir = scratch();
  const policy = policyFor("create_pull_request,noop");
  const patch = writeHandback({ outDir, git, agentText: "", policy, repo: REPO, ref: BASE, base, runId: 42, outcome: { summary: "Do it." }, hasChanges: true });
  assert.equal(patch.base, base);
  assert.deepEqual(readdirSync(outDir).sort(), ["aw-agent-run-42.patch", "base.json", "outputs.jsonl"]);
  assert.match(readFileSync(join(outDir, "aw-agent-run-42.patch"), "utf8"), new RegExp(`^From [0-9a-f]{40} .*\\nX-GH-AW-Base-Commit: ${base}\\n`));
  const verdict = await checkOutputs(outDir, policy);
  assert.deepEqual(verdict.errors, []);
  assert.deepEqual(verdict.items.map((i) => [i.type, i.title]), [["create_pull_request", "Do it."]]);
});

test("writeHandback: a commit of the agent's own is handed back too", async () => {
  const { dir, git, base } = repoWith();
  write(dir, { "src/a.rs": "x\n" });
  git(["add", "--all"]);
  git(["-c", "user.name=a", "-c", "user.email=a@localhost", "commit", "-q", "-m", "mine"]);
  write(dir, { "src/b.rs": "y\n" });
  const outDir = scratch();
  const patch = writeHandback({ outDir, git, agentText: "", policy: policyFor("create_pull_request"), repo: REPO, ref: BASE, base, runId: 1, outcome: {}, hasChanges: true });
  const text = readFileSync(join(outDir, "aw-agent-run-1.patch"), "utf8");
  assert.ok(patch.bytes > 0);
  assert.match(text, /src\/a\.rs/);
  assert.match(text, /src\/b\.rs/);
});

test("writeHandback: no change, a change that can't be a pull request", () => {
  const { dir, git, base } = repoWith();
  const call = (extra) => {
    const outDir = scratch();
    mkdirSync(outDir, { recursive: true });
    const got = writeHandback({ outDir, git, agentText: "", policy: policyFor("create_pull_request"), repo: REPO, ref: BASE, base, runId: 1, outcome: {}, hasChanges: false, ...extra });
    return { got, files: readdirSync(outDir) };
  };
  assert.deepEqual(call({}), { got: null, files: [] });
  write(dir, { "x.rs": "x\n" });
  const dropped = call({ hasChanges: true, policy: policyFor("noop") });
  assert.match(dropped.got.error, /changes dropped/);
  assert.deepEqual(dropped.files, []);
  writeFileSync(join(dir, "big"), "0123456789".repeat(100));
  const big = call({ hasChanges: true, policy: { ...policyFor("create_pull_request"), max_patch_bytes: 500 } });
  assert.match(big.got.error, /over 500 bytes/);
});
