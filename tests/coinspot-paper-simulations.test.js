import test from "node:test";
import assert from "node:assert/strict";
import { MTF_PAPER_CONFIG, createMtfPaperAccount, processMtfPaperAccount, validateMtfPaperAccount } from "../coinspot-mtf-paper.js";
import { __test } from "../index.js";

const openedAt = "2026-11-26T08:00:00.000Z";
const signalAt = "2026-11-26T04:00:00.000Z";
const now = "2026-11-26T09:00:00.000Z";

function validCandidate() {
  const bid = 100000, ask = 100100;
  return {
    coin: "BTC", pair: "BTC/AUD",
    quote: { pair: "BTC/AUD", bid, ask, last: 100050, spreadBps: (ask - bid) / ((ask + bid) / 2) * 10000, retrievedAt: openedAt },
    signal: {
      strategy: "EDGE_MTF_DONCHIAN_ENSEMBLE_V1", status: "BUY_CANDIDATE_PAPER_ONLY",
      signalAt, entryModel: "DONCHIAN_BREAKOUT",
      indicators: { breakoutVotes: 3, atr20: 1000 }, risk: { initialStopDistance: 2500 },
      checks: { dailyTrend: true, fourHourTrend: true, positiveLongTrendSlope: true, breakoutVotes: true,
        pullbackReclaim: false, entryTrigger: true, liquidity: true, volatility: true },
      execution: { orderIntent: "NONE", paperOnly: true, liveTradingEnabled: false }
    }
  };
}

test("controlled simulation completes a full paper buy-to-stop-exit lifecycle with fee and slippage accounting", () => {
  const candidate = validCandidate();
  let account = processMtfPaperAccount(createMtfPaperAccount(openedAt), { markets: [candidate], now: openedAt });
  assert.ok(account.openPosition);
  assert.equal(account.openPosition.pair, "BTC/AUD");
  assert.ok(account.cashAud < 100 && account.openPosition.entryFeeAud > 0 && account.unrealizedPnlAud < 0);
  assert.equal(account.liveTradingEnabled, false);
  const stop = account.openPosition.stopPrice;
  const bid = stop * 0.99, ask = stop * 0.991;
  const exitMarket = { ...candidate,
    quote: { pair: "BTC/AUD", bid, ask, last: bid, spreadBps: (ask - bid) / ((ask + bid) / 2) * 10000, retrievedAt: now },
    signal: { ...candidate.signal, status: "NO_TRADE", checks: { dailyTrend: true, fourHourTrend: true } }
  };
  account = processMtfPaperAccount(account, { markets: [exitMarket], now });
  assert.equal(account.openPosition, null);
  assert.equal(account.closedTrades.length, 1);
  const trade = account.closedTrades[0];
  assert.equal(trade.reason, "TRAILING_STOP");
  assert.equal(trade.pair, "BTC/AUD");
  assert.ok(trade.entryFeeAud > 0 && trade.exitFeeAud > 0 && trade.exitPrice < trade.entryPrice && trade.pnlAud < 0);
  assert.equal(account.liveTradingEnabled, false);
  assert.equal(account.paperOnly, true);
  assert.equal(validateMtfPaperAccount(account), true);
  assert.equal(account.equityAud, account.cashAud);
  assert.ok(account.dailyLossAud < MTF_PAPER_CONFIG.maxDailyLossAud);
});

test("new MTF paper entries fail closed without a valid LOW_CONCERN AI review; existing positions remain managed", async () => {
  const candidate = validCandidate(), previousFetch = globalThis.fetch;
  const cache = new Map(), writes = [];
  const kv = { get: async key => cache.get(key) ?? null,
    put: async (key, value) => { cache.set(key, value); writes.push({ key, value }); } };
  const env = { OPENAI_API_KEY: "test-only-placeholder", OPENAI_MODEL: "test-model", EDGE_KV: kv };
  const response = assessment => new Response(JSON.stringify({ output_text: JSON.stringify({
    assessment, summary: "Synthetic test response: review only the supplied deterministic signal and risk constraints.",
    riskFlags: ["Synthetic fixture only; not a live market assessment."]
  }) }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    let aiCalls = 0, requestBody;
    globalThis.fetch = async (url, options = {}) => {
      aiCalls++; assert.equal(String(url), "https://api.openai.com/v1/responses");
      requestBody = JSON.parse(options.body); return response("CAUTION");
    };
    const cautious = await __test.reviewCoinSpotMtfCandidate(env, candidate);
    assert.equal(cautious.status, "AI_REVIEW_COMPLETE");
    assert.equal(cautious.assessment, "CAUTION");
    assert.equal(cautious.advisoryOnly, true);
    assert.equal(requestBody.text.format.name, "edge_coinspot_signal_review");
    assert.match(requestBody.input[0].content, /do not authorise execution/i);
    assert.equal(writes.length, 1);
    assert.equal(requestBody.input[1].content.includes("100000"), false);
    const blocked = __test.applyCoinSpotMtfAiGate([candidate], [{ coin: "BTC", review: cautious }]);
    assert.equal(blocked.gates.BTC, "AI_BLOCKED");
    const blockedAccount = processMtfPaperAccount(createMtfPaperAccount(openedAt), { markets: blocked.markets, now: openedAt });
    assert.equal(blockedAccount.openPosition, null);
    assert.equal(blockedAccount.cashAud, 100);
    assert.equal(blockedAccount.liveTradingEnabled, false);
    assert.equal(blockedAccount.paperOnly, true);
    const cached = await __test.reviewCoinSpotMtfCandidate(env, candidate);
    assert.equal(cached.assessment, "CAUTION");
    assert.equal(aiCalls, 1);

    const changed = validCandidate();
    changed.quote.ask = 100200; changed.quote.last = 100100;
    changed.quote.spreadBps = (changed.quote.ask - changed.quote.bid) / ((changed.quote.ask + changed.quote.bid) / 2) * 10000;
    globalThis.fetch = async (url, options = {}) => {
      aiCalls++; requestBody = JSON.parse(options.body); return response("LOW_CONCERN");
    };
    const approvedReview = await __test.reviewCoinSpotMtfCandidate(env, changed);
    assert.equal(aiCalls, 2, "a changed spread must receive a fresh review");
    assert.equal(__test.isValidCoinSpotMtfAiReview(approvedReview), true);
    const approved = __test.applyCoinSpotMtfAiGate([changed], [{ coin: "BTC", review: approvedReview }]);
    assert.equal(approved.gates.BTC, "AI_APPROVED");
    const account = processMtfPaperAccount(createMtfPaperAccount(openedAt), { markets: approved.markets, now: openedAt });
    assert.ok(account.openPosition);
    assert.equal(account.openPosition.pair, "BTC/AUD");
    assert.equal(account.liveTradingEnabled, false);
    assert.equal(account.paperOnly, true);
    assert.equal(changed.signal.execution.orderIntent, "NONE");

    const blockedExisting = __test.applyCoinSpotMtfAiGate([changed], [{ coin: "BTC", review: { ...approvedReview, assessment: "CAUTION" } }]);
    assert.equal(blockedExisting.gates.BTC, "AI_BLOCKED");
    const stop = account.openPosition.stopPrice, bid = stop * 0.99, ask = bid * 1.001;
    const exitMarket = { ...blockedExisting.markets[0], quote: {
      pair: "BTC/AUD", bid, ask, last: bid, spreadBps: (ask - bid) / ((ask + bid) / 2) * 10000, retrievedAt: now
    } };
    const closed = processMtfPaperAccount(account, { markets: [exitMarket], now });
    assert.equal(closed.openPosition, null, "AI veto must not disable existing-position stop management");
    assert.equal(closed.closedTrades.length, 1);
    assert.equal(closed.closedTrades[0].reason, "TRAILING_STOP");
    assert.ok(closed.closedTrades[0].entryFeeAud > 0 && closed.closedTrades[0].exitFeeAud > 0);
    assert.ok(closed.closedTrades[0].pnlAud < 0);
    assert.equal(closed.paperOnly, true);
    assert.equal(closed.liveTradingEnabled, false);
    assert.equal(validateMtfPaperAccount(closed), true);

    const notConfigured = await __test.reviewCoinSpotMtfCandidate({ EDGE_KV: kv }, candidate);
    assert.equal(notConfigured.status, "AI_REVIEW_NOT_CONFIGURED");
    assert.equal(__test.applyCoinSpotMtfAiGate([candidate], [{ coin: "BTC", review: notConfigured }]).gates.BTC, "AI_BLOCKED");
    assert.equal(__test.applyCoinSpotMtfAiGate([candidate], [{ coin: "BTC", review: { ...approvedReview, assessment: "HIGH_CONCERN" } }]).gates.BTC, "AI_BLOCKED");
    assert.equal(__test.applyCoinSpotMtfAiGate([candidate], [{ coin: "BTC", review: { ...approvedReview, riskFlags: [123] } }]).gates.BTC, "AI_BLOCKED");

    globalThis.fetch = async () => new Response("{}", { status: 503 });
    const providerError = await __test.reviewCoinSpotMtfCandidate({ ...env, EDGE_KV: { get: async () => null, put: async () => {} } }, candidate);
    assert.equal(providerError.status, "AI_REVIEW_PROVIDER_ERROR");
    assert.equal(__test.applyCoinSpotMtfAiGate([candidate], [{ coin: "BTC", review: providerError }]).gates.BTC, "AI_BLOCKED");

    globalThis.fetch = async () => new Response(JSON.stringify({ output_text: "not valid JSON" }), { status: 200 });
    const malformedResponse = await __test.reviewCoinSpotMtfCandidate({ ...env, EDGE_KV: { get: async () => null, put: async () => {} } }, candidate);
    assert.equal(malformedResponse.status, "AI_REVIEW_UNAVAILABLE");
    assert.equal(__test.applyCoinSpotMtfAiGate([candidate], [{ coin: "BTC", review: malformedResponse }]).gates.BTC, "AI_BLOCKED");

    const noSignal = { ...candidate, signal: { ...candidate.signal, status: "NO_TRADE" } };
    const notRequired = __test.applyCoinSpotMtfAiGate([noSignal], []);
    assert.equal(notRequired.gates.BTC, "NOT_REQUIRED");
    assert.equal(notRequired.markets[0], noSignal);
    assert.equal(candidate.signal.execution.orderIntent, "NONE");
  } finally { globalThis.fetch = previousFetch; }
});
