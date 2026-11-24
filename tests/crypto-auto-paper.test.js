import test from "node:test";
import assert from "node:assert/strict";
import {AUTO_SYMBOLS,createAutoPaperAccount,evaluateAutoSignal,processAutoPaperSignals,markAutoPaperAccount,normalizeAutoPaperAccount,validateAutoPaperAccount} from "../crypto-auto-paper.js";
const bars=Array.from({length:300},(_,i)=>{const close=100+i*.25+Math.sin(i/7)*.2;return {timestamp:new Date(Date.UTC(2026,0,1,i)).toISOString(),open:close-.1,high:close+.4,low:close-.4,close,volume:1000};});
test("automated universe is diversified and paper-only",()=>{assert.ok(AUTO_SYMBOLS.length>=10);assert.equal(createAutoPaperAccount().liveTradingEnabled,false);});
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
