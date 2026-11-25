// CoinSpot public V2 market-data normalization. No credentials and no order execution.
const finite = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
export function normalizeCoinSpotMarket({coin,latest,trades,retrievedAt=new Date().toISOString()}={}) {
  const symbol=String(coin||"").toUpperCase();
  if(!new Set(["BTC","ETH"]).has(symbol)) throw new TypeError("Unsupported CoinSpot AUD market.");
  if(latest?.status!=="ok"||trades?.status!=="ok"||!latest.prices||!Array.isArray(trades.orders)) throw new Error("CoinSpot public market response is invalid.");
  const bid=finite(latest.prices.bid),ask=finite(latest.prices.ask),last=finite(latest.prices.last);
  if(![bid,ask,last].every(Number.isFinite)||bid<=0||ask<bid||last<=0) throw new Error("CoinSpot bid/ask/last values are invalid.");
  const completed=trades.orders.filter(order=>order.market===symbol+"/AUD").map(order=>{
    const timestamp=Date.parse(order.solddate),price=finite(order.rate),amount=finite(order.amount),totalAud=finite(order.total);
    if(!Number.isFinite(timestamp)||price===null||price<=0||amount===null||amount<=0||totalAud===null||totalAud<=0) return null;
    return {timestamp:new Date(timestamp).toISOString(),price,amount,totalAud};
  }).filter(Boolean).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  return {coin:symbol,pair:symbol+"/AUD",bid,ask,last,spreadPct:Number(((ask-bid)/ask*100).toFixed(4)),completedTrades:completed.slice(-100),completedTradesCount:completed.length,source:"CoinSpot Public API V2",retrievedAt,dataClass:"live_public_quote_and_recent_completed_trades_not_ohlc"};
}
