import test from "node:test";
import assert from "node:assert/strict";
import { createLiveRiskState, evaluateLiveExecutionGate, validateLiveOrderIntent, LIVE_CAPITAL_LIMIT_AUD, LIVE_DAILY_LOSS_LIMIT_AUD } from "../live-execution-guard.js";

test("live risk defaults are fixed at AUD 100 capital and AUD 20 daily loss", () => {
  assert.equal(LIVE_CAPITAL_LIMIT_AUD, 100);
  assert.equal(LIVE_DAILY_LOSS_LIMIT_AUD, 20);
  assert.equal(createLiveRiskState().killSwitch, true);
});

test("live execution remains locked without every approval gate", () => {
  const result = evaluateLiveExecutionGate({ riskState: createLiveRiskState() });
  assert.equal(result.allowed, false);
  assert.equal(result.mode, "LIVE_EXECUTION_LOCKED");
  assert.ok(result.blockers.length >= 6);
  assert.equal(result.limits.withdrawalsEnabled, false);
  assert.equal(result.limits.transfersEnabled, false);
});

test("all gates cannot bypass the emergency kill switch", () => {
  const result = evaluateLiveExecutionGate({
    activationConfirmed: true, strategyValidated: true, paperForwardApproved: true,
    credentialsConfigured: true, accountReconciled: true, riskState: createLiveRiskState()
  });
  assert.equal(result.allowed, false);
  assert.ok(result.blockers.some(x => x.includes("kill switch")));
});

test("risk-valid order intent is accepted for review but never executable", () => {
  const result = validateLiveOrderIntent({ side: "BUY", coin: "BTC", spendAud: 25, availableAud: 100, killSwitch: false });
  assert.equal(result.accepted, true);
  assert.equal(result.executable, false);
  assert.equal(result.intent.market, "BTC/AUD");
});

test("rejects oversized, unsupported, over-loss and unsafe order intents", () => {
  assert.equal(validateLiveOrderIntent({ side: "BUY", coin: "BTC", spendAud: 26, availableAud: 100, killSwitch: false }).accepted, false);
  assert.equal(validateLiveOrderIntent({ side: "BUY", coin: "DOGE", spendAud: 20, availableAud: 100, killSwitch: false }).accepted, false);
  assert.equal(validateLiveOrderIntent({ side: "BUY", coin: "BTC", spendAud: 20, availableAud: 100, dailyLossAud: 20, killSwitch: false }).accepted, false);
  assert.equal(validateLiveOrderIntent({ side: "BUY", coin: "BTC", spendAud: 20, availableAud: 100 }).accepted, false);
  assert.equal(validateLiveOrderIntent({ side: "WITHDRAW", coin: "BTC", spendAud: 20, availableAud: 100, killSwitch: false }).accepted, false);
});
