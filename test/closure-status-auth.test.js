import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index-phase-a-fix.js";

test("closure status rejects anonymous callers before touching D1", async () => {
  const DB = { prepare() { throw new Error("D1 must not be queried"); } };
  const response = await worker.fetch(
    new Request("https://example.test/api/phase-a-closure-status"),
    { DB, MANUAL_TRIGGER_TOKEN: "secret" },
    {}
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "Unauthorized" });
});

test("closure status fails closed when auth is not configured", async () => {
  const DB = { prepare() { throw new Error("D1 must not be queried"); } };
  const response = await worker.fetch(
    new Request("https://example.test/api/phase-a-closure-status"),
    { DB },
    {}
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "Manual trigger not configured" });
});
