// CoinSpot multi-timeframe automated paper ledger. AUD only; never submits exchange orders.
export const MTF_PAPER_CONFIG = Object.freeze({
  startingCapitalAud: 100, maxAllocationPct: 25, riskBudgetPct: 0.5,
  feeRate: 0.001, slippageBps: 15, maxDailyLossAud: 3, maxSpreadBps: 50,
  maxHoldingDays: 30, initialStopAtr: 2.5, trailingStopAtr: 3
});
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;
const MAX_SIGNAL_AGE_AFTER_CLOSE_MS = 8 * 60 * 60 * 1000;
const MARK_STALE_AFTER_MS = 20 * 60 * 1000;
const validCoin = coin => coin === "BTC" || coin === "ETH";
const validAudMarket = market => validCoin(market?.coin) && market?.pair === market.coin + "/AUD" && market?.quote?.pair === market.coin + "/AUD";
const validTimestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const positiveFinite = value => Number.isFinite(value) && value > 0;
const nonNegativeFinite = value => Number.isFinite(value) && value >= 0;
function quoteIsFresh(market, now) {
  const retrievedAt = market?.quote?.retrievedAt;
  const retrievedMs = Date.parse(retrievedAt || "");
  const scanMs = Date.parse(now || "");
  return validTimestamp(retrievedAt) && Number.isFinite(scanMs) &&
    retrievedMs <= scanMs && scanMs - retrievedMs <= MARK_STALE_AFTER_MS;
}
function validPaperExitQuote(market, now) {
  if (!validAudMarket(market) || !quoteIsFresh(market, now)) return false;
  const quote = market.quote;
  // Exits must use a coherent executable bid/ask, but the entry spread ceiling
  // must not prevent a protective stop from closing into a temporarily wide market.
  return [quote.bid, quote.ask, quote.last].every(Number.isFinite) &&
    quote.bid > 0 && quote.ask >= quote.bid && quote.last > 0;
}
function validPaperQuote(market, now) {
  if (!validAudMarket(market) || !quoteIsFresh(market, now)) return false;
  const quote = market.quote;
  if (![quote.bid, quote.ask, quote.last, quote.spreadBps].every(Number.isFinite) ||
      quote.bid <= 0 || quote.ask < quote.bid || quote.last <= 0 || quote.spreadBps < 0) return false;
  const midpoint = (quote.bid + quote.ask) / 2;
  if (!Number.isFinite(midpoint) || midpoint <= 0) return false;
  const actualSpreadBps = (quote.ask - quote.bid) / midpoint * 10000;
  // Defense in depth: never trust a caller-supplied spread that understates
  // the executable bid/ask width. Allow only normal two-decimal quote rounding.
  return Number.isFinite(actualSpreadBps) &&
    Math.abs(quote.spreadBps - actualSpreadBps) <= 0.05 &&
    actualSpreadBps <= MTF_PAPER_CONFIG.maxSpreadBps;
}
const quoteCost = price => price * (1 - MTF_PAPER_CONFIG.slippageBps / 10000);
export function createMtfPaperAccount(now = new Date().toISOString()) {
  return { mode:"COINSPOT_MTF_AUTOMATED_PAPER", paperOnly:true, riskAccountingVersion:2, currency:"AUD", startingCapitalAud:100,
    cashAud:100, realizedPnlAud:0, unrealizedPnlAud:0, equityAud:100, dailyLossAud:0,
    day:now.slice(0,10), openPosition:null, closedTrades:[], lastProcessed:{}, lastCandidateRanking:[],
    liveTradingEnabled:false, updatedAt:now };
}
export function validateMtfPaperAccount(a) {
  const validClosedTrade = trade => {
    if (!trade || !validCoin(trade.coin) || trade.pair !== trade.coin + "/AUD" ||
        !validTimestamp(trade.openedAt) || !validTimestamp(trade.closedAt) ||
        !validTimestamp(trade.signalAt) || Date.parse(trade.closedAt) < Date.parse(trade.openedAt) ||
        Date.parse(trade.closedAt) > Date.parse(a.updatedAt) ||
        Date.parse(trade.openedAt) < Date.parse(trade.signalAt) + FOUR_HOUR_MS ||
        Date.parse(trade.openedAt) > Date.parse(trade.signalAt) + FOUR_HOUR_MS + MAX_SIGNAL_AGE_AFTER_CLOSE_MS ||
        !positiveFinite(trade.entryPrice) || !positiveFinite(trade.exitPrice) ||
        !positiveFinite(trade.quantity) || !nonNegativeFinite(trade.entryFeeAud) ||
        !nonNegativeFinite(trade.exitFeeAud) || !Number.isFinite(trade.pnlAud) ||
        typeof trade.reason !== "string" || trade.reason.length === 0) return false;
    if ((trade.entryModel !== undefined && trade.entryModel !== null &&
          !["DONCHIAN_BREAKOUT", "PULLBACK_RECLAIM"].includes(trade.entryModel)) ||
        (trade.candidateRank !== undefined && trade.candidateRank !== null &&
          (!Number.isInteger(trade.candidateRank) || trade.candidateRank < 1 || trade.candidateRank > 2)) ||
        ["riskBudgetAud", "riskBudgetUsePct", "estimatedNetStopLossAud", "spreadBps", "costDragBps"]
          .some(key => trade[key] !== undefined && trade[key] !== null && !nonNegativeFinite(trade[key]))) return false;
    const expectedNetPnl = round(
      trade.quantity * trade.exitPrice - trade.exitFeeAud -
      (trade.quantity * trade.entryPrice + trade.entryFeeAud)
    );
    return Math.abs(trade.pnlAud - expectedNetPnl) <= 0.03;
  };
  const ledgerDay = typeof a?.day === "string" ? a.day : "";
  const realizedLossForLedgerDay = Array.isArray(a?.closedTrades)
    ? a.closedTrades.filter(trade => String(trade?.closedAt || "").slice(0, 10) === ledgerDay)
      .reduce((sum, trade) => sum + Math.max(0, -Number(trade?.pnlAud)), 0)
    : NaN;
  const legacyRiskAccounting = a?.riskAccountingVersion === undefined;
  const unrealizedLossForLedgerDay = a?.openPosition
    ? (Number.isFinite(a?.unrealizedPnlAud) ? Math.max(0, -a.unrealizedPnlAud) : NaN)
    : 0;
  const minimumDailyLossForLedgerDay = Number.isFinite(realizedLossForLedgerDay) &&
      Number.isFinite(unrealizedLossForLedgerDay)
    ? round(realizedLossForLedgerDay + unrealizedLossForLedgerDay) : NaN;
  const validCandidateRanking = a?.lastCandidateRanking === undefined || (
    Array.isArray(a.lastCandidateRanking) && a.lastCandidateRanking.length <= 2 &&
    a.lastCandidateRanking.every((item, index) => item && validCoin(item.coin) &&
      item.pair === item.coin + "/AUD" && item.rank === index + 1 &&
      validTimestamp(item.signalAt) &&
      ["DONCHIAN_BREAKOUT", "PULLBACK_RECLAIM"].includes(item.entryModel) &&
      ["ELIGIBLE", "BLOCKED_DAILY_LOSS_CAPACITY", "BLOCKED_MINIMUM_NOTIONAL", "BLOCKED_ALLOCATION", "BLOCKED_INVALID_RISK"].includes(item.status) &&
      nonNegativeFinite(item.riskBudgetAud) && nonNegativeFinite(item.dailyLossRemainingAud) &&
      nonNegativeFinite(item.estimatedNetStopLossAud) && nonNegativeFinite(item.riskBudgetUsePct) &&
      nonNegativeFinite(item.spreadBps) && nonNegativeFinite(item.costDragBps) &&
      Number.isInteger(item.breakoutVotes) && item.breakoutVotes >= 0 && item.breakoutVotes <= 3 &&
      Number.isFinite(item.signalAgeMinutes) && item.signalAgeMinutes >= 0 &&
      typeof item.reason === "string" && item.reason.length > 0 && item.reason.length <= 240)
  );
  // The idempotency ledger is safety-critical: after a position is closed, the
  // same still-fresh four-hour signal must not be re-entered after a restart.
  // Reject unknown markets, malformed/future signal clocks, and open positions
  // whose signal was not recorded as consumed.
  const validLastProcessed = Boolean(a?.lastProcessed && typeof a.lastProcessed === "object" &&
    !Array.isArray(a.lastProcessed) && Object.keys(a.lastProcessed).length <= 2 &&
    Object.entries(a.lastProcessed).every(([coin, signalAt]) =>
      validCoin(coin) && validTimestamp(signalAt) &&
      Date.parse(signalAt) <= Date.parse(a.updatedAt)));
  const openPositionSignalConsumed = !a?.openPosition ||
    a.lastProcessed?.[a.openPosition.coin] === a.openPosition.signalAt;
  const closedTradeSignalsConsumed = Array.isArray(a?.closedTrades) &&
    a.closedTrades.every(trade => {
      const processedAt = Date.parse(a.lastProcessed?.[trade?.coin] || "");
      const tradeSignalAt = Date.parse(trade?.signalAt || "");
      return Number.isFinite(processedAt) && Number.isFinite(tradeSignalAt) &&
        processedAt >= tradeSignalAt;
    });
  // A persisted idempotency timestamp alone cannot prove that the same signal
  // was not closed twice: lastProcessed intentionally stores only the latest
  // signal per coin. Validate uniqueness across the retained trade history and
  // ensure an open position cannot overlap a previously closed signal.
  const closedTradeIds = new Set();
  const closedTradeSignalKeys = new Set();
  const uniqueClosedTradeLedger = Array.isArray(a?.closedTrades) && a.closedTrades.every(trade => {
    const signalKey = String(trade?.coin) + "|" + String(trade?.signalAt);
    const tradeId = typeof trade?.id === "string" && trade.id.length > 0
      ? trade.id : signalKey;
    if (closedTradeIds.has(tradeId) || closedTradeSignalKeys.has(signalKey)) return false;
    closedTradeIds.add(tradeId);
    closedTradeSignalKeys.add(signalKey);
    return true;
  });
  const openPositionSignalNotPreviouslyClosed = !a?.openPosition ||
    !closedTradeSignalKeys.has(String(a.openPosition.coin) + "|" + String(a.openPosition.signalAt));
  const openPositionIdNotPreviouslyClosed = !a?.openPosition ||
    !(typeof a.openPosition.id === "string" && closedTradeIds.has(a.openPosition.id));
  if (!a || a.mode!=="COINSPOT_MTF_AUTOMATED_PAPER" || a.currency!=="AUD" ||
      (a.paperOnly !== undefined && a.paperOnly !== true) ||
      (a.riskAccountingVersion !== undefined && a.riskAccountingVersion !== 2) ||
      a.startingCapitalAud!==100 || a.liveTradingEnabled!==false ||
      !Number.isFinite(a.cashAud) || a.cashAud<0 || !Number.isFinite(a.realizedPnlAud) ||
      !Number.isFinite(a.unrealizedPnlAud) || !Number.isFinite(a.equityAud) || a.equityAud<0 ||
      !Number.isFinite(a.dailyLossAud) || a.dailyLossAud<0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(ledgerDay) || !validTimestamp(a.updatedAt) || a.day !== a.updatedAt.slice(0, 10) ||
      !Number.isFinite(realizedLossForLedgerDay) || a.dailyLossAud + 0.02 < realizedLossForLedgerDay ||
      (!legacyRiskAccounting && (!Number.isFinite(minimumDailyLossForLedgerDay) || a.dailyLossAud + 0.02 < minimumDailyLossForLedgerDay)) ||
      !Array.isArray(a.closedTrades) || a.closedTrades.length>200 ||
      a.closedTrades.some(trade => !validClosedTrade(trade)) ||
      !validLastProcessed || !openPositionSignalConsumed || !closedTradeSignalsConsumed ||
      !uniqueClosedTradeLedger || !openPositionSignalNotPreviouslyClosed ||
      !openPositionIdNotPreviouslyClosed || !validCandidateRanking)
    throw new Error("CoinSpot MTF paper ledger failed validation; stored data was not changed.");
  if (a.openPosition) {
    const p = a.openPosition;
    const entryCostMatches = Number.isFinite(p.entryCost) && Number.isFinite(p.notionalAud) &&
      Number.isFinite(p.entryFeeAud) &&
      Math.abs(p.entryCost - (p.notionalAud + p.entryFeeAud)) <= 0.02 &&
      Math.abs(p.notionalAud - p.quantity * p.entryPrice) <= 0.02;
    if (!validCoin(p.coin) || p.pair !== p.coin + "/AUD" ||
        typeof p.id !== "string" || p.id.length === 0 ||
        !positiveFinite(p.quantity) || !positiveFinite(p.entryPrice) ||
        !positiveFinite(p.notionalAud) || !positiveFinite(p.entryCost) ||
        !nonNegativeFinite(p.entryFeeAud) || !entryCostMatches ||
        !positiveFinite(p.stopPrice) || p.stopPrice >= p.entryPrice ||
        !positiveFinite(p.atr) || !positiveFinite(p.highestPrice) || p.highestPrice < p.entryPrice ||
        !positiveFinite(p.trailingStop) || p.trailingStop < p.stopPrice || p.trailingStop >= p.highestPrice ||
        !validTimestamp(p.openedAt) || !validTimestamp(p.signalAt) ||
        Date.parse(p.openedAt) > Date.parse(a.updatedAt) ||
        Date.parse(p.openedAt) < Date.parse(p.signalAt) + FOUR_HOUR_MS ||
        Date.parse(p.openedAt) > Date.parse(p.signalAt) + FOUR_HOUR_MS + MAX_SIGNAL_AGE_AFTER_CLOSE_MS ||
        (p.lastMarkAt !== undefined && (!validTimestamp(p.lastMarkAt) ||
          Date.parse(p.lastMarkAt) < Date.parse(p.openedAt) || Date.parse(p.lastMarkAt) > Date.parse(a.updatedAt))) ||
        (p.markStatus !== undefined && (!["CURRENT", "UNAVAILABLE", "STALE"].includes(p.markStatus) || !p.lastMarkAt)) ||
        (p.entryModel !== undefined && !["DONCHIAN_BREAKOUT", "PULLBACK_RECLAIM"].includes(p.entryModel)) ||
        (p.candidateRank !== undefined && (!Number.isInteger(p.candidateRank) || p.candidateRank < 1 || p.candidateRank > 2)) ||
        ["riskBudgetAud", "riskBudgetUsePct", "estimatedNetStopLossAud", "spreadBps", "costDragBps"]
          .some(key => p[key] !== undefined && !nonNegativeFinite(p[key])))
      throw new Error("CoinSpot MTF paper position failed validation; stored data was not changed.");
  }
  if ((!a.openPosition && Math.abs(a.unrealizedPnlAud) > 0.02) ||
      Math.abs(round(a.cashAud + (a.openPosition ? a.openPosition.entryCost : 0)) -
        round(a.startingCapitalAud + a.realizedPnlAud)) > 0.03 ||
      Math.abs(a.equityAud -
        round(a.cashAud + (a.openPosition ? a.openPosition.entryCost : 0) + a.unrealizedPnlAud)) > 0.03) {
    throw new Error("CoinSpot MTF paper ledger balance/equity reconciliation failed; stored data was not changed.");
  }
  return true;
}
function realizedDailyLoss(a, now) {
  return round(a.closedTrades
    .filter(t => String(t.closedAt || "").slice(0, 10) === now.slice(0, 10))
    .reduce((sum, t) => sum + Math.max(0, -Number(t.pnlAud || 0)), 0));
}
function closePosition(a, bid, now, reason) {
  const p = a.openPosition, exit = quoteCost(bid), gross = p.quantity * exit;
  const exitFee = gross * MTF_PAPER_CONFIG.feeRate, proceeds = gross - exitFee;
  const pnl = proceeds - p.entryCost;
  a.cashAud = round(a.cashAud + proceeds);
  a.realizedPnlAud = round(a.realizedPnlAud + pnl);
  a.closedTrades.push({ id:p.id, coin:p.coin, pair:p.pair, openedAt:p.openedAt, closedAt:now,
    signalAt:p.signalAt, entryPrice:p.entryPrice, exitPrice:exit, quantity:p.quantity,
    entryModel:p.entryModel || null,
    candidateRank:p.candidateRank ?? null,
    riskBudgetAud:p.riskBudgetAud ?? null,
    riskBudgetUsePct:p.riskBudgetUsePct ?? null,
    estimatedNetStopLossAud:p.estimatedNetStopLossAud ?? null,
    spreadBps:p.spreadBps ?? null,
    costDragBps:p.costDragBps ?? null,
    entryFeeAud:p.entryFeeAud, exitFeeAud:round(exitFee), pnlAud:round(pnl), reason,
    strategy:"EDGE_MTF_DONCHIAN_ENSEMBLE_V1" });
  a.closedTrades = a.closedTrades.slice(-200);
  a.openPosition = null;
  a.unrealizedPnlAud = 0;
  a.dailyLossAud = realizedDailyLoss(a, now);
  a.equityAud = round(a.cashAud);
}
function isMtfEntryCandidate(m, now) {
  const signal = m?.signal, quote = m?.quote, checks = signal?.checks;
  const signalAt = Date.parse(signal?.signalAt || "");
  const scanAt = Date.parse(now);
  const atr = Number(signal?.indicators?.atr20);
  const stopDistance = Number(signal?.risk?.initialStopDistance);
  const expectedStopDistance = atr * MTF_PAPER_CONFIG.initialStopAtr;
  const ageAfterSignalClose = scanAt - (signalAt + FOUR_HOUR_MS);
  const entryModel = signal?.entryModel ||
    (checks?.pullbackReclaim === true ? "PULLBACK_RECLAIM" : "DONCHIAN_BREAKOUT");
  const requiredChecks = ["dailyTrend", "fourHourTrend", "positiveLongTrendSlope", "entryTrigger", "liquidity", "volatility"];
  return validPaperQuote(m, now) &&
    signal?.strategy === "EDGE_MTF_DONCHIAN_ENSEMBLE_V1" &&
    signal?.status === "BUY_CANDIDATE_PAPER_ONLY" &&
    signal?.execution?.orderIntent === "NONE" &&
    signal?.execution?.paperOnly === true &&
    signal?.execution?.liveTradingEnabled === false &&
    requiredChecks.every(key => checks?.[key] === true) &&
    (checks?.breakoutVotes === true || checks?.pullbackReclaim === true) &&
    ["DONCHIAN_BREAKOUT", "PULLBACK_RECLAIM"].includes(entryModel) &&
    validTimestamp(signal?.signalAt) &&
    quote &&
    Number.isFinite(atr) && atr > 0 &&
    Number.isFinite(stopDistance) && stopDistance > 0 &&
    Math.abs(stopDistance - expectedStopDistance) <= Math.max(1e-8, expectedStopDistance * 1e-6) &&
    Number.isFinite(signalAt) && Number.isFinite(scanAt) &&
    ageAfterSignalClose >= 0 && ageAfterSignalClose <= MAX_SIGNAL_AGE_AFTER_CLOSE_MS;
}

function rankMtfEntryCandidate(m, account, now) {
  const equity = Math.max(0, Number.isFinite(account.equityAud) ? account.equityAud : account.cashAud);
  const dailyLoss = Math.max(0, Number.isFinite(account.dailyLossAud) ? account.dailyLossAud : 0);
  const dailyLossRemainingAud = Math.max(0, MTF_PAPER_CONFIG.maxDailyLossAud - dailyLoss);
  // Daily-loss headroom is an independent hard cap, not merely a circuit-breaker
  // checked after a position has already consumed more risk capacity.
  const riskBudgetAud = Math.min(
    equity * MTF_PAPER_CONFIG.riskBudgetPct / 100,
    dailyLossRemainingAud
  );
  const allocationAud = Math.min(equity * MTF_PAPER_CONFIG.maxAllocationPct / 100, account.cashAud);
  const ask = m.quote.ask;
  const entryPrice = ask * (1 + MTF_PAPER_CONFIG.slippageBps / 10000);
  const stopDistance = m.signal.risk.initialStopDistance;
  const stopPrice = entryPrice - stopDistance;
  const entryCostPerUnit = entryPrice * (1 + MTF_PAPER_CONFIG.feeRate);
  const stopExitPerUnit = stopPrice > 0
    ? quoteCost(stopPrice) * (1 - MTF_PAPER_CONFIG.feeRate) : Number.NaN;
  const riskPerUnit = entryCostPerUnit - stopExitPerUnit;
  const quantity = riskBudgetAud > 0 && allocationAud > 0 && stopPrice > 0 &&
      Number.isFinite(riskPerUnit) && riskPerUnit > 0
    ? Math.floor(Math.min(
        riskBudgetAud / riskPerUnit,
        allocationAud / entryCostPerUnit
      ) * 1e8) / 1e8
    : 0;
  const notional = quantity * entryPrice;
  const entryFeeAud = notional * MTF_PAPER_CONFIG.feeRate;
  const entryCostAud = notional + entryFeeAud;
  const estimatedNetStopLossAud = quantity > 0 && Number.isFinite(riskPerUnit)
    ? quantity * riskPerUnit : 0;
  const minimumNotionalRiskAud = entryCostPerUnit > 0 && Number.isFinite(riskPerUnit) && riskPerUnit > 0
    ? 10 / entryCostPerUnit * riskPerUnit : Number.POSITIVE_INFINITY;
  const costDragPerUnit = Number.isFinite(stopExitPerUnit) && stopPrice > 0
    ? Math.max(0, entryCostPerUnit - ask) + Math.max(0, stopPrice - stopExitPerUnit)
    : 0;
  const costDragBps = entryPrice > 0 ? costDragPerUnit / entryPrice * 10000 : 0;
  const signalAt = m.signal.signalAt;
  const signalAgeMinutes = Math.max(0, (Date.parse(now) - (Date.parse(signalAt) + FOUR_HOUR_MS)) / 60000);
  const breakoutVotesValue = Number(m.signal.indicators?.breakoutVotes);
  const breakoutVotes = Number.isFinite(breakoutVotesValue)
    ? Math.max(0, Math.min(3, Math.floor(breakoutVotesValue))) : 0;
  const entryModel = m.signal.entryModel ||
    (m.signal.checks?.pullbackReclaim === true ? "PULLBACK_RECLAIM" : "DONCHIAN_BREAKOUT");
  let status = "ELIGIBLE";
  let reason = "Within the unchanged paper risk, fee and allocation controls.";
  if (!(riskBudgetAud > 0) || dailyLoss + estimatedNetStopLossAud > MTF_PAPER_CONFIG.maxDailyLossAud + 1e-8) {
    status = "BLOCKED_DAILY_LOSS_CAPACITY";
    reason = "Remaining daily-loss capacity cannot support this paper candidate.";
  } else if (!(stopPrice > 0) || !(riskPerUnit > 0) || !Number.isFinite(riskPerUnit)) {
    status = "BLOCKED_INVALID_RISK";
    reason = "Candidate stop or fee-adjusted risk is invalid.";
  } else if (allocationAud < 10) {
    status = "BLOCKED_ALLOCATION";
    reason = "Available cash or allocation is below the AUD 10 minimum paper notional.";
  } else if (quantity <= 0 || entryCostAud < 10) {
    status = riskBudgetAud + 1e-8 < minimumNotionalRiskAud
      ? "BLOCKED_DAILY_LOSS_CAPACITY" : "BLOCKED_MINIMUM_NOTIONAL";
    reason = status === "BLOCKED_DAILY_LOSS_CAPACITY"
      ? "Daily-loss headroom is below the risk required for the minimum AUD 10 paper position."
      : "Position falls below the AUD 10 minimum paper notional.";
  } else if (entryCostAud > account.cashAud + 1e-8 || entryCostAud > allocationAud + 1e-8) {
    status = "BLOCKED_ALLOCATION";
    reason = "Position exceeds available cash or the existing allocation ceiling.";
  } else if (estimatedNetStopLossAud > riskBudgetAud + 1e-8 ||
      dailyLoss + estimatedNetStopLossAud > MTF_PAPER_CONFIG.maxDailyLossAud + 1e-8) {
    status = "BLOCKED_DAILY_LOSS_CAPACITY";
    reason = "Fee-adjusted stop risk exceeds the remaining daily-loss capacity.";
  }
  return {
    market: m, coin: m.coin, pair: m.pair, signalAt, entryModel,
    entryPrice, stopPrice, quantity, notionalAud: round(notional),
    entryFeeAud: round(entryFeeAud), entryCostAud: round(entryCostAud),
    estimatedNetStopLossAud: round(estimatedNetStopLossAud),
    riskBudgetAud: round(riskBudgetAud), dailyLossRemainingAud: round(dailyLossRemainingAud),
    riskBudgetUsePct: riskBudgetAud > 0 ? round(estimatedNetStopLossAud / riskBudgetAud * 100) : 0,
    spreadBps: round(m.quote.spreadBps), costDragBps: round(costDragBps),
    breakoutVotes, signalAgeMinutes: round(signalAgeMinutes),
    longTrendSlopePct: Number.isFinite(m.signal.indicators?.longTrendSlopePct) ? m.signal.indicators.longTrendSlopePct : 0,
    status, reason
  };
}

function uniqueCoinSpotMtfMarkets(markets) {
  const list = Array.isArray(markets) ? markets : [];
  const counts = new Map();
  // Count every BTC/ETH record before validating its pair/quote. A malformed
  // duplicate must not be silently ignored while another record for that coin
  // is used to open or manage a position.
  for (const market of list) {
    if (validCoin(market?.coin)) counts.set(market.coin, (counts.get(market.coin) || 0) + 1);
  }
  return list.filter(market =>
    validCoin(market?.coin) &&
    counts.get(market.coin) === 1 &&
    validAudMarket(market));
}

function buildMtfCandidateRanking(markets, account, now) {
  const ranked = uniqueCoinSpotMtfMarkets(markets).filter(m => isMtfEntryCandidate(m, now))
    .map(m => rankMtfEntryCandidate(m, account, now))
    .sort((a, b) =>
      Number(a.status !== "ELIGIBLE") - Number(b.status !== "ELIGIBLE") ||
      a.riskBudgetUsePct - b.riskBudgetUsePct ||
      a.spreadBps - b.spreadBps ||
      a.costDragBps - b.costDragBps ||
      b.breakoutVotes - a.breakoutVotes ||
      b.longTrendSlopePct - a.longTrendSlopePct ||
      a.signalAgeMinutes - b.signalAgeMinutes ||
      a.coin.localeCompare(b.coin));
  return ranked.map((item, index) => ({ ...item, rank: index + 1 }));
}

export function processMtfPaperAccount(account, {markets=[], now=new Date().toISOString(), allowNewEntries=true}={}) {
  if (!validTimestamp(now)) throw new Error("CoinSpot MTF paper scan timestamp must be canonical UTC ISO; stored data was not changed.");
  const scanAt = Date.parse(now);
  let a = account ? structuredClone(account) : createMtfPaperAccount(now);
  validateMtfPaperAccount(a);
  if (scanAt < Date.parse(a.updatedAt)) throw new Error("CoinSpot MTF paper scan timestamp cannot move backwards; stored data was not changed.");
  const legacyRiskAccounting = a.riskAccountingVersion === undefined;
  const minimumCurrentDailyLoss = round(realizedDailyLoss(a, now) + (a.openPosition ? Math.max(0, -a.unrealizedPnlAud) : 0));
  if (a.day !== now.slice(0, 10)) {
    a.day = now.slice(0, 10);
    // Until a fresh quote arrives, retain the last validated open-position loss.
    // Resetting it to zero here would understate the daily-loss circuit during
    // a quote outage that spans UTC midnight.
    a.dailyLossAud = minimumCurrentDailyLoss;
  } else if (legacyRiskAccounting) {
    // One-time additive migration for older ledgers created before loss
    // reconciliation included a retained open-position mark.
    a.dailyLossAud = Math.max(a.dailyLossAud, minimumCurrentDailyLoss);
  }

  const byCoin = new Map(uniqueCoinSpotMtfMarkets(markets).map(m => [m.coin, m]));
  const p = a.openPosition;
  if (p) {
    const m = byCoin.get(p.coin), q = m?.quote, s = m?.signal;
    if (validPaperExitQuote(m, now)) {
      p.lastMarkAt = now;
      p.markStatus = "CURRENT";
      // The trailing-stop high-water mark advances only on a completed four-hour
      // close that occurred after this position was opened. Intrabar quotes still
      // trigger an existing stop, but cannot tighten it using an unfinished candle.
      const completedFourHourClose = Number(m?.history?.lastCompletedFourHourClose);
      const completedFourHourAt = Date.parse(m?.history?.lastCompletedFourHourAt || "");
      const openedAt = Date.parse(p.openedAt || "");
      const completedFourHourCloseAt = completedFourHourAt + FOUR_HOUR_MS;
      if (Number.isFinite(completedFourHourClose) && completedFourHourClose > 0 &&
          Number.isFinite(completedFourHourAt) && Number.isFinite(openedAt) &&
          completedFourHourCloseAt > openedAt && completedFourHourCloseAt <= Date.parse(now)) {
        p.highestPrice = Math.max(p.highestPrice, completedFourHourClose);
        p.trailingStop = Math.max(p.trailingStop,
          p.highestPrice - MTF_PAPER_CONFIG.trailingStopAtr * p.atr);
      }
      const heldDays = (Date.parse(now) - Date.parse(p.openedAt)) / 86400000;
      const mark = quoteCost(q.bid), gross = p.quantity * mark, fee = gross * MTF_PAPER_CONFIG.feeRate;
      a.unrealizedPnlAud = round(gross - fee - p.entryCost);
      a.dailyLossAud = round(realizedDailyLoss(a, now) + Math.max(0, -a.unrealizedPnlAud));
      const reason = q.bid <= Math.max(p.stopPrice, p.trailingStop) ? "TRAILING_STOP" :
        a.dailyLossAud >= MTF_PAPER_CONFIG.maxDailyLossAud ? "DAILY_LOSS_LIMIT" :
        s && (s.checks?.dailyTrend === false || s.checks?.fourHourTrend === false) ? "TREND_REVERSAL" :
        heldDays >= MTF_PAPER_CONFIG.maxHoldingDays ? "MAX_HOLD" : null;
      if (reason) closePosition(a, q.bid, now, reason);
      else a.equityAud = round(a.cashAud + gross - fee);
    } else {
      const lastMarkAt = p.lastMarkAt || p.openedAt;
      const lastMarkClock = Date.parse(lastMarkAt);
      const markAge = Date.parse(now) - lastMarkClock;
      p.lastMarkAt = lastMarkAt;
      p.markStatus = Number.isFinite(lastMarkClock) && markAge >= 0 && markAge <= MARK_STALE_AFTER_MS
        ? "UNAVAILABLE" : "STALE";
    }
  }

  a.lastCandidateRanking = [];
  if (allowNewEntries === true && !a.openPosition && a.dailyLossAud < MTF_PAPER_CONFIG.maxDailyLossAud) {
    const rankedCandidates = buildMtfCandidateRanking(markets, a, now);
    a.lastCandidateRanking = rankedCandidates.map(({ market, ...item }) => ({
      rank:item.rank, coin:item.coin, pair:item.pair, signalAt:item.signalAt, entryModel:item.entryModel,
      status:item.status, riskBudgetAud:item.riskBudgetAud, dailyLossRemainingAud:item.dailyLossRemainingAud,
      estimatedNetStopLossAud:item.estimatedNetStopLossAud, riskBudgetUsePct:item.riskBudgetUsePct,
      spreadBps:item.spreadBps, costDragBps:item.costDragBps, breakoutVotes:item.breakoutVotes,
      signalAgeMinutes:item.signalAgeMinutes, reason:item.reason
    }));

    for (const ranked of rankedCandidates) {
      if (ranked.status !== "ELIGIBLE") continue;
      const m = ranked.market;
      const signalAt = ranked.signalAt;
      if (!signalAt || a.lastProcessed[m.coin] === signalAt) continue;
      const ask = m.quote.ask, entry = ranked.entryPrice;
      const quantity = ranked.quantity, notional = ranked.notionalAud;
      const fee = ranked.entryFeeAud, entryCost = ranked.entryCostAud;
      const stopPrice = ranked.stopPrice;

      a.cashAud = round(a.cashAud - entryCost);
      a.openPosition = { id:m.coin + "-" + signalAt, coin:m.coin, pair:m.coin + "/AUD", openedAt:now,
        signalAt, entryModel:ranked.entryModel,
        candidateRank:ranked.rank, riskBudgetAud:ranked.riskBudgetAud,
        riskBudgetUsePct:ranked.riskBudgetUsePct, estimatedNetStopLossAud:ranked.estimatedNetStopLossAud,
        spreadBps:ranked.spreadBps, costDragBps:ranked.costDragBps,
        referenceAsk:ask, entryPrice:entry, quantity, notionalAud:notional,
        entryFeeAud:fee, entryCost:entryCost,
        stopPrice, trailingStop:stopPrice, atr:Number(m.signal.indicators.atr20),
        highestPrice:entry, lastMarkAt:now, markStatus:"CURRENT", status:"OPEN_PAPER_ONLY" };
      // A signal is consumed only after an actual paper entry. A blocked or
      // undersized candidate remains retryable while its signal is still fresh.
      a.lastProcessed[m.coin] = signalAt;
      // Mark the new position to the executable bid immediately. This includes
      // modeled round-trip costs in equity and the daily-loss circuit.
      const mark = quoteCost(m.quote.bid);
      const markGross = quantity * mark;
      const markFee = markGross * MTF_PAPER_CONFIG.feeRate;
      a.unrealizedPnlAud = round(markGross - markFee - entryCost);
      a.dailyLossAud = round(realizedDailyLoss(a, now) + Math.max(0, -a.unrealizedPnlAud));
      a.equityAud = round(a.cashAud + markGross - markFee);
      break;
    }
  }

  a.equityAud = round(a.cashAud + (a.openPosition ? a.openPosition.entryCost : 0) + a.unrealizedPnlAud);
  a.updatedAt = now;
  a.paperOnly = true;
  a.riskAccountingVersion = 2;
  a.liveTradingEnabled = false;
  return a;
}
