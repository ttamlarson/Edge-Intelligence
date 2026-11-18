import test from "node:test";
import assert from "node:assert/strict";
import { CoinSpotExecutionCoordinator } from "../coinspot-execution-coordinator.js";

function makeCoordinator() {
  const data = new Map();
  const storage = {
    async transaction(fn) {
      return fn({
        get: async key => data.get(key),
        put: async (key, value) => data.set(key, structuredClone(value))
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
  return { call, coordinator };
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
  assert.equal(b.nonce, a.nonce + 1);
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
