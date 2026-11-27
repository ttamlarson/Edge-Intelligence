// Outcome diagnostics for AI-assisted ASX paper reviews.
// This is a chronological audit only: it does not train, tune or recalibrate a model.
const round4 = value => Math.round((value + Number.EPSILON) * 10000) / 10000;

function wilsonInterval(successes, sampleCount) {
  if (!Number.isInteger(sampleCount) || sampleCount < 1) return null;
  const z = 1.96;
  const probability = successes / sampleCount;
  const denominator = 1 + z * z / sampleCount;
  const center = (probability + z * z / (2 * sampleCount)) / denominator;
  const margin = z * Math.sqrt(
    probability * (1 - probability) / sampleCount +
    z * z / (4 * sampleCount * sampleCount)
  ) / denominator;
  return {
    lower: round4(Math.max(0, center - margin)),
    upper: round4(Math.min(1, center + margin)),
    confidenceLevel: 0.95
  };
}

function confidenceBandDiagnostics(rows) {
  const bands = [
    { label: "75–79", lower: 75, upper: 80 },
    { label: "80–89", lower: 80, upper: 90 },
    { label: "90–100", lower: 90, upper: 101 }
  ];
  return bands.map(band => {
    const selected = rows.filter(row => row.confidence >= band.lower && row.confidence < band.upper);
    if (!selected.length) return null;
    const wins = selected.reduce((sum, row) => sum + row.outcome, 0);
    return {
      band: band.label,
      sampleCount: selected.length,
      meanSubjectiveConfidencePct: round4(selected.reduce((sum, row) => sum + row.confidence, 0) / selected.length),
      observedWinRate: round4(wins / selected.length),
      observedWinRateInterval95: wilsonInterval(wins, selected.length),
      interpretation: "DESCRIPTIVE_OUTCOME_RATE_NOT_PROBABILITY_CALIBRATION"
    };
  }).filter(Boolean);
}

function scoreRows(rows, baselineProbability = null) {
  if (!rows.length) return {
    sampleCount: 0, observedWinRate: null, observedWinRateInterval95: null, brierScore: null,
    baselineProbability, baselineBrierScore: null, brierSkillScore: null,
    expectedCalibrationError: null, reliabilityBins: []
  };
  const wins = rows.reduce((sum, row) => sum + row.outcome, 0);
  const observedWinRate = wins / rows.length;
  const brierScore = rows.reduce((sum, row) => sum + Math.pow(row.predictedWinProbability - row.outcome, 2), 0) / rows.length;
  // The benchmark probability is estimated only from earlier reference outcomes.
  // Never use the holdout's own win rate to construct its comparison forecast.
  const baselineBrierScore = Number.isFinite(baselineProbability)
    ? rows.reduce((sum, row) => sum + Math.pow(baselineProbability - row.outcome, 2), 0) / rows.length
    : null;
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
    const binWins = bin.rows.reduce((sum, row) => sum + row.outcome, 0);
    const observed = binWins / bin.rows.length;
    const absoluteGap = Math.abs(meanPredicted - observed);
    weightedGap += absoluteGap * bin.rows.length / rows.length;
    return {
      range: "[" + bin.lower.toFixed(1) + ", " + bin.upper.toFixed(1) + (bin.upper === 1 ? "]" : ")"),
      count: bin.rows.length,
      meanPredictedWinProbability: round4(meanPredicted),
      observedWinRate: round4(observed),
      observedWinRateInterval95: wilsonInterval(binWins, bin.rows.length),
      absoluteCalibrationGap: round4(absoluteGap)
    };
  });
  return {
    sampleCount: rows.length,
    observedWinRate: round4(observedWinRate),
    observedWinRateInterval95: wilsonInterval(wins, rows.length),
    brierScore: round4(brierScore),
    baselineProbability: Number.isFinite(baselineProbability) ? round4(baselineProbability) : null,
    baselineBrierScore: baselineBrierScore === null ? null : round4(baselineBrierScore),
    brierSkillScore: baselineBrierScore > 0 ? round4(1 - brierScore / baselineBrierScore) : null,
    expectedCalibrationError: round4(weightedGap),
    reliabilityBins
  };
}

export function calculateAsxAiCalibration(closedTrades, {
  holdoutFraction = 0.3, minimumOutOfSampleSamples = 30, minimumReferenceSamples = 30
} = {}) {
  if (!Array.isArray(closedTrades) || !Number.isFinite(holdoutFraction) ||
      holdoutFraction < 0.2 || holdoutFraction > 0.5 ||
      !Number.isInteger(minimumOutOfSampleSamples) || minimumOutOfSampleSamples < 1 ||
      !Number.isInteger(minimumReferenceSamples) || minimumReferenceSamples < 1) {
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
    const fingerprint = provenance?.fingerprint;
    const policyVersion = typeof review.reviewPolicyVersion === "string" && review.reviewPolicyVersion.trim() && review.reviewPolicyVersion.length <= 80
      ? review.reviewPolicyVersion
      : "LEGACY_UNVERSIONED";
    let sourceUrl = null;
    try { sourceUrl = provenance?.sourceUrl ? new URL(provenance.sourceUrl) : null; } catch { sourceUrl = null; }
    const sourceMetadataValid = provenance?.sourceMetadataVersion === undefined ||
      (provenance.sourceMetadataVersion === 1 &&
        sourceUrl?.protocol === "https:" &&
        ["datacedar.com", "www.datacedar.com"].includes(sourceUrl.hostname) &&
        Number.isFinite(Date.parse(provenance.retrievedAt || "")) &&
        Date.parse(provenance.retrievedAt) >= Date.parse(provenance.observedAt || "") &&
        provenance.exchange === "ASX" && provenance.timeframe === "1d" &&
        provenance.adjustment === "raw" &&
        provenance.dataClass === "historical_market_data_not_realtime" &&
        Number.isInteger(provenance.providerRowsForSymbol) &&
        provenance.providerRowsForSymbol >= provenance.barsProvided);
    const valid = review.status === "AI_APPROVED_PAPER_CANDIDATE" &&
      (review.reviewPolicyVersion === undefined ? sourceMetadataValid : review.reviewPolicyVersion === policyVersion && sourceMetadataValid) &&
      review.decision === "APPROVE" && typeof review.reviewId === "string" &&
      review.reviewId.length > 0 && review.reviewId.length <= 200 &&
      typeof review.model === "string" && review.model.length > 0 &&
      Number.isFinite(review.confidence) && review.confidence >= 75 && review.confidence <= 100 &&
      Number.isFinite(probability) && probability >= 0 && probability <= 1 &&
      Array.isArray(review.riskFlags) && review.riskFlags.length === 0 &&
      provenance?.currency === "AUD" && typeof provenance.source === "string" && provenance.source.trim() &&
      provenance.sourceVerification === "NOT_INDEPENDENTLY_VERIFIED" &&
      provenance.fingerprintAlgorithm === "SHA-256" &&
      Number.isInteger(provenance.barsProvided) && provenance.barsProvided >= 51 &&
      provenance.barsReviewed === 30 &&
      /^[a-f0-9]{64}$/i.test(fingerprint || "") &&
      review.reviewId.endsWith(String(fingerprint).slice(0, 16)) &&
      Date.parse(provenance.observedAt || "") <= reviewedAt &&
      (review.requestStartedAt === undefined ||
        (Number.isFinite(Date.parse(review.requestStartedAt)) && Date.parse(review.requestStartedAt) <= reviewedAt)) &&
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
      policyVersion,
      source: provenance.source,
      reviewedAt,
      closedAt,
      confidence: review.confidence,
      predictedWinProbability: probability,
      outcome: trade.profitLossAud > 0 ? 1 : 0
    });
  }

  rows.sort((a, b) => a.closedAt - b.closedAt || a.reviewedAt - b.reviewedAt);
  const modelVersions = [...new Set(rows.map(row => row.model))].sort();
  const reviewPolicyVersions = [...new Set(rows.map(row => row.policyVersion))].sort();
  const modelGroups = [...new Set(rows.map(row => row.model + "\u0000" + row.policyVersion))].sort();
  const diagnoseModel = modelRows => {
    const splitIndex = Math.floor(modelRows.length * (1 - holdoutFraction));
    const referenceRows = modelRows.slice(0, splitIndex);
    const outOfSampleRows = modelRows.slice(splitIndex);
    const reference = scoreRows(referenceRows);
    const baselineProbability = referenceRows.length >= minimumReferenceSamples
      ? reference.observedWinRate
      : null;
    const outOfSample = scoreRows(outOfSampleRows, baselineProbability);
    const status = outOfSampleRows.length < minimumOutOfSampleSamples
      ? "INSUFFICIENT_OUT_OF_SAMPLE_SAMPLE"
      : outOfSampleRows.length < 100
        ? "EARLY_CALIBRATION_MONITORING"
        : "CALIBRATION_MONITORING_ONLY";
    return {
      model: modelRows[0]?.model || null,
      reviewPolicyVersion: modelRows[0]?.policyVersion || "LEGACY_UNVERSIONED",
      status,
      referenceSampleCount: referenceRows.length,
      outOfSampleSampleCount: outOfSampleRows.length,
      reference,
      outOfSample,
      meanSubjectiveConfidencePct: outOfSampleRows.length
        ? round4(outOfSampleRows.reduce((sum, row) => sum + row.confidence, 0) / outOfSampleRows.length)
        : null,
      confidenceBandDiagnostics: confidenceBandDiagnostics(outOfSampleRows),
      confidenceInterpretation: "Subjective model confidence is grouped descriptively against observed outcomes; it is not a probability and these bands do not establish calibration.",
      referenceWindow: referenceRows.length ? {
        firstClosedAt: new Date(referenceRows[0].closedAt).toISOString(),
        lastClosedAt: new Date(referenceRows.at(-1).closedAt).toISOString()
      } : null,
      outOfSampleWindow: outOfSampleRows.length ? {
        firstClosedAt: new Date(outOfSampleRows[0].closedAt).toISOString(),
        lastClosedAt: new Date(outOfSampleRows.at(-1).closedAt).toISOString()
      } : null
    };
  };
  const modelDiagnostics = modelGroups.map(group => {
    const [model, policyVersion] = group.split("\u0000");
    return diagnoseModel(rows.filter(row => row.model === model && row.policyVersion === policyVersion));
  });
  const mixedModels = modelGroups.length > 1;
  const single = modelDiagnostics[0] || null;
  const status = mixedModels
    ? "MIXED_MODEL_OR_REVIEW_POLICY_VERSIONS_SEPARATE_DIAGNOSTICS"
    : single?.status || "INSUFFICIENT_OUT_OF_SAMPLE_SAMPLE";

  return {
    status,
    isCalibrated: false,
    trainedModel: false,
    method: "CHRONOLOGICAL_HOLDOUT_RELIABILITY_DIAGNOSTICS_NO_FITTING",
    sampleBasis: "APPROVED_AI_REVIEWS_WITH_AUTOMATED_DAILY_BAR_EXITS_ONLY",
    totalEligibleTrades: rows.length,
    referenceSampleCount: mixedModels ? 0 : single?.referenceSampleCount || 0,
    outOfSampleSampleCount: mixedModels ? 0 : single?.outOfSampleSampleCount || 0,
    minimumReferenceSamples,
    minimumOutOfSampleSamples,
    holdoutFraction,
    reference: mixedModels ? null : single?.reference || scoreRows([]),
    outOfSample: mixedModels ? null : single?.outOfSample || scoreRows([]),
    modelDiagnostics,
    meanSubjectiveConfidencePct: mixedModels ? null : single?.meanSubjectiveConfidencePct ?? null,
    confidenceBandDiagnostics: mixedModels ? [] : single?.confidenceBandDiagnostics || [],
    confidenceInterpretation: "Subjective confidence bands are descriptive only and are not calibrated probabilities.",
    modelVersions,
    reviewPolicyVersions,
    sourceLabels: [...new Set(rows.map(row => row.source))].sort(),
    manualExitExcludedCount,
    invalidReviewCount,
    duplicateReviewCount,
    referenceWindow: mixedModels ? null : single?.referenceWindow || null,
    outOfSampleWindow: mixedModels ? null : single?.outOfSampleWindow || null,
    interpretation: mixedModels
      ? "Multiple model or review-policy versions are present. No pooled calibration metric is reported because their predictions must not be mixed; inspect the separate chronological diagnostics for each version. These are outcome diagnostics, not model training, probability correction or evidence of future profitability."
      : "Predicted win probability is an uncalibrated model estimate. The earlier chronological reference sample supplies the fixed baseline probability for the later holdout; the holdout is never used to set that baseline. These are outcome diagnostics, not model training, probability correction or evidence of future profitability. Only approved reviews with automated daily-bar exits are included; manual exits are excluded.",
    liveTradingEnabled: false
  };
}
