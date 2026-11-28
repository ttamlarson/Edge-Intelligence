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

function validatedProbe(now) {
  const partitionHistory = Array.from({ length: 2 }, () => ({
    variants: [{ format: "epoch" }, { format: "epoch-string" }, { format: "epoch-ms" }]
  }));
  return {
    checkedAt: now,
    readOnlyStatus: "AUTHENTICATED",
    markets: ["BTC", "ETH"].map(coin => ({
      coin,
      pair: coin + "/AUD",
      readOnlyHistory: { partitionHistory }
    }))
  };
}

test("mixed valid and malformed CoinSpot AUD rows block the scan without advancing history or paper entries", async () => {
  const now = "2026-11-28T06:00:00.000Z";
  const targetDate = "2026-11-27";
  const kv = kvStore();
  kv.values.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode: "COINSPOT_AUD_RESEARCH_ONLY",
    status: "BACKFILLING",
    startedAt: now,
    nextDate: targetDate,
    lastProcessedDate: "2026-11-26",
    lastBatchDate: "2026-11-26",
    lastProviderProbeAt: now,
    providerProbe: validatedProbe(now),
    markets: {
      BTC: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0, tradesFetchedBase: 0, tradesFetchedByDate: {} },
      ETH: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0, tradesFetchedBase: 0, tradesFetchedByDate: {} }
    },
    liveTradingEnabled: false
  }));

  const originalFetch = globalThis.fetch;
  const historyRequests = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/api/v2/ro/orders/market/completed")) {
      const body = JSON.parse(options.body || "{}");
      historyRequests.push(body);
      if (body.cointype === "BTC") {
        return new Response(JSON.stringify({
          status: "ok",
          buyorders: [
            { market: "BTC/AUD", solddate: targetDate + "T01:00:00.000Z", rate: 90000, amount: 0.01, total: 900 },
            { market: "BTC/AUD", solddate: "not-a-timestamp", rate: 90000, amount: 0.01, total: 900 }
          ],
          sellorders: []
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ status: "ok", buyorders: [], sellorders: [] }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
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
    const snapshot = await __test.runCoinSpotMtfPaper({
      EDGE_KV: kv.binding,
      COINSPOT_READONLY_KEY: "test-readonly-key",
      COINSPOT_READONLY_SECRET: "test-readonly-secret"
    }, now, 1);

    assert.equal(historyRequests.length, 1);
    assert.equal(historyRequests[0].cointype, "BTC");
    assert.equal(historyRequests[0].markettype, "AUD");
    assert.equal(historyRequests[0].startdate, targetDate);
    assert.equal(snapshot.status, "DATA_OR_SYNC_WARNING");
    assert.match(snapshot.lastError, /COINSPOT_HISTORY_SCHEMA_MISMATCH/);
    assert.equal(snapshot.historySyncConsistency.status, "BLOCKED_SYNC_ERROR");
    assert.equal(snapshot.paperOnly, true);
    assert.equal(snapshot.liveTradingEnabled, false);
    assert.equal(snapshot.cashAud, 100);
    assert.equal(snapshot.equityAud, 100);
    assert.equal(snapshot.openPosition, null);
    assert.equal(snapshot.closedTrades.length, 0);
    assert.deepEqual(snapshot.lastCandidateRanking, []);
    assert.ok(snapshot.markets.every(market => market.signalStatus === "DATA_OR_SYNC_WARNING"));
    assert.ok(snapshot.markets.every(market => market.aiGateStatus === "NOT_REQUIRED"));

    const history = JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
    assert.equal(history.nextDate, targetDate);
    assert.equal(history.lastProcessedDate, "2026-11-26");
    assert.equal(history.liveTradingEnabled, false);
    assert.equal(history.markets.BTC.dailyCandles.length, 0);
    assert.equal(history.markets.BTC.fourHourCandles.length, 0);
    assert.equal(history.pendingHistorySync.coins.BTC.complete, false);
    assert.equal(history.pendingHistorySync.coins.BTC.trades.length, 0);
    assert.equal(history.pendingHistorySync.coins.BTC.windows.length, 1);

    const ledger = JSON.parse(kv.values.get("coinspot-mtf-paper-global-v1"));
    assert.equal(ledger.paperOnly, true);
    assert.equal(ledger.liveTradingEnabled, false);
    assert.equal(ledger.cashAud, 100);
    assert.equal(ledger.openPosition, null);
    assert.equal(ledger.closedTrades.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
