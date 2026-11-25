// CoinSpot Read Only completed AUD market-order history -> native trade-derived OHLCV.
// Missing buckets are never filled; this data must pass strict contiguous-candle checks.
const ALLOWED = new Set(["BTC","ETH"]);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const finite = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function normalizeCoinSpotCompletedOrders({coin,payload}={}) {
  const symbol=String(coin||"").toUpperCase();
  if(!ALLOWED.has(symbol)) throw new Error("Only BTC/AUD and ETH/AUD history is enabled.");
  if(payload?.status!=="ok"||!Array.isArray(payload.buyorders)||!Array.isArray(payload.sellorders)) throw new Error("CoinSpot completed market-order response is malformed.");
  const rows=[...payload.buyorders,...payload.sellorders],seen=new Set(),trades=[];
  for(const row of rows){
    if(row?.market!==symbol+"/AUD") continue;
    const timestamp=Date.parse(row.solddate),price=finite(row.rate),amount=finite(row.amount),total=finite(row.total);
    if(!Number.isFinite(timestamp)||price===null||price<=0||amount===null||amount<=0||total===null||total<=0) continue;
    const key=[timestamp,price,amount,total].join("|");
    if(seen.has(key)) continue;
    seen.add(key);
    trades.push({timestamp,price,amount,totalAud:total});
  }
  trades.sort((a,b)=>a.timestamp-b.timestamp);
  return trades;
}

export function aggregateCoinSpotTrades(trades, intervalMs) {
  if(!Array.isArray(trades)||!Number.isInteger(intervalMs)||intervalMs<=0) throw new Error("Invalid CoinSpot trade aggregation inputs.");
  const buckets=new Map();
  for(const trade of trades){
    const timestamp=Number(trade.timestamp),price=finite(trade.price),amount=finite(trade.amount),total=finite(trade.totalAud);
    if(!Number.isFinite(timestamp)||price===null||price<=0||amount===null||amount<=0||total===null||total<=0) throw new Error("Invalid normalized CoinSpot trade.");
    const bucket=Math.floor(timestamp/intervalMs)*intervalMs;
    let bar=buckets.get(bucket);
    if(!bar){bar={timestamp:new Date(bucket).toISOString(),open:price,high:price,low:price,close:price,volume:0,quoteVolumeAud:0,tradeCount:0};buckets.set(bucket,bar);}
    bar.high=Math.max(bar.high,price);bar.low=Math.min(bar.low,price);bar.close=price;
    bar.volume+=amount;bar.quoteVolumeAud+=total;bar.tradeCount++;
  }
  return [...buckets.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)).map(bar=>({
    ...bar,volume:Number(bar.volume.toFixed(12)),quoteVolumeAud:Number(bar.quoteVolumeAud.toFixed(8))
  }));
}

export function mergeCoinSpotCandles(existing=[],incoming=[],maxBars=400) {
  if(!Array.isArray(existing)||!Array.isArray(incoming)||!Number.isInteger(maxBars)||maxBars<1) throw new Error("Invalid CoinSpot candle merge inputs.");
  const byTime=new Map();
  for(const candle of [...existing,...incoming]){
    if(!candle||!Number.isFinite(Date.parse(candle.timestamp))||![candle.open,candle.high,candle.low,candle.close,candle.volume].every(Number.isFinite)) throw new Error("Invalid CoinSpot candle in cache.");
    byTime.set(Date.parse(candle.timestamp),candle);
  }
  return [...byTime.entries()].sort((a,b)=>a[0]-b[0]).slice(-maxBars).map(([,candle])=>candle);
}

export const COINSPOT_INTERVALS={fourHour:4*HOUR,daily:DAY};
