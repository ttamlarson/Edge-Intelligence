import test from "node:test";
import assert from "node:assert/strict";
import { calculateAsxAiCalibration } from "../asx-ai-calibration.js";

function trade(index, probability, outcome, exitType = "AUTOMATED_PAPER_DAILY_BAR_EXIT") {
  const reviewedAt = new Date(Date.UTC(2026, 0, index + 1, 0)).toISOString();
  const openedAt = new Date(Date.UTC(2026, 0, index + 1, 1)).toISOString();
  const closedAt = new Date(Date.UTC(2026, 0, index + 2, 0)).toISOString();
  const fingerprint = String(index).padStart(64, "0");
  return {
    id: "trade-" + index, status: "CLOSED_PAPER", exitType,
    openedAt, closedAt, profitLossAud: outcome ? 10 : -8,
    aiReview: {
      status: "AI_APPROVED_PAPER_CANDIDATE", decision: "APPROVE",
      confidence: 82, predictedWinProbability: probability,
      riskFlags: [], model: "test-model",
      reviewId: "review-" + index + "-" + fingerprint, reviewedAt,
      inputProvenance: {
        source: "Synthetic test fixture only", sourceVerification: "NOT_INDEPENDENTLY_VERIFIED",
        currency: "AUD", observedAt: new Date(Date.parse(reviewedAt) - 3600000).toISOString(),
        barsProvided: 55, barsReviewed: 30, fingerprintAlgorithm: "SHA-256", fingerprint
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
  assert.equal(result.referenceSampleCount, 30);
  assert.equal(result.outOfSampleSampleCount, 10);
  assert.equal(result.outOfSample.sampleCount, 10);
  assert.equal(result.outOfSample.baselineProbability, 0.5);
  assert.equal(typeof result.outOfSample.brierScore, "number");
  assert.equal(typeof result.outOfSample.expectedCalibrationError, "number");
  assert.equal(result.outOfSample.reliabilityBins.length > 0, true);
  assert.ok(result.outOfSample.observedWinRateInterval95.lower <= result.outOfSample.observedWinRate);
  assert.ok(result.outOfSample.observedWinRateInterval95.upper >= result.outOfSample.observedWinRate);
  assert.ok(result.outOfSample.reliabilityBins.every(bin => bin.observedWinRateInterval95?.confidenceLevel === 0.95));
  assert.equal(result.confidenceBandDiagnostics.length, 1);
  assert.equal(result.confidenceBandDiagnostics[0].band, "80–89");
  assert.equal(result.confidenceBandDiagnostics[0].interpretation, "DESCRIPTIVE_OUTCOME_RATE_NOT_PROBABILITY_CALIBRATION");
  assert.match(result.confidenceInterpretation, /not calibrated probabilities/i);
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
  duplicate.aiReview.inputProvenance.fingerprint = valid.aiReview.inputProvenance.fingerprint;
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


test("AI holdout baseline is estimated only from earlier reference outcomes", () => {
  const rows = Array.from({ length: 40 }, (_, i) => trade(i, 0.6, i < 30));
  const result = calculateAsxAiCalibration(rows, {
    holdoutFraction: 0.25, minimumReferenceSamples: 30, minimumOutOfSampleSamples: 5
  });
  assert.equal(result.reference.observedWinRate, 1);
  assert.equal(result.outOfSample.observedWinRate, 0);
  assert.equal(result.outOfSample.baselineProbability, 1);
  assert.equal(result.outOfSample.baselineBrierScore, 1);
  assert.equal(result.outOfSample.brierScore, 0.36);
  assert.equal(result.outOfSample.brierSkillScore, 0.64);
});


test("AI calibration never pools outcomes across different model versions", () => {
  const rows = Array.from({ length: 40 }, (_, i) => {
    const row = trade(i, 0.6, i % 2 === 0);
    row.aiReview.model = i < 20 ? "model-a" : "model-b";
    return row;
  });
  const result = calculateAsxAiCalibration(rows, {
    holdoutFraction: 0.25, minimumReferenceSamples: 10, minimumOutOfSampleSamples: 5
  });
  assert.equal(result.status, "MIXED_MODEL_OR_REVIEW_POLICY_VERSIONS_SEPARATE_DIAGNOSTICS");
  assert.equal(result.outOfSample, null);
  assert.equal(result.outOfSampleSampleCount, 0);
  assert.equal(result.modelDiagnostics.length, 2);
  assert.deepEqual(result.modelDiagnostics.map(item => item.model), ["model-a", "model-b"]);
  assert.ok(result.modelDiagnostics.every(item => item.outOfSampleSampleCount === 5));
});


test("AI calibration separates review-policy versions even when the provider model is unchanged", () => {
  const rows = Array.from({ length: 40 }, (_, i) => {
    const row = trade(i, 0.6, i % 2 === 0);
    row.aiReview.reviewPolicyVersion = i < 20 ? "ASX_AI_REVIEW_V2" : "ASX_AI_REVIEW_V3";
    row.aiReview.requestStartedAt = row.aiReview.reviewedAt;
    Object.assign(row.aiReview.inputProvenance, {
      sourceMetadataVersion: 1,
      sourceUrl: "https://datacedar.com/markets/australia",
      retrievedAt: row.aiReview.reviewedAt,
      exchange: "ASX",
      timeframe: "1d",
      adjustment: "raw",
      dataClass: "historical_market_data_not_realtime",
      providerRowsForSymbol: 55
    });
    return row;
  });
  const result = calculateAsxAiCalibration(rows, {
    holdoutFraction: 0.25, minimumReferenceSamples: 10, minimumOutOfSampleSamples: 5
  });
  assert.equal(result.status, "MIXED_MODEL_OR_REVIEW_POLICY_VERSIONS_SEPARATE_DIAGNOSTICS");
  assert.equal(result.modelVersions.length, 1);
  assert.deepEqual(result.reviewPolicyVersions, ["ASX_AI_REVIEW_V2", "ASX_AI_REVIEW_V3"]);
  assert.equal(result.modelDiagnostics.length, 2);
  assert.deepEqual(result.modelDiagnostics.map(item => item.reviewPolicyVersion), ["ASX_AI_REVIEW_V2", "ASX_AI_REVIEW_V3"]);
  assert.equal(result.outOfSample, null);
});

test("subjective confidence bands remain descriptive and carry wide-sample uncertainty",()=>{
 const rows=Array.from({length:40},(_,i)=>trade(i,.6,i%2===0));
 rows.forEach((row,index)=>{row.aiReview.confidence=index<30?76:94;});
 const result=calculateAsxAiCalibration(rows,{holdoutFraction:.25,minimumOutOfSampleSamples:5});
 assert.equal(result.confidenceBandDiagnostics.length,1);
 assert.equal(result.confidenceBandDiagnostics[0].band,"90–100");
 assert.equal(result.confidenceBandDiagnostics[0].sampleCount,10);
 assert.ok(result.confidenceBandDiagnostics[0].observedWinRateInterval95.lower<=result.confidenceBandDiagnostics[0].observedWinRate);
 assert.ok(result.confidenceBandDiagnostics[0].observedWinRateInterval95.upper>=result.confidenceBandDiagnostics[0].observedWinRate);
 assert.equal(result.isCalibrated,false);
});
