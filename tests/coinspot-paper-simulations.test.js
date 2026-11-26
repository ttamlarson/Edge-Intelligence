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
    quote: { pair: "BTC/AUD", bid, ask, last: 100050, spreadBps: (ask - bid) / ((ask + bid) / 2) * 10000 },
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
    quote: { pair: "BTC/AUD", bid, ask, last: bid, spreadBps: (ask - bid) / ((ask + bid) / 2) * 10000 },
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

test("AI advisory simulation reviews a deterministic paper candidate but cannot authorise exchange orders", async () => {
  const candidate = validCandidate(), previousFetch = globalThis.fetch, writes = [];
  const kv = { get: async () => null, put: async (key, value) => writes.push({ key, value }) };
  let requestBody;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      assessment: "CAUTION",
      summary: "Synthetic test response: verify market context and execution assumptions; deterministic safeguards remain authoritative.",
      riskFlags: ["Synthetic fixture only; not a live market assessment."]
    }) }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const review = await __test.reviewCoinSpotMtfCandidate({
      OPENAI_API_KEY: "test-only-placeholder", OPENAI_MODEL: "test-model", EDGE_KV: kv
    }, candidate);
    assert.equal(review.status, "AI_REVIEW_COMPLETE");
    assert.equal(review.assessment, "CAUTION");
    assert.equal(review.advisoryOnly, true);
    assert.equal(requestBody.text.format.name, "edge_coinspot_signal_review");
    assert.match(requestBody.input[0].content, /do not authorise execution/i);
    assert.equal(writes.length, 1);
    assert.equal(candidate.signal.execution.orderIntent, "NONE");
    const account = processMtfPaperAccount(createMtfPaperAccount(openedAt), { markets: [candidate], now: openedAt });
    assert.ok(account.openPosition);
    assert.equal(account.openPosition.pair, "BTC/AUD");
    assert.equal(account.liveTradingEnabled, false);
    assert.equal(account.paperOnly, true);
  } finally { globalThis.fetch = previousFetch; }
});
