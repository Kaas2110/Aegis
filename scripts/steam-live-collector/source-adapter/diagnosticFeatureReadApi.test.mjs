import test from 'node:test';import assert from 'node:assert/strict';
import {createDiagnosticFeatureReadApi} from './diagnosticFeatureReadApi.mjs';
const key='a'.repeat(64),schemaKey='b'.repeat(64),vectorKey='c'.repeat(64);
function fixture(){const calls={trace:0,schema:0};const journal={async loadTrace(hash){calls.trace++;assert.equal(hash,key);return{contract:'aegis.diagnostic-feature-trace.v1',matchId:'101',seriesId:'202',mode:'LIVE',decisionAt:'2026-10-24T00:00:00Z',privatePath:'private-do-not-expose',routes:[{targetId:'LIVE_MAP_WIN',stateMode:'LIVE',featureCount:3,schemaRef:{sha256:schemaKey,featureCount:3},vectorRef:vectorKey}],vectors:{[vectorKey]:{values:[0,null,5],missing:[false,true,false]}}};},async loadSchema(hash){calls.schema++;assert.equal(hash,schemaKey);return{targetId:'LIVE_MAP_WIN',definitions:[{name:'one'},{name:'missing'},{name:'three'}]};}};return{journal,calls};}
const base='/admin/feature-diagnostics/traces/'+key;
test('admin reader is disabled by default and never touches journal evidence',async()=>{const {journal,calls}=fixture(),api=createDiagnosticFeatureReadApi({journal});assert.equal((await api.handle({url:base})).status,404);assert.deepEqual(calls,{trace:0,schema:0});});
test('summary is compact evidence metadata with no raw vectors/schema/private paths or prediction claim',async()=>{const {journal,calls}=fixture(),api=createDiagnosticFeatureReadApi({journal,enabled:true}),r=await api.handle({url:base});assert.equal(r.status,200);assert.equal(r.body.routes[0].observedFeatures,2);assert.equal(r.body.routes[0].missingFeatures,1);assert.equal(r.body.recordedPrediction,false);assert.equal(JSON.stringify(r.body).includes('private-do-not-expose'),false);assert.equal('vectors'in r.body,false);assert.equal(calls.schema,0);});
test('feature pages bind exact target/schema and preserve observed zero versus missing',async()=>{const {journal}=fixture(),api=createDiagnosticFeatureReadApi({journal,enabled:true,maxFeaturePage:2}),first=await api.handle({url:base+'/features/LIVE_MAP_WIN?offset=0&limit=2'});assert.equal(first.status,200);assert.deepEqual(first.body.features,[{index:0,name:'one',value:0,missing:false},{index:1,name:'missing',value:null,missing:true}]);assert.equal(first.body.nextOffset,2);const last=await api.handle({url:base+'/features/LIVE_MAP_WIN?offset=2&limit=2'});assert.equal(last.body.features[0].name,'three');assert.equal(last.body.nextOffset,null);});
test('writes/path selection/oversized pages/duplicate query parameters and arbitrary targets fail closed',async()=>{const {journal,calls}=fixture(),api=createDiagnosticFeatureReadApi({journal,enabled:true,maxFeaturePage:2});for(const request of [{method:'POST',url:base},{url:'https://example.com/'+base},{url:base+'/features/LIVE_MAP_WIN?limit=3'},{url:base+'/features/LIVE_MAP_WIN?limit=1&limit=2'},{url:base+'?directory=private'}])assert.ok((await api.handle(request)).status>=400);assert.equal(calls.trace,0);assert.equal((await api.handle({url:base+'/features/LIVE_KILLS'})).status,404);});
test('storage corruption remains unavailable with a generic technical error',async()=>{const api=createDiagnosticFeatureReadApi({journal:{loadTrace:async()=>{throw Error('private-source-path');},loadSchema:async()=>null},enabled:true});const result=await api.handle({url:base});assert.equal(result.status,503);assert.equal(JSON.stringify(result).includes('private-source-path'),false);});
test('concurrent read ceiling rejects overload without starting or queuing another journal read',async()=>{const {journal,calls}=fixture(),original=journal.loadTrace;let resume;const held=new Promise(resolve=>resume=resolve);journal.loadTrace=async key=>{await held;return original(key);};const api=createDiagnosticFeatureReadApi({journal,enabled:true,maxConcurrentReads:1}),first=api.handle({url:base});assert.equal((await api.handle({url:base})).status,429);resume();assert.equal((await first).status,200);assert.equal(calls.trace,1);});

test('saved feature inspection does not claim an old trace is currently eligible',async()=>{
 const {journal}=fixture(),api=createDiagnosticFeatureReadApi({journal,enabled:true});
 const r=await api.handle({url:base});assert.equal(r.body.currentLiveEligibility.eligibleForRetainingForecast,false);assert.equal(r.body.currentLiveEligibility.userMessage,'Прогноз недоступен');
});

test('reader calls owned freshness port at read time; a stale clock cannot be supplied in query',async()=>{
 const {journal}=fixture(),original=journal.loadTrace; journal.loadTrace=async hash=>({...await original(hash),nativeObservationId:'observed-1'});
 let time='2026-10-24T00:05:00Z',reads=0;
 const api=createDiagnosticFeatureReadApi({journal,enabled:true,now:()=>time,readLiveEligibility:({matchId,decisionAt})=>{
  reads++;assert.equal(matchId,'101');return{eligibleForRetainingForecast:decisionAt=== '2026-10-24T00:05:00Z',lastTraceSha256:key,stateView:{observationId:'observed-1',lastConfirmedAt:'2026-10-24T00:00:00Z',expiresAt:'2026-10-24T00:05:00Z',classification:'confirmed_active'}};
 }});
 assert.equal((await api.handle({url:base})).body.currentLiveEligibility.eligibleForRetainingForecast,true);
 time='2026-10-24T00:05:00.000000001Z';assert.equal((await api.handle({url:base})).body.currentLiveEligibility.eligibleForRetainingForecast,false);
 assert.equal((await api.handle({url:base+'?decisionAt=2026-10-24T00:00:00Z'})).status,400);assert.equal(reads,2);
});

test('route endpoint resolves source context from an owned port and overrides backdated decisions',async()=>{
 let calls=0;const {journal}=fixture(),api=createDiagnosticFeatureReadApi({journal,enabled:true,now:()=> '2026-10-24T00:06:00Z',resolveRouteContext:async({seriesId})=>({seriesInput:{privateOwnedBytes:true},seriesId,decisionAt:'2000-01-01T00:00:00Z'}),targetRouter:{async read(context){calls++;assert.equal(context.decisionAt,'2026-10-24T00:06:00Z');return{seriesId:'synthetic-series',recordedPrediction:false};}}});
 assert.equal((await api.handle({url:'/admin/feature-diagnostics/series/synthetic-series/routes'})).status,200);
 assert.equal((await api.handle({url:'/admin/feature-diagnostics/series/synthetic-series/routes?source=forged'})).status,400);assert.equal(calls,1);
});
test('feature read final fence observes expiry after delayed schema IO and rejects asynchronous state authority',async()=>{
 const {journal}=fixture(),loadTrace=journal.loadTrace,loadSchema=journal.loadSchema; journal.loadTrace=async hash=>({...await loadTrace(hash),nativeObservationId:'observed-1'});
 let time='2026-10-24T00:04:59Z',release,entered,reads=0;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});journal.loadSchema=async hash=>{entered();await gate;return loadSchema(hash);};
 const state=()=>({eligibleForRetainingForecast:true,lastTraceSha256:key,stateView:{observationId:'observed-1',lastConfirmedAt:'2026-10-24T00:00:00Z',expiresAt:'2026-10-24T00:05:00Z',continuityGeneration:0}}),api=createDiagnosticFeatureReadApi({journal,enabled:true,now:()=>time,readLiveEligibility:()=>{reads++;return state();}});
 const pending=api.handle({url:base+'/features/LIVE_MAP_WIN'});await started;time='2026-10-24T00:05:00.000000001Z';release();const result=await pending;assert.equal(result.status,200);assert.equal(result.body.features.length,3);assert.equal(result.body.currentLiveEligibility.eligibleForRetainingForecast,false);assert.equal(result.body.currentLiveEligibility.evaluatedAt,time);assert.equal(result.body.currentLiveEligibility.reason,'eligible_state_expired');assert.equal(reads,1);
 const asynchronous=createDiagnosticFeatureReadApi({journal,enabled:true,now:()=> '2026-10-24T00:05:00Z',readLiveEligibility:async()=>state()}),rejected=await asynchronous.handle({url:base});assert.equal(rejected.status,200);assert.equal(rejected.body.currentLiveEligibility.eligibleForRetainingForecast,false);assert.equal(rejected.body.currentLiveEligibility.reason,'synchronous_live_eligibility_port_required');
});
