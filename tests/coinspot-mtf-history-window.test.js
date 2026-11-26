import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = "2026-11-26T12:00:00.000Z";

function buildHistory(gapIndexes = [100]) {
  const start = Date.parse("2026-09-17T12:00:00.000Z");
  const fourHourCandles = [];
  const dailyTradeCounts = new Map();
  for (let index = 0; index < 420; index++) {
    if (gapIndexes.includes(index)) continue;
    const timestamp = new Date(start + index * FOUR_HOUR_MS).toISOString();
    const close = index === 419 ? 61450 : 50000 + index * 25;
    const day = timestamp.slice(0, 10);
    dailyTradeCounts.set(day, (dailyTradeCounts.get(day) || 0) + 5);
    fourHourCandles.push({
      timestamp, open: close - 50, high: close + 300, low: close - 300,
      close, volume: 100, tradeCount: 5
    });
  }
  const dailyCandles = Array.from({ length: 121 }, (_, index) => {
    const timestamp = new Date(Date.parse("2026-07-28T00:00:00.000Z") + index * DAY_MS).toISOString();
    const close = 41000 + index * 170;
    return {
      timestamp, open: close - 100, high: close + 400, low: close - 400,
      close, volume: 1000, tradeCount: dailyTradeCounts.get(timestamp.slice(0, 10)) || 0
    };
  });
  return { dailyCandles, fourHourCandles };
}

async function readStrategy(gaps) {
  const history = buildHistory(gaps);
  const state = {
    mode: "COINSPOT_AUD_RESEARCH_ONLY",
    status: "COLLECTING_LIVE_DAY",
    nextDate: "2026-11-26",
    lastSyncAt: NOW,
    lastBatch: [],
    liveTradingEnabled: false,
    markets: {
      BTC: { ...history, tradesFetched: 1000, lastHistoryDate: "2026-11-26" },
      ETH: { ...history, tradesFetched: 1000, lastHistoryDate: "2026-11-26" }
    }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "ok", prices: { bid: 61400, ask: 61460, last: 61430 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    return await __test.getCoinSpotMtfStrategy({
      EDGE_KV: { get: async () => JSON.stringify(state) }
    }, new Date(NOW));
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function readPaperSnapshot(gaps) {
  const history = buildHistory(gaps);
  const state = {
    mode: "COINSPOT_AUD_RESEARCH_ONLY",
    status: "COLLECTING_LIVE_DAY",
    nextDate: "2026-11-26",
    lastSyncAt: NOW,
    lastBatch: [],
    liveTradingEnabled: false,
    markets: {
      BTC: { ...history, tradesFetched: 1000, lastHistoryDate: "2026-11-26" },
      ETH: { ...history, tradesFetched: 1000, lastHistoryDate: "2026-11-26" }
    }
  };
  const cache = new Map();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "ok", prices: { bid: 61400, ask: 61460, last: 61430 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    return await __test.runCoinSpotMtfPaper({
      EDGE_KV: {
        get: async key => key === "coinspot-mtf-history-global-v1" ? JSON.stringify(state) : cache.get(key) || null,
        put: async (key, value) => { cache.set(key, value); }
      }
    }, new Date(NOW), 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("warms EMA indicators with all validated four-hour history while keeping a separate 240-bar signal window", async () => {
  const snapshot = await readStrategy([100]);
  const btc = snapshot.markets.find(market => market.coin === "BTC");
  assert.equal(btc.history.signalWindowFourHourCandles, 240);
  assert.equal(btc.history.signalWindowConfirmedZeroTradeIntervals, 0);
  assert.equal(btc.history.indicatorFourHourHistoryMode, "FULL_VALIDATED_HISTORY");
  assert.equal(btc.history.indicatorFourHourCandles, 419);
  assert.equal(btc.history.indicatorFourHourGapCount, 1);
  assert.equal(btc.signal.indicators.fourHourActualCandles, 419);
  assert.equal(btc.signal.indicators.fourHourElapsedIntervals, 420);
  assert.equal(btc.signal.indicators.fourHourConfirmedZeroTradeIntervals, 1);
  assert.equal(btc.signal.status, "BUY_CANDIDATE_PAPER_ONLY");
  assert.equal(btc.liveTradingEnabled, false);
});

test("falls back to the clean 240-bar signal window when older indicator history has multiple confirmed gaps", async () => {
  const snapshot = await readStrategy([50, 100]);
  const btc = snapshot.markets.find(market => market.coin === "BTC");
  assert.equal(btc.history.signalWindowFourHourCandles, 240);
  assert.equal(btc.history.signalWindowConfirmedZeroTradeIntervals, 0);
  assert.equal(btc.history.indicatorFourHourHistoryMode, "SIGNAL_WINDOW_FALLBACK");
  assert.equal(btc.history.indicatorFourHourCandles, 240);
  assert.equal(btc.history.indicatorFourHourGapCount, 0);
  assert.equal(btc.signal.indicators.fourHourActualCandles, 240);
  assert.equal(btc.signal.status, "BUY_CANDIDATE_PAPER_ONLY");
  assert.equal(btc.liveTradingEnabled, false);
});


test("persists indicator warm-up diagnostics in the paper snapshot without enabling execution", async () => {
  const snapshot = await readPaperSnapshot([100]);
  const btc = snapshot.markets.find(market => market.pair === "BTC/AUD");
  assert.equal(btc.signalStatus, "AI_REVIEW_BLOCKED", "unconfigured AI must fail closed on a synthetic candidate");
  assert.equal(btc.signalWindowFourHourCandles, 240);
  assert.equal(btc.indicatorFourHourCandles, 419);
  assert.equal(btc.indicatorFourHourGapCount, 1);
  assert.equal(btc.indicatorFourHourHistoryMode, "FULL_VALIDATED_HISTORY");
  assert.equal(snapshot.paperOnly, true);
  assert.equal(snapshot.liveTradingEnabled, false);
  assert.equal(snapshot.openPosition, null);
  assert.equal(snapshot.cashAud, 100);
});
