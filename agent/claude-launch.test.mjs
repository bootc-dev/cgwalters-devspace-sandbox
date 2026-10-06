import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CLAUDE_RUN_DIR, CLAUDE_RUN_FILE, runEnv } from "./claude-config.mjs";

const launcher = fileURLToPath(new URL("./claude-launch.mjs", import.meta.url));

test("launcher gives the adapter only the run's environment and the model, and refuses to start without it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "claude-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const work = join(root, "target");
  for (const dir of [join(home, CLAUDE_RUN_DIR), bin, work]) mkdirSync(dir, { recursive: true });
  const fake = join(root, "fake.mjs");
  writeFileSync(fake, 'console.log(JSON.stringify({ env: process.env, argv: process.argv.slice(2) })); process.exit(Number(process.env.FAKE_EXIT));\n');
  writeFileSync(join(bin, "claude-agent-acp"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const runFile = join(home, CLAUDE_RUN_DIR, CLAUDE_RUN_FILE);
  // Whatever session runs the tests has such variables of its own.
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ANTHROPIC|CLAUDE)_/.test(name)));
  const env = {
    ...ambient, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: "23", KEEP_ME: "kept",
    ANTHROPIC_MODEL: "opus", ANTHROPIC_API_KEY: "inherited", ANTHROPIC_BASE_URL: "http://elsewhere.example",
    CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: work, CLAUDE_CODE_OAUTH_TOKEN: "inherited",
  };
  const launch = () => spawnSync(process.execPath, [launcher, "--flag"], { env, cwd: work, encoding: "utf8" });

  const missing = launch();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /claude launcher: reading .*run\.json/);
  assert.equal(missing.stdout, "");
  // (the file's content, the error)
  const invalid = [
    ["{}", /must hold an "env" object/],
    ['{"env": {"PATH": "/evil"}}', /must hold an "env" object/],
    ['{"env": {"ANTHROPIC_BASE_URL": 1}}', /must hold an "env" object/],
    ["not json", /reading .*run\.json/],
  ];
  for (const [content, error] of invalid) {
    writeFileSync(runFile, content);
    const result = launch();
    assert.equal(result.status, 1, content);
    assert.match(result.stderr, error);
    assert.equal(result.stdout, "");
  }

  const run = runEnv({ baseURL: "http://100.64.0.1:18080/v1", runToken: `praxis-run-${"a".repeat(64)}` });
  writeFileSync(runFile, JSON.stringify({ env: run }));
  // A target-local file must never be read.
  mkdirSync(join(work, CLAUDE_RUN_DIR), { recursive: true });
  writeFileSync(join(work, CLAUDE_RUN_DIR, CLAUDE_RUN_FILE), '{"env": {"ANTHROPIC_BASE_URL": "http://target.example"}}');
  const result = launch();
  assert.equal(result.status, 23, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(out.argv, ["--flag"]);
  assert.equal(out.env.KEEP_ME, "kept");
  const configEnv = Object.fromEntries(Object.entries(out.env).filter(([name]) => /^(ANTHROPIC|CLAUDE)_/.test(name)));
  assert.deepEqual(configEnv, { ...run, ANTHROPIC_MODEL: "opus", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  assert.equal(out.env.DISABLE_AUTOUPDATER, "1");

  const relative = spawnSync(process.execPath, [launcher], { env: { ...env, HOME: "relative" }, encoding: "utf8" });
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /HOME must be an absolute path/);
  rmSync(join(bin, "claude-agent-acp"));
  const failed = spawnSync(process.execPath, [launcher], { env: { ...env, PATH: bin }, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /starting claude-agent-acp:.*ENOENT/);
});
