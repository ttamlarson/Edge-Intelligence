import { finiteNumber } from "./domain.js";

const nowIso = () => new Date().toISOString();
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

async function fetchSource(url, { headers = {}, fetchImpl = fetch, maxBytes = MAX_SOURCE_BYTES } = {}) {
  const response = await fetchImpl(url, { headers: { "User-Agent": "EDGE-Intelligence/1.0 (+Australian research dashboard)", ...headers }, signal: AbortSignal.timeout(8000) });
  if (response.url && new URL(response.url).hostname !== new URL(url).hostname) throw new Error("Australian source redirected to an unexpected host.");
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("Source response exceeds the size limit.");
  if (!response.body) return { text: "", response, retrievedAt: nowIso() };
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("Source response exceeds the size limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  return { text, response, retrievedAt: nowIso() };
}

function decodeHtml(value = "") {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, " ").trim();
}

function xmlValue(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? decodeHtml(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")) : "";
}

function parseRbaCashRate(html, retrievedAt) {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const observations = [];
  for (const [, row] of rows) {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cell]) => decodeHtml(cell));
    const dateMatch = cells[0]?.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
    const rate = finiteNumber(cells[2]?.replace(/%/g, "").trim());
    if (!dateMatch || rate === null || rate < 0 || rate > 100) continue;
    const date = new Date(`${dateMatch[2]} ${dateMatch[1]}, ${dateMatch[3]} 00:00:00 UTC`);
    if (!Number.isFinite(date.getTime())) continue;
    observations.push({
      metric: "RBA cash rate target", value: rate, unit: "percent", currency: null,
      observationPeriod: date.toISOString().slice(0, 10), publishedAt: null,
      sourceUrl: "https://www.rba.gov.au/statistics/cash-rate/", retrievedAt,
      sourceTimezone: "Australia/Sydney", status: "official_observation"
    });
  }
  if (!observations.length) throw new Error("RBA cash-rate page did not contain a valid observation table.");
  return observations.slice(0, 20);
}

function parseRbaRss(xml, retrievedAt, sourceUrl) {
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 20).map(([, item]) => {
    const title = xmlValue(item, "title");
    const link = xmlValue(item, "link");
    const published = xmlValue(item, "pubDate");
    const publishedAt = published && Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null;
    if (!title || !link || !/^https:\/\/www\.rba\.gov\.au\//.test(link)) return null;
    return { title, sourceUrl: link, feedUrl: sourceUrl, publishedAt, observationPeriod: null, retrievedAt, sourceTimezone: "Australia/Sydney", status: "official_release" };
  }).filter(Boolean);
  if (!items.length) throw new Error("RBA feed did not contain valid release items.");
  return items;
}

function parseAbsSdmx(payload, flow, retrievedAt) {
  const dataSet = payload?.data?.dataSets?.[0];
  const structure = payload?.data?.structure;
  if (!dataSet || !structure?.dimensions?.observation) throw new Error("ABS response did not match the documented SDMX JSON structure.");
  const dims = structure.dimensions.observation;
  const timeIndex = dims.findIndex(d => /TIME_PERIOD|TIME/i.test(d.id || ""));
  if (timeIndex < 0) throw new Error("ABS response did not include a time-period dimension.");
  const timeValues = dims[timeIndex]?.values || [];
  const records = [];
  const series = dataSet.series || {};
  for (const seriesEntry of Object.values(series)) {
    const observations = seriesEntry?.observations;
    if (!observations || typeof observations !== "object") continue;
    for (const [key, tuple] of Object.entries(observations)) {
      const periodIndex = Number(key.split(":")[timeIndex]);
      const period = timeValues[periodIndex]?.id;
      const value = finiteNumber(Array.isArray(tuple) ? tuple[0] : tuple?.value);
      if (!period || value === null) continue;
      records.push({ metric: flow, value, unit: null, currency: null, observationPeriod: period, publishedAt: null, sourceUrl: `https://indicator.api.abs.gov.au/v1/data/${encodeURIComponent(flow)}/json`, retrievedAt, sourceTimezone: "Australia/Sydney", status: "official_observation" });
    }
  }
  const topLevel = dataSet.observations;
  if (!records.length && topLevel && typeof topLevel === "object") {
    for (const [key, tuple] of Object.entries(topLevel)) {
      const period = timeValues[Number(key.split(":")[timeIndex])]?.id;
      const value = finiteNumber(Array.isArray(tuple) ? tuple[0] : tuple?.value);
      if (period && value !== null) records.push({ metric: flow, value, unit: null, currency: null, observationPeriod: period, publishedAt: null, sourceUrl: `https://indicator.api.abs.gov.au/v1/data/${encodeURIComponent(flow)}/json`, retrievedAt, sourceTimezone: "Australia/Sydney", status: "official_observation" });
    }
  }
  if (!records.length) throw new Error("ABS response contained no usable observations.");
  return records.slice(-500);
}

const BOM_STATIONS = Object.freeze({
  perth: { city: "Perth", product: "IDW60901", station: "94608", timeZone: "Australia/Perth", sourceTimezone: "AWST" },
  sydney: { city: "Sydney", product: "IDN60901", station: "94768", timeZone: "Australia/Sydney", sourceTimezone: "Australia/Sydney" }
});

function parseBomObservations(payload, station, retrievedAt) {
  const rows = payload?.observations?.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("BOM response did not contain observation rows.");
  const actualTimezone = payload?.observations?.header?.[0]?.time_zone || station.sourceTimezone;
  return rows.slice(0, 12).map(row => {
    if (!row || typeof row !== "object" || typeof row.local_date_time_full !== "string") throw new Error("BOM observation row is malformed.");
    const utcText = typeof row.aifstime_utc === "string" ? row.aifstime_utc : "";
    const observedAt = /^\d{14}$/.test(utcText) ? `${utcText.slice(0, 4)}-${utcText.slice(4, 6)}-${utcText.slice(6, 8)}T${utcText.slice(8, 10)}:${utcText.slice(10, 12)}:${utcText.slice(12, 14)}Z` : null;
    return {
      metric: `BOM observation — ${station.city}`, location: row.name || station.city,
      temperatureC: finiteNumber(row.air_temp), apparentTemperatureC: finiteNumber(row.apparent_t),
      rainfallSince9amMm: finiteNumber(row.rain_trace), relativeHumidityPct: finiteNumber(row.rel_hum),
      windKmh: finiteNumber(row.wind_spd_kmh), pressureHpa: finiteNumber(row.press),
      unit: "metric", currency: null, observationPeriod: row.local_date_time || row.local_date_time_full,
      observedAt, sourceLocalTime: row.local_date_time_full, publishedAt: null, sourceUrl: `https://www.bom.gov.au/fwo/${station.product}/${station.product}.${station.station}.json`,
      retrievedAt, sourceTimezone: station.timeZone, sourceTimezoneAbbreviation: actualTimezone, status: "official_observation_unchecked_quality"
    };
  });
}

export async function fetchAbsIndicators({ flow = "CPI_H", format = "json", env = {}, fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(flow) || !["json", "csv", "xml"].includes(format)) throw new Error("Invalid ABS dataflow or format.");
  if (!env.ABS_INDICATOR_API_KEY) return { status: "requires_external_access", source: "ABS Indicator API", message: "Request an ABS Indicator API key and set it as Worker secret ABS_INDICATOR_API_KEY.", records: [] };
  const url = `https://indicator.api.abs.gov.au/v1/data/${encodeURIComponent(flow)}/${format}`;
  const result = await fetchSource(url, { headers: { "x-api-key": env.ABS_INDICATOR_API_KEY, Accept: "application/vnd.sdmx.data+json" }, fetchImpl });
  if (format !== "json") return { status: "source_response", source: "ABS Indicator API", sourceUrl: url, retrievedAt: result.retrievedAt, contentType: result.response.headers.get("Content-Type"), data: result.text.slice(0, 1_000_000) };
  let payload;
  try { payload = JSON.parse(result.text); } catch { throw new Error("ABS returned invalid JSON."); }
  return { status: "live", source: "ABS Indicator API", sourceUrl: url, retrievedAt: result.retrievedAt, records: parseAbsSdmx(payload, flow, result.retrievedAt) };
}

export async function fetchRbaCashRate({ fetchImpl = fetch } = {}) {
  const sourceUrl = "https://www.rba.gov.au/statistics/cash-rate/";
  const result = await fetchSource(sourceUrl, { headers: { Accept: "text/html" }, fetchImpl });
  return { status: "live", source: "Reserve Bank of Australia", sourceUrl, retrievedAt: result.retrievedAt, records: parseRbaCashRate(result.text, result.retrievedAt) };
}

export async function fetchRbaReleases({ fetchImpl = fetch } = {}) {
  const sourceUrl = "https://www.rba.gov.au/rss/rss-cb-media-releases.xml";
  const result = await fetchSource(sourceUrl, { headers: { Accept: "application/rss+xml, application/xml, text/xml" }, fetchImpl });
  return { status: "live", source: "Reserve Bank of Australia media releases", sourceUrl, retrievedAt: result.retrievedAt, records: parseRbaRss(result.text, result.retrievedAt, sourceUrl) };
}

export async function fetchBomObservations({ city = "perth", env = {}, fetchImpl = fetch } = {}) {
  const station = BOM_STATIONS[String(city).toLowerCase()];
  if (!station) throw new Error("Unsupported BOM station. Supported stations: Perth and Sydney.");
  if (env.BOM_DATA_LICENSED !== "true") return { status: "requires_external_access", source: "Bureau of Meteorology", sourceUrl: "https://www.bom.gov.au/catalogue/data-feeds.shtml", licensing: "BOM anonymous products are for personal and non-commercial use. Confirm applicable rights and set Worker variable BOM_DATA_LICENSED=true before displaying data to users.", records: [] };
  const sourceUrl = `https://www.bom.gov.au/fwo/${station.product}/${station.product}.${station.station}.json`;
  const result = await fetchSource(sourceUrl, { headers: { Accept: "application/json" }, fetchImpl });
  let payload;
  try { payload = JSON.parse(result.text); } catch { throw new Error("BOM returned invalid JSON."); }
  return { status: "live", source: "Bureau of Meteorology", sourceUrl, retrievedAt: result.retrievedAt, licensing: "Check the specific BOM product terms; anonymous products are not for commercial use unless the applicable terms allow it.", records: parseBomObservations(payload, station, result.retrievedAt) };
}

export function aecIntegrationStatus({ configured = false } = {}) {
  return {
    status: configured ? "bridge_configured_live_check_required" : "requires_external_access",
    source: "Australian Electoral Commission",
    sourceUrl: "https://www.aec.gov.au/media/mediafeed/",
    archiveUrl: "https://results.aec.gov.au/",
    message: configured ? "An HTTPS bridge is configured. Retrieve results to validate the bridge response; configuration alone is not live verification." : "The AEC publishes official tally-room results and a registered Media Feed over FTP. Obtain AEC Media Feed access and configure a separately hosted, authenticated HTTPS ingestion service before live result records can be shown.",
    records: []
  };
}

const AEC_MAX_BYTES = 2 * 1024 * 1024;
const AEC_SOURCE_HOSTS = new Set(["results.aec.gov.au", "aec.gov.au", "www.aec.gov.au"]);
const isPublicDnsHost = host => /^[a-z0-9.-]+$/.test(host) && host.includes(".") && !host.endsWith(".") && !/(?:^|\.)[0-9]+$/.test(host) && !/^(?:[0-9]+\.){3}[0-9]+$/.test(host) && !/(?:^|\.)(?:localhost|local|internal|test)$/.test(host);

function validAecHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && AEC_SOURCE_HOSTS.has(url.hostname) && !url.port;
  } catch { return false; }
}

function parseAecBridge(payload, sourceUrl, retrievedAt) {
  if (!payload || payload.schema !== "edge.aec.results.v1" || !Array.isArray(payload.records) || payload.records.length > 500) {
    throw new Error("AEC bridge response did not match schema edge.aec.results.v1.");
  }
  const records = payload.records.map(record => {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("AEC bridge returned a malformed result record.");
    const { id, eventName, contest, candidate, party, votes, percent, status, observationPeriod, publishedAt, sourceUrl: recordUrl } = record;
    const voteCount = finiteNumber(votes); const share = percent == null ? null : finiteNumber(percent);
    if (typeof id !== "string" || !id.trim() || id.length > 160 || typeof eventName !== "string" || !eventName.trim() || eventName.length > 300 ||
      typeof candidate !== "string" || !candidate.trim() || candidate.length > 300 || voteCount === null || voteCount < 0 ||
      (share !== null && (share < 0 || share > 100)) || typeof observationPeriod !== "string" || !observationPeriod.trim() ||
      observationPeriod.length > 100 || !Number.isFinite(Date.parse(publishedAt)) || !validAecHttpsUrl(recordUrl) || recordUrl.length > 2048) {
      throw new Error("AEC bridge result failed field, timestamp or official-source validation.");
    }
    return {
      id, metric: eventName, eventName, contest: typeof contest === "string" ? contest.slice(0, 300) : null,
      candidate, party: typeof party === "string" ? party.slice(0, 200) : null, votes: voteCount,
      percent: share, resultStatus: typeof status === "string" ? status.slice(0, 80) : "status_not_supplied",
      observationPeriod: observationPeriod.slice(0, 80), publishedAt: new Date(publishedAt).toISOString(),
      sourceUrl: recordUrl, bridgeUrl: sourceUrl, retrievedAt, sourceTimezone: typeof record.sourceTimezone === "string" ? record.sourceTimezone.slice(0, 100) : null,
      status: "bridge_data_schema_validated_source_not_independently_verified"
    };
  });
  return records;
}

export async function fetchAecResults({ env = {}, fetchImpl = fetch } = {}) {
  const sourceUrl = String(env.AEC_INGESTION_URL || "");
  const expectedHost = String(env.AEC_INGESTION_HOST || "").toLowerCase();
  const token = env.AEC_INGESTION_TOKEN;
  let parsedUrl;
  try { parsedUrl = new URL(sourceUrl); } catch { parsedUrl = null; }
  if (!parsedUrl || parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.hash || parsedUrl.search || parsedUrl.port ||
    !/^(?=.{1,253}$)[a-z0-9.-]+$/.test(expectedHost) || !isPublicDnsHost(expectedHost) || parsedUrl.hostname !== expectedHost || !token || String(token).length > 4096) {
    return aecIntegrationStatus({ configured: false });
  }
  const result = await fetchSource(sourceUrl, { fetchImpl, maxBytes: AEC_MAX_BYTES, headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  let payload;
  try { payload = JSON.parse(result.text); } catch { throw new Error("AEC ingestion bridge returned invalid JSON."); }
  return {
    status: "bridge_data_schema_validated_source_not_independently_verified",
    source: "AEC Media Feed via HTTPS ingestion bridge", bridgeUrl: sourceUrl,
    sourceUrl: "https://results.aec.gov.au/", retrievedAt: result.retrievedAt,
    verification: "Bridge schema and source URLs validated; AEC feed provenance and result finality still require independent confirmation.",
    records: parseAecBridge(payload, sourceUrl, result.retrievedAt)
  };
}

export const sourceMetadata = [
  { id: "abs", name: "ABS", category: "Australian economic statistics", status: "key_required", sourceUrl: "https://www.abs.gov.au/statistics/application-programming-interfaces-apis/indicator-api", licensing: "ABS Indicator API key, terms of use and API registration required." },
  { id: "rba", name: "RBA", category: "Cash rate and monetary policy releases", status: "public_official_pages", sourceUrl: "https://www.rba.gov.au/statistics/cash-rate/", licensing: "Public RBA pages and feeds; observe page/feed terms. RBA exchange-rate and broader statistical series are not included in this adapter." },
  { id: "aec", name: "AEC", category: "Federal election results", status: "registered_feed_and_bridge_required", sourceUrl: "https://www.aec.gov.au/media/mediafeed/", licensing: "Register for the AEC Media Feed, operate a bridge that polls the FTP feed and emits the documented EDGE JSON contract, and set the bridge URL, exact host and Worker token. Bridge schema validation does not independently prove AEC provenance or finality." },
  { id: "bom", name: "Bureau of Meteorology", category: "Weather observations; forecast and warning adapters pending", status: "user_facing_rights_confirmation_required", sourceUrl: "https://www.bom.gov.au/catalogue/data-feeds.shtml", licensing: "BOM anonymous products and RSS feeds are limited to personal/non-commercial use. Obtain appropriate registered data access or rights before enabling public or commercial distribution. Observation endpoint is rights-gated; forecast and warning records are not integrated." },
  { id: "asx", name: "ASX", category: "Licensed market data", status: "license_required", sourceUrl: "https://www.asx.com.au/connectivity-and-data/information-services/real-time-data", licensing: "No ASX data is fetched or displayed until access and data rights are configured." },
  { id: "fex", name: "FEX Global", category: "Energy, commodity and environmental derivatives", status: "not_integrated", sourceUrl: "https://www.fexglobal.com.au/market-notices", licensing: "No event-contract product/API verified; current market notice reports trading halt pending clearing/settlement arrangements." }
];