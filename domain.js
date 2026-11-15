export const DEFAULT_TIME_ZONE = "Australia/Sydney";
export const VALID_TIME_ZONES = ["Australia/Perth", "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide", "Australia/Darwin", "Australia/Hobart", "Australia/Canberra", "Australia/Lord_Howe", "Australia/Eucla"];
export const DEFAULT_MARKET_MAX_AGE_MS = 15 * 60 * 1000;

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function probabilityPercent(value, scale = "auto") {
  const number = finiteNumber(value);
  if (number === null) return null;
  const percent = scale === "fraction" || (scale === "auto" && number >= 0 && number <= 1)
    ? number * 100
    : number;
  return percent >= 0 && percent <= 100 ? percent : null;
}

function isoTimestamp(...values) {
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

export function normalizeMarket(raw, { source = "unknown", retrievedAt = new Date().toISOString(), sourceAsOf = null } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Market must be an object.");
  const providerPrice = raw.price && typeof raw.price === "object" ? raw.price : {};
  const canonicalProbability = raw.probability && typeof raw.probability === "object" ? raw.probability : null;
  const canonicalVolume = raw.volume && typeof raw.volume === "object" ? raw.volume : null;
  const platform = String(raw.platform || raw.venue || source || "unknown").toLowerCase();
  const playMoney = platform === "manifold";
  const bid = probabilityPercent(canonicalProbability?.bid ?? providerPrice.yes_bid ?? raw.yes_bid, canonicalProbability ? "percent" : "auto");
  const ask = probabilityPercent(canonicalProbability?.ask ?? providerPrice.yes_ask ?? raw.yes_ask, canonicalProbability ? "percent" : "auto");
  const rawPrice = typeof raw.price === "number" || typeof raw.price === "string" ? raw.price : undefined;
  const last = probabilityPercent(canonicalProbability?.yes ?? providerPrice.last_price ?? raw.last_price ?? raw.yes_price ?? raw.probability ?? rawPrice,
    canonicalProbability ? "percent" :
    raw.probability !== undefined && providerPrice.last_price === undefined && raw.last_price === undefined && raw.yes_price === undefined ? "fraction" : "auto");
  const midpoint = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : last;
  const observedAt = isoTimestamp(providerPrice.observed_at, providerPrice.updated_at, raw.observed_at, raw.updated_at, raw.as_of, sourceAsOf);
  const nativeCurrency = String(providerPrice.currency || raw.currency || raw.currency_code || "").toUpperCase() || null;
  const volume = finiteNumber(canonicalVolume?.amount ?? providerPrice.volume ?? raw.volume ?? raw.volume_24h);
  const liquidity = finiteNumber(providerPrice.liquidity ?? raw.liquidity);
  const identifier = raw.market_id ?? raw.id ?? raw.ticker ?? null;
  if (identifier === null || identifier === "") throw new TypeError("Market identifier is missing.");
  const title = raw.title ?? raw.question ?? raw.name;
  if (typeof title !== "string" || !title.trim()) throw new TypeError("Market title is missing.");
  return {
    id: String(identifier), marketId: String(raw.market_id ?? raw.id ?? raw.ticker),
    title: raw.event_title ? `${raw.event_title} — ${title}` : title,
    venue: platform, source: raw.source || source, quoteType: raw.quoteType || (playMoney ? "play_money_market" : "unverified_venue_quote"),
    jurisdiction: raw.jurisdiction || "unverified", currency: nativeCurrency,
    probability: { yes: midpoint, bid, ask, unit: "percent" },
    volume: volume === null ? null : { amount: volume, currency: nativeCurrency, unit: nativeCurrency ? "currency" : "venue_native_unknown" },
    liquidity: liquidity === null ? null : { amount: liquidity, currency: nativeCurrency, unit: nativeCurrency ? "currency" : "venue_native_unknown" },
    observedAt, retrievedAt: isoTimestamp(retrievedAt),
    freshness: !observedAt ? "unknown" : (Date.now() - new Date(observedAt).getTime() >= 0 && Date.now() - new Date(observedAt).getTime() <= DEFAULT_MARKET_MAX_AGE_MS ? "fresh" : "stale"),
    fee: finiteNumber(raw.fee ?? providerPrice.fee) === null ? null : { amount: finiteNumber(raw.fee ?? providerPrice.fee), currency: nativeCurrency },
    settlement: raw.rules ?? raw.resolution_rules ?? null,
    url: typeof (raw.source_url ?? raw.url) === "string" ? (raw.source_url ?? raw.url) : null,
    raw
  };
}

export function formatMoney(value, currency) {
  const amount = typeof value === "object" && value !== null ? finiteNumber(value.amount) : finiteNumber(value);
  const code = typeof value === "object" && value !== null ? value.currency : currency;
  if (amount === null) return "Currency unavailable";
  if (code === "MANA") return `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(amount)} MANA (play money)`;
  if (!/^[A-Z]{3}$/.test(String(code || ""))) return "Currency unavailable";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: code, currencyDisplay: "code" }).format(amount);
}

export function convertMoney(amount, from, to, fx) {
  const value = finiteNumber(amount);
  const rate = finiteNumber(fx?.rate);
  const timestamp = isoTimestamp(fx?.timestamp);
  if (value === null || !/^[A-Z]{3}$/.test(String(from || "")) || !/^[A-Z]{3}$/.test(String(to || ""))) return null;
  if (from === to) return { amount: value, currency: to, source: "identity", rate: 1, convertedAt: timestamp || new Date().toISOString() };
  if (!fx || fx.base !== from || fx.quote !== to || rate === null || rate <= 0 || !timestamp || Date.now() - new Date(timestamp).getTime() > 24 * 60 * 60 * 1000 || new Date(timestamp).getTime() > Date.now() + 5 * 60 * 1000) return null;
  return { amount: value * rate, currency: to, source: String(fx.source || "unknown"), rate, convertedAt: timestamp };
}

export function formatDateTime(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  const zone = VALID_TIME_ZONES.includes(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat("en-AU", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone, timeZoneName: "short" }).format(date);
}

export function brierScore(forecasts) {
  const resolved = (Array.isArray(forecasts) ? forecasts : []).filter(f =>
    Number.isFinite(Number(f?.probability)) && Number(f.probability) >= 0 && Number(f.probability) <= 100 && (f?.outcome === 0 || f?.outcome === 1));
  if (!resolved.length) return null;
  return resolved.reduce((sum, f) => sum + ((Number(f.probability) / 100 - f.outcome) ** 2), 0) / resolved.length;
}

export function normalizeForecasts(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(f => f && typeof f === "object" && typeof f.question === "string" && Number.isFinite(Number(f.probability)) && Number(f.probability) >= 0 && Number(f.probability) <= 100 && (f.outcome === null || f.outcome === 0 || f.outcome === 1));
}

export function toggleWatchlist(items, market) {
  if (!Array.isArray(items) || !market || typeof market.id !== "string") return Array.isArray(items) ? items : [];
  return items.some(item => item?.id === market.id) ? items.filter(item => item?.id !== market.id) : [market, ...items];
}

export function validateAlertRules(input) {
  const minRoi = finiteNumber(input?.minRoi); const minSize = finiteNumber(input?.minSize);
  if (minRoi === null || minRoi < 0 || minRoi > 100 || minSize === null || minSize < 0 || minSize > 10_000_000) return null;
  return { minRoi, minSize };
}

export function calculateBacktest(candles) {
  const values = (Array.isArray(candles) ? candles : []).map(c => ({ close: finiteNumber(c?.close), timestamp: isoTimestamp(c?.timestamp) }))
    .filter(c => c.close !== null && c.close > 0).sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  if (values.length < 2) return { candles: values.length, warning: "Not enough valid positive historical closes for replay." };
  const first = values[0].close, last = values.at(-1).close;
  let peak = first, maxDrawdownPct = 0;
  for (const { close } of values) { peak = Math.max(peak, close); maxDrawdownPct = Math.max(maxDrawdownPct, (peak - close) / peak * 100); }
  return { candles: values.length, first, last, buyHoldPct: (last / first - 1) * 100, maxDrawdownPct, from: values[0].timestamp, to: values.at(-1).timestamp };
}

export function paperSettlement({ stake, side, entryProbability, outcome }) {
  const amount = finiteNumber(stake);
  const probability = finiteNumber(entryProbability);
  if (amount === null || amount <= 0 || probability === null || probability <= 0 || probability >= 100 || !["YES", "NO"].includes(side) || (outcome !== 0 && outcome !== 1)) return null;
  const chosenOutcome = side === "YES" ? 1 : 0;
  const winning = chosenOutcome === outcome;
  const sidePrice = side === "YES" ? probability : 100 - probability;
  const payout = winning ? amount / (sidePrice / 100) : 0;
  return { winning, payout, profitLoss: payout - amount, classification: "simulated_paper_settlement" };
}

export function safeParseStorage(storage, key, fallback, validate = value => value) {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    return validate(JSON.parse(raw));
  } catch {
    return fallback;
  }
}