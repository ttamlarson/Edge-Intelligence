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
const sourceMetadata = {
  source: candidate.source, sourceUrl: "https://datacedar.com/markets/australia",
  retrievedAt: candidate.observedAt, currency: "AUD", exchange: "ASX",
  timeframe: "1d", adjustment: "raw", dataClass: "historical_market_data_not_realtime",
  symbols: ["BHP"], providerRowsForSymbol: 60
};
const aiResponse = (decision, extra = {}) => new Response(JSON.stringify({ output_text: JSON.stringify(decision), ...extra }), {
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
    candidate, bars, sourceMetadata, apiKey: "test-only",
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
  assert.equal(result.inputProvenance.fingerprintScope, "DETERMINISTIC_CANDIDATE_REVIEWED_DAILY_BARS_AND_PROVIDER_METADATA");
  assert.equal(result.inputProvenance.sourceMetadataVersion, 1);
  assert.equal(result.inputProvenance.sourceUrl, sourceMetadata.sourceUrl);
  assert.equal(result.inputProvenance.retrievedAt, sourceMetadata.retrievedAt);
  assert.equal(result.inputProvenance.providerRowsForSymbol, 60);
  assert.equal(result.inputProvenance.sourceVerification, "NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(result.reviewId.includes(result.inputProvenance.fingerprint.slice(0, 16)), true);
});


test("AI advisor requires source-verified DataCedar metadata and substantive opposing analysis", async () => {
  let called = false;
  const invalidMetadata = [
    { ...sourceMetadata, sourceUrl: "http://datacedar.com/markets/australia" },
    { ...sourceMetadata, retrievedAt: "2026-11-19T00:00:00.000Z" },
    { ...sourceMetadata, symbols: ["CBA"] },
    { ...sourceMetadata, providerRowsForSymbol: 20 }
  ];
  for (const metadata of invalidMetadata) {
    const result = await evaluateAsxAiDecision({
      candidate, bars, sourceMetadata: metadata, apiKey: "test",
      fetchImpl: async () => { called = true; return aiResponse(approve); }
    });
    assert.equal(result.status, "AI_BLOCKED_INVALID_INPUT");
    assert.equal(result.approved, false);
  }
  const emptyThesis = await evaluateAsxAiDecision({
    candidate, bars, sourceMetadata, apiKey: "test",
    fetchImpl: async () => aiResponse({ ...approve, thesis: "   " })
  });
  assert.equal(emptyThesis.status, "AI_BLOCKED_INVALID_DECISION");
  assert.equal(emptyThesis.approved, false);
  assert.equal(called, false);
});

test("AI review records provider model identity and completion time rather than backdating review", async () => {
  const startedAt = Date.parse(candidate.observedAt) + 1000;
  const completedAt = startedAt + 5000;
  const result = await evaluateAsxAiDecision({
    candidate, bars, sourceMetadata, apiKey: "test",
    model: "requested-model-alias", now: startedAt, clock: () => completedAt,
    fetchImpl: async () => aiResponse(approve, { model: "provider-resolved-model-v2", id: "resp_asx_audit" })
  });
  assert.equal(result.model, "provider-resolved-model-v2");
  assert.equal(result.requestedModel, "requested-model-alias");
  assert.equal(result.reviewPolicyVersion, "ASX_AI_REVIEW_V2");
  assert.equal(result.requestStartedAt, new Date(startedAt).toISOString());
  assert.equal(result.reviewedAt, new Date(completedAt).toISOString());
  assert.equal(result.providerResponseId, "resp_asx_audit");
});

test("AI advisor blocks low confidence, risk flags and non-approval decisions", async () => {
  const low = await evaluateAsxAiDecision({
    candidate, bars, sourceMetadata, apiKey: "test",
    fetchImpl: async () => aiResponse({ ...approve, confidence: 74 })
  });
  assert.equal(low.approved, false);
  const flagged = await evaluateAsxAiDecision({
    candidate, bars, sourceMetadata, apiKey: "test",
    fetchImpl: async () => aiResponse({ ...approve, risk_flags: ["Possible breakout exhaustion"] })
  });
  assert.equal(flagged.approved, false);
  for (const decision of ["REVIEW", "REJECT"]) {
    const result = await evaluateAsxAiDecision({
      candidate, bars, sourceMetadata, apiKey: "test",
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
      candidate, bars, sourceMetadata, apiKey: "test",
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
      candidate: invalidCandidate, bars, sourceMetadata, apiKey: "test",
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
    candidate, bars: barsWithoutVolume, sourceMetadata, apiKey: "test",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return aiResponse(approve);
    }
  });
  assert.equal(result.approved, true);
  assert.equal(result.inputProvenance.volumeBarsAvailable, 0);
  assert.equal(result.inputProvenance.volumeBarsMissing, 30);
  const userContent = requestBody.input[1].content;
  const packet = JSON.parse(userContent.slice(userContent.lastIndexOf("\n\n") + 2));
  assert.equal(packet.recentDailyBars.at(-1).volume, null);
});

test("AI advisor blocks provider errors, redirects and timeouts without approving", async () => {
  const providerError = await evaluateAsxAiDecision({
    candidate, bars, sourceMetadata, apiKey: "test", fetchImpl: async () => new Response("unavailable", { status: 503 })
  });
  assert.equal(providerError.status, "AI_BLOCKED_PROVIDER_ERROR");
  const redirect = await evaluateAsxAiDecision({
    candidate, bars, sourceMetadata, apiKey: "test",
    fetchImpl: async () => ({ ok: true, url: "https://example.com/redirect", text: async () => "{}" })
  });
  assert.equal(redirect.status, "AI_BLOCKED_PROVIDER_REDIRECT");
  const timeout = await evaluateAsxAiDecision({
    candidate, bars, sourceMetadata, apiKey: "test",
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
    timeoutMs: 5
  });
  assert.equal(timeout.status, "AI_BLOCKED_PROVIDER_ERROR");
  assert.equal(timeout.approved, false);
});

test("ASX review identifiers separate model versions for the same candidate and evidence",async()=>{
 const review=async model=>evaluateAsxAiDecision({
  candidate,bars,sourceMetadata,apiKey:"test-only",model,now:Date.parse(candidate.observedAt)+1000,
  fetchImpl:async()=>aiResponse(approve)
 });
 const first=await review("model-a"),second=await review("model-b");
 assert.equal(first.inputProvenance.fingerprint,second.inputProvenance.fingerprint);
 assert.notEqual(first.reviewId,second.reviewId);
 assert.ok(first.reviewId.endsWith(first.inputProvenance.fingerprint.slice(0,16)));
 assert.ok(second.reviewId.endsWith(second.inputProvenance.fingerprint.slice(0,16)));
});
