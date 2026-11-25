import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

test("CoinSpot sync retries empty full-day history with epoch seconds and records provider probes", async t => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/status")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (target.includes("/orders/market/completed")) {
      const body = JSON.parse(init.body || "{}");
      requests.push({ url: target, body });
      const coin = body.cointype;
      if (typeof body.startdate === "string") {
        return new Response(JSON.stringify({ status: "ok", buyorders: [], sellorders: [] }), { status: 200 });
      }
      const date = new Date(Number(body.startdate) * 1000).toISOString().slice(0, 10);
      const row = {
        market: coin + "/AUD",
        solddate: date + "T10:00:00.000Z",
        rate: coin === "BTC" ? 90000 : 2500,
        amount: 0.01,
        total: coin === "BTC" ? 900 : 25
      };
      return new Response(JSON.stringify({ status: "ok", buyorders: [row], sellorders: [] }), { status: 200 });
    }
    if (target.includes("/pubapi/v2/orders/completed/")) {
      const coin = target.includes("/btc/") ? "BTC" : "ETH";
      const row = {
        market: coin + "/AUD",
        solddate: "2026-11-25T10:15:00.000Z",
        rate: coin === "BTC" ? 90100 : 2510,
        amount: 0.02,
        total: coin === "BTC" ? 1802 : 50.2
      };
      return new Response(JSON.stringify({ status: "ok", buyorders: [row], sellorders: [] }), { status: 200 });
    }
    throw new Error("Unexpected CoinSpot probe URL: " + target);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const store = new Map();
  const env = {
    COINSPOT_READONLY_KEY: "test-readonly-key",
    COINSPOT_READONLY_SECRET: "test-readonly-secret",
    EDGE_KV: {
      get: async key => store.get(key) || null,
      put: async (key, value) => { store.set(key, value); }
    }
  };
  store.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode: "COINSPOT_AUD_RESEARCH_ONLY",
    startedAt: "2026-11-24T00:00:00.000Z",
    nextDate: "2026-11-24",
    markets: {},
    liveTradingEnabled: false
  }));

  const result = await __test.syncCoinSpotMtfHistory(env, new Date("2026-11-25T12:00:00.000Z"));
  assert.equal(result.status, "BACKFILLING");
  assert.equal(result.markets.length, 2);
  assert.equal(result.markets[0].tradeCount, 1);
  assert.equal(result.markets[0].dateFormatFallbackHits, 1);
  assert.ok(requests.some(request => typeof request.body.startdate === "string"));
  assert.ok(requests.some(request => typeof request.body.startdate === "number"));
  assert.equal(result.providerProbe.readOnlyStatus, "AUTHENTICATED");
  assert.equal(result.providerProbe.markets[0].readOnlyHistory.validAudTrades, 1);
  assert.equal(result.providerProbe.markets[0].readOnlyHistory.partitionHistory.length, 2);
  assert.equal(result.providerProbe.markets[0].readOnlyHistory.partitionHistory[0].validAudTrades, 1);
  assert.equal(result.providerProbe.markets[0].readOnlyHistory.partitionHistory[1].outOfRangeTrades, 1);
  assert.equal(result.providerProbe.markets[0].publicHistory.validAudTrades, 1);

  const saved = JSON.parse(store.get("coinspot-mtf-history-global-v1"));
  assert.equal(saved.liveTradingEnabled, false);
  assert.equal(saved.markets.BTC.dailyCandles.length, 1);
  assert.equal(saved.markets.ETH.dailyCandles.length, 1);
  assert.ok(saved.providerProbe.checkedAt);
});
