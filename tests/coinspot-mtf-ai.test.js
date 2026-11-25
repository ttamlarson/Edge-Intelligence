import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

function candidate(status = "BUY_CANDIDATE_PAPER_ONLY") {
  return {
    coin: "BTC",
    pair: "BTC/AUD",
    quote: { bid: 90000, ask: 90010, last: 90005, spreadBps: 1.11 },
    signal: {
      strategy: "EDGE_MTF_DONCHIAN_ENSEMBLE_V1",
      status,
      signalAt: "2026-11-25T08:00:00.000Z",
      checks: {
        dailyTrend: true,
        fourHourTrend: true,
        positiveLongTrendSlope: true,
        breakoutVotes: true,
        liquidity: true,
        volatility: true
      },
      indicators: { atr20: 500, breakoutVotes: 3 },
      risk: {
        initialStopDistance: 1250,
        maximumNotionalAllocationPct: 25,
        riskBudgetPct: 0.5
      },
      execution: { orderIntent: "NONE", paperOnly: true, liveTradingEnabled: false }
    }
  };
}

function kvStore() {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    binding: {
      get: async key => values.get(key) ?? null,
      put: async (key, value, options) => {
        values.set(key, value);
        writes.push({ key, options });
      }
    }
  };
}

test("CoinSpot AI review skips the provider when there is no deterministic paper candidate", async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("AI provider must not be called"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await __test.reviewCoinSpotMtfCandidate(
    { OPENAI_API_KEY: "test-key" },
    candidate("NO_TRADE")
  );

  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("CoinSpot AI review uses the configured Responses model and strict structured output", async t => {
  const originalFetch = globalThis.fetch;
  const store = kvStore();
  const review = {
    assessment: "CAUTION",
    summary: "The deterministic setup is valid, but execution costs and concentration remain material.",
    riskFlags: ["Advisory review only; deterministic controls remain authoritative."]
  };
  let calls = 0;
  let request;
  globalThis.fetch = async (url, init = {}) => {
    calls++;
    request = { url: String(url), init };
    return new Response(JSON.stringify({ output_text: JSON.stringify(review) }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = {
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-6.2-astra",
    EDGE_KV: store.binding
  };
  const result = await __test.reviewCoinSpotMtfCandidate(env, candidate());

  assert.equal(result.status, "AI_REVIEW_COMPLETE");
  assert.equal(result.assessment, "CAUTION");
  assert.equal(result.advisoryOnly, true);
  assert.deepEqual(result.riskFlags, review.riskFlags);
  assert.equal(calls, 1);
  assert.equal(request.url, "https://api.openai.com/v1/responses");

  const body = JSON.parse(request.init.body);
  assert.equal(body.model, "gpt-6.2-astra");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.name, "edge_coinspot_signal_review");
  assert.equal(body.input[0].role, "system");
  assert.match(body.input[0].content, /Do not authorise execution/i);
  assert.match(body.input[0].content, /Do not change any strategy, position size, fee or risk rule/i);

  const cacheKey = "coinspot-mtf-ai-review:BTC:2026-11-25T08:00:00.000Z";
  assert.ok(store.values.has(cacheKey));
  assert.equal(store.writes[0].key, cacheKey);
  assert.equal(store.writes[0].options.expirationTtl, 86400);

  const cached = await __test.reviewCoinSpotMtfCandidate(env, candidate());
  assert.equal(cached.status, "AI_REVIEW_COMPLETE");
  assert.equal(calls, 1, "cached advisory review must avoid a duplicate provider call");
});

test("CoinSpot AI provider errors remain advisory and do not throw", async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await __test.reviewCoinSpotMtfCandidate(
    { OPENAI_API_KEY: "test-key", EDGE_KV: kvStore().binding },
    candidate()
  );

  assert.equal(result.status, "AI_REVIEW_PROVIDER_ERROR");
  assert.match(result.summary, /HTTP 429/);
  assert.equal(result.advisoryOnly, undefined);
});

test("CoinSpot AI malformed structured output fails closed to unavailable advisory status", async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: "{not-json" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await __test.reviewCoinSpotMtfCandidate(
    { OPENAI_API_KEY: "test-key", EDGE_KV: kvStore().binding },
    candidate()
  );

  assert.equal(result.status, "AI_REVIEW_UNAVAILABLE");
  assert.equal(result.advisoryOnly, undefined);
  assert.deepEqual(result.riskFlags, []);
});

test("CoinSpot AI review reports missing configuration without making a provider request", async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("AI provider must not be called"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await __test.reviewCoinSpotMtfCandidate({}, candidate());

  assert.equal(result.status, "AI_REVIEW_NOT_CONFIGURED");
  assert.equal(calls, 0);
});
