import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

test("CoinSpot resumable history rejects completed or non-contiguous windows before fetching", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("history fetch must not run for corrupt progress"); };
  try {
    const now = "2026-11-25T12:00:00.000Z";
    const startMs = Date.parse("2026-11-25T00:00:00.000Z");
    const endMs = startMs + 86400000;
    const midpoint = startMs + 43200000;
    const variants = [
      { format: "epoch", validAudTrades: 0, outOfRangeTrades: 0 },
      { format: "epoch-string", validAudTrades: 0, outOfRangeTrades: 0 },
      { format: "epoch-ms", validAudTrades: 1, outOfRangeTrades: 0 }
    ];
    const probeMarket = coin => ({
      coin,
      readOnlyHistory: { partitionHistory: [{ variants }, { variants }] }
    });
    const makeProgress = invalidBtc => ({
      targetDate: "2026-11-25",
      coins: {
        BTC: { ...invalidBtc, trades: [], apiCallsTotal: 0, saturatedWindows: 0 },
        ETH: {
          windows: [{ startMs, endMs }],
          processedThroughMs: startMs,
          trades: [],
          complete: false,
          apiCallsTotal: 0,
          saturatedWindows: 0
        }
      }
    });
    const cases = [
      {
        label: "complete flag with pending windows",
        btc: { windows: [{ startMs, endMs }], processedThroughMs: startMs, complete: true }
      },
      {
        label: "gap between remaining windows",
        btc: {
          windows: [{ startMs, endMs: midpoint }, { startMs: midpoint + 1000, endMs }],
          processedThroughMs: startMs,
          complete: false
        }
      }
    ];
    for (const item of cases) {
      const store = new Map();
      const state = {
        mode: "COINSPOT_AUD_RESEARCH_ONLY",
        status: "BACKFILLING",
        nextDate: "2026-11-25",
        lastProviderProbeAt: now,
        providerProbe: {
          readOnlyStatus: "AUTHENTICATED",
          markets: [probeMarket("BTC"), probeMarket("ETH")]
        },
        markets: {
          BTC: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 },
          ETH: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 }
        },
        pendingHistorySync: makeProgress(item.btc),
        liveTradingEnabled: false
      };
      const serialized = JSON.stringify(state);
      store.set("coinspot-mtf-history-global-v1", serialized);
      const env = {
        EDGE_KV: {
          get: async key => store.get(key) ?? null,
          put: async (key, value) => { store.set(key, value); }
        },
        COINSPOT_READONLY_KEY: "test-readonly-key",
        COINSPOT_READONLY_SECRET: "test-readonly-secret"
      };
      await assert.rejects(
        () => __test.syncCoinSpotMtfHistory(env, now),
        /history window coverage failed validation/,
        item.label
      );
      assert.equal(store.get("coinspot-mtf-history-global-v1"), serialized, item.label + " must preserve the original KV state");
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CoinSpot sync persists legacy partition reconciliation without repeating provider probes", async () => {
  const originalFetch = globalThis.fetch;
  const now = "2026-11-26T22:00:00.000Z";
  const date = "2026-11-26";
  const dayStart = Date.parse(date + "T00:00:00.000Z");
  const midpoint = dayStart + 12 * 60 * 60 * 1000;
  const variants = count => [
    { format: "epoch", rawBuyOrders: 0, rawSellOrders: 0, validAudTrades: 0, outOfRangeTrades: 0 },
    { format: "epoch-string", rawBuyOrders: 0, rawSellOrders: 0, validAudTrades: 0, outOfRangeTrades: 0 },
    { format: "epoch-ms", rawBuyOrders: count, rawSellOrders: 0, validAudTrades: count, outOfRangeTrades: 0 }
  ];
  const probeMarket = coin => ({
    coin, pair: coin + "/AUD",
    readOnlyHistory: {
      date, queryFormat: "date", rawBuyOrders: 2, rawSellOrders: 0,
      validAudTrades: 2, outOfRangeTrades: 0,
      partitionHistory: [
        { startAt: new Date(dayStart).toISOString(), endAt: new Date(midpoint).toISOString(), variants: variants(1) },
        { startAt: new Date(midpoint).toISOString(), endAt: new Date(dayStart + 86400000).toISOString(), variants: variants(1) }
      ]
    }
  });
  const store = new Map();
  store.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode: "COINSPOT_AUD_RESEARCH_ONLY", status: "COLLECTING_LIVE_DAY",
    startedAt: now, nextDate: date, lastProcessedDate: "2026-11-25",
    lastProviderProbeAt: now,
    providerProbe: {
      checkedAt: now, readOnlyStatus: "AUTHENTICATED",
      markets: [probeMarket("BTC"), probeMarket("ETH")]
    },
    markets: {
      BTC: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 },
      ETH: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 }
    },
    liveTradingEnabled: false
  }));
  const historyRequests = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.endsWith("/orders/market/completed")) {
      throw new Error("Unexpected provider-probe request; stored partition evidence should be reused: " + target);
    }
    const body = JSON.parse(options.body || "{}");
    historyRequests.push({ target, body });
    const coin = body.cointype;
    const row = {
      market: coin + "/AUD", solddate: date + "T10:00:00.000Z",
      rate: coin === "BTC" ? 90000 : 2500,
      amount: 0.01, total: coin === "BTC" ? 900 : 25
    };
    return new Response(JSON.stringify({ status: "ok", buyorders: [row], sellorders: [] }), { status: 200 });
  };
  try {
    const env = {
      COINSPOT_READONLY_KEY: "test-readonly-key",
      COINSPOT_READONLY_SECRET: "test-readonly-secret",
      EDGE_KV: {
        get: async key => store.get(key) ?? null,
        put: async (key, value) => { store.set(key, value); }
      }
    };
    const result = await __test.syncCoinSpotMtfHistory(env, now);
    const saved = JSON.parse(store.get("coinspot-mtf-history-global-v1"));
    assert.equal(result.status, "COLLECTING_LIVE_DAY");
    assert.equal(historyRequests.length, 2, "only the two normal full-day history requests should run");
    assert.ok(historyRequests.every(request => request.body.startdate === date));
    assert.equal(saved.lastProviderProbeAt, now, "the stored provider probe must not be falsely refreshed");
    assert.equal(saved.providerProbe.checkedAt, now);
    assert.equal(saved.providerProbe.partitionValidationComputedAt, now);
    for (const market of saved.providerProbe.markets) {
      assert.equal(market.readOnlyHistory.partitionValidation.status, "VALIDATED");
      assert.equal(market.readOnlyHistory.partitionValidation.reason, "FULL_DAY_AND_PARTITIONS_RECONCILED");
      assert.equal(market.readOnlyHistory.partitionValidation.fullDayTradeCount, 2);
      assert.equal(market.readOnlyHistory.partitionValidation.partitionTradeCount, 2);
    }
    assert.equal(saved.liveTradingEnabled, false);
    assert.equal(saved.pendingHistorySync, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CoinSpot sync retries empty full-day history with epoch seconds and records provider probes", async t => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/status")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (target.includes("/orders/market/completed")) {
      const body = JSON.parse(init.body || "{}");
      requests.push({ url: target, body });
      const coin = body.cointype;
      if (typeof body.startdate === "string") {
        return new Response(JSON.stringify({ status: "ok", buyorders: [], sellorders: [] }), { status: 200 });
      }
      const startValue = Number(body.startdate);
      const startMs = startValue >= 1e12 ? startValue : startValue * 1000;
      const date = new Date(startMs).toISOString().slice(0, 10);
      const row = {
        market: coin + "/AUD",
        solddate: date + "T10:00:00.000Z",
        rate: coin === "BTC" ? 90000 : 2500,
        amount: 0.01,
        total: coin === "BTC" ? 900 : 25
      };
      return new Response(JSON.stringify({ status: "ok", buyorders: [row], sellorders: [] }), { status: 200 });
    }
    if (target.includes("/pubapi/v2/orders/completed/")) {
      const coin = target.includes("/btc/") ? "BTC" : "ETH";
      const row = {
        market: coin + "/AUD",
        solddate: "2026-11-25T10:15:00.000Z",
        rate: coin === "BTC" ? 90100 : 2510,
        amount: 0.02,
        total: coin === "BTC" ? 1802 : 50.2
      };
      return new Response(JSON.stringify({ status: "ok", buyorders: [row], sellorders: [] }), { status: 200 });
    }
    throw new Error("Unexpected CoinSpot probe URL: " + target);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const store = new Map();
  const env = {
    COINSPOT_READONLY_KEY: "test-readonly-key",
    COINSPOT_READONLY_SECRET: "test-readonly-secret",
    EDGE_KV: {
      get: async key => store.get(key) || null,
      put: async (key, value) => { store.set(key, value); }
    }
  };
  store.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode: "COINSPOT_AUD_RESEARCH_ONLY",
    startedAt: "2026-11-24T00:00:00.000Z",
    nextDate: "2026-11-24",
    markets: {},
    liveTradingEnabled: false
  }));

  const result = await __test.syncCoinSpotMtfHistory(env, new Date("2026-11-25T12:00:00.000Z"));
  assert.equal(result.status, "BACKFILLING");
  assert.equal(result.markets.length, 2);
  assert.equal(result.markets[0].tradeCount, 1);
  assert.equal(result.markets[0].dateFormatFallbackHits, 1);
  assert.ok(requests.some(request => typeof request.body.startdate === "string"));
  assert.ok(requests.some(request => typeof request.body.startdate === "number"));
  assert.equal(result.providerProbe.readOnlyStatus, "AUTHENTICATED");
  assert.equal(result.providerProbe.markets[0].readOnlyHistory.validAudTrades, 1);
  assert.equal(result.providerProbe.markets[0].readOnlyHistory.partitionHistory.length, 2);
  assert.equal(result.providerProbe.markets[0].readOnlyHistory.partitionHistory[0].format, "epoch-ms");
  assert.equal(result.providerProbe.markets[0].readOnlyHistory.partitionHistory[0].validAudTrades, 1);
  assert.equal(result.providerProbe.markets[0].readOnlyHistory.partitionHistory[1].format, "epoch-ms");
  assert.equal(result.providerProbe.markets[0].readOnlyHistory.partitionHistory[1].outOfRangeTrades, 1);
  assert.equal(result.providerProbe.markets[0].publicHistory.validAudTrades, 1);

  const saved = JSON.parse(store.get("coinspot-mtf-history-global-v1"));
  assert.equal(saved.liveTradingEnabled, false);
  assert.equal(saved.markets.BTC.dailyCandles.length, 1);
  assert.equal(saved.markets.ETH.dailyCandles.length, 1);
  assert.ok(saved.providerProbe.checkedAt);
});


test("CoinSpot live-day refresh replaces per-date trade counts instead of inflating history totals", async () => {
  const store = new Map();
  const kv = {
    values: store,
    binding: {
      get: async key => store.get(key) ?? null,
      put: async (key, value) => { store.set(key, value); }
    }
  };
  const now = "2026-11-25T16:00:00.000Z";
  const variants = [
    { format: "epoch", validAudTrades: 0, outOfRangeTrades: 0 },
    { format: "epoch-string", validAudTrades: 0, outOfRangeTrades: 0 },
    { format: "epoch-ms", validAudTrades: 1, outOfRangeTrades: 0 }
  ];
  const probeMarket = coin => ({ coin, readOnlyHistory: { partitionHistory: [{ variants }, { variants }] } });
  kv.values.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode: "COINSPOT_AUD_RESEARCH_ONLY", status: "COLLECTING_LIVE_DAY", startedAt: now,
    nextDate: "2026-11-25", lastProcessedDate: "2026-11-24",
    markets: {
      BTC: { dailyCandles: [], fourHourCandles: [], tradesFetched: 10 },
      ETH: { dailyCandles: [], fourHourCandles: [], tradesFetched: 20 }
    },
    providerProbe: { checkedAt: now, readOnlyStatus: "AUTHENTICATED", markets: [probeMarket("BTC"), probeMarket("ETH")] },
    lastProviderProbeAt: now, liveTradingEnabled: false
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.endsWith("/orders/market/completed")) throw new Error("Unexpected CoinSpot request: " + target);
    const body = JSON.parse(options.body || "{}");
    const coin = body.cointype, price = coin === "BTC" ? 90000 : 2500;
    const start = Date.parse(body.startdate + "T00:00:00.000Z");
    const row = (offset, rate, amount) => ({
      market: coin + "/AUD", solddate: new Date(start + offset).toISOString(),
      rate, amount, total: rate * amount
    });
    return new Response(JSON.stringify({
      status: "ok", buyorders: [row(3600000, price, 0.01)],
      sellorders: [row(7200000, price + 1, 0.02)]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const env = { EDGE_KV: kv.binding, COINSPOT_READONLY_KEY: "test-readonly-key", COINSPOT_READONLY_SECRET: "test-readonly-secret" };
    const first = await __test.syncCoinSpotMtfHistory(env, now);
    assert.equal(first.status, "COLLECTING_LIVE_DAY");
    let history = JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
    assert.equal(history.nextDate, "2026-11-25");
    assert.equal(history.markets.BTC.tradesFetched, 12);
    assert.equal(history.markets.ETH.tradesFetched, 22);
    assert.equal(history.markets.BTC.tradesFetchedByDate["2026-11-25"], 2);
    assert.equal(history.markets.BTC.tradesFetchedBase, 10);
    const second = await __test.syncCoinSpotMtfHistory(env, "2026-11-25T16:15:00.000Z");
    assert.equal(second.status, "COLLECTING_LIVE_DAY");
    history = JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
    assert.equal(history.markets.BTC.tradesFetched, 12);
    assert.equal(history.markets.ETH.tradesFetched, 22);
    assert.equal(history.markets.BTC.tradesFetchedByDate["2026-11-25"], 2);
    assert.equal(history.markets.ETH.tradesFetchedByDate["2026-11-25"], 2);
    assert.equal(history.liveTradingEnabled, false);
  } finally { globalThis.fetch = originalFetch; }
});


test("CoinSpot dense history resumes in bounded chunks and completes without replaying fetched windows", async () => {
  const store = new Map();
  const now = "2026-11-25T12:00:00.000Z";
  const probeDate = "2026-11-25";
  const probeStartMs = Date.parse(probeDate + "T00:00:00.000Z");
  const probeMidpointMs = probeStartMs + 12 * 60 * 60 * 1000;
  const probeEndMs = probeStartMs + 24 * 60 * 60 * 1000;
  const variants = [
    { format: "epoch", rawBuyOrders: 0, rawSellOrders: 0, validAudTrades: 0, outOfRangeTrades: 0 },
    { format: "epoch-string", rawBuyOrders: 0, rawSellOrders: 0, validAudTrades: 0, outOfRangeTrades: 0 },
    { format: "epoch-ms", rawBuyOrders: 1, rawSellOrders: 0, validAudTrades: 1, outOfRangeTrades: 0 }
  ];
  const probeMarket = coin => ({
    coin,
    readOnlyHistory: {
      date: probeDate, queryFormat: "date",
      rawBuyOrders: 2, rawSellOrders: 0, validAudTrades: 2, outOfRangeTrades: 0,
      partitionHistory: [
        { startAt: new Date(probeStartMs).toISOString(), endAt: new Date(probeMidpointMs).toISOString(), variants },
        { startAt: new Date(probeMidpointMs).toISOString(), endAt: new Date(probeEndMs).toISOString(), variants }
      ]
    }
  });
  store.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode: "COINSPOT_AUD_RESEARCH_ONLY",
    status: "BACKFILLING",
    startedAt: now,
    nextDate: "2026-07-28",
    lastProcessedDate: "2026-07-27",
    markets: {
      BTC: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 },
      ETH: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 }
    },
    providerProbe: {
      checkedAt: now,
      readOnlyStatus: "AUTHENTICATED",
      markets: [probeMarket("BTC"), probeMarket("ETH")]
    },
    lastProviderProbeAt: now,
    liveTradingEnabled: false
  }));

  const originalFetch = globalThis.fetch;
  const allCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.endsWith("/orders/market/completed")) throw new Error("Unexpected CoinSpot request: " + target);
    const body = JSON.parse(options.body || "{}");
    const coin = body.cointype;
    let startMs, endMs;
    if (typeof body.startdate === "string") {
      startMs = Date.parse(body.startdate + "T00:00:00.000Z");
      endMs = startMs + 86400000;
    } else {
      startMs = Number(body.startdate);
      endMs = Number(body.enddate) + 1;
    }
    const duration = endMs - startMs;
    allCalls.push({ coin, duration, startMs, startdate: body.startdate, enddate: body.enddate });
    if (duration > 60 * 60 * 1000) {
      const makeRows = side => Array.from({ length: 500 }, (_, i) => ({
        market: coin + "/AUD",
        solddate: new Date(startMs + (side * 500 + i + 1) * 1000).toISOString(),
        rate: coin === "BTC" ? 90000 : 2500,
        amount: 0.01,
        total: coin === "BTC" ? 900 : 25
      }));
      return new Response(JSON.stringify({ status: "ok", buyorders: makeRows(0), sellorders: makeRows(1) }), { status: 200 });
    }
    const price = coin === "BTC" ? 90000 : 2500;
    const row = {
      market: coin + "/AUD",
      solddate: new Date(startMs + 1000).toISOString(),
      rate: price,
      amount: 0.01,
      total: price * 0.01
    };
    return new Response(JSON.stringify({ status: "ok", buyorders: [row], sellorders: [] }), { status: 200 });
  };
  try {
    const env = {
      COINSPOT_READONLY_KEY: "test-readonly-key",
      COINSPOT_READONLY_SECRET: "test-readonly-secret",
      EDGE_KV: {
        get: async key => store.get(key) ?? null,
        put: async (key, value) => { store.set(key, value); }
      }
    };
    let result;
    for (let run = 0; run < 6; run++) {
      const before = allCalls.length;
      result = await __test.syncCoinSpotMtfHistory(env, now);
      const runCalls = allCalls.slice(before);
      for (const coin of ["BTC", "ETH"]) {
        assert.ok(runCalls.filter(call => call.coin === coin).length <= 18, "per-market request budget must be respected");
      }
      if (result.dateComplete) break;
      const savedProgress = JSON.parse(store.get("coinspot-mtf-history-global-v1")).pendingHistorySync;
      assert.ok(Number.isSafeInteger(savedProgress.coins.BTC.processedThroughMs));
      assert.equal(savedProgress.coins.BTC.windows[0].startMs, savedProgress.coins.BTC.processedThroughMs);
      assert.equal(result.nextDate, "2026-07-28", "incomplete date must remain the cursor");
    }

    assert.equal(result.dateComplete, true);
    assert.equal(result.processedDate, "2026-07-28");
    assert.equal(result.nextDate, "2026-07-29");
    for (const coin of ["BTC", "ETH"]) {
      const marketCalls = allCalls.filter(call => call.coin === coin);
      const ranges = marketCalls.map(call => call.startMs + ":" + call.duration);
      const duplicateRanges = [...new Set(ranges.filter((range, index) => ranges.indexOf(range) !== index))];
      assert.deepEqual(duplicateRanges, [], coin + " duplicate history windows: " + JSON.stringify(marketCalls.filter(call => duplicateRanges.includes(call.startMs + ":" + call.duration))));
      assert.ok(marketCalls.length > 15, coin + " dense date should require more than one bounded sync chunk");
    }
    const history = JSON.parse(store.get("coinspot-mtf-history-global-v1"));
    assert.equal(history.pendingHistorySync, null);
    assert.equal(history.lastProcessedDate, "2026-07-28");
    assert.equal(history.nextDate, "2026-07-29");
    assert.equal(history.markets.BTC.tradesFetched, 32);
    assert.equal(history.markets.ETH.tradesFetched, 32);
    assert.equal(history.markets.BTC.dailyCandles.length, 1);
    assert.equal(history.markets.ETH.dailyCandles.length, 1);
    assert.equal(history.liveTradingEnabled, false);
    assert.equal(history.historyIntegrityRewindFrom, undefined, "partial batches must not trigger a legacy rewind");
    assert.equal(history.historyIntegrityFullRewindAt, undefined, "partial batches must preserve the existing history cursor");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CoinSpot paper runner stops after an incomplete history chunk instead of retrying the same date four times", async () => {
  const store = new Map();
  const now = "2026-11-25T12:00:00.000Z";
  const probeDate = "2026-11-25";
  const probeStartMs = Date.parse(probeDate + "T00:00:00.000Z");
  const probeMidpointMs = probeStartMs + 12 * 60 * 60 * 1000;
  const probeEndMs = probeStartMs + 24 * 60 * 60 * 1000;
  const variants = [
    { format: "epoch", rawBuyOrders: 0, rawSellOrders: 0, validAudTrades: 0, outOfRangeTrades: 0 },
    { format: "epoch-string", rawBuyOrders: 0, rawSellOrders: 0, validAudTrades: 0, outOfRangeTrades: 0 },
    { format: "epoch-ms", rawBuyOrders: 1, rawSellOrders: 0, validAudTrades: 1, outOfRangeTrades: 0 }
  ];
  const probeMarket = coin => ({
    coin,
    readOnlyHistory: {
      date: probeDate, queryFormat: "date",
      rawBuyOrders: 2, rawSellOrders: 0, validAudTrades: 2, outOfRangeTrades: 0,
      partitionHistory: [
        { startAt: new Date(probeStartMs).toISOString(), endAt: new Date(probeMidpointMs).toISOString(), variants },
        { startAt: new Date(probeMidpointMs).toISOString(), endAt: new Date(probeEndMs).toISOString(), variants }
      ]
    }
  });
  store.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode: "COINSPOT_AUD_RESEARCH_ONLY",
    status: "BACKFILLING",
    startedAt: now,
    nextDate: "2026-07-28",
    markets: {
      BTC: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 },
      ETH: { dailyCandles: [], fourHourCandles: [], tradesFetched: 0 }
    },
    providerProbe: { checkedAt: now, readOnlyStatus: "AUTHENTICATED", markets: [probeMarket("BTC"), probeMarket("ETH")] },
    lastProviderProbeAt: now,
    liveTradingEnabled: false
  }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("/pubapi/v2/latest/")) {
      const coin = target.endsWith("/btc") ? "BTC" : "ETH";
      const price = coin === "BTC" ? 90000 : 2500;
      return new Response(JSON.stringify({ status: "ok", prices: { bid: price, ask: price + 1, last: price + 0.5 } }), { status: 200 });
    }
    if (target.endsWith("/orders/market/completed")) {
      const body = JSON.parse(options.body || "{}");
      const coin = body.cointype;
      let startMs, endMs;
      if (typeof body.startdate === "string") {
        startMs = Date.parse(body.startdate + "T00:00:00.000Z");
        endMs = startMs + 86400000;
      } else {
        startMs = Number(body.startdate);
        endMs = Number(body.enddate) + 1;
      }
      calls.push({ coin, duration: endMs - startMs });
      if (endMs - startMs > 60 * 60 * 1000) {
        const rows = Array.from({ length: 500 }, (_, i) => ({
          market: coin + "/AUD", solddate: new Date(startMs + i * 1000).toISOString(),
          rate: coin === "BTC" ? 90000 : 2500, amount: 0.01,
          total: coin === "BTC" ? 900 : 25
        }));
        return new Response(JSON.stringify({ status: "ok", buyorders: rows, sellorders: rows }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ok", buyorders: [], sellorders: [] }), { status: 200 });
    }
    throw new Error("Unexpected CoinSpot request: " + target);
  };
  try {
    const result = await __test.runCoinSpotMtfPaper({
      EDGE_KV: {
        get: async key => store.get(key) ?? null,
        put: async (key, value) => { store.set(key, value); }
      },
      COINSPOT_READONLY_KEY: "test-readonly-key",
      COINSPOT_READONLY_SECRET: "test-readonly-secret"
    }, now, 4);
    assert.equal(result.backfillDaysRequested, 4);
    assert.equal(result.backfillDaysProcessed, 0);
    assert.equal(result.historySync.dateComplete, false);
    assert.equal(result.historySync.nextDate, "2026-07-28");
    assert.ok(calls.filter(call => call.coin === "BTC").length <= 18);
    assert.ok(calls.filter(call => call.coin === "ETH").length <= 18);
    assert.equal(result.paperOnly, true);
    assert.equal(result.liveTradingEnabled, false);
    assert.equal(result.cashAud, 100);
    assert.equal(result.openPosition, null);
    const history = JSON.parse(store.get("coinspot-mtf-history-global-v1"));
    assert.equal(history.nextDate, "2026-07-28");
    assert.ok(history.pendingHistorySync);
    assert.equal(history.liveTradingEnabled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
