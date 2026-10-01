// Safe outputs, step 2 of 2: apply what validate.cjs accepted.
//
// Runs in the apply job's publish phase, as runner with the job's token
// (issues: write and nothing else). Its input was written in the sandbox,
// so it is not trusted either: the hard limits (types, targets, sizes,
// counts, secrets) are checked again here against the config the
// privileged phase shared, and anything outside them fails the job
// before a single write.
//
// Usage: node apply.cjs CONFIG VALIDATED_JSON
"use strict";
const fs = require("node:fs");

const env = process.env;
const API = env.GITHUB_API_URL ?? "https://api.github.com";
const SECRET_RE = /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_|\bpraxis-run-|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function fail(message) {
  console.error(`apply: ${message}`);
  process.exit(1);
}

// Text from the sandbox, shown in Markdown as code and on one line.
const code = (s) => `\`${String(s).replace(/[`\r\n]/g, " ").slice(0, 200)}\``;

function recheck(accepted, config) {
  if (!Array.isArray(accepted)) fail("accepted is not an array");
  if (accepted.length > config.max_total) fail(`${accepted.length} outputs is over the cap of ${config.max_total}`);
  const counts = {};
  for (const o of accepted) {
    const allowed = config.types[o?.type];
    if (!allowed) fail(`type ${code(o?.type)} is not enabled`);
    counts[o.type] = (counts[o.type] ?? 0) + 1;
    if (counts[o.type] > allowed.max) fail(`more than ${allowed.max} ${o.type}`);
    if (o.type === "add_comment") {
      if (!allowed.targets.includes(o.item_number)) fail(`target ${code(o.item_number)} is not allowed`);
      if (typeof o.body !== "string" || Buffer.byteLength(o.body) > allowed.max_body_bytes) fail("bad comment body");
      if (SECRET_RE.test(o.body)) fail("comment body looks like it holds a secret");
    }
  }
}

async function addComment(repo, number, body) {
  const footer = `\n\n---\nProposed by the agent in [run ${env.GITHUB_RUN_ID}](${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}), validated and applied by its \`apply\` job.`;
  const res = await fetch(`${API}/repos/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ body: body + footer }),
  });
  if (!res.ok) fail(`commenting on #${number} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).html_url;
}

async function main() {
  const [configPath, validatedPath] = process.argv.slice(2);
  if (!configPath || !validatedPath) fail("usage: apply.cjs CONFIG VALIDATED_JSON");
  for (const name of ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_SERVER_URL"]) {
    if (!env[name]) fail(`${name} is not set`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (config.repo !== env.GITHUB_REPOSITORY) fail(`config is for ${config.repo}, not ${env.GITHUB_REPOSITORY}`);
  const { accepted, rejected } = JSON.parse(fs.readFileSync(validatedPath, "utf8"));
  recheck(accepted, config);

  const summary = ["## Safe outputs", ""];
  for (const o of accepted) {
    if (o.type === "add_comment") {
      const url = await addComment(config.repo, o.item_number, o.body);
      console.log(`applied add_comment: ${url}`);
      summary.push(`- applied \`add_comment\` on #${o.item_number}: ${url}`);
    } else {
      summary.push(`- \`noop\`: ${code(o.message)}`);
    }
  }
  for (const r of Array.isArray(rejected) ? rejected : []) {
    summary.push(`- **rejected** line ${code(r?.line)} ${code(r?.type)}: ${code(r?.reason)}`);
  }
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
  console.log(`${accepted.length} applied, ${Array.isArray(rejected) ? rejected.length : 0} rejected`);
}

main().catch((e) => fail(e.message));
