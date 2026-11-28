// CoinSpot Read Only completed AUD market-order history -> native trade-derived OHLCV.
// Missing buckets are never filled; this data must pass strict contiguous-candle checks.
const ALLOWED = new Set(["BTC","ETH"]);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const COINSPOT_FOUR_HOUR_HISTORY_LIMIT = 720;
// CoinSpot fields are JSON numbers or decimal strings. Avoid JavaScript's
// broad Number() coercion, which would accept booleans and single-item arrays.
const finite = value => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};
export function coinSpotHistoryRangeParams(startMs, endMs, format = "date") {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs) {
    throw new Error("Invalid CoinSpot history date range.");
  }
  if (format === "date") {
    return {
      startdate: new Date(startMs).toISOString().slice(0, 10),
      enddate: new Date(endMs - 1).toISOString().slice(0, 10)
    };
  }
  if (format === "epoch") {
    return {
      startdate: Math.floor(startMs / 1000),
      enddate: Math.floor((endMs - 1) / 1000)
    };
  }
  if (format === "epoch-string") {
    return {
      startdate: String(Math.floor(startMs / 1000)),
      enddate: String(Math.floor((endMs - 1) / 1000))
    };
  }
  if (format === "epoch-ms") {
    return { startdate: startMs, enddate: endMs - 1 };
  }
  throw new Error("CoinSpot history date format must be date, epoch, epoch-string or epoch-ms.");
}


export function normalizeCoinSpotCompletedOrders({coin,payload}={}) {
  const symbol=String(coin||"").toUpperCase();
  if(!ALLOWED.has(symbol)) throw new Error("Only BTC/AUD and ETH/AUD history is enabled.");
  if(payload?.status!=="ok"||!Array.isArray(payload.buyorders)||!Array.isArray(payload.sellorders)) throw new Error("CoinSpot completed market-order response is malformed.");
  const rows=[...payload.buyorders,...payload.sellorders],seen=new Set(),trades=[];
  for(const row of rows){
    if(!row || typeof row !== "object" || Array.isArray(row) ||
        typeof row.market !== "string" || row.market.trim().length === 0) {
      throw new Error("COINSPOT_HISTORY_SCHEMA_MISMATCH: CoinSpot completed-order row is missing its market identity.");
    }
    if(row.market!==symbol+"/AUD") continue;
    const timestamp=Date.parse(row.solddate),price=finite(row.rate),amount=finite(row.amount),total=finite(row.total);
    if(typeof row.solddate !== "string" || !Number.isFinite(timestamp) ||
        price===null || price<=0 || amount===null || amount<=0 || total===null || total<=0) {
      throw new Error("COINSPOT_HISTORY_SCHEMA_MISMATCH: malformed "+symbol+"/AUD completed-order row.");
    }
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
    const timestamp=trade?.timestamp,price=finite(trade?.price),amount=finite(trade?.amount),total=finite(trade?.totalAud);
    if(!Number.isSafeInteger(timestamp)||timestamp<0||price===null||price<=0||amount===null||amount<=0||total===null||total<=0) throw new Error("Invalid normalized CoinSpot trade.");
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
