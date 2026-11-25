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
  timestamp: new Date(Date.parse(candidate.observedAt) - (59 - i) * 86400000).toISOString(),
  open: 40 + i * 0.08, high: 40.5 + i * 0.08, low: 39.8 + i * 0.08,
  close: 40.2 + i * 0.08, volume: 100000 + i
}));
const aiResponse = decision => new Response(JSON.stringify({ output_text: JSON.stringify(decision) }), {
  status: 200, headers: { "Content-Type": "application/json" }
});
const approve = {
  decision: "APPROVE", confidence: 82, predicted_win_probability: 0.62,
  thesis: "The supplied trend and breakout context are internally consistent.",
  counter_thesis: "A breakout can fail after the observation date.",
  risk_flags: []
};

test("AI advisor fails closed when the OpenAI secret is not configured", async () => {
  const result = await evaluateAsxAiDecision({ candidate, bars });
  assert.equal(result.status, "AI_BLOCKED_NOT_CONFIGURED");
  assert.equal(result.approved, false);
});

test("AI advisor uses strict structured output and records a SHA-256 source fingerprint", async () => {
  let request;
  const result = await evaluateAsxAiDecision({
    candidate, bars, apiKey: "test-only",
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return aiResponse(approve);
    },
    now: Date.parse(candidate.observedAt) + 1000
  });
  assert.equal(result.status, "AI_APPROVED_PAPER_CANDIDATE");
  assert.equal(result.approved, true);
  assert.equal(result.confidence, 82);
  assert.equal(result.predictedWinProbability, 0.62);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.init.headers.Authorization, "Bearer test-only");
  assert.equal(request.body.text.format.type, "json_schema");
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.text.format.schema.additionalProperties, false);
  assert.equal(request.body.text.format.schema.required.includes("predicted_win_probability"), true);
  assert.match(request.body.input[0].content, /not a trained predictive model/i);
  assert.match(request.body.input[1].content, /recentDailyBars/);
  assert.equal(request.body.input[1].content.includes("undefined"), false);
  assert.match(result.inputProvenance.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.inputProvenance.barsProvided, 60);
  assert.equal(result.inputProvenance.barsReviewed, 30);
  assert.equal(result.inputProvenance.sourceVerification, "NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(result.reviewId.includes(result.inputProvenance.fingerprint.slice(0, 16)), true);
});

test("AI advisor blocks low confidence, risk flags and non-approval decisions", async () => {
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
  for (const decision of ["REVIEW", "REJECT"]) {
    const result = await evaluateAsxAiDecision({
      candidate, bars, apiKey: "test",
      fetchImpl: async () => aiResponse({ ...approve, decision })
    });
    assert.equal(result.approved, false);
  }
});

test("AI advisor blocks missing or malformed probability output", async () => {
  for (const malformedDecision of [
    { ...approve, predicted_win_probability: undefined },
    { ...approve, predicted_win_probability: 1.01 },
    { ...approve, confidence: 101 }
  ]) {
    const result = await evaluateAsxAiDecision({
      candidate, bars, apiKey: "test",
      fetchImpl: async () => aiResponse(malformedDecision)
    });
    assert.equal(result.status, "AI_BLOCKED_INVALID_DECISION");
    assert.equal(result.approved, false);
  }
});

test("AI advisor rejects invalid provenance before calling the model", async () => {
  let called = false;
  const invalidCandidates = [
    { ...candidate, source: "" },
    { ...candidate, observedAt: "2026-11-21T06:00:00.000Z" },
    { ...candidate, executable: true }
  ];
  for (const invalidCandidate of invalidCandidates) {
    const result = await evaluateAsxAiDecision({
      candidate: invalidCandidate, bars, apiKey: "test",
      fetchImpl: async () => { called = true; return aiResponse(approve); }
    });
    assert.equal(result.status, "AI_BLOCKED_INVALID_INPUT");
    assert.equal(result.approved, false);
  }
  assert.equal(called, false);
});


test("AI advisor preserves missing provider volume as missing rather than inventing it", async () => {
  let requestBody;
  const barsWithoutVolume = bars.map(({ volume, ...bar }) => bar);
  const result = await evaluateAsxAiDecision({
    candidate, bars: barsWithoutVolume, apiKey: "test",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return aiResponse(approve);
    }
  });
  assert.equal(result.approved, true);
  assert.equal(result.inputProvenance.volumeBarsAvailable, 0);
  assert.equal(result.inputProvenance.volumeBarsMissing, 30);
  const packet = JSON.parse(requestBody.input[1].content.split("\\n\\n").at(-1));
  assert.equal(packet.recentDailyBars.at(-1).volume, null);
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
