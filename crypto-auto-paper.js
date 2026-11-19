// EDGE automated crypto paper engine. Binance public market data only; never submits exchange orders.
export const AUTO_SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT","DOGEUSDT","ADAUSDT","LINKUSDT","AVAXUSDT","LTCUSDT"];
export const AUTO_CONFIG = Object.freeze({ startingCapital: 100, feeRate: .001, slippageBps: 15, spreadBps: 10, riskPct: .005, maxAllocationPct: 25, maxDailyLossPct: 2, stopAtr: 2.5, targetAtr: 5, maxHoldHours: 120 });
const round = n => Math.round((n + Number.EPSILON) * 10000) / 10000;
const roundQuantity = n => Math.floor(n * 1e8) / 1e8;
const finite = n => Number.isFinite(Number(n)) ? Number(n) : null;
function ema(values, period) { if(values.length<period)return null;const k=2/(period+1);let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;for(const x of values.slice(period))v=x*k+v*(1-k);return v; }
function rsi(values, period=14) { if(values.length<=period)return null;let up=0,down=0;for(let i=values.length-period;i<values.length;i++){const d=values[i]-values[i-1];if(d>0)up+=d;else down-=d;}return down===0?100:100-100/(1+up/down); }
function atr(bars, period=14) { if(bars.length<=period)return null;let sum=0;for(let i=bars.length-period;i<bars.length;i++){const p=bars[i-1].close,b=bars[i];sum+=Math.max(b.high-b.low,Math.abs(b.high-p),Math.abs(b.low-p));}return sum/period; }
function adx(bars,period=14){if(bars.length<period*2+2)return null;const dx=[];for(let end=bars.length-period+1;end<=bars.length;end++){let tr=0,plus=0,minus=0;for(let i=end-period;i<end;i++){const c=bars[i],p=bars[i-1];tr+=Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));const up=c.high-p.high,dn=p.low-c.low;if(up>dn&&up>0)plus+=up;if(dn>up&&dn>0)minus+=dn;}const pdi=tr?100*plus/tr:0,mdi=tr?100*minus/tr:0;dx.push(pdi+mdi?100*Math.abs(pdi-mdi)/(pdi+mdi):0);}return dx.reduce((s,x)=>s+x,0)/dx.length;}
export function evaluateAutoSignal(bars) {
 if(!Array.isArray(bars)||bars.length<220) return {signal:false,reason:"WARMUP_REQUIRED"};
 const last=bars.at(-1),closes=bars.map(x=>x.close),e20=ema(closes.slice(-100),20),e50=ema(closes.slice(-150),50),e200=ema(closes,200),momentum=rsi(closes),vol=atr(bars),strength=adx(bars);
 const macd=ema(closes,12)-ema(closes,26);
 const previousMacd=ema(closes.slice(0,-1),12)-ema(closes.slice(0,-1),26);
 const checks={trend:e20>e50&&e50>e200&&last.close>e20,rsi:momentum>=50&&momentum<=68,macd:macd>previousMacd,adx:strength>=18,atr:Number.isFinite(vol)&&vol>0};
 return {signal:Object.values(checks).every(Boolean),reason:Object.entries(checks).filter(([,v])=>!v).map(([k])=>k.toUpperCase()).join("_")||"TREND_FOLLOWING_CONFLUENCE",timestamp:last.timestamp,price:last.close,atr:vol,rsi:round(momentum),adx:round(strength),ema20:round(e20),ema50:round(e50),ema200:round(e200)};
}
export function createAutoPaperAccount(now=new Date().toISOString()){return {mode:"AUTOMATED_PAPER_ONLY",quoteCurrency:"USDT",startingCapital:100,cash:100,realizedPnl:0,openPosition:null,closedTrades:[],lastProcessed:{},dailyLoss:0,day:now.slice(0,10),equity:100,peakEquity:100,maxDrawdownPct:0,liveTradingEnabled:false,updatedAt:now};}
export function normalizeAutoPaperAccount(value,now=new Date().toISOString()){
 if(!value||value.mode!=="AUTOMATED_PAPER_ONLY"||value.quoteCurrency!=="USDT"||value.startingCapital!==100||value.liveTradingEnabled!==false||!Array.isArray(value.closedTrades)||!value.lastProcessed||typeof value.lastProcessed!=="object")return createAutoPaperAccount(now);
 const day=now.slice(0,10),dailyLoss=round(value.closedTrades.filter(t=>String(t.closedAt||"").slice(0,10)===day).reduce((s,t)=>s+Math.max(0,-Number(t.pnl||0)),0));
 return {...value,day,dailyLoss,updatedAt:now};
}
export function markAutoPaperAccount(account,{prices,now=new Date().toISOString()}={}){
 const a=normalizeAutoPaperAccount(account,now),p=a.openPosition,price=p?finite(prices?.[p.symbol]):null;
 if(p&&price>0){
  const mark=price*(1-(AUTO_CONFIG.slippageBps+AUTO_CONFIG.spreadBps/2)/10000),gross=p.quantity*mark,exitFee=gross*AUTO_CONFIG.feeRate;
  a.unrealizedPnl=round(gross-exitFee-p.entryCost);a.markPrice=price;
  const peak=Math.max(p.highestPrice||p.entryPrice,price);p.highestPrice=peak;p.trailingStop=Math.max(p.trailingStop||p.stopPrice,peak-AUTO_CONFIG.stopAtr*p.atr);
  const held=(Date.parse(now)-Date.parse(p.openedAt))/3600000;
  const reason=price<=p.trailingStop?"TRAILING_STOP":price>=p.targetPrice?"TAKE_PROFIT":held>=AUTO_CONFIG.maxHoldHours?"MAX_HOLD":null;
  if(reason){const exit=price*(1-(AUTO_CONFIG.slippageBps+AUTO_CONFIG.spreadBps/2)/10000),grossExit=p.quantity*exit,fee=grossExit*AUTO_CONFIG.feeRate,proceeds=grossExit-fee,pnl=proceeds-p.entryCost;
   a.cash=round(a.cash+proceeds);a.realizedPnl=round(a.realizedPnl+pnl);a.closedTrades.push({id:p.id,symbol:p.symbol,openedAt:p.openedAt,closedAt:now,entryPrice:p.entryPrice,exitPrice:round(exit),quantity:p.quantity,pnl:round(pnl),reason,entryFee:p.entryFee,exitFee:round(fee),strategy:p.strategy});a.closedTrades=a.closedTrades.slice(-200);a.openPosition=null;a.unrealizedPnl=0;a.dailyLoss=round(a.closedTrades.filter(t=>String(t.closedAt||"").slice(0,10)===now.slice(0,10)).reduce((s,t)=>s+Math.max(0,-Number(t.pnl||0)),0));
  }
 }
 a.equity=round(a.cash+(a.openPosition?a.openPosition.quantity*(a.markPrice||a.openPosition.entryPrice):0));a.peakEquity=Math.max(a.peakEquity||100,a.equity);a.maxDrawdownPct=round(Math.max(a.maxDrawdownPct||0,(a.peakEquity-a.equity)/a.peakEquity*100));a.updatedAt=now;return a;
}
export function processAutoPaperSignals(account,{signals,prices,now=new Date().toISOString()}={}){
 let a=markAutoPaperAccount(normalizeAutoPaperAccount(account,now),{prices,now});
 if(a.day!==now.slice(0,10)){a.day=now.slice(0,10);a.dailyLoss=0;}
 const candidates=Object.entries(signals||{}).filter(([symbol,s])=>AUTO_SYMBOLS.includes(symbol)&&s?.signal&&s.timestamp&&s.atr>0&&s.timestamp!==a.lastProcessed[symbol]).sort((x,y)=>(y[1].adx||0)-(x[1].adx||0));
 for(const [symbol,s] of candidates)a.lastProcessed[symbol]=s.timestamp;
 if(a.openPosition||a.dailyLoss>=a.startingCapital*AUTO_CONFIG.maxDailyLossPct/100)return a;
 for(const [symbol,s] of candidates){
  a.lastProcessed[symbol]=s.timestamp;
  const price=finite(prices?.[symbol]);if(!(price>0))continue;
  const entry=price*(1+(AUTO_CONFIG.slippageBps+AUTO_CONFIG.spreadBps/2)/10000),stop=entry-AUTO_CONFIG.stopAtr*s.atr,target=entry+AUTO_CONFIG.targetAtr*s.atr;
  const equity=a.equity||a.cash+a.realizedPnl,riskBudget=equity*AUTO_CONFIG.riskPct,allocation=Math.min(equity*AUTO_CONFIG.maxAllocationPct/100,a.cash),quantity=roundQuantity(Math.min(riskBudget/(entry-stop),allocation/(entry*(1+AUTO_CONFIG.feeRate))));
  const entryFee=quantity*entry*AUTO_CONFIG.feeRate,entryCost=quantity*entry+entryFee;
  if(quantity<=0||entryCost<5||entryCost>a.cash)continue;
  a.cash=round(a.cash-entryCost);a.openPosition={id:symbol+"-"+s.timestamp,symbol,openedAt:now,signalAt:s.timestamp,entryPrice:round(entry),quantity:roundQuantity(quantity),entryFee:round(entryFee),entryCost:round(entryCost),stopPrice:round(stop),trailingStop:round(stop),targetPrice:round(target),atr:s.atr,highestPrice:entry,strategy:"TREND_FOLLOWING_1H_V1",status:"OPEN_PAPER_ONLY"};a.lastProcessed[symbol]=s.timestamp;break;
 }
 a.equity=round(a.cash+(a.openPosition?a.openPosition.quantity*(prices?.[a.openPosition.symbol]||a.openPosition.entryPrice):0));a.peakEquity=Math.max(a.peakEquity||100,a.equity);a.maxDrawdownPct=round(Math.max(a.maxDrawdownPct||0,(a.peakEquity-a.equity)/a.peakEquity*100));a.updatedAt=now;return a;
}
