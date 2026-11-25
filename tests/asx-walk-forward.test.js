import test from "node:test";
import assert from "node:assert/strict";
import { walkForwardAsxStrategy } from "../asx-walk-forward.js";
import { evaluateAsxSwingSetup } from "../autonomous-engine.js";

function makeBars(count = 210) {
  return Array.from({ length: count }, (_, index) => {
    const close = 10 + index * 0.03;
    const open = index === 0 ? close - 0.01 : 10 + (index - 1) * 0.03;
    return {
      timestamp: new Date(Date.UTC(2025, 0, 1 + index)).toISOString(),
      open, high: Math.max(open, close) + 0.01,
      low: Math.min(open, close) - 0.01,
      close
    };
  });
}

test("ASX walk-forward uses chronological prior history and next-session open entries", () => {
  const bars = makeBars();
  const result = walkForwardAsxStrategy({
    symbol: "BHP", bars, source: "Synthetic test fixture only",
    startingCapitalAud: 5000, costs: {
      commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0
    }
  });
  assert.equal(result.liveTradingEnabled, false);
  assert.equal(result.parameterPolicy, "FIXED_RULES_NO_FITTING");
  assert.equal(result.sourceVerification, "NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(result.folds.length, 3);
  assert.equal(result.folds[0].priorHistoryBars, Math.floor(bars.length * 0.6));
  assert.equal(result.folds[0].testStartAt, bars[Math.floor(bars.length * 0.6)].timestamp);
  assert.equal(result.summary.assessment, "INSUFFICIENT_OUT_OF_SAMPLE_TRADES");
  const firstTrade = result.folds.flatMap(fold => fold.trades)[0];
  if (firstTrade) {
    assert.equal(firstTrade.entryPrice, bars.find(bar => bar.timestamp === firstTrade.entryAt).open);
    assert.ok(Date.parse(firstTrade.signalAt) < Date.parse(firstTrade.entryAt));
  }
  assert.match(result.disclaimer, /not a trained predictive model/i);
});

test("ASX walk-forward rejects invalid, unordered, non-AUD and insufficient history", () => {
  const bars = makeBars();
  assert.throws(() => walkForwardAsxStrategy({ symbol: "BHP", bars: bars.slice(0, 100), source: "fixture" }), /150|51 prior bars/i);
  assert.throws(() => walkForwardAsxStrategy({ symbol: "BHP", bars, source: "fixture", currency: "USD" }), /AUD/i);
  const unordered = bars.slice();
  unordered[10] = { ...unordered[10], timestamp: unordered[9].timestamp };
  assert.throws(() => walkForwardAsxStrategy({ symbol: "BHP", bars: unordered, source: "fixture" }), /unordered/i);
});

test("ASX walk-forward uses fee-aware next-open sizing and does not relax deterministic controls", () => {
  const bars = makeBars();
  const noFees = walkForwardAsxStrategy({
    symbol: "BHP", bars, source: "Synthetic test fixture only",
    startingCapitalAud: 5000, costs: {
      commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0
    }
  });
  const withFees = walkForwardAsxStrategy({
    symbol: "BHP", bars, source: "Synthetic test fixture only",
    startingCapitalAud: 500, costs: {
      commissionRate: 0.0008, minimumCommissionAud: 5, gstRate: 0.1, slippageBps: 10
    }
  });
  assert.equal(withFees.startingCapitalAud, 500);
  assert.equal(withFees.liveTradingEnabled, false);
  assert.ok(withFees.folds.every(fold => fold.riskRejectCount >= 0));
  assert.ok(noFees.folds.every(fold => fold.trades.every(trade => trade.notionalAud <= 200)));
});


test("ASX walk-forward resolves same-bar stop/target ambiguity stop-first and gap-aware", () => {
  const bars = makeBars();
  const testStart = Math.floor(bars.length * 0.6);
  const signalIndex = testStart - 1;
  const noFees = { commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0 };
  const signalBar = bars[signalIndex];
  const candidate = evaluateAsxSwingSetup({
    symbol: "BHP", bars: bars.slice(0, signalIndex + 1),
    source: "Synthetic test fixture only", currency: "AUD",
    observedAt: signalBar.timestamp, equityAud: 5000, cashAud: 5000,
    openPositions: 0, now: Date.parse(signalBar.timestamp) + 10 * 60 * 60 * 1000,
    costs: noFees
  });
  assert.equal(candidate.status, "PAPER_CANDIDATE");
  const gapBarIndex = signalIndex + 2;
  const gapOpen = candidate.stopPrice - 0.05;
  bars[gapBarIndex] = {
    timestamp: bars[gapBarIndex].timestamp,
    open: gapOpen,
    high: candidate.targetPrice + 0.05,
    low: candidate.stopPrice - 0.1,
    close: candidate.stopPrice - 0.07
  };
  const result = walkForwardAsxStrategy({
    symbol: "BHP", bars, source: "Synthetic test fixture only",
    startingCapitalAud: 5000, costs: noFees
  });
  const firstTrade = result.folds[0].trades[0];
  assert.equal(firstTrade.exitPrice, gapOpen);
  assert.equal(firstTrade.exitReason, "STOP_FIRST_BOTH_TOUCHED_GAP_WORSE_OPEN");
});

test("ASX walk-forward does not let future bars change an earlier fold result", () => {
  const bars = makeBars();
  const first = walkForwardAsxStrategy({
    symbol: "BHP", bars, source: "Synthetic test fixture only",
    startingCapitalAud: 5000, costs: {
      commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0
    }
  });
  const changedFuture = bars.map(bar => ({ ...bar }));
  const testStart = Math.floor(bars.length * 0.6);
  const firstFoldEnd = testStart + Math.floor((bars.length - testStart) / 3);
  for (let i = firstFoldEnd; i < changedFuture.length; i++) {
    changedFuture[i] = {
      ...changedFuture[i],
      open: changedFuture[i].open * 1.5,
      high: changedFuture[i].high * 1.5,
      low: changedFuture[i].low * 1.5,
      close: changedFuture[i].close * 1.5
    };
  }
  const second = walkForwardAsxStrategy({
    symbol: "BHP", bars: changedFuture, source: "Synthetic test fixture only",
    startingCapitalAud: 5000, costs: {
      commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0
    }
  });
  assert.deepEqual(second.folds[0], first.folds[0]);
});


test("ASX walk-forward rejects future and unfinished current-session daily bars", () => {
  const bars = makeBars();
  bars[bars.length - 1] = {
    ...bars.at(-1), timestamp: "2026-11-25T00:00:00.000Z"
  };
  assert.throws(() => walkForwardAsxStrategy({
    symbol: "BHP", bars, source: "Synthetic test fixture only",
    now: Date.parse("2026-11-24T23:00:00.000Z")
  }), /future-dated/i);
  assert.throws(() => walkForwardAsxStrategy({
    symbol: "BHP", bars, source: "Synthetic test fixture only",
    now: Date.parse("2026-11-25T02:00:00.000Z")
  }), /incomplete/i);
  const completed = walkForwardAsxStrategy({
    symbol: "BHP", bars, source: "Synthetic test fixture only",
    now: Date.parse("2026-11-25T06:30:00.000Z"),
    startingCapitalAud: 5000, costs: {
      commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0
    }
  });
  assert.equal(completed.data.lastBarAt, "2026-11-25T00:00:00.000Z");
  assert.equal(completed.asOf, "2026-11-25T06:30:00.000Z");
});

test("ASX walk-forward excludes an unavailable buy-and-hold benchmark when no whole share fits", () => {
  const result = walkForwardAsxStrategy({
    symbol: "BHP", bars: makeBars(), source: "Synthetic test fixture only",
    startingCapitalAud: 100, costs: {
      commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0
    }
  });
  assert.ok(result.folds.every(fold => fold.benchmark.status === "NO_BENCHMARK_POSITION"));
  assert.ok(result.folds.every(fold => fold.benchmark.returnPct === null));
  assert.equal(result.summary.meanBenchmarkReturnPct, null);
});
