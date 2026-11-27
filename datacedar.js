const BASE_URL = "https://api.datacedar.com/v3";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SYMBOLS = 3;
const TICKER = /^[A-Z0-9.]{2,12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeDataCedarSymbols(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(",");
  if (!input.length || input.length > MAX_SYMBOLS) throw new Error("Enter between one and three ASX tickers on the free DataCedar plan.");
  const symbols = input.map(item => String(item || "").trim().toUpperCase());
  if (symbols.some(symbol => !TICKER.test(symbol)) || new Set(symbols).size !== symbols.length) {
    throw new Error("ASX tickers must be unique 2–12 character codes using letters, numbers or dots.");
  }
  return symbols;
}

function validDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseDataCedarBars(payload, symbols, { retrievedAt = new Date().toISOString(), from = null, to = null } = {}) {
  if (!payload || typeof payload !== "object" || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    throw new Error("DataCedar response did not contain the documented symbol-to-bars map.");
  }
  const barsBySymbol = {};
  const rowsBySymbol = {};
  for (const ticker of symbols) {
    const sid = `asx:${ticker}`;
    const rows = payload.data[sid];
    if (rows == null) { barsBySymbol[ticker] = []; rowsBySymbol[ticker] = 0; continue; }
    if (!Array.isArray(rows) || rows.length > 50_000) throw new Error(`DataCedar returned an invalid bar series for ${ticker}.`);
    const bars = rows.map(row => {
      if (!row || typeof row !== "object" || row.sid !== sid || row.adjustment && row.adjustment !== "raw" || row.timeframe && !["1Day", "1d"].includes(row.timeframe)) {
        throw new Error(`DataCedar returned a malformed or mismatched bar for ${ticker}.`);
      }
      const epoch = Number(row.ts_ms);
      const parsedDate = Number.isSafeInteger(epoch) && epoch > 0 ? new Date(epoch) : null;
      const timestamp = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString() : null;
      const open = Number(row.open), high = Number(row.high), low = Number(row.low), close = Number(row.close);
      const volume = row.volume == null ? null : Number(row.volume);
      if (!timestamp || ![open, high, low, close].every(value => Number.isFinite(value) && value > 0) ||
        high < Math.max(open, close) || low > Math.min(open, close) || low > high ||
        (volume !== null && (!Number.isFinite(volume) || volume < 0)) ||
        (from && timestamp.slice(0, 10) < from) || (to && timestamp.slice(0, 10) > to)) {
        throw new Error(`DataCedar returned invalid OHLCV values or an out-of-range date for ${ticker}.`);
      }
      return { timestamp, open, high, low, close, volume };
    });
    bars.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].timestamp === bars[i - 1].timestamp) throw new Error(`DataCedar returned duplicate daily bars for ${ticker}.`);
    }
    barsBySymbol[ticker] = bars;
    rowsBySymbol[ticker] = bars.length;
  }
  const populated = Object.values(barsBySymbol).flat();
  const latestBar = populated.length ? populated.reduce((latest, bar) => bar.timestamp > latest ? bar.timestamp : latest, populated[0].timestamp) : null;
  return {
    status: populated.length ? "live" : "no_data",
    source: "DataCedar ASX historical daily bars",
    sourceUrl: "https://datacedar.com/markets/australia",
    retrievedAt,
    currency: "AUD",
    exchange: "ASX",
    timeframe: "1d",
    adjustment: "raw",
    symbols,
    rowsBySymbol,
    barsBySymbol,
    rows: populated.length,
    latestBar,
    dataClass: "historical_market_data_not_realtime",
    disclaimer: "Historical source-attributed daily bars for research and paper simulation; not a consolidated real-time feed or best-execution record."
  };
}

export async function fetchDataCedarBars({ symbols, from, to, apiKey, fetchImpl = fetch, now = new Date(), clock = () => new Date() } = {}) {
  const tickers = normalizeDataCedarSymbols(symbols);
  const today = now.toISOString().slice(0, 10);
  const defaultFrom = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  const start = from || defaultFrom;
  const end = to || today;
  if (!validDate(start) || !validDate(end) || start > end) throw new Error("DataCedar date range must use valid YYYY-MM-DD dates with start before end.");
  if ((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) > 366 * 86_400_000) {
    throw new Error("The free Explorer integration is limited to a maximum 366-day daily-bar request.");
  }
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 512) throw new Error("DataCedar API key is not configured.");
  const url = new URL(`${BASE_URL}/stocks/bars`);
  url.search = new URLSearchParams({
    symbols: tickers.map(ticker => `asx:${ticker}`).join(","),
    timeframe: "1d", from: start, to: end, adjustment: "raw", order: "asc", limit: "50000"
  }).toString();
  const response = await fetchImpl(url, {
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (response.url && new URL(response.url).hostname !== "api.datacedar.com") throw new Error("DataCedar redirected to an unexpected host.");
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new Error("DataCedar response exceeds the 4 MB limit.");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("DataCedar response exceeds the 4 MB limit.");
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("DataCedar returned invalid JSON."); }
  if (!response.ok) {
    const code = payload?.error?.code;
    if (response.status === 401) throw new Error("DataCedar rejected the API key. Check the DATACEDAR_API_KEY Worker secret.");
    if (response.status === 403) throw new Error(code === "HISTORY_LIMIT_EXCEEDED" ? "Requested history exceeds the DataCedar plan window." : "DataCedar denied this request under the current plan or access rights.");
    if (response.status === 404) throw new Error(code === "EXCHANGE_NOT_LIVE" ? "DataCedar has not activated ASX bars for this request." : "DataCedar could not find the requested ASX symbol or exchange.");
    if (response.status === 429) throw new Error("DataCedar rate limit reached. Wait before retrying.");
    throw new Error(`DataCedar request failed with HTTP ${response.status}.`);
  }
  const retrievalClock = clock();
  const retrievalDate = retrievalClock instanceof Date ? retrievalClock : new Date(retrievalClock);
  if (!Number.isFinite(retrievalDate.getTime())) throw new Error("DataCedar retrieval timestamp is invalid.");
  const retrievedAt = retrievalDate.toISOString();
  return parseDataCedarBars(payload, tickers, { retrievedAt, from: start, to: end });
}
