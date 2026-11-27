import test from "node:test";
import assert from "node:assert/strict";
import { reviewCryptoWalkForward } from "../crypto-ai-advisor.js";

const candles = Array.from({ length: 400 }, (_, i) => {
  const close = 100 + i * 0.08 + Math.sin(i / 5) * 0.7;
  return {
    timestamp: new Date(Date.UTC(2025, 0, 1, i)).toISOString(),
    open: close - 0.1, high: close + 0.5, low: close - 0.5,
    close, volume: 100 + i
  };
});
const now = Date.parse("2026-11-25T08:00:00.000Z");
const base = {
  market: "BTCUSDT", quoteCurrency: "USDT",
  source: "Synthetic test fixture only", candles, now
};
const decision = {
  decision: "ADVANCE_TO_FORWARD_PAPER_REVIEW",
  confidence: 92, evidence_quality: "HIGH",
  thesis: "The fixed-rule folds are internally consistent.",
  counter_thesis: "The sample may be regime-concentrated and costs may be understated.",
  risk_flags: [], limitations: ["Source is a synthetic test fixture."]
};

test("crypto AI review is structured, provenance-bound and cannot override deterministic research gates", async () => {
  let requestBody;
  const result = await reviewCryptoWalkForward({
    ...base, apiKey: "test-only",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ output_text: JSON.stringify(decision) }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.tools, undefined);
  assert.equal(result.modelDecision, "ADVANCE_TO_FORWARD_PAPER_REVIEW");
  assert.equal(result.decision, "HOLD_FOR_MORE_DATA");
  assert.equal(result.status, "AI_HELD_DETERMINISTIC_GATE_NOT_MET");
  assert.equal(result.advanceAllowed, false);
  assert.equal(result.deterministicGateMet, false);
  assert.equal(result.liveTradingEnabled, false);
  assert.equal(result.research.summary.assessment, "INSUFFICIENT_OUT_OF_SAMPLE_TRADES");
  assert.match(result.inputProvenance.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.inputProvenance.fingerprintScope, "FULL_VALIDATED_DATASET_FIXED_RESEARCH_ASSUMPTIONS_AND_REVIEW_POLICY");
  assert.equal(result.inputProvenance.reviewPolicyVersion, "CRYPTO_RESEARCH_REVIEW_V2");
  assert.equal(result.inputProvenance.sourceType, "USER_SUPPLIED_OR_EXTERNAL_HISTORICAL_OHLCV");
  assert.equal(result.inputProvenance.dataClass, "HISTORICAL_OHLCV_NOT_REALTIME");
  assert.ok(result.reviewId.endsWith(result.inputProvenance.fingerprint));
  assert.equal(result.inputProvenance.sourceVerification, "NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(result.inputProvenance.barsReviewed, 50);
  assert.doesNotMatch(requestBody.input[1].content, /strategyComparison/);
});


test("crypto AI review records provider model identity and completion chronology", async () => {
  const startedAt = now + 1000, completedAt = now + 5000;
  const times = [startedAt, completedAt];
  const result = await reviewCryptoWalkForward({
    ...base, apiKey: "test-only", now,
    clock: () => times.shift(),
    fetchImpl: async () => new Response(JSON.stringify({
      model: "provider-resolved-crypto-model-v3", id: "resp_crypto_audit",
      output_text: JSON.stringify(decision)
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  assert.equal(result.model, "provider-resolved-crypto-model-v3");
  assert.equal(result.requestedModel, "gpt-6.2-astra");
  assert.equal(result.reviewPolicyVersion, "CRYPTO_RESEARCH_REVIEW_V2");
  assert.equal(result.requestStartedAt, new Date(startedAt).toISOString());
  assert.equal(result.reviewedAt, new Date(completedAt).toISOString());
  assert.equal(result.inputProvenance.reviewRequestStartedAt, result.requestStartedAt);
  assert.equal(result.providerResponseId, "resp_crypto_audit");
});

test("crypto AI review fails closed on a completion clock earlier than request start", async () => {
  const times = [now + 5000, now + 1000];
  const result = await reviewCryptoWalkForward({
    ...base, apiKey: "test-only", now, clock: () => times.shift(),
    fetchImpl: async () => new Response(JSON.stringify({
      output_text: JSON.stringify(decision)
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  assert.equal(result.status, "AI_BLOCKED_PROVENANCE_ERROR");
  assert.equal(result.advanceAllowed, false);
  assert.equal(result.retryable, true);
});

test("crypto AI review fails closed when the model key is missing", async () => {
  let called = false;
  const result = await reviewCryptoWalkForward({
    ...base, fetchImpl: async () => { called = true; }
  });
  assert.equal(result.status, "AI_BLOCKED_NOT_CONFIGURED");
  assert.equal(result.advanceAllowed, false);
  assert.equal(result.retryable, true);
  assert.equal(called, false);
});

test("crypto AI review rejects future, incomplete and oversized data before provider calls", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; };
  const shifted = candles.map((bar, index) => ({
    ...bar,
    timestamp: new Date(Date.parse("2026-11-25T07:00:00.000Z") - (candles.length - 1 - index) * 3600000).toISOString()
  }));
  const result = await reviewCryptoWalkForward({
    ...base, candles: shifted, now: Date.parse("2026-11-25T06:00:00.000Z"),
    apiKey: "test-only", fetchImpl
  });
  assert.equal(result.status, "AI_BLOCKED_INVALID_INPUT");
  assert.match(result.reason, /future-dated/i);
  const incompleteResult = await reviewCryptoWalkForward({
    ...base, candles: shifted, now: Date.parse("2026-11-25T07:30:00.000Z"),
    apiKey: "test-only", fetchImpl
  });
  assert.equal(incompleteResult.status, "AI_BLOCKED_INVALID_INPUT");
  assert.match(incompleteResult.reason, /incomplete/i);
  const oversized = Array.from({ length: 5001 }, (_, i) => candles[i % candles.length]);
  const oversizedResult = await reviewCryptoWalkForward({
    ...base, candles: oversized, apiKey: "test-only", fetchImpl
  });
  assert.equal(oversizedResult.status, "AI_BLOCKED_INVALID_INPUT");
  assert.equal(calls, 0);
});

test("crypto AI provider and schema failures remain retryable and never advance research", async () => {
  const unavailable = await reviewCryptoWalkForward({
    ...base, apiKey: "test-only",
    fetchImpl: async () => new Response("unavailable", { status: 503 })
  });
  assert.equal(unavailable.status, "AI_BLOCKED_PROVIDER_ERROR");
  assert.equal(unavailable.advanceAllowed, false);
  assert.equal(unavailable.retryable, true);
  const malformed = await reviewCryptoWalkForward({
    ...base, apiKey: "test-only",
    fetchImpl: async () => new Response(JSON.stringify({ output_text: JSON.stringify({ decision: "APPROVE" }) }), { status: 200 })
  });
  assert.equal(malformed.status, "AI_BLOCKED_INVALID_DECISION");
  assert.equal(malformed.advanceAllowed, false);
  assert.equal(malformed.retryable, true);
  const weakAnalysis = await reviewCryptoWalkForward({
    ...base, apiKey: "test-only",
    fetchImpl: async () => new Response(JSON.stringify({
      output_text: JSON.stringify({ ...decision, thesis: " ", counter_thesis: "too short" })
    }), { status: 200 })
  });
  assert.equal(weakAnalysis.status, "AI_BLOCKED_INVALID_DECISION");
  assert.equal(weakAnalysis.advanceAllowed, false);
});

test("crypto review identifiers separate model versions while retaining full-data provenance",async()=>{
 const review=async actualModel=>reviewCryptoWalkForward({
  ...base,apiKey:"test-only",model:"provider-model-alias",
  fetchImpl:async()=>new Response(JSON.stringify({model:actualModel,id:"resp_"+actualModel,output_text:JSON.stringify(decision)}),{status:200,headers:{"Content-Type":"application/json"}})
 });
 const first=await review("provider-model-v1"),second=await review("provider-model-v2");
 assert.equal(first.inputProvenance.fingerprint,second.inputProvenance.fingerprint);
 assert.equal(first.requestedModel,second.requestedModel);
 assert.notEqual(first.model,second.model);
 assert.notEqual(first.reviewId,second.reviewId);
 assert.ok(first.reviewId.endsWith(first.inputProvenance.fingerprint));
});
