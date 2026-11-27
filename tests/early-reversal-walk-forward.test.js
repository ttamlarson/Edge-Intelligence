import test from "node:test";
import assert from "node:assert/strict";
import { walkForwardEarlyReversalShadow } from "../early-reversal-walk-forward.js";

function fixtures() {
  const dailyCandles = Array.from({ length: 150 }, (_, i) => {
    const close = 100 + i * 0.2 + Math.sin(i * 0.4) * 0.1;
    return {
      timestamp: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      open: close - 0.05, high: close + 0.2, low: close - 0.2, close, volume: 1000
    };
  });
  const fourHourCandles = Array.from({ length: 420 }, (_, i) => {
    const close = 200 + i * 0.02 + Math.sin(i * 0.7) * 0.1;
    return {
      timestamp: new Date(Date.UTC(2026, 1, 20) + i * 4 * 60 * 60 * 1000).toISOString(),
      open: close - 0.03, high: close + 0.12, low: close - 0.12, close, volume: 100
    };
  });
  const now = Date.parse(fourHourCandles.at(-1).timestamp) + 4 * 60 * 60 * 1000;
  return { dailyCandles, fourHourCandles, now };
}

test("early-reversal walk-forward uses chronological folds and conservative CoinSpot costs", () => {
  const { dailyCandles, fourHourCandles, now } = fixtures();
  const result = walkForwardEarlyReversalShadow({
    dailyCandles, fourHourCandles, market: "BTC/AUD", now
  });
  assert.equal(result.strategy, "EDGE_MTF_EARLY_REVERSAL_SHADOW_V1");
  assert.equal(result.source, "coinspot_readonly_completed_orders");
  assert.equal(result.costs.feeRate, 0.001);
  assert.equal(result.costs.slippageBps, 15);
  assert.equal(result.costs.spreadBps, 50);
  assert.equal(result.costs.executionCostBpsPerSide, 40);
  assert.equal(result.parameters.startingCapitalAud, 100);
  assert.equal(result.parameters.riskBudgetPct, 0.5);
  assert.equal(result.parameters.maxAllocationPct, 25);
  assert.equal(result.parameters.maxDailyLossAud, 3);
  assert.equal(result.folds.length, 3);
  assert.ok(result.folds.every(fold => fold.testBars >= 20));
  assert.equal(result.execution.orderIntent, "NONE");
  assert.equal(result.execution.paperOnly, true);
  assert.equal(result.execution.shadowOnly, true);
  assert.equal(result.execution.eligibleForPaperLedger, false);
  assert.equal(result.execution.liveTradingEnabled, false);
  assert.ok([
    "INSUFFICIENT_OUT_OF_SAMPLE_TRADES",
    "NOT_PROVEN_PROFITABLE",
    "RESEARCH_CANDIDATE"
  ].includes(result.status));
});

test("walk-forward refuses to bridge historical four-hour gaps or fabricate candles", () => {
  const { dailyCandles, fourHourCandles, now } = fixtures();
  const gap = fourHourCandles.filter((_, index) => index !== 300);
  const result = walkForwardEarlyReversalShadow({
    dailyCandles, fourHourCandles: gap, market: "BTC/AUD", now
  });
  assert.equal(result.status, "INSUFFICIENT_HISTORY");
  assert.ok(result.history.latestContiguousFourHourCandles < 270);
  assert.equal(result.folds.length, 0);
  assert.equal(result.execution.eligibleForPaperLedger, false);
});

test("walk-forward rejects future bars, daily gaps and spreads above the strategy ceiling", () => {
  const { dailyCandles, fourHourCandles, now } = fixtures();
  assert.throws(() => walkForwardEarlyReversalShadow({
    dailyCandles, fourHourCandles, market: "BTC/AUD",
    now: Date.parse(fourHourCandles.at(-1).timestamp) - 1
  }), /future-dated/i);
  const dailyGap = dailyCandles.filter((_, index) => index !== 50);
  assert.throws(() => walkForwardEarlyReversalShadow({
    dailyCandles: dailyGap, fourHourCandles, market: "BTC/AUD", now
  }), /daily walk-forward history must be contiguous/i);
  assert.throws(() => walkForwardEarlyReversalShadow({
    dailyCandles, fourHourCandles, market: "BTC/AUD", now, spreadBps: 50.01
  }), /invalid.*cost/i);
  const missingVolume = fourHourCandles.map(candle => ({ ...candle }));
  missingVolume[100].volume = null;
  assert.throws(() => walkForwardEarlyReversalShadow({
    dailyCandles, fourHourCandles: missingVolume, market: "BTC/AUD", now
  }), /invalid/i);
});

test("short ETH-like contiguous history remains research-only and cannot create paper positions", () => {
  const { dailyCandles, fourHourCandles, now } = fixtures();
  const result = walkForwardEarlyReversalShadow({
    dailyCandles,
    fourHourCandles: fourHourCandles.slice(-26),
    market: "ETH/AUD",
    now
  });
  assert.equal(result.status, "INSUFFICIENT_HISTORY");
  assert.equal(result.summary.assessment, "INSUFFICIENT_HISTORY");
  assert.equal(result.execution.orderIntent, "NONE");
  assert.equal(result.execution.eligibleForPaperLedger, false);
  assert.equal(result.execution.liveTradingEnabled, false);
});
