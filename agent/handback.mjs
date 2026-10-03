// What the agent step of agent.yml hands back, as gh-aw's safe outputs: the
// requests the agent wrote (JSONL, ~/out/safe-outputs.jsonl in its home),
// and for a pull request a patch of its working tree, made here rather
// than taken from the agent, as gh-aw's safeoutputs MCP server makes it
// from the git state: `git format-patch` of one commit against the commit
// the run started from, with its X-GH-AW-Base-Commit header
// (vendor/gh-aw/generate_git_patch.cjs's embedBaseCommit is not vendored:
// that module needs the rest of gh-aw's git helpers). The agent's lines
// are untrusted; safe-outputs/safe-outputs.mjs checks them all, in the
// workflow's safe_outputs job and again in bot-runs apply.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_FILE, OUTPUTS_FILE, patchFileName } from "../safe-outputs/safe-outputs.mjs";

export const CREATE_PULL_REQUEST = "create_pull_request";
const MAX_TITLE = 100;
const MAX_LINES = 1000;
const COMMIT_IDENTITY = ["-c", "user.name=agent", "-c", "user.email=agent@localhost", "-c", "commit.gpgsign=false"];

// The branch name a run's pull request carries (and its patch is named by).
export const runBranch = (runId) => `agent-run-${runId}`;

const oneLine = (s) => s.replace(/\s+/g, " ").trim();

// The create_pull_request request for a change the agent didn't request
// itself, from its outcome.json.
export function defaultPullRequest(outcome, runId) {
  const summary = typeof outcome?.summary === "string" ? outcome.summary.trim() : "";
  const title = oneLine(summary.split("\n")[0] ?? "").slice(0, MAX_TITLE) || `Agent run ${runId}`;
  return { type: CREATE_PULL_REQUEST, title, body: summary || `Changes from agent run ${runId}.` };
}

// The outputs.jsonl to upload: the agent's lines (those that aren't JSON
// objects stay as they are, for the check to refuse), its
// create_pull_request given the run's branch, and one made from
// outcome.json when the agent changed files without asking for one.
// Returns {text, wantsPatch}: whether a patch is to go with it.
export function buildOutputs({ agentText, allowed, branch, hasChanges, outcome, runId }) {
  const lines = agentText.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, MAX_LINES);
  let sawPullRequest = false;
  const out = lines.map((line) => {
    try {
      const item = JSON.parse(line);
      if (item && typeof item === "object" && String(item.type).replaceAll("-", "_") === CREATE_PULL_REQUEST) {
        sawPullRequest = true;
        return JSON.stringify({ ...item, branch });
      }
    } catch { /* not JSON: the check reports it */ }
    return line;
  });
  if (hasChanges && !sawPullRequest && allowed.includes(CREATE_PULL_REQUEST)) {
    out.push(JSON.stringify({ ...defaultPullRequest(outcome, runId), branch }));
    sawPullRequest = true;
  }
  return { text: out.length > 0 ? `${out.join("\n")}\n` : "", wantsPatch: sawPullRequest && hasChanges };
}

// Commits the working tree as one commit on top of BASE and formats it as
// gh-aw's patch. GIT(args, {limit}) runs git in the checkout (as the
// agent) and gives {status, stdout}. Returns null when nothing changed,
// {error} when it can't be handed back, else {patch: Buffer}.
export function buildPatch(git, base, message, maxBytes) {
  if (git(["reset", "-q", "--soft", base]).status !== 0) return { error: "git reset failed" };
  if (git(["add", "--all"]).status !== 0) return { error: "git add failed" };
  // Exit status 1: there are differences.
  const diff = git(["diff", "--cached", "--quiet"]).status;
  if (diff === 0) return null;
  if (diff !== 1) return { error: "git diff failed" };
  if (git([...COMMIT_IDENTITY, "commit", "-q", "--no-verify", "-m", message]).status !== 0) return { error: "git commit failed" };
  const formatted = git(["format-patch", "--stdout", "--no-renames", "--no-signature", "-1", "HEAD"], { limit: maxBytes + 1 });
  if (formatted.status !== 0) return { error: "git format-patch failed" };
  if (formatted.stdout.length > maxBytes) return { error: `the change is over ${maxBytes} bytes` };
  const text = formatted.stdout.toString("utf8");
  const firstLine = text.indexOf("\n");
  if (firstLine < 0) return { error: "git format-patch gave no patch" };
  return { patch: Buffer.from(`${text.slice(0, firstLine + 1)}X-GH-AW-Base-Commit: ${base}\n${text.slice(firstLine + 1)}`) };
}

// Writes the hand-back into OUTDIR: outputs.jsonl, base.json and the patch.
// Returns what summary.json says of the change, {base, bytes} or {base,
// error}, or null.
export function writeHandback({ outDir, git, agentText, policy, repo, ref, base, runId, outcome, hasChanges }) {
  const branch = runBranch(runId);
  const allowed = Object.keys(policy.safe_outputs);
  const { text, wantsPatch } = buildOutputs({ agentText, allowed, branch, hasChanges, outcome, runId });
  let patch = null;
  if (hasChanges && wantsPatch) {
    const title = defaultPullRequest(outcome, runId).title;
    const built = buildPatch(git, base, title, policy.max_patch_bytes);
    if (built?.error) return { base, error: built.error };
    if (built) {
      writeFileSync(join(outDir, patchFileName(branch)), built.patch);
      writeFileSync(join(outDir, BASE_FILE), `${JSON.stringify({ repo, ref, commit: base })}\n`);
      patch = { base, bytes: built.patch.length };
    }
  }
  if (text) writeFileSync(join(outDir, OUTPUTS_FILE), text);
  if (hasChanges && !wantsPatch) return { base, error: `changes dropped: ${CREATE_PULL_REQUEST} is not an allowed output` };
  return patch;
}
