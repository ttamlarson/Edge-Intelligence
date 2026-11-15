import test from "node:test";
import assert from "node:assert/strict";
import { createPaperPortfolio, closePaperPosition, markPaperPosition, parseAsxDailyCsv } from "../autonomous-engine.js";
test("CSV parser groups valid daily bars by ticker",()=>{
 const result=parseAsxDailyCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,41,39,40.5\nCBA,2026-11-12,170,172,169,171");
 assert.equal(result.valid,true);assert.deepEqual(result.symbols,["BHP","CBA"]);assert.equal(result.rows,2);
});
test("CSV parser rejects malformed OHLC and duplicate sessions",()=>{
 assert.equal(parseAsxDailyCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,39,39,40").valid,false);
 assert.equal(parseAsxDailyCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,41,39,40\nBHP,2026-11-12,40,41,39,40").valid,false);
});
test("paper exit returns proceeds net of estimated fees and records P&L",()=>{
 const portfolio={...createPaperPortfolio(),cashAud:394.4,positions:[{id:"p1",symbol:"BHP",shares:10,entryPrice:10,stopPrice:9,targetPrice:12,entryCostsAud:5.6,debitAud:105.6,status:"OPEN_PAPER"}]};
 const result=closePaperPosition(portfolio,"p1",11,{closedAt:"2026-11-15T00:00:00.000Z"});
 assert.equal(result.accepted,true);assert.equal(result.trade.status,"CLOSED_PAPER");
 // Default exit cost is AUD 5 minimum commission + GST + 10 bps slippage = AUD 5.61.
 assert.equal(result.portfolio.cashAud,498.79);assert.equal(result.trade.profitLossAud,-1.21);assert.equal(result.portfolio.closedTrades.length,1);
});
test("paper marks include estimated exit costs and do not mutate position",()=>{
 const position={id:"p1",symbol:"BHP",shares:10,entryPrice:10,stopPrice:9,targetPrice:12,entryCostsAud:5.6,debitAud:105.6,status:"OPEN_PAPER"};
 const mark=markPaperPosition(position,11);assert.equal(mark.unrealizedProfitLossAud,-1.21);assert.equal(position.lastMarkPrice,undefined);
});
