import test from "node:test";
import assert from "node:assert/strict";
import {createMtfPaperAccount,validateMtfPaperAccount} from "../coinspot-mtf-paper.js";

const now="2026-11-25T08:00:00.000Z";

test("closed MTF trades must not predate the completed four-hour signal close",()=>{
 const trade={id:"BTC-2026-11-25T02:00:00.000Z",coin:"BTC",pair:"BTC/AUD",
  openedAt:"2026-11-25T06:00:00.000Z",closedAt:"2026-11-25T07:00:00.000Z",
  signalAt:"2026-11-25T02:00:00.000Z",entryPrice:100000,exitPrice:99000,quantity:0.0005,
  entryFeeAud:0.05,exitFeeAud:0.05,pnlAud:-0.6,reason:"TRAILING_STOP"};
 const valid={...createMtfPaperAccount(now),cashAud:99.4,equityAud:99.4,realizedPnlAud:-0.6,dailyLossAud:0.6,lastProcessed:{BTC:trade.signalAt},closedTrades:[trade]};
 assert.equal(validateMtfPaperAccount(valid),true,"the exact four-hour close boundary remains valid");
 assert.throws(()=>validateMtfPaperAccount({...valid,closedTrades:[{...trade,openedAt:"2026-11-25T05:59:59.999Z"}]}),/ledger failed validation/);
 assert.throws(()=>validateMtfPaperAccount({...valid,closedTrades:[{...trade,signalAt:"2026-11-25T02:00:00.001Z",id:"BTC-2026-11-25T02:00:00.001Z"}]}),/ledger failed validation/);
 const staleAccount={...valid,updatedAt:"2026-11-25T16:00:00.000Z"};
 const maxAgeTrade={...trade,openedAt:"2026-11-25T14:00:00.000Z",closedAt:"2026-11-25T15:00:00.000Z"};
 assert.equal(validateMtfPaperAccount({...staleAccount,closedTrades:[maxAgeTrade]}),true,"the exact eight-hour post-close freshness boundary remains valid");
 assert.throws(()=>validateMtfPaperAccount({...staleAccount,closedTrades:[{...maxAgeTrade,openedAt:"2026-11-25T14:00:00.001Z"}]}),/ledger failed validation/);
});

test("closed trades cannot be dated after their persisted ledger snapshot",()=>{
 const trade={id:"BTC-2026-11-25T02:00:00.000Z",coin:"BTC",pair:"BTC/AUD",
  openedAt:"2026-11-25T06:00:00.000Z",closedAt:"2026-11-25T07:00:00.000Z",
  signalAt:"2026-11-25T02:00:00.000Z",entryPrice:100000,exitPrice:99000,quantity:0.0005,
  entryFeeAud:0.05,exitFeeAud:0.05,pnlAud:-0.6,reason:"TRAILING_STOP"};
 const account={...createMtfPaperAccount(now),cashAud:99.4,equityAud:99.4,realizedPnlAud:-0.6,dailyLossAud:0.6,lastProcessed:{BTC:trade.signalAt},closedTrades:[trade]};
 assert.equal(validateMtfPaperAccount(account),true);
 assert.throws(()=>validateMtfPaperAccount({...account,updatedAt:"2026-11-25T06:59:59.999Z"}),/ledger failed validation/);
});
