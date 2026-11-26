import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEdgeBreakoutSignal, sizeEdgeBreakoutPosition, getEdgeBreakoutExit, latestContiguousCandleRun } from "../edge-mtf-breakout-strategy.js";

function fixtures() {
  const dailyCandles = Array.from({ length: 120 }, (_, index) => {
    const close = 100 + index * 0.5;
    return {
      timestamp: new Date(Date.UTC(2025, 0, 1 + index)).toISOString(),
      open: close - 0.1, high: close + 0.3, low: close - 0.3,
      close, volume: 1000
    };
  });
  const fourHourCandles = Array.from({ length: 220 }, (_, index) => {
    const close = 200 + index * 0.1 + (index === 219 ? 2 : 0);
    return {
      timestamp: new Date(Date.UTC(2025, 3, 1) + index * 4 * 3600000).toISOString(),
      open: close - 0.1, high: close + 0.3, low: close - 0.3,
      close, volume: 100
    };
  });
  return { dailyCandles, fourHourCandles };
}

test("multi-timeframe breakout requires completed daily and four-hour candles", () => {
  const { dailyCandles, fourHourCandles } = fixtures();
  const asOf = Date.parse(fourHourCandles.at(-1).timestamp) + 4 * 3600000;
  const signal = evaluateEdgeBreakoutSignal({ dailyCandles, fourHourCandles, asOf, spreadBps: 10 });
  assert.equal(signal.strategy, "EDGE_MTF_DONCHIAN_ENSEMBLE_V1");
  assert.equal(signal.status, "BUY_CANDIDATE_PAPER_ONLY");
  assert.equal(signal.execution.orderIntent, "NONE");
  assert.equal(signal.execution.liveTradingEnabled, false);
  assert.equal(signal.indicators.breakoutVotes, 3);
  assert.equal(signal.entryModel, "DONCHIAN_BREAKOUT");
  assert.equal(signal.checks.entryTrigger, true);
  assert.equal(signal.risk.riskBudgetPct, 0.5);
});

test("bullish four-hour EMA20 reclaim creates a pullback entry without a Donchian breakout", () => {
  const { dailyCandles, fourHourCandles } = fixtures();
  fourHourCandles[218] = {
    ...fourHourCandles[218], open: 221.7, high: 221.8, low: 219.8, close: 220
  };
  fourHourCandles[219] = {
    ...fourHourCandles[219], open: 220.1, high: 221.3, low: 220, close: 221.2
  };
  const asOf = Date.parse(fourHourCandles.at(-1).timestamp) + 4 * 3600000;
  const signal = evaluateEdgeBreakoutSignal({ dailyCandles, fourHourCandles, asOf, spreadBps: 10 });
  assert.equal(signal.indicators.breakoutVotes, 0);
  assert.equal(signal.checks.breakoutVotes, false);
  assert.equal(signal.checks.pullbackReclaim, true);
  assert.equal(signal.checks.entryTrigger, true);
  assert.equal(signal.entryModel, "PULLBACK_RECLAIM");
  assert.equal(signal.status, "BUY_CANDIDATE_PAPER_ONLY");
});

test("a bullish regime without a breakout or pullback reclaim does not create an entry", () => {
  const { dailyCandles, fourHourCandles } = fixtures();
  const last = fourHourCandles.at(-1);
  last.open -= 2;
  last.high -= 2;
  last.low -= 2;
  last.close -= 2;
  const asOf = Date.parse(last.timestamp) + 4 * 3600000;
  const signal = evaluateEdgeBreakoutSignal({ dailyCandles, fourHourCandles, asOf, spreadBps: 10 });
  assert.equal(signal.checks.dailyTrend, true);
  assert.equal(signal.checks.fourHourTrend, true);
  assert.equal(signal.checks.entryTrigger, false);
  assert.equal(signal.status, "NO_TRADE");
});


test("pullback trigger diagnostics do not imply an entry when the daily regime is bearish", () => {
  const { dailyCandles, fourHourCandles } = fixtures();
  const daily = dailyCandles.map(candle => ({ ...candle }));
  const lastDaily = daily.at(-1);
  lastDaily.open = 1;
  lastDaily.high = 1.1;
  lastDaily.low = 0.9;
  lastDaily.close = 1;
  fourHourCandles[218] = {
    ...fourHourCandles[218], open: 221.7, high: 221.8, low: 219.8, close: 220
  };
  fourHourCandles[219] = {
    ...fourHourCandles[219], open: 220.1, high: 221.3, low: 220, close: 221.2
  };
  const asOf = Date.parse(fourHourCandles.at(-1).timestamp) + 4 * 3600000;
  const signal = evaluateEdgeBreakoutSignal({ dailyCandles: daily, fourHourCandles, asOf, spreadBps: 10 });
  assert.equal(signal.checks.pullbackReclaim, true);
  assert.equal(signal.checks.entryTrigger, true);
  assert.equal(signal.checks.dailyTrend, false);
  assert.equal(signal.status, "NO_TRADE");
  assert.equal(signal.entryModel, null);
  assert.equal(signal.triggerModel, "PULLBACK_RECLAIM");
  assert.ok(signal.failedChecks.includes("dailyTrend"));
});

test("signal rejects incomplete candles and broken chronological series", () => {
  const { dailyCandles, fourHourCandles } = fixtures();
  const latest = Date.parse(fourHourCandles.at(-1).timestamp);
  assert.throws(() => evaluateEdgeBreakoutSignal({ dailyCandles, fourHourCandles, asOf: latest + 1000 }), /incomplete/i);
  const gap = fourHourCandles.map(candle => ({ ...candle }));
  gap[100].timestamp = new Date(Date.parse(gap[100].timestamp) + 3600000).toISOString();
  assert.throws(() => evaluateEdgeBreakoutSignal({
    dailyCandles, fourHourCandles: gap, asOf: latest + 4 * 3600000
  }), /non-contiguous/i);
});

test("spread, liquidity and bearish regime filters fail closed", () => {
  const { dailyCandles, fourHourCandles } = fixtures();
  const asOf = Date.parse(fourHourCandles.at(-1).timestamp) + 4 * 3600000;
  const wide = evaluateEdgeBreakoutSignal({ dailyCandles, fourHourCandles, asOf, spreadBps: 51 });
  assert.equal(wide.status, "NO_TRADE");
  assert.equal(wide.checks.liquidity, false);
  const thin = evaluateEdgeBreakoutSignal({ dailyCandles, fourHourCandles: fourHourCandles.map(c => ({ ...c, volume: 0 })), asOf, minimumVolume: 1 });
  assert.equal(thin.status, "NO_TRADE");
  assert.equal(thin.checks.liquidity, false);
  const bearish = dailyCandles.map(c => ({ ...c }));
  bearish[bearish.length - 1].close = 1;
  bearish[bearish.length - 1].low = 0.9;
  bearish[bearish.length - 1].open = 1;
  bearish[bearish.length - 1].high = 1.1;
  const noTrend = evaluateEdgeBreakoutSignal({ dailyCandles: bearish, fourHourCandles, asOf });
  assert.equal(noTrend.checks.dailyTrend, false);
  assert.equal(noTrend.status, "NO_TRADE");
  assert.equal(noTrend.entryModel, null, "a blocked trigger must not be labelled as an entry");
  assert.equal(noTrend.triggerModel, "DONCHIAN_BREAKOUT", "retain the trigger for diagnostics");
  assert.ok(noTrend.failedChecks.includes("dailyTrend"));
});

test("position sizing obeys both risk and allocation caps", () => {
  const size = sizeEdgeBreakoutPosition({ equity: 100, entryPrice: 1000, atr20: 10 });
  assert.equal(size.liveTradingEnabled, false);
  assert.ok(size.notional <= 25);
  assert.ok(size.estimatedStopRisk <= 0.5);
  assert.ok(size.stopPrice < 1000);
  assert.throws(() => sizeEdgeBreakoutPosition({ equity: 100, entryPrice: 1000, atr20: 10, riskPct: 0.02 }));
});

test("exit helper applies trailing stop, daily reversal and maximum holding period", () => {
  const trailing = getEdgeBreakoutExit({
    entryPrice: 100, highestCompletedClose: 130, atr20: 5,
    fourHourClose: 110, dailyTrendBullish: true, ageDays: 2
  });
  assert.equal(trailing.shouldExit, true);
  assert.equal(trailing.reason, "ATR_TRAILING_STOP");
  const reversal = getEdgeBreakoutExit({
    entryPrice: 100, highestCompletedClose: 100, atr20: 2,
    fourHourClose: 99, dailyTrendBullish: false, ageDays: 1
  });
  assert.equal(reversal.reason, "DAILY_TREND_REVERSAL");
  const timed = getEdgeBreakoutExit({
    entryPrice: 100, highestCompletedClose: 110, atr20: 2,
    fourHourClose: 105, dailyTrendBullish: true, ageDays: 30
  });
  assert.equal(timed.reason, "MAXIMUM_HOLDING_PERIOD");
});


test("latest contiguous candle run reports gaps without fabricating missing bars", () => {
  const { fourHourCandles } = fixtures();
  const gapBars = fourHourCandles.map((candle, index) => ({
    ...candle,
    timestamp: new Date(Date.parse(candle.timestamp) + (index >= 100 ? 4 * 3600000 : 0)).toISOString()
  }));
  const result = latestContiguousCandleRun(gapBars, 4 * 3600000, "Four-hour history");
  assert.equal(result.totalCandles, 220);
  assert.equal(result.gapCount, 1);
  assert.equal(result.contiguousCandles, 120);
  assert.equal(result.latestGap.previousAt, fourHourCandles[99].timestamp);
  assert.equal(result.latestGap.nextAt, gapBars[100].timestamp);
  assert.equal(result.latestGap.missingIntervals, 1);
  assert.equal(result.candles.length, 120);
  assert.equal(result.candles[0].timestamp, gapBars[100].timestamp);
  assert.equal(result.candles.some(candle => candle.timestamp === new Date(Date.parse(fourHourCandles[99].timestamp) + 4 * 3600000).toISOString()), false);
});

test("latest contiguous candle run rejects duplicate, unordered, unaligned and malformed bars", () => {
  const { fourHourCandles } = fixtures();
  const duplicate = fourHourCandles.map(candle => ({ ...candle }));
  duplicate[100].timestamp = duplicate[99].timestamp;
  assert.throws(() => latestContiguousCandleRun(duplicate, 4 * 3600000), /unordered/i);
  const unaligned = fourHourCandles.map(candle => ({ ...candle }));
  unaligned[0].timestamp = new Date(Date.parse(unaligned[0].timestamp) + 3600000).toISOString();
  assert.throws(() => latestContiguousCandleRun(unaligned, 4 * 3600000), /unaligned/i);
  const malformed = fourHourCandles.map(candle => ({ ...candle }));
  malformed[10].close = 0;
  assert.throws(() => latestContiguousCandleRun(malformed, 4 * 3600000), /invalid/i);
});
