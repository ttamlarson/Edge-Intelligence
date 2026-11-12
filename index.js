const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};
const json = (data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...CORS,"Content-Type":"application/json","Cache-Control":"no-store"}});
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
const num=v=>Number.isFinite(Number(v))?Number(v):null;
const PRED_BASE="https://prediction.com/api/v2";
async function pred(env,path){
 if(!env.PREDICTION_HUNT_API_KEY)return {error:"PREDICTION_HUNT_API_KEY is not configured."};
 const r=await fetch(PRED_BASE+path,{headers:{"X-API-Key":env.PREDICTION_HUNT_API_KEY,"Accept":"application/json"}});
 const data=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(data.error?.message||data.message||`Prediction data provider returned ${r.status}`);
 return data;
}
function normMarket(m){
 const p=m.price||{};
 const mid=num(p.yes_bid)!=null&&num(p.yes_ask)!=null?(Number(p.yes_bid)+Number(p.yes_ask))/2:num(p.last_price);
 return {id:String(m.id),market_id:String(m.market_id),platform:m.platform,title:m.event_title?`${m.event_title} — ${m.title}`:m.title,category:m.category,status:m.status,price:mid,bid:num(p.yes_bid),ask:num(p.yes_ask),spread:num(p.yes_bid)!=null&&num(p.yes_ask)!=null?Number(p.yes_ask)-Number(p.yes_bid):null,volume:num(p.volume),liquidity:num(p.liquidity),expiration_date:m.expiration_date,url:m.source_url,rules:m.rules||null};
}
function scoreCandidate(o,minRoi=2,minSize=10){
 const roi=num(o.roi_pct),size=num(o.max_wager_usd);
 const legs=Array.isArray(o.legs)?o.legs:[];
 const deep=legs.length===2&&legs.every(l=>num(l.liquidity_usd)>0);
 const executable=size!==null&&size>=minSize;
 const net=roi!==null&&roi>=minRoi;
 return {...o,screen_status:net&&executable&&deep?"QUALIFIES":"REVIEW",quality_flags:{net_roi:net,minimum_size:executable,both_legs_have_depth:deep},score:clamp((roi||0)*2+(deep?20:0)+(executable?15:0),0,100)};
}
async function scan(env,settings={}){
 const minRoi=clamp(num(settings.minRoi)??3,0,100),minSize=clamp(num(settings.minSize)??25,0,10000000);
 const data=await pred(env,`/arb?min_roi=${encodeURIComponent(minRoi)}&limit=100`);
 const raw=data.opportunities||[];
 const opportunities=raw.map(o=>scoreCandidate(o,minRoi,minSize)).sort((a,b)=>(b.score||0)-(a.score||0));
 const snapshot={as_of:data.as_of||new Date().toISOString(),delay_seconds:data.delay_seconds??null,count:opportunities.length,opportunities};
 if(env.EDGE_KV)await env.EDGE_KV.put("latest-scan",JSON.stringify(snapshot),{expirationTtl:86400});
 return snapshot;
}
async function alertNew(env,scanData){
 if(!env.EDGE_KV||!env.ALERT_WEBHOOK_URL)return;
 const qualifying=scanData.opportunities.filter(o=>o.screen_status==="QUALIFIES");
 const previous=JSON.parse(await env.EDGE_KV.get("alert-state")||"{}");
 const next={};
 for(const o of qualifying){
  const key=String(o.group_id||o.group_title||o.legs?.map(l=>l.market_id).join("-"));
  const roi=num(o.roi_pct)||0, old=previous[key];
  const changed=!old||Math.abs(roi-old.roi)>=1.5;
  if(changed){
   const lines=[`EDGE signal: ${o.group_title||"Cross-platform market"}`,`Net ROI estimate: ${roi.toFixed(2)}%`,`Max executable wager: $${num(o.max_wager_usd)||0}`,`Check each market's resolution wording, fees and depth before acting.`,...(o.legs||[]).map(l=>`${l.platform} ${l.side}: ${l.price} · ${l.source_url||""}`)];
   await fetch(env.ALERT_WEBHOOK_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:lines.join("\n"),text:lines.join("\n")})}).catch(()=>null);
  }
  next[key]={roi,seenAt:Date.now()};
 }
 await env.EDGE_KV.put("alert-state",JSON.stringify(next),{expirationTtl:60*60*24*30});
}
function extractResponseText(resp){
 if(resp.output_text)return resp.output_text;
 const out=[];
 for(const item of resp.output||[])for(const c of item.content||[])if(c.type==="output_text"||c.type==="text")out.push(c.text);
 return out.join("\n");
}
function extractCitations(resp){
 const cites=[];
 for(const item of resp.output||[])for(const c of item.content||[])for(const a of c.annotations||[])if(a.type==="url_citation"&&a.url_citation)cites.push({url:a.url_citation.url,title:a.url_citation.title||a.url_citation.url});
 const seen=new Set();return cites.filter(c=>c.url&&!seen.has(c.url)&&seen.add(c.url));
}
async function research(env,input){
 if(!env.OPENAI_API_KEY)return {error:"OPENAI_API_KEY is not configured."};
 const prompt=`Research this prediction-market question using live web search. Exact question: ${input.question}\nResolution rules: ${input.rules||"Not supplied; flag this as a major limitation."}\nCurrent YES market price: ${input.marketPrice==null?"Not supplied":input.marketPrice+"%"}\n\nUse primary sources first, cite URLs, and distinguish confirmed facts from claims. Search current facts. Find relevant base rates if credible comparable data exists. Steelman YES and NO cases. Identify timeline/catalysts and what evidence would change the view. Never invent facts or sources. If evidence is insufficient, say so and return no point estimate. Give a defensible probability range and confidence rather than false precision. Do not treat the market quote as independent evidence. Calculate edge_points only if there is a defensible midpoint estimate and market price; edge is midpoint minus market price in percentage points before fees. Explicitly discuss fees, spread, depth, slippage, settlement wording, and jurisdiction as limitations.\n\nReturn JSON with keys: question, summary, probability_range (string or null), probability (number or null), market_price (number or null), edge_points (number or null), confidence, yes_case (array), no_case (array), base_rates_and_assumptions (array), invalidation (array), limitations (array).`;
 const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Authorization":`Bearer ${env.OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:env.OPENAI_MODEL||"gpt-6-astra",tools:[{type:"web_search",search_context_size:"high"}],tool_choice:"auto",input:prompt,text:{format:{type:"json_object"}}})});
 const data=await response.json();if(!response.ok)throw new Error(data.error?.message||`OpenAI returned ${response.status}`);
 const text=extractResponseText(data);let report;try{report=JSON.parse(text)}catch{throw new Error("Could not parse the structured research report.")}
 return {report,citations:extractCitations(data),created_at:new Date().toISOString(),model:env.OPENAI_MODEL||"gpt-6-astra"};
}
async function backtest(env,input){
 const platform=String(input.platform||"").toLowerCase(),marketId=String(input.marketId||"");
 if(!/^[a-z0-9_-]{1,80}$/i.test(platform)||!/^[a-z0-9_.-]{1,120}$/i.test(marketId))throw new Error("Invalid platform or market ID.");
 const days=clamp(num(input.days)||30,1,90),interval=["1m","5m","15m","1h","1d"].includes(input.interval)?input.interval:"1h";
 const to=new Date(),from=new Date(to.getTime()-days*86400000);
 const qs=new URLSearchParams({platform,market_id:marketId,from:from.toISOString(),to:to.toISOString(),interval});
 const data=await pred(env,`/prices/history?${qs}`);
 const candles=(data.candles||[]).filter(c=>num(c.close)!==null);
 if(candles.length<2)return {result:{candles:candles.length,warning:"Not enough historical candles for replay.",from:from.toISOString(),to:to.toISOString()}};
 const first=Number(candles[0].close),last=Number(candles[candles.length-1].close);
 let peak=first,maxDd=0;
 for(const c of candles){const v=Number(c.close);peak=Math.max(peak,v);maxDd=Math.max(maxDd,(peak-v)/peak*100)}
 return {result:{candles:candles.length,first,last,buyHoldPct:(last/first-1)*100,maxDrawdownPct:maxDd,from:candles[0].timestamp,to:candles[candles.length-1].timestamp,method:"Buy-and-hold mark-to-market replay using historical close prices. It does not model fills, fees, spread, slippage, or resolution payouts.",warning:"This is descriptive historical price replay, not a validated predictive strategy or a resolved-contract backtest."}};
}
export default {
 async fetch(request,env){
  const url=new URL(request.url);if(request.method==="OPTIONS")return new Response(null,{headers:CORS});
  try{
   if(url.pathname==="/api/health")return json({status:"healthy",providers:{marketData:!!env.PREDICTION_HUNT_API_KEY,ai:!!env.OPENAI_API_KEY,storage:!!env.EDGE_KV,alerts:!!env.ALERT_WEBHOOK_URL},scanner:"15-minute cron"});
   if(url.pathname==="/api/markets"&&request.method==="GET"){
    const q=new URLSearchParams();for(const k of ["q","platform","category","status","cursor"])if(url.searchParams.has(k))q.set(k,url.searchParams.get(k));
    q.set("limit",String(clamp(num(url.searchParams.get("limit"))||50,1,200)));q.set("include","rules");
    const requestedPlatform=url.searchParams.get("platform");
    if(requestedPlatform==="manifold"){
     const limit=clamp(num(url.searchParams.get("limit"))||50,1,200);
     const mu=new URL("https://api.manifold.markets/v0/markets");mu.searchParams.set("limit",String(limit));
     const raw=await fetch(mu,{headers:{"Accept":"application/json"}});
     if(!raw.ok)throw new Error(`Manifold API returned ${raw.status}`);
     const list=await raw.json(),term=(url.searchParams.get("q")||"").toLowerCase();
     const markets=(Array.isArray(list)?list:[]).filter(m=>!term||String(m.question||"").toLowerCase().includes(term)).map(m=>({id:String(m.id),market_id:String(m.id),platform:"manifold",title:m.question,category:m.groupSlugs?.[0]||"community",status:m.isResolved?"closed":"active",price:num(m.probability)==null?null:Number(m.probability)*100,bid:null,ask:null,spread:null,volume:num(m.volume),liquidity:null,expiration_date:m.closeTime?new Date(m.closeTime).toISOString():null,url:m.url||`https://manifold.markets/${m.creatorUsername}/${m.slug}`,rules:{primary:m.description||"See Manifold market description."}}));
     return json({markets,next_cursor:null,total_count:markets.length,as_of:new Date().toISOString(),source:"Manifold public API"});
    }
    const d=await pred(env,`/markets?${q}`);
    const normalized=(d.markets||[]).map(normMarket);
    if(!requestedPlatform&&url.searchParams.get("include_manifold")==="true"){
     try{
      const mu=await fetch("https://api.manifold.markets/v0/markets?limit=100",{headers:{"Accept":"application/json"}});
      if(mu.ok){const ml=await mu.json();for(const m of (Array.isArray(ml)?ml:[])){normalized.push({id:String(m.id),market_id:String(m.id),platform:"manifold",title:m.question,category:m.groupSlugs?.[0]||"community",status:m.isResolved?"closed":"active",price:num(m.probability)==null?null:Number(m.probability)*100,bid:null,ask:null,spread:null,volume:num(m.volume),liquidity:null,expiration_date:m.closeTime?new Date(m.closeTime).toISOString():null,url:m.url||null,rules:{primary:m.description||"See Manifold market description."}})}}
     }catch{}
    }
    return json({markets:normalized,next_cursor:d.next_cursor||null,total_count:d.total_count,as_of:d.as_of});
   }
   if(url.pathname==="/api/scan"&&request.method==="POST"){const body=await request.json();return json(await scan(env,body))}
   if(url.pathname==="/api/opportunities"&&request.method==="GET"){const cached=env.EDGE_KV?await env.EDGE_KV.get("latest-scan"):null;return cached?json(JSON.parse(cached)):json(await scan(env,{}))}
   if(url.pathname==="/api/research"&&request.method==="POST"){const body=await request.json();if(!body.question)return json({error:"Question is required."},400);return json(await research(env,body))}
   if(url.pathname==="/api/analyze"&&request.method==="POST"){
    const body=await request.json();if(!body.question&&!body.url)return json({error:"Question or URL required."},400);
    const r=await research(env,{question:body.question||body.url,rules:body.rules||"",marketPrice:body.marketPrice});
    return json({analysis:{title:r.report.question,summary:r.report.summary,marketProbability:r.report.market_price,modelProbability:r.report.probability,edge:r.report.edge_points,confidence:r.report.confidence,risk:(r.report.limitations||[]).join(" · "),evidence:[...(r.report.yes_case||[]),...(r.report.base_rates_and_assumptions||[])],risks:r.report.no_case||[],invalidation:r.report.invalidation||[]},citations:r.citations});
   }
   if(url.pathname==="/api/backtest"&&request.method==="POST")return json(await backtest(env,await request.json()));
   if(url.pathname==="/api/alert-rules"&&request.method==="POST"){
    if(!env.EDGE_KV)return json({error:"EDGE_KV binding is required for server-side alert rules."},503);
    const b=await request.json(),rules={minRoi:clamp(num(b.minRoi)||3,0,100),minSize:clamp(num(b.minSize)||25,0,10000000)};
    await env.EDGE_KV.put("alert-rules",JSON.stringify(rules));return json({saved:true,rules});
   }
   if(url.pathname==="/api/alerts"&&request.method==="GET"){const v=env.EDGE_KV?await env.EDGE_KV.get("latest-scan"):null;return json(v?JSON.parse(v):{opportunities:[]})}
   return json({error:"Not found"},404);
  }catch(e){return json({error:e.message||"Unexpected server error"},500)}
 },
 async scheduled(event,env,ctx){
  if(!env.PREDICTION_HUNT_API_KEY)return;
  ctx.waitUntil((async()=>{const rules=env.EDGE_KV?JSON.parse(await env.EDGE_KV.get("alert-rules")||'{"minRoi":3,"minSize":25}'):{minRoi:3,minSize:25};const result=await scan(env,rules);await alertNew(env,result)})());
 }
};