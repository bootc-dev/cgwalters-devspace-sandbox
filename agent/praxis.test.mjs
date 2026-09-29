// Tests for agent/praxis.mjs register, against a fake GitHub OIDC endpoint
// and praxis runs endpoint. Run with: node --test agent/*.test.mjs (just test)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AUDIENCE, LEGACY_FILE, RECORD_SCHEMA, TOKEN_FILE, USAGE_FILE, finish, register, runToken } from "./praxis.mjs";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2ln";
const REQUEST_TOKEN = "request-token";
const RUN_TOKEN = `praxis-run-${"ab".repeat(32)}`;
const WORKFLOW_REF = "owner/repo/.github/workflows/agent.yml@refs/heads/main";

// A server whose /v1/runs answers with each of STATUSES in turn (the last
// one repeating), each a status or [status, body], granting a run of TTL_S
// seconds; records the registrations it got. DELETE /v1/runs/self answers
// FINISH_ANSWER.
async function fakePraxis(statuses, { ttlS = 3600, finishAnswer = [200, { schema: RECORD_SCHEMA }] } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/oidc") {
        assert.equal(url.searchParams.get("audience"), AUDIENCE);
        assert.equal(req.headers.authorization, `Bearer ${REQUEST_TOKEN}`);
        res.end(JSON.stringify({ value: JWT }));
        return;
      }
      if (req.method === "DELETE") {
        assert.equal(url.pathname, "/v1/runs/self");
        seen.push({ auth: req.headers.authorization, method: "DELETE" });
        res.statusCode = finishAnswer[0];
        res.end(JSON.stringify(finishAnswer[1]));
        return;
      }
      assert.equal(url.pathname, "/v1/runs");
      seen.push({ auth: req.headers.authorization, body: data });
      const answer = statuses[Math.min(seen.length, statuses.length) - 1];
      const [status, body] = Array.isArray(answer) ? answer : [answer, "refused\n"];
      res.statusCode = status;
      res.end(status === 201
        ? JSON.stringify({ token: RUN_TOKEN, usage: {
          schema: RECORD_SCHEMA, run_id: 1, run_attempt: 1, state: "active",
          expires_at_unix: Math.floor(Date.now() / 1000) + ttlS } })
        : body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { seen, server, env: {
    PRAXIS_BASE_URL: `${base}/v1`, TIMEOUT_MINUTES: "10",
    ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    GITHUB_WORKFLOW_REF: WORKFLOW_REF, GITHUB_REPOSITORY_ID: "1234",
  } };
}

const opts = (env, lines = []) => ({ env, retryDelayMs: 1, log: (l) => lines.push(l) });
const newDir = () => join(mkdtempSync(join(tmpdir(), "praxis-test-")), "praxis");

test("registration sends only the OIDC token, masks the run token and keeps it private", async () => {
  const p = await fakePraxis([201]);
  const dir = newDir();
  const lines = [];
  const usage = await register(dir, opts(p.env, lines));
  p.server.close();
  assert.equal(usage.run_id, 1);
  assert.deepEqual(p.seen, [{ auth: `Bearer ${JWT}`, body: "" }]);
  assert.equal(lines[0], `::add-mask::${RUN_TOKEN}`);
  // Only the mask command names the token.
  assert.ok(lines.slice(1).every((l) => !l.includes(RUN_TOKEN)));
  assert.equal(readFileSync(join(dir, TOKEN_FILE), "utf8"), `${RUN_TOKEN}\n`);
  assert.equal(runToken(dir), RUN_TOKEN);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, TOKEN_FILE)).mode & 0o777, 0o600);
});

test("server errors are retried with the same OIDC token", async () => {
  const p = await fakePraxis([[503, "OIDC keys unavailable\n"], 429, 500, 201]);
  await register(newDir(), opts(p.env));
  p.server.close();
  assert.equal(p.seen.length, 4);
  assert.ok(p.seen.every((s) => s.auth === `Bearer ${JWT}`));
});

test("a broker that refuses the registration fails closed, saying how to set it up", async () => {
  const policy = `workflows: \\["${WORKFLOW_REF}"\\], repository_ids: \\[1234\\]`;
  const cases = [
    [[503, "run registration is not configured\n"], new RegExp(`has no run registration policy .*${policy}`)],
    [[403, "workflow may not register runs\n"], new RegExp(`refused to register runs of this workflow .*${policy}`)],
    [[401, "invalid OIDC token\n"], /rejected this job's OIDC token \(HTTP 401: invalid OIDC token\).*audience/],
    [[409, "run already registered\n"], /refused to register this job's run again .*re-run of the workflow/],
    [[405, "method not allowed\n"], /failed \(HTTP 405: method not allowed\)/],
  ];
  for (const [answer, want] of cases) {
    const p = await fakePraxis([answer]);
    const dir = newDir();
    const error = await register(dir, opts(p.env)).catch((e) => e);
    p.server.close();
    assert.match(error.message, want, `${answer[0]}`);
    // No retry, no token, and not taken for a broker without run tokens.
    assert.equal(p.seen.length, 1, `${answer[0]}`);
    for (const file of [TOKEN_FILE, LEGACY_FILE]) assert.throws(() => statSync(join(dir, file)));
  }
});

test("a broker from before run tokens runs the agent without one", async () => {
  const p = await fakePraxis([[404, "not found\n"]]);
  const dir = newDir();
  const lines = [];
  assert.equal(await register(dir, opts(p.env, lines)), null);
  p.server.close();
  assert.equal(p.seen.length, 1);
  assert.ok(lines.some((l) => /^::warning::praxis at .* has no run registration \(HTTP 404\).*neither capped nor counted/.test(l)));
  assert.throws(() => statSync(join(dir, TOKEN_FILE)));
  assert.equal(runToken(dir), null);
  // Nothing to end.
  assert.equal(await finish(dir, opts(p.env)), null);
});

test("without a registration there is no run token", () => {
  assert.throws(() => runToken(newDir()), /ENOENT/);
});

test("an unreachable broker is reported as such", async () => {
  const p = await fakePraxis([201]);
  const env = { ...p.env, PRAXIS_BASE_URL: "http://127.0.0.1:1/v1" };
  await assert.rejects(register(newDir(), opts(env)), /can't reach praxis at http:\/\/127.0.0.1:1\/v1.*tailnet/);
  p.server.close();
});

test("without OIDC request variables there is nothing to register with", async () => {
  await assert.rejects(register(newDir(), opts({ PRAXIS_BASE_URL: "http://x/v1", TIMEOUT_MINUTES: "1" })),
    /id-token: write/);
});

test("a lifetime shorter than the agent's timeout is warned about", async () => {
  for (const [ttlS, warned] of [[3600, false], [300, true]]) {
    const p = await fakePraxis([201], { ttlS });
    const lines = [];
    await register(newDir(), opts(p.env, lines));
    p.server.close();
    assert.equal(lines.some((l) => /^::warning::the praxis run expires at .* before the agent's 10-minute timeout/.test(l)), warned, `${ttlS}`);
    assert.ok(lines.some((l) => /^Registered praxis run 1\/1, until 20/.test(l)));
  }
});

test("finish ends the run with its token and keeps the record private", async () => {
  const record = { schema: RECORD_SCHEMA, run_id: 1, run_attempt: 1, state: "finished", requests: 2,
    unmetered: 0, tokens: { input: 1, cache_read: 2, output: 3, reasoning: 0, total: 6 } };
  const p = await fakePraxis([201], { finishAnswer: [200, record] });
  const dir = newDir();
  await register(dir, opts(p.env));
  assert.deepEqual(await finish(dir, opts(p.env)), record);
  p.server.close();
  assert.deepEqual(p.seen.at(-1), { auth: `Bearer ${RUN_TOKEN}`, method: "DELETE" });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, USAGE_FILE), "utf8")), record);
  assert.equal(statSync(join(dir, USAGE_FILE)).mode & 0o777, 0o600);
});

test("finish without a registered run does nothing, and its failures say the token may be live", async () => {
  assert.equal(await finish(newDir(), opts({ PRAXIS_BASE_URL: "http://127.0.0.1:1/v1" })), null);
  const cases = [
    [[500, {}], /ending the praxis run failed: HTTP 500; its token may still be live/],
    [[200, { schema: RECORD_SCHEMA, state: "active" }], /still has the run active after ending it; its token may still be live/],
    [[200, { schema: "other/v1" }], /praxis returned other\/v1/],
  ];
  for (const [answer, want] of cases) {
    const p = await fakePraxis([201], { finishAnswer: answer });
    const dir = newDir();
    await register(dir, opts(p.env));
    await assert.rejects(finish(dir, opts(p.env)), want);
    p.server.close();
    assert.throws(() => statSync(join(dir, USAGE_FILE)));
  }
  // A broker that forgot the run (it restarted) answers 401: the token is
  // dead, and there is no record.
  {
    const p = await fakePraxis([201], { finishAnswer: [401, {}] });
    const dir = newDir();
    const lines = [];
    await register(dir, opts(p.env));
    assert.equal(await finish(dir, opts(p.env, lines)), null);
    p.server.close();
    assert.ok(lines.some((l) => /^::warning::praxis at .* doesn't know this run's token any more \(HTTP 401/.test(l)));
    assert.throws(() => statSync(join(dir, USAGE_FILE)));
  }
  const dir = newDir();
  const p = await fakePraxis([201]);
  await register(dir, opts(p.env));
  p.server.close();
  await assert.rejects(finish(dir, opts({ PRAXIS_BASE_URL: "http://127.0.0.1:1/v1" })),
    /can't reach praxis at http:\/\/127.0.0.1:1\/v1 to end the run .*may still be live/);
});
