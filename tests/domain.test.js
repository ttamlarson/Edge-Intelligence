import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMarket, probabilityPercent, formatMoney, convertMoney, formatDateTime, brierScore, normalizeForecasts, calculateBacktest, safeParseStorage, paperSettlement, toggleWatchlist, validateAlertRules } from "../domain.js";

test("provider market normalization keeps quote separate from money and records venue/source", () => {
  const market = normalizeMarket({ id: "kalshi-1", platform: "kalshi", title: "RBA decision", price: { yes_bid: 42, yes_ask: 44, volume: 100, liquidity: 30 } }, { source: "prediction.com", sourceAsOf: "2026-11-13T01:00:00Z" });
  assert.equal(market.probability.yes, 43);
  assert.equal(market.probability.unit, "percent");
  assert.equal(market.currency, null);
  assert.equal(market.volume.unit, "venue_native_unknown");
  assert.equal(market.quoteType, "unverified_venue_quote");
  assert.equal(market.jurisdiction, "unverified");
  assert.equal(market.source, "prediction.com");
});

test("numeric prices and canonical Worker markets survive a second frontend normalization", () => {
  const raw = normalizeMarket({ id: "numeric", title: "Numeric quote", platform: "unknown", price: 42 });
  assert.equal(raw.probability.yes, 42);
  const canonical = normalizeMarket({ id: "canonical", title: "Canonical", venue: "manifold", source: "Manifold public API", quoteType: "play_money_market", currency: "MANA", probability: { yes: 38, bid: 37, ask: 39, unit: "percent" }, volume: { amount: 12, currency: "MANA" }, observedAt: "2026-11-13T00:00:00Z", retrievedAt: "2026-11-13T00:00:01Z" });
  assert.equal(canonical.probability.yes, 38);
  assert.equal(canonical.volume.amount, 12);
  assert.equal(canonical.currency, "MANA");
  assert.equal(canonical.quoteType, "play_money_market");
});

test("Manifold fractional probability is correctly identified as play money", () => {
  const market = normalizeMarket({ id: "m1", platform: "manifold", question: "Question", probability: 0.35, volume: 200 }, { source: "manifold" });
  assert.equal(market.probability.yes, 35);
  assert.equal(market.quoteType, "play_money_market");
  assert.equal(market.volume.currency, null);
});

test("invalid or missing probability is not coerced into zero", () => {
  assert.equal(probabilityPercent(undefined), null);
  assert.equal(probabilityPercent(101), null);
  assert.equal(normalizeMarket({ id: "m", title: "x", platform: "unknown" }).probability.yes, null);
});

test("currency formatter never labels unknown or USD data as AUD", () => {
  assert.equal(formatMoney({ amount: 12, currency: null }), "Currency unavailable");
  assert.match(formatMoney({ amount: 12, currency: "USD" }), /USD/);
  assert.match(formatMoney({ amount: 12, currency: "AUD" }), /AUD/);
  assert.equal(formatMoney({ amount: 12, currency: "MANA" }), "12 MANA (play money)");
});

test("currency conversion requires matching, recent, sourced FX data", () => {
  const now = new Date().toISOString();
  assert.equal(convertMoney(10, "USD", "AUD", null), null);
  assert.equal(convertMoney(10, "USD", "AUD", { base: "AUD", quote: "USD", rate: 1.5, source: "RBA", timestamp: now }), null);
  assert.equal(convertMoney(10, "USD", "AUD", { base: "USD", quote: "AUD", rate: 1.5, source: "RBA", timestamp: now }).amount, 15);
});

test("date formatting supports Perth and Sydney daylight-saving offsets", () => {
  const perth = formatDateTime("2026-01-01T00:00:00Z", "Australia/Perth");
  const sydney = formatDateTime("2026-01-01T00:00:00Z", "Australia/Sydney");
  assert.match(perth, /AWST/);
  assert.match(sydney, /AEDT/);
  assert.notEqual(perth, sydney);
});

test("forecast validation and Brier score use only valid resolved entries", () => {
  const forecasts = normalizeForecasts([{ question: "A", probability: 80, outcome: 1 }, { question: "B", probability: 30, outcome: 0 }, { question: "bad", probability: 300, outcome: 1 }]);
  assert.equal(forecasts.length, 2);
  assert.equal(brierScore(forecasts), ((0.8 - 1) ** 2 + 0.3 ** 2) / 2);
});

test("backtest ignores bad prices, sorts timestamps and avoids zero-price infinities", () => {
  assert.deepEqual(calculateBacktest([{ close: 0 }, { close: "nope" }]).candles, 0);
  const result = calculateBacktest([{ close: 80, timestamp: "2026-01-02T00:00:00Z" }, { close: 100, timestamp: "2026-01-01T00:00:00Z" }]);
  assert.equal(result.first, 100);
  assert.equal(result.last, 80);
  assert.ok(Math.abs(result.buyHoldPct + 20) < 1e-9);
  assert.equal(result.maxDrawdownPct, 20);
});

test("corrupt local storage falls back without overwriting the stored data", () => {
  let raw = "{not json";
  const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
  assert.deepEqual(safeParseStorage(storage, "x", { safe: true }), { safe: true });
  assert.equal(raw, "{not json");
});

test("watchlist add/remove preserves other existing markets and is idempotent by market ID", () => {
  const first = { id: "a", title: "A" }; const second = { id: "b", title: "B" };
  assert.deepEqual(toggleWatchlist([first], second), [second, first]);
  assert.deepEqual(toggleWatchlist([first, second], first), [second]);
  assert.deepEqual(toggleWatchlist([first], first), []);
  assert.deepEqual(toggleWatchlist([first], { title: "missing id" }), [first]);
});

test("alert rule validation rejects non-finite, negative and excessive thresholds", () => {
  assert.deepEqual(validateAlertRules({ minRoi: "3", minSize: "25" }), { minRoi: 3, minSize: 25 });
  for (const input of [{ minRoi: -1, minSize: 10 }, { minRoi: 101, minSize: 10 }, { minRoi: 2, minSize: 10_000_001 }, { minRoi: "NaN", minSize: 10 }]) assert.equal(validateAlertRules(input), null);
});

test("paper trading settlement is virtual, handles YES and NO prices, and rejects bad records", () => {
  assert.deepEqual(paperSettlement({ stake: 100, side: "YES", entryProbability: 40, outcome: 1 }), { winning: true, payout: 250, profitLoss: 150, classification: "simulated_paper_settlement" });
  assert.ok(Math.abs(paperSettlement({ stake: 100, side: "NO", entryProbability: 40, outcome: 0 }).payout - 166.66666666666666) < 1e-10);
  assert.equal(paperSettlement({ stake: 100, side: "YES", entryProbability: 40, outcome: 0 }).profitLoss, -100);
  assert.equal(paperSettlement({ stake: 0, side: "YES", entryProbability: 40, outcome: 1 }), null);
});