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

test("CoinSpot sub-day epoch-ms history fails closed when partition totals omit full-day trades", async () => {
  const kv = kvStore();
  const originalFetch = globalThis.fetch;
  const day = "2026-11-25";
  const dayStart = Date.parse(day + "T00:00:00.000Z");
  const epochMsRequests = [];
  const firstTrade = {
    market: "BTC/AUD", solddate: day + "T02:00:00.000Z",
    rate: 90000, amount: 0.01, total: 900
  };
  const secondTrade = {
    market: "BTC/AUD", solddate: day + "T14:00:00.000Z",
    rate: 90100, amount: 0.01, total: 901
  };

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/status")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (target.endsWith("/orders/market/completed")) {
      const body = JSON.parse(options.body || "{}");
      const coin = body.cointype;
      if (body.startdate === day) {
        return new Response(JSON.stringify({
          status: "ok",
          buyorders: coin === "BTC" ? [firstTrade] : [],
          sellorders: coin === "BTC" ? [secondTrade] : []
        }), { status: 200 });
      }
      if (typeof body.startdate === "number" && body.startdate > 1e12) {
        epochMsRequests.push({ coin, startdate: body.startdate });
        const rows = coin === "BTC" && body.startdate === dayStart ? [firstTrade] : [];
        return new Response(JSON.stringify({ status: "ok", buyorders: rows, sellorders: [] }), { status: 200 });
      }
      if (body.startdate === "2026-07-28") {
        const rows = Array.from({ length: 500 }, (_, index) => ({
          market: coin + "/AUD",
          solddate: new Date(Date.parse("2026-07-28T00:00:00.000Z") + (index + 1) * 1000).toISOString(),
          rate: coin === "BTC" ? 90000 : 2500,
          amount: 0.01,
          total: coin === "BTC" ? 900 : 25
        }));
        return new Response(JSON.stringify({ status: "ok", buyorders: rows, sellorders: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ok", buyorders: [], sellorders: [] }), { status: 200 });
    }
    if (target.includes("/pubapi/v2/orders/completed/")) {
      return new Response(JSON.stringify({ status: "ok", buyorders: [], sellorders: [] }), { status: 200 });
    }
    throw new Error("Unexpected CoinSpot URL: " + target);
  };

  try {
    await assert.rejects(
      () => __test.syncCoinSpotMtfHistory({
        EDGE_KV: kv.binding,
        COINSPOT_READONLY_KEY: "test-readonly-key",
        COINSPOT_READONLY_SECRET: "test-readonly-secret"
      }, "2026-11-25T12:00:00.000Z"),
      /COINSPOT_SUBDAY_EPOCH_MS_UNVERIFIED/
    );

    const history = JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
    const validation = history.providerProbe.markets[0].readOnlyHistory.partitionValidation;
    assert.equal(validation.version, 1);
    assert.equal(validation.status, "UNVERIFIED");
    assert.equal(validation.reason, "PARTITION_TRADE_COUNT_MISMATCH");
    assert.equal(validation.fullDayTradeCount, 2);
    assert.equal(validation.partitionTradeCount, 1);
    assert.equal(epochMsRequests.length, 4, "only provider-probe partitions may use epoch-ms");
    assert.equal(history.nextDate, "2026-07-28");
    assert.equal(history.pendingHistorySync.coins.BTC.windows.length, 2);
    assert.equal(history.markets.BTC?.dailyCandles?.length ?? 0, 0);
    assert.equal(history.liveTradingEnabled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
