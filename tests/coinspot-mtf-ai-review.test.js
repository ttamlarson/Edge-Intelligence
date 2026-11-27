import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

const hour=60*60*1000;
const baseNowMs=Date.now();
const baseNow=new Date(baseNowMs).toISOString();
const reviewDecision={
 assessment:"LOW_CONCERN",
 summary:"The supplied signal is coherent, but spread, regime shifts and limited historical evidence remain material risks.",
 riskFlags:[]
};

function marketAt(now=baseNow){
 const nowMs=Date.parse(now);
 const signalAt=new Date(nowMs-4*hour).toISOString();
 return {
  coin:"BTC",pair:"BTC/AUD",
  quote:{pair:"BTC/AUD",bid:99950,ask:100050,last:100000,spreadBps:10,retrievedAt:now},
  signal:{
   strategy:"EDGE_MTF_DONCHIAN_ENSEMBLE_V1",status:"BUY_CANDIDATE_PAPER_ONLY",
   entryModel:"DONCHIAN_BREAKOUT",signalAt,marketRegime:"BULLISH",
   checks:{dailyTrend:true,fourHourTrend:true,positiveLongTrendSlope:true,breakoutVotes:true,pullbackReclaim:false,entryTrigger:true,liquidity:true,volatility:true},
   indicators:{breakoutVotes:3,atr20:1000,longTrendSlopePct:0.2},
   risk:{initialStopDistance:2500},
   execution:{orderIntent:"NONE",paperOnly:true,liveTradingEnabled:false}
  }
 };
}

function kvStore(){
 const values=new Map();
 return {values,async get(key){return values.get(key)??null;},async put(key,value){values.set(key,value);}};
}

function successfulFetch(actualModel="provider-resolved-mtf-model"){
 return async (_url,options)=>{
  const body=JSON.parse(options.body);
  assert.equal(body.text.format.type,"json_schema");
  assert.equal(body.text.format.strict,true);
  assert.equal(body.tools,undefined);
  return new Response(JSON.stringify({
   id:"resp_coinspot_mtf_review",
   model:actualModel,
   output_text:JSON.stringify(reviewDecision)
  }),{status:200,headers:{"Content-Type":"application/json"}});
 };
}

test("CoinSpot MTF AI review is strict, versioned, provenance-bound and cached per model version",async()=>{
 const originalFetch=globalThis.fetch,kv=kvStore();
 let calls=0;
 globalThis.fetch=async(url,options)=>{calls++;return successfulFetch()(url,options);};
 try{
  const env={OPENAI_API_KEY:"test-only",OPENAI_MODEL:"test-model-v1",EDGE_KV:kv};
  const first=await __test.reviewCoinSpotMtfCandidate(env,marketAt(),baseNow);
  assert.equal(first.status,"AI_REVIEW_COMPLETE");
  assert.equal(first.assessment,"LOW_CONCERN");
  assert.equal(first.model,"provider-resolved-mtf-model");
  assert.equal(first.requestedModel,"test-model-v1");
  assert.equal(first.modelIdentitySource,"PROVIDER_REPORTED");
  assert.equal(first.reviewPolicyVersion,"COINSPOT_MTF_AI_REVIEW_V2");
  assert.equal(first.providerResponseId,"resp_coinspot_mtf_review");
  assert.ok(Date.parse(first.reviewedAt)>=Date.parse(first.requestStartedAt));
  assert.equal(first.inputProvenance.sourceVerification,"NOT_INDEPENDENTLY_VERIFIED");
  assert.match(first.inputProvenance.fingerprint,/^[a-f0-9]{64}$/);
  assert.match(first.inputProvenance.modelFingerprint,/^[a-f0-9]{64}$/);
  assert.ok(first.reviewId.endsWith(first.inputProvenance.fingerprint));
  assert.equal(__test.isValidCoinSpotMtfAiReview(first),true);
  assert.equal(calls,1);

  const [cacheKey]=kv.values.keys();
  kv.values.set(cacheKey,JSON.stringify({
   ...first,
   inputProvenance:{...first.inputProvenance,signalAt:new Date(Date.parse(first.inputProvenance.signalAt)+60_000).toISOString()}
  }));
  const refreshed=await __test.reviewCoinSpotMtfCandidate(env,marketAt(),baseNow);
  assert.equal(refreshed.inputProvenance.signalAt,first.inputProvenance.signalAt);
  assert.equal(calls,2,"a cache record with mismatched signal provenance must be refreshed");

  const nextNow=new Date(Date.parse(baseNow)+60_000).toISOString();
  const nextMarket=marketAt(nextNow);
  nextMarket.signal.signalAt=first.inputProvenance.signalAt;
  const cached=await __test.reviewCoinSpotMtfCandidate(env,nextMarket,nextNow);
  assert.equal(cached.reviewId,first.reviewId);
  assert.equal(calls,2,"a refreshed quote timestamp with unchanged signal/spread should reuse the same review evidence");

  const nextModel=await __test.reviewCoinSpotMtfCandidate(
   {...env,OPENAI_MODEL:"test-model-v2"},marketAt(nextNow),nextNow
  );
  assert.equal(nextModel.status,"AI_REVIEW_COMPLETE");
  assert.equal(nextModel.requestedModel,"test-model-v2");
  assert.notEqual(nextModel.reviewId,first.reviewId);
  assert.equal(calls,3,"changing the requested model must bypass the previous model's cache");
  assert.equal(__test.isValidCoinSpotMtfAiReview({
   ...first,inputProvenance:{...first.inputProvenance,modelFingerprint:"0".repeat(64)}
  }),false);
 }finally{globalThis.fetch=originalFetch;}
});

test("CoinSpot MTF AI review rejects stale, future and malformed quote/signal inputs before provider calls",async()=>{
 const originalFetch=globalThis.fetch;
 let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error("provider must not be called");};
 try{
  const env={OPENAI_API_KEY:"test-only",EDGE_KV:kvStore()};
  const stale=marketAt();
  stale.quote.retrievedAt=new Date(Date.parse(baseNow)-21*60_000).toISOString();
  assert.equal((await __test.reviewCoinSpotMtfCandidate(env,stale,baseNow)).status,"AI_REVIEW_INVALID_INPUT");

  const future=marketAt();
  future.quote.retrievedAt=new Date(Date.parse(baseNow)+1000).toISOString();
  assert.equal((await __test.reviewCoinSpotMtfCandidate(env,future,baseNow)).status,"AI_REVIEW_INVALID_INPUT");

  const expired=marketAt();
  expired.signal.signalAt=new Date(Date.parse(baseNow)-12*hour-1).toISOString();
  assert.equal((await __test.reviewCoinSpotMtfCandidate(env,expired,baseNow)).status,"AI_REVIEW_INVALID_INPUT");

  const liveFlag=marketAt();
  liveFlag.signal.execution.liveTradingEnabled=true;
  assert.equal((await __test.reviewCoinSpotMtfCandidate(env,liveFlag,baseNow)).status,"AI_REVIEW_INVALID_INPUT");

  assert.equal((await __test.reviewCoinSpotMtfCandidate({},marketAt(),baseNow)).status,"AI_REVIEW_NOT_CONFIGURED");
  assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;}
});

test("CoinSpot MTF AI provider, schema, size and cache failures fail closed",async()=>{
 const originalFetch=globalThis.fetch,env={OPENAI_API_KEY:"test-only",EDGE_KV:kvStore()};
 try{
  globalThis.fetch=async()=>new Response("unavailable",{status:503});
  assert.equal((await __test.reviewCoinSpotMtfCandidate(env,marketAt(),baseNow)).status,"AI_REVIEW_PROVIDER_ERROR");

  globalThis.fetch=async()=>new Response("not-json",{status:200});
  assert.equal((await __test.reviewCoinSpotMtfCandidate(env,marketAt(),baseNow)).status,"AI_REVIEW_INVALID_RESPONSE");

  globalThis.fetch=async()=>new Response(JSON.stringify({
   model:"test-model",output_text:JSON.stringify({assessment:"APPROVE",summary:"short",riskFlags:[]})
  }),{status:200});
  assert.equal((await __test.reviewCoinSpotMtfCandidate(env,marketAt(),baseNow)).status,"AI_REVIEW_INVALID_DECISION");

  globalThis.fetch=async()=>new Response(JSON.stringify({
   id:"x".repeat(121),model:"test-model",output_text:JSON.stringify(reviewDecision)
  }),{status:200});
  assert.equal((await __test.reviewCoinSpotMtfCandidate(env,marketAt(),baseNow)).status,"AI_REVIEW_INVALID_RESPONSE");

  globalThis.fetch=async()=>new Response("{}",{status:200,headers:{"Content-Length":"9000"}});
  assert.equal((await __test.reviewCoinSpotMtfCandidate(env,marketAt(),baseNow)).status,"AI_REVIEW_RESPONSE_TOO_LARGE");

  globalThis.fetch=async()=>{const error=new Error("timeout");error.name="AbortError";throw error;};
  assert.equal((await __test.reviewCoinSpotMtfCandidate(env,marketAt(),baseNow)).status,"AI_REVIEW_TIMEOUT");

  const brokenCache={async get(){throw new Error("cache unavailable");}};
  globalThis.fetch=successfulFetch();
  assert.equal((await __test.reviewCoinSpotMtfCandidate(
   {OPENAI_API_KEY:"test-only",EDGE_KV:brokenCache},marketAt(),baseNow
  )).status,"AI_REVIEW_CACHE_UNAVAILABLE");
 }finally{globalThis.fetch=originalFetch;}
});

test("only a provenance-valid LOW_CONCERN review can clear the advisory AI gate",async()=>{
 const originalFetch=globalThis.fetch,kv=kvStore();
 globalThis.fetch=successfulFetch();
 try{
  const market=marketAt();
  const review=await __test.reviewCoinSpotMtfCandidate(
   {OPENAI_API_KEY:"test-only",EDGE_KV:kv},market,baseNow
  );
  const approved=__test.applyCoinSpotMtfAiGate([market],[{coin:"BTC",review}]);
  assert.equal(approved.gates.BTC,"AI_APPROVED");
  assert.equal(approved.markets[0].signal.status,"BUY_CANDIDATE_PAPER_ONLY");

  const caution=__test.applyCoinSpotMtfAiGate([market],[{
   coin:"BTC",review:{...review,assessment:"CAUTION"}
  }]);
  assert.equal(caution.gates.BTC,"AI_BLOCKED");
  assert.equal(caution.markets[0].signal.status,"AI_REVIEW_BLOCKED");
  assert.equal(caution.markets[0].signal.execution.liveTradingEnabled,false);
 }finally{globalThis.fetch=originalFetch;}
});
