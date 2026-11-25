// EDGE crypto spot research engine. Simulation only; never signs or submits exchange orders.
export const CRYPTO_STARTING_CAPITAL_AUD=100, CRYPTO_MAX_DEPLOYED_AUD=50, CRYPTO_RISK_PER_TRADE_PCT=.01, CRYPTO_MAX_DAILY_LOSS_AUD=3, CRYPTO_MAX_OPEN_POSITIONS=1;
const n=v=>v===null||v===undefined||v===""?null:Number.isFinite(Number(v))?Number(v):null, r2=v=>Math.round((v+Number.EPSILON)*100)/100;
export function parseKrakenOhlc(payload,{pair="XBTAUD",retrievedAt=new Date().toISOString(),now=Date.now(),maxAgeMs=90*60_000}={}){
 if(!payload||!Array.isArray(payload.error)||payload.error.length)throw Error("Kraken returned an API error.");
 const result=payload.result;if(!result||typeof result!=="object"||Array.isArray(result))throw Error("Kraken OHLC response is malformed.");
 const key=Object.keys(result).find(k=>k!=="last"&&Array.isArray(result[k]));if(!key)throw Error("Kraken returned no OHLC series.");
 const raw=result[key];if(raw.length<61||raw.length>721)throw Error("At least 60 completed hourly candles are required.");
 const candles=raw.slice(0,-1).map(row=>{if(!Array.isArray(row)||row.length<7)throw Error("Malformed Kraken candle.");
 const timestamp=Number(row[0])*1000,open=n(row[1]),high=n(row[2]),low=n(row[3]),close=n(row[4]),volume=n(row[6]);
 if(!Number.isFinite(timestamp)||timestamp>now||![open,high,low,close,volume].every(Number.isFinite)||Math.min(open,high,low,close)<=0||high<Math.max(open,close)||low>Math.min(open,close)||low>high||volume<0)throw Error("Kraken candle failed OHLCV validation.");
 return {timestamp:new Date(timestamp).toISOString(),open,high,low,close,volume};}).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
 for(let i=1;i<candles.length;i++)if(candles[i].timestamp===candles[i-1].timestamp)throw Error("Duplicate Kraken candles.");
 if(now-Date.parse(candles.at(-1).timestamp)>maxAgeMs)throw Error("Kraken hourly market data is stale.");
 return {source:"Kraken public Spot API",pair,quoteCurrency:"AUD",intervalMinutes:60,retrievedAt,observedAt:candles.at(-1).timestamp,candles,dataClass:"public_exchange_market_data_not_execution"};
}
function ema(v,p){if(v.length<p)return null;const a=2/(p+1);let x=v.slice(0,p).reduce((s,z)=>s+z,0)/p;for(const z of v.slice(p))x=z*a+x*(1-a);return x;}
function atr(c,p=14){if(c.length<p+1)return null;return c.slice(-p).reduce((s,x,i)=>{const prev=c[c.length-p-1+i].close;return s+Math.max(x.high-x.low,Math.abs(x.high-prev),Math.abs(x.low-prev));},0)/p;}
function rsi(v,p=14){if(v.length<p+1)return null;let g=0,l=0;for(let i=v.length-p;i<v.length;i++){const d=v[i]-v[i-1];if(d>0)g+=d;else l-=d;}return l===0?100:100-100/(1+g/l);}
export function evaluateCryptoSpotSetup({marketData,equityAud=100,cashAud=equityAud,dailyLossAud=0,feeRate=.001,slippageBps=15,now=Date.now()}={}){
 const reject=reason=>({status:"REJECTED",simulatedOnly:true,executable:false,reason});
 if(!marketData||marketData.quoteCurrency!=="AUD"||marketData.dataClass!=="public_exchange_market_data_not_execution"||!Array.isArray(marketData.candles)||marketData.candles.length<60)return reject("Validated AUD-quoted Kraken spot candles are required.");
 if(!Number.isFinite(Date.parse(marketData.observedAt))||Date.parse(marketData.observedAt)>now+60_000||now-Date.parse(marketData.observedAt)>90*60_000)return reject("Market data is stale or future-dated.");
 if(![equityAud,cashAud,dailyLossAud,feeRate,slippageBps].every(Number.isFinite)||equityAud<=0||cashAud<0||cashAud>equityAud||dailyLossAud<0||feeRate<0||slippageBps<0)return reject("Portfolio or cost inputs are invalid.");
 if(dailyLossAud>=3)return reject("Daily loss limit reached; trading is paused.");
 const c=marketData.candles,v=c.map(x=>x.close),last=v.at(-1),fast=ema(v.slice(-100),20),slow=ema(v.slice(-100),50),vol=atr(c),momentum=rsi(v);
 if(![fast,slow,vol,momentum].every(Number.isFinite)||vol<=0)return reject("Insufficient valid indicator history.");
 if(!(fast>slow&&last>fast&&momentum>=50&&momentum<=70))return {status:"NO_SIGNAL",simulatedOnly:true,executable:false,reason:"Hourly trend and momentum filters are not aligned.",indicators:{ema20:r2(fast),ema50:r2(slow),rsi14:r2(momentum)}};
 const stop=last-2*vol,target=last+3*vol;if(stop<=0||target<=last)return reject("Invalid volatility stop or target.");
 const spend=Math.min(50,Math.max(0,cashAud-50)),risk=Math.min(equityAud*.01,3-dailyLossAud),qty=Math.min(spend/last,risk/(last-stop)),notional=qty*last,feeIn=notional*feeRate,slipIn=notional*slippageBps/10000,feeOut=qty*target*feeRate,slipOut=qty*target*slippageBps/10000;
 const netTarget=qty*target-notional-feeIn-feeOut-slipIn-slipOut,stopLoss=notional-qty*stop+feeIn+qty*stop*feeRate+slipIn+qty*stop*slippageBps/10000;
 if(notional<10||notional+feeIn+slipIn>spend)return reject("Trade size is too small or breaches the $50 allocation cap.");
 if(netTarget<=0||stopLoss<=0||netTarget<2*stopLoss)return reject("Estimated fees and slippage reduce reward/risk below 2:1.");
 return {status:"PAPER_CANDIDATE",strategy:"CRYPTO_HOURLY_TREND_V1",simulatedOnly:true,executable:false,pair:marketData.pair,source:marketData.source,observedAt:marketData.observedAt,entryReference:r2(last),stopPrice:r2(stop),targetPrice:r2(target),quantity:qty,notionalAud:r2(notional),riskBudgetAud:r2(risk),estimatedRoundTripCostsAud:r2(feeIn+feeOut+slipIn+slipOut),estimatedNetTargetProfitAud:r2(netTarget),estimatedNetStopLossAud:r2(stopLoss),indicators:{ema20:r2(fast),ema50:r2(slow),rsi14:r2(momentum),atr14:r2(vol)},limits:{maxCapitalAud:100,maxDeployedAud:50,maxDailyLossAud:3,leverage:false},reason:"Research candidate only; not an order or a prediction of profit."};
}
export function createCryptoPaperAccount({capitalAud=100}={}){if(!Number.isFinite(capitalAud)||capitalAud!==100)throw TypeError("Initial crypto paper capital is fixed at AUD 100.");return {mode:"CRYPTO_PAPER_ONLY",currency:"AUD",startingCapitalAud:100,cashAud:100,positions:[],closedTrades:[],dailyLossAud:0,liveTradingEnabled:false};}
