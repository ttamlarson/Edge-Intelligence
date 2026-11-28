import test from "node:test";
import assert from "node:assert/strict";
import worker from "../index.js";

const OPERATOR_EMAIL = "operator@example.com";
const limiter = () => ({ limit: async () => ({ success: true }) });
const kv = () => ({ get: async () => null, put: async () => {} });
const identity = email => ({ access: { getIdentity: async () => ({ id: "access-subject", email }) } });
const env = extra => ({
  COINSPOT_MTF_OPERATOR_EMAIL: OPERATOR_EMAIL,
  EDGE_KV: kv(),
  DATA_LIMITER: limiter(),
  WRITE_LIMITER: limiter(),
  ...extra
});

test("deployment-wide MTF ledger is fail-closed when operator email configuration is missing", async () => {
  const response = await worker.fetch(
    new Request("https://api.example.au/api/crypto/coinspot/mtf-paper"),
    env({ COINSPOT_MTF_OPERATOR_EMAIL: "" }),
    identity(OPERATOR_EMAIL)
  );
  assert.equal(response.status, 403);
});

test("deployment-wide MTF ledger rejects missing and non-operator Access emails", async () => {
  for (const email of [undefined, "", "another-user@example.com"]) {
    const response = await worker.fetch(
      new Request("https://api.example.au/api/crypto/coinspot/mtf-paper"),
      env(),
      identity(email)
    );
    assert.equal(response.status, 403);
  }
});

test("only the configured operator can read the global AUD paper ledger", async () => {
  const response = await worker.fetch(
    new Request("https://api.example.au/api/crypto/coinspot/mtf-paper"),
    env(),
    identity("OPERATOR@example.com")
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.startingCapitalAud, 100);
  assert.equal(body.currency, "AUD");
  assert.equal(body.paperOnly, true);
  assert.equal(body.liveTradingEnabled, false);
});

test("global strategy, sync and private CoinSpot account routes reject other Access identities", async () => {
  const routes = [
    ["GET", "/api/crypto/coinspot/strategy"],
    ["POST", "/api/crypto/coinspot/strategy/sync"],
    ["GET", "/api/crypto/coinspot/readonly/status"],
    ["GET", "/api/coinspot/account"],
    ["POST", "/api/crypto/coinspot/mtf-paper"]
  ];
  for (const [method, path] of routes) {
    const response = await worker.fetch(
      new Request("https://api.example.au" + path, { method }),
      env(),
      identity("not-the-operator@example.com")
    );
    assert.equal(response.status, 403, path);
  }
});

test("the operator gate does not rewrite or migrate the persisted paper ledger", async () => {
  const response = await worker.fetch(
    new Request("https://api.example.au/api/crypto/coinspot/mtf-paper"),
    env({ EDGE_KV: { get: async () => null, put: async () => { throw new Error("read-only test KV"); } } }),
    identity(OPERATOR_EMAIL)
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.paperOnly, true);
  assert.equal(body.liveTradingEnabled, false);
});
