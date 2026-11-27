import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEarlyReversalShadow } from "../early-reversal-shadow.js";

function fixtures() {
  const dailyCandles = Array.from({ length: 120 }, (_, i) => {
    const close = 100 + i * 0.45 + Math.sin(i * 0.45) * 0.18;
    return { timestamp: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
      open: close - 0.08, high: close + 0.25, low: close - 0.25, close, volume: 1000 };
  });
  const fourHourCandles = Array.from({ length: 240 }, (_, i) => {
    const close = 200 + i * 0.055 + Math.sin(i * 0.72) * 0.42;
    return { timestamp: new Date(Date.UTC(2025, 3, 1) + i * 4 * 3600000).toISOString(),
      open: close - 0.04, high: close + 0.2, low: close - 0.2, close, volume: 100 };
  });
  const asOf = Date.parse(fourHourCandles.at(-1).timestamp) + 4 * 3600000;
  return { dailyCandles, fourHourCandles, asOf };
}

test("early-reversal shadow engine emits a strictly gated, paper-only candidate", () => {
  const { dailyCandles, fourHourCandles, asOf } = fixtures();
  const signal = evaluateEarlyReversalShadow({ dailyCandles, fourHourCandles, asOf, spreadBps: 10 });
  assert.equal(signal.strategy, "EDGE_MTF_EARLY_REVERSAL_SHADOW_V1");
  assert.equal(signal.execution.orderIntent, "NONE");
  assert.equal(signal.execution.paperOnly, true);
  assert.equal(signal.execution.shadowOnly, true);
  assert.equal(signal.execution.eligibleForPaperLedger, false);
  assert.equal(signal.execution.liveTradingEnabled, false);
  assert.ok(["SHADOW_CANDIDATE_PAPER_ONLY", "WATCH", "NO_SETUP"].includes(signal.status));
  assert.equal(signal.checks.liquidity, true);
  assert.equal(signal.checks.volatility, true);
});

test("wide spreads and missing volume block an otherwise improving shadow setup", () => {
  const { dailyCandles, fourHourCandles, asOf } = fixtures();
  const wide = evaluateEarlyReversalShadow({ dailyCandles, fourHourCandles, asOf, spreadBps: 50.01 });
  assert.equal(wide.checks.liquidity, false);
  assert.equal(wide.execution.eligibleForPaperLedger, false);
  const thin = evaluateEarlyReversalShadow({
    dailyCandles, fourHourCandles: fourHourCandles.map(c => ({ ...c, volume: 0 })),
    asOf, spreadBps: 10, minimumVolume: 1
  });
  assert.equal(thin.checks.liquidity, false);
  assert.notEqual(thin.status, "SHADOW_CANDIDATE_PAPER_ONLY");
});

test("shadow engine rejects incomplete, future, misaligned and gapped candle history", () => {
  const { dailyCandles, fourHourCandles, asOf } = fixtures();
  assert.throws(() => evaluateEarlyReversalShadow({
    dailyCandles, fourHourCandles, asOf: asOf - 1
  }), /closed/i);
  const gap = fourHourCandles.filter((_, index) => index !== 100);
  assert.throws(() => evaluateEarlyReversalShadow({ dailyCandles, fourHourCandles: gap, asOf }), /contiguous/i);
  const malformed = dailyCandles.map(c => ({ ...c }));
  malformed[10].close = 0;
  assert.throws(() => evaluateEarlyReversalShadow({ dailyCandles: malformed, fourHourCandles, asOf }), /invalid/i);
});

test("shadow risk references the same conservative ATR stop envelope and never authorises orders", () => {
  const { dailyCandles, fourHourCandles, asOf } = fixtures();
  const signal = evaluateEarlyReversalShadow({ dailyCandles, fourHourCandles, asOf, spreadBps: 10 });
  assert.equal(signal.risk.initialStopAtr, 2.5);
  assert.equal(signal.risk.trailingStopAtr, 3);
  assert.equal(signal.risk.riskBudgetPct, 0.5);
  assert.equal(signal.risk.maximumNotionalAllocationPct, 25);
  assert.equal(signal.execution.orderIntent, "NONE");
  assert.equal(signal.execution.eligibleForPaperLedger, false);
});


test("one reconciled zero-trade interval is time-adjusted without fabricating a candle", () => {
  const { dailyCandles, fourHourCandles, asOf } = fixtures();
  const missing = fourHourCandles[100];
  const gap = fourHourCandles.filter((_, index) => index !== 100);
  const evidence = [{
    startAt: missing.timestamp,
    endAt: new Date(Date.parse(missing.timestamp) + 4 * 3600000).toISOString(),
    status: "CONFIRMED_NO_TRADES"
  }];
  const signal = evaluateEarlyReversalShadow({
    dailyCandles, fourHourCandles: gap, confirmedZeroTradeIntervals: evidence,
    asOf, spreadBps: 10
  });
  assert.equal(signal.history.fourHourActualCandles, 239);
  assert.equal(signal.history.confirmedZeroTradeIntervals, 1);
  assert.equal(signal.history.fourHourEmaUsesElapsedTime, true);
  assert.equal(signal.execution.eligibleForPaperLedger, false);
  assert.equal(signal.execution.orderIntent, "NONE");
  assert.throws(() => evaluateEarlyReversalShadow({
    dailyCandles, fourHourCandles: gap,
    confirmedZeroTradeIntervals: [{ ...evidence[0], status: "UNVERIFIED_GAP" }],
    asOf, spreadBps: 10
  }), /zero-trade gap evidence/i);
  assert.throws(() => evaluateEarlyReversalShadow({
    dailyCandles, fourHourCandles: gap,
    confirmedZeroTradeIntervals: [{
      startAt: new Date(Date.parse(evidence[0].startAt) + 4 * 3600000).toISOString(),
      endAt: new Date(Date.parse(evidence[0].endAt) + 4 * 3600000).toISOString(),
      status: "CONFIRMED_NO_TRADES"
    }],
    asOf, spreadBps: 10
  }), /contiguous/i);
});


test("shadow engine rejects missing OHLCV fields instead of treating null as zero", () => {
  const { dailyCandles, fourHourCandles, asOf } = fixtures();
  const missingVolume = fourHourCandles.map(candle => ({ ...candle }));
  missingVolume[100].volume = null;
  assert.throws(() => evaluateEarlyReversalShadow({
    dailyCandles, fourHourCandles: missingVolume, asOf, spreadBps: 10
  }), /invalid/i);
});


test("shadow engine time-adjusts multiple individually reconciled zero-trade intervals", () => {
  const { dailyCandles, fourHourCandles, asOf } = fixtures();
  const missingIndexes = [60, 160];
  const confirmedZeroTradeIntervals = missingIndexes.map(index => ({
    startAt: fourHourCandles[index].timestamp,
    endAt: new Date(Date.parse(fourHourCandles[index].timestamp) + 4 * 3600000).toISOString(),
    status: "CONFIRMED_NO_TRADES"
  }));
  const retained = fourHourCandles.filter((_, index) => !missingIndexes.includes(index));
  const signal = evaluateEarlyReversalShadow({
    dailyCandles,
    fourHourCandles: retained,
    confirmedZeroTradeIntervals,
    asOf,
    spreadBps: 10
  });
  assert.equal(signal.history.fourHourActualCandles, 238);
  assert.equal(signal.history.confirmedZeroTradeIntervals, 2);
  assert.equal(signal.history.fourHourEmaUsesElapsedTime, true);
  assert.equal(signal.execution.orderIntent, "NONE");
  assert.equal(signal.execution.eligibleForPaperLedger, false);
});
