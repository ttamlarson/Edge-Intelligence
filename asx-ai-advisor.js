// EDGE ASX AI decision layer. AI may veto a deterministic paper candidate; it never sets prices or sizing.
// Fail-closed: missing keys, malformed model output, timeouts and provider errors block the candidate.
const MAX_RESPONSE_CHARS = 12000;
const MAX_BARS = 30;
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI decision was not an object.");
  const decision = value.decision;
  const confidence = finite(value.confidence);
  const thesis = value.thesis;
  const counterThesis = value.counter_thesis;
  const riskFlags = value.risk_flags;
  if (!["APPROVE", "REJECT", "REVIEW"].includes(decision) ||
      confidence === null || confidence < 0 || confidence > 100 ||
      typeof thesis !== "string" || thesis.length > 1600 ||
      typeof counterThesis !== "string" || counterThesis.length > 1600 ||
      !Array.isArray(riskFlags) || riskFlags.length > 10 ||
      riskFlags.some(flag => typeof flag !== "string" || flag.length > 300)) {
    throw new Error("AI decision did not match the required schema.");
  }
  const approved = decision === "APPROVE" && confidence >= 75 && riskFlags.length === 0;
  return {
    status: approved ? "AI_APPROVED_PAPER_CANDIDATE" : "AI_BLOCKED_PAPER_CANDIDATE",
    approved, decision, confidence, thesis, counterThesis, riskFlags,
    reason: approved
      ? "AI approved the deterministic candidate at the required confidence threshold with no declared risk flags."
      : decision === "APPROVE"
        ? "AI approval did not meet the confidence or risk-flag gate."
        : `AI returned ${decision}; paper entry was blocked.`
  };
}

export async function evaluateAsxAiDecision({
  candidate, bars, apiKey, model = "gpt-6-astra", fetchImpl = fetch, timeoutMs = 12000
} = {}) {
  if (!apiKey) return { status: "AI_BLOCKED_NOT_CONFIGURED", approved: false, reason: "OPENAI_API_KEY is not configured." };
  if (!candidate || candidate.status !== "PAPER_CANDIDATE" || candidate.executable !== false ||
      candidate.simulatedOnly !== true || !Array.isArray(bars) || bars.length < 51) {
    return { status: "AI_BLOCKED_INVALID_INPUT", approved: false, reason: "AI review requires a deterministic paper candidate and at least 51 source bars." };
  }
  const recentBars = bars.slice(-MAX_BARS).map(bar => ({
    timestamp: bar.timestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume
  }));
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
    deterministicReason: candidate.reason, recentDailyBars: recentBars
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{
          role: "system",
          content: "You are EDGE's conservative ASX paper-trading risk reviewer. Evaluate only the supplied source observations and deterministic candidate. Do not invent facts, prices, news, fundamentals or market data. Do not calculate or change entry, stop, target, quantity, fees, capital or risk limits. Treat this as a research veto layer, not an order instruction. Return JSON only with decision (APPROVE, REJECT or REVIEW), confidence (0-100), thesis (string), counter_thesis (string), risk_flags (array of strings). APPROVE only when evidence is coherent and risks are acceptably bounded; otherwise REJECT or REVIEW. Confidence is subjective model confidence, not probability of profit."
        }, {
          role: "user",
          content: `Review this ASX daily-bar paper candidate. The supplied bars and source label are the only market evidence. Identify data limitations, trend quality, breakout context, volatility and cost/risk asymmetry. Do not treat the candidate's deterministic screening as proof. Return the required JSON schema.\n\n${JSON.stringify(packet)}`
        }],
        text: { format: { type: "json_object" } }
      }),
      signal: controller.signal,
      redirect: "error"
    });
    if (response.url && new URL(response.url).hostname !== "api.openai.com") {
      return { status: "AI_BLOCKED_PROVIDER_REDIRECT", approved: false, reason: "AI provider redirected to an unexpected host." };
    }
    if (!response.ok) return { status: "AI_BLOCKED_PROVIDER_ERROR", approved: false, reason: `OpenAI returned HTTP ${response.status}.` };
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
    return { ...decision, model, reviewedAt: new Date().toISOString() };
  } catch (error) {
    return {
      status: "AI_BLOCKED_PROVIDER_ERROR", approved: false,
      reason: error?.name === "AbortError" ? "AI review timed out." : "AI review failed; candidate safely blocked."
    };
  } finally {
    clearTimeout(timeout);
  }
}
