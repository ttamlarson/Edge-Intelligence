// Outcome diagnostics for AI-assisted ASX paper reviews.
// This is a chronological audit only: it does not train, tune or recalibrate a model.
const round4 = value => Math.round((value + Number.EPSILON) * 10000) / 10000;

function scoreRows(rows) {
  if (!rows.length) return {
    sampleCount: 0, observedWinRate: null, brierScore: null,
    baselineBrierScore: null, brierSkillScore: null,
    expectedCalibrationError: null, reliabilityBins: []
  };
  const observedWinRate = rows.reduce((sum, row) => sum + row.outcome, 0) / rows.length;
  const brierScore = rows.reduce((sum, row) => sum + Math.pow(row.predictedWinProbability - row.outcome, 2), 0) / rows.length;
  const baselineBrierScore = rows.reduce((sum, row) => sum + Math.pow(observedWinRate - row.outcome, 2), 0) / rows.length;
  const binCount = 5;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: index / binCount, upper: (index + 1) / binCount, rows: []
  }));
  for (const row of rows) {
    const index = Math.min(binCount - 1, Math.floor(row.predictedWinProbability * binCount));
    bins[index].rows.push(row);
  }
  let weightedGap = 0;
  const reliabilityBins = bins.filter(bin => bin.rows.length).map(bin => {
    const meanPredicted = bin.rows.reduce((sum, row) => sum + row.predictedWinProbability, 0) / bin.rows.length;
    const observed = bin.rows.reduce((sum, row) => sum + row.outcome, 0) / bin.rows.length;
    const absoluteGap = Math.abs(meanPredicted - observed);
    weightedGap += absoluteGap * bin.rows.length / rows.length;
    return {
      range: "[" + bin.lower.toFixed(1) + ", " + bin.upper.toFixed(1) + (bin.upper === 1 ? "]" : ")"),
      count: bin.rows.length,
      meanPredictedWinProbability: round4(meanPredicted),
      observedWinRate: round4(observed),
      absoluteCalibrationGap: round4(absoluteGap)
    };
  });
  return {
    sampleCount: rows.length,
    observedWinRate: round4(observedWinRate),
    brierScore: round4(brierScore),
    baselineBrierScore: round4(baselineBrierScore),
    brierSkillScore: baselineBrierScore > 0 ? round4(1 - brierScore / baselineBrierScore) : null,
    expectedCalibrationError: round4(weightedGap),
    reliabilityBins
  };
}

export function calculateAsxAiCalibration(closedTrades, {
  holdoutFraction = 0.3, minimumOutOfSampleSamples = 30
} = {}) {
  if (!Array.isArray(closedTrades) || !Number.isFinite(holdoutFraction) ||
      holdoutFraction < 0.2 || holdoutFraction > 0.5 ||
      !Number.isInteger(minimumOutOfSampleSamples) || minimumOutOfSampleSamples < 1) {
    return { status: "INVALID_CALIBRATION_INPUT", isCalibrated: false, trainedModel: false, sampleCount: 0 };
  }

  let manualExitExcludedCount = 0;
  let invalidReviewCount = 0;
  let duplicateReviewCount = 0;
  const seenReviewIds = new Set();
  const rows = [];
  for (const trade of closedTrades) {
    if (trade?.status !== "CLOSED_PAPER" || !trade.aiReview) continue;
    if (trade.exitType !== "AUTOMATED_PAPER_DAILY_BAR_EXIT") {
      manualExitExcludedCount++;
      continue;
    }
    const review = trade.aiReview;
    const reviewedAt = Date.parse(review.reviewedAt || "");
    const openedAt = Date.parse(trade.openedAt || "");
    const closedAt = Date.parse(trade.closedAt || "");
    const probability = review.predictedWinProbability;
    const provenance = review.inputProvenance;
    const valid = review.status === "AI_APPROVED_PAPER_CANDIDATE" &&
      review.decision === "APPROVE" && typeof review.reviewId === "string" &&
      review.reviewId.length > 0 && review.reviewId.length <= 200 &&
      typeof review.model === "string" && review.model.length > 0 &&
      Number.isFinite(review.confidence) && review.confidence >= 75 && review.confidence <= 100 &&
      Number.isFinite(probability) && probability >= 0 && probability <= 1 &&
      Array.isArray(review.riskFlags) && review.riskFlags.length === 0 &&
      provenance?.currency === "AUD" && typeof provenance.source === "string" && provenance.source.trim() &&
      /^[a-f0-9]{64}$/i.test(provenance.fingerprint || "") &&
      Number.isFinite(reviewedAt) && Number.isFinite(openedAt) && Number.isFinite(closedAt) &&
      reviewedAt <= openedAt && openedAt <= closedAt &&
      Number.isFinite(trade.profitLossAud);
    if (!valid) {
      invalidReviewCount++;
      continue;
    }
    if (seenReviewIds.has(review.reviewId)) {
      duplicateReviewCount++;
      continue;
    }
    seenReviewIds.add(review.reviewId);
    rows.push({
      reviewId: review.reviewId,
      model: review.model,
      source: provenance.source,
      reviewedAt,
      closedAt,
      confidence: review.confidence,
      predictedWinProbability: probability,
      outcome: trade.profitLossAud > 0 ? 1 : 0
    });
  }

  rows.sort((a, b) => a.closedAt - b.closedAt || a.reviewedAt - b.reviewedAt);
  const splitIndex = Math.floor(rows.length * (1 - holdoutFraction));
  const trainingRows = rows.slice(0, splitIndex);
  const outOfSampleRows = rows.slice(splitIndex);
  const training = scoreRows(trainingRows);
  const outOfSample = scoreRows(outOfSampleRows);
  const status = outOfSampleRows.length < minimumOutOfSampleSamples
    ? "INSUFFICIENT_OUT_OF_SAMPLE_SAMPLE"
    : outOfSampleRows.length < 100
      ? "EARLY_CALIBRATION_MONITORING"
      : "CALIBRATION_MONITORING_ONLY";

  return {
    status,
    isCalibrated: false,
    trainedModel: false,
    method: "CHRONOLOGICAL_HOLDOUT_RELIABILITY_DIAGNOSTICS_NO_FITTING",
    sampleBasis: "APPROVED_AI_REVIEWS_WITH_AUTOMATED_DAILY_BAR_EXITS_ONLY",
    totalEligibleTrades: rows.length,
    trainingSampleCount: trainingRows.length,
    outOfSampleSampleCount: outOfSampleRows.length,
    minimumOutOfSampleSamples,
    holdoutFraction,
    training,
    outOfSample,
    meanSubjectiveConfidencePct: outOfSampleRows.length
      ? round4(outOfSampleRows.reduce((sum, row) => sum + row.confidence, 0) / outOfSampleRows.length)
      : null,
    modelVersions: [...new Set(rows.map(row => row.model))].sort(),
    sourceLabels: [...new Set(rows.map(row => row.source))].sort(),
    manualExitExcludedCount,
    invalidReviewCount,
    duplicateReviewCount,
    trainingWindow: trainingRows.length ? {
      firstClosedAt: new Date(trainingRows[0].closedAt).toISOString(),
      lastClosedAt: new Date(trainingRows.at(-1).closedAt).toISOString()
    } : null,
    outOfSampleWindow: outOfSampleRows.length ? {
      firstClosedAt: new Date(outOfSampleRows[0].closedAt).toISOString(),
      lastClosedAt: new Date(outOfSampleRows.at(-1).closedAt).toISOString()
    } : null,
    interpretation: "Predicted win probability is an uncalibrated model estimate. The later chronological holdout is an outcome diagnostic, not model training, probability correction or evidence of future profitability. Only approved reviews with automated daily-bar exits are included; manual exits are excluded.",
    liveTradingEnabled: false
  };
}
