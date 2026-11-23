import test from "node:test";
import assert from "node:assert/strict";
import { runAsxAutopilot, readAsxAutopilot, __test } from "../asx-autopilot.js";
import { createPaperPortfolio, evaluateAsxSwingSetup, openPaperPosition } from "../autonomous-engine.js";

function kv(seed = null) {
  const values = new Map(seed ? [[__test.STORAGE_KEY, seed]] : []);
  return { values, binding: { get: async key => values.get(key) ?? null, put: async (key, value) => values.set(key, value) } };
}
function bars(now) {
  return Array.from({ length: 55 }, (_, i) => {
    const close = i === 54 ? 15.8 : 10 + i * 0.08;
    return {
      sid: "asx:BHP", timeframe: "1Day", ts_ms: now - (54 - i) * 86_400_000,
      open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 1000
    };
  });
}
function provider(now, calls) {
  return async (url, options) => {
    calls.push({ url: new URL(url), key: options.headers["X-API-Key"] });
    return new Response(JSON.stringify({ data: { "asx:BHP": bars(now) } }), { headers: { "Content-Type": "application/json" } });
  };
}

test("ASX autopilot stays disabled unless the operator explicitly enables it", async () => {
  let called = false;
  const result = await runAsxAutopilot({ ASX_AUTOPILOT_SYMBOLS: "BHP", DATACEDAR_API_KEY: "secret", EDGE_KV: kv().binding }, {
    now: new Date("2026-11-23T02:00:00Z"), fetchImpl: async () => { called = true; }
  });
  assert.equal(result.status, "DISABLED");
  assert.equal(result.liveTradingEnabled, false);
  assert.equal(called, false);
});

test("ASX autopilot reports missing key and storage without calling DataCedar", async () => {
  const noStorage = await runAsxAutopilot({ ASX_AUTOPILOT_ENABLED: "true", ASX_AUTOPILOT_SYMBOLS: "BHP", DATACEDAR_API_KEY: "secret" });
  assert.equal(noStorage.status, "BLOCKED_STORAGE_NOT_CONFIGURED");
  const noKey = await runAsxAutopilot({ ASX_AUTOPILOT_ENABLED: "true", ASX_AUTOPILOT_SYMBOLS: "BHP", EDGE_KV: kv().binding });
  assert.equal(noKey.status, "BLOCKED_DATACEDAR_KEY_MISSING");
});

test("ASX autopilot validates DataCedar data, records a paper-only scan and never forces an uneconomic entry", async () => {
  const now = Date.parse("2026-11-23T02:00:00Z");
  const store = kv();
  const calls = [];
  const result = await runAsxAutopilot({
    ASX_AUTOPILOT_ENABLED: "true", ASX_AUTOPILOT_SYMBOLS: "BHP", DATACEDAR_API_KEY: "server-secret", EDGE_KV: store.binding
  }, { now: new Date(now), fetchImpl: provider(now, calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.hostname, "api.datacedar.com");
  assert.equal(calls[0].key, "server-secret");
  assert.equal(result.status, "SCAN_COMPLETED");
  assert.equal(result.mode, "AUTOMATED_ASX_PAPER_ONLY");
  assert.equal(result.liveTradingEnabled, false);
  assert.equal(result.portfolio.mode, "PAPER_ONLY");
  assert.equal(result.portfolio.positions.length, 0);
  assert.equal(result.scanCount, 1);
  assert.ok(result.signals.some(signal => signal.symbol === "BHP" && signal.status === "REJECTED"));
  const persisted = JSON.parse(store.values.get(__test.STORAGE_KEY));
  assert.equal(persisted.liveTradingEnabled, false);
  assert.equal(persisted.portfolio.cashAud, 500);
});

test("ASX autopilot processes each daily bar only once", async () => {
  const now = Date.parse("2026-11-23T02:00:00Z");
  const store = kv();
  const config = { ASX_AUTOPILOT_ENABLED: "true", ASX_AUTOPILOT_SYMBOLS: "BHP", DATACEDAR_API_KEY: "secret", EDGE_KV: store.binding };
  await runAsxAutopilot(config, { now: new Date(now), fetchImpl: provider(now, []) });
  const second = await runAsxAutopilot(config, { now: new Date(now + 6 * 60 * 60_000 + 60_000), fetchImpl: provider(now, []) });
  assert.equal(second.scanCount, 2);
  assert.equal(second.signals.length, 1);
});

test("ASX autopilot refuses to overwrite a corrupt paper ledger", async () => {
  const store = kv("not-json");
  const before = store.values.get(__test.STORAGE_KEY);
  await assert.rejects(() => runAsxAutopilot({
    ASX_AUTOPILOT_ENABLED: "true", ASX_AUTOPILOT_SYMBOLS: "BHP", DATACEDAR_API_KEY: "secret", EDGE_KV: store.binding
  }, { now: new Date("2026-11-23T02:00:00Z"), fetchImpl: provider(Date.parse("2026-11-23T02:00:00Z"), []) }), /corrupt|invalid JSON/i);
  assert.equal(store.values.get(__test.STORAGE_KEY), before);
});

test("ASX autopilot status is explicitly unconfigured without Worker KV", async () => {
  const status = await readAsxAutopilot({});
  assert.equal(status.status, "BLOCKED_STORAGE_NOT_CONFIGURED");
  assert.equal(status.liveTradingEnabled, false);
});


test("ASX autopilot exits at a gap-worse open, resolves stop before target and does not re-enter on the same bar", async () => {
  const firstNow = Date.parse("2026-11-23T02:00:00Z");
  const firstRows = bars(firstNow);
  const firstBars = firstRows.map(row => ({
    timestamp: new Date(row.ts_ms).toISOString(), open: row.open, high: row.high,
    low: row.low, close: row.close, volume: row.volume
  }));
  const candidate = evaluateAsxSwingSetup({
    symbol: "BHP", bars: firstBars, source: "DataCedar ASX historical daily bars",
    currency: "AUD", observedAt: new Date(firstNow).toISOString(),
    equityAud: 5000, cashAud: 5000, now: firstNow
  });
  assert.equal(candidate.status, "PAPER_CANDIDATE", candidate.reason);
  const openedAt = firstNow + 1000;
  const opened = openPaperPosition(createPaperPortfolio({ capitalAud: 5000 }), candidate, {
    id: "asx-auto-BHP-2026-11-23", openedAt: new Date(openedAt).toISOString(), now: openedAt
  });
  assert.equal(opened.accepted, true, opened.reason);
  const initial = {
    ...__test.initialSnapshot(),
    portfolio: opened.portfolio,
    lastScanAt: new Date(openedAt).toISOString(),
    lastBarBySymbol: { BHP: new Date(firstNow).toISOString() },
    scanCount: 1
  };
  const store = kv(JSON.stringify(initial));
  const nextNow = firstNow + 2 * 86_400_000;
  const nextRows = bars(nextNow);
  const latest = nextRows.at(-1);
  latest.open = opened.position.stopPrice - 0.2;
  latest.low = latest.open - 0.1;
  latest.close = opened.position.targetPrice + 0.1;
  latest.high = latest.close + 0.1;
  const fetchImpl = async () => new Response(JSON.stringify({ data: { "asx:BHP": nextRows } }), {
    headers: { "Content-Type": "application/json" }
  });
  const result = await runAsxAutopilot({
    ASX_AUTOPILOT_ENABLED: "true", ASX_AUTOPILOT_SYMBOLS: "BHP",
    DATACEDAR_API_KEY: "server-secret", EDGE_KV: store.binding
  }, { now: new Date(nextNow), fetchImpl });
  assert.equal(result.portfolio.positions.length, 0);
  assert.equal(result.portfolio.closedTrades.length, 1);
  assert.equal(result.portfolio.closedTrades[0].exitPrice, latest.open);
  assert.ok(result.signals.some(signal => signal.status === "POSITION_CLOSED_PAPER" && /stop-first.*gap-aware/i.test(signal.reason)));
  assert.equal(result.signals.some(signal => signal.status === "OPEN_REJECTED" || signal.status === "OPENED_PAPER"), false);
});
