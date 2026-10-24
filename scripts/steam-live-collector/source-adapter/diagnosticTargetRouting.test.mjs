import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {TARGET_IDS,digest} from '../../feature-registry/registry-contract.mjs';
import {createDiagnosticTargetRouter} from './diagnosticTargetRouting.mjs';
const AT='2026-10-23T13:00:00Z',TRACE_AT='2026-10-23T12:40:00Z';
const pinned=data=>{const utf8=JSON.stringify(data);return{utf8,pin:{path:'synthetic-series.json',bytes:Buffer.byteLength(utf8),sha256:createHash('sha256').update(utf8).digest('hex')}};};
const phaseIds={PRE:['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','SERIES_PRE'],POST:['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE'],LIVE:['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE'],BETWEEN:['SERIES_BETWEEN'],SERIES_PRE:['SERIES_PRE']};
function series(bestOf=3,count=0,winners=null){return pinned({contract:'aegis.series-map-receipts.v1',seriesId:'series:7',team1Id:'100',team2Id:'200',bestOf,availableAt:'2026-10-23T12:30:00Z',completeThroughMapNumber:count,previousMaps:Array.from({length:count},(_,i)=>({mapId:String(101+i),mapNumber:i+1,winnerTeamId:winners?.[i]??(i%2?'200':'100'),durationSeconds:1800,team1Kills:20+i,team2Kills:10+i,finishedAt:`2026-10-${10+i}T12:30:00Z`,availableAt:`2026-10-${10+i}T13:00:00Z`,team1Heroes:[21+i*10,22+i*10,23+i*10,24+i*10,25+i*10],team2Heroes:[26+i*10,27+i*10,28+i*10,29+i*10,30+i*10]}))});}
function setup(){
 const targetDocument=syntheticRegistry()[2],schemas=new Map(),expectedSchemaHashes=Object.fromEntries(TARGET_IDS.map(id=>[id,[]])),traces=new Map(),calls={trace:0,schema:0};
 for(const meta of targetDocument.targets)for(const stateMode of meta.stateModes){const schema={contract:'aegis.unified-feature-projection-schema.v1',targetId:meta.id,stateMode,definitions:[{name:'synthetic.'+meta.id}]},key=digest(schema);schemas.set(key,schema);expectedSchemaHashes[meta.id].push(key);}
 const journal={loadTrace:async key=>{calls.trace++;if(!traces.has(key))throw Error('private-evidence-path');return structuredClone(traces.get(key));},loadSchema:async key=>{calls.schema++;return structuredClone(schemas.get(key));}};
 const router=createDiagnosticTargetRouter({journal,targetDocument,expectedSchemaHashes});
 function trace(phase,currentMap=null,{radiant='100',change=null}={}){
  const routes=phaseIds[phase].map(targetId=>{const stateMode=targetId==='SERIES_LIVE'?(phase==='LIVE'?'observed_live':'observed_postdraft'):targetDocument.targets.find(t=>t.id===targetId).stateModes[0],schemaKey=[...schemas].find(([,s])=>s.targetId===targetId&&s.stateMode===stateMode)[0];return{targetId,stateMode,schemaRef:{sha256:schemaKey,featureCount:1},featureCount:1,vectorRef:digest(targetId)};});
  const body={contract:'aegis.diagnostic-feature-trace.v1',mode:phase,matchId:currentMap?.mapId??null,seriesId:'series:7',decisionAt:TRACE_AT,availableAt:TRACE_AT,timings:{featuresReadyAt:TRACE_AT},sourceSnapshotHash:null,targetBinding:{mapId:currentMap?.mapId??null,mapOutcome:currentMap?'map_radiant_win':null,mapSides:currentMap?{radiant,dire:radiant==='100'?'200':'100'}:null,series:{seriesId:'series:7',team1Id:'100',team2Id:'200',outcome:'series_team1_win',team1CurrentSide:currentMap?(radiant==='100'?'radiant':'dire'):null}},routes,vectors:{},eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};if(change)change(body);const key=digest(body);traces.set(key,body);return key;
 }
 return{router,trace,calls,schemas,traces,targetDocument,expectedSchemaHashes,journal};
}

test('all twelve logical targets route by registry phase/metric metadata into series main and map detail',async()=>{
 const f=setup(),seen=new Set();for(const phase of ['PRE','POST','LIVE','BETWEEN','SERIES_PRE']){
  const currentMap=['PRE','POST','LIVE'].includes(phase)?{mapId:'102',mapNumber:2}:null,seriesInput=series(3,phase==='SERIES_PRE'?0:1),traceSha256=f.trace(phase,currentMap),r=await f.router.read({traceSha256,seriesInput,phase,currentMap,decisionAt:AT});assert.equal(r.main.entity,'series');assert.equal(r.main.status,'diagnostic_features_available');seen.add(r.main.targetId);
  if(currentMap){assert.equal(r.selectedMapId,currentMap.mapId);assert.equal(r.detail.entity,'map');assert.equal(r.detail.targets.length,3);for(const d of r.detail.targets){seen.add(d.targetId);assert.equal(d.prediction,null);assert.equal(d.eligibleForServing,false);}}
  else assert.equal(r.detail.status,'unavailable');
 }
 assert.deepEqual([...seen].sort(),[...TARGET_IDS].sort());
});
test('BO1/BO3/BO5 keep explicit series identity and selected current map independent',async()=>{
 for(const bestOf of [1,3,5]){const f=setup(),count=bestOf===1?0:bestOf===3?1:2,currentMap={mapId:String(101+count),mapNumber:count+1},r=await f.router.read({traceSha256:f.trace('LIVE',currentMap),seriesInput:series(bestOf,count),phase:'LIVE',currentMap,decisionAt:AT});assert.equal(r.main.seriesId,'series:7');assert.equal(r.main.targetId,'SERIES_LIVE');assert.equal(r.detail.mapId,currentMap.mapId);assert.equal(r.main.eventRelation,bestOf===1?'same_event_as_only_map':'whole_series');}
});
test('series PRE works before any map ID or Radiant/Dire assignment',async()=>{
 const f=setup(),r=await f.router.read({traceSha256:f.trace('SERIES_PRE'),seriesInput:series(),phase:'SERIES_PRE',decisionAt:AT});assert.equal(r.main.targetId,'SERIES_PRE');assert.equal(r.main.team1CurrentSide,null);assert.equal(r.currentMapId,null);assert.equal(r.detail.status,'unavailable');
});
test('manual previous-map selection preserves its own actual heroes/results through current-map updates',async()=>{
 const f=setup(),currentMap={mapId:'103',mapNumber:3},input={traceSha256:f.trace('LIVE',currentMap),seriesInput:series(5,2),phase:'LIVE',currentMap,selection:{kind:'manual',mapId:'101'},decisionAt:AT},r=await f.router.read(input);assert.equal(r.main.targetId,'SERIES_LIVE');assert.equal(r.detail.status,'actual_result');assert.equal(r.detail.winnerTeamId,'100');assert.deepEqual(r.detail.heroes.team1,[21,22,23,24,25]);assert.equal(r.detail.historicalForecast,null);assert.equal(r.originalForecastReplayEnabled,false);
 const next={mapId:'104',mapNumber:4},update=await f.router.read({...input,currentMap:next,traceSha256:f.trace('LIVE',next),seriesInput:series(5,3),selection:r.selection});assert.equal(update.selectedMapId,'101');assert.deepEqual(update.detail.heroes,r.detail.heroes);assert.equal(update.main.status,'diagnostic_features_available');
});
test('completed series stops target selection and completed map shows actual results without invented original forecast',async()=>{
 const f=setup(),r=await f.router.read({traceSha256:'a'.repeat(64),seriesInput:series(3,2,['100','100']),phase:'COMPLETE',decisionAt:AT});assert.equal(r.main.status,'actual_result');assert.equal(r.main.winnerTeamId,'100');assert.equal(r.detail.mapId,'102');assert.equal(r.detail.status,'actual_result');assert.equal(r.detail.historicalForecast,null);assert.equal(f.calls.trace,0);
});
test('current team-side permutation changes the bridge while map and series winner orientations remain distinct',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},r=await f.router.read({traceSha256:f.trace('LIVE',currentMap,{radiant:'200'}),seriesInput:series(3,1),phase:'LIVE',currentMap,decisionAt:AT});assert.equal(r.main.orientation,'series_team1');assert.equal(r.main.team1CurrentSide,'dire');assert.equal(r.detail.targets.find(t=>t.metric==='winner').orientation,'map_radiant');assert.equal(r.detail.mapSides.radiant,'200');
});
test('kills/duration units and final/remaining semantics come from target metadata, never a filename',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2};for(const phase of ['PRE','POST','LIVE']){const r=await f.router.read({traceSha256:f.trace(phase,currentMap,{change:b=>b.filename='misleading-duration-kills.model'}),seriesInput:series(3,1),phase,currentMap,decisionAt:AT}),kills=r.detail.targets.find(t=>t.metric==='kills'),duration=r.detail.targets.find(t=>t.metric==='duration');assert.equal(kills.units,'kills');assert.equal(duration.units,'seconds');assert.equal(kills.totals.discrete,true);assert.equal(kills.quantity,phase==='LIVE'?'remaining':'final');assert.equal(duration.quantity,phase==='LIVE'?'remaining':'final');assert.equal(duration.totals.outputMetadataRequired,true);assert.equal(duration.totals.remainingToFinalConversionPerformed,false);assert.equal(duration.totals.distribution,null);}
});
test('unknown or damaged exact schema, wrong phase, map, series or team binding fail closed',async()=>{
 for(const change of [b=>b.routes[0].schemaRef.sha256='f'.repeat(64),b=>b.mode='POST',b=>b.matchId='999',b=>b.seriesId='other',b=>b.targetBinding.series.team1Id='200',b=>b.targetBinding.series.team1CurrentSide='dire',b=>b.routes[0].targetId='PRE_MAP_WIN']){const f=setup(),currentMap={mapId:'102',mapNumber:2},r=await f.router.read({traceSha256:f.trace('LIVE',currentMap,{change}),seriesInput:series(3,1),phase:'LIVE',currentMap,decisionAt:AT});assert.equal(r.main.status,'unavailable');assert.equal(r.detail.status,'unavailable');assert.equal(r.main.displayText,'Прогноз недоступен');assert.ok(r.sourceRejection);}
});
test('future trace availability at +1ns is not usable, and schema target mismatch is rejected',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},input={seriesInput:series(3,1),phase:'LIVE',currentMap,decisionAt:AT},future=await f.router.read({...input,traceSha256:f.trace('LIVE',currentMap,{change:b=>b.timings.featuresReadyAt='2026-10-23T13:00:00.000000001Z'})});assert.equal(future.main.status,'unavailable');
 const key=f.expectedSchemaHashes.LIVE_MAP_WIN[0],stored=f.trace('LIVE',currentMap);f.schemas.get(key).targetId='LIVE_KILLS';const bad=await f.router.read({...input,traceSha256:stored});assert.equal(bad.sourceRejection,'exact_schema_target_binding');
});
test('claimed static historical binding requires the new owned-journal CAS reference',async()=>{
 const f=setup(),base={seriesInput:series(),phase:'SERIES_PRE',decisionAt:AT},missing=await f.router.read({...base,traceSha256:f.trace('SERIES_PRE',null,{change:b=>b.historicalBindings={kind:'series_history',factsSha256:'a'.repeat(64),targetSha256:'b'.repeat(64)}})});assert.equal(missing.sourceRejection,'static_historical_input_reference_required');
 const accepted=await f.router.read({...base,traceSha256:f.trace('SERIES_PRE',null,{change:b=>{b.historicalBindings={kind:'series_history'};b.historicalInputRef={contract:'aegis.static-historical-input-reference.v1',sha256:'c'.repeat(64),bytes:500};}})});assert.equal(accepted.main.status,'diagnostic_features_available');assert.equal(accepted.main.sourceEvidence.historicalInputRef.contract,'aegis.static-historical-input-reference.v1');assert.equal(accepted.main.sourceEvidence.rawSourceReplayPerformedByRouter,false);
});
test('selection cannot escape this series and deployment requires an explicit complete schema allowlist',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2};await assert.rejects(()=>f.router.read({seriesInput:series(3,1),phase:'LIVE',currentMap,selection:{kind:'manual',mapId:'999'},decisionAt:AT}),/selected_map_not_in_series/);assert.throws(()=>createDiagnosticTargetRouter({journal:f.journal,targetDocument:f.targetDocument,expectedSchemaHashes:{}}),/exact_schema_allowlist/);await assert.rejects(()=>f.router.read({seriesInput:series(),phase:'COMPLETE',decisionAt:AT}),/series_not_complete/);
});
