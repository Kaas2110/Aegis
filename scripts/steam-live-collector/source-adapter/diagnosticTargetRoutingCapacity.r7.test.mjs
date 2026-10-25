/** Actual router and installed canonical target registry, with an explicitly
 * synthetic owned compact read port. These scalar/page fixtures do not prove
 * full codec/journal, feature-generation, provider or serving acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadCanonicalRegistry} from '../../feature-registry/canonical-registry.mjs';
import {TARGET_IDS,digest} from '../../feature-registry/registry-contract.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createDiagnosticTargetRouter} from './diagnosticTargetRouting.mjs';
import {LEGACY_FEATURE_CAPACITY_PROFILE as LEGACY,FULL_FEATURE_CAPACITY_PROFILE as FULL} from './featureCapacityProfiles.mjs';

const AT='2026-10-25T13:00:00Z',TRACE_AT='2026-10-25T12:40:00Z';
const HEADS=['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE'];
const pin=value=>{const utf8=JSON.stringify(value);return{utf8,pin:{path:'synthetic-capacity-series.json',bytes:Buffer.byteLength(utf8),sha256:createHash('sha256').update(utf8).digest('hex')}};};
function fixture({legacy=false,count=legacy?1:150001,mutate=null}={}){
 const targetDocument=loadCanonicalRegistry().targetDocument,owner=createDiagnosticResourceArena({maxBytes:1024*1024}),headers=new Map(),allow=Object.fromEntries(TARGET_IDS.map(id=>[id,[]])),calls={traceLoads:0,traceReleases:0,pageLoads:0,pageReleases:0};
 const capacity=legacy?LEGACY:FULL,seriesInput=pin({contract:'aegis.series-map-receipts.v1',seriesId:'series:capacity',team1Id:'100',team2Id:'200',bestOf:3,availableAt:'2026-10-25T12:30:00Z',completeThroughMapNumber:0,previousMaps:[]}),currentMap={mapId:'101',mapNumber:1};
 const routes=HEADS.map(targetId=>{
  const stateMode=targetId==='SERIES_LIVE'?'observed_postdraft':'POST',header={contract:capacity.schemaContract,...(legacy?{}:{capacityProfile:capacity.id}),targetId,stateMode},sha256=digest({header,syntheticScalarFeatureCount:count});headers.set(targetId,header);allow[targetId].push(sha256);
  return{targetId,stateMode,featureCount:count,schemaRef:{sha256,namesSha256:digest(['synthetic.'+targetId]),featureCount:count,...(legacy?{}:{capacityProfile:capacity.id})}};
 });
 for(const id of TARGET_IDS)if(!allow[id].length)allow[id].push(digest({syntheticUnusedTarget:id}));
 const body={contract:'aegis.compact-diagnostic-feature-trace.v2',mode:'POST',matchId:currentMap.mapId,seriesId:'series:capacity',seriesReceiptPin:seriesInput.pin,decisionAt:TRACE_AT,availableAt:TRACE_AT,featureInputCutoffAt:TRACE_AT,timings:{featuresReadyAt:TRACE_AT},targetBinding:{mapId:currentMap.mapId,mapOutcome:'map_radiant_win',mapSides:{radiant:'100',dire:'200'},series:{seriesId:'series:capacity',team1Id:'100',team2Id:'200',outcome:'series_team1_win',team1CurrentSide:'radiant'}},routes,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
 mutate?.({body,headers});const traceSha256=digest(body);
 const journal={contract:'aegis.compact-diagnostic-feature-journal.v2',async loadTrace(key){
  assert.equal(key,traceSha256);calls.traceLoads++;const traceLease=owner.reserve(4096);assert.ok(traceLease);let active=true;
  return{contract:journal.contract,body:structuredClone(body),readSchemaPage({targetId,offset,limit}){
   assert.equal(active,true);assert.equal(offset,0);assert.equal(limit,1);calls.pageLoads++;const pageLease=owner.reserve(4096);assert.ok(pageLease);let held=true;const route=body.routes.find(r=>r.targetId===targetId);
   return{header:structuredClone(headers.get(targetId)),expandedSchemaHash:route.schemaRef.sha256,total:route.featureCount,definitions:[{name:'synthetic.'+targetId}],release(){if(!held)return false;held=false;calls.pageReleases++;return pageLease.release();}};
  },release(){if(!active)return false;active=false;calls.traceReleases++;return traceLease.release();}};
 }};
 const router=createDiagnosticTargetRouter({journal,targetDocument,expectedSchemaHashes:allow,now:()=>AT});
 return{router,owner,calls,input:{traceSha256,seriesInput,phase:'POST',currentMap,decisionAt:AT}};
}
function released(f){assert.equal(f.calls.traceLoads,1);assert.equal(f.calls.traceReleases,1);assert.equal(f.calls.pageLoads,f.calls.pageReleases);assert.equal(f.owner.status().chargedBytes,0);assert.equal(f.owner.status().leases,0);}

test('compact router accepts legacy and explicit full profiles for POST four-head series/map routing',async()=>{
 for(const legacy of [true,false]){
  const f=fixture({legacy,count:legacy?150000:300000}),result=await f.router.read(f.input);
  assert.equal(result.sourceRejection,null);assert.deepEqual(result.panelRejections,{series:null,map:null});assert.equal(result.main.targetId,'SERIES_LIVE');assert.equal(result.main.entity,'series');assert.equal(result.main.quantity,'whole_series');assert.equal(result.detail.mapId,'101');assert.deepEqual(result.detail.targets.map(r=>r.targetId),HEADS.slice(0,3));assert.equal(result.main.featureCount,legacy?150000:300000);assert.equal(result.main.schemaRef.capacityProfile,legacy?undefined:FULL.id);assert.equal(result.main.prediction,null);assert.equal(result.main.eligibleForServing,false);assert.equal(f.calls.pageLoads,8);released(f);
 }
});

test('compact router rejects omitted or conflicting full route markers and releases trace/page owners',async()=>{
 for(const mutate of [({body})=>{delete body.routes[0].schemaRef.capacityProfile;},({body})=>{body.routes[0].schemaRef.capacityProfile=LEGACY.id;},({body})=>{body.routes[0].schemaRef.capacityProfile='future';}]){
  const f=fixture({mutate}),result=await f.router.read(f.input);assert.equal(result.sourceRejection,'exact_schema_target_binding');assert.equal(result.main.status,'unavailable');assert.equal(result.detail.status,'unavailable');assert.equal(f.calls.pageLoads,2);released(f);
 }
});

test('compact router rejects forged profile headers and keeps legacy/full count ceilings separate',async()=>{
 const variants=[
  {mutate:({headers})=>{headers.get('POST_MAP_WIN').capacityProfile='future';}},
  {mutate:({headers})=>{delete headers.get('POST_MAP_WIN').capacityProfile;}},
  {mutate:({headers})=>{headers.get('POST_MAP_WIN').contract=LEGACY.schemaContract;}},
  {legacy:true,count:150001},
  {count:300001},
  {count:150001,mutate:({body,headers})=>{for(const route of body.routes){delete route.schemaRef.capacityProfile;const header=headers.get(route.targetId);header.contract=LEGACY.schemaContract;delete header.capacityProfile;}}}
 ];
 for(const options of variants){const f=fixture(options),result=await f.router.read(f.input);assert.equal(result.main.status,'unavailable');assert.equal(result.detail.status,'unavailable');assert.ok(result.sourceRejection);assert.equal(f.calls.pageLoads,2);released(f);}
});
