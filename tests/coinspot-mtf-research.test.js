import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

const FOUR_HOURS = 4 * 60 * 60 * 1000;

function fixtures() {
  const dailyCandles = Array.from({ length: 121 }, (_, i) => {
    const close = 100 + i * 0.2 + Math.sin(i * 0.4) * 0.1;
    return {
      timestamp: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      open: close - 0.05,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 1000,
      tradeCount: 60
    };
  });
  const fourHourCandles = Array.from({ length: 420 }, (_, i) => {
    const close = 200 + i * 0.02 + Math.sin(i * 0.7) * 0.1;
    return {
      timestamp: new Date(Date.UTC(2026, 1, 20) + i * FOUR_HOURS).toISOString(),
      open: close - 0.03,
      high: close + 0.12,
      low: close - 0.12,
      close,
      volume: 100,
      tradeCount: 10
    };
  });
  const now = Date.parse(fourHourCandles.at(-1).timestamp) + FOUR_HOURS;
  return { dailyCandles, fourHourCandles, now };
}

test("CoinSpot MTF walk-forward reconciles ETH zero-trade gaps and remains ledger-isolated", async () => {
  const { dailyCandles, fourHourCandles, now } = fixtures();
  const missingIndex = 390;
  const missingDay = fourHourCandles[missingIndex].timestamp.slice(0, 10);
  const ethDaily = dailyCandles.map(candle =>
    candle.timestamp.slice(0, 10) === missingDay ? { ...candle, tradeCount: 50 } : candle
  );
  const ethFourHour = fourHourCandles.filter((_, index) => index !== missingIndex);
  const state = {
    mode: "COINSPOT_AUD_RESEARCH_ONLY",
    status: "COLLECTING_LIVE_DAY",
    nextDate: "2026-05-01",
    liveTradingEnabled: false,
    markets: {
      BTC: { dailyCandles, fourHourCandles, tradesFetched: 1000 },
      ETH: { dailyCandles: ethDaily, fourHourCandles: ethFourHour, tradesFetched: 500 }
    }
  };
  let writes = 0;
  const env = {
    EDGE_KV: {
      async get(key) {
        return key === "coinspot-mtf-history-global-v1" ? JSON.stringify(state) : null;
      },
      async put() {
        writes++;
        throw new Error("Research must not mutate history or the paper ledger.");
      }
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "ok",
    prices: { bid: 100, ask: 100.1, last: 100.05 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const result = await __test.getCoinSpotMtfStrategy(env, new Date(now));
    assert.equal(result.markets.length, 2);
    const eth = result.markets.find(market => market.coin === "ETH");
    assert.ok(eth.shadowBacktest);
    assert.notEqual(eth.shadowBacktest.status, "INSUFFICIENT_HISTORY");
    assert.equal(eth.shadowBacktest.history.latestValidatedFourHourCandles, 419);
    assert.equal(eth.shadowBacktest.history.confirmedZeroTradeIntervals, 1);
    assert.equal(eth.shadowBacktest.summary.signalEvaluationErrors, 0);
    assert.equal(eth.shadowBacktest.execution.orderIntent, "NONE");
    assert.equal(eth.shadowBacktest.execution.eligibleForPaperLedger, false);
    assert.equal(eth.shadowBacktest.execution.liveTradingEnabled, false);
    assert.equal(eth.shadowBacktest.sourceVerification, "NOT_INDEPENDENTLY_VERIFIED");
    assert.equal(writes, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
