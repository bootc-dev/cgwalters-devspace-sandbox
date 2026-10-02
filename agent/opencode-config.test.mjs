// Tests for agent/opencode-config.mjs. Run with: node --test agent/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFiles, parseOpencodeConfig, runConfig, stripJsonc } from "./opencode-config.mjs";

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

test("runConfig sets the base URL, run token and sharing, keeping the rest", () => {
  const out = runConfig(parseOpencodeConfig(goodConfig({ share: "auto", model: "praxis/m" })), { baseURL: "http://broker/v1", apiKey: "tok" });
  assert.equal(out.share, "disabled");
  assert.equal(out.model, "praxis/m");
  assert.deepEqual(out.provider.praxis.options, { baseURL: "http://broker/v1", apiKey: "tok" });
  assert.deepEqual(out.provider.praxis.models, { m: {} });
});

test("configFiles copies only the named files and keeps them inside the checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-"));
  const dir = join(root, "cfg");
  mkdirSync(dir);
  writeFileSync(join(root, "AGENTS.md"), "x");
  writeFileSync(join(dir, "opencode.json"), "{}");
  writeFileSync(join(dir, "opencode.jsonc"), "{}");
  mkdirSync(join(dir, "plugins"));
  symlinkSync("../AGENTS.md", join(dir, "AGENTS.md"));
  assert.deepEqual(configFiles(dir, root), ["opencode.json", "AGENTS.md"]);
  rmSync(join(dir, "AGENTS.md"));
  symlinkSync("/etc/passwd", join(dir, "AGENTS.md"));
  assert.throws(() => configFiles(dir, root), /outside the homegit checkout/);
  rmSync(join(dir, "AGENTS.md"));
  mkdirSync(join(dir, "AGENTS.md"));
  assert.throws(() => configFiles(dir, root), /not a regular file/);
});
