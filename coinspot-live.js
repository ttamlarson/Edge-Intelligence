// CoinSpot V2 live API request preparation. No request is sent from this module.
// Submission is intentionally separated until a Durable Object serializes nonces,
// persists idempotency keys, reconciles fills, and the strategy release gates pass.
export const COINSPOT_LIVE_API_BASE = "https://www.coinspot.com.au/api/v2";
export const COINSPOT_LIVE_ORDER_LIMIT_AUD = 25;
export const COINSPOT_LIVE_ALLOWED_COINS = Object.freeze(["BTC", "ETH"]);
const encoder = new TextEncoder();

export function validateCoinSpotLiveLimitOrder({ side, coin, amount, rate, markettype = "AUD" } = {}) {
  const action = String(side || "").toUpperCase();
  const symbol = String(coin || "").toUpperCase();
  const qty = Number(amount), price = Number(rate);
  if (!["BUY", "SELL"].includes(action)) throw new Error("Only spot limit BUY and SELL orders are supported.");
  if (!COINSPOT_LIVE_ALLOWED_COINS.includes(symbol) || markettype !== "AUD") throw new Error("Only BTC/AUD and ETH/AUD are enabled.");
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) throw new Error("Order amount and limit rate must be positive finite numbers.");
  if (Number(qty.toFixed(8)) !== qty || Number(price.toFixed(8)) !== price) throw new Error("CoinSpot limit orders support at most 8 decimal places.");
  const notional = qty * price;
  if (!Number.isFinite(notional) || notional < 10 || notional > COINSPOT_LIVE_ORDER_LIMIT_AUD) throw new Error("Order notional must be between AUD 10 and AUD 25.");
  return { path: action === "BUY" ? "/my/buy" : "/my/sell", payload: { cointype: symbol, amount: qty, rate: price, markettype: "AUD" }, notionalAud: Number(notional.toFixed(2)) };
}

export async function signCoinSpotLivePayload({ key, secret, payload, nonce }) {
  if (typeof key !== "string" || !key.trim() || typeof secret !== "string" || !secret.trim()) throw new Error("Separate CoinSpot trading credentials are not configured.");
  if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new Error("A safe monotonically increasing nonce is required.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.hasOwn(payload, "nonce")) throw new Error("Invalid CoinSpot request payload.");
  const body = JSON.stringify({ ...payload, nonce });
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(body));
  const sign = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { url: COINSPOT_LIVE_API_BASE, body, headers: { "Content-Type": "application/json", Accept: "application/json", key: key.trim(), sign } };
}

export function evaluateCoinSpotLiveRelease({ enabled = false, strategyValidated = false, forwardPaperApproved = false,
  explicitActivation = false, durableCoordinatorReady = false, accountReconciled = false } = {}) {
  const blockers = [];
  if (!enabled) blockers.push("LIVE_TRADING_ENABLED is not true.");
  if (!strategyValidated) blockers.push("Strategy validation has not passed.");
  if (!forwardPaperApproved) blockers.push("Forward paper trading has not been approved.");
  if (!explicitActivation) blockers.push("Explicit live-trading activation is missing.");
  if (!durableCoordinatorReady) blockers.push("Durable nonce and idempotency coordinator is not deployed.");
  if (!accountReconciled) blockers.push("CoinSpot balances and open orders are not reconciled.");
  return { allowed: blockers.length === 0, mode: "LIVE_EXECUTION_LOCKED", blockers, withdrawalsEnabled: false, transfersEnabled: false };
}
