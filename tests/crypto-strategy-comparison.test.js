import test from "node:test";
import assert from "node:assert/strict";
import { buildCryptoStrategyComparison } from "../crypto-strategy-comparison.js";

const sample = (trades, pnl, profitFactor, drawdown) => ({
  trades, netPnlQuote: pnl, profitFactor, maxDrawdownPct: drawdown, winRatePct: 55,
  dateRange: { from: "2026-01-01T00:00:00.000Z", to: "2026-06-30T00:00:00.000Z" }
});

test("strategy comparison reports each available OOS variant with a common research screen", () => {
  const result = buildCryptoStrategyComparison({
    legacy: { outOfSample: sample(40, 5, 1.5, 8), assessment: "CANDIDATE_FOR_FORWARD_PAPER_REVIEW" },
    adaptive: {
      outOfSample: sample(12, 2, 1.4, 7),
      assessment: "INSUFFICIENT_OUT_OF_SAMPLE_TRADES",
      activeVariant: { outOfSample: sample(35, -1, 0.9, 12), assessment: "NOT_PROVEN_PROFITABLE" }
    },
    breakout: { outOfSample: sample(45, 3, 1.3, 9), assessment: "CANDIDATE_FOR_FORWARD_PAPER_TEST" },
    trendFollowing: {
      oneHour: { variants: [
        { id: "FULL_CONFLUENCE", outOfSample: sample(31, 4, 1.4, 7), assessment: "CANDIDATE_FOR_FORWARD_PAPER_TEST" },
        { id: "BALANCED_CONFIRMATION", outOfSample: sample(8, 1, 1.5, 5), assessment: "INSUFFICIENT_OUT_OF_SAMPLE_TRADES" }
      ] },
      fourHour: { variants: [
        { id: "FULL_CONFLUENCE", outOfSample: sample(33, 2, 1.25, 11), assessment: "NOT_PROVEN_PROFITABLE" },
        { id: "BALANCED_CONFIRMATION", outOfSample: sample(36, 1, 1.21, 9), assessment: "CANDIDATE_FOR_FORWARD_PAPER_TEST" }
      ] }
    }
  });
  assert.equal(result.status, "MULTI_STRATEGY_OOS_COMPARISON");
  assert.equal(result.strategyCount, 8);
  assert.equal(result.meetsCommonResearchScreenCount, 4);
  assert.equal(result.strategies[0].commonScreen, "MEETS_COMMON_RESEARCH_SCREEN");
  assert.equal(result.strategies[1].commonScreen, "INSUFFICIENT_OUT_OF_SAMPLE_TRADES");
  assert.equal(result.strategies[2].commonScreen, "DOES_NOT_MEET_COMMON_RESEARCH_SCREEN");
  assert.equal(result.strategies[5].timeframe, "1h");
  assert.equal(result.strategies[7].timeframe, "4h");
  assert.equal(result.sourceVerification, "NOT_INDEPENDENTLY_VERIFIED");
  assert.match(result.interpretation, /not a statistically matched head-to-head/i);
  assert.match(result.interpretation, /does not establish profitability/i);
});

test("comparison handles insufficient strategy history without inventing results", () => {
  const result = buildCryptoStrategyComparison({});
  assert.equal(result.status, "LIMITED_STRATEGY_OOS_COMPARISON");
  assert.equal(result.strategyCount, 0);
  assert.equal(result.meetsCommonResearchScreenCount, 0);
  assert.deepEqual(result.strategies, []);
});

test("comparison thresholds are validated", () => {
  assert.throws(() => buildCryptoStrategyComparison({ minimumOutOfSampleTrades: 0 }), /thresholds are invalid/i);
  assert.throws(() => buildCryptoStrategyComparison({ maximumDrawdownPct: 0 }), /thresholds are invalid/i);
});
