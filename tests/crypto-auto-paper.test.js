import test from "node:test";
import assert from "node:assert/strict";
import {AUTO_SYMBOLS,createAutoPaperAccount,evaluateAutoSignal,processAutoPaperSignals,markAutoPaperAccount,normalizeAutoPaperAccount,validateAutoPaperAccount,rankAutoPaperCandidates,calculateAutoPaperPerformance} from "../crypto-auto-paper.js";
const bars=Array.from({length:300},(_,i)=>{const close=100+i*.25+Math.sin(i/7)*.2;return {timestamp:new Date(Date.UTC(2026,0,1,i)).toISOString(),open:close-.1,high:close+.4,low:close-.4,close,volume:1000};});
test("automated universe is diversified and paper-only",()=>{assert.ok(AUTO_SYMBOLS.length>=10);assert.equal(createAutoPaperAccount().liveTradingEnabled,false);assert.equal(createAutoPaperAccount().paperOnly,true);});
test("signal engine requires warmup and validates trend filters",()=>{assert.equal(evaluateAutoSignal(bars.slice(0,100)).reason,"WARMUP_REQUIRED");const s=evaluateAutoSignal(bars);assert.equal(typeof s.signal,"boolean");assert.ok(s.atr>0);});
test("opens only one risk-sized simulated position and never uses live execution",()=>{const now="2026-11-19T08:00:00.000Z",a=createAutoPaperAccount(now),s={signal:true,timestamp:bars.at(-1).timestamp,atr:2,adx:30};const n=processAutoPaperSignals(a,{signals:{BTCUSDT:s,ETHUSDT:{...s,adx:20}},prices:{BTCUSDT:175,ETHUSDT:3500},now});assert.ok(n.openPosition);assert.equal(n.openPosition.symbol,"BTCUSDT");assert.equal(n.liveTradingEnabled,false);assert.ok(n.cash>=74);assert.ok(n.openPosition.entryCost<=25);});
test("deduplicates already processed hourly signals",()=>{const now="2026-11-19T08:00:00.000Z",s={signal:true,timestamp:bars.at(-1).timestamp,atr:2,adx:30};let a=processAutoPaperSignals(createAutoPaperAccount(now),{signals:{BTCUSDT:s},prices:{BTCUSDT:175},now});a=markAutoPaperAccount(a,{prices:{BTCUSDT:175},now});a.openPosition=null;a.cash=100;a.equity=100;const b=processAutoPaperSignals(a,{signals:{BTCUSDT:s},prices:{BTCUSDT:175},now});assert.equal(b.openPosition,null);});
test("trailing stop closes paper position and records net fees",()=>{const now="2026-11-19T08:00:00.000Z",s={signal:true,timestamp:bars.at(-1).timestamp,atr:2,adx:30};let a=processAutoPaperSignals(createAutoPaperAccount(now),{signals:{BTCUSDT:s},prices:{BTCUSDT:175},now});const p=a.openPosition;assert.ok(p);a=markAutoPaperAccount(a,{prices:{BTCUSDT:p.stopPrice*.95},now:"2026-11-19T09:00:00.000Z"});assert.equal(a.openPosition,null);assert.equal(a.closedTrades.length,1);assert.equal(a.closedTrades[0].reason,"TRAILING_STOP");assert.equal(a.liveTradingEnabled,false);});
test("daily loss circuit breaker prevents a new entry",()=>{const now="2026-11-19T08:00:00.000Z",a=createAutoPaperAccount(now);a.closedTrades=[{closedAt:now,pnl:-3}];a.openPosition=null;const s={signal:true,timestamp:bars.at(-1).timestamp,atr:2,adx:30};const n=processAutoPaperSignals(a,{signals:{BTCUSDT:s},prices:{BTCUSDT:175},now});assert.equal(n.openPosition,null);});

test("marks open-position equity net of exit fees, spread and slippage",()=>{const now="2026-11-19T08:00:00.000Z",s={signal:true,timestamp:bars.at(-1).timestamp,atr:2,adx:30};const a=processAutoPaperSignals(createAutoPaperAccount(now),{signals:{BTCUSDT:s},prices:{BTCUSDT:175},now});const p=a.openPosition;const marked=markAutoPaperAccount(a,{prices:{BTCUSDT:175},now});assert.ok(marked.equity<a.cash+p.quantity*175);});

test("reports every failed entry gate with observed values and requirements",()=>{
 const s=evaluateAutoSignal(bars);
 assert.ok(s.checks && s.failedChecks);
 for(const key of ["trend","rsi","macd","adx","atr"]){assert.equal(typeof s.checks[key].passed,"boolean");assert.ok("value" in s.checks[key]);assert.ok(s.checks[key].required);}
 assert.deepEqual(s.failedChecks,Object.entries(s.checks).filter(([,v])=>!v.passed).map(([k])=>k.toUpperCase()));
 assert.equal(s.signal,s.failedChecks.length===0);
});
test("warmup diagnostic explains the missing candle count",()=>{
 const s=evaluateAutoSignal(bars.slice(0,100));
 assert.equal(s.checks.warmup.passed,false);assert.equal(s.checks.warmup.value,100);assert.equal(s.checks.warmup.required,220);
});

test("stored paper ledger validation rejects corrupt state instead of resetting capital or history",()=>{
 const valid=createAutoPaperAccount("2026-11-25T00:00:00.000Z");
 assert.equal(validateAutoPaperAccount(valid),true);
 assert.throws(()=>normalizeAutoPaperAccount({...valid,cash:-1},"2026-11-25T01:00:00.000Z"),/failed validation/);
 assert.throws(()=>normalizeAutoPaperAccount({...valid,closedTrades:[{closedAt:"invalid",pnl:-4}]},"2026-11-25T01:00:00.000Z"),/failed validation/);
 assert.throws(()=>normalizeAutoPaperAccount({...valid,liveTradingEnabled:true},"2026-11-25T01:00:00.000Z"),/failed validation/);
});

test("legacy crypto paper ledgers gain an additive paper-only marker without resetting history",()=>{
 const now="2026-11-26T08:00:00.000Z",legacy=createAutoPaperAccount(now);
 delete legacy.paperOnly;legacy.cash=83.25;legacy.closedTrades=[{closedAt:now,pnl:-1.5,symbol:"BTCUSDT"}];
 const migrated=normalizeAutoPaperAccount(legacy,now);
 assert.equal(migrated.paperOnly,true);assert.equal(migrated.cash,83.25);assert.equal(migrated.closedTrades.length,1);assert.equal(migrated.closedTrades[0].pnl,-1.5);
 assert.throws(()=>normalizeAutoPaperAccount({...migrated,paperOnly:false},now),/paper-only safety flags/i);
});

test("crypto candidate ranking uses fee-aware net reward/risk before ADX strength",()=>{
 const now="2026-11-26T08:00:00.000Z",a=createAutoPaperAccount(now);
 const signals={
  BTCUSDT:{signal:true,timestamp:bars.at(-1).timestamp,atr:2,adx:20,rsi:55},
  ETHUSDT:{signal:true,timestamp:bars.at(-1).timestamp,atr:1,adx:55,rsi:60}
 };
 const ranked=rankAutoPaperCandidates(signals,{BTCUSDT:175,ETHUSDT:175},a);
 assert.equal(ranked.length,2);assert.equal(ranked[0].symbol,"BTCUSDT");
 assert.ok(ranked[0].rewardRiskAfterCosts>ranked[1].rewardRiskAfterCosts);
 assert.equal(ranked[0].rank,1);
 assert.match(ranked[0].rankingMethod,/AFTER_FEES_AND_SPREAD_SLIPPAGE/);
});

test("paper entry sizing includes modeled exit fees and stays inside remaining daily risk",()=>{
 const now="2026-11-26T08:00:00.000Z",s={signal:true,timestamp:bars.at(-1).timestamp,atr:2,adx:30};
 const a=processAutoPaperSignals(createAutoPaperAccount(now),{signals:{BTCUSDT:s},prices:{BTCUSDT:175},now});
 assert.ok(a.openPosition);
 assert.ok(a.openPosition.estimatedNetStopLossQuote<=a.openPosition.riskBudgetQuote);
 assert.ok(a.openPosition.riskBudgetQuote<=0.5);
 assert.ok(a.openPosition.entryCost<=25);
 assert.equal(a.paperOnly,true);assert.equal(a.liveTradingEnabled,false);
});

test("a missing candidate price is not consumed and can be retried with the same candle",()=>{
 const now="2026-11-26T08:00:00.000Z",s={signal:true,timestamp:bars.at(-1).timestamp,atr:2,adx:30};
 const first=processAutoPaperSignals(createAutoPaperAccount(now),{signals:{BTCUSDT:s},prices:{},now});
 assert.equal(first.openPosition,null);assert.equal(first.lastProcessed.BTCUSDT,undefined);
 const second=processAutoPaperSignals(first,{signals:{BTCUSDT:s},prices:{BTCUSDT:175},now});
 assert.equal(second.openPosition.symbol,"BTCUSDT");
});

test("paper-trade feedback reports net outcomes, fees and insufficient-sample status",()=>{
 const now="2026-11-26T08:00:00.000Z",a=createAutoPaperAccount(now);
 a.closedTrades=[
  {closedAt:"2026-11-25T08:00:00.000Z",symbol:"BTCUSDT",pnl:2,entryFee:.1,exitFee:.1},
  {closedAt:"2026-11-26T07:00:00.000Z",symbol:"ETHUSDT",pnl:-1,entryFee:.1,exitFee:.1}
 ];
 const p=calculateAutoPaperPerformance(a);
 assert.equal(p.tradeCount,2);assert.equal(p.netPnlQuote,1);assert.equal(p.winRatePct,50);
 assert.equal(p.profitFactor,2);assert.equal(p.estimatedFeesQuote,.4);
 assert.equal(p.status,"INSUFFICIENT_SAMPLE");assert.equal(p.assessment,"NOT_PROVEN");
 assert.equal(p.bySymbol.BTCUSDT.netPnlQuote,2);
});
