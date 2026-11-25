import test from "node:test";
import assert from "node:assert/strict";
import { calculateAsxAiCalibration } from "../asx-ai-calibration.js";

function trade(index, probability, outcome, exitType = "AUTOMATED_PAPER_DAILY_BAR_EXIT") {
  const reviewedAt = new Date(Date.UTC(2026, 0, index + 1, 0)).toISOString();
  const openedAt = new Date(Date.UTC(2026, 0, index + 1, 1)).toISOString();
  const closedAt = new Date(Date.UTC(2026, 0, index + 2, 0)).toISOString();
  return {
    id: "trade-" + index, status: "CLOSED_PAPER", exitType,
    openedAt, closedAt, profitLossAud: outcome ? 10 : -8,
    aiReview: {
      status: "AI_APPROVED_PAPER_CANDIDATE", decision: "APPROVE",
      confidence: 82, predictedWinProbability: probability,
      riskFlags: [], model: "test-model", reviewId: "review-" + index, reviewedAt,
      inputProvenance: {
        source: "Synthetic test fixture only", currency: "AUD",
        fingerprint: String(index).padStart(64, "0")
      }
    }
  };
}

test("AI calibration uses a chronological holdout and reports Brier and reliability diagnostics", () => {
  const rows = Array.from({ length: 40 }, (_, i) => trade(i, 0.6, i % 2 === 0));
  const result = calculateAsxAiCalibration(rows, { holdoutFraction: 0.25, minimumOutOfSampleSamples: 5 });
  assert.equal(result.status, "EARLY_CALIBRATION_MONITORING");
  assert.equal(result.isCalibrated, false);
  assert.equal(result.trainedModel, false);
  assert.equal(result.trainingSampleCount, 30);
  assert.equal(result.outOfSampleSampleCount, 10);
  assert.equal(result.outOfSample.sampleCount, 10);
  assert.equal(typeof result.outOfSample.brierScore, "number");
  assert.equal(typeof result.outOfSample.expectedCalibrationError, "number");
  assert.equal(result.outOfSample.reliabilityBins.length > 0, true);
  assert.equal(result.outOfSampleWindow.firstClosedAt, rows[30].closedAt);
  assert.equal(result.interpretation.includes("not model training"), true);
});

test("AI calibration excludes manual exits, invalid provenance and duplicate review identifiers", () => {
  const valid = trade(0, 0.7, true);
  const manual = trade(1, 0.7, false, "MANUAL_PAPER_CLOSE");
  const invalid = trade(2, 0.7, true);
  invalid.aiReview.inputProvenance.fingerprint = "not-a-hash";
  const duplicate = trade(3, 0.7, true);
  duplicate.aiReview.reviewId = valid.aiReview.reviewId;
  const result = calculateAsxAiCalibration([valid, manual, invalid, duplicate], {
    holdoutFraction: 0.25, minimumOutOfSampleSamples: 2
  });
  assert.equal(result.totalEligibleTrades, 1);
  assert.equal(result.manualExitExcludedCount, 1);
  assert.equal(result.invalidReviewCount, 1);
  assert.equal(result.duplicateReviewCount, 1);
  assert.equal(result.status, "INSUFFICIENT_OUT_OF_SAMPLE_SAMPLE");
});

test("AI calibration never claims a result from a small or empty sample", () => {
  const result = calculateAsxAiCalibration([trade(0, 0.9, true), trade(1, 0.8, true)]);
  assert.equal(result.status, "INSUFFICIENT_OUT_OF_SAMPLE_SAMPLE");
  assert.equal(result.isCalibrated, false);
  assert.equal(result.outOfSampleSampleCount, 1);
  const empty = calculateAsxAiCalibration([]);
  assert.equal(empty.status, "INSUFFICIENT_OUT_OF_SAMPLE_SAMPLE");
  assert.equal(empty.isCalibrated, false);
});
