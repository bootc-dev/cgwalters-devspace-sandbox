import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLAUDE_MEMORY_FILE, CLAUDE_RUN_DIR, CLAUDE_RUN_FILE, CONFIG_INSTALL_COMMAND, PLACEHOLDER_CREDENTIAL, anthropicBaseUrl, installClaudeConfig, managedSettings, runEnv } from "./claude-config.mjs";
import { TOKEN_CONFIG } from "./praxis.mjs";

const TOKEN = `praxis-run-${"a".repeat(64)}`;

test("the broker's Anthropic routes are beside its Responses base URL", () => {
  const cases = [
    ["http://100.64.0.1:18080/v1", "http://100.64.0.1:18080/anthropic"],
    ["http://100.64.0.1:18080/v1/", "http://100.64.0.1:18080/anthropic"],
    ["https://broker.example/praxis/v1?x=1#y", "https://broker.example/praxis/anthropic"],
  ];
  for (const [base, expected] of cases) assert.equal(anthropicBaseUrl(base), expected);
  for (const bad of ["http://100.64.0.1:18080", "http://100.64.0.1:18080/v2", "http://100.64.0.1:18080/v1/responses"]) {
    assert.throws(() => anthropicBaseUrl(bad), /must end in \/v1/, bad);
  }
  assert.throws(() => anthropicBaseUrl("not a url"));
});

test("the run token is only in the run's environment, never in the managed settings", () => {
  const baseURL = "http://100.64.0.1:18080/v1";
  assert.deepEqual(runEnv({ baseURL, runToken: TOKEN }), {
    ANTHROPIC_BASE_URL: "http://100.64.0.1:18080/anthropic",
    ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_CREDENTIAL,
    ANTHROPIC_CUSTOM_HEADERS: `x-run-token: ${TOKEN}`,
  });
  const managed = managedSettings({ baseURL });
  assert.ok(!JSON.stringify(managed).includes("praxis-run-"));
  assert.equal(managed.env.ANTHROPIC_BASE_URL, "http://100.64.0.1:18080/anthropic");
  assert.equal(managed.env.ANTHROPIC_AUTH_TOKEN, PLACEHOLDER_CREDENTIAL);
  for (const name of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) assert.equal(managed.env[name], "");
  assert.equal(managed.allowManagedHooksOnly, true);
  assert.equal(managed.allowManagedPermissionRulesOnly, true);
  assert.deepEqual(managed.permissions, { defaultMode: "default", disableBypassPermissionsMode: "disable" });
  assert.throws(() => installClaudeConfig({ baseURL, runToken: null }), /no run token/);
  // What the isolation check looks for.
  assert.equal(TOKEN_CONFIG.claude, `${CLAUDE_RUN_DIR}/${CLAUDE_RUN_FILE}`);
});

test("the install command replaces the files, private to the user, and leaves the home's mode alone", (t) => {
  const root = mkdtempSync(join(tmpdir(), "claude-config-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const stage = join(root, "stage");
  mkdirSync(home, { mode: 0o755 });
  const files = [join(CLAUDE_RUN_DIR, CLAUDE_RUN_FILE), CLAUDE_MEMORY_FILE];
  for (const round of ["first", "second"]) {
    for (const f of files) {
      mkdirSync(join(stage, f, ".."), { recursive: true });
      writeFileSync(join(stage, f), round, { mode: 0o644 });
    }
    const tar = spawnSync("tar", ["-C", stage, "-cf", "-", ...files]);
    const result = spawnSync("sh", ["-c", CONFIG_INSTALL_COMMAND], { env: { ...process.env, HOME: home }, input: tar.stdout, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    for (const f of files) assert.equal(readFileSync(join(home, f), "utf8"), round);
    assert.equal(statSync(join(home, files[0])).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, CLAUDE_RUN_DIR)).mode & 0o777, 0o700);
    assert.equal(statSync(home).mode & 0o777, 0o755);
  }
});
