import { calculateBacktest, finiteNumber, normalizeMarket, validateAlertRules } from "./domain.js";
import { aecIntegrationStatus, fetchAbsIndicators, fetchAecResults, fetchBomObservations, fetchRbaCashRate, fetchRbaReleases, sourceMetadata } from "./au-sources.js";
import { fetchDataCedarBars, normalizeDataCedarSymbols } from "./datacedar.js";
import { normalizeCoinSpotMarket } from "./coinspot.js";
import { createCoinSpotPaperAccount, normalizePaperAccount, openCoinSpotPaperPosition, closeCoinSpotPaperPosition, markCoinSpotPaperAccount } from "./coinspot-paper.js";

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

async function coinSpotReadOnly(env, path, extra = {}) {
  const key=String(env.COINSPOT_READONLY_KEY||"").trim(),secret=String(env.COINSPOT_READONLY_SECRET||"").trim();
  if(!key||!secret)throw new HttpError(503,"CoinSpot read-only API credentials are not configured.");
  if(!/^\\/[a-z0-9/]+$/.test(path))throw new HttpError(400,"Invalid CoinSpot read-only endpoint.");
  // Add a random sub-millisecond component to reduce nonce collisions across isolates.
  const random = new Uint32Array(1); crypto.getRandomValues(random);
  const nonce=Math.max(Date.now()*1000+(random[0]%1000),lastCoinSpotNonce+1);lastCoinSpotNonce=nonce;
  const body=JSON.stringify({...extra,nonce});
  const cryptoKey=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-512"},false,["sign"]);
  const signature=await crypto.subtle.sign("HMAC",cryptoKey,new TextEncoder().encode(body));
  const sign=[...new Uint8Array(signature)].map(b=>b.toString(16).padStart(2,"0")).join("");
  let response;
  try {
    response=await fetch("https://www.coinspot.com.au/api/v2/ro"+path,{method:"POST",headers:{"Content-Type":"application/json",key,sign,Accept:"application/json"},body,signal:AbortSignal.timeout(10_000)});
  } catch {
    throw new HttpError(502,"Could not reach CoinSpot. Retry the read-only account request.");
  }
  if(response.url && new URL(response.url).hostname!=="www.coinspot.com.au") throw new HttpError(502,"CoinSpot redirected to an unexpected host.");
  const length=Number(response.headers.get("Content-Length"));
  if(Number.isFinite(length)&&length>512*1024) throw new HttpError(502,"CoinSpot response exceeded the size limit.");
  const raw=await readLimitedText(response,512*1024,()=>new HttpError(502,"CoinSpot response exceeded the size limit."));
  let payload;
  try { payload=JSON.parse(raw); } catch { throw new HttpError(502,"CoinSpot returned an invalid response."); }
  if(!response.ok || payload?.status!=="ok") throw new HttpError(502,coinSpotDiagnostic(response.status,payload?.message));
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
    body: JSON.stringify({ model: env.OPENAI_MODEL || "gpt-6-astra", tools: [{ type: "web_search", search_context_size: "high" }], tool_choice: "auto", input: [{ role: "user", content }], text: { format: { type: "json_object" } } }), signal: AbortSignal.timeout(45_000)
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
  return { report, citations: citations(data), created_at: isoNow(), model: env.OPENAI_MODEL || "gpt-6-astra", classification: "model_generated_research_probability" };
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

async function handle(request, env, ctx) {
  const requestUrl = new URL(request.url); const origin = request.headers.get("Origin");
  if (origin && origin !== requestUrl.origin && !configuredOrigins(env).includes(origin)) return json({ error: "Origin is not allowed." }, 403);
  if (request.method === "OPTIONS") {
    const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
    if (requestedHeaders.some(header => header !== "content-type")) return json({ error: "Requested headers are not allowed." }, 403, origin, env);
    return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...corsHeaders(origin, env) } });
  }
  // Proxy the static frontend from GitHub Pages through this Worker. The app and API
  // then share the Worker origin, so Cloudflare Access uses a first-party Safari cookie.
  if (!requestUrl.pathname.startsWith("/api/")) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed." }, 405, origin, env);
    const allowedAssets = new Set(["/", "/index.html", "/app.js", "/domain.js", "/au-sources.js", "/autonomous-engine.js", "/crypto-engine.js", "/coinspot.js", "/coinspot-paper.js", "/coinspot-strategy.js", "/styles.css", "/manifest.webmanifest", "/sw.js", "/icon.svg", "/icon-192.png", "/icon-512.png"]);
    if (!allowedAssets.has(requestUrl.pathname)) return json({ error: "Not found" }, 404, origin, env);
    const assetPath = requestUrl.pathname === "/" ? "/Edge-Intelligence/" : "/Edge-Intelligence" + requestUrl.pathname;
    const upstream = await fetch("https://ttamlarson.github.io" + assetPath, { headers: { Accept: request.headers.get("Accept") || "*/*" } });
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
    return reply({ status: "worker_responding", providers: { coinSpotReadOnly: Boolean(env.COINSPOT_READONLY_KEY && env.COINSPOT_READONLY_SECRET), datacedar: env.DATACEDAR_API_KEY ? "key configured; retrieval not verified" : "requires DATACEDAR_API_KEY Worker secret", marketData: Boolean(env.PREDICTION_HUNT_API_KEY), ai: Boolean(env.OPENAI_API_KEY), storage: Boolean(env.EDGE_KV), alerts: Boolean(env.ALERT_WEBHOOK_URL), cloudflareAccess: true }, australianSources: { RBA: "official public pages; retrieval not verified by health check", ABS: env.ABS_INDICATOR_API_KEY ? "key configured; API response not verified by health check" : "requires ABS_INDICATOR_API_KEY secret", AEC: env.AEC_INGESTION_URL && env.AEC_INGESTION_TOKEN ? "HTTPS bridge configured; feed retrieval and provenance not verified by health check" : "requires registered AEC feed and authenticated HTTPS bridge", BOM: env.BOM_DATA_LICENSED === "true" ? "rights asserted by operator; retrieval not verified by health check" : "requires confirmation of user-facing data rights" , ASX: env.DATACEDAR_API_KEY ? "DataCedar key configured; historical bars require a successful retrieval" : "DataCedar ASX historical adapter requires DATACEDAR_API_KEY Worker secret", FEX: "not integrated; no verified event API/access" }, scanner: "15-minute cron configured; execution requires provider secret and KV", realMoneyTrading: false, retrieved_at: isoNow() });
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
    if (!env.PREDICTION_HUNT_API_KEY) return;
    ctx.waitUntil((async () => {
      const rules = env.EDGE_KV ? JSON.parse(await env.EDGE_KV.get("cron-alert-rules") || '{"minRoi":3,"minSize":25}') : { minRoi: 3, minSize: 25 };
      const result = await scan(env, rules); await alertNew(env, result);
    })());
  }
};

export const __test = { parseLimit, normalizeManifoldMarket, screenOpportunity, marketSearch, readJson, decodeJwtPart };