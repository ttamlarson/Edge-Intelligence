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


test("CoinSpot live-day refresh replaces per-date trade counts instead of inflating history totals", async () => {
  const kv = kvStore();
  const now = "2026-11-25T16:00:00.000Z";
  const variants = [{ format: "epoch" }, { format: "epoch-string" }, { format: "epoch-ms" }];
  const probeMarket = coin => ({ coin, readOnlyHistory: { partitionHistory: [{ variants }, { variants }] } });
  kv.values.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode: "COINSPOT_AUD_RESEARCH_ONLY", status: "COLLECTING_LIVE_DAY", startedAt: now,
    nextDate: "2026-11-25", lastProcessedDate: "2026-11-24",
    markets: {
      BTC: { dailyCandles: [], fourHourCandles: [], tradesFetched: 10 },
      ETH: { dailyCandles: [], fourHourCandles: [], tradesFetched: 20 }
    },
    providerProbe: { checkedAt: now, readOnlyStatus: "AUTHENTICATED", markets: [probeMarket("BTC"), probeMarket("ETH")] },
    lastProviderProbeAt: now, liveTradingEnabled: false
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.endsWith("/orders/market/completed")) throw new Error("Unexpected CoinSpot request: " + target);
    const body = JSON.parse(options.body || "{}");
    const coin = body.cointype, price = coin === "BTC" ? 90000 : 2500;
    const start = Date.parse(body.startdate + "T00:00:00.000Z");
    const row = (offset, rate, amount) => ({
      market: coin + "/AUD", solddate: new Date(start + offset).toISOString(),
      rate, amount, total: rate * amount
    });
    return new Response(JSON.stringify({
      status: "ok", buyorders: [row(3600000, price, 0.01)],
      sellorders: [row(7200000, price + 1, 0.02)]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const env = { EDGE_KV: kv.binding, COINSPOT_READONLY_KEY: "test-readonly-key", COINSPOT_READONLY_SECRET: "test-readonly-secret" };
    const first = await __test.syncCoinSpotMtfHistory(env, now);
    assert.equal(first.status, "COLLECTING_LIVE_DAY");
    let history = JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
    assert.equal(history.nextDate, "2026-11-25");
    assert.equal(history.markets.BTC.tradesFetched, 12);
    assert.equal(history.markets.ETH.tradesFetched, 22);
    assert.equal(history.markets.BTC.tradesFetchedByDate["2026-11-25"], 2);
    assert.equal(history.markets.BTC.tradesFetchedBase, 10);
    const second = await __test.syncCoinSpotMtfHistory(env, "2026-11-25T16:15:00.000Z");
    assert.equal(second.status, "COLLECTING_LIVE_DAY");
    history = JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
    assert.equal(history.markets.BTC.tradesFetched, 12);
    assert.equal(history.markets.ETH.tradesFetched, 22);
    assert.equal(history.markets.BTC.tradesFetchedByDate["2026-11-25"], 2);
    assert.equal(history.markets.ETH.tradesFetchedByDate["2026-11-25"], 2);
    assert.equal(history.liveTradingEnabled, false);
  } finally { globalThis.fetch = originalFetch; }
});
