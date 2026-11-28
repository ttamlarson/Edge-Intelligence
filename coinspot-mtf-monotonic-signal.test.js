import test from "node:test";
import assert from "node:assert/strict";
import {
  createMtfPaperAccount,
  processMtfPaperAccount,
  validateMtfPaperAccount
} from "./coinspot-mtf-paper.js";

const HOUR = 60 * 60 * 1000;
const iso = value => new Date(value).toISOString();

function btcMarket(now, signalAt, { dailyTrend = true, bid = 1000, ask = 1000.1 } = {}) {
  const midpoint = (bid + ask) / 2;
  return {
    coin: "BTC",
    pair: "BTC/AUD",
    quote: {
      pair: "BTC/AUD",
      bid,
      ask,
      last: bid,
      spreadBps: (ask - bid) / midpoint * 10000,
      retrievedAt: now
    },
    signal: {
      strategy: "EDGE_MTF_DONCHIAN_ENSEMBLE_V1",
      status: "BUY_CANDIDATE_PAPER_ONLY",
      signalAt,
      entryModel: "DONCHIAN_BREAKOUT",
      execution: { orderIntent: "NONE", paperOnly: true, liveTradingEnabled: false },
      checks: {
        dailyTrend,
        fourHourTrend: true,
        positiveLongTrendSlope: true,
        entryTrigger: true,
        liquidity: true,
        volatility: true,
        breakoutVotes: true,
        pullbackReclaim: false
      },
      indicators: { atr20: 1, breakoutVotes: 3, longTrendSlopePct: 1 },
      risk: { initialStopDistance: 2.5 }
    }
  };
}

test("does not reopen an older closed four-hour signal after a newer signal was consumed", () => {
  const firstSignalAt = "2026-11-28T00:00:00.000Z";
  const newerSignalAt = "2026-11-28T04:00:00.000Z";
  const firstEntryAt = "2026-11-28T04:30:00.000Z";
  const firstExitAt = iso(Date.parse(firstEntryAt) + 60_000);
  const newerEntryAt = "2026-11-28T08:01:00.000Z";
  const newerExitAt = iso(Date.parse(newerEntryAt) + 60_000);
  const staleRetryAt = iso(Date.parse(newerExitAt) + 60_000);

  let account = createMtfPaperAccount(firstEntryAt);
  account = processMtfPaperAccount(account, {
    now: firstEntryAt,
    markets: [btcMarket(firstEntryAt, firstSignalAt)]
  });
  assert.equal(account.openPosition?.signalAt, firstSignalAt);

  account = processMtfPaperAccount(account, {
    now: firstExitAt,
    markets: [btcMarket(firstExitAt, firstSignalAt, { dailyTrend: false })]
  });
  assert.equal(account.openPosition, null);
  assert.equal(account.closedTrades.length, 1);

  account = processMtfPaperAccount(account, {
    now: newerEntryAt,
    markets: [btcMarket(newerEntryAt, newerSignalAt)]
  });
  assert.equal(account.openPosition?.signalAt, newerSignalAt);

  account = processMtfPaperAccount(account, {
    now: newerExitAt,
    markets: [btcMarket(newerExitAt, newerSignalAt, { dailyTrend: false })]
  });
  assert.equal(account.openPosition, null);
  assert.equal(account.closedTrades.length, 2);
  assert.equal(account.lastProcessed.BTC, newerSignalAt);

  account = processMtfPaperAccount(account, {
    now: staleRetryAt,
    markets: [btcMarket(staleRetryAt, firstSignalAt)]
  });

  assert.equal(account.openPosition, null);
  assert.equal(account.closedTrades.length, 2);
  assert.deepEqual(account.lastCandidateRanking, []);
  assert.equal(account.lastProcessed.BTC, newerSignalAt);
  assert.equal(validateMtfPaperAccount(account), true);
  assert.equal(account.paperOnly, true);
  assert.equal(account.liveTradingEnabled, false);
});
