import test from "node:test";
import assert from "node:assert/strict";
import { validateCoinSpotLiveLimitOrder, signCoinSpotLivePayload, evaluateCoinSpotLiveRelease } from "../coinspot-live.js";

test("only BTC/AUD and ETH/AUD limit orders within AUD 10-25 are valid", () => {
  const buy = validateCoinSpotLiveLimitOrder({ side: "BUY", coin: "BTC", amount: 0.0001, rate: 100000 });
  assert.equal(buy.path, "/my/buy");
  assert.equal(buy.notionalAud, 10);
  const sell = validateCoinSpotLiveLimitOrder({ side: "SELL", coin: "ETH", amount: 0.005, rate: 5000 });
  assert.equal(sell.path, "/my/sell");
  assert.throws(() => validateCoinSpotLiveLimitOrder({ side: "BUY", coin: "DOGE", amount: 10, rate: 1 }));
  assert.throws(() => validateCoinSpotLiveLimitOrder({ side: "BUY", coin: "BTC", amount: 0.00026, rate: 100000 }));
  assert.throws(() => validateCoinSpotLiveLimitOrder({ side: "BUY", coin: "BTC", amount: 0.00001, rate: 100000 }));
  assert.throws(() => validateCoinSpotLiveLimitOrder({ side: "BUY", coin: "BTC", amount: 0.0001, rate: 100000.000000001 }));
});

test("CoinSpot signed request preparation uses HMAC-SHA512 and never sends a request", async () => {
  const signed = await signCoinSpotLivePayload({ key: "test-key", secret: "test-secret", payload: { cointype: "BTC" }, nonce: 123 });
  assert.match(signed.headers.sign, /^[a-f0-9]{128}$/);
  assert.equal(JSON.parse(signed.body).nonce, 123);
  assert.equal(signed.headers.key, "test-key");
  assert.equal(signed.url, "https://www.coinspot.com.au/api/v2");
  await assert.rejects(() => signCoinSpotLivePayload({ key: "", secret: "x", payload: {}, nonce: 1 }));
  await assert.rejects(() => signCoinSpotLivePayload({ key: "x", secret: "y", payload: {}, nonce: Number.MAX_SAFE_INTEGER + 1 }));
});

test("CoinSpot live release is blocked unless every independent gate is true", () => {
  const locked = evaluateCoinSpotLiveRelease();
  assert.equal(locked.allowed, false);
  assert.equal(locked.mode, "LIVE_EXECUTION_LOCKED");
  assert.equal(locked.withdrawalsEnabled, false);
  assert.equal(locked.transfersEnabled, false);
  assert.equal(evaluateCoinSpotLiveRelease({ enabled: true, strategyValidated: true, forwardPaperApproved: true, explicitActivation: true, durableCoordinatorReady: true, accountReconciled: true }).allowed, true);
});
