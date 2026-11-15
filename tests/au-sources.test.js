import test from "node:test";
import assert from "node:assert/strict";
import { fetchAbsIndicators, fetchAecResults, fetchBomObservations, fetchRbaCashRate, fetchRbaReleases, aecIntegrationStatus } from "../au-sources.js";

const response = body => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });

test("ABS Indicator adapter stays disabled until its registered secret is configured", async () => {
  const result = await fetchAbsIndicators({ env: {} });
  assert.equal(result.status, "requires_external_access");
  assert.equal(result.records.length, 0);
});

test("ABS adapter validates and maps SDMX observations with source metadata", async () => {
  const fixture = {
    data: {
      dataSets: [{ series: { "0": { observations: { "0": ["4.2"], "1": ["3.8"] } } } }],
      structure: { dimensions: { observation: [{ id: "TIME_PERIOD", values: [{ id: "2026-Q1" }, { id: "2026-Q2" }] }], series: [] } }
    }
  };
  const result = await fetchAbsIndicators({ flow: "CPI_H", env: { ABS_INDICATOR_API_KEY: "mock-key" }, fetchImpl: async (url, init) => {
    assert.equal(url, "https://indicator.api.abs.gov.au/v1/data/CPI_H/json");
    assert.equal(init.headers["x-api-key"], "mock-key");
    return response(JSON.stringify(fixture));
  } });
  assert.equal(result.status, "live");
  assert.equal(result.records[0].value, 4.2);
  assert.equal(result.records[0].observationPeriod, "2026-Q1");
  assert.match(result.records[0].sourceUrl, /indicator\.api\.abs\.gov\.au/);
});

test("ABS adapter rejects a malformed API response", async () => {
  await assert.rejects(fetchAbsIndicators({ env: { ABS_INDICATOR_API_KEY: "mock-key" }, fetchImpl: async () => response(JSON.stringify({ data: { dataSets: [] } })) }), /SDMX JSON structure/);
});

test("RBA cash-rate adapter parses official HTML table and observation date", async () => {
  const html = "<table><tr><th>Date</th><th>Change</th><th>Target</th></tr><tr><td>4 Nov 2026</td><td>+0.25</td><td>4.85</td></tr></table>";
  const result = await fetchRbaCashRate({ fetchImpl: async url => { assert.equal(url, "https://www.rba.gov.au/statistics/cash-rate/"); return response(html); } });
  assert.equal(result.records[0].value, 4.85);
  assert.equal(result.records[0].unit, "percent");
  assert.equal(result.records[0].observationPeriod, "2026-11-04");
  assert.equal(result.records[0].sourceTimezone, "Australia/Sydney");
});

test("RBA adapter fails safely if the official page schema changes", async () => {
  await assert.rejects(fetchRbaCashRate({ fetchImpl: async () => response("<html>Maintenance</html>") }), /valid observation table/);
});

test("RBA release feed validates official source URLs and publication dates", async () => {
  const xml = `<rss><channel><item><title><![CDATA[Monetary Policy Decision]]></title><link>https://www.rba.gov.au/media-releases/2026/mr-26-01.html</link><pubDate>Fri, 13 Nov 2026 04:30:00 GMT</pubDate></item></channel></rss>`;
  const result = await fetchRbaReleases({ fetchImpl: async url => { assert.match(url, /rss-cb-media-releases\.xml/); return response(xml); } });
  assert.equal(result.records[0].title, "Monetary Policy Decision");
  assert.equal(result.records[0].publishedAt, "2026-11-13T04:30:00.000Z");
});

test("BOM adapter validates station responses and retains official observation metadata", async () => {
  const fixture = { observations: { header: [{ time_zone: "AWST" }], data: [{ name: "PERTH METRO", local_date_time: "13/10:00am", local_date_time_full: "20261113100000", aifstime_utc: "20261113020000", air_temp: 23.2, apparent_t: 22.1, rain_trace: "0.0", rel_hum: 40, wind_spd_kmh: 12, press: 1015 }] } };
  const result = await fetchBomObservations({ city: "perth", env: { BOM_DATA_LICENSED: "true" }, fetchImpl: async url => { assert.match(url, /IDW60901\/IDW60901\.94608\.json/); return response(JSON.stringify(fixture)); } });
  assert.equal(result.records[0].temperatureC, 23.2);
  assert.equal(result.records[0].location, "PERTH METRO");
  assert.equal(result.records[0].currency, null);
  assert.equal(result.records[0].observedAt, "2026-11-13T02:00:00Z");
  assert.match(result.licensing, /terms/i);
});

test("BOM invalid station and malformed feed fail closed", async () => {
  await assert.rejects(fetchBomObservations({ city: "nowhere" }), /Unsupported BOM station/);
  const blocked = await fetchBomObservations({ city: "perth" });
  assert.equal(blocked.status, "requires_external_access");
  await assert.rejects(fetchBomObservations({ city: "perth", env: { BOM_DATA_LICENSED: "true" }, fetchImpl: async () => response(JSON.stringify({ observations: { data: [{ air_temp: 20 }] } })) }), /malformed/);
});

test("AEC status reports feed registration and FTP ingestion as an external dependency", () => {
  const result = aecIntegrationStatus();
  assert.equal(result.records.length, 0);
  assert.match(result.message, /FTP/);
  assert.match(result.sourceUrl, /aec\.gov\.au/);
  assert.match(aecIntegrationStatus({ configured: true }).status, /bridge_configured/);
});

test("AEC bridge validates bounded result records and preserves source and timestamps", async () => {
  const payload = { schema: "edge.aec.results.v1", records: [{ id: "farrer-2026-x", eventName: "Farrer by-election", contest: "Farrer", candidate: "Candidate A", party: "Party A", votes: 1250, percent: 42.5, status: "provisional", observationPeriod: "2026-11-13T05:00:00Z", publishedAt: "2026-11-13T05:05:00Z", sourceUrl: "https://results.aec.gov.au/" }] };
  const env = { AEC_INGESTION_URL: "https://bridge.example.au/v1/results", AEC_INGESTION_HOST: "bridge.example.au", AEC_INGESTION_TOKEN: "test-token" };
  const result = await fetchAecResults({ env, fetchImpl: async (url, init) => {
    assert.equal(url, env.AEC_INGESTION_URL);
    assert.equal(init.headers.Authorization, "Bearer test-token");
    return response(JSON.stringify(payload));
  } });
  assert.equal(result.records[0].votes, 1250);
  assert.equal(result.records[0].percent, 42.5);
  assert.equal(result.records[0].publishedAt, "2026-11-13T05:05:00.000Z");
  assert.equal(result.records[0].sourceUrl, "https://results.aec.gov.au/");
  assert.match(result.status, /not_independently_verified/);
});

test("AEC bridge is disabled without endpoint credentials and rejects fabricated source hosts", async () => {
  const disabled = await fetchAecResults({ env: {} });
  assert.equal(disabled.status, "requires_external_access");
  const env = { AEC_INGESTION_URL: "https://bridge.example.au/v1/results", AEC_INGESTION_HOST: "bridge.example.au", AEC_INGESTION_TOKEN: "test-token" };
  const payload = { schema: "edge.aec.results.v1", records: [{ id: "1", eventName: "Election", candidate: "A", votes: 5, observationPeriod: "2026-11-13", publishedAt: "2026-11-13T00:00:00Z", sourceUrl: "https://fake-aec.example/" }] };
  await assert.rejects(fetchAecResults({ env, fetchImpl: async () => response(JSON.stringify(payload)) }), /official-source validation/);
  const invalidConfiguration = await fetchAecResults({ env: { ...env, AEC_INGESTION_URL: "http://bridge.example.au/v1/results" }, fetchImpl: async () => { throw new Error("must not fetch"); } });
  assert.equal(invalidConfiguration.status, "requires_external_access");
  const privateHost = await fetchAecResults({ env: { ...env, AEC_INGESTION_URL: "https://127.0.0.1/results", AEC_INGESTION_HOST: "127.0.0.1" }, fetchImpl: async () => { throw new Error("private destinations must never be fetched"); } });
  assert.equal(privateHost.status, "requires_external_access");
});