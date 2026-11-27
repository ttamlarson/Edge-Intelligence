import test from "node:test";
import assert from "node:assert/strict";
import { fetchDataCedarBars, normalizeDataCedarSymbols, parseDataCedarBars } from "../datacedar.js";

const ts = Date.parse("2026-11-17T00:00:00.000Z");
const row = (overrides = {}) => ({ sid: "asx:BHP", symbol: "BHP", timeframe: "1Day", ts_ms: String(ts), open: 45, high: 47, low: 44, close: 46, volume: "12345", adjustment: "raw", ...overrides });

test("DataCedar ticker input is bounded, normalized and unique", () => {
  assert.deepEqual(normalizeDataCedarSymbols("bhp, CBA"), ["BHP", "CBA"]);
  assert.throws(() => normalizeDataCedarSymbols("BHP,BHP"), /unique/);
  assert.throws(() => normalizeDataCedarSymbols("BHP,CBA,CSL,WES"), /one and three/);
  assert.throws(() => normalizeDataCedarSymbols("BHP;DROP"), /unique/);
});

test("DataCedar bars normalize to the ASX paper engine contract with provenance", () => {
  const result = parseDataCedarBars({ data: { "asx:BHP": [row()] } }, ["BHP"], { retrievedAt: "2026-11-18T00:00:00.000Z", from: "2026-11-01", to: "2026-11-30" });
  assert.equal(result.status, "live");
  assert.equal(result.currency, "AUD");
  assert.equal(result.dataClass, "historical_market_data_not_realtime");
  assert.equal(result.rowsBySymbol.BHP, 1);
  assert.equal(result.barsBySymbol.BHP[0].close, 46);
  assert.equal(result.barsBySymbol.BHP[0].volume, 12345);
  assert.equal(result.barsBySymbol.BHP[0].timestamp, new Date(ts).toISOString());
});

test("DataCedar missing symbol bars are explicit and never fabricated", () => {
  const result = parseDataCedarBars({ data: {} }, ["BHP"]);
  assert.equal(result.status, "no_data");
  assert.deepEqual(result.barsBySymbol.BHP, []);
  assert.equal(result.latestBar, null);
});

test("DataCedar rejects mismatched symbols, invalid OHLC, duplicate dates and out-of-range rows", () => {
  assert.throws(() => parseDataCedarBars({ data: { "asx:BHP": [row({ sid: "asx:CBA" })] } }, ["BHP"]), /mismatched/);
  assert.throws(() => parseDataCedarBars({ data: { "asx:BHP": [row({ high: 43 })] } }, ["BHP"]), /OHLCV/);
  assert.throws(() => parseDataCedarBars({ data: { "asx:BHP": [row(), row()] } }, ["BHP"]), /duplicate/);
  assert.throws(() => parseDataCedarBars({ data: { "asx:BHP": [row()] } }, ["BHP"], { from: "2026-11-18" }), /out-of-range/);
});

test("DataCedar fetch uses the server-side key, ASX batch route and free daily window", async () => {
  let requestedUrl, requestedHeaders;
  const result = await fetchDataCedarBars({
    symbols: ["BHP", "CBA"], apiKey: "server-only-test-key", now: new Date("2026-11-18T00:00:00.000Z"),
    clock: () => new Date("2026-11-18T00:00:03.000Z"),
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url); requestedHeaders = options.headers;
      return new Response(JSON.stringify({ data: { "asx:BHP": [row()], "asx:CBA": [] } }), { headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal(requestedUrl.hostname, "api.datacedar.com");
  assert.equal(requestedUrl.pathname, "/v3/stocks/bars");
  assert.equal(requestedUrl.searchParams.get("symbols"), "asx:BHP,asx:CBA");
  assert.equal(requestedUrl.searchParams.get("timeframe"), "1d");
  assert.equal(requestedUrl.searchParams.get("adjustment"), "raw");
  assert.equal(requestedHeaders["X-API-Key"], "server-only-test-key");
  assert.equal(result.rowsBySymbol.BHP, 1);
  assert.equal(result.rowsBySymbol.CBA, 0);
  assert.equal(result.status, "live");
  assert.equal(result.retrievedAt, "2026-11-18T00:00:03.000Z");
});

test("DataCedar rejects missing key, unexpected redirects, invalid JSON and provider failures", async () => {
  await assert.rejects(fetchDataCedarBars({ symbols: ["BHP"] }), /API key is not configured/);
  await assert.rejects(fetchDataCedarBars({ symbols: ["BHP"], apiKey: "key", fetchImpl: async () => new Response("{}", { headers: { "Content-Type": "application/json" } }) }), /response did not contain/);
  await assert.rejects(fetchDataCedarBars({ symbols: ["BHP"], apiKey: "key", fetchImpl: async () => new Response("<html>") }), /invalid JSON/);
  await assert.rejects(fetchDataCedarBars({ symbols: ["BHP"], apiKey: "key", fetchImpl: async () => ({ url: "https://evil.example/steal", headers: new Headers(), text: async () => "{}" }) }), /unexpected host/);
  await assert.rejects(fetchDataCedarBars({ symbols: ["BHP"], apiKey: "key", fetchImpl: async () => new Response(JSON.stringify({ error: { code: "AUTH_INVALID" } }), { status: 401 }) }), /rejected the API key/);
  await assert.rejects(fetchDataCedarBars({ symbols: ["BHP"], apiKey: "key", fetchImpl: async () => new Response(JSON.stringify({ error: { code: "HISTORY_LIMIT_EXCEEDED" } }), { status: 403 }) }), /plan window/);
});

test("DataCedar accepts only valid date windows within one year", async () => {
  await assert.rejects(fetchDataCedarBars({ symbols: ["BHP"], apiKey: "key", from: "2025-11-01", to: "2026-11-18", now: new Date("2026-11-18T00:00:00Z"), fetchImpl: async () => new Response(JSON.stringify({ data: {} })) }), /maximum 366-day/);
  await assert.rejects(fetchDataCedarBars({ symbols: ["BHP"], apiKey: "key", from: "2026-02-30", now: new Date("2026-11-18T00:00:00Z"), fetchImpl: async () => new Response(JSON.stringify({ data: {} })) }), /valid YYYY-MM-DD/);
});
