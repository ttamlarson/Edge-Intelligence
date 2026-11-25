import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEdgeBreakoutSignal, sizeEdgeBreakoutPosition, getEdgeBreakoutExit } from "../edge-mtf-breakout-strategy.js";

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
  assert.equal(signal.risk.riskBudgetPct, 0.5);
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
  assert.equal(reversal.reason, "ATR_TRAILING_STOP");
  const timed = getEdgeBreakoutExit({
    entryPrice: 100, highestCompletedClose: 110, atr20: 2,
    fourHourClose: 105, dailyTrendBullish: true, ageDays: 30
  });
  assert.equal(timed.reason, "MAXIMUM_HOLDING_PERIOD");
});
