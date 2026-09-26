#!/usr/bin/env node
// The gate before agent.yml uploads anything, all public: the target must
// still be a public repository (fail closed), and no secret-shaped string
// may have survived redaction, in the run summary or the transcript. Once
// that holds, it publishes the step summary (the run's summary.md).
//   check-uploads.mjs OUT REPO    (AGENT, GH_TOKEN from the workflow)
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SECRET_PATTERNS } from "../agent/redact.mjs";
import { fail } from "./runner-sandbox.mjs";
import { isPublicRepo } from "./public-repo.mjs";

const [out, repo] = process.argv.slice(2);
if (!repo) fail("usage: check-uploads.mjs OUT REPO");
try {
  if (!(await isPublicRepo(repo))) throw new Error("it is not public");
} catch (e) {
  fail(`not uploading anything for ${repo}: ${e.message}`);
}

const secret = new RegExp(SECRET_PATTERNS.join("|"));
const runDir = join(out, "run");
const files = readdirSync(runDir).map((name) => [name, readFileSync(join(runDir, name))]);
const tar = spawnSync("tar", ["--zstd", "-xOf", join(out, "transcript.tar.zst")], { maxBuffer: 1 << 30 });
if (tar.status !== 0) fail("can't read the transcript");
files.push(["transcript.tar.zst", tar.stdout]);
for (const [name, content] of files) {
  if (secret.test(content.toString("latin1"))) fail(`a secret-shaped string survived redaction in ${name}`);
}
// The fake agent's demo prints a token-shaped string on purpose.
const FAKE_AGENT = "fake";
const { redactions } = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
if (process.env.AGENT === FAKE_AGENT && !(redactions > 0)) fail("the redaction pass replaced nothing in a fake agent run");
console.log(`${repo} is public; redacted ${redactions} string(s); no secret-shaped string left`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(join(runDir, "summary.md")));
