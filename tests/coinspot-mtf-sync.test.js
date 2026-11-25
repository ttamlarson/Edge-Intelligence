import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

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
      const date = new Date(Number(body.startdate) * 1000).toISOString().slice(0, 10);
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
  assert.equal(result.providerProbe.markets[0].publicHistory.validAudTrades, 1);

  const saved = JSON.parse(store.get("coinspot-mtf-history-global-v1"));
  assert.equal(saved.liveTradingEnabled, false);
  assert.equal(saved.markets.BTC.dailyCandles.length, 1);
  assert.equal(saved.markets.ETH.dailyCandles.length, 1);
  assert.ok(saved.providerProbe.checkedAt);
});

test("CoinSpot capped daily history falls back from empty epoch seconds to millisecond partitions", async t => {
  const originalFetch = globalThis.fetch;
  const store = new Map();
  const requests = [];
  const makeRow = (coin, timestamp, i = 0) => ({
    market: coin + "/AUD", solddate: timestamp,
    rate: coin === "BTC" ? 90000 + i : 2500 + i,
    amount: 0.01 + i / 100000, total: coin === "BTC" ? 900 : 25
  });
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/status")) return new Response(JSON.stringify({status:"ok"}), {status:200});
    if (target.includes("/api/v2/ro/orders/market/completed")) {
      const body = JSON.parse(init.body || "{}");
      requests.push({body, target});
      const coin = body.cointype;
      if (body.startdate === "2026-11-25") {
        const row = makeRow(coin, "2026-11-25T09:00:00.000Z");
        return new Response(JSON.stringify({status:"ok",buyorders:[row],sellorders:[]}), {status:200});
      }
      if (typeof body.startdate === "string") {
        const rows = Array.from({length:500}, (_,i) => makeRow(coin, "2026-08-19T" + String(Math.floor(i/60)).padStart(2,"0") + ":" + String(i%60).padStart(2,"0") + ":00.000Z", i));
        return new Response(JSON.stringify({status:"ok",buyorders:rows,sellorders:rows}), {status:200});
      }
      if (body.startdate < 100000000000) {
        return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}), {status:200});
      }
      const timestamp = body.startdate < Date.parse("2026-08-19T12:00:00.000Z")
        ? "2026-08-19T06:00:00.000Z" : "2026-08-19T18:00:00.000Z";
      const row = makeRow(coin, timestamp);
      return new Response(JSON.stringify({status:"ok",buyorders:[row],sellorders:[]}), {status:200});
    }
    if (target.includes("/pubapi/v2/orders/completed/")) {
      const coin = target.includes("/btc/") ? "BTC" : "ETH";
      return new Response(JSON.stringify({status:"ok",buyorders:[makeRow(coin,"2026-11-25T09:00:00.000Z")],sellorders:[]}), {status:200});
    }
    throw new Error("Unexpected CoinSpot URL: " + target);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = {
    COINSPOT_READONLY_KEY: "test-readonly-key",
    COINSPOT_READONLY_SECRET: "test-readonly-secret",
    EDGE_KV: {
      get: async key => store.get(key) || null,
      put: async (key, value) => store.set(key, value)
    }
  };
  store.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode:"COINSPOT_AUD_RESEARCH_ONLY", startedAt:"2026-11-25T00:00:00.000Z",
    nextDate:"2026-08-19", markets:{}, liveTradingEnabled:false
  }));

  const result = await __test.syncCoinSpotMtfHistory(env, "2026-11-25T09:30:00.000Z");
  assert.equal(result.status, "BACKFILLING");
  assert.equal(result.processedDate, "2026-08-19");
  assert.equal(result.markets[0].tradeCount, 2);
  assert.equal(result.markets[0].epochMillisecondsFallbackHits, 2);
  assert.ok(result.markets[0].queryFormatsAttempted.includes("epoch-ms"));
  assert.ok(requests.some(x => typeof x.body.startdate === "number" && x.body.startdate > 100000000000));
  const saved = JSON.parse(store.get("coinspot-mtf-history-global-v1"));
  assert.equal(saved.markets.BTC.dailyCandles.length, 1);
  assert.equal(saved.markets.ETH.dailyCandles.length, 1);
  assert.equal(saved.lastProcessedDate, "2026-08-19");
  assert.equal(saved.liveTradingEnabled, false);
});

test("CoinSpot capped history that stays empty after both epoch formats does not advance the backfill date", async t => {
  const originalFetch = globalThis.fetch;
  const store = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/status")) return new Response(JSON.stringify({status:"ok"}), {status:200});
    if (target.includes("/api/v2/ro/orders/market/completed")) {
      const body = JSON.parse(init.body || "{}");
      if (body.startdate === "2026-11-25") {
        return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}), {status:200});
      }
      if (typeof body.startdate === "string") {
        const row = {market:body.cointype+"/AUD",solddate:"2026-08-19T08:00:00.000Z",rate:100,amount:1,total:100};
        return new Response(JSON.stringify({status:"ok",buyorders:Array(500).fill(row),sellorders:[]}), {status:200});
      }
      return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}), {status:200});
    }
    if (target.includes("/pubapi/v2/orders/completed/")) {
      return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}), {status:200});
    }
    throw new Error("Unexpected CoinSpot URL: " + target);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = {
    COINSPOT_READONLY_KEY: "test-readonly-key",
    COINSPOT_READONLY_SECRET: "test-readonly-secret",
    EDGE_KV: {
      get: async key => store.get(key) || null,
      put: async (key, value) => store.set(key, value)
    }
  };
  store.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode:"COINSPOT_AUD_RESEARCH_ONLY", startedAt:"2026-11-25T00:00:00.000Z",
    nextDate:"2026-08-19", markets:{}, liveTradingEnabled:false
  }));

  await assert.rejects(
    () => __test.syncCoinSpotMtfHistory(env, "2026-11-25T09:30:00.000Z"),
    /COINSPOT_HISTORY_PARTITION_EMPTY/
  );
  const saved = JSON.parse(store.get("coinspot-mtf-history-global-v1"));
  assert.equal(saved.nextDate, "2026-08-19");
  assert.equal(saved.lastProcessedDate, undefined);
  assert.equal(saved.lastHistoryError.coin, "BTC");
  assert.equal(saved.lastHistoryError.date, "2026-08-19");
  assert.equal(saved.liveTradingEnabled, false);
});

test("CoinSpot checkpoints a completed market while the other market is blocked", async t => {
  const originalFetch = globalThis.fetch;
  const store = new Map();
  const calls = { BTC: 0, ETH: 0 };
  let allowEth = false;
  const row = coin => ({
    market: coin + "/AUD", solddate: "2026-08-19T08:00:00.000Z",
    rate: coin === "BTC" ? 90000 : 2500, amount: 0.01, total: coin === "BTC" ? 900 : 25
  });
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (!target.includes("/api/v2/ro/orders/market/completed")) {
      throw new Error("Unexpected checkpoint test URL: " + target);
    }
    const body = JSON.parse(init.body || "{}");
    const coin = body.cointype;
    calls[coin]++;
    if (coin === "ETH" && !allowEth && typeof body.startdate === "string") {
      const invalid = row(coin);
      invalid.rate = "invalid";
      return new Response(JSON.stringify({status:"ok",buyorders:[invalid],sellorders:[]}), {status:200});
    }
    return new Response(JSON.stringify({status:"ok",buyorders:[row(coin)],sellorders:[]}), {status:200});
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  store.set("coinspot-mtf-history-global-v1", JSON.stringify({
    mode:"COINSPOT_AUD_RESEARCH_ONLY", startedAt:"2026-11-25T00:00:00.000Z",
    nextDate:"2026-08-19", lastProviderProbeAt:"2026-11-25T09:00:00.000Z",
    markets:{}, liveTradingEnabled:false
  }));
  const env = {
    COINSPOT_READONLY_KEY:"test-key", COINSPOT_READONLY_SECRET:"test-secret",
    EDGE_KV:{get:async key=>store.get(key)||null,put:async(key,value)=>store.set(key,value)}
  };

  await assert.rejects(() => __test.syncCoinSpotMtfHistory(env,"2026-11-25T09:30:00.000Z"), /COINSPOT_HISTORY_SCHEMA_MISMATCH/);
  let saved=JSON.parse(store.get("coinspot-mtf-history-global-v1"));
  assert.equal(saved.nextDate,"2026-08-19");
  assert.equal(saved.markets.BTC.lastHistoryDate,"2026-08-19");
  const btcCallsAfterFirst=calls.BTC;
  allowEth=true;

  const result=await __test.syncCoinSpotMtfHistory(env,"2026-11-25T09:45:00.000Z");
  saved=JSON.parse(store.get("coinspot-mtf-history-global-v1"));
  assert.equal(result.processedDate,"2026-08-19");
  assert.equal(result.markets[0].status,"ALREADY_PROCESSED");
  assert.equal(result.markets[1].status,"SYNCED");
  assert.equal(calls.BTC,btcCallsAfterFirst);
  assert.equal(saved.nextDate,"2026-08-20");
  assert.equal(saved.liveTradingEnabled,false);
});
