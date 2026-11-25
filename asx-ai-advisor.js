// EDGE ASX AI decision layer. This is a model-assisted veto, not a trained predictor.
// Deterministic portfolio controls remain authoritative; malformed or unavailable AI always fails closed.
const MAX_RESPONSE_CHARS = 12000;
const MAX_BARS = 30;
const MIN_BARS = 51;
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

function validateInput(candidate, bars) {
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
    const close = finite(bar?.close), volume = finite(bar?.volume);
    if (!Number.isFinite(timestamp) || timestamp <= previous ||
        open === null || high === null || low === null || close === null || volume === null ||
        open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 ||
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
  return { valid: true, bars: clean };
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
      typeof thesis !== "string" || thesis.length > 1600 ||
      typeof counterThesis !== "string" || counterThesis.length > 1600 ||
      !Array.isArray(riskFlags) || riskFlags.length > 10 ||
      riskFlags.some(flag => typeof flag !== "string" || flag.length > 300)) {
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
    thesis: { type: "string", maxLength: 1600 },
    counter_thesis: { type: "string", maxLength: 1600 },
    risk_flags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } }
  },
  required: ["decision", "confidence", "predicted_win_probability", "thesis", "counter_thesis", "risk_flags"]
};

export async function evaluateAsxAiDecision({
  candidate, bars, apiKey, model = "gpt-6.2-astra", fetchImpl = fetch,
  timeoutMs = 12000, now = Date.now()
} = {}) {
  if (!apiKey) return { status: "AI_BLOCKED_NOT_CONFIGURED", approved: false, reason: "OPENAI_API_KEY is not configured." };
  const validated = validateInput(candidate, bars);
  if (!validated.valid) return { status: "AI_BLOCKED_INVALID_INPUT", approved: false, reason: validated.reason };
  const reviewClock = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(reviewClock) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      typeof model !== "string" || !model.trim() || model.length > 120) {
    return { status: "AI_BLOCKED_INVALID_INPUT", approved: false, reason: "AI review clock, model or timeout configuration is invalid." };
  }

  const recentBars = validated.bars.slice(-MAX_BARS);
  let fingerprint;
  try {
    fingerprint = await sha256(recentBars);
  } catch {
    return { status: "AI_BLOCKED_PROVENANCE_ERROR", approved: false, reason: "Source-bar fingerprinting failed; AI review was not attempted." };
  }
  const observedAt = new Date(Date.parse(candidate.observedAt)).toISOString();
  const inputProvenance = {
    source: candidate.source,
    sourceVerification: "NOT_INDEPENDENTLY_VERIFIED",
    currency: "AUD",
    observedAt,
    firstBarAt: validated.bars[0].timestamp,
    latestBarAt: validated.bars.at(-1).timestamp,
    barsProvided: validated.bars.length,
    barsReviewed: recentBars.length,
    fingerprintAlgorithm: "SHA-256",
    fingerprint
  };
  const reviewId = "asx-" + candidate.symbol + "-" + observedAt.slice(0, 10) + "-" + fingerprint.slice(0, 16);
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
    deterministicReason: candidate.reason, recentDailyBars: recentBars, inputProvenance
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
          content: "Review this ASX daily-bar paper candidate. The supplied bars and provenance packet are the only market evidence. Identify data limitations, trend quality, breakout context, volatility and cost/risk asymmetry. Do not treat deterministic screening as proof. Return the required structured JSON.\n\n" + JSON.stringify(packet)
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
    return {
      ...decision, model, reviewedAt: new Date(reviewClock).toISOString(),
      reviewId, inputProvenance
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
