const $ = id => document.getElementById(id);
const STORE = "edge-intelligence-v1";
const demoMarkets = [
 {id:"d1",title:"Will the RBA cut rates at its next meeting?",platform:"demo",yes:34,volume:482000,category:"Economics",estimated:43,edge:9},
 {id:"d2",title:"Will Bitcoin reach $120,000 by December 31?",platform:"demo",yes:28,volume:1250000,category:"Crypto",estimated:35,edge:7},
 {id:"d3",title:"Will the US government pass a funding bill this month?",platform:"demo",yes:71,volume:830000,category:"Politics",estimated:67,edge:-4},
 {id:"d4",title:"Will global temperatures set a new annual record?",platform:"demo",yes:58,volume:210000,category:"Climate",estimated:64,edge:6}
];
const venues = [
 ["Polymarket","polymarket","Official public market data / aggregator"],
 ["Kalshi","kalshi","Official market data / aggregator"],
 ["Manifold","manifold","Public API; play-money venue"],
 ["PredictIt","predictit","Aggregator / availability varies"],
 ["Opinion","opinion","Aggregator integration"],
 ["Predict.fun","predictfun","Aggregator integration"],
 ["Novig","novig","Sports-focused; access varies"],
 ["ProphetX","prophetx","Provider integration may be required"],
 ["Limitless","limitless","Direct adapter planned"],
 ["Metaculus","metaculus","Forecasting data adapter planned"]
];
let state = loadState();
let markets = demoMarkets.slice();
let selectedImage = null;
function loadState(){try{return Object.assign({backend:"",watchlist:[],positions:[],balance:10000,realized:0},JSON.parse(localStorage.getItem(STORE)||"{}"))}catch{return {backend:"",watchlist:[],positions:[],balance:10000,realized:0}}}
function save(){localStorage.setItem(STORE,JSON.stringify(state))}
function money(n){return new Intl.NumberFormat("en-AU",{style:"currency",currency:"AUD"}).format(Number(n)||0)}
function toast(msg){const t=$("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2400)}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function nav(page){document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id==="page-"+page));document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===page));$("pageCrumb").textContent=page.replace(/^\w/,c=>c.toUpperCase()).replace("-"," ");window.scrollTo(0,0)}
document.querySelectorAll("[data-page]").forEach(b=>b.addEventListener("click",()=>nav(b.dataset.page)));
document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>nav(b.dataset.goto)));
$("dismissNotice").onclick=()=>{$("dismissNotice").closest(".notice").remove()};
function venueLabel(v){return String(v||"unknown").replace(/[_-]/g," ").replace(/^\w/,c=>c.toUpperCase())}
function normalize(m){const nested=m.price&&typeof m.price==="object"?m.price:{};const p=Number(m.yes_price??m.yesPrice??nested.last_price??m.last_price??m.probability);return {id:String(m.market_id??m.id??Math.random()),title:m.event_title?`${m.event_title} — ${m.title}`:(m.title??m.question??m.name??"Untitled market"),platform:m.platform??m.venue??"unknown",yes:Number.isFinite(p)?(p<=1?p*100:p):null,volume:Number(nested.volume??m.volume??m.volume_24h??0),raw:m}}
function marketCard(m){const w=state.watchlist.some(x=>x.id===m.id);return `<div class="market-row"><div><div class="market-title">${esc(m.title)}</div><div class="market-meta">${esc(venueLabel(m.platform))} · ${m.volume?money(m.volume)+" volume":"Volume unavailable"}</div></div><div class="prob">${m.yes==null?"—":m.yes.toFixed(1)+"%"}<small>YES PRICE</small></div><button class="small-btn" data-watch="${esc(m.id)}">${w?"★ Saved":"☆ Save"}</button></div>`}
function bindWatch(){document.querySelectorAll("[data-watch]").forEach(b=>b.onclick=()=>{const m=markets.find(x=>x.id===b.dataset.watch)||state.watchlist.find(x=>x.id===b.dataset.watch);if(!m)return;const i=state.watchlist.findIndex(x=>x.id===m.id);if(i>=0)state.watchlist.splice(i,1);else state.watchlist.push(m);save();render()})}
function render(){const ranked=demoMarkets.slice().sort((a,b)=>Math.abs(b.edge)-Math.abs(a.edge));$("radarList").innerHTML=ranked.slice(0,4).map(m=>`<div class="market-row"><div><div class="market-title">${esc(m.title)}</div><div class="market-meta">DEMO EXAMPLE · MODEL ILLUSTRATION</div></div><div class="prob">${m.estimated}%<small>MODEL ESTIMATE</small></div><span class="edge-pill">${m.edge>0?"+":""}${m.edge} pts</span></div>`).join("");
$("metricMarkets").textContent=state.backend?"Provider connected":"Demo";$("metricOpps").textContent=ranked.filter(x=>Math.abs(x.edge)>=5).length;$("metricWatch").textContent=state.watchlist.length;$("metricPnl").textContent=money(state.realized);
$("venueList").innerHTML=venues.slice(0,6).map(v=>`<div class="venue"><span>${v[0]}</span><small>${state.backend?"VIA PROVIDER":"NOT CONNECTED"}</small></div>`).join("");
$("integrationGrid").innerHTML=venues.map(v=>`<div class="integration"><b>${v[0]}</b><small>${v[2]}</small><em>${v[1]==="manifold"?"PUBLIC / PLAY MONEY":"PROVIDER OR DIRECT ADAPTER"}</em></div>`).join("");
$("watchlistRows").innerHTML=state.watchlist.length?state.watchlist.map(m=>marketCard(m)).join(""):'<div class="empty">No saved markets yet. Save a market from Discover.</div>';bindWatch();
$("opportunityList").innerHTML=ranked.map(m=>`<div class="opportunity-card"><div><h3>${esc(m.title)}</h3><p>Illustrative demo only · Market ${m.yes}% · Model ${m.estimated}% · Verify all inputs</p><div style="margin-top:12px"><button class="small-btn" data-analyze-demo="${m.id}">Review analysis</button></div></div><div class="score">${Math.abs(m.edge)}<small>EDGE POINTS*</small></div></div>`).join("");
document.querySelectorAll("[data-analyze-demo]").forEach(b=>b.onclick=()=>{const m=demoMarkets.find(x=>x.id===b.dataset.analyzeDemo);$("marketQuestion").value=m.title;$("yesPrice").value=m.yes;nav("analyzer")});
renderPaper();
}
function renderPaper(){const open=state.positions.filter(p=>!p.closed);$("paperBalance").textContent=money(state.balance);$("paperPositions").textContent=open.length;$("paperRealized").textContent=money(state.realized);$("paperReturn").textContent=((state.realized/10000)*100).toFixed(2)+"%";$("positionList").innerHTML=state.positions.length?state.positions.map((p,i)=>`<div class="position-card"><div><b>${esc(p.question)}</b><div class="market-meta">${p.side} · Entry ${p.price}% · Stake ${money(p.stake)} ${p.closed?"· CLOSED":""}</div></div>${p.closed?"":`<button class="small-btn" data-close="${i}">Close at entry</button>`}</div>`).join(""):'<div class="empty">No simulated positions yet.</div>';document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>{const p=state.positions[Number(b.dataset.close)];if(!p||p.closed)return;p.closed=true;state.balance+=p.stake;save();render();toast("Position closed at entry — no simulated profit or loss.")})}
async function api(path,opts={}){if(!state.backend)throw new Error("No backend configured. Add your Worker URL in Settings.");const base=state.backend.replace(/\/+$/,"");const r=await fetch(base+path,{...opts,headers:{"Content-Type":"application/json",...(opts.headers||{})}});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||"Backend request failed ("+r.status+")");return data}
async function searchMarkets(){const q=$("marketSearch").value.trim(),platform=$("venueFilter").value;const body={q,platform:platform==="all"?undefined:platform,limit:40};$("marketRows").innerHTML='<tr><td colspan="5" class="empty">Loading market data…</td></tr>';try{const data=await api("/api/markets?"+new URLSearchParams(Object.entries(body).filter(([,v])=>v!==undefined)));const rows=(data.markets||data.data||[]).map(normalize);markets=rows.length?rows:[];$("marketRows").innerHTML=rows.length?rows.map(m=>`<tr><td><div class="table-market">${esc(m.title)}</div><div class="table-sub">${esc(m.id)}</div></td><td>${esc(venueLabel(m.platform))}</td><td>${m.yes==null?"—":m.yes.toFixed(1)+"%"}</td><td>${m.volume?money(m.volume):"—"}</td><td><button class="small-btn" data-watch="${esc(m.id)}">☆ Save</button></td></tr>`).join(""):'<tr><td colspan="5" class="empty">No markets returned for these filters.</td></tr>';bindWatch();$("connectionText").textContent="Provider connected";toast("Market data refreshed")}catch(e){$("marketRows").innerHTML=`<tr><td colspan="5" class="empty">${esc(e.message)}<br><br>Configure the backend or try demo examples on Overview.</td></tr>`}}
$("searchBtn").onclick=searchMarkets;$("refreshBtn").onclick=()=>{if($("page-discover").classList.contains("active"))searchMarkets();else toast("Refresh markets from Discover.")};
$("screenshotInput").onchange=e=>{const f=e.target.files[0];selectedImage=f||null;$("fileName").textContent=f?f.name+" · "+Math.round(f.size/1024)+" KB":""};
async function analyze(){const question=$("marketQuestion").value.trim(),url=$("marketUrl").value.trim(),price=$("yesPrice").value; if(!question&&!url&&!selectedImage){toast("Enter a market question, URL or screenshot.");return}
const btn=$("analyzeBtn");btn.disabled=true;btn.textContent="Analyzing…";let result;
try{let imageData=null;if(selectedImage){if(selectedImage.size>5*1024*1024)throw new Error("Please use an image smaller than 5 MB.");imageData=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(selectedImage)})}
result=await api("/api/analyze",{method:"POST",body:JSON.stringify({question,url,marketPrice:price===""?null:Number(price),platform:$("analysisPlatform").value,image:imageData})});showResult(result.analysis||result)
}catch(e){if(!state.backend){showResult({title:question||url||"Screenshot market",verdict:"DEMO ONLY",marketProbability:null,modelProbability:null,edge:null,confidence:"Not assessed",risk:"Not assessed",summary:"This is a sample report layout. No live market data, news research or AI inference has been performed. Configure a secure backend with market-data and AI credentials to enable real analysis.",evidence:["Demo mode is active.","No external sources were queried."],risks:["Do not use this sample to make a trading decision."],invalidation:["Run the analysis again after configuring integrations."]})}else toast(e.message)}
finally{btn.disabled=false;btn.textContent="✳ Run AI analysis"}}
function showResult(r){const n=v=>v==null?"—":(typeof v==="number"?v.toFixed(1):v)+(typeof v==="number"?"%":"");$("analysisResult").classList.remove("hidden");$("analysisResult").innerHTML=`<div class="result-top"><div><div class="eyebrow">ANALYSIS REPORT</div><h3>${esc(r.title||r.question||"Market analysis")}</h3></div><span class="verdict">${esc(r.verdict||"RESEARCH ONLY")}</span></div><div class="result-stats"><div class="result-stat"><small>MARKET PRICE</small><b>${n(r.marketProbability??r.marketPrice)}</b></div><div class="result-stat"><small>MODEL ESTIMATE</small><b>${n(r.modelProbability)}</b></div><div class="result-stat"><small>ESTIMATED EDGE</small><b>${r.edge==null?"—":(r.edge>0?"+":"")+Number(r.edge).toFixed(1)+" pts"}</b></div></div><div class="result-section"><h4>EXECUTIVE SUMMARY</h4><p>${esc(r.summary||"No summary returned.")}</p></div><div class="result-section"><h4>EVIDENCE & CATALYSTS</h4><ul>${(r.evidence||[]).map(x=>`<li>${esc(x)}</li>`).join("")||"<li>No evidence returned.</li>"}</ul></div><div class="result-section"><h4>KEY RISKS</h4><ul>${(r.risks||[]).map(x=>`<li>${esc(x)}</li>`).join("")||"<li>No risks returned.</li>"}</ul></div><div class="result-section"><h4>INVALIDATION CONDITIONS</h4><ul>${(r.invalidation||[]).map(x=>`<li>${esc(x)}</li>`).join("")||"<li>Reassess when material new information emerges.</li>"}</ul></div><div class="result-section"><h4>CONFIDENCE & LIMITATIONS</h4><p>Confidence: ${esc(r.confidence||"Not provided")} · Risk: ${esc(r.risk||"Not provided")}</p><p>AI estimates are uncertain and may be wrong. Verify all claims and resolution rules independently.</p></div>`;$("analysisResult").scrollIntoView({behavior:"smooth",block:"start"})}
$("analyzeBtn").onclick=analyze;
$("paperAdd").onclick=()=>{const q=$("paperQuestion").value.trim(),price=Number($("paperPrice").value),stake=Number($("paperStake").value),side=$("paperSide").value;if(!q||price<1||price>99||stake<=0||!Number.isFinite(stake)){toast("Enter a question, valid price and stake.");return}if(stake>state.balance){toast("Stake exceeds virtual balance.");return}state.balance-=stake;state.positions.unshift({question:q,price,stake,side,closed:false,created:Date.now()});save();render();$("paperQuestion").value="";$("paperPrice").value="";$("paperStake").value="";toast("Simulated position added.")};
$("resetPaper").onclick=()=>{if(!confirm("Reset all paper positions and restore the $10,000 virtual balance?"))return;state.positions=[];state.balance=10000;state.realized=0;save();render();toast("Paper trading reset.")};
$("saveSettings").onclick=()=>{state.backend=$("backendUrl").value.trim().replace(/\/+$/,"");save();$("connectionText").textContent=state.backend?"Backend configured":"Demo data mode";toast("Backend URL saved.")};
$("testConnection").onclick=async()=>{try{const d=await api("/api/health");$("settingsStatus").textContent="Connected · "+(d.status||"healthy")+" · "+(d.providers||[]).join(", ");$("connectionText").textContent="Backend connected"}catch(e){$("settingsStatus").textContent=e.message}};
$("backendUrl").value=state.backend;
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
render();

// EDGE Intelligence expansion: server scanner, cited research, price-history replay, forecast calibration and alert settings.
const edgeExtra = {
  forecasts: JSON.parse(localStorage.getItem("edge-forecasts-v1")||"[]"),
  alertRules: JSON.parse(localStorage.getItem("edge-alert-rules-v1")||'{"minRoi":3,"minSize":25}')
};
function safeNum(v){const n=Number(v);return Number.isFinite(n)?n:null}
function esc2(s){return esc(s)}
async function getExtra(path,opts={}){return api(path,opts)}
function renderForecasts(){
 const list=$("forecastLedger"); if(!list)return;
 const resolved=edgeExtra.forecasts.filter(x=>x.outcome!==null);
 const brier=resolved.length?resolved.reduce((s,x)=>s+Math.pow(x.probability/100-x.outcome,2),0)/resolved.length:null;
 list.innerHTML=edgeExtra.forecasts.length?edgeExtra.forecasts.map((f,i)=>`<div class="position-card"><div><b>${esc2(f.question)}</b><div class="market-meta">Forecast ${f.probability}% · ${esc2(f.horizon||"No horizon")} · ${f.outcome===null?"OPEN":f.outcome===1?"RESOLVED YES":"RESOLVED NO"}</div></div>${f.outcome===null?`<div><button class="small-btn" data-resolve="${i}" data-outcome="1">Resolve YES</button> <button class="small-btn" data-resolve="${i}" data-outcome="0">Resolve NO</button></div>`:""}</div>`).join(""):'<div class="empty">No forecasts saved yet.</div>';
 $("calibrationStats").textContent=resolved.length?`Resolved forecasts: ${resolved.length} · Brier score: ${brier.toFixed(4)} (lower is better; 0 is perfect, 0.25 is climatological 50/50 baseline).`:"No resolved forecasts yet. Resolve forecasts only after the outcome is independently verified.";
 document.querySelectorAll("[data-resolve]").forEach(b=>b.onclick=()=>{const i=Number(b.dataset.resolve);edgeExtra.forecasts[i].outcome=Number(b.dataset.outcome);localStorage.setItem("edge-forecasts-v1",JSON.stringify(edgeExtra.forecasts));renderForecasts()});
}
function renderCitedResearch(data,target){
 const r=data.report||data;
 const citations=(data.citations||r.citations||[]);
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
$("saveAlertRules")?.addEventListener("click",async()=>{
 edgeExtra.alertRules={minRoi:Math.max(0,Number($("alertMinRoi").value)||0),minSize:Math.max(0,Number($("alertMinSize").value)||0)};
 localStorage.setItem("edge-alert-rules-v1",JSON.stringify(edgeExtra.alertRules));
 try{await getExtra("/api/alert-rules",{method:"POST",body:JSON.stringify(edgeExtra.alertRules)});$("alertStatus").textContent="Rules saved to the server."}
 catch(e){$("alertStatus").textContent="Saved locally. Server persistence requires KV binding: "+e.message}
});
$("runScan")?.addEventListener("click",async()=>{
 const b=$("runScan");b.disabled=true;b.textContent="Scanning…";
 try{const d=await getExtra("/api/scan",{method:"POST",body:JSON.stringify({minRoi:edgeExtra.alertRules.minRoi,minSize:edgeExtra.alertRules.minSize})});const items=d.opportunities||[];$("alertFeed").innerHTML=items.length?items.map(o=>`<div class="market-row"><div><div class="market-title">${esc2(o.title||o.group_title||"Cross-market opportunity")}</div><div class="market-meta">${esc2((o.legs||[]).map(l=>l.platform+" "+l.side+" "+l.price).join(" · "))}</div></div><div class="prob">${Number(o.roi_pct||0).toFixed(2)}%<small>NET ROI</small></div><span class="edge-pill">${o.max_wager_usd?("$"+o.max_wager_usd+" size"):"Check depth"}</span></div>`).join(""):'<div class="empty">No qualifying signals returned. This is not evidence that no opportunities exist; check plan access and scan filters.</div>'}
 catch(e){$("alertFeed").innerHTML=`<div class="empty">${esc2(e.message)}</div>`}finally{b.disabled=false;b.textContent="Run scan now"}
});
if($("alertMinRoi")){$("alertMinRoi").value=edgeExtra.alertRules.minRoi;$("alertMinSize").value=edgeExtra.alertRules.minSize}
renderForecasts();
