// EDGE live execution safety boundary. This module prepares and validates order intents only.
// It deliberately contains no exchange transport, signing, secret access, or order-submission function.
export const LIVE_CAPITAL_LIMIT_AUD = 100;
export const LIVE_DAILY_LOSS_LIMIT_AUD = 20;
export const LIVE_MAX_ORDER_NOTIONAL_AUD = 25;
export const LIVE_MAX_OPEN_POSITIONS = 1;
export const LIVE_ALLOWED_ASSETS = Object.freeze(["BTC", "ETH"]);
export const LIVE_EXECUTION_DEFAULTS = Object.freeze({
  mode: "LIVE_EXECUTION_LOCKED",
  enabled: false,
  requiresExplicitActivation: true,
  requiresStrategyValidation: true,
  requiresForwardPaperApproval: true,
  withdrawalsEnabled: false,
  transfersEnabled: false,
  capitalLimitAud: LIVE_CAPITAL_LIMIT_AUD,
  dailyLossLimitAud: LIVE_DAILY_LOSS_LIMIT_AUD,
  maxOrderNotionalAud: LIVE_MAX_ORDER_NOTIONAL_AUD
});
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function createLiveRiskState({ day = new Date().toISOString().slice(0, 10), startingCapitalAud = LIVE_CAPITAL_LIMIT_AUD } = {}) {
  if (startingCapitalAud !== LIVE_CAPITAL_LIMIT_AUD) throw new Error("EDGE live capital is fixed at the approved AUD 100 limit.");
  return { mode: "LIVE_RISK_GUARD_LOCKED", day, startingCapitalAud, realizedDailyLossAud: 0, reservedNotionalAud: 0, openPositions: 0, killSwitch: true, updatedAt: new Date().toISOString() };
}

export function normalizeLiveRiskState(state, { day = new Date().toISOString().slice(0, 10) } = {}) {
  if (!state || state.mode !== "LIVE_RISK_GUARD_LOCKED" || state.startingCapitalAud !== LIVE_CAPITAL_LIMIT_AUD ||
      !Number.isFinite(state.realizedDailyLossAud) || state.realizedDailyLossAud < 0 ||
      !Number.isFinite(state.reservedNotionalAud) || state.reservedNotionalAud < 0 ||
      !Number.isInteger(state.openPositions) || state.openPositions < 0 || typeof state.killSwitch !== "boolean") {
    return createLiveRiskState({ day });
  }
  if (state.day !== day) return { ...createLiveRiskState({ day }), killSwitch: state.killSwitch };
  return { ...state };
}

export function evaluateLiveExecutionGate({ activationConfirmed = false, strategyValidated = false, paperForwardApproved = false,
  credentialsConfigured = false, accountReconciled = false, riskState, now = new Date().toISOString() } = {}) {
  const state = normalizeLiveRiskState(riskState, { day: now.slice(0, 10) });
  const blockers = [];
  if (!activationConfirmed) blockers.push("Explicit live-trading activation has not been confirmed.");
  if (!strategyValidated) blockers.push("Strategy has not passed the required out-of-sample validation.");
  if (!paperForwardApproved) blockers.push("Forward paper-trading approval is outstanding.");
  if (!credentialsConfigured) blockers.push("Separate CoinSpot trading credentials are not configured.");
  if (!accountReconciled) blockers.push("Live account balances and open orders have not been reconciled.");
  if (state.killSwitch) blockers.push("Emergency kill switch is engaged.");
  if (state.realizedDailyLossAud >= LIVE_DAILY_LOSS_LIMIT_AUD) blockers.push("Daily loss limit reached.");
  return { allowed: blockers.length === 0, mode: "LIVE_EXECUTION_LOCKED", blockers, limits: {
    capitalAud: LIVE_CAPITAL_LIMIT_AUD, dailyLossAud: LIVE_DAILY_LOSS_LIMIT_AUD,
    maxOrderNotionalAud: LIVE_MAX_ORDER_NOTIONAL_AUD, maxOpenPositions: LIVE_MAX_OPEN_POSITIONS,
    withdrawalsEnabled: false, transfersEnabled: false
  }};
}

export function validateLiveOrderIntent({ side, coin, quoteCurrency = "AUD", spendAud, availableAud,
  openPositions = 0, dailyLossAud = 0, killSwitch = true } = {}) {
  const reject = reason => ({ accepted: false, executable: false, mode: "LIVE_EXECUTION_LOCKED", reason });
  const symbol = String(coin || "").toUpperCase();
  const amount = finite(spendAud), available = finite(availableAud), loss = finite(dailyLossAud);
  if (!["BUY", "SELL"].includes(String(side || "").toUpperCase())) return reject("Only spot BUY and SELL intents are supported.");
  if (!LIVE_ALLOWED_ASSETS.includes(symbol) || quoteCurrency !== "AUD") return reject("Only BTC/AUD and ETH/AUD spot markets are allowed.");
  if (amount === null || amount < 10 || amount > LIVE_MAX_ORDER_NOTIONAL_AUD) return reject("Order notional must be between AUD 10 and AUD 25.");
  if (available === null || available < amount || available > LIVE_CAPITAL_LIMIT_AUD) return reject("Available AUD balance is invalid or insufficient.");
  if (!Number.isInteger(openPositions) || openPositions < 0 || openPositions >= LIVE_MAX_OPEN_POSITIONS) return reject("Maximum open-position limit reached.");
  if (loss === null || loss < 0 || loss >= LIVE_DAILY_LOSS_LIMIT_AUD) return reject("Daily loss limit reached or invalid.");
  if (killSwitch !== false) return reject("Emergency kill switch is engaged.");
  return { accepted: true, executable: false, mode: "LIVE_EXECUTION_LOCKED", intent: {
    side: String(side).toUpperCase(), coin: symbol, market: symbol + "/AUD",
    notionalAud: round(amount), quoteCurrency: "AUD",
    maxCapitalAud: LIVE_CAPITAL_LIMIT_AUD, dailyLossLimitAud: LIVE_DAILY_LOSS_LIMIT_AUD
  }, reason: "Risk checks passed for an order intent only. No exchange order can be submitted by this module." };
}
