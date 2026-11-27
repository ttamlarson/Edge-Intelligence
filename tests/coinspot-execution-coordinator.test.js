import test from "node:test";
import assert from "node:assert/strict";
import { CoinSpotExecutionCoordinator } from "../coinspot-execution-coordinator.js";

function makeCoordinator() {
  const data = new Map();
  const storage = {
    async transaction(fn) {
      return fn({
        get: async key => data.get(key),
        put: async (key, value) => data.set(key, structuredClone(value)),
        delete: async key => data.delete(key)
      });
    }
  };
  const ctx = { storage };
  const env = { EDGE_COORDINATOR_TOKEN: "unit-test-token" };
  const coordinator = new CoinSpotExecutionCoordinator(ctx, env);
  const call = (path, body = {}) => coordinator.fetch(new Request("https://do.internal" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-edge-coordinator-token": "unit-test-token" },
    body: JSON.stringify(body)
  }));
  const callInternal = (path, body = {}) => coordinator.fetch(new Request("https://do.internal" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
  return { call, callInternal, coordinator };
}

test("coordinator rejects unauthenticated requests and non-POST methods", async () => {
  const { coordinator } = makeCoordinator();
  const denied = await coordinator.fetch(new Request("https://do.internal/nonce", { method: "POST" }));
  assert.equal(denied.status, 403);
  const method = await coordinator.fetch(new Request("https://do.internal/nonce"));
  assert.equal(method.status, 405);
});

test("nonce allocation is strictly monotonic", async () => {
  const { call } = makeCoordinator();
  const a = await (await call("/nonce")).json();
  const b = await (await call("/nonce")).json();
  assert.ok(Number.isSafeInteger(a.nonce));
  assert.ok(b.nonce > a.nonce, "each allocation must exceed the previous nonce");
});

test("idempotency reservations replay safely and reject key reuse with changed intent", async () => {
  const { call } = makeCoordinator();
  const intent = { side: "BUY", coin: "BTC", amount: 0.0001, rate: 100000 };
  const first = await (await call("/idempotency/reserve", { key: "order-001", intent })).json();
  assert.equal(first.duplicate, false);
  assert.equal(first.record.state, "RESERVED");
  const replay = await (await call("/idempotency/reserve", { key: "order-001", intent })).json();
  assert.equal(replay.duplicate, true);
  const conflict = await call("/idempotency/reserve", { key: "order-001", intent: { ...intent, rate: 99000 } });
  assert.equal(conflict.status, 409);
});

test("paper sync lease serializes global history/ledger writes and only its owner can release", async () => {
  const { callInternal } = makeCoordinator();
  const leaseA = "11111111-1111-4111-8111-111111111111";
  const leaseB = "22222222-2222-4222-8222-222222222222";
  const first = await callInternal("/paper-sync/acquire", { leaseId: leaseA });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).acquired, true);

  const blocked = await callInternal("/paper-sync/acquire", { leaseId: leaseB });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).acquired, false);

  const wrongOwner = await callInternal("/paper-sync/release", { leaseId: leaseB });
  assert.equal(wrongOwner.status, 409);
  assert.equal((await wrongOwner.json()).conflict, true);

  const released = await callInternal("/paper-sync/release", { leaseId: leaseA });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).released, true);

  const retry = await callInternal("/paper-sync/acquire", { leaseId: leaseB });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).acquired, true);
});


test("paper sync lease remains exclusive beyond the provider retry envelope and expires before the next 20-minute cron boundary", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-11-27T10:00:00.000Z");
  Date.now = () => now;
  try {
    const { callInternal } = makeCoordinator();
    const leaseA = "33333333-3333-4333-8333-333333333333";
    const leaseB = "44444444-4444-4444-8444-444444444444";
    const acquired = await callInternal("/paper-sync/acquire", { leaseId: leaseA });
    assert.equal(acquired.status, 200);
    const lease = await acquired.json();
    assert.equal(lease.expiresAt, now + 19 * 60 * 1000);

    // A slow but bounded scan may still be active at the next 15-minute cron
    // interval; another writer must not take its lease.
    now += 15 * 60 * 1000;
    const stillHeld = await callInternal("/paper-sync/acquire", { leaseId: leaseB });
    assert.equal(stillHeld.status, 409);
    assert.equal((await stillHeld.json()).acquired, false);

    // A crashed invocation cannot block the engine permanently. Once the
    // lease expires, a new owner may acquire it, and the old owner cannot
    // release the successor's lease.
    now = lease.expiresAt + 1;
    const recovered = await callInternal("/paper-sync/acquire", { leaseId: leaseB });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).acquired, true);
    const staleRelease = await callInternal("/paper-sync/release", { leaseId: leaseA });
    assert.equal(staleRelease.status, 409);
    const released = await callInternal("/paper-sync/release", { leaseId: leaseB });
    assert.equal(released.status, 200);
    assert.equal((await released.json()).released, true);
  } finally {
    Date.now = originalNow;
  }
});

test("idempotency state transitions are explicit and terminal conflicts fail closed", async () => {
  const { call } = makeCoordinator();
  await call("/idempotency/reserve", { key: "order-002", intent: { side: "SELL", coin: "ETH", amount: 0.01, rate: 3000 } });
  const completed = await (await call("/idempotency/complete", { key: "order-002", state: "ACKNOWLEDGED" })).json();
  assert.equal(completed.record.state, "ACKNOWLEDGED");
  const conflict = await call("/idempotency/complete", { key: "order-002", state: "REJECTED" });
  assert.equal(conflict.status, 409);
  const missing = await call("/idempotency/complete", { key: "missing", state: "UNKNOWN" });
  assert.equal(missing.status, 404);
});
