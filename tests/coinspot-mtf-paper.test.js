import test from "node:test";
import assert from "node:assert/strict";
import {MTF_PAPER_CONFIG,createMtfPaperAccount,processMtfPaperAccount,validateMtfPaperAccount} from "../coinspot-mtf-paper.js";
const now="2026-11-25T08:00:00.000Z";
function candidate(coin="BTC",signalAt="2026-11-25T04:00:00.000Z",ask=100000){
 const bid=ask*.999;
 return {coin,pair:coin+"/AUD",quote:{pair:coin+"/AUD",bid,ask,last:ask,spreadBps:(ask-bid)/ask*10000},signal:{
  strategy:"EDGE_MTF_DONCHIAN_ENSEMBLE_V1",status:"BUY_CANDIDATE_PAPER_ONLY",signalAt,
  indicators:{breakoutVotes:3,atr20:1000},risk:{initialStopDistance:2500},
  checks:{dailyTrend:true,fourHourTrend:true,positiveLongTrendSlope:true,breakoutVotes:true,liquidity:true,volatility:true},
  execution:{orderIntent:"NONE",paperOnly:true,liveTradingEnabled:false}
 }};
}
test("starts with AUD 100 and immutable paper-only safety flags",()=>{const a=createMtfPaperAccount(now);assert.equal(a.cashAud,100);assert.equal(a.paperOnly,true);assert.equal(a.liveTradingEnabled,false);assert.equal(validateMtfPaperAccount(a),true);});
test("migrates legacy ledgers to an explicit paper-only marker and rejects a false marker",()=>{const legacy=createMtfPaperAccount(now);delete legacy.paperOnly;assert.equal(validateMtfPaperAccount(legacy),true);const migrated=processMtfPaperAccount(legacy,{markets:[],now});assert.equal(migrated.paperOnly,true);assert.equal(migrated.liveTradingEnabled,false);assert.throws(()=>processMtfPaperAccount({...migrated,paperOnly:false},{markets:[],now}),/failed validation/);});
test("opens a single risk-sized simulated CoinSpot position and retains reserve",()=>{const a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});assert.ok(a.openPosition);assert.equal(a.openPosition.coin,"BTC");assert.ok(a.cashAud>=75);assert.ok(a.unrealizedPnlAud<0);assert.ok(a.equityAud<100);assert.ok(a.dailyLossAud>0);assert.equal(a.liveTradingEnabled,false);});
test("does not repeat an already processed signal",()=>{let a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});const next=processMtfPaperAccount(a,{markets:[candidate()],now:"2026-11-25T08:15:00.000Z"});assert.equal(next.openPosition.id,a.openPosition.id);});
test("trailing stop closes position and records net fees",()=>{let a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});const m={...candidate(),quote:{pair:"BTC/AUD",bid:a.openPosition.stopPrice*.9,ask:a.openPosition.stopPrice,last:a.openPosition.stopPrice}};a=processMtfPaperAccount(a,{markets:[m],now:"2026-11-25T09:00:00.000Z"});assert.equal(a.openPosition,null);assert.equal(a.closedTrades.length,1);assert.equal(a.closedTrades[0].reason,"TRAILING_STOP");assert.equal(a.liveTradingEnabled,false);});
test("daily trend reversal closes an open paper position",()=>{let a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});const m={...candidate(),quote:{pair:"BTC/AUD",bid:101000,ask:101100,last:101000},signal:{...candidate().signal,status:"NO_TRADE",checks:{dailyTrend:false,fourHourTrend:true}}};a=processMtfPaperAccount(a,{markets:[m],now:"2026-11-25T09:00:00.000Z"});assert.equal(a.openPosition,null);assert.equal(a.closedTrades[0].reason,"TREND_REVERSAL");});
test("rejects corrupt or live-enabled paper ledger without resetting it",()=>{assert.throws(()=>processMtfPaperAccount({...createMtfPaperAccount(now),cashAud:-1},{markets:[],now}),/failed validation/);assert.throws(()=>processMtfPaperAccount({...createMtfPaperAccount(now),liveTradingEnabled:true},{markets:[],now}),/failed validation/);});

test("position sizing caps stop-loss risk after round-trip fees and slippage",()=>{
 const a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 const p=a.openPosition;
 assert.ok(p);
 const entryCostPerUnit=p.entryPrice*(1+MTF_PAPER_CONFIG.feeRate);
 const stopProceedsPerUnit=p.stopPrice*(1-MTF_PAPER_CONFIG.slippageBps/10000)*(1-MTF_PAPER_CONFIG.feeRate);
 const modeledRisk=p.quantity*(entryCostPerUnit-stopProceedsPerUnit);
 assert.ok(modeledRisk<=MTF_PAPER_CONFIG.startingCapitalAud*MTF_PAPER_CONFIG.riskBudgetPct/100+0.01);
 assert.ok(p.notionalAud<=MTF_PAPER_CONFIG.startingCapitalAud*MTF_PAPER_CONFIG.maxAllocationPct/100);
});

test("daily loss circuit includes open mark-to-market loss and closes at the limit",()=>{
 let a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 assert.ok(a.openPosition);
 a.closedTrades.push({closedAt:now,pnlAud:-2.9});
 const p=a.openPosition;
 const bid=p.entryPrice-2000;
 const market={...candidate(),signalAt:p.signalAt,quote:{bid,ask:bid+10,last:bid}};
 a=processMtfPaperAccount(a,{markets:[market],now:"2026-11-25T09:00:00.000Z"});
 assert.equal(a.openPosition,null);
 assert.equal(a.closedTrades.at(-1).reason,"DAILY_LOSS_LIMIT");
 assert.ok(a.dailyLossAud>=MTF_PAPER_CONFIG.maxDailyLossAud);
 assert.equal(a.liveTradingEnabled,false);
});


test("rejects malformed MTF candidates with invalid ATR or crossed quotes",()=>{
 const base=candidate();
 const badAtr={...base,signal:{...base.signal,indicators:{...base.signal.indicators,atr20:0}}};
 const crossed={...candidate("ETH"),quote:{pair:"ETH/AUD",bid:101000,ask:100000,last:100500}};
 const a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[badAtr,crossed],now});
 assert.equal(a.openPosition,null);
 assert.equal(a.cashAud,100);
 assert.equal(a.equityAud,100);
 assert.equal(a.liveTradingEnabled,false);
 assert.equal(validateMtfPaperAccount(a),true);
});

test("rejects wide-spread, stale, incomplete-check, malformed-stop and non-paper candidates before sizing",()=>{
 const base=candidate();
 const wide={...base,quote:{...base.quote,spreadBps:MTF_PAPER_CONFIG.maxSpreadBps+0.01}};
 const stale={...base,signal:{...base.signal,signalAt:"2026-11-24T04:00:00.000Z"}};
 const incomplete={...base,signal:{...base.signal,checks:{...base.signal.checks,volatility:false}}};
 const badStop={...base,signal:{...base.signal,risk:{initialStopDistance:2000}}};
 const liveIntent={...base,signal:{...base.signal,execution:{...base.signal.execution,liveTradingEnabled:true}}};
 const missingSpread={...base,quote:{...base.quote,spreadBps:undefined}};
 const a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[wide,stale,incomplete,badStop,liveIntent,missingSpread],now});
 assert.equal(a.openPosition,null);
 assert.equal(a.cashAud,100);
 assert.equal(a.equityAud,100);
 assert.deepEqual(a.lastProcessed,{});
 assert.equal(a.liveTradingEnabled,false);
});


test("rejects mismatched market and quote pairs before paper entry",()=>{
 const wrongMarketPair={...candidate("BTC"),pair:"BTC/USDT"};
 const eth=candidate("ETH");
 const wrongQuotePair={...eth,quote:{...eth.quote,pair:"ETH/USDT"}};
 const a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[wrongMarketPair,wrongQuotePair],now});
 assert.equal(a.openPosition,null);
 assert.equal(a.cashAud,100);
 assert.deepEqual(a.lastProcessed,{});
 assert.equal(a.paperOnly,true);
 assert.equal(a.liveTradingEnabled,false);
});

test("rejects persisted positions and closed trades outside the exact AUD pairs",()=>{
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 assert.ok(opened.openPosition);
 assert.throws(()=>validateMtfPaperAccount({...opened,openPosition:{...opened.openPosition,pair:"BTC/USDT"}}),/position failed validation/);
 assert.throws(()=>validateMtfPaperAccount({...createMtfPaperAccount(now),closedTrades:[{coin:"ETH",pair:"ETH/USDT"}]}),/ledger failed validation/);
});
