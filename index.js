import { calculateBacktest, finiteNumber, normalizeMarket, validateAlertRules } from "./domain.js";
import { aecIntegrationStatus, fetchAbsIndicators, fetchAecResults, fetchBomObservations, fetchRbaCashRate, fetchRbaReleases, sourceMetadata } from "./au-sources.js";
import { fetchDataCedarBars, normalizeDataCedarSymbols } from "./datacedar.js";
import { readAsxAutopilot, runAsxAutopilot } from "./asx-autopilot.js";
import { reviewCryptoWalkForward } from "./crypto-ai-advisor.js";
import { normalizeCoinSpotMarket, calculateCoinSpotSpreadBps } from "./coinspot.js";
import { normalizeCoinSpotCompletedOrders, aggregateCoinSpotTrades, mergeCoinSpotCandles, coinSpotHistoryRangeParams, COINSPOT_INTERVALS } from "./coinspot-history.js";
import { evaluateEdgeBreakoutSignal, latestContiguousCandleRun } from "./edge-mtf-breakout-strategy.js";
import { createMtfPaperAccount, processMtfPaperAccount, validateMtfPaperAccount } from "./coinspot-mtf-paper.js";
import { createCoinSpotPaperAccount, normalizePaperAccount, openCoinSpotPaperPosition, closeCoinSpotPaperPosition, markCoinSpotPaperAccount } from "./coinspot-paper.js";
import { AUTO_SYMBOLS, calculateAutoPaperPerformance, createAutoPaperAccount, normalizeAutoPaperAccount, validateAutoPaperAccount, evaluateAutoSignal, processAutoPaperSignals } from "./crypto-auto-paper.js";
import { normalizeBinanceHourlyKlines } from "./binance-market-data.js";

const PRED_BASE = "https://prediction.com/api/v2";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ANALYZE_BYTES = 7 * 1024 * 1024;
const SECURITY_HEADERS = {
  "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Strict-Transport-Security": "max-age=31536000"
};
let accessKeysCache = null;
let accessKeysCacheAt = 0;
let accessKeysPending = null;
let lastCoinSpotNonce = 0;
const COINSPOT_READONLY_PATHS = new Set(["/status", "/orders/market/completed", "/my/balances", "/my/orders/market/open"]);
const COINSPOT_READONLY_TIMEOUT_MS = 15_000;
const COINSPOT_READONLY_MAX_ATTEMPTS = 2;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const isoNow = () => new Date().toISOString();

function configuredOrigins(env) {
  return String(env.FRONTEND_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean).map(value => {
    try { const url = new URL(value); return url.origin === value && (url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname)) ? value : null; }
    catch { return null; }
  }).filter(Boolean);
}
function corsHeaders(origin, env) {
  if (!origin || !configuredOrigins(env).includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600", "Vary": "Origin"
  };
}
function json(data, status = 200, origin = null, env = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...SECURITY_HEADERS, ...corsHeaders(origin, env) } });
}
function decodeBase64Url(part) {
  const value = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
function decodeJwtPart(part) { return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))); }

async function fetchAccessKeys(teamDomain) {
  if (accessKeysCache && Date.now() - accessKeysCacheAt < 10 * 60 * 1000) return accessKeysCache;
  if (accessKeysPending) return accessKeysPending;
  accessKeysPending = (async () => {
    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new HttpError(503, "Authentication service temporarily unavailable.");
    const body = await response.json();
    if (!Array.isArray(body?.keys) || !body.keys.length) throw new HttpError(503, "Authentication service temporarily unavailable.");
    accessKeysCache = body.keys; accessKeysCacheAt = Date.now(); return accessKeysCache;
  })();
  try { return await accessKeysPending; } finally { accessKeysPending = null; }
}

async function authenticate(request, env, ctx) {
  if (ctx?.access) {
    const identity = await ctx.access.getIdentity();
    const subject = identity?.id || identity?.sub;
    if (subject) return { sub: String(subject) };
  }
  const teamDomain = String(env.CF_ACCESS_TEAM_DOMAIN || "").trim().toLowerCase();
  const audience = String(env.CF_ACCESS_AUD || "").trim();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain) || !audience) throw new HttpError(503, "Cloudflare Access authentication is not configured.");
  const token = request.headers.get("CF-Access-Jwt-Assertion") || "";
  if (!token || token.length > 16_384) throw new HttpError(401, "Authentication required.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Authentication required.");
  try {
    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    const now = Date.now() / 1000;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 256 || claims.iss !== `https://${teamDomain}` || !aud.includes(audience) || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 256 || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf != null && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60))) throw new HttpError(401, "Authentication required.");
    const jwk = (await fetchAccessKeys(teamDomain)).find(key => key.kid === header.kid && key.kty === "RSA" && key.use !== "enc");
    if (!jwk) throw new HttpError(401, "Authentication required.");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!verified) throw new HttpError(401, "Authentication required.");
    return { sub: claims.sub };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Authentication required.");
  }
}

async function routeLimit(binding, userId, route) {
  if (!binding || typeof binding.limit !== "function") throw new HttpError(503, "Route rate limiting is not configured.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}:${route}`));
  const key = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const result = await binding.limit({ key });
  if (!result?.success) throw new HttpError(429, "Rate limit exceeded. Try again shortly.");
}

async function readJson(request, maxBytes = MAX_JSON_BYTES) {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json.");
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > maxBytes) throw new HttpError(413, "Request body is too large.");
  if (!request.body) return {};
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, "Request body is too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object.");
    return parsed;
  } catch { throw new HttpError(400, "Request body must be a JSON object."); }
}

async function userKey(prefix, subject) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${hex}`;
}

async function providerJson(url, init = {}, maxBytes = 4 * 1024 * 1024) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (response.url && new URL(response.url).hostname !== new URL(url).hostname) throw new HttpError(502, "Upstream redirected to an unexpected host.");
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > maxBytes) throw new HttpError(502, "Upstream response exceeded the size limit.");
  const text = await readLimitedText(response, maxBytes, () => new HttpError(502, "Upstream response exceeded the size limit."));
  let payload;
  try { payload = JSON.parse(text); } catch { throw new HttpError(502, "Upstream returned invalid JSON."); }
  if (!response.ok) throw new HttpError(502, `Upstream request failed with HTTP ${response.status}.`);
  return payload;
}

async function readLimitedText(response, maxBytes, makeTooLarge) {
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw makeTooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function coinSpotDiagnostic(status, message) {
  const detail = String(message || "").toLowerCase();
  if (/nonce/.test(detail)) return "CoinSpot rejected the request nonce. EDGE generated a fresh nonce; retry once. If this persists, another client may be sharing this API key.";
  if (/sign|hmac|signature/.test(detail)) return "CoinSpot rejected the request signature. Check that the API key and secret are the matching pair and contain no extra characters.";
  if (/key|auth|unauthori[sz]ed|credential/.test(detail) || status === 401) return "CoinSpot rejected the API key. Confirm it is active, email-confirmed, Read Only, and paired with its matching secret.";
  if (/permission|access|forbidden/.test(detail) || status === 403) return "CoinSpot denied access to this Read Only endpoint. Check the API key permissions in CoinSpot.";
  return `CoinSpot rejected the authenticated request (HTTP ${status || "unknown"}). Check that the API key is active and email-confirmed, and that the key and secret match.`;
}

let coinSpotRequestQueue = Promise.resolve();

function coinSpotReadOnly(env, path, extra = {}) {
  // CoinSpot requires strictly increasing nonces. Serialize requests using the
  // same API key so parallel balance/order calls cannot arrive out of order.
  const run = coinSpotRequestQueue.then(() => coinSpotReadOnlyNow(env, path, extra));
  coinSpotRequestQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function coinSpotReadOnlyNow(env, path, extra = {}) {
  const key = String(env.COINSPOT_READONLY_KEY || "").trim();
  const secret = String(env.COINSPOT_READONLY_SECRET || "").trim();
  if (!key || !secret) throw new HttpError(503, "CoinSpot read-only API credentials are not configured.");
  if (!COINSPOT_READONLY_PATHS.has(path)) throw new HttpError(403, "CoinSpot adapter only permits read-only status, balance, open-order and completed-market-history endpoints.");

  let response = null;
  let transportError = null;
  for (let attempt = 0; attempt < COINSPOT_READONLY_MAX_ATTEMPTS; attempt++) {
    // A timed-out request may have reached CoinSpot. Every retry therefore
    // receives a fresh, strictly increasing nonce and matching HMAC signature.
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const nonce = Math.max(Date.now() * 1000 + (random[0] % 1000), lastCoinSpotNonce + 1);
    lastCoinSpotNonce = nonce;
    const body = JSON.stringify({ ...extra, nonce });
    const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(body));
    const sign = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");

    try {
      response = await fetch("https://www.coinspot.com.au/api/v2/ro" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", key, sign, Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(COINSPOT_READONLY_TIMEOUT_MS)
      });
      transportError = null;
      break;
    } catch (error) {
      transportError = error;
      if (attempt + 1 < COINSPOT_READONLY_MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }

  if (!response) {
    const errorName = String(transportError?.name || "");
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      throw new HttpError(504, `COINSPOT_TIMEOUT: CoinSpot read-only request timed out after ${COINSPOT_READONLY_MAX_ATTEMPTS} attempts.`);
    }
    throw new HttpError(502, `COINSPOT_NETWORK_ERROR: CoinSpot read-only endpoint could not be reached after ${COINSPOT_READONLY_MAX_ATTEMPTS} attempts.`);
  }
  if (response.url && new URL(response.url).hostname !== "www.coinspot.com.au") throw new HttpError(502, "CoinSpot redirected to an unexpected host.");
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 512 * 1024) throw new HttpError(502, "CoinSpot response exceeded the size limit.");
  const raw = await readLimitedText(response, 512 * 1024, () => new HttpError(502, "CoinSpot response exceeded the size limit."));
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new HttpError(502, "CoinSpot returned an invalid response."); }
  if (!response.ok || payload?.status !== "ok") throw new HttpError(502, coinSpotDiagnostic(response.status, payload?.message));
  return payload;
}

async function prediction(env, path) {
  if (!env.PREDICTION_HUNT_API_KEY) throw new HttpError(503, "Prediction.com API key is not configured.");
  const data = await providerJson(`${PRED_BASE}${path}`, { headers: { "X-API-Key": env.PREDICTION_HUNT_API_KEY, Accept: "application/json" } });
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(502, "Prediction.com response shape was invalid.");
  return data;
}

function normalizePredictionMarket(market, sourceAsOf, retrievedAt) {
  return publicMarket(normalizeMarket(market, { source: "Prediction.com API", sourceAsOf, retrievedAt }));
}

function publicMarket(market) {
  const settlement = typeof market.settlement === "string" ? market.settlement.slice(0, 20_000) : market.settlement && typeof market.settlement === "object" ? Object.fromEntries(Object.entries(market.settlement).slice(0, 10).map(([key, value]) => [String(key).slice(0, 80), typeof value === "string" ? value.slice(0, 5000) : null])) : null;
  return { id: market.id, marketId: market.marketId, title: market.title.slice(0, 1000), venue: market.venue, source: market.source, quoteType: market.quoteType, jurisdiction: market.jurisdiction, currency: market.currency, probability: market.probability, volume: market.volume, liquidity: market.liquidity, observedAt: market.observedAt, retrievedAt: market.retrievedAt, freshness: market.freshness, fee: market.fee, settlement, url: market.url };
}

function normalizeManifoldMarket(market, retrievedAt) {
  if (!market || typeof market.id !== "string" || typeof market.question !== "string" || !Number.isFinite(Number(market.probability))) throw new HttpError(502, "Manifold response contained a malformed market.");
  return publicMarket(normalizeMarket({
    id: market.id, market_id: market.id, title: market.question, platform: "manifold", probability: market.probability,
    volume: market.volume, currency: "MANA", status: market.isResolved ? "resolved" : "active",
    closeTime: market.closeTime, source_url: market.url || (market.creatorUsername && market.slug ? `https://manifold.markets/${encodeURIComponent(market.creatorUsername)}/${encodeURIComponent(market.slug)}` : null),
    rules: { primary: market.description || "See the Manifold market description." }
  }, { source: "Manifold public API", retrievedAt }));
}

function screenOpportunity(opportunity, minRoi, minSize) {
  if (!opportunity || typeof opportunity !== "object" || Array.isArray(opportunity)) throw new HttpError(502, "Arbitrage response contained a malformed opportunity.");
  const roi = finiteNumber(opportunity.roi_pct);
  const maxWager = finiteNumber(opportunity.max_wager_usd);
  const legs = Array.isArray(opportunity.legs) ? opportunity.legs : [];
  const hasTwoLegs = legs.length === 2;
  const knownDepth = hasTwoLegs && legs.every(leg => finiteNumber(leg.liquidity_usd) > 0);
  const allFeesKnown = hasTwoLegs && legs.every(leg => finiteNumber(leg.fee_usd) !== null || finiteNumber(leg.fee_pct) !== null);
  const sizePass = maxWager !== null && maxWager >= minSize;
  const roiPass = roi !== null && roi >= minRoi;
  const safeLegs = legs.slice(0, 2).map(leg => ({
    platform: typeof leg.platform === "string" ? leg.platform.slice(0, 80) : "unknown",
    market_id: typeof leg.market_id === "string" ? leg.market_id.slice(0, 160) : null,
    side: typeof leg.side === "string" ? leg.side.slice(0, 20) : null,
    price: finiteNumber(leg.price), liquidity_usd: finiteNumber(leg.liquidity_usd), fee_usd: finiteNumber(leg.fee_usd), fee_pct: finiteNumber(leg.fee_pct)
  }));
  return {
    group_id: typeof opportunity.group_id === "string" ? opportunity.group_id.slice(0, 160) : null,
    group_title: typeof opportunity.group_title === "string" ? opportunity.group_title.slice(0, 1000) : "Cross-venue candidate",
    roi_pct: roi,
    max_wager_usd: maxWager,
    legs: safeLegs,
    observationType: "simulated_cross_venue_candidate",
    currency: "USD",
    roi_basis: "provider-reported estimate; EDGE has not independently recalculated fees, spreads, fills or slippage",
    executable: false,
    screen_status: "RESEARCH_ONLY",
    quality_flags: { roi_threshold: roiPass, minimum_size: sizePass, both_legs_have_liquidity_reported: knownDepth, both_leg_fee_fields_present: allFeesKnown, fee_schedule_verified: false, bid_ask_spread_verified: false, executable_quotes_verified: false, executable: false },
    score: clamp((roi || 0) * 2 + (knownDepth ? 20 : 0) + (sizePass ? 15 : 0), 0, 100),
    limitations: ["Research candidate only; no order is placed.", "Confirm venue access and Australian legal eligibility.", "Verify currency, executable prices, complete fees, depth, slippage and resolution rules before treating as actionable."]
  };
}

async function scan(env, settings = {}) {
  const minRoi = clamp(finiteNumber(settings.minRoi) ?? 3, 0, 100);
  const minSize = clamp(finiteNumber(settings.minSize) ?? 25, 0, 10_000_000);
  const data = await prediction(env, `/arb?min_roi=${encodeURIComponent(minRoi)}&limit=100`);
  if (!Array.isArray(data.opportunities)) throw new HttpError(502, "Prediction.com arbitrage response did not contain an opportunities array.");
  if (data.opportunities.length > 500) throw new HttpError(502, "Prediction.com returned too many arbitrage candidates.");
  const opportunities = data.opportunities.map(o => screenOpportunity(o, minRoi, minSize)).sort((a, b) => b.score - a.score);
  const snapshot = { as_of: typeof data.as_of === "string" ? data.as_of : null, retrieved_at: isoNow(), delay_seconds: finiteNumber(data.delay_seconds), count: opportunities.length, opportunities, observationType: "simulated_cross_venue_candidates" };
  if (env.EDGE_KV) await env.EDGE_KV.put("latest-scan", JSON.stringify(snapshot), { expirationTtl: 86_400 });
  return snapshot;
}

async function alertNew(env, scanData) {
  if (!env.EDGE_KV || !env.ALERT_WEBHOOK_URL) return;
  const previous = JSON.parse(await env.EDGE_KV.get("alert-state") || "{}"); const next = {};
  for (const opportunity of scanData.opportunities) {
    const key = String(opportunity.group_id || opportunity.group_title || opportunity.legs?.map(leg => leg.market_id).join("-") || "unknown");
    const roi = finiteNumber(opportunity.roi_pct) || 0; const old = previous[key];
    if (!old || Math.abs(roi - old.roi) >= 1.5) {
      const lines = [`EDGE simulated research signal: ${opportunity.group_title || "Cross-venue candidate"}`, `Provider ROI estimate: ${roi.toFixed(2)}% (reported in provider-defined USD terms)`, "Not executable. Confirm fees, spread, depth, jurisdiction and settlement terms independently."];
      await fetch(env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: lines.join("\n"), text: lines.join("\n") }), signal: AbortSignal.timeout(5000) }).catch(() => null);
    }
    next[key] = { roi, seenAt: Date.now() };
  }
  await env.EDGE_KV.put("alert-state", JSON.stringify(next), { expirationTtl: 2_592_000 });
}

function responseText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output || []).flatMap(item => item.content || []).filter(content => ["output_text", "text"].includes(content.type)).map(content => content.text).join("\n");
}
function citations(response) {
  const values = (response?.output || []).flatMap(item => item.content || []).flatMap(content => content.annotations || [])
    .filter(annotation => annotation.type === "url_citation" && typeof annotation.url_citation?.url === "string" && URL.canParse(annotation.url_citation.url) && new URL(annotation.url_citation.url).protocol === "https:")
    .map(annotation => ({ url: annotation.url_citation.url, title: annotation.url_citation.title || annotation.url_citation.url }));
  return [...new Map(values.map(item => [item.url, item])).values()];
}
function validateResearchInput(input) {
  const question = String(input.question || "").trim();
  const rules = String(input.rules || "").trim();
  const url = input.url == null ? "" : String(input.url).trim();
  const venue = input.platform == null ? "" : String(input.platform).trim();
  const marketPrice = input.marketPrice == null || input.marketPrice === "" ? null : finiteNumber(input.marketPrice);
  if (!question && !url && !input.image) throw new HttpError(400, "Question, HTTPS market URL, or image is required.");
  if (question.length > 4000 || rules.length > 10_000 || url.length > 2048 || venue.length > 100) throw new HttpError(413, "Research input exceeds the supported length.");
  if (url && (!/^https:\/\//i.test(url) || !URL.canParse(url))) throw new HttpError(400, "Market URL must be a valid HTTPS URL.");
  if (marketPrice !== null && (marketPrice < 0 || marketPrice > 100)) throw new HttpError(400, "Market probability must be between 0 and 100 percent.");
  return { question: question || "Read the supplied market screenshot and identify the market question and resolution wording.", rules, url, venue, marketPrice, image: input.image || null };
}
async function research(env, input) {
  const validated = validateResearchInput(input);
  if (!env.OPENAI_API_KEY) throw new HttpError(503, "OpenAI API key is not configured.");
  const prompt = `Research this prediction-market question with Australian context first. Question: ${validated.question}\nUser-supplied venue label (unverified): ${validated.venue || "Not supplied"}\nMarket URL supplied by user (treat it as a search hint; do not assume it is accessible in Australia): ${validated.url || "Not supplied"}\nResolution rules: ${validated.rules || "Not supplied; flag this as a major limitation."}\nObserved market YES quote: ${validated.marketPrice == null ? "Not supplied" : `${validated.marketPrice}%`}.\n\nPrioritise primary Australian sources where relevant: RBA, ABS, AEC, BOM, ASX (only public/licensed data), Australian and state governments, and Australian courts. Cite source URLs and publication dates. Use international sources only when relevant and label them secondary. Distinguish observed facts, source data, market quote and model inference. Search current facts and base rates. Identify Australian local date/time and timezone for catalysts. Never invent facts, sources, market access or Australian legal eligibility. If evidence is insufficient, return no point estimate. Give a probability range and confidence, not false precision. Do not treat the market quote as independent evidence. Discuss fees, spread, depth, slippage, resolution wording, freshness, jurisdiction, licensing and Australian regulation. No trade recommendation or order placement.\n\nReturn JSON keys: question, summary, probability_range, probability, market_price, edge_points, confidence, yes_case, no_case, base_rates_and_assumptions, invalidation, limitations.`;
  const content = [{ type: "input_text", text: prompt }];
  if (validated.image) {
    if (typeof validated.image !== "string" || validated.image.length > 6_800_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(validated.image)) throw new HttpError(400, "Screenshot must be a PNG, JPEG or WEBP image smaller than 5 MB.");
    content.push({ type: "input_image", image_url: validated.image });
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.OPENAI_MODEL || "gpt-6.2-astra", tools: [{ type: "web_search", search_context_size: "high" }], tool_choice: "auto", input: [{ role: "user", content }], text: { format: { type: "json_object" } } }), signal: AbortSignal.timeout(45_000)
  });
  if (response.url && new URL(response.url).hostname !== "api.openai.com") throw new HttpError(502, "AI provider redirected to an unexpected host.");
  const text = await readLimitedText(response, 1_000_000, () => new HttpError(502, "OpenAI response exceeded the size limit.")); let data;
  try { data = JSON.parse(text); } catch { throw new HttpError(502, "OpenAI returned an invalid response."); }
  if (!response.ok) throw new HttpError(502, `OpenAI request failed with HTTP ${response.status}.`);
  let report;
  try { report = JSON.parse(responseText(data)); } catch { throw new HttpError(502, "Could not parse the structured research report."); }
  if (!report || typeof report !== "object" || typeof report.summary !== "string") throw new HttpError(502, "Research response did not match the expected schema.");
  if (report.summary.length > 20_000) throw new HttpError(502, "Research response summary exceeded the size limit.");
  for (const field of ["yes_case", "no_case", "base_rates_and_assumptions", "invalidation", "limitations"]) if (!Array.isArray(report[field]) || report[field].length > 50 || report[field].some(value => typeof value !== "string" || value.length > 4000)) throw new HttpError(502, "Research response contained an invalid evidence list.");
  for (const field of ["probability", "market_price", "edge_points"]) if (report[field] !== null && report[field] !== undefined && finiteNumber(report[field]) === null) throw new HttpError(502, "Research response contained an invalid probability or edge value.");
  for (const field of ["probability", "market_price", "edge_points"]) if (report[field] != null) report[field] = finiteNumber(report[field]);
  if (report.probability != null && (report.probability < 0 || report.probability > 100) || report.market_price != null && (report.market_price < 0 || report.market_price > 100)) throw new HttpError(502, "Research response probability was outside the 0–100 range.");
  report.market_price = validated.marketPrice;
  report.edge_points = validated.marketPrice === null || report.probability === null || report.probability === undefined ? null : report.probability - validated.marketPrice;
  return { report, citations: citations(data), created_at: isoNow(), model: env.OPENAI_MODEL || "gpt-6.2-astra", classification: "model_generated_research_probability" };
}

async function backtest(env, input) {
  const platform = String(input.platform || "").toLowerCase(); const marketId = String(input.marketId || "");
  if (!/^[a-z0-9_-]{1,80}$/i.test(platform) || !/^[a-z0-9_.-]{1,120}$/.test(marketId)) throw new HttpError(400, "Invalid platform or market ID.");
  const daysInput = finiteNumber(input.days); const days = clamp(daysInput ?? 30, 1, 90);
  const interval = ["1m", "5m", "15m", "1h", "1d"].includes(input.interval) ? input.interval : "1h";
  const to = new Date(); const from = new Date(to.getTime() - days * 86_400_000);
  const query = new URLSearchParams({ platform, market_id: marketId, from: from.toISOString(), to: to.toISOString(), interval });
  const data = await prediction(env, `/prices/history?${query}`);
  if (!Array.isArray(data.candles)) throw new HttpError(502, "Price history response did not contain a candle array.");
  const result = calculateBacktest(data.candles);
  return { result: { ...result, from: result.from || from.toISOString(), to: result.to || to.toISOString(), method: "Descriptive price replay using provider historical closes. It does not model fills, fees, spread, slippage, resolution payouts or a validated predictive strategy.", warning: "Historical performance does not predict future outcomes.", source: "Prediction.com API", currency: null, priceUnit: "provider-normalized probability points; verify source units" } };
}

function parseLimit(value, fallback, max) {
  const n = finiteNumber(value);
  if (n === null) return fallback;
  return clamp(Math.trunc(n), 1, max);
}

async function marketSearch(request, env) {
  const url = new URL(request.url); const q = (url.searchParams.get("q") || "").trim();
  if (q.length > 200) throw new HttpError(400, "Search query exceeds 200 characters.");
  const requestedPlatform = (url.searchParams.get("platform") || "").toLowerCase();
  const limit = parseLimit(url.searchParams.get("limit"), 40, 100);
  const retrievedAt = isoNow();
  if (requestedPlatform === "manifold") {
    const cursor = url.searchParams.get("cursor") || "";
    if (cursor && !/^\d{1,16}$/.test(cursor)) throw new HttpError(400, "Invalid Manifold pagination cursor.");
    const query = new URLSearchParams({ term: q, sort: "newest", filter: "open", contractType: "BINARY", limit: String(limit) });
    if (cursor) query.set("beforeTime", cursor);
    const list = await providerJson(`https://api.manifold.markets/v0/search-markets?${query}`, { headers: { Accept: "application/json" } });
    if (!Array.isArray(list)) throw new HttpError(502, "Manifold response did not contain a market array.");
    const markets = list.map(item => normalizeManifoldMarket(item, retrievedAt));
    const lastTime = list.at(-1)?.createdTime;
    return { markets, next_cursor: list.length === limit && Number.isFinite(lastTime) ? String(lastTime) : null, total_count: null, as_of: null, retrieved_at: retrievedAt, source: "Manifold public API", marketClass: "play_money" };
  }
  const allowedPlatforms = new Set(["", "polymarket", "polymarket_us", "kalshi", "predictit", "prophetx", "opinion", "predictfun", "novig"]);
  if (!allowedPlatforms.has(requestedPlatform)) throw new HttpError(400, "Unsupported Prediction.com venue filter.");
  const params = new URLSearchParams();
  for (const name of ["platform", "category", "status", "cursor"]) if (url.searchParams.has(name)) params.set(name, url.searchParams.get(name));
  if (q) params.set("q", q);
  params.set("limit", String(limit)); params.set("include", "rules");
  const data = await prediction(env, `/markets?${params}`);
  if (!Array.isArray(data.markets)) throw new HttpError(502, "Prediction.com response did not contain a market array.");
  return { markets: data.markets.map(market => normalizePredictionMarket(market, data.as_of, retrievedAt)), next_cursor: typeof data.next_cursor === "string" ? data.next_cursor : null, total_count: finiteNumber(data.total_count), as_of: typeof data.as_of === "string" ? data.as_of : null, retrieved_at: retrievedAt, source: "Prediction.com API", jurisdiction: "unverified" };
}

async function runAutomatedCryptoPaper(env, { fetchImpl = fetch, timeoutMs = 7000, now = Date.now() } = {}) {
  if (!env.EDGE_KV) return { status: "storage_unavailable" };
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : Number(now);
  if (!Number.isFinite(nowMs)) return { status: "INVALID_SCAN_CLOCK", mode: "AUTOMATED_PAPER_ONLY", liveTradingEnabled: false };
  const key = "crypto-auto-paper-global-v1", nowIso = new Date(nowMs).toISOString();
  const stored = await env.EDGE_KV.get(key);
  let account;
  if (stored === null || stored === undefined || stored === "") {
    account = createAutoPaperAccount(nowIso);
  } else {
    let parsed;
    try { parsed = JSON.parse(stored); }
    catch { return { status: "LEDGER_INVALID_JSON", mode: "AUTOMATED_PAPER_ONLY", liveTradingEnabled: false, message: "Stored paper ledger is invalid JSON; no existing data was overwritten." }; }
    try { account = normalizeAutoPaperAccount(parsed, nowIso); }
    catch { return { status: "LEDGER_VALIDATION_FAILED", mode: "AUTOMATED_PAPER_ONLY", liveTradingEnabled: false, message: "Stored paper ledger failed validation; no existing data was overwritten." }; }
  }
  // Binance documents data-api.binance.vision for unauthenticated public market data.
  // Use one klines request per host: the last closed candle supplies both the
  // indicator inputs and current mark, avoiding a second endpoint that could
  // fail independently and incorrectly mark an otherwise healthy market offline.
  const hosts = ["https://data-api.binance.vision/api/v3/", "https://api.binance.com/api/v3/", "https://api-gcp.binance.com/api/v3/", "https://api1.binance.com/api/v3/", "https://api2.binance.com/api/v3/", "https://api3.binance.com/api/v3/", "https://api4.binance.com/api/v3/"];
  const results = await Promise.all(AUTO_SYMBOLS.map(async symbol => {
    let lastError = "NO_PROVIDER_RESPONSE";
    let lastErrorDetail = null;
    for (const base of hosts) {
      try {
        const options = { headers: { Accept: "application/json" } };
        // Cron scheduled() invocations do not have an HTTP Request Context. In
        // that context AbortSignal.timeout() can throw before fetch is attempted.
        // Keep the bounded timeout for HTTP-triggered manual scans, but omit it
        // for Cron and rely on the platform's outbound request lifecycle.
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) options.signal = AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(base + "klines?symbol=" + symbol + "&interval=1h&limit=260", options);
        if (!response.ok) { lastError = "HTTP_" + response.status; continue; }
        const body = await response.text();
        let raw;
        try { raw = JSON.parse(body); }
        catch { lastError = "INVALID_JSON_RESPONSE"; continue; }
        const normalized = normalizeBinanceHourlyKlines(raw, { now: nowMs });
        if (!normalized.valid) { lastError = normalized.reason; continue; }
        const bars = normalized.bars;
        const latest = bars.at(-1);
        return { symbol, price: latest.close, signal: evaluateAutoSignal(bars), status: "LIVE_PUBLIC_DATA", provider: new URL(base).hostname, latestClosedCandle: latest.timestamp };
      } catch (error) {
        lastError = error?.name === "TimeoutError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FETCH_ERROR";
        lastErrorDetail = String(error?.message || error?.name || "Provider request failed").replace(/[\r\n\t]+/g, " ").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/(api[_-]?key|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 160);
      }
    }
    return { symbol, status: "UNAVAILABLE", errorCode: lastError, errorDetail: lastErrorDetail, message: "All configured public market-data endpoints failed." };
  }));
  const prices = Object.fromEntries(results.filter(x => x.price > 0).map(x => [x.symbol,x.price]));
  const signals = Object.fromEntries(results.filter(x => x.signal).map(x => [x.symbol,x.signal]));
  account = processAutoPaperSignals(account, { signals, prices, now: nowIso });
  const liveMarkets = results.filter(x => x.status === "LIVE_PUBLIC_DATA").length;
  const snapshot = { ...account, paperOnly:true, performance:calculateAutoPaperPerformance(account), candidateRanking:account.lastCandidateRanking||[], markets: results.map(x => ({ symbol:x.symbol,status:x.status,provider:x.provider||null,errorCode:x.errorCode||null,errorDetail:x.errorDetail||null,latestClosedCandle:x.latestClosedCandle||null,signal:x.signal?.signal||false,reason:x.signal?.reason||x.errorCode||"NO_QUALIFYING_SIGNAL",rsi:x.signal?.rsi??null,adx:x.signal?.adx??null,checks:x.signal?.checks||null,failedChecks:x.signal?.failedChecks||[] })), marketDataStatus: liveMarkets ? "PARTIAL_OR_FULL" : "ALL_PROVIDERS_UNAVAILABLE", liveMarketCount:liveMarkets, lastScanAt:nowIso, scanIntervalMinutes:15, dataSource:"Binance public market-data API · USDT pairs", observationType:"AUTOMATED_SIMULATED_PAPER_TRADING", liveTradingEnabled:false };
  await env.EDGE_KV.put(key, JSON.stringify(snapshot));
  return snapshot;
}

const COINSPOT_MTF_KEY = "coinspot-mtf-history-global-v1";
const COINSPOT_MTF_COINS = ["BTC","ETH"];
const utcDate = timestamp => new Date(timestamp).toISOString().slice(0,10);
const shiftUtcDate = (date,days) => new Date(Date.parse(date+"T00:00:00.000Z")+days*86400000).toISOString().slice(0,10);

const COINSPOT_HISTORY_REQUEST_BUDGET_PER_MARKET_PER_SYNC = 15;
const COINSPOT_HISTORY_MIN_PARTITION_MS = 15 * 60 * 1000;

function createCoinSpotHistoryProgress(targetDate, startMs, endMs) {
  return {
    targetDate,
    coins: Object.fromEntries(COINSPOT_MTF_COINS.map(coin => [coin, {
      windows: [{ startMs, endMs }],
      trades: [],
      rawRowsSeen: 0,
      rawBuyOrders: 0,
      rawSellOrders: 0,
      apiCallsTotal: 0,
      emptyPrimaryResponses: 0,
      emptyHistoryWindows: 0,
      dateFormatFallbackHits: 0,
      queryFormatsAttempted: [],
      marketsSeen: [],
      sampleOrderAt: null,
      saturatedWindows: 0,
      complete: false,
      tradeCount: 0
    }]))
  };
}

function validateCoinSpotHistoryProgress(progress, targetDate, startMs, endMs) {
  if (!progress || progress.targetDate !== targetDate || !progress.coins ||
      typeof progress.coins !== "object" || Array.isArray(progress.coins)) {
    throw new HttpError(409, "CoinSpot resumable history state failed validation; stored data was preserved.");
  }
  for (const coin of COINSPOT_MTF_COINS) {
    const market = progress.coins[coin];
    if (!market || !Array.isArray(market.windows) || market.windows.length > 512 ||
        !Array.isArray(market.trades) || market.trades.length > 100000 ||
        typeof market.complete !== "boolean" ||
        !Number.isSafeInteger(market.apiCallsTotal) || market.apiCallsTotal < 0 ||
        !Number.isSafeInteger(market.saturatedWindows) || market.saturatedWindows < 0) {
      throw new HttpError(409, "CoinSpot resumable " + coin + "/AUD history state failed validation; stored data was preserved.");
    }
    for (const window of market.windows) {
      if (!Number.isSafeInteger(window?.startMs) || !Number.isSafeInteger(window?.endMs) ||
          window.startMs < startMs || window.endMs > endMs || window.endMs <= window.startMs ||
          (window.format !== undefined && !["date", "epoch"].includes(window.format))) {
        throw new HttpError(409, "CoinSpot resumable " + coin + "/AUD history window failed validation; stored data was preserved.");
      }
    }
    for (const trade of market.trades) {
      if (!Number.isSafeInteger(trade?.timestamp) || trade.timestamp < startMs || trade.timestamp >= endMs ||
          ![trade.price, trade.amount, trade.totalAud].every(value => Number.isFinite(value) && value > 0)) {
        throw new HttpError(409, "CoinSpot resumable " + coin + "/AUD trade cache failed validation; stored data was preserved.");
      }
    }
  }
  return true;
}

async function fetchCoinSpotHistoryProgress(env, coin, progress, maxRequests = COINSPOT_HISTORY_REQUEST_BUDGET_PER_MARKET_PER_SYNC) {
  const budget = { calls: 0 };
  const request = async (window, format) => {
    if (budget.calls >= maxRequests) return null;
    budget.calls++;
    progress.apiCallsTotal++;
    progress.queryFormatsAttempted.push(format);
    if (progress.queryFormatsAttempted.length > 200) progress.queryFormatsAttempted = progress.queryFormatsAttempted.slice(-200);
    const range = coinSpotHistoryRangeParams(window.startMs, window.endMs, format);
    const payload = await coinSpotReadOnly(env, "/orders/market/completed", {
      cointype: coin, markettype: "AUD", ...range, limit: 500
    });
    if (!Array.isArray(payload.buyorders) || !Array.isArray(payload.sellorders)) {
      throw new HttpError(502, "CoinSpot historical order response was malformed.");
    }
    progress.rawBuyOrders += payload.buyorders.length;
    progress.rawSellOrders += payload.sellorders.length;
    for (const row of [...payload.buyorders, ...payload.sellorders].slice(0, 6)) {
      if (row?.market && progress.marketsSeen.length < 6 && !progress.marketsSeen.includes(String(row.market))) {
        progress.marketsSeen.push(String(row.market));
      }
      if (!progress.sampleOrderAt && row?.solddate) progress.sampleOrderAt = String(row.solddate);
    }
    return payload;
  };

  while (progress.windows.length && budget.calls < maxRequests) {
    const window = progress.windows[0];
    const duration = window.endMs - window.startMs;
    const wholeUtcDay = duration === 86400000 && window.startMs % 86400000 === 0;
    const format = window.format || (wholeUtcDay ? "date" : "epoch-ms");
    let payload = await request(window, format);
    if (!payload) break;
    let count = payload.buyorders.length + payload.sellorders.length;

    // The provider probe validated epoch-millisecond filters for sub-day windows.
    // Do not spend extra requests retrying seconds formats that production has
    // already shown to return empty ranges.
    if (wholeUtcDay && format === "date" && count === 0) {
      progress.emptyPrimaryResponses++;
      if (budget.calls >= maxRequests) {
        window.format = "epoch";
        break;
      }
      const fallback = await request(window, "epoch");
      if (!fallback) {
        window.format = "epoch";
        break;
      }
      const fallbackCount = fallback.buyorders.length + fallback.sellorders.length;
      if (fallbackCount > count) {
        payload = fallback;
        count = fallbackCount;
        progress.dateFormatFallbackHits++;
      } else {
        progress.emptyHistoryWindows++;
        progress.windows.shift();
        continue;
      }
    }

    if (count >= 450) {
      if (duration <= COINSPOT_HISTORY_MIN_PARTITION_MS) {
        throw new HttpError(503, "CoinSpot returned a potentially truncated 15-minute history window; no candles were saved.");
      }
      const midpoint = Math.floor((window.startMs + window.endMs) / 2 / 1000) * 1000;
      if (midpoint <= window.startMs || midpoint >= window.endMs) {
        throw new HttpError(502, "CoinSpot history window could not be safely partitioned.");
      }
      progress.windows.splice(0, 1,
        { startMs: window.startMs, endMs: midpoint },
        { startMs: midpoint, endMs: window.endMs }
      );
      progress.saturatedWindows++;
      continue;
    }

    const normalizedTrades = normalizeCoinSpotCompletedOrders({ coin, payload });
    const outOfRangeTrades = normalizedTrades.filter(trade => trade.timestamp < window.startMs || trade.timestamp >= window.endMs);
    if (outOfRangeTrades.length > 0) {
      throw new HttpError(502, "COINSPOT_HISTORY_RANGE_MISMATCH: " + coin + "/AUD returned trades outside the requested UTC window.");
    }
    const rawRows = [...payload.buyorders, ...payload.sellorders];
    if (rawRows.length > 0 && normalizedTrades.length === 0) {
      const sample = rawRows.find(row => row && typeof row === "object") || {};
      const diagnostic = {
        marketMatch: sample.market === coin + "/AUD",
        timestampValid: Number.isFinite(Date.parse(sample.solddate)),
        pricePositive: Number.isFinite(Number(sample.rate)) && Number(sample.rate) > 0,
        amountPositive: Number.isFinite(Number(sample.amount)) && Number(sample.amount) > 0,
        totalPositive: Number.isFinite(Number(sample.total)) && Number(sample.total) > 0
      };
      throw new HttpError(502, "COINSPOT_HISTORY_SCHEMA_MISMATCH: non-empty history contained no accepted trades; sample validation=" + JSON.stringify(diagnostic));
    }
    if (count === 0) progress.emptyHistoryWindows++;
    progress.rawRowsSeen += count;
    progress.trades.push(...normalizedTrades);
    progress.windows.shift();
  }

  if (progress.windows.length === 0) {
    if (progress.saturatedWindows > 0 && progress.trades.length === 0) {
      throw new HttpError(502, "COINSPOT_HISTORY_PARTITION_EMPTY: " + coin + "/AUD returned saturated history but its validated smaller epoch windows returned no accepted trades.");
    }
    const unique = new Map();
    for (const trade of progress.trades) {
      const key = [trade.timestamp, trade.price, trade.amount, trade.totalAud].join("|");
      if (!unique.has(key)) unique.set(key, trade);
    }
    progress.trades = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
    progress.tradeCount = progress.trades.length;
    progress.complete = true;
  }
  return { complete: progress.complete, calls: budget.calls, pendingWindows: progress.windows.length };
}


async function probeCoinSpotHistory(env, coin, clock) {
  const date = utcDate(clock);
  const startMs = Date.parse(date + "T00:00:00.000Z");
  const endMs = startMs + 86400000;
  const formats = ["date", "epoch"];
  let payload = null;
  let usedFormat = null;
  for (const format of formats) {
    const range = coinSpotHistoryRangeParams(startMs, endMs, format);
    const candidate = await coinSpotReadOnly(env, "/orders/market/completed", {
      cointype: coin, markettype: "AUD", ...range, limit: 500
    });
    if (!Array.isArray(candidate.buyorders) || !Array.isArray(candidate.sellorders)) {
      throw new Error("CoinSpot live-day history probe returned a malformed response.");
    }
    payload = candidate;
    usedFormat = format;
    if (candidate.buyorders.length + candidate.sellorders.length > 0) break;
  }
  const normalizedTrades = normalizeCoinSpotCompletedOrders({ coin, payload });
  const trades = normalizedTrades.filter(trade => trade.timestamp >= startMs && trade.timestamp < endMs);
  const outOfRangeTrades = normalizedTrades.length - trades.length;
  const marketsSeen = [...new Set([...payload.buyorders, ...payload.sellorders]
    .map(row => String(row?.market || "")).filter(Boolean))].slice(0, 6);
  const midpoint = startMs + 12 * 60 * 60 * 1000;
  const partitionHistory = [];
  for (const [windowStart, windowEnd] of [[startMs, midpoint], [midpoint, endMs]]) {
    const variants = [];
    for (const format of ["epoch", "epoch-string", "epoch-ms"]) {
      try {
        const range = coinSpotHistoryRangeParams(windowStart, windowEnd, format);
        const part = await coinSpotReadOnly(env, "/orders/market/completed", {
          cointype: coin, markettype: "AUD", ...range, limit: 500
        });
        if (!Array.isArray(part.buyorders) || !Array.isArray(part.sellorders)) {
          throw new Error("CoinSpot sub-day history probe returned a malformed response.");
        }
        const normalizedPartTrades = normalizeCoinSpotCompletedOrders({ coin, payload: part });
        const partTrades = normalizedPartTrades.filter(trade => trade.timestamp >= windowStart && trade.timestamp < windowEnd);
        const outOfRangeTrades = normalizedPartTrades.length - partTrades.length;
        variants.push({
          format, rawBuyOrders: part.buyorders.length, rawSellOrders: part.sellorders.length,
          validAudTrades: partTrades.length, outOfRangeTrades,
          sampleOrderAt: partTrades.length ? new Date(partTrades.at(-1).timestamp).toISOString() : null
        });
      } catch (error) {
        variants.push({ format, status: "ERROR", message: String(error?.message || error).slice(0, 180) });
      }
    }
    const numericEpoch = variants.find(variant => variant.format === "epoch") || {};
    partitionHistory.push({
      startAt: new Date(windowStart).toISOString(),
      endAt: new Date(windowEnd).toISOString(),
      ...numericEpoch,
      variants
    });
  }
  return {
    date, queryFormat: usedFormat,
    rawBuyOrders: payload.buyorders.length,
    rawSellOrders: payload.sellorders.length,
    validAudTrades: trades.length,
    outOfRangeTrades,
    sampleOrderAt: trades.length ? new Date(trades.at(-1).timestamp).toISOString() : null,
    marketsSeen, partitionHistory
  };
}

async function probeCoinSpotPublicHistory(coin) {
  const url = "https://www.coinspot.com.au/pubapi/v2/orders/completed/" + coin.toLowerCase() + "/AUD";
  const payload = await providerJson(url, { headers: { Accept: "application/json" } }, 128 * 1024);
  const trades = normalizeCoinSpotCompletedOrders({ coin, payload });
  const marketsSeen = [...new Set([...payload.buyorders, ...payload.sellorders]
    .map(row => String(row?.market || "")).filter(Boolean))].slice(0, 6);
  return {
    rawBuyOrders: payload.buyorders.length,
    rawSellOrders: payload.sellorders.length,
    validAudTrades: trades.length,
    latestTradeAt: trades.length ? new Date(trades.at(-1).timestamp).toISOString() : null,
    marketsSeen,
    possiblyCapped: payload.buyorders.length >= 100 || payload.sellorders.length >= 100
  };
}

async function probeCoinSpotProviders(env, clock) {
  const probe = { checkedAt: new Date(clock).toISOString(), readOnlyStatus: "UNKNOWN", markets: [] };
  try {
    const status = await coinSpotReadOnly(env, "/status");
    probe.readOnlyStatus = status?.status === "ok" ? "AUTHENTICATED" : "INVALID_RESPONSE";
  } catch (error) {
    probe.readOnlyStatus = "FAILED";
    probe.readOnlyStatusError = String(error?.message || "CoinSpot read-only status probe failed").replace(/\s+/g, " ").slice(0, 180);
  }
  for (const coin of COINSPOT_MTF_COINS) {
    const market = { coin, pair: coin + "/AUD" };
    try {
      market.readOnlyHistory = await probeCoinSpotHistory(env, coin, clock);
    } catch (error) {
      market.readOnlyHistory = { status: "ERROR", message: String(error?.message || "Read-only history probe failed").replace(/\s+/g, " ").slice(0, 180) };
    }
    try {
      market.publicHistory = await probeCoinSpotPublicHistory(coin);
    } catch (error) {
      market.publicHistory = { status: "ERROR", message: String(error?.message || "Public history probe failed").replace(/\s+/g, " ").slice(0, 180) };
    }
    probe.markets.push(market);
  }
  return probe;
}

async function syncCoinSpotMtfHistory(env,now=new Date()) {
  if(!env.EDGE_KV) return {status:"STORAGE_UNAVAILABLE",liveTradingEnabled:false};
  const clock=now instanceof Date?now.getTime():Date.parse(now);
  if(!Number.isFinite(clock)) return {status:"INVALID_SYNC_CLOCK",liveTradingEnabled:false};
  const today=utcDate(clock);
  let state;
  try { state=JSON.parse(await env.EDGE_KV.get(COINSPOT_MTF_KEY)||"null"); }
  catch { return {status:"HISTORY_CACHE_INVALID_JSON",liveTradingEnabled:false}; }
  if(!state) state={mode:"COINSPOT_AUD_RESEARCH_ONLY",startedAt:new Date(clock).toISOString(),nextDate:shiftUtcDate(today,-120),markets:{},liveTradingEnabled:false};
  if (state.mode !== "COINSPOT_AUD_RESEARCH_ONLY" || state.liveTradingEnabled !== false ||
      typeof state.nextDate !== "string" || !state.markets || typeof state.markets !== "object") {
    return { status: "HISTORY_CACHE_VALIDATION_FAILED", liveTradingEnabled: false };
  }
  // A resumable partial batch can contain raw rows from saturated parent
  // windows while no completed leaf trades have been accepted yet. It must not
  // trigger the legacy full-history rewind intended for old completed batches.
  const legacyBatchHasUnacceptedRows = !state.pendingHistorySync &&
    Array.isArray(state.lastBatch) && state.lastBatch.some(batch =>
      batch?.complete !== false &&
      Number(batch?.tradeCount || 0) === 0 &&
      Number(batch?.rawBuyOrders || 0) + Number(batch?.rawSellOrders || 0) > 0
    );
  if (state.lastBatchDate === undefined && legacyBatchHasUnacceptedRows &&
      typeof state.lastProcessedDate === "string" &&
      state.nextDate === shiftUtcDate(state.lastProcessedDate, 1)) {
    const previousProcessedDate = state.lastProcessedDate;
    state.historyIntegrityRewindFrom = previousProcessedDate;
    state.historyIntegrityRewindAt = new Date(clock).toISOString();
    state.lastBatchDate = previousProcessedDate;
    state.lastProcessedDate = shiftUtcDate(previousProcessedDate, -2);
    state.nextDate = shiftUtcDate(previousProcessedDate, -1);
    state.status = "BACKFILLING";
    await env.EDGE_KV.put(COINSPOT_MTF_KEY, JSON.stringify(state));
  }
  if (state.historyIntegrityRewindFrom && !state.historyIntegrityFullRewindAt) {
    const fullStartDate = shiftUtcDate(today, -120);
    state.historyIntegrityFullRewindFrom = fullStartDate;
    state.historyIntegrityFullRewindAt = new Date(clock).toISOString();
    state.lastProcessedDate = shiftUtcDate(fullStartDate, -1);
    state.nextDate = fullStartDate;
    state.lastBatchDate = state.historyIntegrityRewindFrom;
    state.lastBatch = [];
    state.lastSyncAt = null;
    state.pendingHistorySync = null;
    state.status = "BACKFILLING";
    state.markets = Object.fromEntries(COINSPOT_MTF_COINS.map(coin => [coin, {
      ...(state.markets[coin] || {}),
      dailyCandles: [],
      fourHourCandles: [],
      tradesFetched: 0,
      lastHistoryDate: null,
      lastSyncAt: null
    }]));
    // Rebuild the full original window: earlier legacy batches may also have
    // advanced despite incomplete capped responses. Persist before any fetch.
    await env.EDGE_KV.put(COINSPOT_MTF_KEY, JSON.stringify(state));
  }
  const previousProbeAt = Date.parse(state.lastProviderProbeAt || "");
  const needsPartitionProbe = !Array.isArray(state.providerProbe?.markets) ||
    state.providerProbe.markets.some(market =>
      !Array.isArray(market.readOnlyHistory?.partitionHistory) ||
      market.readOnlyHistory.partitionHistory.length !== 2 ||
      market.readOnlyHistory.partitionHistory.some(window => !Array.isArray(window.variants) || window.variants.length !== 3)
    );
  if (!Number.isFinite(previousProbeAt) || clock - previousProbeAt >= 24 * 60 * 60 * 1000 || needsPartitionProbe) {
    state.providerProbe = await probeCoinSpotProviders(env, clock);
    state.lastProviderProbeAt = new Date(clock).toISOString();
    // Persist provider diagnostics before backfill work so a later history
    // failure cannot erase evidence from the live read-only/public probes.
    await env.EDGE_KV.put(COINSPOT_MTF_KEY, JSON.stringify(state));
  }
  const targetDate=state.nextDate<=today?state.nextDate:today;
  const startMs=Date.parse(targetDate+"T00:00:00.000Z"),endMs=startMs+86400000;
  if (!Number.isFinite(startMs) || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return { status:"INVALID_HISTORY_CURSOR", liveTradingEnabled:false };
  }
  const pending = state.pendingHistorySync
    ? structuredClone(state.pendingHistorySync)
    : createCoinSpotHistoryProgress(targetDate, startMs, endMs);
  validateCoinSpotHistoryProgress(pending, targetDate, startMs, endMs);

  const updatedMarkets={...state.markets};
  const outcomes=[];
  for(const coin of COINSPOT_MTF_COINS){
    const progress=pending.coins[coin];
    const callsBefore=progress.apiCallsTotal;
    if(!progress.complete){
      try {
        await fetchCoinSpotHistoryProgress(env, coin, progress);
        if(progress.complete){
          const trades=progress.trades;
          const daily=aggregateCoinSpotTrades(trades,COINSPOT_INTERVALS.daily);
          const fourHour=aggregateCoinSpotTrades(trades,COINSPOT_INTERVALS.fourHour);
          const previous=updatedMarkets[coin]||{dailyCandles:[],fourHourCandles:[],tradesFetched:0};
          const previousCounts=previous.tradesFetchedByDate&&typeof previous.tradesFetchedByDate==="object"&&!Array.isArray(previous.tradesFetchedByDate)
            ? previous.tradesFetchedByDate : {};
          const previousTrackedTrades=Object.values(previousCounts).reduce((sum,value)=>{
            const count=Number(value);
            return sum+(Number.isFinite(count)&&count>=0?count:0);
          },0);
          const tradesFetchedBase=typeof previous.tradesFetchedBase==="number"&&Number.isFinite(previous.tradesFetchedBase)
            ? Math.max(0,previous.tradesFetchedBase)
            : Math.max(0,Number(previous.tradesFetched||0)-previousTrackedTrades);
          const tradesFetchedByDate={...previousCounts,[targetDate]:trades.length};
          const trackedTrades=Object.values(tradesFetchedByDate).reduce((sum,value)=>{
            const count=Number(value);
            return sum+(Number.isFinite(count)&&count>=0?count:0);
          },0);
          updatedMarkets[coin]={
            dailyCandles:mergeCoinSpotCandles(previous.dailyCandles,daily,160),
            fourHourCandles:mergeCoinSpotCandles(previous.fourHourCandles,fourHour,420),
            tradesFetched:tradesFetchedBase+trackedTrades,
            tradesFetchedBase,
            tradesFetchedByDate,
            lastHistoryDate:targetDate,
            lastSyncAt:new Date(clock).toISOString()
          };
          progress.tradeCount=trades.length;
          progress.trades=[];
        }
      } catch(error) {
        state={
          ...state,markets:updatedMarkets,pendingHistorySync:pending,
          lastSyncAt:new Date(clock).toISOString(),nextDate:targetDate,
          status:"BACKFILLING",liveTradingEnabled:false
        };
        await env.EDGE_KV.put(COINSPOT_MTF_KEY,JSON.stringify(state));
        throw error;
      }
    }
    outcomes.push({
      coin,
      tradeCount:progress.complete?progress.tradeCount:0,
      partialTradeCount:progress.trades.length,
      complete:progress.complete,
      apiCalls:progress.apiCallsTotal-callsBefore,
      apiCallsTotal:progress.apiCallsTotal,
      rawBuyOrders:progress.rawBuyOrders,
      rawSellOrders:progress.rawSellOrders,
      marketsSeen:progress.marketsSeen,
      sampleOrderAt:progress.sampleOrderAt,
      emptyPrimaryResponses:progress.emptyPrimaryResponses,
      emptyHistoryWindows:progress.emptyHistoryWindows,
      dateFormatFallbackHits:progress.dateFormatFallbackHits,
      queryFormatsAttempted:progress.queryFormatsAttempted.slice(-30),
      pendingWindows:progress.windows.length
    });
    state={
      ...state,markets:updatedMarkets,pendingHistorySync:pending,
      lastSyncAt:new Date(clock).toISOString(),nextDate:targetDate,
      status:"BACKFILLING",liveTradingEnabled:false,lastBatch:outcomes
    };
    await env.EDGE_KV.put(COINSPOT_MTF_KEY,JSON.stringify(state));
  }

  const dateComplete=COINSPOT_MTF_COINS.every(coin=>pending.coins[coin].complete);
  const nextDate=dateComplete
    ? (targetDate<today?shiftUtcDate(targetDate,1):today)
    : targetDate;
  const status=dateComplete&&targetDate===today?"COLLECTING_LIVE_DAY":"BACKFILLING";
  state={
    ...state,markets:updatedMarkets,lastSyncAt:new Date(clock).toISOString(),
    lastProcessedDate:dateComplete?targetDate:state.lastProcessedDate,
    lastBatchDate:dateComplete?targetDate:state.lastBatchDate,
    nextDate,status,liveTradingEnabled:false,lastBatch:outcomes,
    pendingHistorySync:dateComplete?null:pending
  };
  await env.EDGE_KV.put(COINSPOT_MTF_KEY,JSON.stringify(state));
  const progressSummary=dateComplete?null:Object.fromEntries(COINSPOT_MTF_COINS.map(coin=>{
    const market=pending.coins[coin];
    return [coin,{complete:market.complete,pendingWindows:market.windows.length,partialTradeCount:market.trades.length,apiCallsTotal:market.apiCallsTotal}];
  }));
  return {
    status,processedDate:dateComplete?targetDate:state.lastProcessedDate||null,
    targetDate,nextDate,dateComplete,progress:progressSummary,
    markets:outcomes,providerProbe:state.providerProbe||null,liveTradingEnabled:false
  };
}


async function reviewCoinSpotMtfCandidate(env, market) {
  if (!env.OPENAI_API_KEY) return { status: "AI_REVIEW_NOT_CONFIGURED", summary: "AI review is unavailable; deterministic risk rules remain in control.", riskFlags: [] };
  if (market?.signal?.status !== "BUY_CANDIDATE_PAPER_ONLY") return null;
  const cacheKey = "coinspot-mtf-ai-review:" + market.coin + ":" + market.signal.signalAt;
  const cached = await env.EDGE_KV?.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch { /* invalid advisory cache is ignored */ } }
  const packet = {
    pair: market.pair, quote: market.quote, signal: market.signal,
    strategy: "Daily close above EMA100; 4h EMA50 above EMA200 with positive slope; entry trigger is either a 2-of-3 prior 20/55/100-bar Donchian breakout or a bullish 4h EMA20 reclaim after the previous 4h close was at/below its EMA20. Spread, liquidity, volatility and paper risk gates remain mandatory.",
    constraints: { spotOnly: true, paperOnly: true, maximumAllocationPct: 25, riskBudgetPct: 0.5, initialStopAtr: 2.5, trailingStopAtr: 3, maxHoldingDays: 30 }
  };
  const schema = { type:"object", additionalProperties:false, properties:{
    assessment:{type:"string",enum:["LOW_CONCERN","CAUTION","HIGH_CONCERN"]},
    summary:{type:"string",maxLength:700},
    riskFlags:{type:"array",maxItems:6,items:{type:"string",maxLength:180}}
  }, required:["assessment","summary","riskFlags"] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method:"POST", headers:{Authorization:"Bearer "+env.OPENAI_API_KEY,"Content-Type":"application/json"},
      body:JSON.stringify({model:env.OPENAI_MODEL||"gpt-6.2-astra",max_output_tokens:500,
        input:[{role:"system",content:"You are EDGE's conservative crypto paper-trading risk analyst. Review only the supplied deterministic signal, quote, spread and risk constraints. Do not invent market facts, news or data. Do not change any strategy, position size, fee or risk rule. Do not issue buy/sell instructions and do not authorise execution. Identify uncertainty, spread, volatility, concentration and data limitations. Return only the requested JSON."},
          {role:"user",content:"Review this paper-only candidate. This review is advisory and cannot override deterministic strategy/risk controls.\n"+JSON.stringify(packet)}],
        text:{format:{type:"json_schema",name:"edge_coinspot_signal_review",strict:true,schema}}
      }), redirect:"error", signal:controller.signal
    });
    if (!response.ok) return {status:"AI_REVIEW_PROVIDER_ERROR",summary:"AI review provider returned HTTP "+response.status+".",riskFlags:[]};
    const payload=await response.json();
    let output=payload.output_text||"";
    if(!output) for(const item of payload.output||[]) for(const part of item.content||[]) if(part.text) output=part.text;
    const parsed=JSON.parse(output);
    if(!["LOW_CONCERN","CAUTION","HIGH_CONCERN"].includes(parsed.assessment)||typeof parsed.summary!=="string"||!Array.isArray(parsed.riskFlags)||parsed.riskFlags.length>6) throw new Error("AI response schema mismatch");
    const review = {status:"AI_REVIEW_COMPLETE",...parsed,reviewedAt:isoNow(),advisoryOnly:true};
    await env.EDGE_KV?.put(cacheKey, JSON.stringify(review), {expirationTtl: 86400});
    return review;
  } catch {
    return {status:"AI_REVIEW_UNAVAILABLE",summary:"AI review could not be completed; deterministic safeguards remain authoritative.",riskFlags:[]};
  } finally { clearTimeout(timeout); }
}

async function runCoinSpotMtfPaper(env, now = new Date(), backfillDays = 4) {
  if (!env.EDGE_KV) throw new HttpError(503, "Persistent CoinSpot paper storage is not configured.");
  const clock = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(clock)) throw new HttpError(400, "Invalid paper scan clock.");
  const nowIso = new Date(clock).toISOString();
  const accountKey = "coinspot-mtf-paper-global-v1";
  const statusKey = "coinspot-mtf-paper-status-global-v1";
  let account;
  const stored = await env.EDGE_KV.get(accountKey);
  if (!stored) account = createMtfPaperAccount(nowIso);
  else {
    try { account = JSON.parse(stored); validateMtfPaperAccount(account); }
    catch { throw new HttpError(409, "CoinSpot MTF paper ledger failed validation; existing data was preserved."); }
  }
  let historySync = null, syncError = null, backfillDaysProcessed = 0;
  const backfillDaysRequested = Math.max(1, Math.min(4, Number(backfillDays) || 1));
  let historyRequestsThisScan = 0;
  if (env.COINSPOT_READONLY_KEY && env.COINSPOT_READONLY_SECRET) {
    for (let i = 0; i < backfillDaysRequested; i++) {
      try {
        historySync = await syncCoinSpotMtfHistory(env, new Date(clock));
        if (!["BACKFILLING", "COLLECTING_LIVE_DAY"].includes(historySync.status)) break;
        historyRequestsThisScan += (historySync.markets || []).reduce((sum, market) => sum + Math.max(0, Number(market.apiCalls) || 0), 0);
        if (historySync.dateComplete !== true) break;
        backfillDaysProcessed++;
        if (historySync.status === "COLLECTING_LIVE_DAY" || historyRequestsThisScan >= 30) break;
      } catch (error) {
        syncError = String(error?.message || "CoinSpot history sync failed").replace(/\s+/g, " ").slice(0, 220);
        break;
      }
    }
  } else syncError = "CoinSpot Read Only API credentials are not configured.";
  let strategy;
  try { strategy = await getCoinSpotMtfStrategy(env, new Date(clock)); }
  catch (error) { strategy = { status: "STRATEGY_DATA_UNAVAILABLE", markets: [], liveTradingEnabled: false }; syncError ||= String(error?.message || "Strategy data unavailable").slice(0, 220); }
  const aiReviews = await Promise.all((strategy.markets || []).map(async market => ({
    coin: market.coin, review: await reviewCoinSpotMtfCandidate(env, market)
  })));
  account = processMtfPaperAccount(account, { markets: strategy.markets || [], now: nowIso });
  await env.EDGE_KV.put(accountKey, JSON.stringify(account));
  const snapshot = {
    ...account, status: syncError ? "DATA_OR_SYNC_WARNING" : strategy.status || "PAPER_ENGINE_ACTIVE",
    strategyStatus: strategy.status || "UNKNOWN", historySync,
    backfillDaysRequested, backfillDaysProcessed, historyRequestsThisScan, lastScanAt: nowIso,
    lastError: syncError, markets: (strategy.markets || []).map(m => ({
      coin: m.coin, pair: m.pair, signalStatus: m.signalStatus || "NO_SIGNAL",
      signalAt: m.signal?.signalAt || null, bid: m.quote?.bid || null, ask: m.quote?.ask || null,
      spreadBps: m.quote?.spreadBps ?? null, dailyCandles: m.history?.dailyCandles || 0,
      fourHourCandles: m.history?.fourHourCandles || 0,
      contiguousDailyCandles: m.history?.contiguousDailyCandles ?? m.history?.dailyCandles ?? 0,
      contiguousFourHourCandles: m.history?.contiguousFourHourCandles ?? m.history?.fourHourCandles ?? 0,
      signalWindowFourHourCandles: m.history?.signalWindowFourHourCandles ?? m.history?.fourHourCandles ?? 0,
      signalWindowElapsedIntervals: m.history?.signalWindowElapsedIntervals ?? m.history?.signalWindowFourHourCandles ?? 0,
      signalWindowMissingIntervals: m.history?.signalWindowMissingIntervals ?? 0,
      signalWindowConfirmedZeroTradeIntervals: m.history?.signalWindowConfirmedZeroTradeIntervals ?? 0,
      signalWindowStatus: m.history?.signalWindowStatus ?? "UNKNOWN",
      dailyGapCount: m.history?.dailyGapCount ?? 0,
      fourHourGapCount: m.history?.fourHourGapCount ?? 0,
      latestDailyGap: m.history?.latestDailyGap ?? null,
      latestFourHourGap: m.history?.latestFourHourGap ?? null,
      fourHourGapDiagnostics: m.history?.fourHourGapDiagnostics ?? [],
      storedDailyCandles: m.history?.storedDailyCandles ?? m.history?.dailyCandles ?? 0,
      storedFourHourCandles: m.history?.storedFourHourCandles ?? m.history?.fourHourCandles ?? 0,
      lastCompletedDailyAt: m.history?.lastCompletedDailyAt || null,
      lastCompletedFourHourAt: m.history?.lastCompletedFourHourAt || null,
      lastCompletedFourHourClose: m.history?.lastCompletedFourHourClose ?? null,
      entryModel: m.signal?.entryModel || null,
      triggerModel: m.signal?.triggerModel || null,
      marketRegime: m.signal?.marketRegime || null,
      indicators: m.signal?.indicators || null,
      risk: m.signal?.risk || null,
      failedChecks: m.signal?.failedChecks || [],
      tradesFetched: m.history?.tradesFetched || 0,
      checks: m.signal?.checks || null, signalError: m.signalError || null,
      aiReview: aiReviews.find(x => x.coin === m.coin)?.review || null
    })),
    paperOnly: true, liveTradingEnabled: false
  };
  await env.EDGE_KV.put(statusKey, JSON.stringify(snapshot));
  return snapshot;
}

async function getCoinSpotMtfPaper(env) {
  if (!env.EDGE_KV) throw new HttpError(503, "Persistent CoinSpot paper storage is not configured.");
  const [stored, status] = await Promise.all([
    env.EDGE_KV.get("coinspot-mtf-paper-global-v1"),
    env.EDGE_KV.get("coinspot-mtf-paper-status-global-v1")
  ]);
  let account = createMtfPaperAccount();
  if (stored) {
    try { account = JSON.parse(stored); validateMtfPaperAccount(account); }
    catch { throw new HttpError(409, "CoinSpot MTF paper ledger failed validation; existing data was preserved."); }
  }
  if (!status) return { ...account, status: "WAITING_FOR_FIRST_PAPER_SCAN", markets: [], liveTradingEnabled: false };
  let snapshot;
  try { snapshot = JSON.parse(status); } catch { throw new HttpError(502, "CoinSpot MTF paper status is invalid JSON."); }
  return { ...snapshot, ...account, markets: snapshot.markets || [], lastScanAt: snapshot.lastScanAt || null, status: snapshot.status || "PAPER_ENGINE_WAITING", liveTradingEnabled: false };
}

function coinSpotFourHourGapDiagnostics(dailyCandles, fourHourCandles) {
  const dailyTradeCounts = new Map();
  for (const candle of dailyCandles) {
    const timestamp = Date.parse(candle?.timestamp || "");
    const rawCount = candle?.tradeCount;
    if (!Number.isFinite(timestamp)) continue;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    dailyTradeCounts.set(day, typeof rawCount === "number" && Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : null);
  }

  // Reconcile every retained four-hour trade count against its UTC daily
  // candle. Only an exact match can prove that an absent bucket contained no
  // completed trades; missing metadata or truncated day coverage stays unknown.
  const fourHourTradeCounts = new Map();
  for (const candle of fourHourCandles) {
    const timestamp = Date.parse(candle?.timestamp || "");
    if (!Number.isFinite(timestamp)) continue;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const aggregate = fourHourTradeCounts.get(day) || { count: 0, valid: true };
    const rawCount = candle?.tradeCount;
    if (typeof rawCount !== "number" || !Number.isSafeInteger(rawCount) || rawCount < 0) aggregate.valid = false;
    else aggregate.count += rawCount;
    fourHourTradeCounts.set(day, aggregate);
  }

  const diagnostics = [];
  const intervalMs = COINSPOT_INTERVALS.fourHour;
  for (let index = 1; index < fourHourCandles.length; index++) {
    const previousAt = Date.parse(fourHourCandles[index - 1]?.timestamp || "");
    const nextAt = Date.parse(fourHourCandles[index]?.timestamp || "");
    if (!Number.isFinite(previousAt) || !Number.isFinite(nextAt) || nextAt - previousAt <= intervalMs) continue;
    const steps = (nextAt - previousAt) / intervalMs;
    if (!Number.isInteger(steps)) continue;
    for (let missingAt = previousAt + intervalMs; missingAt < nextAt; missingAt += intervalMs) {
      const startAt = new Date(missingAt).toISOString();
      const endAt = new Date(missingAt + intervalMs).toISOString();
      const day = startAt.slice(0, 10);
      const dailyTradeCount = dailyTradeCounts.get(day);
      const observed = fourHourTradeCounts.get(day);
      const confirmed = Number.isSafeInteger(dailyTradeCount) && dailyTradeCount >= 0 &&
        observed?.valid === true && observed.count === dailyTradeCount;
      diagnostics.push({
        startAt,
        endAt,
        status: confirmed ? "CONFIRMED_NO_TRADES" : "UNVERIFIED_GAP",
        dailyTradeCount: Number.isSafeInteger(dailyTradeCount) ? dailyTradeCount : null,
        observedFourHourTradeCount: observed?.valid === true ? observed.count : null
      });
    }
  }
  return diagnostics;
}

async function getCoinSpotMtfStrategy(env,now=new Date()) {
  if(!env.EDGE_KV) throw new HttpError(503,"Persistent CoinSpot strategy storage is not configured.");
  let state;
  try { state=JSON.parse(await env.EDGE_KV.get(COINSPOT_MTF_KEY)||"null"); }
  catch { throw new HttpError(502,"CoinSpot strategy history cache is invalid JSON."); }
  if(!state) state={mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"HISTORY_SYNC_NOT_STARTED",markets:{},liveTradingEnabled:false};
  const clock=now instanceof Date?now.getTime():Date.parse(now),markets=[];
  for(const coin of COINSPOT_MTF_COINS){
    const history=state.markets?.[coin]||{dailyCandles:[],fourHourCandles:[]};
    let quote=null,signal=null,signalError=null;
    const storedDaily=Array.isArray(history.dailyCandles)?history.dailyCandles:[];
    const storedFourHour=Array.isArray(history.fourHourCandles)?history.fourHourCandles:[];
    const daily=storedDaily.filter(bar=>Date.parse(bar.timestamp)+COINSPOT_INTERVALS.daily<=clock);
    const fourHour=storedFourHour.filter(bar=>Date.parse(bar.timestamp)+COINSPOT_INTERVALS.fourHour<=clock);
    const historySummary={
      dailyCandles:daily.length,
      fourHourCandles:fourHour.length,
      storedDailyCandles:storedDaily.length,
      storedFourHourCandles:storedFourHour.length,
      lastCompletedDailyAt:daily.at(-1)?.timestamp||null,
      lastCompletedFourHourAt:fourHour.at(-1)?.timestamp||null,
      tradesFetched:history.tradesFetched||0,
      lastHistoryDate:history.lastHistoryDate||null,
      fourHourGapDiagnostics:[]
    };
    let dailyContinuity, fourHourContinuity, candleValidationError = null;
    // Missing intervals are never filled with synthetic OHLCV candles. A
    // signal window may span one interval only when daily/four-hour trade
    // counts reconcile exactly; all other gaps remain blocked.
    try {
      dailyContinuity = latestContiguousCandleRun(daily, COINSPOT_INTERVALS.daily, "Daily history");
      fourHourContinuity = latestContiguousCandleRun(fourHour, COINSPOT_INTERVALS.fourHour, "Four-hour history");
      Object.assign(historySummary, {
        contiguousDailyCandles: dailyContinuity.contiguousCandles,
        contiguousFourHourCandles: fourHourContinuity.contiguousCandles,
        dailyGapCount: dailyContinuity.gapCount,
        fourHourGapCount: fourHourContinuity.gapCount,
        latestDailyGap: dailyContinuity.latestGap,
        latestFourHourGap: fourHourContinuity.latestGap,
        lastCompletedFourHourClose: fourHourContinuity.candles.at(-1)?.close ?? null,
        fourHourGapDiagnostics: coinSpotFourHourGapDiagnostics(daily, fourHour)
      });
    } catch(error) {
      candleValidationError = String(error?.message || "COINSPOT_CANDLE_VALIDATION_FAILED").slice(0,180);
    }

    // Always retrieve the current AUD quote, even during history warm-up. An
    // existing paper position must continue to be marked and stop-managed when
    // historical candles are incomplete or temporarily unavailable.
    try {
      const latest=await providerJson("https://www.coinspot.com.au/pubapi/v2/latest/"+coin.toLowerCase(),{headers:{Accept:"application/json"}},128*1024);
      if(latest.status!=="ok"||!latest.prices) throw new Error("CoinSpot quote response is invalid.");
      const bid=Number(latest.prices.bid),ask=Number(latest.prices.ask),last=Number(latest.prices.last);
      if(![bid,ask,last].every(Number.isFinite)||bid<=0||ask<bid||last<=0) throw new Error("CoinSpot bid/ask quote is invalid.");
      quote={pair:coin+"/AUD",bid,ask,last,spreadBps:calculateCoinSpotSpreadBps(bid,ask),retrievedAt:new Date(clock).toISOString()};
    } catch(error) {
      signalError=String(error?.message||"COINSPOT_QUOTE_UNAVAILABLE").slice(0,180);
    }

    if(candleValidationError){
      signalError = [signalError,candleValidationError].filter(Boolean).join("; ");
      markets.push({coin,pair:coin+"/AUD",quote,history:historySummary,signal:null,signalStatus:"INVALID_COINSPOT_CANDLE_DATA",signalError,execution:"NO_ORDER_PAPER_CANDIDATE_ONLY",liveTradingEnabled:false});
      continue;
    }
    const fourHourSignalWindow=fourHour.slice(-240);
    const signalWindowStart=Date.parse(fourHourSignalWindow[0]?.timestamp||"");
    const signalWindowEnd=Date.parse(fourHourSignalWindow.at(-1)?.timestamp||"");
    const signalWindowGapDiagnostics=historySummary.fourHourGapDiagnostics.filter(item=>{
      const start=Date.parse(item.startAt),end=Date.parse(item.endAt);
      return Number.isFinite(start)&&Number.isFinite(end)&&
        start>=signalWindowStart&&end<=signalWindowEnd;
    });
    const confirmedSignalWindowGaps=signalWindowGapDiagnostics.filter(item=>item.status==="CONFIRMED_NO_TRADES");
    const unverifiedSignalWindowGaps=signalWindowGapDiagnostics.filter(item=>item.status!=="CONFIRMED_NO_TRADES");
    const elapsedSignalWindowIntervals=fourHourSignalWindow.length
      ? Math.round((signalWindowEnd-signalWindowStart)/COINSPOT_INTERVALS.fourHour)+1 : 0;
    historySummary.signalWindowFourHourCandles=fourHourSignalWindow.length;
    historySummary.signalWindowElapsedIntervals=elapsedSignalWindowIntervals;
    historySummary.signalWindowMissingIntervals=signalWindowGapDiagnostics.length;
    historySummary.signalWindowConfirmedZeroTradeIntervals=confirmedSignalWindowGaps.length;
    historySummary.signalWindowUnverifiedGaps=unverifiedSignalWindowGaps.length;
    historySummary.signalWindowStatus=fourHourSignalWindow.length<210?"WARMUP_REQUIRED":
      unverifiedSignalWindowGaps.length?"BLOCKED_UNVERIFIED_GAP":
      confirmedSignalWindowGaps.length>1?"BLOCKED_EXCESSIVE_ZERO_TRADE_GAPS":
      confirmedSignalWindowGaps.length?"READY_WITH_CONFIRMED_ZERO_TRADE_GAP":"READY_CONTIGUOUS";

    const readiness = [];
    if(dailyContinuity.contiguousCandles<110){
      const gap=dailyContinuity.latestGap?" after gap "+dailyContinuity.latestGap.previousAt+" -> "+dailyContinuity.latestGap.nextAt:"";
      readiness.push("Daily contiguous history "+dailyContinuity.contiguousCandles+"/110 completed candles"+gap);
    }
    if(fourHourSignalWindow.length<210){
      readiness.push("Four-hour signal history "+fourHourSignalWindow.length+"/210 actual completed candles");
    }
    if(unverifiedSignalWindowGaps.length){
      readiness.push("Four-hour signal window contains unverified gap(s): "+
        unverifiedSignalWindowGaps.map(item=>item.startAt+" -> "+item.endAt).join(", ")+
        "; latest contiguous run "+fourHourContinuity.contiguousCandles+"/210");
    }
    if(confirmedSignalWindowGaps.length>1){
      readiness.push("Four-hour signal window exceeds the one-interval zero-trade allowance: confirmed zero-trade intervals "+
        confirmedSignalWindowGaps[0].startAt+" -> "+confirmedSignalWindowGaps.at(-1).endAt);
    }
    if(readiness.length){
      const blockedByGap =
        (dailyContinuity.gapCount>0&&dailyContinuity.contiguousCandles<110) ||
        unverifiedSignalWindowGaps.length>0 || confirmedSignalWindowGaps.length>1;
      signalError=[signalError,...readiness].filter(Boolean).join("; ");
      markets.push({coin,pair:coin+"/AUD",quote,history:historySummary,signal:null,
        signalStatus:blockedByGap?"INSUFFICIENT_CONTIGUOUS_HISTORY_AFTER_GAP":"WARMUP_REQUIRED",
        signalError,execution:"NO_ORDER_PAPER_CANDIDATE_ONLY",liveTradingEnabled:false});
      continue;
    }
    if(!quote){
      markets.push({coin,pair:coin+"/AUD",quote:null,history:historySummary,signal:null,signalStatus:signalError||"COINSPOT_QUOTE_UNAVAILABLE",signalError,execution:"NO_ORDER_PAPER_CANDIDATE_ONLY",liveTradingEnabled:false});
      continue;
    }
    const dailyAge=daily.length?clock-(Date.parse(daily.at(-1).timestamp)+COINSPOT_INTERVALS.daily):Infinity;
    const fourHourAge=fourHour.length?clock-(Date.parse(fourHour.at(-1).timestamp)+COINSPOT_INTERVALS.fourHour):Infinity;
    if(dailyAge>48*3600000||fourHourAge>8*3600000) signalError="STALE_COINSPOT_HISTORY";
    else {
      try { signal=evaluateEdgeBreakoutSignal({
        dailyCandles:dailyContinuity.candles.slice(-120),
        fourHourCandles:fourHourSignalWindow,
        confirmedZeroTradeIntervals:confirmedSignalWindowGaps,
        asOf:clock,spreadBps:quote.spreadBps
      }); }
      catch(error) { signalError=String(error?.message||"CANDLE_VALIDATION_FAILED").slice(0,180); }
    }
    markets.push({coin,pair:coin+"/AUD",quote,history:historySummary,signal,signalStatus:signal?.status||signalError||"NO_SIGNAL",signalError,execution:"NO_ORDER_PAPER_CANDIDATE_ONLY",liveTradingEnabled:false});
  }
  return {provider:"CoinSpot Read Only market history + public bid/ask",mode:state.mode,status:state.status,nextDate:state.nextDate,lastSyncAt:state.lastSyncAt,lastBatch:state.lastBatch||[],markets,liveTradingEnabled:false,disclaimer:"Candles are aggregated only from actual CoinSpot BTC/AUD and ETH/AUD completed market orders. Empty intervals are not fabricated. A signal is withheld until sufficient fresh, contiguous history is available. This endpoint never places orders."};
}

async function runScheduledCryptoPaper(env, options = {}) {
  // ScheduledEvent has no HTTP Request Context; do not use AbortSignal.timeout().
  return runAutomatedCryptoPaper(env, { ...options, timeoutMs: null });
}

async function handle(request, env, ctx) {
  const requestUrl = new URL(request.url); const origin = request.headers.get("Origin");
  if (origin && origin !== requestUrl.origin && !configuredOrigins(env).includes(origin)) return json({ error: "Origin is not allowed." }, 403);
  if (request.method === "OPTIONS") {
    const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
    if (requestedHeaders.some(header => header !== "content-type")) return json({ error: "Requested headers are not allowed." }, 403, origin, env);
    return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...corsHeaders(origin, env) } });
  }
  // Proxy the static frontend from the Cloudflare Pages production site through
  // this Worker. Browser requests stay on the Worker origin, keeping Cloudflare
  // Access authentication first-party (including Safari/iOS).
  if (!requestUrl.pathname.startsWith("/api/")) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed." }, 405, origin, env);
    const allowedAssets = new Set(["/", "/index.html", "/app.js", "/domain.js", "/au-sources.js", "/autonomous-engine.js", "/crypto-engine.js", "/crypto-csv.js", "/coinspot.js", "/coinspot-paper.js", "/crypto-auto-paper.js", "/coinspot-strategy.js", "/crypto-strategy-comparison.js", "/styles.css", "/manifest.webmanifest", "/sw.js", "/icon.svg", "/icon-192.png", "/icon-512.png", "/adaptive-regime-strategy.js", "/regime-adaptive-breakout.js", "/trend-following-indicators.js"]);
    if (!allowedAssets.has(requestUrl.pathname)) return json({ error: "Not found" }, 404, origin, env);
    const assetPath = requestUrl.pathname === "/" ? "/" : requestUrl.pathname;
    const upstream = await fetch("https://edge-intelligence-486.pages.dev" + assetPath, { headers: { Accept: request.headers.get("Accept") || "*/*" } });
    const headers = new Headers(upstream.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cache-Control", requestUrl.pathname === "/" || requestUrl.pathname === "/index.html" ? "no-cache" : "public, max-age=300");
    return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  }
  if (!requestUrl.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404, origin, env);
  const principal = await authenticate(request, env, ctx);
  const reply = (data, status = 200) => json(data, status, origin, env);

  if (requestUrl.pathname === "/api/health" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "health");
    return reply({ status: "worker_responding", providers: { coinSpotReadOnly: Boolean(env.COINSPOT_READONLY_KEY && env.COINSPOT_READONLY_SECRET), datacedar: env.DATACEDAR_API_KEY ? "key configured; retrieval not verified" : "requires DATACEDAR_API_KEY Worker secret", marketData: true, marketDataSource: "Binance public market-data API; no API key required; scanner retrieval is reported by the automated paper account", predictionMarkets: Boolean(env.PREDICTION_HUNT_API_KEY), ai: Boolean(env.OPENAI_API_KEY), storage: Boolean(env.EDGE_KV), alerts: Boolean(env.ALERT_WEBHOOK_URL), cloudflareAccess: true }, asxAutopilot: { enabled: env.ASX_AUTOPILOT_ENABLED === "true", dataCedarKeyConfigured: Boolean(env.DATACEDAR_API_KEY), aiKeyConfigured: Boolean(env.OPENAI_API_KEY), symbolsConfigured: Boolean(env.ASX_AUTOPILOT_SYMBOLS), configured: env.ASX_AUTOPILOT_ENABLED === "true" && Boolean(env.DATACEDAR_API_KEY && env.OPENAI_API_KEY && env.ASX_AUTOPILOT_SYMBOLS && env.EDGE_KV) }, australianSources: { RBA: "official public pages; retrieval not verified by health check", ABS: env.ABS_INDICATOR_API_KEY ? "key configured; API response not verified by health check" : "requires ABS_INDICATOR_API_KEY secret", AEC: env.AEC_INGESTION_URL && env.AEC_INGESTION_TOKEN ? "HTTPS bridge configured; feed retrieval and provenance not verified by health check" : "requires registered AEC feed and authenticated HTTPS bridge", BOM: env.BOM_DATA_LICENSED === "true" ? "rights asserted by operator; retrieval not verified by health check" : "requires confirmation of user-facing data rights" , ASX: env.DATACEDAR_API_KEY ? "DataCedar key configured; historical bars require a successful retrieval" : "DataCedar ASX historical adapter requires DATACEDAR_API_KEY Worker secret", FEX: "not integrated; no verified event API/access" }, scanner: "15-minute cron configured; crypto paper scanning uses public Binance data and KV; ASX paper autopilot is separately opt-in", realMoneyTrading: false, retrieved_at: isoNow() });
  }
  if (requestUrl.pathname === "/api/asx/datacedar/status" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "datacedar-status");
    return reply({ status: env.DATACEDAR_API_KEY ? "key_configured_retrieval_unverified" : "requires_external_access", provider: "DataCedar", exchange: "ASX", timeframe: "1d", configured: Boolean(env.DATACEDAR_API_KEY), history: "Explorer plan: up to one year of daily bars; minute bars are not used by this paper workflow", message: env.DATACEDAR_API_KEY ? "The Worker secret is present. Run a symbol request to verify live provider access." : "Create a free DataCedar key and set it as the DATACEDAR_API_KEY Worker secret. Never paste it into the browser or GitHub source.", sourceUrl: "https://datacedar.com/markets/australia", retrievedAt: isoNow() });
  }
  if (requestUrl.pathname === "/api/asx/datacedar/bars" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "datacedar-bars");
    if (!env.DATACEDAR_API_KEY) throw new HttpError(503, "DataCedar is not configured. Set DATACEDAR_API_KEY as a Cloudflare Worker secret.");
    let symbols;
    try { symbols = normalizeDataCedarSymbols(requestUrl.searchParams.get("symbols") || ""); }
    catch (error) { throw new HttpError(400, error.message); }
    const from = requestUrl.searchParams.get("from") || undefined;
    const to = requestUrl.searchParams.get("to") || undefined;
    let data;
    try { data = await fetchDataCedarBars({ symbols, from, to, apiKey: env.DATACEDAR_API_KEY }); }
    catch (error) {
      if (/ticker|symbol|date range|history|maximum|valid YYYY-MM-DD|unique|one and three/i.test(error.message)) throw new HttpError(400, error.message);
      if (/API key|plan|rate limit|not found|redirected/i.test(error.message)) throw new HttpError(502, error.message);
      throw new HttpError(502, "DataCedar request could not be validated. Retry later or check provider access.");
    }
    return reply(data);
  }
  if (requestUrl.pathname === "/api/asx/autopilot" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "asx-autopilot-status");
    return reply(await readAsxAutopilot(env));
  }
  if (requestUrl.pathname === "/api/asx/autopilot/scan" && request.method === "POST") {
    await routeLimit(env.WRITE_LIMITER, principal.sub, "asx-autopilot-scan");
    return reply(await runAsxAutopilot(env));
  }
  if (requestUrl.pathname === "/api/crypto/research/review" && request.method === "POST") {
    await routeLimit(env.AI_LIMITER, principal.sub, "crypto-research-review");
    const body = await readJson(request, 1_000_000);
    return reply(await reviewCryptoWalkForward({
      market: body.market,
      quoteCurrency: body.quoteCurrency,
      source: body.source,
      candles: body.candles,
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-6.2-astra",
      now: Date.now()
    }));
  }
  if (requestUrl.pathname === "/api/crypto/auto-paper/account" && (request.method === "GET" || request.method === "POST")) {
    await routeLimit(request.method === "POST" ? env.WRITE_LIMITER : env.DATA_LIMITER, principal.sub, "crypto-auto-paper-account");
    if (!env.EDGE_KV) throw new HttpError(503, "Persistent paper storage is not configured.");
    if (request.method === "POST") return reply(await runAutomatedCryptoPaper(env));
    const stored = await env.EDGE_KV.get("crypto-auto-paper-global-v1");
    if (!stored) {
      const account = createAutoPaperAccount();
      return reply({ ...account, markets: [], status: "WAITING_FOR_FIRST_SCHEDULED_SCAN", performance: calculateAutoPaperPerformance(account), candidateRanking: [] });
    }
    let snapshot; try { snapshot = JSON.parse(stored); } catch { throw new HttpError(502, "Automated paper ledger is invalid JSON; stored data was preserved."); }
    const needsPaperOnlyMigration = snapshot?.paperOnly !== true;
    try { validateAutoPaperAccount(snapshot); snapshot = normalizeAutoPaperAccount(snapshot, snapshot.updatedAt); }
    catch { throw new HttpError(409, "Automated paper ledger failed validation; stored data was preserved."); }
    if (needsPaperOnlyMigration) await env.EDGE_KV.put("crypto-auto-paper-global-v1", JSON.stringify(snapshot));
    return reply({ ...snapshot, paperOnly: true, performance: calculateAutoPaperPerformance(snapshot), candidateRanking: Array.isArray(snapshot.lastCandidateRanking) ? snapshot.lastCandidateRanking : [] });
  }

  if (requestUrl.pathname === "/api/crypto/coinspot/mtf-paper" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "coinspot-mtf-paper-account");
    return reply(await getCoinSpotMtfPaper(env));
  }
  if (requestUrl.pathname === "/api/crypto/coinspot/mtf-paper" && request.method === "POST") {
    await routeLimit(env.WRITE_LIMITER, principal.sub, "coinspot-mtf-paper-run");
    return reply(await runCoinSpotMtfPaper(env));
  }
  if (requestUrl.pathname.startsWith("/api/crypto/coinspot/paper")) {
    if (!env.EDGE_KV) throw new HttpError(503, "Persistent paper storage is not configured.");
    const storageKey = await userKey("crypto-paper", principal.sub);
    const loadAccount = async () => normalizePaperAccount(JSON.parse(await env.EDGE_KV.get(storageKey) || "null") || createCoinSpotPaperAccount(), isoNow());
    const saveAccount = async account => { await env.EDGE_KV.put(storageKey, JSON.stringify(account)); return account; };
    if (requestUrl.pathname === "/api/crypto/coinspot/paper/account" && request.method === "GET") {
      await routeLimit(env.DATA_LIMITER, principal.sub, "crypto-paper-account");
      let account = await loadAccount();
      let marked;
      if(account.openPosition){
        const q=await providerJson("https://www.coinspot.com.au/pubapi/v2/latest/"+account.openPosition.coin.toLowerCase(),{headers:{Accept:"application/json"}},128*1024);
        if(q.status!=="ok")throw new HttpError(502,"CoinSpot quote unavailable.");
        const bid=Number(q.prices?.bid),position=account.openPosition;
        const exitReason=bid<=position.stopPrice?"PAPER_STOP_LOSS":bid>=position.targetPrice?"PAPER_TAKE_PROFIT":null;
        if(exitReason){account=closeCoinSpotPaperPosition(account,{bid,reason:exitReason});await saveAccount(account);}
        marked=markCoinSpotPaperAccount(account,{bid});
      } else marked=markCoinSpotPaperAccount(account,{bid:1});
      return reply(marked);
    }
    if (requestUrl.pathname === "/api/crypto/coinspot/paper/open" && request.method === "POST") {
      await routeLimit(env.WRITE_LIMITER, principal.sub, "crypto-paper-open");
      const body=await readJson(request),coin=String(body.coin||"").toUpperCase();
      if(!["BTC","ETH"].includes(coin))throw new HttpError(400,"Only BTC and ETH AUD paper markets are enabled.");
      const q=await providerJson("https://www.coinspot.com.au/pubapi/v2/latest/"+coin.toLowerCase(),{headers:{Accept:"application/json"}},128*1024);
      if(q.status!=="ok")throw new HttpError(502,"CoinSpot quote unavailable.");
      let account;try{account=openCoinSpotPaperPosition(await loadAccount(),{coin,ask:Number(q.prices?.ask)});}catch(error){throw new HttpError(409,error.message);}
      return reply(await saveAccount(account),201);
    }
    if (requestUrl.pathname === "/api/crypto/coinspot/paper/close" && request.method === "POST") {
      await routeLimit(env.WRITE_LIMITER, principal.sub, "crypto-paper-close");
      const account=await loadAccount();if(!account.openPosition)throw new HttpError(409,"There is no open paper position.");
      const q=await providerJson("https://www.coinspot.com.au/pubapi/v2/latest/"+account.openPosition.coin.toLowerCase(),{headers:{Accept:"application/json"}},128*1024);
      if(q.status!=="ok")throw new HttpError(502,"CoinSpot quote unavailable.");
      let next;try{next=closeCoinSpotPaperPosition(account,{bid:Number(q.prices?.bid)});}catch(error){throw new HttpError(409,error.message);}
      return reply(await saveAccount(next));
    }
    throw new HttpError(404,"Paper trading route not found.");
  }
  if (requestUrl.pathname.startsWith("/api/crypto/coinspot/execution/")) {
    if (!env.COINSPOT_EXECUTION_COORDINATOR || !env.EDGE_COORDINATOR_TOKEN) throw new HttpError(503, "CoinSpot execution coordinator is not configured.");
    const routes = new Map([
      ["/api/crypto/coinspot/execution/nonce", "/nonce"],
      ["/api/crypto/coinspot/execution/idempotency/reserve", "/idempotency/reserve"],
      ["/api/crypto/coinspot/execution/idempotency/complete", "/idempotency/complete"]
    ]);
    const internalPath = routes.get(requestUrl.pathname);
    if (!internalPath || request.method !== "POST") throw new HttpError(404, "Execution coordination route not found.");
    await routeLimit(env.WRITE_LIMITER, principal.sub, "coinspot-execution-coordination");
    const id = env.COINSPOT_EXECUTION_COORDINATOR.idFromName(await userKey("coinspot-execution", principal.sub));
    const stub = env.COINSPOT_EXECUTION_COORDINATOR.get(id);
    const body = await readJson(request, 16 * 1024);
    const result = await stub.fetch("https://coordinator.internal" + internalPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-edge-coordinator-token": env.EDGE_COORDINATOR_TOKEN },
      body: JSON.stringify(body)
    });
    const payload = await result.json().catch(() => ({ error: "Coordinator returned invalid JSON." }));
    if (!result.ok) throw new HttpError(result.status, payload.error || "Coordinator request failed.");
    return reply(payload, result.status);
  }
  if (requestUrl.pathname === "/api/coinspot/account" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER,principal.sub,"coinspot-readonly-account");
    const [balances,orders]=await Promise.all([coinSpotReadOnly(env,"/my/balances"),coinSpotReadOnly(env,"/my/orders/market/open",{markettype:"AUD"})]);
    if(!Array.isArray(balances.balances))throw new HttpError(502,"CoinSpot balance response was malformed.");
    const clean=balances.balances.map(item=>{const symbol=Object.keys(item||{})[0];const v=item?.[symbol];return /^[A-Z0-9]{2,12}$/.test(symbol||"")&&v&&Number.isFinite(Number(v.balance))?{coin:symbol,balance:Number(v.balance),audValue:Number.isFinite(Number(v.audbalance))?Number(v.audbalance):null,rate:Number.isFinite(Number(v.rate))?Number(v.rate):null}:null;}).filter(Boolean);
    return reply({provider:"CoinSpot",access:"READ_ONLY",balances:clean,openBuyOrders:Array.isArray(orders.buyorders)?orders.buyorders:[],openSellOrders:Array.isArray(orders.sellorders)?orders.sellorders:[],retrievedAt:isoNow(),liveTradingEnabled:false});
  }
  if (requestUrl.pathname === "/api/crypto/coinspot/market" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "crypto-coinspot-market");
    const requested = (requestUrl.searchParams.get("coins") || "BTC,ETH").toUpperCase().split(",");
    if (!requested.length || requested.length > 2 || requested.some(coin => !new Set(["BTC","ETH"]).has(coin)) || new Set(requested).size !== requested.length) throw new HttpError(400, "Only BTC and ETH AUD markets are enabled.");
    const markets = await Promise.all(requested.map(async coin => {
      const [latest, trades] = await Promise.all([
        providerJson("https://www.coinspot.com.au/pubapi/v2/latest/" + coin.toLowerCase(), {headers:{Accept:"application/json"}}, 128*1024),
        providerJson("https://www.coinspot.com.au/pubapi/v2/orders/summary/completed/" + coin.toLowerCase(), {headers:{Accept:"application/json"}}, 512*1024)
      ]);
      if (latest.status !== "ok" || trades.status !== "ok" || !latest.prices || !Array.isArray(trades.orders)) throw new HttpError(502, "CoinSpot returned an invalid public market response.");
      try { return normalizeCoinSpotMarket({coin,latest,trades,retrievedAt:isoNow()}); }
      catch { throw new HttpError(502, "CoinSpot returned invalid public market data."); }
    }));
    return reply({provider:"CoinSpot",markets,retrievedAt:isoNow(),strategyStatus:"WAITING_FOR_VALIDATED_HISTORICAL_CANDLES",disclaimer:"CoinSpot public API provides current bid/ask/last prices and recent completed trades here, not a documented hourly OHLC candle feed. EDGE will not manufacture candles or generate trade signals from incomplete data."});
  }
  if (requestUrl.pathname === "/api/crypto/coinspot/readonly/status" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "coinspot-readonly-status");
    if (!env.COINSPOT_READONLY_KEY || !env.COINSPOT_READONLY_SECRET) throw new HttpError(503, "CoinSpot read-only API credentials are not configured.");
    const status = await coinSpotReadOnly(env, "/status");
    if (status?.status !== "ok") throw new HttpError(502, "CoinSpot read-only status response was invalid.");
    return reply({ provider: "CoinSpot", access: "READ_ONLY", status: "AUTHENTICATED", retrievedAt: isoNow(), paperOnly: true, liveTradingEnabled: false });
  }
  if (requestUrl.pathname === "/api/crypto/coinspot/strategy" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER,principal.sub,"coinspot-mtf-strategy");
    return reply(await getCoinSpotMtfStrategy(env));
  }
  if (requestUrl.pathname === "/api/crypto/coinspot/strategy/sync" && request.method === "POST") {
    await routeLimit(env.WRITE_LIMITER,principal.sub,"coinspot-mtf-sync");
    if(!env.COINSPOT_READONLY_KEY||!env.COINSPOT_READONLY_SECRET) throw new HttpError(503,"CoinSpot Read Only API credentials are not configured.");
    return reply(await syncCoinSpotMtfHistory(env));
  }
  if (requestUrl.pathname === "/api/markets" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "markets");
    return reply(await marketSearch(request, env));
  }
  if (requestUrl.pathname === "/api/au/sources" && request.method === "GET") { await routeLimit(env.DATA_LIMITER, principal.sub, "au-sources"); return reply({ status: "source_registry", sources: sourceMetadata, retrieved_at: isoNow() }); }
  if (requestUrl.pathname === "/api/au/indicators" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "abs");
    const flow = requestUrl.searchParams.get("flow") || "CPI_H";
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(flow)) throw new HttpError(400, "Invalid ABS dataflow identifier.");
    return reply(await fetchAbsIndicators({ flow, format: "json", env }));
  }
  if (requestUrl.pathname === "/api/au/rba/cash-rate" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "rba-cash-rate");
    return reply(await fetchRbaCashRate());
  }
  if (requestUrl.pathname === "/api/au/rba/releases" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "rba-releases");
    return reply(await fetchRbaReleases());
  }
  if (requestUrl.pathname === "/api/au/aec/results" && request.method === "GET") { await routeLimit(env.DATA_LIMITER, principal.sub, "aec-results"); return reply(await fetchAecResults({ env })); }
  if (requestUrl.pathname === "/api/au/bom/observations" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "bom-observations");
    const city = (requestUrl.searchParams.get("city") || "perth").toLowerCase();
    if (!new Set(["perth", "sydney"]).has(city)) throw new HttpError(400, "Unsupported BOM station.");
    return reply(await fetchBomObservations({ city, env }));
  }
  if (requestUrl.pathname === "/api/au/dashboard" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "au-dashboard");
    const city = requestUrl.searchParams.get("city") || "perth";
    const flow = requestUrl.searchParams.get("flow") || "CPI_H";
    if (!new Set(["perth", "sydney"]).has(city.toLowerCase()) || !/^[A-Za-z0-9_-]{1,40}$/.test(flow)) throw new HttpError(400, "Invalid Australian dashboard city or ABS dataflow.");
    const [abs, cashRate, releases, weather, aec] = await Promise.allSettled([
      fetchAbsIndicators({ flow, env }), fetchRbaCashRate(), fetchRbaReleases(), fetchBomObservations({ city, env }), fetchAecResults({ env })
    ]);
    const adapt = result => result.status === "fulfilled" ? result.value : { status: "unavailable", message: "Source request failed. Retry later.", records: [] };
    return reply({ retrieved_at: isoNow(), abs_dataflow: flow, australian_local_time_zone: city.toLowerCase() === "sydney" ? "Australia/Sydney" : "Australia/Perth", sections: { abs: adapt(abs), rbaCashRate: adapt(cashRate), rbaReleases: adapt(releases), bom: adapt(weather), aec: adapt(aec), asx: sourceMetadata.find(source => source.id === "asx"), fex: sourceMetadata.find(source => source.id === "fex") } });
  }
  if (requestUrl.pathname === "/api/scan" && request.method === "POST") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "scan");
    const body = await readJson(request); const rules = validateAlertRules({ minRoi: body.minRoi ?? 3, minSize: body.minSize ?? 25 });
    if (!rules) throw new HttpError(400, "Scan thresholds are outside supported bounds.");
    return reply(await scan(env, rules));
  }
  if (requestUrl.pathname === "/api/opportunities" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "opportunities");
    const cached = env.EDGE_KV ? await env.EDGE_KV.get("latest-scan") : null;
    if (cached) { try { return reply(JSON.parse(cached)); } catch { throw new HttpError(502, "Stored scan snapshot is invalid."); } }
    return reply(await scan(env, {}));
  }
  if (requestUrl.pathname === "/api/research" && request.method === "POST") {
    await routeLimit(env.AI_LIMITER, principal.sub, "research");
    return reply(await research(env, await readJson(request)));
  }
  if (requestUrl.pathname === "/api/analyze" && request.method === "POST") {
    await routeLimit(env.AI_LIMITER, principal.sub, "analyze");
    const body = await readJson(request, MAX_ANALYZE_BYTES); const result = await research(env, body);
    const report = result.report;
    return reply({ analysis: { title: report.question, summary: report.summary, marketProbability: report.market_price, modelProbability: report.probability, edge: report.edge_points, confidence: report.confidence, risk: (Array.isArray(report.limitations) ? report.limitations : []).join(" · "), evidence: [...(Array.isArray(report.yes_case) ? report.yes_case : []), ...(Array.isArray(report.base_rates_and_assumptions) ? report.base_rates_and_assumptions : [])], risks: Array.isArray(report.no_case) ? report.no_case : [], invalidation: Array.isArray(report.invalidation) ? report.invalidation : [], classification: "model_generated_research_probability" }, citations: result.citations });
  }
  if (requestUrl.pathname === "/api/backtest" && request.method === "POST") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "backtest");
    return reply(await backtest(env, await readJson(request)));
  }
  if (requestUrl.pathname === "/api/alert-rules" && (request.method === "GET" || request.method === "POST")) {
    if (!env.EDGE_KV) throw new HttpError(503, "EDGE_KV binding is required for user alert rules.");
    const key = await userKey("user-alert-rules", principal.sub);
    if (request.method === "GET") {
      await routeLimit(env.DATA_LIMITER, principal.sub, "alert-rules-read");
      let stored;
      try { stored = JSON.parse(await env.EDGE_KV.get(key) || '{"minRoi":3,"minSize":25}'); } catch { throw new HttpError(502, "Stored alert rules are invalid."); }
      const rules = validateAlertRules(stored);
      if (!rules) throw new HttpError(502, "Stored alert rules are invalid.");
      return reply(rules);
    }
    await routeLimit(env.WRITE_LIMITER, principal.sub, "alert-rules");
    const body = await readJson(request);
    const validatedRules = validateAlertRules(body);
    if (!validatedRules) throw new HttpError(400, "Alert thresholds are outside supported bounds.");
    const rules = { ...validatedRules, updatedAt: isoNow() };
    await env.EDGE_KV.put(key, JSON.stringify(rules)); return reply({ saved: true, rules });
  }
  if (requestUrl.pathname === "/api/alerts" && request.method === "GET") {
    await routeLimit(env.DATA_LIMITER, principal.sub, "alerts");
    const value = env.EDGE_KV ? await env.EDGE_KV.get("latest-scan") : null;
    if (!value) return reply({ opportunities: [], observationType: "simulated_cross_venue_candidates" });
    let snapshot;
    try { snapshot = JSON.parse(value); } catch { throw new HttpError(502, "Stored alert snapshot is invalid."); }
    const rulesKey = await userKey("user-alert-rules", principal.sub);
    let rules = { minRoi: 3, minSize: 25 };
    try { rules = validateAlertRules(JSON.parse(await env.EDGE_KV?.get(rulesKey) || "{}")) || rules; } catch { throw new HttpError(502, "Stored alert rules are invalid."); }
    const opportunities = Array.isArray(snapshot.opportunities) ? snapshot.opportunities.filter(item => finiteNumber(item.roi_pct) >= rules.minRoi && finiteNumber(item.max_wager_usd) >= rules.minSize) : [];
    return reply({ ...snapshot, opportunities, appliedUserRules: rules, observationType: "simulated_cross_venue_candidates" });
  }
  return reply({ error: "Not found" }, 404);
}

function isCoinSpotMtfScheduleSlot(event, env) {
  if (!env.EDGE_KV || !env.COINSPOT_READONLY_KEY || !env.COINSPOT_READONLY_SECRET) return false;
  const scheduledTime = Number(event?.scheduledTime);
  const minute = Number.isFinite(scheduledTime)
    ? new Date(scheduledTime).getUTCMinutes()
    : new Date().getUTCMinutes();
  // Other scheduled engines share this Worker invocation's subrequest budget.
  // Reserve :00 for them and run CoinSpot MTF alone at :15, :30 and :45.
  return minute > 0 && minute % 15 === 0;
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); }
    catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      const message = error instanceof HttpError ? error.message : "Request could not be completed.";
      const origin = request.headers.get("Origin");
      return json({ error: message }, status, origin, env);
    }
  },
  async scheduled(_event, env, ctx) {
    if (isCoinSpotMtfScheduleSlot(_event, env)) {
      const scan = runCoinSpotMtfPaper(env).then(snapshot => {
        console.log(JSON.stringify({
          event: "COINSPOT_MTF_SCAN",
          scannedAt: snapshot.lastScanAt,
          status: snapshot.status,
          strategyStatus: snapshot.strategyStatus,
          backfill: {
            requested: snapshot.backfillDaysRequested,
            processed: snapshot.backfillDaysProcessed,
            processedDate: snapshot.historySync?.processedDate || null,
            nextDate: snapshot.historySync?.nextDate || null
          },
          markets: (snapshot.markets || []).map(market => ({
            pair: market.pair,
            signalStatus: market.signalStatus,
            completedDailyCandles: market.dailyCandles,
            completedFourHourCandles: market.fourHourCandles,
            storedDailyCandles: market.storedDailyCandles,
            storedFourHourCandles: market.storedFourHourCandles,
            lastCompletedDailyAt: market.lastCompletedDailyAt,
            lastCompletedFourHourAt: market.lastCompletedFourHourAt,
            lastCompletedFourHourClose: market.lastCompletedFourHourClose,
            entryModel: market.entryModel,
            spreadBps: market.spreadBps,
            aiReviewStatus: market.aiReview?.status || "NOT_RUN"
          })),
          ledger: {
            equityAud: snapshot.equityAud,
            cashAud: snapshot.cashAud,
            openPosition: snapshot.openPosition?.coin || null,
            closedTradeCount: Array.isArray(snapshot.closedTrades) ? snapshot.closedTrades.length : 0
          },
          paperOnly: snapshot.paperOnly === true,
          liveTradingEnabled: false
        }));
        return snapshot;
      }).catch(error => {
        console.error("CoinSpot MTF paper scan failed:", String(error?.message || error).replace(/\s+/g, " ").slice(0, 220));
        throw error;
      });
      ctx.waitUntil(scan);
      return;
    }
    if (env.EDGE_KV) ctx.waitUntil(runScheduledCryptoPaper(env).catch(() => null));
    if (env.ASX_AUTOPILOT_ENABLED === "true") ctx.waitUntil(runAsxAutopilot(env).catch(() => null));
    if (env.PREDICTION_HUNT_API_KEY) ctx.waitUntil((async () => {
      const rules = env.EDGE_KV ? JSON.parse(await env.EDGE_KV.get("cron-alert-rules") || '{"minRoi":3,"minSize":25}') : { minRoi: 3, minSize: 25 };
      const result = await scan(env, rules); await alertNew(env, result);
    })());
  }
};

export const __test = { parseLimit, normalizeManifoldMarket, screenOpportunity, marketSearch, readJson, decodeJwtPart, runAutomatedCryptoPaper, runScheduledCryptoPaper, isCoinSpotMtfScheduleSlot, coinSpotReadOnly, coinSpotReadOnlyNow, syncCoinSpotMtfHistory, getCoinSpotMtfStrategy, runCoinSpotMtfPaper, getCoinSpotMtfPaper, probeCoinSpotHistory, reviewCoinSpotMtfCandidate };
export { CoinSpotExecutionCoordinator } from "./coinspot-execution-coordinator.js";
