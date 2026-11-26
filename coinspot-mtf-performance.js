// Derived performance metrics for the CoinSpot MTF AUD paper ledger.
// This module never changes the ledger and never manufactures equity-curve points.
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateMtfPaperPerformance(account, now = new Date()) {
  const clock = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(clock)) throw new Error("Invalid performance calculation time.");
  const trades = Array.isArray(account?.closedTrades) ? account.closedTrades : [];
  const validTrades = trades.filter(trade => trade && Number.isFinite(Date.parse(trade.closedAt)) && Date.parse(trade.closedAt) <= clock && Number.isFinite(Number(trade.pnlAud)));
  const pnl = validTrades.map(trade => Number(trade.pnlAud));
  const wins = pnl.filter(value => value > 0);
  const losses = pnl.filter(value => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = -losses.reduce((sum, value) => sum + value, 0);
  // The ledger retains only its latest 200 closed trades; use its validated
  // cumulative realized P&L for lifetime results instead of summing that sample.
  const realized = Number.isFinite(Number(account?.realizedPnlAud))
    ? Number(account.realizedPnlAud) : pnl.reduce((sum, value) => sum + value, 0);
  const tradeHistoryAtLimit = trades.length >= 200;
  const unrealized = finite(account?.unrealizedPnlAud);
  const equity = finite(account?.equityAud);
  const startingCapital = finite(account?.startingCapitalAud);
  const periodPnl = duration => round(validTrades.reduce((sum, trade) => {
    const closedAt = Date.parse(trade.closedAt);
    return sum + (closedAt > clock - duration && closedAt <= clock ? Number(trade.pnlAud) : 0);
  }, 0));
  const fees = validTrades.reduce((sum, trade) => sum + finite(trade.entryFeeAud) + finite(trade.exitFeeAud), 0);
  const average = values => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  return {
    currency: "AUD",
    startingCapitalAud: round(startingCapital),
    equityAud: round(equity),
    realizedPnlAud: round(realized),
    unrealizedPnlAud: round(unrealized),
    netPnlAud: round(realized + unrealized),
    returnPct: startingCapital > 0 ? round((equity / startingCapital - 1) * 100) : null,
    closedTrades: validTrades.length,
    tradeHistoryAtLimit,
    tradeStatisticsBasis: tradeHistoryAtLimit ? "LATEST_200_RETAINED_CLOSED_TRADES" : "ALL_RETAINED_CLOSED_TRADES",
    rollingWindowsComplete: !tradeHistoryAtLimit,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRatePct: validTrades.length ? round(wins.length / validTrades.length * 100) : null,
    averageWinAud: average(wins),
    averageLossAud: average(losses),
    grossProfitAud: round(grossProfit),
    grossLossAud: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    feesPaidAud: round(fees),
    rolling24hPnlAud: periodPnl(24 * 60 * 60 * 1000),
    rolling7dPnlAud: periodPnl(7 * 24 * 60 * 60 * 1000),
    rolling30dPnlAud: periodPnl(30 * 24 * 60 * 60 * 1000),
    openPosition: Boolean(account?.openPosition),
    performanceBasis: "CUMULATIVE_LEDGER_REALIZED_PNL_PLUS_CURRENT_UNREALIZED_PNL; TRADE_STATISTICS_AND_FEES_USE_RETAINED_CLOSED_TRADES",
    equityCurve: null
  };
}
