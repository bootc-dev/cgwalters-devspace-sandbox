import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const launcher = fileURLToPath(new URL("./opencode-launch.mjs", import.meta.url));

test("launcher cleans inherited configuration, keeps the login session and selects only the installed absolute profile", (t) => {
  const root = mkdtempSync(join(tmpdir(), "oc-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const work = join(root, "target");
  for (const dir of [home, bin, work]) mkdirSync(dir);
  const fake = join(root, "fake.mjs");
  writeFileSync(fake, 'console.log(JSON.stringify({ env: process.env, argv: process.argv.slice(2) })); process.exit(Number(process.env.FAKE_EXIT));\n');
  writeFileSync(join(bin, "opencode"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const profile = join(home, ".config/opencode/opencode-runner.json");
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  // A target-local profile must never be selected, even in the absent case.
  writeFileSync(join(work, "opencode-runner.json"), "{}");
  // Whatever session runs the tests has such variables of its own.
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE|XDG)_/.test(name)));
  for (const present of [false, true]) {
    if (present) writeFileSync(profile, "{}");
    const env = {
      ...ambient, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: "23", KEEP_ME: "kept",
      OPENCODE_CONFIG: "opencode-runner.json", OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG_DIR: work,
      OPENCODE_DISABLE_PROJECT_CONFIG: "0", OPENCODE_DISABLE_MODELS_FETCH: "0", OPENCODE_OTHER: "inherited",
      XDG_CONFIG_HOME: work, XDG_CONFIG_DIRS: work, XDG_DATA_HOME: work, XDG_DATA_DIRS: work, XDG_STATE_HOME: work, XDG_CACHE_HOME: work,
      XDG_RUNTIME_DIR: work, XDG_SESSION_ID: "7",
    };
    const result = spawnSync(process.execPath, [launcher, "--port", "1234"], { env, cwd: work, encoding: "utf8" });
    assert.equal(result.status, 23, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.deepEqual(out.argv, ["acp", "--port", "1234"]);
    assert.equal(out.env.KEEP_ME, "kept");
    assert.equal(out.env.HOME, home);
    assert.equal(out.env.PATH, env.PATH);
    const configEnv = Object.fromEntries(Object.entries(out.env).filter(([name]) => name.startsWith("OPENCODE_") || name.startsWith("XDG_")));
    assert.deepEqual(configEnv, {
      OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      // The login session's, which rootless podman needs.
      XDG_RUNTIME_DIR: work, XDG_SESSION_ID: "7",
      ...(present ? { OPENCODE_CONFIG: profile } : {}),
    });
    if (present) assert.ok(isAbsolute(out.env.OPENCODE_CONFIG));
  }
  const invalid = spawnSync(process.execPath, [launcher], { env: { ...process.env, HOME: "relative" }, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /HOME must be an absolute path/);
  rmSync(join(bin, "opencode"));
  const failed = spawnSync(process.execPath, [launcher], { env: { ...process.env, HOME: home, PATH: bin }, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /starting opencode:.*ENOENT/);
});
