// EDGE crypto strategy research reviewer. This is a structured research critique, not a predictor or execution gate.
import { validateCoinSpotCandles, walkForwardCoinSpotTrend } from "./coinspot-strategy.js";

const MAX_RESPONSE_CHARS = 12000;
const MAX_INPUT_BARS = 5000;
const MAX_REVIEW_BARS = 50;

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === "string") return part.text;
    }
  }
  return "";
}

function validateDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI research review was not an object.");
  }
  const decision = value.decision;
  const confidence = value.confidence;
  const evidenceQuality = value.evidence_quality;
  const thesis = value.thesis;
  const counterThesis = value.counter_thesis;
  const riskFlags = value.risk_flags;
  const limitations = value.limitations;
  if (!["ADVANCE_TO_FORWARD_PAPER_REVIEW", "HOLD_FOR_MORE_DATA", "REJECT"].includes(decision) ||
      typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 100 ||
      !["LOW", "MODERATE", "HIGH"].includes(evidenceQuality) ||
      typeof thesis !== "string" || thesis.length > 1600 ||
      typeof counterThesis !== "string" || counterThesis.length > 1600 ||
      !Array.isArray(riskFlags) || riskFlags.length > 10 ||
      riskFlags.some(flag => typeof flag !== "string" || flag.length > 300) ||
      !Array.isArray(limitations) || limitations.length > 10 ||
      limitations.some(item => typeof item !== "string" || item.length > 300)) {
    throw new Error("AI research review did not match the required structured schema.");
  }
  return { decision, confidence, evidenceQuality, thesis, counterThesis, riskFlags, limitations };
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder !== "function") {
    throw new Error("SHA-256 provenance hashing is unavailable.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["ADVANCE_TO_FORWARD_PAPER_REVIEW", "HOLD_FOR_MORE_DATA", "REJECT"] },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    evidence_quality: { type: "string", enum: ["LOW", "MODERATE", "HIGH"] },
    thesis: { type: "string", maxLength: 1600 },
    counter_thesis: { type: "string", maxLength: 1600 },
    risk_flags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } },
    limitations: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } }
  },
  required: ["decision", "confidence", "evidence_quality", "thesis", "counter_thesis", "risk_flags", "limitations"]
};

export async function reviewCryptoWalkForward({
  market, quoteCurrency = "USDT", source, candles, apiKey,
  model = "gpt-6.2-astra", fetchImpl = fetch, timeoutMs = 15000, now = Date.now()
} = {}) {
  if (!apiKey) return {
    status: "AI_BLOCKED_NOT_CONFIGURED", advanceAllowed: false, retryable: true,
    reason: "OPENAI_API_KEY is not configured.", liveTradingEnabled: false
  };
  const clock = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : Number(now);
  if (!Number.isFinite(clock) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      typeof model !== "string" || !model.trim() || model.length > 120 ||
      !Array.isArray(candles) || candles.length < 300 || candles.length > MAX_INPUT_BARS ||
      typeof source !== "string" || !source.trim() || source.length > 200) {
    return {
      status: "AI_BLOCKED_INVALID_INPUT", advanceAllowed: false, retryable: false,
      reason: "Crypto review requires 300–5,000 completed hourly candles, a source label and valid review settings.",
      liveTradingEnabled: false
    };
  }

  let data, research;
  try {
    data = validateCoinSpotCandles(candles);
    research = walkForwardCoinSpotTrend({
      candles: data, market, quoteCurrency, source, now: clock,
      initialHistoryFraction: 0.6, foldCount: 3, minimumOutOfSampleTrades: 30,
      startingCapital: 100, feeRate: 0.001, slippageBps: 15, spreadBps: 10
    });
  } catch (error) {
    return {
      status: "AI_BLOCKED_INVALID_INPUT", advanceAllowed: false, retryable: false,
      reason: error?.message || "Crypto walk-forward input failed validation.",
      liveTradingEnabled: false
    };
  }

  const recentCandles = data.slice(-MAX_REVIEW_BARS);
  let fingerprint;
  try {
    fingerprint = await sha256(recentCandles);
  } catch {
    return {
      status: "AI_BLOCKED_PROVENANCE_ERROR", advanceAllowed: false, retryable: true,
      reason: "Source-candle fingerprinting failed; AI review was not attempted.",
      liveTradingEnabled: false
    };
  }
  const inputProvenance = {
    source: research.source,
    sourceVerification: "NOT_INDEPENDENTLY_VERIFIED",
    quoteCurrency: research.quoteCurrency,
    firstBarAt: research.data.firstBarAt,
    latestBarAt: research.data.lastBarAt,
    barsProvided: data.length,
    barsReviewed: recentCandles.length,
    fingerprintAlgorithm: "SHA-256",
    fingerprint
  };
  const reviewId = "crypto-" + research.market + "-" + research.data.lastBarAt.slice(0, 10) + "-" + fingerprint.slice(0, 16);
  const packet = {
    strategy: research.strategy,
    market: research.market,
    quoteCurrency: research.quoteCurrency,
    source: research.source,
    sourceVerification: research.sourceVerification,
    methodology: research.methodology,
    comparison: research.comparison,
    parameterPolicy: research.parameterPolicy,
    data: research.data,
    summary: research.summary,
    folds: research.folds.map(fold => ({
      fold: fold.fold, priorHistoryBars: fold.priorHistoryBars,
      testStartAt: fold.testStartAt, testEndAt: fold.testEndAt,
      trades: fold.trades, winRatePct: fold.winRatePct,
      profitFactor: fold.profitFactor, netPnlQuote: fold.netPnlQuote,
      returnPct: fold.returnPct, maxDrawdownPct: fold.maxDrawdownPct,
      benchmark: { status: fold.benchmark.status, returnPct: fold.benchmark.returnPct }
    })),
    recentHourlyCandles: recentCandles,
    inputProvenance
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
          content: "You are EDGE's conservative crypto strategy research reviewer. Critique only the supplied deterministic walk-forward results and recent hourly candles. Do not invent market data, news, fundamentals, licensing, exchange access or source verification. Do not search the web. Do not predict returns or win probabilities. Do not change strategy rules, parameters, capital, sizing, fees, slippage, spread, loss limits or execution settings. This is model-assisted review, not a trained predictive model. An ADVANCE decision means only that the fixed strategy may enter a longer forward paper-observation phase; it is not an approval for a real trade, profitability claim or order instruction. If the deterministic assessment is not CANDIDATE_FOR_EXTENDED_FORWARD_PAPER_REVIEW, choose HOLD_FOR_MORE_DATA. Confidence is subjective review confidence, not a calibrated probability. Identify overfitting risk, sample limitations, market-regime concentration, drawdown, cost sensitivity, gaps and source uncertainty. Return only the exact structured JSON schema."
        }, {
          role: "user",
          content: "Review this fixed-rule crypto walk-forward report. The supplied metrics, folds, recent candles and provenance are the only evidence. The deterministic assessment remains authoritative and cannot be overridden. Return a cautious research decision.\n\n" + JSON.stringify(packet)
        }],
        text: { format: { type: "json_schema", name: "edge_crypto_research_review", strict: true, schema: REVIEW_SCHEMA } }
      }),
      signal: controller.signal,
      redirect: "error"
    });
    if (response.url && new URL(response.url).hostname !== "api.openai.com") {
      return { status: "AI_BLOCKED_PROVIDER_REDIRECT", advanceAllowed: false, retryable: true, reason: "AI provider redirected to an unexpected host.", liveTradingEnabled: false };
    }
    if (!response.ok) {
      return { status: "AI_BLOCKED_PROVIDER_ERROR", advanceAllowed: false, retryable: true, reason: "OpenAI returned HTTP " + response.status + ".", liveTradingEnabled: false };
    }
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_CHARS) {
      return { status: "AI_BLOCKED_RESPONSE_TOO_LARGE", advanceAllowed: false, retryable: true, reason: "AI response exceeded the size limit.", liveTradingEnabled: false };
    }
    let payload;
    try { payload = JSON.parse(raw); } catch {
      return { status: "AI_BLOCKED_INVALID_RESPONSE", advanceAllowed: false, retryable: true, reason: "OpenAI returned invalid JSON.", liveTradingEnabled: false };
    }
    let decision;
    try { decision = validateDecision(JSON.parse(responseText(payload))); } catch (error) {
      return { status: "AI_BLOCKED_INVALID_DECISION", advanceAllowed: false, retryable: true, reason: error?.message || "AI decision failed schema validation.", liveTradingEnabled: false };
    }

    const deterministicGateMet = research.summary.assessment === "CANDIDATE_FOR_EXTENDED_FORWARD_PAPER_REVIEW";
    let finalDecision = decision.decision;
    const riskFlags = [...decision.riskFlags];
    if (finalDecision === "ADVANCE_TO_FORWARD_PAPER_REVIEW" && !deterministicGateMet) {
      finalDecision = "HOLD_FOR_MORE_DATA";
      riskFlags.push("DETERMINISTIC_WALK_FORWARD_GATE_NOT_MET");
    }
    if (finalDecision === "ADVANCE_TO_FORWARD_PAPER_REVIEW" && (decision.confidence < 75 || riskFlags.length > 0)) {
      finalDecision = "HOLD_FOR_MORE_DATA";
      riskFlags.push("AI_REVIEW_CONFIDENCE_OR_RISK_GATE_NOT_MET");
    }
    const advanceAllowed = finalDecision === "ADVANCE_TO_FORWARD_PAPER_REVIEW" &&
      deterministicGateMet && decision.confidence >= 75 && riskFlags.length === 0;
    const status = advanceAllowed
      ? "AI_RECOMMENDS_FORWARD_PAPER_OBSERVATION"
      : finalDecision === "REJECT" ? "AI_REJECTED_RESEARCH_CANDIDATE"
        : !deterministicGateMet && decision.decision === "ADVANCE_TO_FORWARD_PAPER_REVIEW"
          ? "AI_HELD_DETERMINISTIC_GATE_NOT_MET"
          : "AI_HELD_RESEARCH_CANDIDATE";
    return {
      status, advanceAllowed, retryable: false,
      decision: finalDecision, modelDecision: decision.decision,
      confidence: decision.confidence, evidenceQuality: decision.evidenceQuality,
      thesis: decision.thesis, counterThesis: decision.counterThesis,
      riskFlags, limitations: decision.limitations,
      deterministicGateMet,
      reason: advanceAllowed
        ? "The AI review and independent deterministic walk-forward gates support considering extended forward paper observation only; no observation job was started."
        : "No trade or live execution is authorised. The deterministic research gates and AI review remain advisory safeguards.",
      model, reviewedAt: new Date(clock).toISOString(), reviewId, inputProvenance,
      research: {
        strategy: research.strategy, market: research.market, quoteCurrency: research.quoteCurrency,
        source: research.source, data: research.data, summary: research.summary,
        folds: packet.folds, methodology: research.methodology
      },
      interpretation: "This is a model-assisted critique of a deterministic historical simulation. It is not a trained predictive model, calibrated probability, profitability guarantee or execution instruction.",
      liveTradingEnabled: false
    };
  } catch (error) {
    return {
      status: "AI_BLOCKED_PROVIDER_ERROR", advanceAllowed: false, retryable: true,
      reason: error?.name === "AbortError" ? "AI review timed out." : "AI review failed; no research advancement was authorised.",
      liveTradingEnabled: false
    };
  } finally {
    clearTimeout(timeout);
  }
}
