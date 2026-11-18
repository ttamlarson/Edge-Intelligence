// Persistent CoinSpot paper account. No live orders, credentials or withdrawal capability.
export const PAPER_CAPITAL_AUD=100, PAPER_MAX_DEPLOYED_AUD=50, PAPER_MAX_DAILY_LOSS_AUD=3, PAPER_FEE_RATE=.001, PAPER_SLIPPAGE_BPS=15;
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const validCoin=c=>new Set(["BTC","ETH"]).has(String(c||"").toUpperCase());
export function createCoinSpotPaperAccount(now=new Date().toISOString()){return {mode:"COINSPOT_PAPER_ONLY",currency:"AUD",startingCapitalAud:100,cashAud:100,realizedPnlAud:0,dailyLossAud:0,day:now.slice(0,10),openPosition:null,closedTrades:[],liveTradingEnabled:false,updatedAt:now};}
export function normalizePaperAccount(a,now=new Date().toISOString()){
 if(!a||a.mode!=="COINSPOT_PAPER_ONLY"||a.currency!=="AUD"||a.startingCapitalAud!==100||a.liveTradingEnabled!==false||!Array.isArray(a.closedTrades))return createCoinSpotPaperAccount(now);
 const day=now.slice(0,10),dailyLoss=a.closedTrades.filter(t=>String(t.closedAt||"").slice(0,10)===day).reduce((s,t)=>s+Math.max(0,-Number(t.pnlAud||0)),0);
 return {...a,dailyLossAud:round(dailyLoss),day,updatedAt:now};
}
export function openCoinSpotPaperPosition(account,{coin,ask,now=new Date().toISOString()}={}){
 const a=normalizePaperAccount(account,now),symbol=String(coin||"").toUpperCase(),price=Number(ask);
 if(!validCoin(symbol)||!Number.isFinite(price)||price<=0)throw Error("Valid BTC or ETH AUD ask price is required.");
 if(a.openPosition)throw Error("Only one open paper position is allowed.");
 if(a.dailyLossAud>=3)throw Error("Daily loss limit reached; paper trading is paused.");
 const spend=Math.min(50,a.cashAud-50);
 if(spend<10)throw Error("Insufficient cash; at least AUD 50 must remain unallocated.");
 const entryPrice=price*(1+PAPER_SLIPPAGE_BPS/10000),fee=spend*PAPER_FEE_RATE,quantity=(spend-fee)/entryPrice;
 a.cashAud=round(a.cashAud-spend);a.openPosition={id:cryptoRandomId(),coin:symbol,pair:symbol+"/AUD",openedAt:now,referenceAsk:price,entryPrice,quantity,notionalAud:spend-fee,entryFeeAud:fee,stopPrice:entryPrice*.98,targetPrice:entryPrice*1.03,status:"OPEN_PAPER_ONLY"};a.updatedAt=now;
 return a;
}
function cryptoRandomId(){const b=new Uint8Array(12);crypto.getRandomValues(b);return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");}
export function closeCoinSpotPaperPosition(account,{bid,now=new Date().toISOString(),reason="MANUAL_PAPER_CLOSE"}={}){
 const a=normalizePaperAccount(account,now),p=a.openPosition,price=Number(bid);
 if(!p)throw Error("There is no open paper position.");
 if(!Number.isFinite(price)||price<=0)throw Error("Valid CoinSpot bid price is required.");
 const exitPrice=price*(1-PAPER_SLIPPAGE_BPS/10000),gross=p.quantity*exitPrice,exitFee=gross*PAPER_FEE_RATE,proceeds=gross-exitFee,pnl=proceeds-p.notionalAud-p.entryFeeAud;
 const trade={...p,closedAt:now,referenceBid:price,exitPrice,exitFeeAud:round(exitFee),proceedsAud:round(proceeds),pnlAud:round(pnl),reason,status:"CLOSED_PAPER_ONLY"};
 a.cashAud=round(a.cashAud+proceeds);a.realizedPnlAud=round(a.realizedPnlAud+pnl);a.closedTrades=[...a.closedTrades,trade].slice(-100);a.openPosition=null;
 a.dailyLossAud=round(a.closedTrades.filter(t=>String(t.closedAt).slice(0,10)===now.slice(0,10)).reduce((sum,t)=>sum+Math.max(0,-t.pnlAud),0));a.updatedAt=now;
 return a;
}
export function markCoinSpotPaperAccount(account,{bid,now=new Date().toISOString()}={}){
 const a=normalizePaperAccount(account,now),p=a.openPosition;if(!p)return {...a,unrealizedPnlAud:0,equityAud:round(a.cashAud+a.realizedPnlAud)};
 const price=Number(bid);if(!Number.isFinite(price)||price<=0)throw Error("Valid CoinSpot bid price is required.");
 const mark=price*(1-PAPER_SLIPPAGE_BPS/10000),gross=p.quantity*mark,fee=gross*PAPER_FEE_RATE,unrealized=gross-fee-p.notionalAud-p.entryFeeAud;
 return {...a,unrealizedPnlAud:round(unrealized),equityAud:round(a.cashAud+gross-fee),markPrice:price};
}
