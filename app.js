import { normalizeMarket, formatMoney, formatDateTime, brierScore, paperSettlement, VALID_TIME_ZONES, normalizeForecasts, toggleWatchlist, validateAlertRules } from "./domain.js";
import { createPaperPortfolio, calculatePaperPortfolioEquity, evaluateAsxSwingSetup, openPaperPosition, closePaperPosition, markPaperPosition, recordPaperMark, updatePaperMarksFromBars, parseAsxDailyCsv } from "./autonomous-engine.js";
import { backtestCoinSpotTrend, walkForwardCoinSpotTrend } from "./coinspot-strategy.js";
import { backtestAdaptiveRegime } from "./adaptive-regime-strategy.js";
import { backtestRegimeAdaptiveBreakout } from "./regime-adaptive-breakout.js";
import { backtestTrendFollowingIndicators } from "./trend-following-indicators.js";
import { buildCryptoStrategyComparison } from "./crypto-strategy-comparison.js";
import { parseBinanceKlineCsv, parseBinanceUsdtSymbols } from "./crypto-csv.js";
import { walkForwardAsxStrategy } from "./asx-walk-forward.js";
const $ = id => document.getElementById(id);
const STORE = "edge-intelligence-v1";
const demoMarkets = [
 {id:"d1",title:"Will the RBA cut rates at its next meeting?",platform:"demo",yes:34,volume:482000,category:"Economics",estimated:43,edge:9},
 {id:"d2",title:"Will Bitcoin reach $120,000 by December 31?",platform:"demo",yes:28,volume:1250000,category:"Crypto",estimated:35,edge:7},
 {id:"d3",title:"Will the US government pass a funding bill this month?",platform:"demo",yes:71,volume:830000,category:"Politics",estimated:67,edge:-4},
 {id:"d4",title:"Will global temperatures set a new annual record?",platform:"demo",yes:58,volume:210000,category:"Climate",estimated:64,edge:6}
];
const venues = [
 ["Polymarket","polymarket","Prediction.com venue listing; API entitlement and Australian jurisdiction are unverified"],
 ["Kalshi","kalshi","Prediction.com venue listing; API entitlement and Australian jurisdiction are unverified"],
 ["Manifold","manifold","Public API; play-money venue"],
 ["PredictIt","predictit","Aggregator or venue availability and Australian eligibility are unverified"],
 ["Opinion","opinion","Aggregator or venue availability and Australian eligibility are unverified"],
 ["Predict.fun","predictfun","Aggregator or venue availability and Australian eligibility are unverified"],
 ["Novig","novig","Aggregator or venue availability and Australian eligibility are unverified"],
 ["ProphetX","prophetx","Aggregator or venue availability and Australian eligibility are unverified"],
 ["Limitless","limitless","No verified integration configured"],
 ["Metaculus","metaculus","No verified integration configured"],
];
let state = loadState();
const cryptoResearchReports = new Map();
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const initialTimeZone = VALID_TIME_ZONES.includes(state.timeZone) ? state.timeZone : VALID_TIME_ZONES.includes(browserTimeZone) ? browserTimeZone : "Australia/Sydney";
if ($("auTimezone")) $("auTimezone").value = initialTimeZone;
let markets = demoMarkets.slice();
let nextMarketCursor = null;
let selectedImage = null;
function storageValue(key,fallback){try{const value=JSON.parse(localStorage.getItem(key)||"null");return value==null?fallback:value}catch{return fallback}}
function loadState(){const stored=storageValue(STORE,{});const base=Object.assign({backend:"https://edge-intelligence-api.ttamlarson.workers.dev",watchlist:[],positions:[],balance:10000,realized:0},stored&&typeof stored==="object"&&!Array.isArray(stored)?stored:{});base.watchlist=Array.isArray(base.watchlist)?base.watchlist.filter(item=>item&&typeof item==="object"):[];base.positions=Array.isArray(base.positions)?base.positions.filter(item=>item&&typeof item==="object"):[];base.balance=Number.isFinite(Number(base.balance))&&Number(base.balance)>=0?Number(base.balance):10000;base.realized=Number.isFinite(Number(base.realized))?Number(base.realized):0;return base}
function save(){try{localStorage.setItem(STORE,JSON.stringify(state))}catch{toast("Browser storage is unavailable. Changes may not persist.")}}
function money(n,currency=null){return formatMoney(n,currency)}
function toast(msg){const t=$("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2400)}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function nav(page){document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id==="page-"+page));document.querySelectorAll(".nav-item, .mobile-nav-item").forEach(b=>{const active=b.dataset.page===page;b.classList.toggle("active",active);if(b.classList.contains("mobile-nav-item")){if(active)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current")}});$("pageCrumb").textContent=page.replace(/^\w/,c=>c.toUpperCase()).replace("-"," ");window.scrollTo(0,0);if(page==="alerts")loadAlertRules();if(page==="crypto"){loadCoinSpotMarkets();loadCoinSpotAccount();loadCoinSpotMtfStrategy();loadCoinSpotMtfPaper()}if(page==="asx-autopilot")loadAsxAutopilotStatus();}
document.querySelectorAll("[data-page]").forEach(b=>b.addEventListener("click",()=>nav(b.dataset.page)));
document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>nav(b.dataset.goto)));
$("dismissNotice").onclick=()=>{$("dismissNotice").closest(".notice").remove()};
function normalizeBackendUrl(value){let input=String(value||"").trim();if(input&&!/^[a-z][a-z0-9+.-]*:\/\//i.test(input))input="https://"+input;const url=new URL(input);const local=["localhost","127.0.0.1"].includes(url.hostname);if(url.username||url.password||url.search||url.hash||!(url.protocol==="https:"||(local&&url.protocol==="http:")))throw new Error("Backend URL must use HTTPS and cannot contain credentials, query parameters or fragments.");return url.origin+url.pathname.replace(/\/+$/g,"")}
function venueLabel(v){return String(v||"unknown").replace(/[_-]/g," ").replace(/^\w/,c=>c.toUpperCase())}
function normalize(m){const n=normalizeMarket(m,{source:m.source||"provider response"});return {...m,id:n.id,title:n.title,platform:n.venue,yes:n.probability.yes,volume:n.volume,currency:n.currency,quoteType:n.quoteType,observedAt:n.observedAt,freshness:n.freshness,raw:m}}
function marketCard(m){const w=state.watchlist.some(x=>x.id===m.id);return `<div class="market-row"><div><div class="market-title">${esc(m.title)}</div><div class="market-meta">${esc(venueLabel(m.platform))} | ${m.volume?.amount!=null?esc(money(m.volume.amount,m.volume.currency))+" volume":"Volume unavailable"} | ${esc(m.quoteType||"quote type unverified")}</div></div><div class="prob">${m.yes==null?"?":m.yes.toFixed(1)+"%"}<small>OBSERVED YES QUOTE</small></div><button class="small-btn" data-watch="${esc(m.id)}">${w?"? Saved":"? Save"}</button></div>`}
function bindWatch(){document.querySelectorAll("[data-watch]").forEach(button=>button.onclick=()=>{const market=markets.find(item=>item.id===button.dataset.watch)||state.watchlist.find(item=>item.id===button.dataset.watch);if(!market)return;state.watchlist=toggleWatchlist(state.watchlist,market);save();render()})}
function render(){const ranked=demoMarkets.slice().sort((a,b)=>Math.abs(b.edge)-Math.abs(a.edge));$("radarList").innerHTML=ranked.slice(0,4).map(m=>`<div class="market-row"><div><div class="market-title">${esc(m.title)}</div><div class="market-meta">DEMO EXAMPLE · MODEL ILLUSTRATION</div></div><div class="prob">${m.estimated}%<small>MODEL ESTIMATE</small></div><span class="edge-pill">${m.edge>0?"+":""}${m.edge} pts</span></div>`).join("");
$("metricMarkets").textContent=state.backend?"Backend configured":"Demo examples";$("metricOpps").textContent=ranked.filter(x=>Math.abs(x.edge)>=5).length;$("metricWatch").textContent=state.watchlist.length;$("metricPnl").textContent=money(state.realized,"AUD");
$("venueList").innerHTML=venues.slice(0,6).map(v=>`<div class="venue"><span>${v[0]}</span><small>${state.backend?"NOT LIVE-VERIFIED":"NOT CONNECTED"}</small></div>`).join("");
$("integrationGrid").innerHTML=venues.map(v=>`<div class="integration"><b>${v[0]}</b><small>${v[2]}</small><em>${v[1]==="manifold"?"PUBLIC / PLAY MONEY":"ACCESS / JURISDICTION UNVERIFIED"}</em></div>`).join("");
$("watchlistRows").innerHTML=state.watchlist.length?state.watchlist.map(m=>marketCard(m)).join(""):'<div class="empty">No saved markets yet. Save a market from Discover.</div>';bindWatch();
$("opportunityList").innerHTML=ranked.map(m=>`<div class="opportunity-card"><div><h3>${esc(m.title)}</h3><p>Illustrative demo only · Market ${m.yes}% · Model ${m.estimated}% · Verify all inputs</p><div style="margin-top:12px"><button class="small-btn" data-analyze-demo="${m.id}">Review analysis</button></div></div><div class="score">${Math.abs(m.edge)}<small>EDGE POINTS*</small></div></div>`).join("");
document.querySelectorAll("[data-analyze-demo]").forEach(b=>b.onclick=()=>{const m=demoMarkets.find(x=>x.id===b.dataset.analyzeDemo);$("marketQuestion").value=m.title;$("yesPrice").value=m.yes;nav("analyzer")});
renderPaper();
}
function renderPaper(){const open=state.positions.filter(p=>!p.closed);$("paperBalance").textContent=money(state.balance,"AUD");$("paperPositions").textContent=open.length;$("paperRealized").textContent=money(state.realized,"AUD");$("paperReturn").textContent=((state.realized/10000)*100).toFixed(2)+"%";$("positionList").innerHTML=state.positions.length?state.positions.map((p,i)=>`<div class="position-card"><div><b>${esc(p.question)}</b><div class="market-meta">${esc(p.side)} | Entry ${Number(p.price).toFixed(1)}% YES | Stake ${esc(money(p.stake,"AUD"))} virtual AUD ${p.closed?"| CLOSED":"| SIMULATED"}${p.resolution?" | Resolved "+(p.resolution===1?"YES":"NO"):""}</div></div>${p.closed?"":`<div>${p.resolution?"":`<button class="small-btn" data-paper-outcome="1" data-paper-id="${i}">Resolve YES (simulated)</button> <button class="small-btn" data-paper-outcome="0" data-paper-id="${i}">Resolve NO (simulated)</button>`} <button class="small-btn" data-close="${i}">Close at entry</button></div>`}</div>`).join(""):`<div class="empty">No simulated positions yet.</div>`;document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>{const p=state.positions[Number(b.dataset.close)];if(!p||p.closed)return;p.closed=true;state.balance+=Number(p.stake)||0;save();render();toast("Closed at entry in the paper simulation; no profit or loss.")});document.querySelectorAll("[data-paper-outcome]").forEach(b=>b.onclick=()=>{const p=state.positions[Number(b.dataset.paperId)];if(!p||p.closed)return;const result=paperSettlement({stake:Number(p.stake),side:p.side,entryProbability:Number(p.price),outcome:Number(b.dataset.paperOutcome)});if(!result){toast("Position data is invalid; it was not settled.");return}p.closed=true;p.resolution=Number(b.dataset.paperOutcome);p.profitLoss=result.profitLoss;p.payout=result.payout;state.balance+=result.payout;state.realized+=result.profitLoss;save();render();toast("Paper position resolved in a simulation only.")})}
async function api(path,opts={}){if(!state.backend)throw new Error("No backend configured. Add your Worker URL in Settings.");const base=normalizeBackendUrl(state.backend);let r;try{r=await fetch(base+path,{credentials:"include",...opts,headers:{...((opts.method||"GET").toUpperCase()==="GET"?{}:{"Content-Type":"application/json"}),...(opts.headers||{})}})}catch(error){const detail=error?.message||"Network request blocked";throw new Error("Could not reach the Cloudflare Worker. This is a browser/network failure, not a CoinSpot credential rejection. Check the saved Worker URL, Cloudflare Access login/cookie, CORS origin and deployment. ("+detail+")")}const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||"Backend request failed ("+r.status+")");return data}
async function fetchBinanceHourlyHistory(symbol, days=365) {
 const end=Date.now(), start=end-days*86400000;
 const hosts=["https://api.binance.com","https://data-api.binance.vision"];
 const failures=[];
 let rows=null, sourceHost=null;
 for(const host of hosts){
  try{
   let cursor=start, collected=[];
   while(cursor<end){
    const url=host+"/api/v3/klines?"+new URLSearchParams({symbol,interval:"1h",startTime:String(cursor),endTime:String(end),limit:"1000"});
    const response=await fetch(url,{headers:{Accept:"application/json"},cache:"no-store"});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const batch=await response.json();
    if(!Array.isArray(batch))throw new Error("invalid candle response");
    if(!batch.length)break;
    collected.push(...batch);
    const last=Number(batch[batch.length-1][0]);
    if(!Number.isFinite(last)||last<cursor)throw new Error("unordered candle response");
    cursor=last+3600000;
    if(batch.length<1000)break;
    if(collected.length>50000)throw new Error("history exceeded 50,000 candles (about 5.7 years)");
   }
   if(collected.length<300)throw new Error("only "+collected.length+" candles returned");
   rows=collected;sourceHost=host;break;
  }catch(error){failures.push(host+": "+(error?.message||"request failed"))}
 }
 if(!rows)throw new Error("Both Binance market-data endpoints failed for "+symbol+". "+failures.join("; ")+". If you are using the installed iPhone app, reopen it once to receive the latest update; otherwise try the CSV importer.");
 const candles=rows.filter(x=>Number(x[6])<end).map(x=>({timestamp:new Date(Number(x[0])).toISOString(),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5])}));
 if(candles.length<300)throw new Error("Fewer than 300 completed hourly candles for "+symbol+".");
 for(let i=1;i<candles.length;i++)if(Date.parse(candles[i].timestamp)-Date.parse(candles[i-1].timestamp)<=0)throw new Error("Binance history contains duplicate or unordered candles for "+symbol+".");
 return {metadata:{source:"Binance public Spot API ("+new URL(sourceHost).hostname+")",exchange:"Binance",symbol,quoteAsset:symbol.endsWith("USDT")?"USDT":"UNKNOWN",timeframe:"1h",candleCount:candles.length,firstCandleAt:candles[0].timestamp,lastCandleAt:candles.at(-1).timestamp},quality:{missingIntervals:candles.slice(1).filter((x,i)=>Date.parse(x.timestamp)-Date.parse(candles[i].timestamp)!==3600000).length},candles};
}
function runCryptoWalkForward(parsed,symbol,quoteAsset) {
 try {
  return walkForwardCoinSpotTrend({
   candles:parsed.candles,market:symbol,
   source:parsed.metadata.source||"User-supplied historical OHLCV",
   quoteCurrency:quoteAsset
  });
 } catch(error) {
  return {status:"BLOCKED",reason:error.message};
 }
}
async function runCryptoCandlesBacktest(parsed,symbol,quoteAsset) {
 const result=backtestCoinSpotTrend({candles:parsed.candles,quoteCurrency:quoteAsset});
 const adaptive=backtestAdaptiveRegime({candles:parsed.candles,market:symbol,quoteCurrency:quoteAsset});
 const breakout=backtestRegimeAdaptiveBreakout({candles:parsed.candles,market:symbol,quoteCurrency:quoteAsset});
 const trendFollowing=backtestTrendFollowingIndicators({candles:parsed.candles,market:symbol,quoteCurrency:quoteAsset});
 const walkForward=runCryptoWalkForward(parsed,symbol,quoteAsset);
 return {...parsed,result,adaptive,breakout,trendFollowing,walkForward};
}
async function runCryptoDatasetBacktest(file, symbol, quoteAsset) {
 const parsed = parseBinanceKlineCsv(await file.text(), { symbol, quoteAsset, exchange: "Binance via CryptoFetch" });
 const result = backtestCoinSpotTrend({ candles: parsed.candles, quoteCurrency: quoteAsset });
 const adaptive = backtestAdaptiveRegime({ candles: parsed.candles, market: symbol, quoteCurrency: quoteAsset });
 const breakout = backtestRegimeAdaptiveBreakout({ candles: parsed.candles, market: symbol, quoteCurrency: quoteAsset });
 const trendFollowing = backtestTrendFollowingIndicators({ candles: parsed.candles, market: symbol, quoteCurrency: quoteAsset });
 const walkForward = runCryptoWalkForward(parsed, symbol, quoteAsset);
 return { ...parsed, result, adaptive, breakout, trendFollowing, walkForward };
}
function renderCryptoBacktest(label, imported) {
 const r=imported.result, q=imported.metadata.quoteAsset, m=imported.metadata;
 cryptoResearchReports.set(m.symbol, imported);
 const moneyQ=value=>new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value)||0)+" "+q;
 const cards=[
  ["OUT-OF-SAMPLE NET P&L",moneyQ(r.outOfSample.netPnlQuote),r.outOfSample.trades+" closed trades"],
  ["OUT-OF-SAMPLE WIN RATE",r.outOfSample.winRatePct+"%",r.outOfSample.wins+" winners"],
  ["PROFIT FACTOR",r.outOfSample.profitFactor??"Unavailable","After modelled costs"],
  ["MAX DRAWDOWN",r.outOfSample.maxDrawdownPct+"%","Out-of-sample"],
  ["IN-SAMPLE NET P&L",moneyQ(r.inSample.netPnlQuote),r.inSample.trades+" closed trades"],
  ["ASSESSMENT",r.assessment,"Research only · no live orders"]
 ];
 const sample=r.sample, o=r.outOfSample, ins=r.inSample;
 const ar=imported.adaptive, ao=ar.outOfSample, ai=ar.inSample;
 const adaptiveCards=[["OOS NET P&L",moneyQ(ao.netPnlQuote),ao.trades+" closed trades"],["OOS WIN RATE",ao.winRatePct+"%",ao.wins+" winners"],["PROFIT FACTOR",ao.profitFactor??"Unavailable","After modelled costs"],["MAX DRAWDOWN",ao.maxDrawdownPct+"%","Out-of-sample"],["IN-SAMPLE P&L",moneyQ(ai.netPnlQuote),ai.trades+" trades"],["ASSESSMENT",ar.assessment,"Research only · no live orders"]];
 const active=ar.activeVariant, av=active.outOfSample, activeCards=[["OOS NET P&L",moneyQ(av.netPnlQuote),av.trades+" closed trades"],["OOS WIN RATE",av.winRatePct+"%",av.wins+" winners"],["PROFIT FACTOR",av.profitFactor??"Unavailable","After modelled costs"],["MAX DRAWDOWN",av.maxDrawdownPct+"%","Out-of-sample"],["IN-SAMPLE P&L",moneyQ(active.inSample.netPnlQuote),active.inSample.trades+" trades"],["ASSESSMENT",active.assessment,"Research only · no live orders"]];
 const br=imported.breakout, bo=br.outOfSample, bi=br.inSample;
 const breakoutCards=[["OOS NET P&L",moneyQ(bo.netPnlQuote),bo.trades+" closed trades"],["OOS WIN RATE",bo.winRatePct+"%",bo.wins+" winners"],["PROFIT FACTOR",bo.profitFactor??"Unavailable","After modelled costs"],["MAX DRAWDOWN",bo.maxDrawdownPct+"%","Out-of-sample"],["IN-SAMPLE P&L",moneyQ(bi.netPnlQuote),bi.trades+" trades"],["ASSESSMENT",br.assessment,"Research only · no live orders"]];
 const tf=imported.trendFollowing;
 const tfRender=(period,model)=>{const variants=model.variants.map(v=>{const x=v.outOfSample;const cells=[["OOS NET P&L",moneyQ(x.netPnlQuote),x.trades+" closed trades"],["WIN RATE",x.winRatePct+"%",x.wins+" winners"],["PROFIT FACTOR",x.profitFactor??"Unavailable","After modelled costs"],["MAX DRAWDOWN",x.maxDrawdownPct+"%","Out-of-sample"],["IN-SAMPLE P&L",moneyQ(v.inSample.netPnlQuote),v.inSample.trades+" trades"],["ASSESSMENT",v.assessment,"Research only · no live orders"]];return '<div class="result-section"><h5>'+esc(v.label)+' · '+esc(v.assessment)+'</h5><div class="metric-grid">'+cells.map(c=>'<article class="metric-card"><span>'+esc(c[0])+'</span><strong>'+esc(c[1])+'</strong><small>'+esc(c[2])+'</small></article>').join("")+'</div><p>'+x.trades+' closed OOS trades from '+x.evaluatedBars+' bars · '+esc(x.dateRange.from||"—")+' → '+esc(x.dateRange.to||"—")+' · '+x.eligibleSignals+' qualifying signals. Minimum: '+tf.sample.minimumOutOfSampleTrades+' trades.</p></div>';}).join("");return '<div class="result-section"><h4>TREND-FOLLOWING INDICATORS v2 · '+period+'</h4><p>'+esc(tf.methodology)+' Costs: '+(tf.costs.feeRate*100).toFixed(2)+'% fee per side, '+tf.costs.slippageBps+' bps slippage and '+tf.costs.spreadBps+' bps spread. Risk: '+tf.risk.perTradePct+'% per trade; '+tf.risk.maxAllocationPct+'% maximum allocation.</p>'+variants+'</div>';};
 const trendFollowingHtml=tfRender("1H",tf.oneHour)+tfRender("4H",tf.fourHour);
 const comparison=buildCryptoStrategyComparison({legacy:r,adaptive:ar,breakout:br,trendFollowing:tf});
 const comparisonRows=comparison.strategies.map(row=>'<tr><td><b>'+esc(row.strategy)+'</b><div class="table-sub">'+esc(row.timeframe)+' · '+esc(row.window.from||"—")+' → '+esc(row.window.to||"—")+'</div></td><td>'+row.outOfSampleTrades+'</td><td>'+esc(row.netPnlQuote==null?"—":moneyQ(row.netPnlQuote))+'</td><td>'+esc(row.profitFactor==null?"—":row.profitFactor.toFixed(2))+'</td><td>'+esc(row.maxDrawdownPct==null?"—":row.maxDrawdownPct.toFixed(2)+"%")+'</td><td>'+esc(row.commonScreen.replaceAll("_"," "))+'</td></tr>').join("");
 const comparisonHtml='<div class="result-section"><h4>STRATEGY COMPARISON · OUT-OF-SAMPLE</h4><p>'+esc(comparison.interpretation)+' Common screen met by '+comparison.meetsCommonResearchScreenCount+' of '+comparison.strategyCount+' reported variants.</p><div class="table-wrap"><table class="data-table"><thead><tr><th>Strategy / window</th><th>OOS trades</th><th>Net P&amp;L</th><th>Profit factor</th><th>Max drawdown</th><th>Common screen</th></tr></thead><tbody>'+comparisonRows+'</tbody></table></div></div>';
 const wf=imported.walkForward||{},wfSummary=wf.summary||{};
 const wfPct=value=>Number.isFinite(value)?Number(value).toFixed(2)+"%":"—";
 const walkForwardHtml=wf.status==="BLOCKED"
  ? '<div class="result-section"><h4>CHRONOLOGICAL WALK-FORWARD · BLOCKED</h4><p>'+esc(wf.reason||"Insufficient validated hourly data.")+'</p></div>'
  : '<div class="result-section"><h4>CHRONOLOGICAL WALK-FORWARD · FIXED RULES</h4><p>'+esc(wf.methodology||"")+'</p><div class="metric-grid">'+[
    ["OOS TRADES",wfSummary.totalOutOfSampleTrades??0,"Across independent folds"],
    ["MEAN FOLD RETURN",wfPct(wfSummary.meanFoldReturnPct),"Each fold resets virtual capital"],
    ["BUY/HOLD REFERENCE",wfPct(wfSummary.meanBenchmarkReturnPct),"Separate 50% allocation"],
    ["MEAN DRAWDOWN",wfPct(wfSummary.meanFoldMaxDrawdownPct),"Net liquidation mark"],
    ["PROFIT FACTOR",wfSummary.pooledProfitFactor??"Unavailable","After modelled costs"],
    ["ASSESSMENT",wfSummary.assessment||"UNKNOWN","Research only · no live orders"]
   ].map(c=>'<article class="metric-card"><span>'+esc(c[0])+'</span><strong>'+esc(c[1])+'</strong><small>'+esc(c[2])+'</small></article>').join("")+'</div>'+
   (wf.folds||[]).map(fold=>'<p class="market-meta">Fold '+fold.fold+': '+fold.trades+' trades · return '+wfPct(fold.returnPct)+' · buy/hold '+wfPct(fold.benchmark?.returnPct)+' · drawdown '+wfPct(fold.maxDrawdownPct)+'</p>').join("")+
   '<p class="muted tiny">Chronological expanding-history validation; fixed parameters, no fitting. Source: '+esc(wf.source||m.source||"User supplied")+' · '+esc(wf.data?.firstBarAt||"")+' → '+esc(wf.data?.lastBarAt||"")+'. Source and data-use rights are not independently verified. Small samples are not evidence of profitability.</p><button class="secondary-btn" type="button" data-crypto-ai-review="'+esc(m.symbol)+'">Run AI research review</button><div class="market-meta" id="cryptoAiReview-'+esc(m.symbol)+'"></div></div>';
 const skipLabels={positionOpen:"Position already open",dailyLossLimit:"Daily loss limit",trendFilter:"Trend filter",rsiFilter:"RSI filter",volatilityFilter:"ATR / volatility filter",insufficientCapitalOrRisk:"Capital or risk sizing"};
 const skipRows=Object.entries(o.skipped||{}).map(([key,value])=>`<tr><td>${esc(skipLabels[key]||key)}</td><td>${value}</td></tr>`).join("");
 return `<div class="result-section"><h3>${esc(label)} · ${esc(m.symbol)}</h3><p>${esc(m.exchange)} · 1h · ${m.candleCount} completed candles · ${esc(m.firstCandleAt)} → ${esc(m.lastCandleAt)} · quote currency ${esc(q)}</p><div class="metric-grid">${cards.map(x=>`<article class="metric-card"><span>${esc(x[0])}</span><strong>${esc(x[1])}</strong><small>${esc(x[2])}</small></article>`).join("")}</div><div class="result-section"><h4>OUT-OF-SAMPLE DIAGNOSTICS</h4><p>${o.trades} completed trades from ${o.evaluatedBars} evaluated candles; ${o.eligibleSignals} entry signals passed the indicator filters.</p><p>Out-of-sample window: ${esc(o.dateRange?.from||"—")} → ${esc(o.dateRange?.to||"—")} (${sample.outOfSampleCandles} candles). In-sample: ${ins.trades} trades across ${sample.inSampleCandles} candles, ${esc(ins.dateRange?.from||"—")} → ${esc(ins.dateRange?.to||"—")}.</p><p>Assessment requirement: ${sample.minimumOutOfSampleTrades} completed out-of-sample trades. Current count: ${o.trades}.</p><table class="data-table"><thead><tr><th>Why no entry was taken</th><th>Bars</th></tr></thead><tbody>${skipRows}</tbody></table></div><div class="result-section"><h4>NEW STRATEGY · EDGE ADAPTIVE REGIME v1</h4><p>${esc(ar.methodology)} Entry risk: ${ar.risk.perTradePct}% of equity; max allocation ${ar.risk.maxAllocationPct}%; max hold ${ar.risk.maxHoldHours} hours.</p><div class="metric-grid">${adaptiveCards.map(x=>`<article class="metric-card"><span>${esc(x[0])}</span><strong>${esc(x[1])}</strong><small>${esc(x[2])}</small></article>`).join("")}</div><p>Out-of-sample: ${ao.trades} closed trades from ${ao.evaluatedBars} bars · ${esc(ao.dateRange.from||"—")} → ${esc(ao.dateRange.to||"—")}. In-sample: ${ai.trades} trades. Minimum sample: ${ar.sample.minimumOutOfSampleTrades} OOS trades. The new model is assessed separately from the legacy EMA strategy.</p></div><div class="result-section"><h4>ALTERNATIVE · EDGE ACTIVE MOMENTUM v1</h4><p>${esc(active.methodology)}</p><div class="metric-grid">${activeCards.map(x=>`<article class="metric-card"><span>${esc(x[0])}</span><strong>${esc(x[1])}</strong><small>${esc(x[2])}</small></article>`).join("")}</div><p>Out-of-sample: ${av.trades} closed trades from ${av.evaluatedBars} bars · ${esc(av.dateRange.from||"—")} → ${esc(av.dateRange.to||"—")}. This is a separate research candidate, not a validated replacement.</p></div><div class="result-section"><h4>NEW CANDIDATE · REGIME-ADAPTIVE BREAKOUT v1 · 4H</h4><p>${esc(br.methodology)} Risk ${br.risk.perTradePct}% of equity per trade; maximum allocation ${br.risk.maxAllocationPct}%; initial stop ${br.risk.initialStopAtr} ATR; trailing stop ${br.risk.trailingStopAtr} ATR. Uses complete 4-hour candles aggregated from hourly history; incomplete buckets are discarded.</p><div class="metric-grid">${breakoutCards.map(x=>`<article class="metric-card"><span>${esc(x[0])}</span><strong>${esc(x[1])}</strong><small>${esc(x[2])}</small></article>`).join("")}</div><p>Out-of-sample: ${bo.trades} closed trades from ${bo.evaluatedBars} bars · ${esc(bo.dateRange.from||"—")} → ${esc(bo.dateRange.to||"—")}; ${bo.eligibleSignals} qualifying entry signals. ${br.sample.fourHourCandles} complete 4h candles; ${br.sample.outOfSampleCandles} OOS candles. Research candidate only; not approved for live trading.</p></div>'+walkForwardHtml+trendFollowingHtml+comparisonHtml+'<p class="muted tiny">Data provenance: ${esc(m.source||"User-supplied historical CSV")}, ${esc(m.exchange||"Binance")} ${esc(m.symbol)}. Strategy capital and P&L are denominated in ${esc(q)}, not AUD. Costs: 0.1% fee each side + 15 bps slippage + 10 bps spread model. Missing hourly intervals: ${imported.quality.missingIntervals}. CSV source is user-supplied and not independently verified.</p></div>`;
}

document.addEventListener("click", async event => {
 const button=event.target?.closest?.("[data-crypto-ai-review]");
 if(!button)return;
 const symbol=button.dataset.cryptoAiReview;
 const imported=cryptoResearchReports.get(symbol);
 const target=$("cryptoAiReview-"+symbol);
 if(!imported||!target)return;
 const candles=imported.candles||[];
 if(candles.length>5000){target.textContent="AI review is limited to 5,000 completed hourly candles. The deterministic local backtest remains available.";return;}
 button.disabled=true;button.textContent="Reviewing research…";
 target.textContent="Recomputing the fixed-rule walk-forward on the Worker and requesting a structured AI critique. No orders can be placed.";
 try{
  const review=await api("/api/crypto/research/review",{
   method:"POST",
   body:JSON.stringify({
    market:symbol,quoteCurrency:imported.metadata.quoteAsset,
    source:imported.metadata.source||"User-supplied historical OHLCV",candles
   })
  });
  const provenance=review.inputProvenance||{};
  const lines=[
   "AI research review: "+(review.status||"UNKNOWN"),
   "Decision: "+(review.decision||"Not authorised")+" · model suggestion: "+(review.modelDecision||"—"),
   "Subjective confidence: "+(review.confidence==null?"—":review.confidence+"%")+" · evidence quality: "+(review.evidenceQuality||"—"),
   "Deterministic gate: "+(review.deterministicGateMet?"met":"not met")+" · AI recommendation: "+(review.advanceAllowed?"consider extended paper observation (not started)":"do not advance"),
   "Thesis: "+(review.thesis||"—"),
   "Counter-thesis: "+(review.counterThesis||"—"),
   "Risk flags: "+((review.riskFlags||[]).join("; ")||"None declared"),
   "Limitations: "+((review.limitations||[]).join("; ")||"—"),
   "Walk-forward assessment: "+(review.research?.summary?.assessment||"Unavailable"),
   "Provenance: "+(provenance.barsProvided||0)+" bars · SHA-256 "+(provenance.fingerprint||"").slice(0,16)+"… · source not independently verified",
   review.reason||"",
   "Model-assisted critique only; not a trained predictor, profitability claim or trade instruction."
  ].filter(Boolean);
  target.innerHTML=lines.map(line=>"<div>"+esc(line)+"</div>").join("");
 }catch(error){
  target.textContent="AI review unavailable: "+(error?.message||"Request failed")+". No research advancement or trade was authorised.";
 }finally{
  button.disabled=false;button.textContent="Run AI research review";
 }
});
$("fetchCryptoHistoryBtn")?.addEventListener("click",async()=>{
 const status=$("coinSpotBacktestStatus"),out=$("coinSpotBacktestResults"),button=$("fetchCryptoHistoryBtn");
 let symbols; try { symbols=parseBinanceUsdtSymbols($("cryptoHistorySymbols")?.value||""); } catch(error) { status.textContent=error.message; return; }
 const days=Math.max(90,Math.min(1825,Number($("cryptoHistoryDays")?.value)||1095));
 
 button.disabled=true;button.textContent="Fetching history…";status.textContent="Downloading "+days+" days of hourly Binance data for "+symbols.join(", ")+". This may take a minute.";out.innerHTML="";
 try{
  const results=await Promise.all(symbols.map(async symbol=>{const parsed=await fetchBinanceHourlyHistory(symbol,days);return {symbol,imported:await runCryptoCandlesBacktest(parsed,symbol,"USDT")};}));
  out.innerHTML=results.map(x=>renderCryptoBacktest(x.symbol,x.imported)).join("");
  status.textContent="Fetched and tested "+results.map(x=>x.symbol).join(", ")+". "+days+" requested days; each market has an independent chronological 70/30 split. Verify candle counts and gaps in each result."; 
 }catch(error){status.textContent="Binance history fetch/test failed: "+error.message+" You can still import CSV files below."; }
 finally{button.disabled=false;button.textContent="Fetch up to 5 years from Binance";}
});
$("coinSpotBacktestBtn")?.addEventListener("click",async()=>{
 const selected=[...($("cryptoHistoryFiles")?.files||[])];
 const status=$("coinSpotBacktestStatus"),out=$("coinSpotBacktestResults");
 if(!selected.length){status.textContent="Choose one or more 1-hour OHLCV CSV files first.";return}
 if(selected.length>10){status.textContent="Select no more than 10 markets per batch.";return}
 let files; try { files=selected.map(file=>{
  const stem=file.name.replace(/\\.csv$/i,"").toUpperCase();
  const quote=["USDT","USDC","AUD","BTC","ETH"].find(q=>stem.endsWith(q));
  if(!quote)throw new Error("Could not infer quote asset from "+file.name+". Name the file with its full symbol, e.g. SOLUSDT.csv.");
  const symbol=stem.match(/[A-Z0-9]{5,20}$/)?.[0];
  if(!symbol||!symbol.endsWith(quote))throw new Error("Could not infer market symbol from "+file.name+".");
  return {symbol,quote,file};
 }); } catch(error) { status.textContent=error.message; return; }
 if(new Set(files.map(x=>x.symbol)).size!==files.length){status.textContent="Remove duplicate market CSVs.";return}
 for(const item of files)if(item.file.size>5*1024*1024){status.textContent=item.symbol+" CSV must be smaller than 5 MB.";return}
 const b=$("coinSpotBacktestBtn");b.disabled=true;b.textContent="Testing markets…";
 try{
  const results=await Promise.all(files.map(async item=>({symbol:item.symbol,imported:await runCryptoDatasetBacktest(item.file,item.symbol,item.quote)})));
  out.innerHTML=results.map(x=>renderCryptoBacktest(x.symbol,x.imported)).join("");
  status.textContent="Completed "+results.map(x=>x.symbol).join(", ")+". Each market uses its own 70% chronological in-sample / 30% out-of-sample split. The unfinished candle is excluded. No cross-market portfolio simulation is implied.";
 }catch(e){out.innerHTML="";status.textContent="Backtest rejected: "+e.message;}
 finally{b.disabled=false;b.textContent="Run multi-market strategy tests";}
});

async function loadCoinSpotMarkets(){
 const button=$("cryptoRefreshBtn"),status=$("cryptoStatus"),container=$("cryptoMarketRows");
 if(!container||!status)return;
 if(button){button.disabled=true;button.textContent="Refreshing…"}
 status.textContent="Fetching live public CoinSpot quotes…";
 container.innerHTML='<div class="empty">Loading BTC/AUD and ETH/AUD…</div>';
 try{
  const data=await api("/api/crypto/coinspot/market?coins=BTC,ETH");
  const markets=Array.isArray(data.markets)?data.markets:[];
  if(!markets.length)throw new Error("CoinSpot returned no supported markets.");
  container.innerHTML=markets.map(m=>`<article class="integration"><b>${esc(m.pair)}</b><small>Bid ${esc(money(m.bid,"AUD"))} · Ask ${esc(money(m.ask,"AUD"))}</small><small>Last ${esc(money(m.last,"AUD"))} · Spread ${esc(m.spreadPct)}%</small><small>${Number(m.completedTradesCount)||0} recent completed trades in response</small><em>LIVE PUBLIC DATA · NOT A TRADE SIGNAL</em><button class="small-btn" data-paper-open="${esc(m.coin)}">Open paper position</button></article>`).join("");
  status.textContent="Updated "+formatDateTime(data.retrievedAt,$("auTimezone")?.value)+" · "+markets.length+" AUD markets";
  document.querySelectorAll("[data-paper-open]").forEach(b=>b.onclick=()=>openCoinSpotPaper(b.dataset.paperOpen));
  await loadCoinSpotPaper();
 }catch(error){
  container.innerHTML=`<div class="empty">${esc(error.message)} Check authentication, Worker deployment and route rate limits.</div>`;
  status.textContent="Market data unavailable";
 }finally{if(button){button.disabled=false;button.textContent="Refresh market data"}}
}
async function loadCoinSpotMtfPaper(runNow=false){
 const panel=$("coinSpotMtfPaperPanel");if(!panel)return;
 const button=$("coinSpotMtfPaperRun");if(button){button.disabled=true;button.textContent=runNow?"Running scan…":"Loading…";}
 try{
  const a=await api("/api/crypto/coinspot/mtf-paper",runNow?{method:"POST",body:JSON.stringify({})}:{});
  const fmt=v=>money(Number(v)||0,"AUD");
  $("mtfPaperEquity").textContent=fmt(a.equityAud);$("mtfPaperCash").textContent=fmt(a.cashAud);
  $("mtfPaperRealized").textContent=fmt(a.realizedPnlAud);$("mtfPaperDailyLoss").textContent=fmt(a.dailyLossAud);
  const perf=a.performance||{};
  $("mtfPaperNetPnl").textContent=fmt(perf.netPnlAud);
  $("mtfPaperReturn").textContent=Number.isFinite(perf.returnPct)?Number(perf.returnPct).toFixed(2)+"%":"—";
  $("mtfPaperWinRate").textContent=Number.isFinite(perf.winRatePct)?Number(perf.winRatePct).toFixed(1)+"%":"—";
  $("mtfPaperClosedTrades").textContent=String(perf.closedTrades??0);
  $("mtfPaperFees").textContent=fmt(perf.feesPaidAud);
  $("mtfPaperWeekPnl").textContent=fmt(perf.rolling7dPnlAud);
  $("mtfPaperPerformanceNote").textContent=perf.tradeHistoryAtLimit
   ?"Trade statistics, fees and rolling P&L use the latest 200 retained closes; rolling windows may be incomplete. Lifetime realised P&L uses cumulative ledger accounting."
   :"Performance uses all retained closed trades. No synthetic equity-curve points are generated.";

  const when=a.lastScanAt?" · Last scan "+formatDateTime(a.lastScanAt,$("auTimezone")?.value||"Australia/Perth"):"";
  $("coinSpotMtfPaperStatus").textContent=String(a.status||"WAITING").replaceAll("_"," ")+when+(a.lastError?" · "+a.lastError:"");
  $("mtfPaperPositionTitle").textContent=a.openPosition?"OPEN · "+a.openPosition.pair:"No open paper position";
  $("mtfPaperPositionDetail").textContent=a.openPosition?"Entry "+fmt(a.openPosition.entryPrice)+" · stop "+fmt(a.openPosition.trailingStop)+" · quantity "+Number(a.openPosition.quantity).toFixed(8)+" · signal "+a.openPosition.signalAt:"One position maximum. No real exchange orders are submitted.";
  $("mtfPaperMarkets").innerHTML=(a.markets||[]).map(m=>{
   const gap=m.latestFourHourGap?m.latestFourHourGap.previousAt+" → "+m.latestFourHourGap.nextAt:"No latest 4h gap";
   const model=m.entryModel||m.triggerModel;
   const modelStatus=model?(m.entryModel?"Eligible entry ":"Trigger only ")+String(model).replaceAll("_"," "):"No entry trigger";
   const blockers=Array.isArray(m.failedChecks)&&m.failedChecks.length?"Blocked by "+m.failedChecks.map(x=>String(x).replaceAll("_"," ")).join(", "):"";
   const signalWindow=m.signalWindowFourHourCandles?"Signal window "+Number(m.signalWindowFourHourCandles)+" actual bars · "+Number(m.signalWindowConfirmedZeroTradeIntervals||0)+" confirmed zero-trade intervals · "+String(m.signalWindowStatus||"UNKNOWN").replaceAll("_"," "):"";
   const i=m.indicators||{};
   const metricLine=Number.isFinite(Number(i.dailyEma100))?"Regime "+String(m.marketRegime||"UNKNOWN").replaceAll("_"," ")+" · Daily "+fmt(i.dailyClose)+" / EMA100 "+fmt(i.dailyEma100)+" ("+Number(i.dailyTrendDistancePct).toFixed(2)+"%) · 4h EMA50 / EMA200 "+fmt(i.fourHourEma50)+" / "+fmt(i.fourHourEma200)+" ("+Number(i.fourHourTrendSpreadPct).toFixed(2)+"%) · EMA200 slope "+Number(i.longTrendSlopePct).toFixed(3)+"% · breakout votes "+Number(i.breakoutVotes||0)+"/3 · ATR "+Number(i.atrPct).toFixed(2)+"%":"";
   const aiReviewStatus=String(m.aiReview?.assessment||m.aiReview?.status||"PENDING").replaceAll("_"," ");
   const aiStatus=m.aiGateStatus==="AI_APPROVED"?"AI GATE APPROVED · "+aiReviewStatus:
    m.aiGateStatus==="AI_BLOCKED"?"AI GATE BLOCKED · "+aiReviewStatus:
    (m.signalStatus==="BUY_CANDIDATE_PAPER_ONLY"?"AI review pending":"AI review not run · no eligible candidate");
   return '<article class="integration"><b>'+esc(m.pair||m.coin)+'</b><small>'+esc(String(m.signalStatus||"WAITING").replaceAll("_"," "))+'</small><small>Bid '+(m.bid?esc(fmt(m.bid)):"—")+' · Ask '+(m.ask?esc(fmt(m.ask)):"—")+' · Spread '+(m.spreadBps??"—")+' bps</small><small>History '+Number(m.dailyCandles||0)+' daily / '+Number(m.fourHourCandles||0)+' 4h bars · contiguous '+Number(m.contiguousDailyCandles??m.dailyCandles??0)+' daily / '+Number(m.contiguousFourHourCandles??m.fourHourCandles??0)+' 4h · '+Number(m.tradesFetched||0)+' trades</small><small>4h gaps '+Number(m.fourHourGapCount||0)+' · '+esc(gap)+'</small><small>'+esc(signalWindow)+'</small><small>'+esc(modelStatus)+(blockers?" · "+esc(blockers):"")+'</small><small>'+esc(metricLine)+'</small><em>'+esc(aiStatus)+'</em><small>'+esc(m.aiReview?.summary||m.signalError||"No additional risk commentary.")+'</small></article>';
  }).join("")||'<div class="empty">Waiting for validated CoinSpot history.</div>';
  $("mtfPaperTrades").innerHTML=a.closedTrades?.length?a.closedTrades.slice().reverse().slice(0,10).map(t=>'<div class="market-row"><div><b>'+esc(t.pair)+'</b><div class="market-meta">'+esc(t.reason)+' · '+esc(t.closedAt)+'</div></div><b>'+esc(fmt(t.pnlAud))+'</b></div>').join(""):'<div class="empty">No automated paper trades recorded yet.</div>';
 }catch(e){$("coinSpotMtfPaperStatus").textContent="PAPER ENGINE UNAVAILABLE · "+e.message;}
 finally{if(button){button.disabled=false;button.textContent="Run paper scan now";}}
}
async function loadCoinSpotMtfStrategy(syncNow=false){
 const panel=$("coinSpotMtfPanel"),button=$("coinSpotMtfSyncBtn"),status=$("coinSpotMtfStatus"),progress=$("coinSpotMtfProgress"),container=$("coinSpotMtfMarkets");
 if(!panel||!status||!container)return;
 if(button){button.disabled=true;button.textContent=syncNow?"Syncing CoinSpot…":"Sync next history day"}
 try{
  if(syncNow){
   const batch=await api("/api/crypto/coinspot/strategy/sync",{method:"POST",body:JSON.stringify({})});
   progress.textContent="Processed "+batch.processedDate+" · next date "+batch.nextDate+" · "+(batch.markets||[]).map(x=>x.coin+": raw "+(Number(x.rawBuyOrders||0)+Number(x.rawSellOrders||0))+" / accepted "+x.tradeCount+" trades / "+x.apiCalls+" API calls").join(" · ");
  }
  const data=await api("/api/crypto/coinspot/strategy");
  status.textContent=String(data.status||"UNKNOWN").replaceAll("_"," ");
  if(!syncNow)progress.textContent=data.lastSyncAt?"Last history sync "+formatDateTime(data.lastSyncAt,$("auTimezone")?.value||"Australia/Perth")+" · next date "+(data.nextDate||"—")+" · "+(data.lastBatch||[]).map(x=>x.coin+": raw "+(Number(x.rawBuyOrders||0)+Number(x.rawSellOrders||0))+" / accepted "+Number(x.tradeCount||0)+" · markets "+(x.marketsSeen||[]).join(",")).join(" · "):"History backfill has not started. The Worker begins automatically when CoinSpot read-only credentials are configured.";
  const rows=Array.isArray(data.markets)?data.markets:[];
  container.innerHTML=rows.map(m=>{
   const h=m.history||{},s=m.signal;
   const contiguousDaily=Number(h.contiguousDailyCandles??h.dailyCandles??0);
   const contiguousFourHour=Number(h.contiguousFourHourCandles??h.fourHourCandles??0);
   const ready=contiguousDaily>=110&&contiguousFourHour>=210;
   const quote=m.quote;
   const signalLabel=s?.status==="BUY_CANDIDATE_PAPER_ONLY"?"PAPER ENTRY CANDIDATE":(!ready&&m.signalStatus==="WARMUP_REQUIRED"?"CONTIGUOUS HISTORY WARMING":String(m.signalStatus||"WAITING").replaceAll("_"," "));
   const details=quote?"Bid "+money(quote.bid,"AUD")+" · Ask "+money(quote.ask,"AUD")+" · Spread "+Number(quote.spreadBps||0).toFixed(1)+" bps":"Live quote withheld until validated history is warm";
   const checks=s?Object.entries(s.checks||{}).map(([k,v])=>k+": "+(v?"PASS":"FAIL")).join(" · "):m.signalError||"Awaiting validated candles";
   const latestGap=h.latestFourHourGap?" · latest 4h gap "+h.latestFourHourGap.previousAt+" → "+h.latestFourHourGap.nextAt:"";
   return '<article class="integration"><b>'+esc(m.pair)+'</b><small>'+esc(details)+'</small><small>Completed '+Number(h.dailyCandles||0)+' daily / '+Number(h.fourHourCandles||0)+' 4h · contiguous '+contiguousDaily+'/110 daily / '+contiguousFourHour+'/210 4h</small><small>4h gaps '+Number(h.fourHourGapCount||0)+esc(latestGap)+'</small><small>Trades collected '+Number(h.tradesFetched||0)+' · last history day '+esc(h.lastHistoryDate||"—")+'</small><em>'+esc(signalLabel)+'</em><small>'+esc(checks)+'</small><small>Execution: no orders · live trading disabled</small></article>';
  }).join("")||'<div class="empty">CoinSpot history is not available yet.</div>';
  if(data.status==="BACKFILLING")status.textContent="BACKFILLING · HISTORICAL DATA";
  else if(data.status==="COLLECTING_LIVE_DAY")status.textContent="COLLECTING CURRENT DAY · CHECKING SIGNAL READINESS";
 }catch(error){
  status.textContent="COINSPOT STRATEGY DATA UNAVAILABLE";
  progress.textContent=error.message;
  container.innerHTML='<div class="empty">'+esc(error.message)+' Check the CoinSpot Read Only key and Worker deployment.</div>';
 }finally{if(button){button.disabled=false;button.textContent="Sync next history day"}}
}
async function loadAutomatedCryptoPaper(runNow=false){
 const panel=$("cryptoAutoPaperPanel");if(!panel)return;
 const button=$("cryptoAutoPaperRefresh");if(button){button.disabled=true;button.textContent=runNow?"Scanning markets…":"Loading…"}
 try{
  const a=await api("/api/crypto/auto-paper/account",runNow?{method:"POST"}:{});
  const fmt=v=>(Number(v)||0).toFixed(2)+" USDT";
  $("autoPaperEquity").textContent=fmt(a.equity);$("autoPaperCash").textContent=fmt(a.cash);$("autoPaperRealized").textContent=fmt(a.realizedPnl);$("autoPaperDrawdown").textContent=(Number(a.maxDrawdownPct)||0).toFixed(2)+"%";
  $("autoPaperStatus").textContent=a.lastScanAt?"AUTOMATED PAPER ENGINE ACTIVE":(a.status||"WAITING FOR FIRST SCHEDULED SCAN").replaceAll("_"," ");
  $("autoPaperLastScan").textContent=a.lastScanAt?"Last server scan: "+formatDateTime(a.lastScanAt,$("auTimezone")?.value||"Australia/Perth")+" · "+(a.markets||[]).filter(x=>x.status==="LIVE_PUBLIC_DATA").length+" of 10 markets returned valid data · "+(a.scanIntervalMinutes||15)+" minute schedule.":"No scheduled scan has completed yet. Check back after the next Worker cron.";
  $("autoPaperPosition").innerHTML=a.openPosition?'<div class="position-card"><div><b>'+esc(a.openPosition.symbol)+' · OPEN PAPER POSITION</b><div class="market-meta">Entry '+fmt(a.openPosition.entryPrice)+' · quantity '+Number(a.openPosition.quantity).toFixed(6)+' · stop '+fmt(a.openPosition.trailingStop)+' · target '+fmt(a.openPosition.targetPrice)+'</div><div class="market-meta">Unrealized '+fmt(a.unrealizedPnl||0)+' · signal candle '+esc(a.openPosition.signalAt)+'</div></div></div>':'<div class="empty">No open automated paper position. The engine scans for qualifying signals.</div>';
  const performance=a.performance||{};
  const pct=value=>value===null||value===undefined||!Number.isFinite(Number(value))?"—":Number(value).toFixed(2)+"%";
  const scalar=value=>Number.isFinite(Number(value))?Number(value).toFixed(2):"—";
  $("autoPaperPerformance").innerHTML=[
   ["CLOSED TRADES",String(performance.tradeCount??0),performance.status||"Insufficient sample"],
   ["WIN RATE",pct(performance.winRatePct),String(performance.wins??0)+" wins / "+String(performance.losses??0)+" losses"],
   ["PROFIT FACTOR",performance.profitFactor==null?"—":scalar(performance.profitFactor),"Closed trades after costs"],
   ["EXPECTANCY",performance.expectancyQuote==null?"—":fmt(performance.expectancyQuote),"Net quote units per closed trade"],
   ["NET RETURN",pct(performance.netReturnPct),performance.assessment||"NOT PROVEN"],
   ["SIMULATED FEES",fmt(performance.estimatedFeesQuote),"Entry + exit fees"],
   ["REALIZED DRAWDOWN",performance.maxRealizedDrawdownQuote==null?"—":fmt(performance.maxRealizedDrawdownQuote),pct(performance.maxRealizedDrawdownPct)]
  ].map(c=>'<article class="metric-card"><span>'+esc(c[0])+'</span><strong>'+esc(c[1])+'</strong><small>'+esc(c[2])+'</small></article>').join("");
  const ranking=Array.isArray(a.candidateRanking)?a.candidateRanking:[];
  $("autoPaperRanking").innerHTML=ranking.length?ranking.map(row=>'<div class="market-row"><div><b>#'+esc(row.rank)+' · '+esc(row.symbol)+'</b><div class="market-meta">Net R/R '+scalar(row.rewardRiskAfterCosts)+' · planned stop risk '+fmt(row.estimatedNetStopLossQuote)+' · risk budget used '+pct(row.riskBudgetUtilizationPct)+' · ADX '+scalar(row.adx)+'</div></div><b>'+fmt(row.estimatedNetTargetProfitQuote)+'</b></div>').join(""):'<div class="empty">No risk-eligible priced candidates in the latest scan. Missing prices are not consumed and can be retried on the next scan.</div>';
  $("autoPaperMarkets").innerHTML=(a.markets||[]).length?a.markets.map(m=>{const checks=m.checks||{};const labels={trend:"EMA trend",rsi:"RSI",macd:"MACD",adx:"Trend strength (ADX)",atr:"Volatility (ATR)"};const rows=Object.entries(labels).filter(([k])=>checks[k]).map(([k,label])=>{const c=checks[k];const value=typeof c.value==="object"?Object.entries(c.value).map(([n,v])=>n+" "+(v??"—")).join(" · "):String(c.value??"—");return `<div class="market-meta">${c.passed?"✓":"✕"} ${label}: ${esc(value)} · requires ${esc(c.required)}</div>`}).join("");return `<article class="integration"><b>${esc(m.symbol)}</b><small>${esc((m.status||"UNKNOWN").replaceAll("_"," "))}</small><small>${esc(m.reason||"No signal")}</small><small>${m.rsi==null?"RSI —":"RSI "+Number(m.rsi).toFixed(1)} · ${m.adx==null?"ADX —":"ADX "+Number(m.adx).toFixed(1)}</small><em>${m.signal?"QUALIFYING SIGNAL":"NO ENTRY"}</em>${rows?`<details class="signal-diagnostics"><summary>Why no entry? · ${Object.values(checks).filter(c=>!c.passed).length} failed gates</summary>${rows}</details>`:""}</article>`}).join(""):'<div class="empty">Waiting for first market scan.</div>';
  $("autoPaperHistory").innerHTML=a.closedTrades?.length?a.closedTrades.slice().reverse().slice(0,10).map(t=>'<div class="market-row"><div><b>'+esc(t.symbol)+'</b><div class="market-meta">'+esc(t.reason)+' · '+esc(t.closedAt)+'</div></div><b>'+fmt(t.pnl)+'</b></div>').join(""):'<div class="empty">No completed automated trades yet.</div>';
 }catch(e){$("autoPaperStatus").textContent="AUTOMATED PAPER STATUS UNAVAILABLE";$("autoPaperLastScan").textContent=e.message;}
 finally{if(button){button.disabled=false;button.textContent="Run scan now"}}
}
function coinSpotBalanceDisplay(value){const n=Number(value);if(!Number.isFinite(n))return "Unavailable";const clean=Math.abs(n)<1e-8?0:Math.max(0,n);return clean.toFixed(8).replace(/\.?0+$/,"")||"0";}
function renderCoinSpotPortfolio(balances){
 const rows=balances.map(x=>({...x,audValue:Number(x.audValue)})).filter(x=>Number.isFinite(x.audValue)&&x.audValue>0).sort((a,b)=>b.audValue-a.audValue);
 const total=rows.reduce((sum,x)=>sum+x.audValue,0), summary=$("coinSpotPortfolioSummary");
 if(!summary)return;
 if(!rows.length){summary.innerHTML='<div class="portfolio-summary"><div><small>COINSPOT ACCOUNT VALUE</small><strong>Unavailable</strong><p>CoinSpot did not provide usable AUD valuations for these balances.</p></div></div>';return;}
 summary.innerHTML=`<div class="portfolio-summary"><div class="portfolio-total"><small>COINSPOT ACCOUNT VALUE · AUD</small><strong>${esc(money(total,"AUD"))}</strong><p>${rows.length} assets with reported AUD valuations · read-only snapshot</p></div><div class="portfolio-allocation"><div class="portfolio-subheading">ASSET ALLOCATION</div>${rows.map(x=>{const pct=x.audValue/total*100;return `<div class="allocation-row"><div class="allocation-label"><b>${esc(x.coin)}</b><span>${esc(money(x.audValue,"AUD"))} · ${pct.toFixed(1)}%</span></div><div class="allocation-track"><span style="width:${pct.toFixed(2)}%"></span></div></div>`}).join("")}</div><p class="portfolio-disclaimer">This is the value of balances returned by CoinSpot, not a complete net-worth figure. It excludes other exchanges, wallets, liabilities and assets.</p></div>`;
}
async function loadCoinSpotAccount(){const status=$("coinSpotAccountStatus"),container=$("coinSpotBalances"),orders=$("coinSpotOrders");if(!status||!container)return;status.textContent="Checking CoinSpot read-only API…";try{const a=await api("/api/coinspot/account");const balances=(Array.isArray(a.balances)?a.balances:[]).map(x=>({...x,balance:Number(x.balance)})).filter(x=>Number.isFinite(x.balance)&&x.balance>1e-8);renderCoinSpotPortfolio(balances);container.innerHTML=balances.length?balances.map(x=>`<article class="integration"><b>${esc(x.coin)}</b><small>Balance: ${esc(coinSpotBalanceDisplay(x.balance))}</small><small>AUD value: ${x.audValue==null?"Unavailable":esc(money(Math.max(0,Number(x.audValue)||0),"AUD"))}</small></article>`).join(""):'<div class="empty">No material balances returned. Tiny residual amounts are hidden as account dust.</div>';const buys=Array.isArray(a.openBuyOrders)?a.openBuyOrders.length:0,sells=Array.isArray(a.openSellOrders)?a.openSellOrders.length:0;orders.innerHTML=`<div class="market-row"><div><b>Open AUD orders</b><div class="market-meta">${buys} buy orders · ${sells} sell orders</div></div><b>READ ONLY</b></div>`;status.textContent="✓ CoinSpot read-only account connected · "+formatDateTime(a.retrievedAt,$("auTimezone")?.value);status.classList.add("connected");}catch(e){status.textContent="Not connected: "+e.message;status.classList.remove("connected");container.innerHTML='<div class="empty">Account data unavailable. Check the connection and retry; API credentials are managed securely in Cloudflare.</div>';const summary=$("coinSpotPortfolioSummary");if(summary)summary.innerHTML="";orders.innerHTML="";}}
async function loadCoinSpotPaper(){try{const a=await api("/api/crypto/coinspot/paper/account");$("cryptoPaperCash").textContent=money(a.cashAud,"AUD");$("cryptoPaperRealized").textContent=money(a.realizedPnlAud,"AUD");$("cryptoPaperUnrealized").textContent=money(a.unrealizedPnlAud||0,"AUD");$("cryptoPaperDailyLoss").textContent=money(a.dailyLossAud,"AUD");$("cryptoPaperPositionTitle").textContent=a.openPosition?"Open "+a.openPosition.pair+" paper position":"No open paper position";$("cryptoPaperPositionDetail").textContent=a.openPosition?"Entry "+money(a.openPosition.referenceAsk,"AUD")+" · Stop "+money(a.openPosition.stopPrice,"AUD")+" · Target "+money(a.openPosition.targetPrice,"AUD"):"No active simulated position. One position maximum; AUD 50 remains unallocated."; $("cryptoPaperCloseBtn").disabled=!a.openPosition;$("cryptoPaperHistory").innerHTML=a.closedTrades?.length?a.closedTrades.slice().reverse().slice(0,8).map(t=>`<div class="market-row"><div><b>${esc(t.pair)}</b><div class="market-meta">${esc(t.reason)} · ${esc(t.closedAt)}</div></div><b>${esc(money(t.pnlAud,"AUD"))}</b></div>`).join(""):'<div class="empty">No completed paper trades yet.</div>';$("cryptoPaperCloseBtn").onclick=closeCoinSpotPaper;}catch(e){$("cryptoPaperPositionDetail").textContent="Paper account unavailable: "+e.message;}}
async function openCoinSpotPaper(coin){const buttons=[...document.querySelectorAll("[data-paper-open]")];buttons.forEach(b=>b.disabled=true);try{await api("/api/crypto/coinspot/paper/open",{method:"POST",body:JSON.stringify({coin})});toast("Paper position opened at current CoinSpot ask.");await loadCoinSpotPaper();}catch(e){toast("Paper entry not opened: "+e.message);}finally{buttons.forEach(b=>b.disabled=false);}}
async function closeCoinSpotPaper(){const b=$("cryptoPaperCloseBtn");b.disabled=true;try{await api("/api/crypto/coinspot/paper/close",{method:"POST",body:JSON.stringify({})});toast("Paper position closed at current CoinSpot bid.");await loadCoinSpotPaper();}catch(e){toast("Paper close failed: "+e.message);b.disabled=false;}}
async function searchMarkets(cursor=null){const q=$("marketSearch").value.trim(),platform=$("venueFilter").value;const body={q,platform:platform==="all"?undefined:platform,limit:40,...(cursor?{cursor}:{})};$("marketRows").innerHTML=`<tr><td colspan="5" class="empty">Loading market data...</td></tr>`;try{const data=await api("/api/markets?"+new URLSearchParams(Object.entries(body).filter(([,v])=>v!==undefined)));const rows=(data.markets||[]).map(normalize);markets=rows;nextMarketCursor=data.next_cursor||null;$("marketRows").innerHTML=rows.length?rows.map(m=>`<tr><td><div class="table-market">${esc(m.title)}</div><div class="table-sub">${esc(m.id)} | ${esc(m.quoteType||"quote type unverified")} | ${m.observedAt?esc(formatDateTime(m.observedAt,$("auTimezone")?.value)):"time unknown"} | ${esc(m.freshness||"freshness unknown")}</div></td><td>${esc(venueLabel(m.platform))}<div class="table-sub">jurisdiction: ${esc(m.raw?.jurisdiction||"unverified")}</div></td><td>${m.yes==null?"unavailable":m.yes.toFixed(1)+"%"}</td><td>${m.volume?.amount!=null?esc(money(m.volume.amount,m.volume.currency)):"Currency unavailable"}</td><td><button class="small-btn" data-watch="${esc(m.id)}">Save</button></td></tr>`).join(""):`<tr><td colspan="5" class="empty">No markets returned for these filters.</td></tr>`;const next=$("marketNext");if(next){next.hidden=!nextMarketCursor;next.disabled=false}bindWatch();$("connectionText").textContent="Provider response received"}catch(e){nextMarketCursor=null;$("marketRows").innerHTML=`<tr><td colspan="5" class="empty">${esc(e.message)} Configure the backend and confirm credentials and venue access.</td></tr>`;if($("marketNext"))$("marketNext").hidden=true}}
if($("cryptoRefreshBtn"))$("cryptoRefreshBtn").onclick=loadCoinSpotMarkets;
$("coinSpotMtfSyncBtn")?.addEventListener("click",()=>loadCoinSpotMtfStrategy(true));
$("coinSpotMtfPaperRun")?.addEventListener("click",()=>loadCoinSpotMtfPaper(true));
$("cryptoAutoPaperRefresh")?.addEventListener("click",()=>loadAutomatedCryptoPaper(true));
loadAutomatedCryptoPaper();
$("coinSpotAccountRefresh")?.addEventListener("click",loadCoinSpotAccount);
$("searchBtn").onclick=()=>searchMarkets();if($("marketNext"))$("marketNext").onclick=()=>searchMarkets(nextMarketCursor);$("refreshBtn").onclick=()=>{if($("page-discover").classList.contains("active"))searchMarkets();else toast("Refresh markets from Discover.")};
$("screenshotInput").onchange=e=>{const f=e.target.files[0];selectedImage=f||null;$("fileName").textContent=f?f.name+" · "+Math.round(f.size/1024)+" KB":""};
async function analyze(){const question=$("marketQuestion").value.trim(),url=$("marketUrl").value.trim(),price=$("yesPrice").value; if(!question&&!url&&!selectedImage){toast("Enter a market question, URL or screenshot.");return}
const btn=$("analyzeBtn");btn.disabled=true;btn.textContent="Analyzing…";let result;
try{let imageData=null;if(selectedImage){if(selectedImage.size>5*1024*1024)throw new Error("Please use an image smaller than 5 MB.");imageData=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(selectedImage)})}
result=await api("/api/analyze",{method:"POST",body:JSON.stringify({question,url,marketPrice:price===""?null:Number(price),platform:$("analysisPlatform").value,image:imageData})});showResult(result.analysis||result,result.citations||[])
}catch(e){if(!state.backend){showResult({title:question||url||"Screenshot market",verdict:"DEMO ONLY",marketProbability:null,modelProbability:null,edge:null,confidence:"Not assessed",risk:"Not assessed",summary:"This is a sample report layout. No live market data, news research or AI inference has been performed. Configure a secure backend with market-data and AI credentials to enable real analysis.",evidence:["Demo mode is active.","No external sources were queried."],risks:["Do not use this sample to make a trading decision."],invalidation:["Run the analysis again after configuring integrations."]})}else{const panel=$("analysisResult");panel.classList.remove("hidden");panel.innerHTML=`<div class="analysis-error" role="alert"><h3>Analysis could not complete</h3><p>${esc(e.message||"Unknown analysis error.")}</p><p class="muted">Your question has not been submitted successfully. Check the connection and retry.</p><button class="secondary-btn" type="button" id="retryAnalysis">Try again</button></div>`;panel.scrollIntoView({behavior:"smooth",block:"start"});$("retryAnalysis")?.addEventListener("click",analyze)}}
finally{btn.disabled=false;btn.textContent="✳ Run AI analysis"}}
function showResult(r,citations=[]) {
 const n=value=>value==null?"Unavailable":(typeof value==="number"?value.toFixed(1):value)+(typeof value==="number"?"%":"");const items=value=>Array.isArray(value)?value:[];
 const links=items(citations).filter(c=>{try{return new URL(c.url).protocol==="https:"}catch{return false}}).map(c=>`<li><a class="source-link" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title||c.url)}</a></li>`).join("");
 $("analysisResult").classList.remove("hidden");$("analysisResult").innerHTML=`<div class="result-top"><div><div class="eyebrow">RESEARCH PROBABILITY ? NOT A MARKET QUOTE</div><h3>${esc(r.title||r.question||"Market analysis")}</h3></div><span class="verdict">${esc(r.verdict||"RESEARCH ONLY")}</span></div><div class="result-stats"><div class="result-stat"><small>OBSERVED MARKET PRICE</small><b>${n(r.marketProbability??r.marketPrice)}</b></div><div class="result-stat"><small>MODEL-GENERATED ESTIMATE</small><b>${n(r.modelProbability)}</b></div><div class="result-stat"><small>RESEARCH EDGE BEFORE COSTS</small><b>${r.edge==null?"Unavailable":(r.edge>0?"+":"")+Number(r.edge).toFixed(1)+" points"}</b></div></div><div class="result-section"><h4>EXECUTIVE SUMMARY</h4><p>${esc(r.summary||"No summary returned.")}</p></div><div class="result-section"><h4>EVIDENCE & CATALYSTS</h4><ul>${items(r.evidence).map(x=>`<li>${esc(x)}</li>`).join("")||"<li>No evidence returned.</li>"}</ul></div><div class="result-section"><h4>KEY RISKS</h4><ul>${items(r.risks).map(x=>`<li>${esc(x)}</li>`).join("")||"<li>No risks returned.</li>"}</ul></div><div class="result-section"><h4>INVALIDATION CONDITIONS</h4><ul>${items(r.invalidation).map(x=>`<li>${esc(x)}</li>`).join("")||"<li>Reassess when material new information emerges.</li>"}</ul></div><div class="result-section"><h4>SOURCES</h4><ul>${links||"<li>No source citations returned. Claims are unverified.</li>"}</ul></div><div class="result-section"><h4>CONFIDENCE & LIMITATIONS</h4><p>Confidence: ${esc(r.confidence||"Not provided")} | Risk: ${esc(r.risk||"Not provided")}</p><p>AI estimates are uncertain and may be wrong. Verify all claims, source dates and resolution rules independently.</p></div>`;$("analysisResult").scrollIntoView({behavior:"smooth",block:"start"})
}
$("analyzeBtn").onclick=analyze;
$("paperAdd").onclick=()=>{const q=$("paperQuestion").value.trim(),price=Number($("paperPrice").value),stake=Number($("paperStake").value),side=$("paperSide").value;if(!q||price<1||price>99||stake<=0||!Number.isFinite(stake)){toast("Enter a question, valid price and stake.");return}if(stake>state.balance){toast("Stake exceeds virtual balance.");return}state.balance-=stake;state.positions.unshift({question:q,price,stake,side,closed:false,created:Date.now()});save();render();$("paperQuestion").value="";$("paperPrice").value="";$("paperStake").value="";toast("Simulated position added.")};
$("resetPaper").onclick=()=>{if(!confirm("Reset all paper positions and restore the $10,000 virtual balance?"))return;state.positions=[];state.balance=10000;state.realized=0;save();render();toast("Paper trading reset.")};
$("saveSettings").onclick=()=>{try{state.backend=$("backendUrl").value.trim()?normalizeBackendUrl($("backendUrl").value.trim()):"";save();$("connectionText").textContent=state.backend?"Backend URL saved":"Demo data mode";toast("Backend URL saved.")}catch(error){$("settingsStatus").textContent=error.message}};
$("testConnection").onclick=async()=>{try{const d=await api("/api/health");$("settingsStatus").textContent="Connected | Crypto market data: public Binance API | AI: "+(d.providers?.ai?"key configured":"key missing")+" | storage: "+(d.providers?.storage?"configured":"not configured");$("connectionText").textContent="Backend connected"}catch(e){$("settingsStatus").textContent=e.message}};
async function runApiHealthCheck(panel){if(!panel)return;panel.textContent="Checking authenticated Worker and provider configuration...";try{const data=await api("/api/health");panel.innerHTML=`<div class="position-card"><b>Worker</b><span>${esc(data.status||"unknown")}</span></div><div class="position-card"><b>CoinSpot read-only secrets</b><span>${data.providers?.coinSpotReadOnly?"both configured":"missing one or both"}</span></div><div class="position-card"><b>Crypto market data</b><span>Public Binance API (no key required)</span></div><div class="position-card"><b>Prediction-market provider key</b><span>${data.providers?.predictionMarkets?"configured":"missing"}</span></div><div class="position-card"><b>AI provider key</b><span>${data.providers?.ai?"configured":"missing"}</span></div><div class="position-card"><b>ASX paper autopilot</b><span>${data.asxAutopilot?.configured?"configured":"incomplete"}${data.asxAutopilot?.enabled?" · enabled":" · disabled"}</span></div><div class="position-card"><b>KV storage</b><span>${data.providers?.storage?"configured":"not configured"}</span></div><div class="position-card"><b>Real-money trading</b><span>disabled</span></div><h3>Australian sources</h3>${Object.entries(data.australianSources||{}).map(([name,status])=>`<div class="position-card"><b>${esc(name)}</b><span>${esc(status)}</span></div>`).join("")}<p class="muted tiny">Configuration is not a live integration test. Run each source page after deployment and inspect retrieval status and data timestamps.</p>`}catch(error){panel.textContent=error.message}}
$("refreshHealth")?.addEventListener("click",()=>runApiHealthCheck($("apiHealthResult")));
$("refreshHealthSettings")?.addEventListener("click",()=>runApiHealthCheck($("apiHealthSettingsResult")));
$("backendUrl").value=state.backend;
if("serviceWorker" in navigator){
 window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").then(reg=>{
  if(reg.waiting)showSwUpdate(reg);
  reg.addEventListener("updatefound",()=>{const worker=reg.installing;worker?.addEventListener("statechange",()=>{if(worker.state==="installed"&&reg.active)showSwUpdate(reg)})});
 }).catch(()=>{}));
 let reloaded=false;navigator.serviceWorker.addEventListener("controllerchange",()=>{if(!reloaded){reloaded=true;location.reload()}})
}
function showSwUpdate(reg){
 if(document.getElementById("swUpdateNotice"))return;
 const notice=document.createElement("button");notice.id="swUpdateNotice";notice.className="primary-btn";notice.textContent="A new EDGE version is ready | Update";notice.style.cssText="position:fixed;z-index:1000;right:1rem;bottom:1rem";
 notice.onclick=()=>{
  const worker=reg.waiting;if(!worker)return;
  notice.disabled=true;notice.textContent="Updating EDGE…";
  const channel=new MessageChannel();
  const retry=setTimeout(()=>{channel.port1.close();notice.disabled=false;notice.textContent="Update ready | Retry"},10000);
  channel.port1.onmessage=()=>{clearTimeout(retry);channel.port1.close();notice.textContent="Restarting EDGE…"};
  try{worker.postMessage({type:"SKIP_WAITING"},[channel.port2])}catch{clearTimeout(retry);channel.port1.close();notice.disabled=false;notice.textContent="Update ready | Retry"}
 };
 document.body.append(notice)
}
render();

// EDGE Intelligence expansion: server scanner, cited research, price-history replay, forecast calibration and alert settings.
const edgeExtra = {
  forecasts: normalizeForecasts(storageValue("edge-forecasts-v1",[])),
  alertRules: validateAlertRules(storageValue("edge-alert-rules-v1",{minRoi:3,minSize:25}))||{minRoi:3,minSize:25}
};
function safeNum(v){const n=Number(v);return Number.isFinite(n)?n:null}
function esc2(s){return esc(s)}
async function getExtra(path,opts={}){return api(path,opts)}
function renderForecasts(){
 const list=$("forecastLedger"); if(!list)return;
 const resolved=edgeExtra.forecasts.filter(x=>x.outcome!==null);
 const brier=brierScore(resolved);
 list.innerHTML=edgeExtra.forecasts.length?edgeExtra.forecasts.map((f,i)=>`<div class="position-card"><div><b>${esc2(f.question)}</b><div class="market-meta">Forecast ${f.probability}% · ${esc2(f.horizon||"No horizon")} · ${f.outcome===null?"OPEN":f.outcome===1?"RESOLVED YES":"RESOLVED NO"}</div></div>${f.outcome===null?`<div><button class="small-btn" data-resolve="${i}" data-outcome="1">Resolve YES</button> <button class="small-btn" data-resolve="${i}" data-outcome="0">Resolve NO</button></div>`:""}</div>`).join(""):'<div class="empty">No forecasts saved yet.</div>';
 $("calibrationStats").textContent=resolved.length?`Resolved forecasts: ${resolved.length} · Brier score: ${brier.toFixed(4)} (lower is better; 0 is perfect, 0.25 is climatological 50/50 baseline).`:"No resolved forecasts yet. Resolve forecasts only after the outcome is independently verified.";
 document.querySelectorAll("[data-resolve]").forEach(b=>b.onclick=()=>{const i=Number(b.dataset.resolve);edgeExtra.forecasts[i].outcome=Number(b.dataset.outcome);localStorage.setItem("edge-forecasts-v1",JSON.stringify(edgeExtra.forecasts));renderForecasts()});
}
function renderCitedResearch(data,target){
 const r=data.report||data;
 const citations=(data.citations||r.citations||[]).filter(c=>{try{return new URL(c.url).protocol==="https:"}catch{return false}});
 const citationHtml=citations.map((c,i)=>`<li><a class="source-link" href="${esc2(c.url||"#")}" target="_blank" rel="noopener">${esc2(c.title||c.url||"Source "+(i+1))}</a>${c.published_at?" · "+esc2(c.published_at):""}</li>`).join("");
 target.innerHTML=`<div class="result-top"><div><div class="eyebrow">EVIDENCE REPORT</div><h3>${esc2(r.question||r.title||"Research findings")}</h3></div><span class="verdict">${esc2(r.confidence||"UNCERTAINTY NOTED")}</span></div><div class="result-stats"><div class="result-stat"><small>ESTIMATE</small><b>${r.probability_range?esc2(r.probability_range):r.probability==null?"Not assessed":esc2(r.probability)+"%"}</b></div><div class="result-stat"><small>MARKET PRICE</small><b>${r.market_price==null?"—":esc2(r.market_price)+"%"}</b></div><div class="result-stat"><small>ESTIMATED EDGE</small><b>${r.edge_points==null?"—":(r.edge_points>0?"+":"")+esc2(r.edge_points)+" pts"}</b></div></div><div class="result-section"><h4>EXECUTIVE VIEW</h4><p>${esc2(r.summary||"No summary returned.")}</p></div><div class="result-section"><h4>YES CASE</h4><ul class="report-list">${(r.yes_case||[]).map(x=>`<li>${esc2(x)}</li>`).join("")}</ul></div><div class="result-section"><h4>NO CASE</h4><ul class="report-list">${(r.no_case||[]).map(x=>`<li>${esc2(x)}</li>`).join("")}</ul></div><div class="result-section"><h4>BASE RATES & ASSUMPTIONS</h4><ul class="report-list">${(r.base_rates_and_assumptions||[]).map(x=>`<li>${esc2(x)}</li>`).join("")}</ul></div><div class="result-section"><h4>WHAT WOULD CHANGE THE VIEW</h4><ul class="report-list">${(r.invalidation||[]).map(x=>`<li>${esc2(x)}</li>`).join("")}</ul></div><div class="result-section"><h4>LIMITATIONS</h4><p>${esc2((r.limitations||[]).join(" · ")||"Verify every source and the exact resolution criteria.")}</p></div><div class="result-section"><h4>SOURCES</h4><ul class="report-list">${citationHtml||"<li>No citations were returned. Treat claims as unverified.</li>"}</ul></div>`;
 target.classList.remove("hidden");
}
$("researchBtn")?.addEventListener("click",async()=>{
 const question=$("researchQuestion").value.trim();if(!question){toast("Enter a market question first.");return}
 const btn=$("researchBtn");btn.disabled=true;btn.textContent="Researching…";
 try{const d=await getExtra("/api/research",{method:"POST",body:JSON.stringify({question,rules:$("researchRules").value,marketPrice:safeNum($("researchPrice").value)})});renderCitedResearch(d,$("researchResult"))}
 catch(e){toast(e.message)}finally{btn.disabled=false;btn.textContent="✳ Research with live sources"}
});
$("backtestBtn")?.addEventListener("click",async()=>{
 const platform=$("btPlatform").value,marketId=$("btMarketId").value.trim(),days=Math.max(1,Math.min(90,Number($("btDays").value)||30)),interval=$("btInterval").value;
 if(!marketId){toast("Enter a platform market ID.");return}
 const btn=$("backtestBtn");btn.disabled=true;btn.textContent="Replaying…";
 try{const d=await getExtra("/api/backtest",{method:"POST",body:JSON.stringify({platform,marketId,days,interval})});const r=d.result||{};
 $("backtestResult").classList.remove("hidden");$("backtestResult").innerHTML=`<div class="result-stats"><div class="result-stat"><small>CANDLES</small><b>${r.candles??0}</b></div><div class="result-stat"><small>BUY & HOLD CHANGE</small><b>${r.buyHoldPct==null?"—":r.buyHoldPct.toFixed(2)+"%"}</b></div><div class="result-stat"><small>MAX DRAWDOWN</small><b>${r.maxDrawdownPct==null?"—":r.maxDrawdownPct.toFixed(2)+"%"}</b></div></div><div class="result-section"><h4>REPLAY METHOD</h4><p>${esc2(r.method||"Historical candle replay")}</p><p>${esc2(r.warning||"Mark-to-market replay is not a resolved-contract backtest and excludes real execution costs unless supplied.")}</p></div><div class="result-section"><h4>DATA WINDOW</h4><p>${esc2(r.from||"")} → ${esc2(r.to||"")} · ${esc2(interval)} · ${esc2(platform)} / ${esc2(marketId)}</p></div>`}
 catch(e){toast(e.message)}finally{btn.disabled=false;btn.textContent="Run replay"}
});
$("saveForecast")?.addEventListener("click",()=>{
 const question=$("forecastQuestion").value.trim(),p=safeNum($("forecastProbability").value);if(!question||p===null||p<0||p>100){toast("Enter a question and probability from 0 to 100.");return}
 edgeExtra.forecasts.unshift({question,probability:p,horizon:$("forecastHorizon").value.trim(),outcome:null,createdAt:new Date().toISOString()});
 localStorage.setItem("edge-forecasts-v1",JSON.stringify(edgeExtra.forecasts));$("forecastQuestion").value="";$("forecastProbability").value="";$("forecastHorizon").value="";renderForecasts();toast("Forecast saved.")
});
async function loadAlertRules(){if(!state.backend)return;try{const data=await getExtra("/api/alert-rules");const rules=validateAlertRules(data);if(rules){edgeExtra.alertRules=rules;$("alertMinRoi").value=rules.minRoi;$("alertMinSize").value=rules.minSize;$("alertStatus").textContent="Loaded alert thresholds for the authenticated user."}}catch(error){$("alertStatus").textContent="User settings could not be loaded: "+error.message}}
$("saveAlertRules")?.addEventListener("click",async()=>{const rules=validateAlertRules({minRoi:$("alertMinRoi").value,minSize:$("alertMinSize").value});if(!rules){$("alertStatus").textContent="Enter a ROI from 0 to 100 and a provider size up to 10,000,000 USD.";return}edgeExtra.alertRules=rules;localStorage.setItem("edge-alert-rules-v1",JSON.stringify(rules));try{await getExtra("/api/alert-rules",{method:"POST",body:JSON.stringify(rules)});$("alertStatus").textContent="Rules saved for the authenticated user."}catch(e){$("alertStatus").textContent="Saved locally. Server persistence may be unavailable: "+e.message}});
$("runScan")?.addEventListener("click",async()=>{const b=$("runScan");b.disabled=true;b.textContent="Scanning...";try{const d=await getExtra("/api/scan",{method:"POST",body:JSON.stringify({minRoi:edgeExtra.alertRules.minRoi,minSize:edgeExtra.alertRules.minSize})});const items=d.opportunities||[];$("alertFeed").innerHTML=items.length?items.map(o=>`<div class="market-row"><div><div class="market-title">${esc2(o.title||o.group_title||"Cross-venue research candidate")}</div><div class="market-meta">${esc2((o.legs||[]).map(l=>l.platform+" "+l.side+" "+l.price).join(" | "))}</div><small>${esc2(o.screen_status||"RESEARCH_ONLY")} ? Simulated cross-venue candidate ? Not executable</small><div class="market-meta">${esc2(o.roi_basis||"Provider ROI estimate; not independently cost-adjusted.")}</div></div><div class="prob">${Number(o.roi_pct||0).toFixed(2)}%<small>PROVIDER ROI ESTIMATE</small></div><span class="edge-pill">${o.max_wager_usd!=null?formatMoney(o.max_wager_usd,"USD")+" provider size":"Liquidity unavailable"}</span></div>`).join(""):`<div class="empty">No qualifying provider candidates returned. This is not evidence that no opportunities exist. No candidate was verified executable.</div>`}catch(e){$("alertFeed").innerHTML=`<div class="empty">${esc2(e.message)}</div>`}finally{b.disabled=false;b.textContent="Run scan now"}});
if($("localDateBanner"))$("localDateBanner").textContent=new Intl.DateTimeFormat("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric",timeZone:$("auTimezone")?.value||"Australia/Perth"}).format(new Date()).toUpperCase()+" | AUSTRALIAN MARKET INTELLIGENCE";
$("auTimezone")?.addEventListener("change",()=>{state.timeZone=$("auTimezone").value;save();if($("localDateBanner"))$("localDateBanner").textContent=new Intl.DateTimeFormat("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric",timeZone:$("auTimezone").value}).format(new Date()).toUpperCase()+" | AUSTRALIAN MARKET INTELLIGENCE"});
if($("loadAustralia"))$("loadAustralia").onclick=loadAustralia;
async function loadAustralia(){const city=$("auCity").value;$("australiaStatus").textContent="Checking official source adapters...";try{const flow=$("absFlow").value.trim()||"CPI_H";const data=await api("/api/au/dashboard?"+new URLSearchParams({city,flow}));const sections=data.sections||{};const entries=[["RBA cash rate",sections.rbaCashRate],["RBA releases",sections.rbaReleases],["ABS indicators",sections.abs],["BOM observations",sections.bom],["AEC results",sections.aec],["ASX",sections.asx],["FEX Global",sections.fex]];$("australiaCards").innerHTML=entries.map(([name,item])=>{const records=item?.records||[];const detail=records.slice(0,8).map(r=>`<div class="market-meta">${esc(r.metric||r.title||r.location||name)}: ${esc(r.value??r.temperatureC??"")} ${esc(r.unit||"C")} | period ${esc(r.observationPeriod||"not stated")} | published ${r.publishedAt?esc(formatDateTime(r.publishedAt,$("auTimezone").value)):"not stated"} | retrieved ${r.retrievedAt?esc(formatDateTime(r.retrievedAt,$("auTimezone").value)):"not available"} | source timezone ${esc(r.sourceTimezone||"not stated")} | <a href="${esc(r.sourceUrl||item?.sourceUrl||"#")}" target="_blank" rel="noopener">official source</a></div>`).join("");const context=records[0]?`${records[0].metric||records[0].title||records[0].location||name}: ${records[0].value??records[0].temperatureC??""} ${records[0].unit||""}; observation period ${records[0].observationPeriod||"not stated"}; published ${records[0].publishedAt||"not stated"}; source ${records[0].sourceUrl||item?.sourceUrl||"not supplied"}`:"No data record returned; only source metadata is available.";return `<article class="panel"><h3>${esc(name)}</h3><p>${esc(item?.status||"not configured")}</p>${detail||`<p>${esc(item?.message||item?.licensing||item?.sourceUrl||"No live data returned; source not integrated.")}</p>`}<button class="secondary-btn" data-research-source="${esc(name)}" data-research-context="${esc(context)}">Research relationship to Australian forecasts</button></article>`}).join("");document.querySelectorAll("[data-research-source]").forEach(button=>button.onclick=()=>{nav("research");$("researchQuestion").value=`How might the verified Australian ${button.dataset.researchSource} information affect relevant market forecasts?`;$("researchRules").value=button.dataset.researchContext});$("australiaStatus").textContent="Source retrieval completed at "+formatDateTime(data.retrieved_at,$("auTimezone").value)+" local time. Each card reports its status; empty records are not data."}catch(error){$("australiaStatus").textContent="Australian dashboard could not load: "+error.message}}
if($("alertMinRoi")){$("alertMinRoi").value=edgeExtra.alertRules.minRoi;$("alertMinSize").value=edgeExtra.alertRules.minSize}
renderForecasts();

// Personal ASX paper-trading desk. CSV import is the data boundary until a licensed feed is configured.
const ASX_STORE = "edge-asx-paper-v1";
const asxStored = storageValue(ASX_STORE, null);
let asxPortfolio = asxStored?.mode === "PAPER_ONLY" && asxStored?.liveTradingEnabled === false ? asxStored : createPaperPortfolio();
let asxUniverse = {};
let asxCandidates = [];
function saveAsx(){try{localStorage.setItem(ASX_STORE,JSON.stringify(asxPortfolio))}catch{toast("ASX paper ledger could not be saved in browser storage.")}}
function aud(value){return new Intl.NumberFormat("en-AU",{style:"currency",currency:"AUD"}).format(Number(value)||0)}
function renderAsxDesk(){
 const open=asxPortfolio.positions.filter(p=>p.status==="OPEN_PAPER");
 const realized=asxPortfolio.closedTrades.reduce((s,p)=>s+(Number(p.profitLossAud)||0),0);
 const unrealized=open.reduce((s,p)=>s+(markPaperPosition(p,p.lastMarkPrice||p.entryPrice)?.unrealizedProfitLossAud||0),0);
 const equity=calculatePaperPortfolioEquity(asxPortfolio);
 $("asxCash").textContent=aud(asxPortfolio.cashAud);$("asxEquity").textContent=equity===null?"Unavailable":aud(equity);
 $("asxRealized").textContent=aud(realized);$("asxUnrealized").textContent=aud(unrealized);
 $("asxPositions").textContent=open.length;
 $("asxCandidates").innerHTML=asxCandidates.length?asxCandidates.map((c,i)=>`<div class="position-card"><div><b>${esc(c.symbol)} · ${esc(c.status)}</b><div class="market-meta">${esc(c.reason)} · ${esc(c.source||"")}</div>${c.status==="PAPER_CANDIDATE"?`<div class="market-meta">Ref ${aud(c.entryReference)} · ${c.shares} shares · stop ${aud(c.stopPrice)} · target ${aud(c.targetPrice)} · est. target net ${aud(c.estimatedNetTargetProfitAud)} · RR ${c.rewardRiskAfterCosts}:1</div>`:""}</div>${c.status==="PAPER_CANDIDATE"?`<button class="small-btn" data-asx-open="${i}">Open paper position</button>`:""}</div>`).join(""):'<div class="empty">Connect DataCedar historical daily bars or import an authorised ASX daily OHLC CSV to scan. No real-time ASX feed is connected.</div>';
 document.querySelectorAll("[data-asx-open]").forEach(b=>b.onclick=()=>{const c=asxCandidates[Number(b.dataset.asxOpen)];const result=openPaperPosition(asxPortfolio,c);if(!result.accepted){toast(result.reason);return}asxPortfolio=result.portfolio;saveAsx();renderAsxDesk();toast("Paper position opened. No broker order was sent.")});
 $("asxOpenList").innerHTML=open.length?open.map(p=>{const mark=markPaperPosition(p,p.lastMarkPrice||p.entryPrice);return `<div class="position-card"><div><b>${esc(p.symbol)} · ${p.shares} shares</b><div class="market-meta">Entry ${aud(p.entryPrice)} · Stop ${aud(p.stopPrice)} · Target ${aud(p.targetPrice)} · Last mark ${esc(p.lastMarkedAt||"Not marked yet")} · Est. unrealized ${aud(mark?.unrealizedProfitLossAud)}</div><label class="field-label">MANUAL PAPER MARK / EXIT PRICE <input type="number" step="0.001" min="0.001" data-asx-price="${esc(p.id)}" value="${Number(p.lastMarkPrice||p.entryPrice)}"></label></div><div class="position-actions"><button class="small-btn" data-asx-mark="${esc(p.id)}">Save mark</button><button class="small-btn" data-asx-close="${esc(p.id)}">Close paper position</button></div></div>`}).join(""):'<div class="empty">No open ASX paper positions.</div>';
 document.querySelectorAll("[data-asx-mark]").forEach(b=>b.onclick=()=>{const p=asxPortfolio.positions.find(x=>x.id===b.dataset.asxMark);const input=p&&document.querySelector("[data-asx-price=\""+CSS.escape(p.id)+"\"]");if(!p||!input)return;const result=recordPaperMark(asxPortfolio,p.id,Number(input.value));if(!result.accepted){toast(result.reason);return}asxPortfolio=result.portfolio;saveAsx();renderAsxDesk();toast("Paper mark saved. Cash and realized P&L are unchanged.")});
 document.querySelectorAll("[data-asx-close]").forEach(b=>b.onclick=()=>{const p=asxPortfolio.positions.find(x=>x.id===b.dataset.asxClose);const input=document.querySelector(`[data-asx-price="${CSS.escape(p.id)}"]`);const result=closePaperPosition(asxPortfolio,p.id,Number(input.value));if(!result.accepted){toast(result.reason);return}asxPortfolio=result.portfolio;saveAsx();renderAsxDesk();toast("Position closed in paper ledger only.")});
 $("asxHistory").innerHTML=asxPortfolio.closedTrades.length?asxPortfolio.closedTrades.slice().reverse().map(p=>`<div class="position-card"><div><b>${esc(p.symbol)} · ${p.shares} shares</b><div class="market-meta">Entry ${aud(p.entryPrice)} · Exit ${aud(p.exitPrice)} · ${esc(p.closedAt)}</div></div><b>${aud(p.profitLossAud)}</b></div>`).join(""):'<div class="empty">No closed trades yet.</div>';
}
$("asxImportBtn")?.addEventListener("click",()=>{
 const file=$("asxCsvFile").files[0],source=$("asxSource").value.trim();
 if(!file||!source||$("asxConfirmData")?.checked!==true){toast("Choose a CSV, name its source, and confirm AUD denomination and data-use rights.");return}
 asxUniverse={};
 asxCandidates=[];
 renderAsxDesk();
 if(file.size>5*1024*1024){$("asxImportStatus").textContent="CSV must be smaller than 5 MB.";return}
 $("asxImportStatus").textContent="Reading CSV. Previous import candidates have been cleared.";
 const reader=new FileReader();
 reader.onload=()=>{
  const parsed=parseAsxDailyCsv(String(reader.result||""),{currency:"AUD"});
  if(!parsed.valid){$("asxImportStatus").textContent=parsed.reason;renderAsxDesk();return}
  asxUniverse=parsed.barsBySymbol;
  asxCandidates=parsed.symbols.map(symbol=>evaluateAsxSwingSetup({symbol,bars:asxUniverse[symbol],source,currency:"AUD",observedAt:asxUniverse[symbol].at(-1).timestamp,equityAud:calculatePaperPortfolioEquity(asxPortfolio)??0,cashAud:asxPortfolio.cashAud,openPositions:asxPortfolio.positions.filter(p=>p.status==="OPEN_PAPER").length}));
  $("asxImportStatus").textContent=`Imported ${parsed.rows} daily bars for ${parsed.symbols.length} ASX tickers. Latest bar: ${formatDateTime(parsed.latestBar,"Australia/Perth")}. Source label is user-declared and has not been independently verified.`;
  renderAsxDesk();
 };
 reader.onerror=()=>{
  asxUniverse={};
  asxCandidates=[];
  $("asxImportStatus").textContent="Could not read CSV file.";
  renderAsxDesk();
 };
 reader.readAsText(file);
});
$("asxDataCedarBtn")?.addEventListener("click",async()=>{
 const button=$("asxDataCedarBtn"),symbols=$("asxDataCedarSymbols").value.trim();
 if(!symbols){$("asxImportStatus").textContent="Enter one to three ASX tickers, for example BHP,CBA,CSL.";return}
 button.disabled=true;button.textContent="Fetching DataCedar history…";
 try{
  const data=await api("/api/asx/datacedar/bars?"+new URLSearchParams({symbols}));
  if(data.status==="no_data"||!data.rows){$("asxImportStatus").textContent="DataCedar returned no daily bars for the requested tickers. No sample data was substituted.";asxCandidates=[];renderAsxDesk();return}
  asxUniverse=data.barsBySymbol||{};
  $("asxSource").value="DataCedar ASX historical daily bars";
  $("asxWalkForwardResults").innerHTML="";
  const markUpdate=updatePaperMarksFromBars(asxPortfolio,asxUniverse);
  if(markUpdate.markedSymbols.length){asxPortfolio=markUpdate.portfolio;saveAsx()}
  asxCandidates=(data.symbols||[]).filter(symbol=>(asxUniverse[symbol]||[]).length>0).map(symbol=>evaluateAsxSwingSetup({
   symbol,bars:asxUniverse[symbol],source:"DataCedar ASX historical daily bars",currency:"AUD",
   observedAt:asxUniverse[symbol].at(-1).timestamp,equityAud:calculatePaperPortfolioEquity(asxPortfolio)??0,
   cashAud:asxPortfolio.cashAud,openPositions:asxPortfolio.positions.filter(p=>p.status==="OPEN_PAPER").length
  }));
  const counts=Object.entries(data.rowsBySymbol||{}).map(([symbol,count])=>symbol+": "+count+" bars").join("; ");
  $("asxImportStatus").textContent="DataCedar response validated. "+counts+". Latest daily bar: "+(data.latestBar?formatDateTime(data.latestBar,"Australia/Perth"):"not supplied")+". "+(markUpdate.markedSymbols.length?"Updated paper marks for "+markUpdate.markedSymbols.join(", ")+"; cash and realised P&L unchanged. ":"No open positions received a newer eligible mark. ")+"Historical daily data only; not a real-time quote. "+(data.disclaimer||"");
  renderAsxDesk();
 }catch(error){$("asxImportStatus").textContent="DataCedar fetch failed: "+error.message}
 finally{button.disabled=false;button.textContent="Fetch DataCedar daily bars & scan"}
});

$("asxWalkForwardBtn")?.addEventListener("click",()=>{
 const button=$("asxWalkForwardBtn"),status=$("asxWalkForwardStatus"),results=$("asxWalkForwardResults");
 const symbols=Object.keys(asxUniverse||{});
 if(!symbols.length){status.textContent="Import authorised ASX daily bars or fetch DataCedar history before running validation.";return}
 button.disabled=true;button.textContent="Running chronological validation…";status.textContent="Running fixed-rule, next-session-open walk-forward simulations. No sample data is inserted.";
 const source=$("asxSource")?.value.trim()||"DataCedar ASX historical daily bars";
 const reports=[];
 for(const symbol of symbols){
  try{
   reports.push(walkForwardAsxStrategy({
    symbol,bars:asxUniverse[symbol],source,currency:"AUD",
    startingCapitalAud:asxPortfolio.startingCapitalAud,
    trainFraction:0.6,foldCount:3,minimumOutOfSampleTrades:30
   }));
  }catch(error){reports.push({symbol,status:"BLOCKED",reason:error.message})}
 }
 const pct=value=>Number.isFinite(value)?Number(value).toFixed(2)+"%":"—";
 results.innerHTML=reports.map(report=>{
  if(report.status==="BLOCKED")return '<div class="position-card"><div><b>'+esc(report.symbol)+' · BLOCKED</b><div class="market-meta">'+esc(report.reason)+'</div></div></div>';
  const summary=report.summary||{};
  const folds=(report.folds||[]).map(fold=>'<div class="market-meta">Fold '+fold.fold+': '+fold.tradeCount+' trades · return '+pct(fold.returnPct)+' · buy/hold '+pct(fold.benchmark?.returnPct)+' · drawdown '+pct(fold.maxDrawdownPct)+'</div>').join("");
  return '<div class="position-card"><div><b>'+esc(report.symbol)+' · '+esc(summary.assessment||"UNKNOWN")+'</b><div class="market-meta">Out-of-sample trades '+(summary.totalOutOfSampleTrades??0)+' · win rate '+pct(summary.pooledWinRatePct)+' · profit factor '+(summary.pooledProfitFactor==null?"—":Number(summary.pooledProfitFactor).toFixed(2))+'</div><div class="market-meta">Mean fold return '+pct(summary.meanFoldReturnPct)+' · buy/hold reference '+pct(summary.meanBenchmarkReturnPct)+' · mean drawdown '+pct(summary.meanFoldMaxDrawdownPct)+'</div><div class="market-meta">Source: '+esc(report.source)+' · '+esc(report.data?.firstBarAt||"")+" to "+esc(report.data?.lastBarAt||"")+'</div>'+folds+'<div class="market-meta">'+esc(report.disclaimer||"")+'</div></div></div>';
 }).join("")||'<div class="empty">No walk-forward results were produced.</div>';
 status.textContent="Completed "+reports.length+" symbol validation(s). Each fold resets virtual capital; pooled results are not one compounded account. Source labels are not independently verified.";
 button.disabled=false;button.textContent="Run chronological walk-forward";
});

$("asxResetBtn")?.addEventListener("click",()=>{if(!confirm("Permanently clear the local ASX paper ledger and restore AUD 500 virtual capital?"))return;asxPortfolio=createPaperPortfolio();saveAsx();renderAsxDesk();toast("ASX paper ledger reset.")});
async function loadAsxAutopilotStatus(){
 const status=$("asxAutoStatus");if(!status)return;
 try{
  const a=await api("/api/asx/autopilot");
  const configured=a.configured===true&&Array.isArray(a.symbols)&&a.symbols.length>0;
  status.textContent=configured
   ? "AUTOMATED PAPER SCANNER "+(a.status||"CONFIGURED")+" · "+a.symbols.join(", ")+" · scans "+(a.scanCount||0)+" · last scan "+(a.lastScanAt?formatDateTime(a.lastScanAt,"Australia/Perth"):"not yet run")+" · open positions "+(a.portfolio?.positions||[]).filter(p=>p.status==="OPEN_PAPER").length+" · AI reviewer "+(a.aiReviewConfigured?"KEY CONFIGURED · NOT VERIFIED":"BLOCKED · OPENAI_API_KEY missing")
   : "AUTOMATION NOT ENABLED · Configure ASX_AUTOPILOT_ENABLED, ASX_AUTOPILOT_SYMBOLS, DataCedar key and Worker KV before running.";
  if(a.lastError)status.textContent+=" · Last provider error: "+a.lastError;
  const p=a.performance||{};
  const metric=(label,value,detail)=>'<article class="metric-card"><span>'+label+'</span><strong>'+value+'</strong><small>'+detail+'</small></article>';
  $("asxAutoPerformance").innerHTML=metric("CLOSED TRADES",String(p.tradeCount??0),"Realized sample only")+metric("WIN RATE",p.winRatePct==null?"—":p.winRatePct.toFixed(1)+"%","Wins / all closed trades")+metric("PROFIT FACTOR",p.profitFactor==null?"—":p.profitFactor.toFixed(2),"Gross profit / gross loss")+metric("NET REALIZED P&amp;L",p.totalRealizedProfitLossAud==null?"—":aud(p.totalRealizedProfitLossAud),"After simulated fees")+metric("MAX DRAWDOWN",p.maxRealizedDrawdownAud==null?"—":aud(p.maxRealizedDrawdownAud)+" · "+(p.maxRealizedDrawdownPct??0).toFixed(2)+"%","Realized equity curve only");
  $("asxAutoEvidence").textContent="Evidence: "+(p.status||"UNKNOWN")+" · "+(p.invalidTradeCount||0)+" invalid ledger records excluded · realized closed trades only; no live fills or profitability guarantee."
  const calibration=a.aiCalibration||{};const oos=calibration.outOfSample||{};const sample=calibration.outOfSampleSampleCount??0;const minimum=calibration.minimumOutOfSampleSamples??30;
  const mixedModels=calibration.status==="MIXED_MODEL_VERSIONS_SEPARATE_DIAGNOSTICS";
  const modelDiagnostics=(calibration.modelDiagnostics||[]).map(item=>item.model+": "+item.outOfSampleSampleCount+" OOS · Brier "+(item.outOfSample?.brierScore==null?"—":Number(item.outOfSample.brierScore).toFixed(4))).join("; ");
  $("asxAutoCalibration").textContent="AI win-probability audit: "+(calibration.status||"UNKNOWN")+" · "+(mixedModels?"separate per-model holdouts":"chronological holdout "+sample+"/"+minimum+" trades")+(oos.brierScore==null?"":" · Brier "+Number(oos.brierScore).toFixed(4))+(oos.expectedCalibrationError==null?"":" · calibration error "+Number(oos.expectedCalibrationError).toFixed(4))+(modelDiagnostics?" · "+modelDiagnostics:"")+" · diagnostic only; no model training or calibration claim.";
  $("asxAutoSignals").innerHTML=(a.signals||[]).slice(-12).reverse().map(s=>'<div class="market-meta"><b>'+esc(s.symbol)+' · '+esc(s.status)+'</b>'+(s.ai?.decision?' · AI '+esc(s.ai.decision)+' ('+esc(s.ai.confidence)+'% subjective confidence)':'')+(s.ai?.predictedWinProbability==null?'':' · uncalibrated win estimate '+(Number(s.ai.predictedWinProbability)*100).toFixed(0)+'%')+(s.candidateRank==null?'':' · risk rank #'+esc(s.candidateRank)+' · net R/R '+esc(s.ranking?.rewardRiskAfterCosts)+' · net target $'+esc(s.ranking?.expectedNetTargetProfitAud)+' · risk budget use '+esc(s.ranking?.riskBudgetUtilizationPct)+'%')+' · '+esc(s.reason||"No additional detail")+(s.profitLossAud==null?"":" · "+aud(s.profitLossAud))+'</div>').join("")||'<div class="empty">No automated scan results recorded.</div>';
 }catch(error){status.textContent="Automated scanner status unavailable: "+error.message}
}
$("asxAutoScanBtn")?.addEventListener("click",async()=>{
 const button=$("asxAutoScanBtn"),status=$("asxAutoStatus");button.disabled=true;button.textContent="Running paper scan…";
 try{const result=await api("/api/asx/autopilot/scan",{method:"POST",body:JSON.stringify({})});status.textContent=result.message||("Automated paper scan "+(result.status||"completed")+" · "+(result.symbols||[]).join(", "));await loadAsxAutopilotStatus();}
 catch(error){status.textContent="Automated paper scan failed: "+error.message}
 finally{button.disabled=false;button.textContent="Run automated paper scan now"}
});
renderAsxDesk();
loadAsxAutopilotStatus();
