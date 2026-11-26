// CoinSpot multi-timeframe automated paper ledger. AUD only; never submits exchange orders.
export const MTF_PAPER_CONFIG = Object.freeze({
  startingCapitalAud: 100, maxAllocationPct: 25, riskBudgetPct: 0.5,
  feeRate: 0.001, slippageBps: 15, maxDailyLossAud: 3, maxSpreadBps: 50,
  maxHoldingDays: 30, initialStopAtr: 2.5, trailingStopAtr: 3
});
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const validCoin = coin => coin === "BTC" || coin === "ETH";
const validAudMarket = market => validCoin(market?.coin) && market?.pair === market.coin + "/AUD" && market?.quote?.pair === market.coin + "/AUD";
const quoteCost = price => price * (1 - MTF_PAPER_CONFIG.slippageBps / 10000);
export function createMtfPaperAccount(now = new Date().toISOString()) {
  return { mode:"COINSPOT_MTF_AUTOMATED_PAPER", paperOnly:true, currency:"AUD", startingCapitalAud:100,
    cashAud:100, realizedPnlAud:0, unrealizedPnlAud:0, equityAud:100, dailyLossAud:0,
    day:now.slice(0,10), openPosition:null, closedTrades:[], lastProcessed:{},
    liveTradingEnabled:false, updatedAt:now };
}
export function validateMtfPaperAccount(a) {
  if (!a || a.mode!=="COINSPOT_MTF_AUTOMATED_PAPER" || a.currency!=="AUD" ||
      (a.paperOnly !== undefined && a.paperOnly !== true) ||
      a.startingCapitalAud!==100 || a.liveTradingEnabled!==false ||
      !Number.isFinite(a.cashAud) || a.cashAud<0 || !Number.isFinite(a.realizedPnlAud) ||
      !Number.isFinite(a.unrealizedPnlAud) || !Number.isFinite(a.equityAud) || a.equityAud<0 ||
      !Number.isFinite(a.dailyLossAud) || a.dailyLossAud<0 ||
      !Array.isArray(a.closedTrades) || a.closedTrades.length>200 ||
      a.closedTrades.some(t => !validCoin(t?.coin) || t?.pair !== t.coin + "/AUD") ||
      !a.lastProcessed || typeof a.lastProcessed!=="object" || Array.isArray(a.lastProcessed))
    throw new Error("CoinSpot MTF paper ledger failed validation; stored data was not changed.");
  if (a.openPosition && (!validCoin(a.openPosition.coin) || a.openPosition.pair !== a.openPosition.coin + "/AUD" ||
      !Number.isFinite(a.openPosition.quantity) || a.openPosition.quantity<=0 ||
      !Number.isFinite(a.openPosition.entryPrice) || a.openPosition.entryPrice<=0 ||
      !Number.isFinite(a.openPosition.stopPrice) || a.openPosition.stopPrice<=0 ||
      !Number.isFinite(a.openPosition.atr) || a.openPosition.atr<=0 ||
      !Number.isFinite(a.openPosition.highestPrice) || a.openPosition.highestPrice<=0 ||
      !Number.isFinite(a.openPosition.trailingStop) || a.openPosition.trailingStop<=0 || !a.openPosition.signalAt))
    throw new Error("CoinSpot MTF paper position failed validation; stored data was not changed.");
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
      p.highestPrice = Math.max(p.highestPrice, Number(q.last) || q.bid);
      p.trailingStop = Math.max(p.trailingStop, p.highestPrice - MTF_PAPER_CONFIG.trailingStopAtr * p.atr);
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
      const requiredChecks = ["dailyTrend", "fourHourTrend", "positiveLongTrendSlope", "breakoutVotes", "liquidity", "volatility"];
      return validAudMarket(m) &&
        signal?.strategy === "EDGE_MTF_DONCHIAN_ENSEMBLE_V1" &&
        signal?.status === "BUY_CANDIDATE_PAPER_ONLY" &&
        signal?.execution?.orderIntent === "NONE" &&
        signal?.execution?.paperOnly === true &&
        signal?.execution?.liveTradingEnabled === false &&
        requiredChecks.every(key => checks?.[key] === true) &&
        quote && Number.isFinite(quote.bid) && quote.bid > 0 &&
        Number.isFinite(quote.ask) && quote.ask >= quote.bid &&
        Number.isFinite(quote.last) && quote.last > 0 &&
        Number.isFinite(quote.spreadBps) && quote.spreadBps >= 0 &&
        quote.spreadBps <= MTF_PAPER_CONFIG.maxSpreadBps &&
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
        signalAt, referenceAsk:ask, entryPrice:entry, quantity, notionalAud:round(notional),
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
