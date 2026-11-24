import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAsxAiDecision } from "../asx-ai-advisor.js";

const candidate = {
  status: "PAPER_CANDIDATE", executable: false, simulatedOnly: true,
  symbol: "BHP", currency: "AUD", source: "licensed provider sample",
  observedAt: "2026-11-20T06:00:00.000Z", entryReference: 45,
  stopPrice: 43, targetPrice: 49, shares: 2, notionalAud: 90,
  riskBudgetAud: 5, estimatedEntryCostsAud: 5.5,
  estimatedNetTargetProfitAud: 6, estimatedNetStopLossAud: 3,
  rewardRiskAfterCosts: 2, reason: "Deterministic candidate."
};
const bars = Array.from({ length: 60 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
  open: 40 + i * .08, high: 40.5 + i * .08, low: 39.8 + i * .08,
  close: 40.2 + i * .08, volume: 100000 + i
}));
const aiResponse = decision => new Response(JSON.stringify({ output_text: JSON.stringify(decision) }), {
  status: 200, headers: { "Content-Type": "application/json" }
});
const approve = {
  decision: "APPROVE", confidence: 82,
  thesis: "The supplied trend and breakout context are internally consistent.",
  counter_thesis: "A breakout can fail after the observation date.",
  risk_flags: []
};

test("AI advisor fails closed when the OpenAI secret is not configured", async () => {
  const result = await evaluateAsxAiDecision({ candidate, bars });
  assert.equal(result.status, "AI_BLOCKED_NOT_CONFIGURED");
  assert.equal(result.approved, false);
});

test("AI advisor approves only a valid high-confidence decision with no risk flags", async () => {
  let request;
  const result = await evaluateAsxAiDecision({
    candidate, bars, apiKey: "test-only",
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return aiResponse(approve);
    }
  });
  assert.equal(result.status, "AI_APPROVED_PAPER_CANDIDATE");
  assert.equal(result.approved, true);
  assert.equal(result.confidence, 82);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.init.headers.Authorization, "Bearer test-only");
  assert.equal(request.body.text.format.type, "json_object");
  assert.match(request.body.input[0].content, /Do not invent facts/);
  assert.match(request.body.input[1].content, /recentDailyBars/);
  assert.equal(request.body.input[1].content.includes("undefined"), false);
});

test("AI advisor blocks low confidence and any declared risk flag", async () => {
  const low = await evaluateAsxAiDecision({
    candidate, bars, apiKey: "test",
    fetchImpl: async () => aiResponse({ ...approve, confidence: 74 })
  });
  assert.equal(low.approved, false);
  const flagged = await evaluateAsxAiDecision({
    candidate, bars, apiKey: "test",
    fetchImpl: async () => aiResponse({ ...approve, risk_flags: ["Possible breakout exhaustion"] })
  });
  assert.equal(flagged.approved, false);
});

test("AI advisor blocks review, reject and malformed model output", async () => {
  for (const decision of ["REVIEW", "REJECT"]) {
    const result = await evaluateAsxAiDecision({
      candidate, bars, apiKey: "test",
      fetchImpl: async () => aiResponse({ ...approve, decision })
    });
    assert.equal(result.approved, false);
  }
  const malformed = await evaluateAsxAiDecision({
    candidate, bars, apiKey: "test",
    fetchImpl: async () => aiResponse({ ...approve, confidence: 101 })
  });
  assert.equal(malformed.status, "AI_BLOCKED_INVALID_DECISION");
  assert.equal(malformed.approved, false);
});

test("AI advisor blocks provider errors, redirects and timeouts without approving", async () => {
  const providerError = await evaluateAsxAiDecision({
    candidate, bars, apiKey: "test", fetchImpl: async () => new Response("unavailable", { status: 503 })
  });
  assert.equal(providerError.status, "AI_BLOCKED_PROVIDER_ERROR");
  const redirect = await evaluateAsxAiDecision({
    candidate, bars, apiKey: "test",
    fetchImpl: async () => ({ ok: true, url: "https://example.com/redirect", text: async () => "{}" })
  });
  assert.equal(redirect.status, "AI_BLOCKED_PROVIDER_REDIRECT");
  const timeout = await evaluateAsxAiDecision({
    candidate, bars, apiKey: "test",
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
    timeoutMs: 5
  });
  assert.equal(timeout.status, "AI_BLOCKED_PROVIDER_ERROR");
  assert.equal(timeout.approved, false);
});

test("AI advisor rejects incomplete candidate provenance before calling the model", async () => {
  let called = false;
  const result = await evaluateAsxAiDecision({
    candidate: { ...candidate, executable: true }, bars, apiKey: "test",
    fetchImpl: async () => { called = true; return aiResponse(approve); }
  });
  assert.equal(result.status, "AI_BLOCKED_INVALID_INPUT");
  assert.equal(result.approved, false);
  assert.equal(called, false);
});
