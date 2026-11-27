import test from "node:test";
import assert from "node:assert/strict";
import {MTF_PAPER_CONFIG,createMtfPaperAccount,processMtfPaperAccount,validateMtfPaperAccount} from "../coinspot-mtf-paper.js";
const now="2026-11-25T08:00:00.000Z";
function candidate(coin="BTC",signalAt="2026-11-25T04:00:00.000Z",ask=100000,entryModel="DONCHIAN_BREAKOUT",retrievedAt=now){
 const bid=ask*.999;
 const breakoutVotes=entryModel==="DONCHIAN_BREAKOUT";
 const pullbackReclaim=entryModel==="PULLBACK_RECLAIM";
 return {coin,pair:coin+"/AUD",quote:{pair:coin+"/AUD",bid,ask,last:ask,spreadBps:(ask-bid)/((ask+bid)/2)*10000,retrievedAt},signal:{
  strategy:"EDGE_MTF_DONCHIAN_ENSEMBLE_V1",status:"BUY_CANDIDATE_PAPER_ONLY",signalAt,entryModel,
  indicators:{breakoutVotes:breakoutVotes?3:0,atr20:1000},risk:{initialStopDistance:2500},
  checks:{dailyTrend:true,fourHourTrend:true,positiveLongTrendSlope:true,breakoutVotes,pullbackReclaim,entryTrigger:true,liquidity:true,volatility:true},
  execution:{orderIntent:"NONE",paperOnly:true,liveTradingEnabled:false}
 }};
}
test("starts with AUD 100 and immutable paper-only safety flags",()=>{const a=createMtfPaperAccount(now);assert.equal(a.cashAud,100);assert.equal(a.paperOnly,true);assert.equal(a.liveTradingEnabled,false);assert.equal(validateMtfPaperAccount(a),true);});
test("migrates legacy ledgers to an explicit paper-only marker and rejects a false marker",()=>{const legacy=createMtfPaperAccount(now);delete legacy.paperOnly;assert.equal(validateMtfPaperAccount(legacy),true);const migrated=processMtfPaperAccount(legacy,{markets:[],now});assert.equal(migrated.paperOnly,true);assert.equal(migrated.liveTradingEnabled,false);assert.throws(()=>processMtfPaperAccount({...migrated,paperOnly:false},{markets:[],now}),/failed validation/);});
test("opens a single risk-sized simulated CoinSpot position and retains reserve",()=>{const a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});assert.ok(a.openPosition);assert.equal(a.openPosition.coin,"BTC");assert.ok(a.cashAud>=75);assert.ok(a.unrealizedPnlAud<0);assert.ok(a.equityAud<100);assert.ok(a.dailyLossAud>0);assert.equal(a.liveTradingEnabled,false);});
test("does not repeat an already processed signal",()=>{let a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});const next=processMtfPaperAccount(a,{markets:[candidate()],now:"2026-11-25T08:15:00.000Z"});assert.equal(next.openPosition.id,a.openPosition.id);});
test("does not consume a signal when risk sizing falls below the minimum notional",()=>{
 const undersized=candidate();
 undersized.signal.indicators.atr20=10000;
 undersized.signal.risk.initialStopDistance=25000;
 const skipped=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[undersized],now});
 assert.equal(skipped.openPosition,null);
 assert.deepEqual(skipped.lastProcessed,{});
 const retried=processMtfPaperAccount(skipped,{markets:[candidate("BTC","2026-11-25T04:00:00.000Z",100000,"DONCHIAN_BREAKOUT","2026-11-25T08:15:00.000Z")],now:"2026-11-25T08:15:00.000Z"});
 assert.ok(retried.openPosition);
 assert.equal(retried.lastProcessed.BTC,"2026-11-25T04:00:00.000Z");
});

test("accepts an executable quote exactly at the 20-minute freshness boundary",()=>{
 const boundary=candidate("BTC","2026-11-25T04:00:00.000Z",100000,"DONCHIAN_BREAKOUT","2026-11-25T07:40:00.000Z");
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[boundary],now});
 assert.ok(opened.openPosition);
 assert.equal(opened.paperOnly,true);
 assert.equal(opened.liveTradingEnabled,false);
});

test("stale or future quote timestamps cannot open or close paper positions",()=>{
 const staleEntry=candidate("BTC","2026-11-25T04:00:00.000Z",100000,"DONCHIAN_BREAKOUT","2026-11-25T07:39:59.999Z");
 const blocked=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[staleEntry],now});
 assert.equal(blocked.openPosition,null);
 assert.deepEqual(blocked.lastProcessed,{});
 const futureEntry=candidate("BTC","2026-11-25T04:00:00.000Z",100000,"DONCHIAN_BREAKOUT","2026-11-25T08:00:00.001Z");
 assert.equal(processMtfPaperAccount(createMtfPaperAccount(now),{markets:[futureEntry],now}).openPosition,null);
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 const stop=opened.openPosition.stopPrice;
 const staleExit={...candidate(),quote:{...candidate().quote,bid:stop*.9,ask:stop,last:stop,retrievedAt:"2026-11-25T08:09:59.999Z"}};
 const unchanged=processMtfPaperAccount(opened,{markets:[staleExit],now:"2026-11-25T08:30:00.000Z"});
 assert.ok(unchanged.openPosition);
 assert.equal(unchanged.openPosition.markStatus,"STALE");
 assert.equal(unchanged.openPosition.lastMarkAt,now);
 assert.equal(unchanged.closedTrades.length,0);
 assert.equal(unchanged.equityAud,opened.equityAud);
 assert.equal(unchanged.paperOnly,true);
 assert.equal(unchanged.liveTradingEnabled,false);
});
function setSpread(market, spreadBps) {
 const ask=100000,bid=ask*(20000-spreadBps)/(20000+spreadBps);
 market.quote.bid=bid;
 market.quote.ask=ask;
 market.quote.last=(bid+ask)/2;
 market.quote.spreadBps=(ask-bid)/((ask+bid)/2)*10000;
 return market;
}

test("risk-aware MTF ranking prefers lower executable spread and persists the entry evidence",()=>{
 const wide=setSpread(candidate("ETH"),40);
 const tight=setSpread(candidate("BTC"),10);
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[wide,tight],now});
 assert.equal(opened.openPosition.coin,"BTC");
 assert.equal(opened.openPosition.candidateRank,1);
 assert.ok(opened.openPosition.riskBudgetUsePct<=100.01);
 assert.equal(opened.lastCandidateRanking[0].coin,"BTC");
 assert.equal(opened.lastCandidateRanking[0].status,"ELIGIBLE");
 assert.ok(opened.lastCandidateRanking[0].spreadBps<opened.lastCandidateRanking[1].spreadBps);
 assert.equal(validateMtfPaperAccount(opened),true);
});

test("MTF candidate ranking prioritises lower fee-adjusted stop-risk budget use",()=>{
 const riskLimited=candidate("BTC");
 const allocationLimited=candidate("ETH");
 allocationLimited.signal.indicators.atr20=100;
 allocationLimited.signal.risk.initialStopDistance=250;
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[riskLimited,allocationLimited],now});
 assert.equal(opened.openPosition.coin,"ETH");
 assert.ok(opened.lastCandidateRanking[0].riskBudgetUsePct<opened.lastCandidateRanking[1].riskBudgetUsePct);
 assert.equal(opened.openPosition.candidateRank,1);
 assert.equal(validateMtfPaperAccount(opened),true);
});

test("MTF entry risk is capped by remaining daily-loss headroom before minimum-notional sizing",()=>{
 const account=createMtfPaperAccount(now);
 account.cashAud=97.08;
 account.realizedPnlAud=-2.92;
 account.equityAud=97.08;
 account.dailyLossAud=2.92;
 account.closedTrades=[{
  id:"prior-loss",coin:"BTC",pair:"BTC/AUD",
  openedAt:"2026-11-25T04:00:00.000Z",closedAt:"2026-11-25T05:00:00.000Z",
  signalAt:"2026-11-25T00:00:00.000Z",entryPrice:100000,exitPrice:88000,
  quantity:0.00024,entryFeeAud:0.02,exitFeeAud:0.02,pnlAud:-2.92,reason:"STOP"
 }];
 assert.equal(validateMtfPaperAccount(account),true);
 const blocked=processMtfPaperAccount(account,{markets:[candidate()],now:"2026-11-25T08:15:00.000Z"});
 assert.equal(blocked.openPosition,null);
 assert.equal(blocked.lastCandidateRanking.length,1);
 assert.equal(blocked.lastCandidateRanking[0].status,"BLOCKED_DAILY_LOSS_CAPACITY");
 assert.ok(blocked.lastCandidateRanking[0].riskBudgetAud<=0.08);
 assert.ok(blocked.lastCandidateRanking[0].estimatedNetStopLossAud<=blocked.lastCandidateRanking[0].riskBudgetAud+0.01);
 assert.equal(blocked.cashAud,97.08);
 assert.equal(blocked.lastProcessed.BTC,undefined);
 assert.equal(validateMtfPaperAccount(blocked),true);
});

test("opens a validated pullback reclaim candidate without weakening higher-timeframe gates",()=>{
 const a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate("BTC","2026-11-25T04:00:00.000Z",100000,"PULLBACK_RECLAIM")],now});
 assert.ok(a.openPosition);
 assert.equal(a.openPosition.entryModel,"PULLBACK_RECLAIM");
 assert.equal(a.openPosition.pair,"BTC/AUD");
 assert.equal(a.liveTradingEnabled,false);
});
test("rejects an entry flag when neither breakout nor pullback trigger is present",()=>{
 const invalid=candidate();
 invalid.signal.checks={...invalid.signal.checks,breakoutVotes:false,pullbackReclaim:false,entryTrigger:true};
 const a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[invalid],now});
 assert.equal(a.openPosition,null);
 assert.equal(a.cashAud,100);
 assert.deepEqual(a.lastProcessed,{});
});
test("trailing stop closes position and records net fees",()=>{let a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});const m={...candidate(),quote:{pair:"BTC/AUD",bid:a.openPosition.stopPrice*.9,ask:a.openPosition.stopPrice,last:a.openPosition.stopPrice,retrievedAt:"2026-11-25T09:00:00.000Z"}};a=processMtfPaperAccount(a,{markets:[m],now:"2026-11-25T09:00:00.000Z"});assert.equal(a.openPosition,null);assert.equal(a.closedTrades.length,1);assert.equal(a.closedTrades[0].reason,"TRAILING_STOP");assert.equal(validateMtfPaperAccount(a),true);assert.equal(a.liveTradingEnabled,false);});

test("open-position mark freshness becomes unavailable then stale without changing the last valuation",()=>{
 let a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 const initial={...a.openPosition};
 assert.equal(initial.markStatus,"CURRENT");
 assert.equal(initial.lastMarkAt,now);
 const unavailable=processMtfPaperAccount(a,{markets:[{coin:"BTC",pair:"BTC/AUD",quote:null,signal:null}],now:"2026-11-25T08:15:00.000Z"});
 assert.equal(unavailable.openPosition.markStatus,"UNAVAILABLE");
 assert.equal(unavailable.openPosition.lastMarkAt,now);
 assert.equal(unavailable.unrealizedPnlAud,a.unrealizedPnlAud);
 assert.equal(unavailable.equityAud,a.equityAud);
 assert.equal(unavailable.closedTrades.length,0);
 assert.equal(validateMtfPaperAccount(unavailable),true);
 const stale=processMtfPaperAccount(unavailable,{markets:[],now:"2026-11-25T08:30:00.000Z"});
 assert.equal(stale.openPosition.markStatus,"STALE");
 assert.equal(stale.openPosition.lastMarkAt,now);
 assert.equal(stale.unrealizedPnlAud,a.unrealizedPnlAud);
 assert.equal(stale.equityAud,a.equityAud);
 assert.equal(validateMtfPaperAccount(stale),true);
 const recovered=processMtfPaperAccount(stale,{markets:[candidate("BTC","2026-11-25T04:00:00.000Z",100000,"DONCHIAN_BREAKOUT","2026-11-25T08:45:00.000Z")],now:"2026-11-25T08:45:00.000Z"});
 assert.equal(recovered.openPosition.markStatus,"CURRENT");
 assert.equal(recovered.openPosition.lastMarkAt,"2026-11-25T08:45:00.000Z");
 assert.equal(recovered.liveTradingEnabled,false);
 assert.equal(recovered.paperOnly,true);
 assert.equal(validateMtfPaperAccount(recovered),true);
});

test("open paper positions remain within the completed four-hour signal freshness window",()=>{
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 assert.ok(opened.openPosition);
 const exactBoundary={...opened,openPosition:{...opened.openPosition,signalAt:"2026-11-24T20:00:00.000Z"}};
 assert.equal(validateMtfPaperAccount(exactBoundary),true);
 const tooOld={...opened,openPosition:{...opened.openPosition,signalAt:"2026-11-24T19:59:59.999Z"}};
 assert.throws(()=>validateMtfPaperAccount(tooOld),/position failed validation/);
});
test("rejects malformed or inconsistent persisted position mark metadata",()=>{
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 assert.throws(()=>validateMtfPaperAccount({...opened,openPosition:{...opened.openPosition,markStatus:"UNKNOWN"}}),/position failed validation/);
 assert.throws(()=>validateMtfPaperAccount({...opened,openPosition:{...opened.openPosition,markStatus:"STALE",lastMarkAt:undefined}}),/position failed validation/);
 assert.throws(()=>validateMtfPaperAccount({...opened,openPosition:{...opened.openPosition,lastMarkAt:"2026-11-25T09:00:00.000Z"}}),/position failed validation/);
});

test("legacy open positions acquire a conservative stale-mark timestamp when quotes are unavailable",()=>{
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 const legacy={...opened,openPosition:{...opened.openPosition}};
 delete legacy.openPosition.lastMarkAt;
 delete legacy.openPosition.markStatus;
 const stale=processMtfPaperAccount(legacy,{markets:[],now:"2026-11-25T08:30:00.000Z"});
 assert.equal(stale.openPosition.lastMarkAt,stale.openPosition.openedAt);
 assert.equal(stale.openPosition.markStatus,"STALE");
 assert.equal(validateMtfPaperAccount(stale),true);
});
test("trailing-stop high-water mark advances only on completed post-entry four-hour closes",()=>{
 let a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 const entryHigh=a.openPosition.highestPrice;
 const intrabar={...candidate(),history:{lastCompletedFourHourAt:"2026-11-25T04:00:00.000Z",lastCompletedFourHourClose:120000},
  quote:{pair:"BTC/AUD",bid:99900,ask:100000,last:120000,spreadBps:10,retrievedAt:"2026-11-25T08:30:00.000Z"}};
 a=processMtfPaperAccount(a,{markets:[intrabar],now:"2026-11-25T08:30:00.000Z"});
 assert.equal(a.openPosition.highestPrice,entryHigh);
 assert.equal(a.openPosition.trailingStop,entryHigh-2500);
 const completed={...intrabar,history:{lastCompletedFourHourAt:"2026-11-25T08:00:00.000Z",lastCompletedFourHourClose:104000},
  quote:{pair:"BTC/AUD",bid:102000,ask:102100,last:104000,spreadBps:9.8,retrievedAt:"2026-11-25T12:15:00.000Z"}};
 a=processMtfPaperAccount(a,{markets:[completed],now:"2026-11-25T12:15:00.000Z"});
 assert.equal(a.openPosition.highestPrice,104000);
 assert.equal(a.openPosition.trailingStop,101000);
});
test("rejects crossed exit quotes but still honours stops when a valid exit spread is wide",()=>{
 let a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 const p=a.openPosition;
 assert.ok(p);
 const crossedBid=p.stopPrice*.9, crossedAsk=p.stopPrice*.89;
 const crossed={...candidate(),quote:{pair:"BTC/AUD",bid:crossedBid,ask:crossedAsk,last:crossedBid,spreadBps:0,retrievedAt:"2026-11-25T08:15:00.000Z"}};
 const unchanged=processMtfPaperAccount(a,{markets:[crossed],now:"2026-11-25T08:15:00.000Z"});
 assert.ok(unchanged.openPosition);
 assert.equal(unchanged.cashAud,a.cashAud);
 assert.equal(unchanged.closedTrades.length,0);
 assert.equal(unchanged.equityAud,a.equityAud);
 const bid=p.stopPrice*.9,ask=p.stopPrice*1.02;
 const wide={...candidate(),quote:{pair:"BTC/AUD",bid,ask,last:(bid+ask)/2,spreadBps:(ask-bid)/((ask+bid)/2)*10000,retrievedAt:"2026-11-25T08:30:00.000Z"}};
 assert.ok(wide.quote.spreadBps>MTF_PAPER_CONFIG.maxSpreadBps);
 const closed=processMtfPaperAccount(unchanged,{markets:[wide],now:"2026-11-25T08:30:00.000Z"});
 assert.equal(closed.openPosition,null);
 assert.equal(closed.closedTrades.at(-1).reason,"TRAILING_STOP");
 assert.equal(closed.liveTradingEnabled,false);
 assert.equal(closed.paperOnly,true);
});
test("daily trend reversal closes an open paper position",()=>{let a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});const m={...candidate(),quote:{pair:"BTC/AUD",bid:101000,ask:101100,last:101000,retrievedAt:"2026-11-25T09:00:00.000Z"},signal:{...candidate().signal,status:"NO_TRADE",checks:{dailyTrend:false,fourHourTrend:true}}};a=processMtfPaperAccount(a,{markets:[m],now:"2026-11-25T09:00:00.000Z"});assert.equal(a.openPosition,null);assert.equal(a.closedTrades[0].reason,"TREND_REVERSAL");});
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
 a.closedTrades.push({id:"ETH-test",coin:"ETH",pair:"ETH/AUD",openedAt:"2026-11-25T06:00:00.000Z",closedAt:now,signalAt:"2026-11-25T02:00:00.000Z",entryPrice:2500,exitPrice:2215,quantity:0.01,entryFeeAud:0.03,exitFeeAud:0.02,pnlAud:-2.9,reason:"TRAILING_STOP",strategy:"EDGE_MTF_DONCHIAN_ENSEMBLE_V1"});
 a.dailyLossAud=2.9+Math.max(0,-a.unrealizedPnlAud);
 const p=a.openPosition;
 const bid=p.entryPrice-2000;
 const market={...candidate(),signalAt:p.signalAt,quote:{pair:"BTC/AUD",bid,ask:bid+10,last:bid,retrievedAt:"2026-11-25T09:00:00.000Z"}};
 a=processMtfPaperAccount(a,{markets:[market],now:"2026-11-25T09:00:00.000Z"});
 assert.equal(a.openPosition,null);
 assert.equal(a.closedTrades.at(-1).reason,"DAILY_LOSS_LIMIT");
 assert.ok(a.dailyLossAud>=MTF_PAPER_CONFIG.maxDailyLossAud);
 assert.equal(a.liveTradingEnabled,false);
});


test("rejects malformed MTF candidates with invalid ATR or crossed quotes",()=>{
 const base=candidate();
 const badAtr={...base,signal:{...base.signal,indicators:{...base.signal.indicators,atr20:0}}};
 const crossed={...candidate("ETH"),quote:{pair:"ETH/AUD",bid:101000,ask:100000,last:100500,retrievedAt:now}};
 const a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[badAtr,crossed],now});
 assert.equal(a.openPosition,null);
 assert.equal(a.cashAud,100);
 assert.equal(a.equityAud,100);
 assert.equal(a.liveTradingEnabled,false);
 assert.equal(validateMtfPaperAccount(a),true);
});

test("recomputes midpoint spread from bid/ask and rejects understated or inconsistent spread metadata",()=>{
 const understated=candidate();
 understated.quote.bid=99500;
 understated.quote.spreadBps=1;
 const inconsistent=candidate();
 inconsistent.quote.spreadBps=1;
 const a=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[understated,inconsistent],now});
 assert.equal(a.openPosition,null);
 assert.equal(a.cashAud,100);
 assert.deepEqual(a.lastProcessed,{});
 assert.equal(a.paperOnly,true);
 assert.equal(a.liveTradingEnabled,false);
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

test("rejects persisted positions with invalid cost, fee or timestamp accounting",()=>{
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 assert.ok(opened.openPosition);
 assert.throws(()=>validateMtfPaperAccount({...opened,openPosition:{...opened.openPosition,entryCost:NaN}}),/position failed validation/);
 assert.throws(()=>validateMtfPaperAccount({...opened,openPosition:{...opened.openPosition,entryFeeAud:-0.01}}),/position failed validation/);
 assert.throws(()=>validateMtfPaperAccount({...opened,openPosition:{...opened.openPosition,openedAt:"not-a-date"}}),/position failed validation/);
});

test("reconciles closed-trade P&L to modeled prices and fees and prevents realized-loss understatement",()=>{
 const trade={id:"BTC-test",coin:"BTC",pair:"BTC/AUD",openedAt:"2026-11-25T06:00:00.000Z",closedAt:now,
  signalAt:"2026-11-25T02:00:00.000Z",entryPrice:2500,exitPrice:2215,quantity:0.01,
  entryFeeAud:0.03,exitFeeAud:0.02,pnlAud:-2.9,reason:"TRAILING_STOP"};
 const base=createMtfPaperAccount(now);
 const valid={...base,cashAud:97.1,equityAud:97.1,realizedPnlAud:-2.9,dailyLossAud:2.9,closedTrades:[trade]};
 assert.equal(validateMtfPaperAccount(valid),true);
 assert.throws(()=>validateMtfPaperAccount({...valid,closedTrades:[{...trade,pnlAud:-1}]}),/ledger failed validation/);
 assert.throws(()=>validateMtfPaperAccount({...valid,dailyLossAud:0}),/ledger failed validation/);
 assert.throws(()=>validateMtfPaperAccount({...valid,day:"2026-11-26"}),/ledger failed validation/);
});

test("rejects closed trades with non-finite P&L or fee accounting before daily-loss calculation",()=>{
 const trade={coin:"BTC",pair:"BTC/AUD",openedAt:"2026-11-25T08:00:00.000Z",closedAt:"2026-11-25T09:00:00.000Z",
  signalAt:"2026-11-25T04:00:00.000Z",entryPrice:100000,exitPrice:99000,quantity:0.001,
  entryFeeAud:0.1,exitFeeAud:0.099,pnlAud:NaN,reason:"TRAILING_STOP"};
 assert.throws(()=>validateMtfPaperAccount({...createMtfPaperAccount(now),closedTrades:[trade]}),/ledger failed validation/);
 assert.throws(()=>validateMtfPaperAccount({...createMtfPaperAccount(now),closedTrades:[{...trade,pnlAud:-1,exitFeeAud:Infinity}]}),/ledger failed validation/);
});


test("reconciles cash basis and net liquidation equity before using stored risk",()=>{
 const base=createMtfPaperAccount(now);
 assert.throws(()=>validateMtfPaperAccount({...base,cashAud:99,equityAud:99}),/balance\/equity reconciliation/);
 assert.throws(()=>validateMtfPaperAccount({...base,equityAud:99}),/balance\/equity reconciliation/);
 assert.throws(()=>validateMtfPaperAccount({...base,unrealizedPnlAud:-1,equityAud:99}),/balance\/equity reconciliation/);

 const opened=processMtfPaperAccount(base,{markets:[candidate()],now});
 assert.ok(opened.openPosition);
 assert.equal(validateMtfPaperAccount(opened),true);
 assert.throws(()=>validateMtfPaperAccount({...opened,equityAud:opened.equityAud+1}),/balance\/equity reconciliation/);
 assert.throws(()=>validateMtfPaperAccount({...opened,cashAud:opened.cashAud+1,equityAud:opened.equityAud+1}),/balance\/equity reconciliation/);
});


test("UTC day rollover carries the last validated open-position loss while the quote is unavailable",()=>{
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 assert.ok(opened.openPosition);
 assert.ok(opened.unrealizedPnlAud<0);
 const expectedLoss=Math.round((Math.max(0,-opened.unrealizedPnlAud)+Number.EPSILON)*100)/100;
 const rolled=processMtfPaperAccount(opened,{markets:[],now:"2026-11-26T00:15:00.000Z"});
 assert.equal(rolled.day,"2026-11-26");
 assert.equal(rolled.openPosition.markStatus,"STALE");
 assert.equal(rolled.openPosition.lastMarkAt,opened.openPosition.lastMarkAt);
 assert.equal(rolled.unrealizedPnlAud,opened.unrealizedPnlAud);
 assert.equal(rolled.dailyLossAud,expectedLoss);
 assert.ok(rolled.dailyLossAud>0);
 assert.equal(validateMtfPaperAccount(rolled),true);
 assert.throws(()=>validateMtfPaperAccount({...rolled,dailyLossAud:0}),/ledger failed validation/);
});

test("rejects a backdated MTF paper scan without changing the supplied ledger",()=>{
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 const before=structuredClone(opened);
 assert.throws(()=>processMtfPaperAccount(opened,{markets:[],now:"2026-11-25T07:59:59.999Z"}),/cannot move backwards/);
 assert.deepEqual(opened,before);
});


test("migrates a legacy open-position ledger whose stored daily loss omitted its unrealized loss",()=>{
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 const legacy={...opened};
 delete legacy.riskAccountingVersion;
 legacy.dailyLossAud=0;
 assert.equal(validateMtfPaperAccount(legacy),true);
 const upgraded=processMtfPaperAccount(legacy,{markets:[],now:"2026-11-25T08:15:00.000Z"});
 assert.equal(upgraded.riskAccountingVersion,2);
 assert.ok(upgraded.dailyLossAud>=Math.max(0,-opened.unrealizedPnlAud));
 assert.equal(validateMtfPaperAccount(upgraded),true);
});


test("sync-warning scans block new MTF entries while preserving protective stop exits",()=>{
 const blocked=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now,allowNewEntries:false});
 assert.equal(blocked.openPosition,null);
 assert.equal(blocked.cashAud,100);
 assert.deepEqual(blocked.lastProcessed,{});
 assert.deepEqual(blocked.lastCandidateRanking,[]);

 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[candidate()],now});
 assert.ok(opened.openPosition);
 const stop=opened.openPosition.stopPrice;
 const stopped={...candidate(),quote:{
  pair:"BTC/AUD",bid:stop*.9,ask:stop,last:stop,
  spreadBps:(stop-stop*.9)/((stop+stop*.9)/2)*10000,
  retrievedAt:"2026-11-25T09:00:00.000Z"
 }};
 const closed=processMtfPaperAccount(opened,{markets:[stopped],now:"2026-11-25T09:00:00.000Z",allowNewEntries:false});
 assert.equal(closed.openPosition,null);
 assert.equal(closed.closedTrades.at(-1).reason,"TRAILING_STOP");
 assert.equal(closed.paperOnly,true);
 assert.equal(closed.liveTradingEnabled,false);
});
