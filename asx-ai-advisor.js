// EDGE ASX AI decision layer. This is a model-assisted veto, not a trained predictor.
// Deterministic portfolio controls remain authoritative; malformed or unavailable AI always fails closed.
const MAX_RESPONSE_CHARS = 12000;
const MAX_BARS = 30;
const MIN_BARS = 51;
const REVIEW_POLICY_VERSION = "ASX_AI_REVIEW_V2";
const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === "string") return part.text;
    }
  }
  return "";
}

function validateInput(candidate, bars, sourceMetadata, reviewClock) {
  if (!candidate || candidate.status !== "PAPER_CANDIDATE" || candidate.executable !== false ||
      candidate.simulatedOnly !== true || !/^[A-Z0-9.]{2,12}$/.test(String(candidate.symbol || "")) ||
      candidate.currency !== "AUD" || typeof candidate.source !== "string" || !candidate.source.trim() ||
      !Number.isFinite(Date.parse(candidate.observedAt || "")) ||
      finite(candidate.entryReference) === null || candidate.entryReference <= 0 ||
      finite(candidate.stopPrice) === null || candidate.stopPrice <= 0 || candidate.stopPrice >= candidate.entryReference ||
      finite(candidate.targetPrice) === null || candidate.targetPrice <= candidate.entryReference ||
      !Number.isInteger(candidate.shares) || candidate.shares < 1 ||
      finite(candidate.notionalAud) === null || candidate.notionalAud <= 0 ||
      !Array.isArray(bars) || bars.length < MIN_BARS || bars.length > 5000) {
    return { valid: false, reason: "AI review requires a fully sourced AUD paper candidate and at least 51 valid daily bars." };
  }

  const clean = [];
  let previous = -Infinity;
  for (const bar of bars) {
    const timestamp = Date.parse(bar?.timestamp || "");
    const open = finite(bar?.open), high = finite(bar?.high), low = finite(bar?.low);
    const close = finite(bar?.close);
    const rawVolume = bar?.volume;
    const volume = rawVolume == null ? null : finite(rawVolume);
    if (!Number.isFinite(timestamp) || timestamp <= previous ||
        open === null || high === null || low === null || close === null ||
        (rawVolume != null && (volume === null || volume < 0)) ||
        open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
        high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
      return { valid: false, reason: "AI review rejected invalid, unordered or incomplete source OHLCV bars." };
    }
    previous = timestamp;
    clean.push({
      timestamp: new Date(timestamp).toISOString(),
      open, high, low, close, volume
    });
  }

  const observedAt = Date.parse(candidate.observedAt);
  if (observedAt !== previous) {
    return { valid: false, reason: "Candidate observation time does not match the latest supplied source bar." };
  }

  let sourceUrl;
  try { sourceUrl = new URL(sourceMetadata?.sourceUrl || ""); } catch { sourceUrl = null; }
  const retrievedAt = Date.parse(sourceMetadata?.retrievedAt || "");
  const providerSymbols = sourceMetadata?.symbols;
  const providerRows = sourceMetadata?.providerRowsForSymbol;
  if (!sourceMetadata || sourceMetadata.source !== candidate.source ||
      !sourceUrl || sourceUrl.protocol !== "https:" ||
      !["datacedar.com", "www.datacedar.com"].includes(sourceUrl.hostname) ||
      sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash ||
      !Number.isFinite(retrievedAt) || retrievedAt < previous || retrievedAt > reviewClock + 5 * 60_000 ||
      sourceMetadata.currency !== "AUD" || sourceMetadata.exchange !== "ASX" ||
      sourceMetadata.timeframe !== "1d" || sourceMetadata.adjustment !== "raw" ||
      sourceMetadata.dataClass !== "historical_market_data_not_realtime" ||
      !Array.isArray(providerSymbols) || !providerSymbols.includes(candidate.symbol) ||
      !Number.isInteger(providerRows) || providerRows < clean.length) {
    return { valid: false, reason: "AI review requires validated DataCedar ASX source, retrieval, symbol, timeframe, adjustment and row-count provenance." };
  }

  return {
    valid: true,
    bars: clean,
    sourceMetadata: {
      source: candidate.source,
      sourceUrl: sourceUrl.href,
      retrievedAt: new Date(retrievedAt).toISOString(),
      currency: "AUD",
      exchange: "ASX",
      timeframe: "1d",
      adjustment: "raw",
      dataClass: "historical_market_data_not_realtime",
      symbols: [...new Set(providerSymbols.map(symbol => String(symbol).toUpperCase()))].sort(),
      providerRowsForSymbol: providerRows
    }
  };
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder !== "function") {
    throw new Error("SHA-256 provenance hashing is unavailable.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI decision was not an object.");
  }
  const decision = value.decision;
  const confidence = value.confidence;
  const predictedWinProbability = value.predicted_win_probability;
  const thesis = value.thesis;
  const counterThesis = value.counter_thesis;
  const riskFlags = value.risk_flags;
  if (!["APPROVE", "REJECT", "REVIEW"].includes(decision) ||
      typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 100 ||
      typeof predictedWinProbability !== "number" || !Number.isFinite(predictedWinProbability) ||
      predictedWinProbability < 0 || predictedWinProbability > 1 ||
      typeof thesis !== "string" || thesis.trim().length < 20 || thesis.length > 1600 ||
      typeof counterThesis !== "string" || counterThesis.trim().length < 20 || counterThesis.length > 1600 ||
      !Array.isArray(riskFlags) || riskFlags.length > 10 ||
      riskFlags.some(flag => typeof flag !== "string" || !flag.trim() || flag.length > 300)) {
    throw new Error("AI decision did not match the required structured schema.");
  }
  const approved = decision === "APPROVE" && confidence >= 75 && riskFlags.length === 0;
  return {
    status: approved ? "AI_APPROVED_PAPER_CANDIDATE" : "AI_BLOCKED_PAPER_CANDIDATE",
    approved, decision, confidence, predictedWinProbability,
    thesis, counterThesis, riskFlags,
    reason: approved
      ? "AI approved the deterministic candidate at the required subjective-confidence threshold with no declared risk flags."
      : decision === "APPROVE"
        ? "AI approval did not meet the confidence or risk-flag gate."
        : "AI returned " + decision + "; paper entry was blocked."
  };
}

const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["APPROVE", "REJECT", "REVIEW"] },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    predicted_win_probability: { type: "number", minimum: 0, maximum: 1 },
    thesis: { type: "string", minLength: 20, maxLength: 1600 },
    counter_thesis: { type: "string", minLength: 20, maxLength: 1600 },
    risk_flags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } }
  },
  required: ["decision", "confidence", "predicted_win_probability", "thesis", "counter_thesis", "risk_flags"]
};

export async function evaluateAsxAiDecision({
  candidate, bars, sourceMetadata, apiKey, model = "gpt-6.2-astra", fetchImpl = fetch,
  timeoutMs = 12000, now = Date.now(), clock = () => Date.now()
} = {}) {
  if (!apiKey) return { status: "AI_BLOCKED_NOT_CONFIGURED", approved: false, reason: "OPENAI_API_KEY is not configured." };
  const reviewClock = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(reviewClock) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      typeof model !== "string" || !model.trim() || model.length > 120 || typeof clock !== "function") {
    return { status: "AI_BLOCKED_INVALID_INPUT", approved: false, reason: "AI review clock, model or timeout configuration is invalid." };
  }
  const validated = validateInput(candidate, bars, sourceMetadata, reviewClock);
  if (!validated.valid) return { status: "AI_BLOCKED_INVALID_INPUT", approved: false, reason: validated.reason };

  const recentBars = validated.bars.slice(-MAX_BARS);
  let fingerprint;
  const candidateEvidence = {
    symbol: candidate.symbol, currency: candidate.currency, source: candidate.source,
    observedAt: candidate.observedAt, entryReference: candidate.entryReference,
    stopPrice: candidate.stopPrice, targetPrice: candidate.targetPrice,
    shares: candidate.shares, notionalAud: candidate.notionalAud,
    riskBudgetAud: candidate.riskBudgetAud,
    estimatedEntryCostsAud: candidate.estimatedEntryCostsAud,
    estimatedNetTargetProfitAud: candidate.estimatedNetTargetProfitAud,
    estimatedNetStopLossAud: candidate.estimatedNetStopLossAud,
    rewardRiskAfterCosts: candidate.rewardRiskAfterCosts,
    deterministicReason: candidate.reason
  };
  try {
    fingerprint = await sha256({
      policyVersion: REVIEW_POLICY_VERSION,
      candidate: candidateEvidence,
      recentDailyBars: recentBars,
      sourceMetadata: validated.sourceMetadata
    });
  } catch {
    return { status: "AI_BLOCKED_PROVENANCE_ERROR", approved: false, reason: "Candidate or source-bar fingerprinting failed; AI review was not attempted." };
  }
  const observedAt = new Date(Date.parse(candidate.observedAt)).toISOString();
  let requestStartedAtMs;
  try {
    const requestClock = clock();
    const requestClockMs = requestClock instanceof Date ? requestClock.getTime() : Number(requestClock);
    requestStartedAtMs = Math.max(reviewClock, requestClockMs);
  } catch {
    requestStartedAtMs = Number.NaN;
  }
  if (!Number.isFinite(requestStartedAtMs)) {
    return { status: "AI_BLOCKED_PROVENANCE_ERROR", approved: false, reason: "AI request start timestamp is invalid." };
  }
  const requestStartedAt = new Date(requestStartedAtMs).toISOString();
  const inputProvenance = {
    source: candidate.source,
    sourceVerification: "NOT_INDEPENDENTLY_VERIFIED",
    sourceMetadataVersion: 1,
    sourceUrl: validated.sourceMetadata.sourceUrl,
    retrievedAt: validated.sourceMetadata.retrievedAt,
    exchange: validated.sourceMetadata.exchange,
    timeframe: validated.sourceMetadata.timeframe,
    adjustment: validated.sourceMetadata.adjustment,
    dataClass: validated.sourceMetadata.dataClass,
    providerRowsForSymbol: validated.sourceMetadata.providerRowsForSymbol,
    reviewRequestStartedAt: requestStartedAt,
    currency: "AUD",
    observedAt,
    firstBarAt: validated.bars[0].timestamp,
    latestBarAt: validated.bars.at(-1).timestamp,
    barsProvided: validated.bars.length,
    barsReviewed: recentBars.length,
    volumeBarsAvailable: recentBars.filter(bar => bar.volume !== null).length,
    volumeBarsMissing: recentBars.filter(bar => bar.volume === null).length,
    fingerprintAlgorithm: "SHA-256",
    fingerprintScope: "DETERMINISTIC_CANDIDATE_REVIEWED_DAILY_BARS_AND_PROVIDER_METADATA",
    fingerprint
  };
  const packet = {
    symbol: candidate.symbol, currency: candidate.currency, source: candidate.source,
    observedAt: candidate.observedAt, entryReference: candidate.entryReference,
    stopPrice: candidate.stopPrice, targetPrice: candidate.targetPrice,
    shares: candidate.shares, notionalAud: candidate.notionalAud,
    riskBudgetAud: candidate.riskBudgetAud,
    estimatedEntryCostsAud: candidate.estimatedEntryCostsAud,
    estimatedNetTargetProfitAud: candidate.estimatedNetTargetProfitAud,
    estimatedNetStopLossAud: candidate.estimatedNetStopLossAud,
    rewardRiskAfterCosts: candidate.rewardRiskAfterCosts,
    deterministicReason: candidate.reason, recentDailyBars: recentBars,
    sourceMetadata: validated.sourceMetadata, inputProvenance
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        reasoning: { effort: "high" },
        max_output_tokens: 1400,
        input: [{
          role: "system",
          content: "You are EDGE's conservative ASX paper-trading risk reviewer. Evaluate only the supplied source observations and deterministic candidate. The source label is not independent proof of licensing or accuracy. Do not invent facts, prices, news, fundamentals or market data. Do not calculate or change entry, stop, target, quantity, fees, capital, risk limits or execution settings. This is a model-assisted review layer, not a trained predictive model and not an order instruction. Return the exact JSON schema. Confidence is subjective reasoning confidence, not a probability. predicted_win_probability is your uncalibrated estimate, from 0 to 1, that this exact paper candidate closes with positive net P&L after the supplied fee assumptions under its fixed stop/target rules. Do not imply this probability is calibrated or proven. APPROVE only when evidence is coherent and risks are acceptably bounded."
        }, {
          role: "user",
          content: "Review this ASX daily-bar paper candidate. The supplied bars and provenance packet are the only market evidence. If volume is absent, explicitly disclose that limitation and do not infer volume confirmation. Identify data limitations, trend quality, breakout context, volatility and cost/risk asymmetry. Do not treat deterministic screening as proof. Return the required structured JSON.\n\n" + JSON.stringify(packet)
        }],
        text: { format: { type: "json_schema", name: "edge_asx_ai_review", strict: true, schema: DECISION_SCHEMA } }
      }),
      signal: controller.signal,
      redirect: "error"
    });
    if (response.url && new URL(response.url).hostname !== "api.openai.com") {
      return { status: "AI_BLOCKED_PROVIDER_REDIRECT", approved: false, reason: "AI provider redirected to an unexpected host." };
    }
    if (!response.ok) return { status: "AI_BLOCKED_PROVIDER_ERROR", approved: false, reason: "OpenAI returned HTTP " + response.status + "." };
    const contentLength = Number(response.headers?.get?.("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_CHARS) return { status: "AI_BLOCKED_RESPONSE_TOO_LARGE", approved: false, reason: "AI response exceeded the size limit." };
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_CHARS) return { status: "AI_BLOCKED_RESPONSE_TOO_LARGE", approved: false, reason: "AI response exceeded the size limit." };
    let payload;
    try { payload = JSON.parse(raw); } catch {
      return { status: "AI_BLOCKED_INVALID_RESPONSE", approved: false, reason: "OpenAI returned invalid JSON." };
    }
    let decision;
    try { decision = validateDecision(JSON.parse(responseText(payload))); } catch (error) {
      return { status: "AI_BLOCKED_INVALID_DECISION", approved: false, reason: error.message };
    }
    const actualModel = typeof payload.model === "string" && payload.model.trim()
      ? payload.model.trim()
      : model;
    if (actualModel.length > 120) {
      return { status: "AI_BLOCKED_INVALID_RESPONSE", approved: false, reason: "OpenAI returned an invalid model identifier." };
    }
    let completedAt;
    try {
      const completionClock = clock();
      completedAt = completionClock instanceof Date ? completionClock.getTime() : Number(completionClock);
    } catch {
      completedAt = Number.NaN;
    }
    if (!Number.isFinite(completedAt)) {
      return { status: "AI_BLOCKED_PROVENANCE_ERROR", approved: false, reason: "AI review completion timestamp is invalid." };
    }
    const reviewedAt = new Date(Math.max(requestStartedAtMs, completedAt)).toISOString();
    let modelFingerprint;
    try {
      modelFingerprint = await sha256({
        requestedModel: model,
        actualModel,
        policyVersion: REVIEW_POLICY_VERSION
      });
    } catch {
      return { status: "AI_BLOCKED_PROVENANCE_ERROR", approved: false, reason: "AI model-version fingerprinting failed." };
    }
    const reviewId = "asx-" + candidate.symbol + "-" + observedAt.slice(0, 10) + "-" +
      modelFingerprint.slice(0, 8) + "-" + fingerprint.slice(0, 16);
    return {
      ...decision,
      model: actualModel,
      requestedModel: model,
      reviewPolicyVersion: REVIEW_POLICY_VERSION,
      requestStartedAt,
      reviewedAt,
      providerResponseId: typeof payload.id === "string" && payload.id.length <= 120 ? payload.id : null,
      reviewId,
      inputProvenance
    };
  } catch (error) {
    return {
      status: "AI_BLOCKED_PROVIDER_ERROR", approved: false,
      reason: error?.name === "AbortError" ? "AI review timed out." : "AI review failed; candidate safely blocked."
    };
  } finally {
    clearTimeout(timeout);
  }
}
