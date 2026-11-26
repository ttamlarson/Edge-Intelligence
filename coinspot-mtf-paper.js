// CoinSpot multi-timeframe automated paper ledger. AUD only; never submits exchange orders.
export const MTF_PAPER_CONFIG = Object.freeze({
  startingCapitalAud: 100, maxAllocationPct: 25, riskBudgetPct: 0.5,
  feeRate: 0.001, slippageBps: 15, maxDailyLossAud: 3, maxSpreadBps: 50,
  maxHoldingDays: 30, initialStopAtr: 2.5, trailingStopAtr: 3
});
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;
const validCoin = coin => coin === "BTC" || coin === "ETH";
const validAudMarket = market => validCoin(market?.coin) && market?.pair === market.coin + "/AUD" && market?.quote?.pair === market.coin + "/AUD";
const validTimestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const positiveFinite = value => Number.isFinite(value) && value > 0;
const nonNegativeFinite = value => Number.isFinite(value) && value >= 0;
function validPaperQuote(market) {
  if (!validAudMarket(market)) return false;
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
  return { mode:"COINSPOT_MTF_AUTOMATED_PAPER", paperOnly:true, currency:"AUD", startingCapitalAud:100,
    cashAud:100, realizedPnlAud:0, unrealizedPnlAud:0, equityAud:100, dailyLossAud:0,
    day:now.slice(0,10), openPosition:null, closedTrades:[], lastProcessed:{},
    liveTradingEnabled:false, updatedAt:now };
}
export function validateMtfPaperAccount(a) {
  const validClosedTrade = trade => {
    if (!trade || !validCoin(trade.coin) || trade.pair !== trade.coin + "/AUD" ||
        !validTimestamp(trade.openedAt) || !validTimestamp(trade.closedAt) ||
        !validTimestamp(trade.signalAt) || Date.parse(trade.closedAt) < Date.parse(trade.openedAt) ||
        !positiveFinite(trade.entryPrice) || !positiveFinite(trade.exitPrice) ||
        !positiveFinite(trade.quantity) || !nonNegativeFinite(trade.entryFeeAud) ||
        !nonNegativeFinite(trade.exitFeeAud) || !Number.isFinite(trade.pnlAud) ||
        typeof trade.reason !== "string" || trade.reason.length === 0) return false;
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
  if (!a || a.mode!=="COINSPOT_MTF_AUTOMATED_PAPER" || a.currency!=="AUD" ||
      (a.paperOnly !== undefined && a.paperOnly !== true) ||
      a.startingCapitalAud!==100 || a.liveTradingEnabled!==false ||
      !Number.isFinite(a.cashAud) || a.cashAud<0 || !Number.isFinite(a.realizedPnlAud) ||
      !Number.isFinite(a.unrealizedPnlAud) || !Number.isFinite(a.equityAud) || a.equityAud<0 ||
      !Number.isFinite(a.dailyLossAud) || a.dailyLossAud<0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(ledgerDay) || !validTimestamp(a.updatedAt) ||
      !Number.isFinite(realizedLossForLedgerDay) || a.dailyLossAud + 0.02 < realizedLossForLedgerDay ||
      !Array.isArray(a.closedTrades) || a.closedTrades.length>200 ||
      a.closedTrades.some(trade => !validClosedTrade(trade)) ||
      !a.lastProcessed || typeof a.lastProcessed!=="object" || Array.isArray(a.lastProcessed))
    throw new Error("CoinSpot MTF paper ledger failed validation; stored data was not changed.");
  if (a.openPosition) {
    const p = a.openPosition;
    const entryCostMatches = Number.isFinite(p.entryCost) && Number.isFinite(p.notionalAud) &&
      Number.isFinite(p.entryFeeAud) &&
      Math.abs(p.entryCost - (p.notionalAud + p.entryFeeAud)) <= 0.02 &&
      Math.abs(p.notionalAud - p.quantity * p.entryPrice) <= 0.02;
    if (!validCoin(p.coin) || p.pair !== p.coin + "/AUD" ||
        !positiveFinite(p.quantity) || !positiveFinite(p.entryPrice) ||
        !positiveFinite(p.notionalAud) || !positiveFinite(p.entryCost) ||
        !nonNegativeFinite(p.entryFeeAud) || !entryCostMatches ||
        !positiveFinite(p.stopPrice) || p.stopPrice >= p.entryPrice ||
        !positiveFinite(p.atr) || !positiveFinite(p.highestPrice) || p.highestPrice < p.entryPrice ||
        !positiveFinite(p.trailingStop) || p.trailingStop < p.stopPrice || p.trailingStop >= p.highestPrice ||
        !validTimestamp(p.openedAt) || !validTimestamp(p.signalAt) ||
        Date.parse(p.openedAt) < Date.parse(p.signalAt) + FOUR_HOUR_MS ||
        (p.entryModel !== undefined && !["DONCHIAN_BREAKOUT", "PULLBACK_RECLAIM"].includes(p.entryModel)))
      throw new Error("CoinSpot MTF paper position failed validation; stored data was not changed.");
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
    entryFeeAud:p.entryFeeAud, exitFeeAud:round(exitFee), pnlAud:round(pnl), reason,
    strategy:"EDGE_MTF_DONCHIAN_ENSEMBLE_V1" });
  a.closedTrades = a.closedTrades.slice(-200);
  a.openPosition = null;
  a.unrealizedPnlAud = 0;
  a.dailyLossAud = realizedDailyLoss(a, now);
  a.equityAud = round(a.cashAud);
}
export function processMtfPaperAccount(account, {markets=[], now=new Date().toISOString()}={}) {
  let a = account ? structuredClone(account) : createMtfPaperAccount(now);
  validateMtfPaperAccount(a);
  if (a.day !== now.slice(0, 10)) { a.day = now.slice(0, 10); a.dailyLossAud = 0; }

  const byCoin = new Map(markets.filter(validAudMarket).map(m => [m.coin, m]));
  const p = a.openPosition;
  if (p) {
    const m = byCoin.get(p.coin), q = m?.quote, s = m?.signal;
    if (q && Number.isFinite(q.bid) && q.bid > 0) {
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
    }
  }

  if (!a.openPosition && a.dailyLossAud < MTF_PAPER_CONFIG.maxDailyLossAud) {
    const candidates = markets.filter(m => {
      const signal = m?.signal, quote = m?.quote, checks = signal?.checks;
      const signalAt = Date.parse(signal?.signalAt || "");
      const scanAt = Date.parse(now);
      const atr = Number(signal?.indicators?.atr20);
      const stopDistance = Number(signal?.risk?.initialStopDistance);
      const expectedStopDistance = atr * MTF_PAPER_CONFIG.initialStopAtr;
      const ageAfterSignalClose = scanAt - (signalAt + 4 * 60 * 60 * 1000);
      const requiredChecks = ["dailyTrend", "fourHourTrend", "positiveLongTrendSlope", "entryTrigger", "liquidity", "volatility"];
      return validPaperQuote(m) &&
        signal?.strategy === "EDGE_MTF_DONCHIAN_ENSEMBLE_V1" &&
        signal?.status === "BUY_CANDIDATE_PAPER_ONLY" &&
        signal?.execution?.orderIntent === "NONE" &&
        signal?.execution?.paperOnly === true &&
        signal?.execution?.liveTradingEnabled === false &&
        requiredChecks.every(key => checks?.[key] === true) &&
        (checks?.breakoutVotes === true || checks?.pullbackReclaim === true) &&
        quote &&
        Number.isFinite(atr) && atr > 0 &&
        Number.isFinite(stopDistance) && stopDistance > 0 &&
        Math.abs(stopDistance - expectedStopDistance) <= Math.max(1e-8, expectedStopDistance * 1e-6) &&
        Number.isFinite(signalAt) && Number.isFinite(scanAt) &&
        ageAfterSignalClose >= 0 && ageAfterSignalClose <= 8 * 60 * 60 * 1000;
    }).sort((x, y) => Number(y.signal.indicators.breakoutVotes || 0) - Number(x.signal.indicators.breakoutVotes || 0));

    for (const m of candidates) {
      const signalAt = m.signal.signalAt;
      if (!signalAt || a.lastProcessed[m.coin] === signalAt) continue;
      a.lastProcessed[m.coin] = signalAt;

      const ask = m.quote.ask, entry = ask * (1 + MTF_PAPER_CONFIG.slippageBps / 10000);
      const equity = Math.max(0, Number.isFinite(a.equityAud) ? a.equityAud : a.cashAud);
      const riskBudget = equity * MTF_PAPER_CONFIG.riskBudgetPct / 100;
      const allocation = Math.min(equity * MTF_PAPER_CONFIG.maxAllocationPct / 100, a.cashAud);
      const stopDistance = m.signal.risk.initialStopDistance;
      const stopPrice = entry - stopDistance;
      const entryCostPerUnit = entry * (1 + MTF_PAPER_CONFIG.feeRate);
      const stopExitPerUnit = quoteCost(stopPrice) * (1 - MTF_PAPER_CONFIG.feeRate);
      const riskPerUnit = entryCostPerUnit - stopExitPerUnit;
      if (stopPrice <= 0 || !Number.isFinite(riskPerUnit) || riskPerUnit <= 0) continue;

      // Risk sizing includes entry and stop-exit fees plus both sides of modeled slippage.
      const quantity = Math.floor(Math.min(
        riskBudget / riskPerUnit,
        allocation / entryCostPerUnit
      ) * 1e8) / 1e8;
      const notional = quantity * entry, fee = notional * MTF_PAPER_CONFIG.feeRate;
      const entryCost = notional + fee;
      if (quantity <= 0 || entryCost < 10 || entryCost > a.cashAud) continue;

      a.cashAud = round(a.cashAud - entryCost);
      a.openPosition = { id:m.coin + "-" + signalAt, coin:m.coin, pair:m.coin + "/AUD", openedAt:now,
        signalAt, entryModel:m.signal.entryModel ||
          (m.signal.checks?.pullbackReclaim === true ? "PULLBACK_RECLAIM" : "DONCHIAN_BREAKOUT"),
        referenceAsk:ask, entryPrice:entry, quantity, notionalAud:round(notional),
        entryFeeAud:round(fee), entryCost:round(entryCost),
        stopPrice, trailingStop:stopPrice, atr:Number(m.signal.indicators.atr20),
        highestPrice:entry, status:"OPEN_PAPER_ONLY" };
      // Mark the new position to the executable bid immediately. This includes
      // the modeled round-trip costs in equity and the daily-loss circuit from
      // the first scan rather than temporarily reporting par after entry.
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
  a.liveTradingEnabled = false;
  return a;
}
