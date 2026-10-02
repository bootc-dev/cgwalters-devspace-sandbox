// Tests for scripts/egress-proxy.mjs: egress_denied from the access log.
// Run with: node --test agent/*.test.mjs scripts/*.test.mjs (just test)
import assert from "node:assert/strict";
import { test } from "node:test";
import { egressDenied } from "./egress-proxy.mjs";

const entry = (decision, host) => JSON.stringify({ decision, host, method: "POST", path: "/" });

test("egress_denied counts refusals per host, most first", () => {
  const log = [
    entry("deny", "b.example"), entry("allow", "a.example"), entry("deny", "a.example"),
    entry("deny", "b.example"), "not json", "", JSON.stringify({ decision: "deny" }), entry("deny", "c.example"),
  ].join("\n");
  assert.deepEqual(egressDenied(log), [
    { domain: "b.example", count: 2 }, { domain: "a.example", count: 1 }, { domain: "c.example", count: 1 },
  ]);
});

test("egress_denied of an empty log is empty", () => {
  assert.deepEqual(egressDenied(""), []);
});
