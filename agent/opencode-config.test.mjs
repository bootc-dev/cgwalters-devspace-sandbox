// Tests for agent/opencode-config.mjs. Run with: node --test agent/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_INSTALL_COMMAND, OPENCODE_CONFIG_DIR, OPENCODE_RUNNER_FILE, checkRunnerProfile, configFiles, parseOpencodeConfig, runConfig, stripJsonc } from "./opencode-config.mjs";

const PRAXIS = { name: "p", options: { baseURL: "http://local", apiKey: "unused" }, models: { m: {} } };
const goodConfig = (extra = {}) => JSON.stringify({ enabled_providers: ["praxis"], provider: { praxis: PRAXIS }, ...extra });

test("stripJsonc", () => {
  for (const [input, want] of [
    ['{"a": 1, // note\n "b": "http://x"}', { a: 1, b: "http://x" }],
    ['{/* c */ "a": [1, 2,],}', { a: [1, 2] }],
    ['{"a": "x // not a comment"}', { a: "x // not a comment" }],
    ['{"a": "x,}", "b": [1,\n // c\n ],}', { a: "x,}", b: [1] }],
  ]) assert.deepEqual(JSON.parse(stripJsonc(input)), want, input);
});

test("parseOpencodeConfig accepts only the praxis provider", () => {
  assert.equal(parseOpencodeConfig(goodConfig()).enabled_providers[0], "praxis");
  for (const [name, text, error] of [
    ["not JSON", "{", /isn't valid JSONC/],
    ["no enabled_providers", JSON.stringify({ provider: { praxis: PRAXIS } }), /only the praxis provider/],
    ["another enabled", goodConfig({ enabled_providers: ["praxis", "openai"] }), /only the praxis provider/],
    ["another defined", JSON.stringify({ enabled_providers: ["praxis"], provider: { praxis: PRAXIS, evil: {} } }), /only the praxis provider/],
  ]) assert.throws(() => parseOpencodeConfig(text), error, name);
});

test("checkRunnerProfile refuses a profile that isn't an object or touches the providers", () => {
  checkRunnerProfile('{ // jsonc\n "default_agent": "build", "agent": { "build": { "model": "praxis/m" } }, }');
  // (profile, error)
  const cases = [
    ["{", /isn't valid JSONC/],
    ["[]", /must be a JSON object/],
    ["null", /must be a JSON object/],
    ['{"provider":{"other":{}}}', /must not set provider:/],
    ['{"enabled_providers":["praxis","other"],"disabled_providers":[]}', /must not set enabled_providers, disabled_providers:/],
  ];
  for (const [text, error] of cases) assert.throws(() => checkRunnerProfile(text), error, text);
});

test("runConfig sets the base URL, run token and sharing, keeping the rest", () => {
  const out = runConfig(parseOpencodeConfig(goodConfig({ share: "auto", model: "praxis/m" })), { baseURL: "http://broker/v1", apiKey: "tok" });
  assert.equal(out.share, "disabled");
  assert.equal(out.model, "praxis/m");
  assert.deepEqual(out.provider.praxis.options, { baseURL: "http://broker/v1", apiKey: "tok" });
  assert.deepEqual(out.provider.praxis.models, { m: {} });
});

test("configFiles copies only the named files and keeps them inside the checkout", (t) => {
  const root = mkdtempSync(join(tmpdir(), "oc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "cfg");
  mkdirSync(dir);
  writeFileSync(join(root, "AGENTS.md"), "x");
  writeFileSync(join(dir, "opencode.json"), "{}");
  writeFileSync(join(dir, "opencode.jsonc"), "{}");
  mkdirSync(join(dir, "plugins"));
  symlinkSync("../AGENTS.md", join(dir, "AGENTS.md"));
  assert.deepEqual(configFiles(dir, root), ["opencode.json", "AGENTS.md"]);
  writeFileSync(join(dir, OPENCODE_RUNNER_FILE), '{"default_agent":"build"}');
  assert.deepEqual(configFiles(dir, root), ["opencode.json", "AGENTS.md", OPENCODE_RUNNER_FILE]);
  rmSync(join(dir, OPENCODE_RUNNER_FILE));
  symlinkSync("/etc/passwd", join(dir, OPENCODE_RUNNER_FILE));
  assert.throws(() => configFiles(dir, root), /outside the homegit checkout/);
  rmSync(join(dir, OPENCODE_RUNNER_FILE));
  mkdirSync(join(dir, OPENCODE_RUNNER_FILE));
  assert.throws(() => configFiles(dir, root), /not a regular file/);
  rmSync(join(dir, OPENCODE_RUNNER_FILE), { recursive: true });
  rmSync(join(dir, "AGENTS.md"));
  symlinkSync("/etc/passwd", join(dir, "AGENTS.md"));
  assert.throws(() => configFiles(dir, root), /outside the homegit checkout/);
  rmSync(join(dir, "AGENTS.md"));
  mkdirSync(join(dir, "AGENTS.md"));
  assert.throws(() => configFiles(dir, root), /not a regular file/);
});

test("installation copies the optional profile and removes it when subsequently absent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "oc-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const home = join(root, "home");
  mkdirSync(stage);
  mkdirSync(home);
  writeFileSync(join(stage, "opencode.json"), goodConfig());
  const profile = '{"default_agent":"build"}\n';
  writeFileSync(join(stage, OPENCODE_RUNNER_FILE), profile);
  const installed = join(home, OPENCODE_CONFIG_DIR, OPENCODE_RUNNER_FILE);
  const outside = join(root, "untouched");
  writeFileSync(outside, "unchanged");
  mkdirSync(join(home, OPENCODE_CONFIG_DIR), { recursive: true });
  symlinkSync(outside, installed);
  for (const present of [true, false]) {
    if (!present) rmSync(join(stage, OPENCODE_RUNNER_FILE));
    const tar = spawnSync("tar", ["-C", stage, "-cf", "-", "."]);
    assert.equal(tar.status, 0, tar.stderr.toString());
    const result = spawnSync("sh", ["-c", CONFIG_INSTALL_COMMAND], { env: { ...process.env, HOME: home }, input: tar.stdout });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(existsSync(installed), present);
    if (present) assert.equal(readFileSync(installed, "utf8"), profile);
    assert.equal(readFileSync(outside, "utf8"), "unchanged");
    assert.equal(statSync(join(home, OPENCODE_CONFIG_DIR, "opencode.json")).mode & 0o777, 0o600);
  }
});
