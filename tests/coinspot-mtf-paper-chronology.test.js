import test from "node:test";
import assert from "node:assert/strict";
import {createMtfPaperAccount,validateMtfPaperAccount} from "../coinspot-mtf-paper.js";

const now="2026-11-25T08:00:00.000Z";

test("closed MTF trades must not predate the completed four-hour signal close",()=>{
 const trade={id:"BTC-chronology",coin:"BTC",pair:"BTC/AUD",
  openedAt:"2026-11-25T06:00:00.000Z",closedAt:"2026-11-25T07:00:00.000Z",
  signalAt:"2026-11-25T02:00:00.000Z",entryPrice:100000,exitPrice:99000,quantity:0.0005,
  entryFeeAud:0.05,exitFeeAud:0.0495,pnlAud:-0.6,reason:"TRAILING_STOP"};
 const valid={...createMtfPaperAccount(now),cashAud:99.4,equityAud:99.4,realizedPnlAud:-0.6,dailyLossAud:0.6,closedTrades:[trade]};
 assert.equal(validateMtfPaperAccount(valid),true,"the exact four-hour close boundary remains valid");
 assert.throws(()=>validateMtfPaperAccount({...valid,closedTrades:[{...trade,openedAt:"2026-11-25T05:59:59.999Z"}]}),/ledger failed validation/);
 assert.throws(()=>validateMtfPaperAccount({...valid,closedTrades:[{...trade,signalAt:"2026-11-25T02:00:00.001Z"}]}),/ledger failed validation/);
});
