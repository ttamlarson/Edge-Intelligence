import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

function kvStore() {
  const values = new Map();
  return {
    values,
    binding: {
      get: async key => values.get(key) ?? null,
      put: async (key, value) => { values.set(key, value); }
    }
  };
}

test("CoinSpot MTF runner backfills four UTC dates per scan and remains paper-only", async () => {
  const kv = kvStore();
  const now = "2026-11-25T12:00:00.000Z";
  const probeMarket = coin => ({
    coin,
    readOnlyHistory: {
      partitionHistory: [
        { variants: [{ format: "epoch" }, { format: "epoch-string" }, { format: "epoch-ms" }] },
        { variants: [{ format: "epoch" }, { format: "epoch-string" }, { format: "epoch-ms" }] }
      ]
    }
  });
  kv.values.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode: "COINSPOT_AUD_RESEARCH_ONLY",
    status: "BACKFILLING",
    startedAt: now,
    nextDate: "2026-07-28",
    markets: {
      BTC: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 },
      ETH: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 }
    },
    providerProbe: {
      checkedAt: now,
      readOnlyStatus: "AUTHENTICATED",
      markets: [probeMarket("BTC"), probeMarket("ETH")]
    },
    lastProviderProbeAt: now,
    liveTradingEnabled: false
  }));

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ target, body });

    if (target.endsWith("/orders/market/completed")) {
      const coin = body.cointype;
      const day = String(body.startdate);
      const price = coin === "BTC" ? 90000 : 2500;
      return new Response(JSON.stringify({
        status: "ok",
        buyorders: [{
          market: coin + "/AUD",
          solddate: day + "T01:00:00.000Z",
          rate: price,
          amount: 0.01,
          total: price * 0.01
        }],
        sellorders: []
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (target.includes("/pubapi/v2/latest/")) {
      const coin = target.endsWith("/btc") ? "BTC" : "ETH";
      const price = coin === "BTC" ? 90000 : 2500;
      return new Response(JSON.stringify({
        status: "ok",
        prices: { bid: price, ask: price + 1, last: price + 0.5 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error("Unexpected CoinSpot request: " + target);
  };

  try {
    const result = await __test.runCoinSpotMtfPaper({
      EDGE_KV: kv.binding,
      COINSPOT_READONLY_KEY: "test-readonly-key",
      COINSPOT_READONLY_SECRET: "test-readonly-secret"
    }, now);

    assert.equal(result.backfillDaysRequested, 4);
    assert.equal(result.backfillDaysProcessed, 4);
    assert.equal(result.historyRequestBudgetThisScan, 20);
    assert.equal(result.providerProbeBudgetGuardApplied, false);
    assert.ok(result.historyRequestsThisScan <= result.historyRequestBudgetThisScan);
    assert.equal(result.historySync.processedDate, "2026-07-31");
    assert.equal(result.historySync.nextDate, "2026-08-01");
    assert.equal(result.status, "BACKFILLING");
    assert.equal(result.paperOnly, true);
    assert.equal(result.liveTradingEnabled, false);
    assert.equal(result.cashAud, 100);
    assert.equal(result.openPosition, null);
    assert.equal(result.closedTrades.length, 0);
    assert.ok(result.markets.every(market => market.signalStatus === "INSUFFICIENT_CONTIGUOUS_HISTORY_AFTER_GAP"));
    assert.ok(result.markets.every(market => market.contiguousFourHourCandles === 1));
    assert.ok(result.markets.every(market => market.fourHourGapCount === 3));
    assert.equal(calls.filter(call => call.target.endsWith("/orders/market/completed")).length, 8);
    assert.equal(calls.filter(call => call.target.includes("/pubapi/v2/latest/")).length, 2);

    const history = JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
    assert.equal(history.nextDate, "2026-08-01");
    assert.equal(history.liveTradingEnabled, false);
    for (const coin of ["BTC", "ETH"]) {
      assert.equal(history.markets[coin].dailyCandles.length, 4);
      assert.equal(history.markets[coin].fourHourCandles.length, 4);
    }

    const account = JSON.parse(kv.values.get("coinspot-mtf-paper-global-v1"));
    assert.equal(account.liveTradingEnabled, false);
    assert.equal(account.cashAud, 100);
    assert.equal(account.openPosition, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("paper runner reserves subrequest headroom when a provider partition probe is due", async () => {
  const kv = kvStore();
  const now = "2026-11-27T10:45:00.000Z";
  kv.values.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode: "COINSPOT_AUD_RESEARCH_ONLY",
    status: "BACKFILLING",
    startedAt: now,
    nextDate: "2026-07-28",
    markets: {
      BTC: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 },
      ETH: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 }
    },
    liveTradingEnabled: false
  }));

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, body: options.body ? JSON.parse(options.body) : {} });
    if (target.endsWith("/status")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (target.endsWith("/orders/market/completed")) {
      return new Response(JSON.stringify({ status: "ok", buyorders: [], sellorders: [] }), { status: 200 });
    }
    if (target.includes("/pubapi/v2/orders/completed/")) {
      return new Response(JSON.stringify({ status: "ok", buyorders: [], sellorders: [] }), { status: 200 });
    }
    if (target.includes("/pubapi/v2/latest/")) {
      return new Response(JSON.stringify({ status: "ok", prices: { bid: 100, ask: 101, last: 100.5 } }), { status: 200 });
    }
    throw new Error("Unexpected CoinSpot request: " + target);
  };

  try {
    const result = await __test.runCoinSpotMtfPaper({
      EDGE_KV: kv.binding,
      COINSPOT_READONLY_KEY: "test-readonly-key",
      COINSPOT_READONLY_SECRET: "test-readonly-secret"
    }, now, 4);
    assert.equal(result.providerProbeBudgetGuardApplied, true);
    assert.equal(result.historyRequestBudgetThisScan, 2);
    assert.equal(result.historyRequestsThisScan, 2);
    assert.equal(result.backfillDaysRequested, 4);
    assert.equal(result.backfillDaysProcessed, 0);
    assert.equal(result.historySync.providerProbePerformed, true);
    assert.equal(result.historySync.dateComplete, false);
    assert.equal(result.historySyncConsistency.status, "CONSISTENT_IN_MEMORY_SNAPSHOT");
    assert.equal(result.paperOnly, true);
    assert.equal(result.liveTradingEnabled, false);
    assert.equal(result.cashAud, 100);
    assert.equal(result.openPosition, null);
    assert.equal(result.closedTrades.length, 0);
    assert.ok(result.markets.every(market => market.quoteRetrievedAt === now));
    assert.equal(calls.filter(call => call.target.endsWith("/status")).length, 1);
    assert.equal(calls.filter(call => call.target.endsWith("/orders/market/completed")).length, 18);
    assert.equal(calls.filter(call => call.target.includes("/pubapi/v2/orders/completed/")).length, 2);
    assert.equal(calls.filter(call => call.target.includes("/pubapi/v2/latest/")).length, 2);
    assert.ok(calls.length < 50, "probe and history work must leave room for quotes and auth subrequests");

    const history = JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
    assert.equal(history.nextDate, "2026-07-28");
    assert.ok(history.pendingHistorySync);
    assert.equal(history.lastProviderProbeAt, now);
    assert.equal(history.liveTradingEnabled, false);
    const account = JSON.parse(kv.values.get("coinspot-mtf-paper-global-v1"));
    assert.equal(account.paperOnly, true);
    assert.equal(account.liveTradingEnabled, false);
    assert.equal(account.cashAud, 100);
    assert.equal(account.openPosition, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
