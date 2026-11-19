import test from "node:test";
import assert from "node:assert/strict";
import worker from "../index.js";
import { webcrypto } from "node:crypto";

const ORIGIN = "https://edge.example.au";
const access = sub => ({ access: { getIdentity: async () => ({ id: sub }) } });
const limiter = answer => ({ limit: async ({ key }) => ({ success: typeof answer === "function" ? answer(key) : answer }) });
const kv = () => {
  const values = new Map();
  return { values, binding: { get: async key => values.get(key) ?? null, put: async (key, value) => values.set(key, value) } };
};
const baseEnv = extra => ({ FRONTEND_ORIGINS: ORIGIN, DATA_LIMITER: limiter(true), AI_LIMITER: limiter(true), WRITE_LIMITER: limiter(true), ...extra });

test("API fails closed when Cloudflare Access is not configured", async () => {
  const response = await worker.fetch(new Request("https://api.example.au/api/health"), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "Cloudflare Access authentication is not configured.");
});

test("malformed access assertion is rejected", async () => {
  const env = baseEnv({ CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "test-aud" });
  const response = await worker.fetch(new Request("https://api.example.au/api/health", { headers: { "CF-Access-Jwt-Assertion": "not-a-jwt" } }), env);
  assert.equal(response.status, 401);
});

test("unknown frontend origin is rejected and receives no allow-origin header", async () => {
  const response = await worker.fetch(new Request("https://api.example.au/api/health", { headers: { Origin: "https://attacker.example" } }), baseEnv(), access("user-1"));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("CORS preflight only allows the configured frontend and safe headers", async () => {
  const response = await worker.fetch(new Request("https://api.example.au/api/markets", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Headers": "content-type" } }), baseEnv());
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  const denied = await worker.fetch(new Request("https://api.example.au/api/markets", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Headers": "authorization" } }), baseEnv());
  assert.equal(denied.status, 403);
});

test("data routes apply user-keyed rate limits", async () => {
  const env = baseEnv({ DATA_LIMITER: limiter(false), PREDICTION_HUNT_API_KEY: "test-secret" });
  const response = await worker.fetch(new Request("https://api.example.au/api/markets"), env, access("user-1"));
  assert.equal(response.status, 429);
});

test("rate limiter keys are bounded hashes and do not carry the Access subject", async () => {
  let observedKey;
  const env = baseEnv({ DATA_LIMITER: { limit: async ({ key }) => { observedKey = key; return { success: true }; } } });
  const response = await worker.fetch(new Request("https://api.example.au/api/health"), env, access("private-user-subject"));
  assert.equal(response.status, 200);
  assert.match(observedKey, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(observedKey, /private-user-subject/);
});

test("market API maps current quotes and leaves unknown currency unlabelled", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ as_of: new Date().toISOString(), total_count: 1, markets: [{ id: "k-1", market_id: "K-1", platform: "kalshi", title: "RBA cash rate", price: { yes_bid: 41, yes_ask: 43, volume: 900 } }] }), { headers: { "Content-Type": "application/json" } });
  const env = baseEnv({ PREDICTION_HUNT_API_KEY: "test-secret" });
  const response = await worker.fetch(new Request("https://api.example.au/api/markets"), env, access("user-1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.markets[0].probability.yes, 42);
  assert.equal(body.markets[0].currency, null);
  assert.equal(body.markets[0].volume.unit, "venue_native_unknown");
  assert.equal(body.markets[0].jurisdiction, "unverified");
});

test("invalid upstream JSON is returned as a bounded upstream error", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("<html>not json</html>", { status: 200 });
  const response = await worker.fetch(new Request("https://api.example.au/api/markets"), baseEnv({ PREDICTION_HUNT_API_KEY: "test-secret" }), access("user-1"));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /invalid JSON/i);
});

test("Manifold page uses documented search pagination and labels MANA as play money", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requested;
  globalThis.fetch = async input => {
    requested = new URL(input);
    return new Response(JSON.stringify([{ id: "m-1", question: "Will the RBA cut?", probability: 0.38, volume: 100, createdTime: 1790000000000, description: "Rules" }]), { headers: { "Content-Type": "application/json" } });
  };
  const response = await worker.fetch(new Request("https://api.example.au/api/markets?platform=manifold&q=RBA&limit=1"), baseEnv(), access("user-1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(requested.pathname, "/v0/search-markets");
  assert.equal(body.markets[0].probability.yes, 38);
  assert.equal(body.markets[0].quoteType, "play_money_market");
  assert.equal(body.markets[0].volume.currency, "MANA");
  assert.equal(body.next_cursor, "1790000000000");
});

test("alert rules are scoped to the authenticated user", async () => {
  const store = kv(); const env = baseEnv({ EDGE_KV: store.binding });
  const first = await worker.fetch(new Request("https://api.example.au/api/alert-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minRoi: 4, minSize: 50 }) }), env, access("user-a"));
  const second = await worker.fetch(new Request("https://api.example.au/api/alert-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minRoi: 7, minSize: 70 }) }), env, access("user-b"));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(store.values.size, 2);
  const stored = [...store.values.values()].map(JSON.parse);
  assert.deepEqual(stored.map(value => value.minRoi).sort(), [4, 7]);
  store.values.set("latest-scan", JSON.stringify({ opportunities: [
    { roi_pct: 5, max_wager_usd: 60, group_id: "candidate-a" },
    { roi_pct: 8, max_wager_usd: 80, group_id: "candidate-b" }
  ] }));
  const alertsA = await worker.fetch(new Request("https://api.example.au/api/alerts"), env, access("user-a"));
  const alertsB = await worker.fetch(new Request("https://api.example.au/api/alerts"), env, access("user-b"));
  assert.deepEqual((await alertsA.json()).opportunities.map(item => item.group_id), ["candidate-a", "candidate-b"]);
  assert.deepEqual((await alertsB.json()).opportunities.map(item => item.group_id), ["candidate-b"]);
});

test("health, source registry, cached opportunities and alert reads all apply rate limits", async () => {
  const env = baseEnv({ DATA_LIMITER: limiter(false), EDGE_KV: kv().binding });
  for (const path of ["/api/health", "/api/au/sources", "/api/au/aec/results", "/api/opportunities", "/api/alerts"]) {
    const response = await worker.fetch(new Request(`https://api.example.au${path}`), env, access("rate-limited-user"));
    assert.equal(response.status, 429, `${path} must be rate limited`);
  }
});

test("oversized and malformed request bodies are rejected before upstream calls", async () => {
  const oversized = await worker.fetch(new Request("https://api.example.au/api/research", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "70000" }, body: "{}" }), baseEnv(), access("user-1"));
  assert.equal(oversized.status, 413);
  const malformed = await worker.fetch(new Request("https://api.example.au/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" }), baseEnv(), access("user-1"));
  assert.equal(malformed.status, 400);
});

test("research route rejects invalid probability input", async () => {
  const response = await worker.fetch(new Request("https://api.example.au/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "Will RBA cut?", marketPrice: 140 }) }), baseEnv(), access("user-1"));
  assert.equal(response.status, 400);
});

test("manual scan candidates can never be called executable", async () => {
  const env = baseEnv({ PREDICTION_HUNT_API_KEY: "test-secret", EDGE_KV: kv().binding });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ opportunities: [{ roi_pct: 8, max_wager_usd: 100, legs: [{ liquidity_usd: 500, fee_pct: 1 }, { liquidity_usd: 500, fee_pct: 1 }] }] }), { headers: { "Content-Type": "application/json" } });
  try {
    const response = await worker.fetch(new Request("https://api.example.au/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env, access("user-1"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.opportunities[0].screen_status, "RESEARCH_ONLY");
    assert.equal(body.opportunities[0].quality_flags.executable, false);
  } finally { globalThis.fetch = originalFetch; }
});


test("valid signed Cloudflare Access JWT is verified against the team JWK", async t => {
  const oldFetch = globalThis.fetch;
  const pair = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey); jwk.kid = "test-key"; jwk.use = "sig"; jwk.alg = "RS256";
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
  t.after(() => { globalThis.fetch = oldFetch; });
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const claims = encode({ iss: "https://team.cloudflareaccess.com", aud: ["test-aud"], sub: "verified-user", exp: Math.floor(Date.now() / 1000) + 300, nbf: Math.floor(Date.now() / 1000) - 1 });
  const data = `${header}.${claims}`;
  const signature = Buffer.from(await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(data))).toString("base64url");
  const response = await worker.fetch(new Request("https://api.example.au/api/health", { headers: { "CF-Access-Jwt-Assertion": `${data}.${signature}` } }), { ...baseEnv(), CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "test-aud" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "worker_responding");
  const oversizedClaims = encode({ iss: "https://team.cloudflareaccess.com", aud: "test-aud", sub: "x".repeat(257), exp: Math.floor(Date.now() / 1000) + 300 });
  const oversizedData = `${header}.${oversizedClaims}`;
  const oversizedSignature = Buffer.from(await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(oversizedData))).toString("base64url");
  const oversizedResponse = await worker.fetch(new Request("https://api.example.au/api/health", { headers: { "CF-Access-Jwt-Assertion": `${oversizedData}.${oversizedSignature}` } }), { ...baseEnv(), CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "test-aud" });
  assert.equal(oversizedResponse.status, 401);
});

test("AI response schema is validated and market price stays tied to the user-supplied quote", async t => {
  const oldFetch = globalThis.fetch;
  const goodReport = { question: "Will the RBA cut?", summary: "Evidence is mixed.", probability: 55, market_price: 99, edge_points: 99, confidence: "low", yes_case: ["Evidence A"], no_case: ["Evidence B"], base_rates_and_assumptions: ["Assumption"], invalidation: ["New data"], limitations: ["No fills modeled"] };
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(goodReport), output: [{ content: [{ type: "output_text", annotations: [{ type: "url_citation", url_citation: { url: "https://www.rba.gov.au/example", title: "RBA" } }, { type: "url_citation", url_citation: { url: "http://unsafe.example", title: "unsafe" } }] }] }] }), { headers: { "Content-Type": "application/json" } });
  t.after(() => { globalThis.fetch = oldFetch; });
  const response = await worker.fetch(new Request("https://api.example.au/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "Will the RBA cut?", marketPrice: 42 }) }), baseEnv({ OPENAI_API_KEY: "test-secret" }), access("user-1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.report.market_price, 42);
  assert.equal(body.report.edge_points, 13);
  assert.equal(body.citations.length, 1);
});

test("AI response with invalid evidence fields is rejected", async t => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify({ summary: "Bad schema", probability: 44, yes_case: "not an array", no_case: [], base_rates_and_assumptions: [], invalidation: [], limitations: [] }) }), { headers: { "Content-Type": "application/json" } });
  t.after(() => { globalThis.fetch = oldFetch; });
  const response = await worker.fetch(new Request("https://api.example.au/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "Will there be an RBA cut?" }) }), baseEnv({ OPENAI_API_KEY: "test-secret" }), access("user-1"));
  assert.equal(response.status, 502);
});

test("DataCedar status is explicit and does not claim retrieval before a key is configured", async () => {
  const response = await worker.fetch(new Request("https://api.example.au/api/asx/datacedar/status"), baseEnv(), access("user-1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.configured, false);
  assert.equal(body.status, "requires_external_access");
  assert.match(body.message, /DATACEDAR_API_KEY/);
});

test("DataCedar bars route fails closed until the Worker secret is configured", async () => {
  const response = await worker.fetch(new Request("https://api.example.au/api/asx/datacedar/bars?symbols=BHP"), baseEnv(), access("user-1"));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /DATACEDAR_API_KEY/);
});

test("DataCedar bars route validates symbols and returns normalized historical bars", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestedUrl, requestedKey;
  globalThis.fetch = async (url, options) => {
    requestedUrl = new URL(url); requestedKey = options.headers["X-API-Key"];
    const timestamp = String(Date.parse("2026-11-17T00:00:00.000Z"));
    return new Response(JSON.stringify({ data: { "asx:BHP": [{ sid: "asx:BHP", timeframe: "1Day", ts_ms: timestamp, open: 45, high: 47, low: 44, close: 46, volume: "123" }] } }), { headers: { "Content-Type": "application/json" } });
  };
  const env = baseEnv({ DATACEDAR_API_KEY: "server-only-secret" });
  const response = await worker.fetch(new Request("https://api.example.au/api/asx/datacedar/bars?symbols=bhp"), env, access("user-1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(requestedUrl.hostname, "api.datacedar.com");
  assert.equal(requestedKey, "server-only-secret");
  assert.equal(body.source, "DataCedar ASX historical daily bars");
  assert.equal(body.currency, "AUD");
  assert.equal(body.barsBySymbol.BHP[0].close, 46);
  assert.equal(body.dataClass, "historical_market_data_not_realtime");
});

test("DataCedar bars route rejects more than three symbols without calling provider", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let called = false; globalThis.fetch = async () => { called = true; throw new Error("must not call"); };
  const response = await worker.fetch(new Request("https://api.example.au/api/asx/datacedar/bars?symbols=BHP,CBA,CSL,WES"), baseEnv({ DATACEDAR_API_KEY: "key" }), access("user-1"));
  assert.equal(response.status, 400);
  assert.equal(called, false);
});


test("Cloudflare asset proxy serves the Crypto CSV module required by Strategy Lab", async t => {
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async url => {
    requested = String(url);
    return new Response("export function parseBinanceKlineCsv() {}", {
      status: 200, headers: { "Content-Type": "text/javascript" }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await worker.fetch(new Request("https://edge.example.au/crypto-csv.js"), baseEnv());
  assert.equal(response.status, 200);
  assert.match(requested, /edge-intelligence-486\.pages\.dev\/crypto-csv\.js$/);
  assert.match(await response.text(), /parseBinanceKlineCsv/);
});


test("Cloudflare asset proxy serves the breakout strategy module required by Strategy Lab", async t => {
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async url => {
    requested = String(url);
    return new Response("export function backtestRegimeAdaptiveBreakout() {}", {
      status: 200, headers: { "Content-Type": "text/javascript" }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await worker.fetch(new Request("https://edge.example.au/regime-adaptive-breakout.js"), baseEnv());
  assert.equal(response.status, 200);
  assert.match(requested, /edge-intelligence-486\\.pages\\.dev\\/regime-adaptive-breakout\\.js$/);
  assert.match(await response.text(), /backtestRegimeAdaptiveBreakout/);
});
