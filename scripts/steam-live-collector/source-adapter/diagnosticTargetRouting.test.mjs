import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {TARGET_IDS,digest} from '../../feature-registry/registry-contract.mjs';
import {createDiagnosticTargetRouter} from './diagnosticTargetRouting.mjs';
import {createDiagnosticFeatureJournal} from './diagnosticFeatureJournal.mjs';
import {createDiagnosticFeatureReadApi} from './diagnosticFeatureReadApi.mjs';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const AT='2026-10-23T13:00:00Z',TRACE_AT='2026-10-23T12:40:00Z';
const pinned=data=>{const utf8=JSON.stringify(data);return{utf8,pin:{path:'synthetic-series.json',bytes:Buffer.byteLength(utf8),sha256:createHash('sha256').update(utf8).digest('hex')}};};
const phaseIds={PRE:['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','SERIES_PRE'],POST:['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE'],LIVE:['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE'],BETWEEN:['SERIES_BETWEEN'],SERIES_PRE:['SERIES_PRE']};
function series(bestOf=3,count=0,winners=null){return pinned({contract:'aegis.series-map-receipts.v1',seriesId:'series:7',team1Id:'100',team2Id:'200',bestOf,availableAt:'2026-10-23T12:30:00Z',completeThroughMapNumber:count,previousMaps:Array.from({length:count},(_,i)=>({mapId:String(101+i),mapNumber:i+1,winnerTeamId:winners?.[i]??(i%2?'200':'100'),durationSeconds:1800,team1Kills:20+i,team2Kills:10+i,finishedAt:`2026-10-${10+i}T12:30:00Z`,availableAt:`2026-10-${10+i}T13:00:00Z`,team1Heroes:[21+i*10,22+i*10,23+i*10,24+i*10,25+i*10],team2Heroes:[26+i*10,27+i*10,28+i*10,29+i*10,30+i*10]}))});}
function setup(){
 const targetDocument=syntheticRegistry()[2],schemas=new Map(),expectedSchemaHashes=Object.fromEntries(TARGET_IDS.map(id=>[id,[]])),traces=new Map(),calls={trace:0,schema:0};
 for(const meta of targetDocument.targets)for(const stateMode of meta.stateModes){const schema={contract:'aegis.unified-feature-projection-schema.v1',targetId:meta.id,stateMode,definitions:[{name:'synthetic.'+meta.id}]},key=digest(schema);schemas.set(key,schema);expectedSchemaHashes[meta.id].push(key);}
 const journal={loadTrace:async key=>{calls.trace++;if(!traces.has(key))throw Error('private-evidence-path');return structuredClone(traces.get(key));},loadSchema:async key=>{calls.schema++;return structuredClone(schemas.get(key));}};
 const router=createDiagnosticTargetRouter({journal,targetDocument,expectedSchemaHashes});
 function trace(phase,currentMap=null,{radiant='100',change=null,seriesInput=series(3,phase==='SERIES_PRE'?0:currentMap?currentMap.mapNumber-1:1)}={}){
  const routes=phaseIds[phase].map(targetId=>{const stateMode=targetId==='SERIES_LIVE'?(phase==='LIVE'?'observed_live':'observed_postdraft'):targetDocument.targets.find(t=>t.id===targetId).stateModes[0],schemaKey=[...schemas].find(([,s])=>s.targetId===targetId&&s.stateMode===stateMode)[0];return{targetId,stateMode,schemaRef:{sha256:schemaKey,featureCount:1},featureCount:1,vectorRef:digest(targetId)};});
  const body={contract:'aegis.diagnostic-feature-trace.v1',mode:phase,matchId:currentMap?.mapId??null,seriesId:'series:7',seriesReceiptPin:seriesInput.pin,decisionAt:TRACE_AT,availableAt:TRACE_AT,timings:{featuresReadyAt:TRACE_AT},sourceSnapshotHash:null,targetBinding:{mapId:currentMap?.mapId??null,mapOutcome:currentMap?'map_radiant_win':null,mapSides:currentMap?{radiant,dire:radiant==='100'?'200':'100'}:null,series:{seriesId:'series:7',team1Id:'100',team2Id:'200',outcome:'series_team1_win',team1CurrentSide:currentMap?(radiant==='100'?'radiant':'dire'):null}},routes,vectors:{},eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};if(change)change(body);const key=digest(body);traces.set(key,body);return key;
 }
 return{router,trace,calls,schemas,traces,targetDocument,expectedSchemaHashes,journal};
}

test('all twelve logical targets route by registry phase/metric metadata into series main and map detail',async()=>{
 const f=setup(),seen=new Set();for(const phase of ['PRE','POST','LIVE','BETWEEN','SERIES_PRE']){
  const count=['PRE','SERIES_PRE'].includes(phase)?0:1,currentMap=['PRE','POST','LIVE'].includes(phase)?{mapId:String(101+count),mapNumber:count+1}:null,seriesInput=series(3,count),traceSha256=f.trace(phase,currentMap,{seriesInput}),r=await f.router.read({traceSha256,seriesInput,phase,currentMap,decisionAt:AT});assert.equal(r.main.entity,'series');assert.equal(r.main.status,'diagnostic_features_available');seen.add(r.main.targetId);
  if(currentMap){assert.equal(r.selectedMapId,currentMap.mapId);assert.equal(r.detail.entity,'map');assert.equal(r.detail.targets.length,3);for(const d of r.detail.targets){seen.add(d.targetId);assert.equal(d.prediction,null);assert.equal(d.eligibleForServing,false);}}
  else assert.equal(r.detail.status,'unavailable');
 }
 assert.deepEqual([...seen].sort(),[...TARGET_IDS].sort());
});
test('BO1/BO3/BO5 keep explicit series identity and selected current map independent',async()=>{
 for(const bestOf of [1,3,5]){const f=setup(),count=bestOf===1?0:bestOf===3?1:2,currentMap={mapId:String(101+count),mapNumber:count+1},seriesInput=series(bestOf,count),r=await f.router.read({traceSha256:f.trace('LIVE',currentMap,{seriesInput}),seriesInput,phase:'LIVE',currentMap,decisionAt:AT});assert.equal(r.main.seriesId,'series:7');assert.equal(r.main.targetId,'SERIES_LIVE');assert.equal(r.detail.mapId,currentMap.mapId);assert.equal(r.main.eventRelation,bestOf===1?'same_event_as_only_map':'whole_series');}
});
test('series PRE works before any map ID or Radiant/Dire assignment',async()=>{
 const f=setup(),r=await f.router.read({traceSha256:f.trace('SERIES_PRE'),seriesInput:series(),phase:'SERIES_PRE',decisionAt:AT});assert.equal(r.main.targetId,'SERIES_PRE');assert.equal(r.main.team1CurrentSide,null);assert.equal(r.currentMapId,null);assert.equal(r.detail.status,'unavailable');
});
test('manual previous-map selection preserves its own actual heroes/results through current-map updates',async()=>{
 const f=setup(),currentMap={mapId:'103',mapNumber:3},seriesInput=series(5,2),input={traceSha256:f.trace('LIVE',currentMap,{seriesInput}),seriesInput,phase:'LIVE',currentMap,selection:{kind:'manual',mapId:'101'},decisionAt:AT},r=await f.router.read(input);assert.equal(r.main.targetId,'SERIES_LIVE');assert.equal(r.detail.status,'actual_result');assert.equal(r.detail.winnerTeamId,'100');assert.deepEqual(r.detail.heroes.team1,[21,22,23,24,25]);assert.equal(r.detail.historicalForecast,null);assert.equal(r.originalForecastReplayEnabled,false);
 const next={mapId:'104',mapNumber:4},nextSeries=series(5,3),update=await f.router.read({...input,currentMap:next,traceSha256:f.trace('LIVE',next,{seriesInput:nextSeries}),seriesInput:nextSeries,selection:r.selection});assert.equal(update.selectedMapId,'101');assert.deepEqual(update.detail.heroes,r.detail.heroes);assert.equal(update.main.status,'diagnostic_features_available');
});
test('completed series stops target selection and completed map shows actual results without invented original forecast',async()=>{
 const f=setup(),r=await f.router.read({traceSha256:'a'.repeat(64),seriesInput:series(3,2,['100','100']),phase:'COMPLETE',decisionAt:AT});assert.equal(r.main.status,'actual_result');assert.equal(r.main.winnerTeamId,'100');assert.equal(r.detail.mapId,'102');assert.equal(r.detail.status,'actual_result');assert.equal(r.detail.historicalForecast,null);assert.equal(f.calls.trace,0);
});
test('current team-side permutation changes the bridge while map and series winner orientations remain distinct',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},r=await f.router.read({traceSha256:f.trace('LIVE',currentMap,{radiant:'200'}),seriesInput:series(3,1),phase:'LIVE',currentMap,decisionAt:AT});assert.equal(r.main.orientation,'series_team1');assert.equal(r.main.team1CurrentSide,'dire');assert.equal(r.detail.targets.find(t=>t.metric==='winner').orientation,'map_radiant');assert.equal(r.detail.mapSides.radiant,'200');
});
test('kills/duration units and final/remaining semantics come from target metadata, never a filename',async()=>{
 const f=setup(),currentMap={mapId:'101',mapNumber:1};for(const phase of ['PRE','POST','LIVE']){const r=await f.router.read({traceSha256:f.trace(phase,currentMap,{change:b=>b.filename='misleading-duration-kills.model'}),seriesInput:series(3,0),phase,currentMap,decisionAt:AT}),kills=r.detail.targets.find(t=>t.metric==='kills'),duration=r.detail.targets.find(t=>t.metric==='duration');assert.equal(kills.units,'kills');assert.equal(duration.units,'seconds');assert.equal(kills.totals.discrete,true);assert.equal(kills.quantity,phase==='LIVE'?'remaining':'final');assert.equal(duration.quantity,phase==='LIVE'?'remaining':'final');assert.equal(duration.totals.outputMetadataRequired,true);assert.equal(duration.totals.remainingToFinalConversionPerformed,false);assert.equal(duration.totals.distribution,null);}
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
 const accepted=await f.router.read({...base,traceSha256:f.trace('SERIES_PRE',null,{change:b=>{b.historicalBindings={kind:'series_history',transitionId:'series:7:after:0'};b.historicalInputRef={contract:'aegis.static-historical-input-reference.v1',sha256:'c'.repeat(64),bytes:500};}})});assert.equal(accepted.main.status,'diagnostic_features_available');assert.equal(accepted.main.sourceEvidence.historicalInputRef.contract,'aegis.static-historical-input-reference.v1');assert.equal(accepted.main.sourceEvidence.rawSourceReplayPerformedByRouter,false);
});
test('selection cannot escape this series and deployment requires an explicit complete schema allowlist',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2};await assert.rejects(()=>f.router.read({seriesInput:series(3,1),phase:'LIVE',currentMap,selection:{kind:'manual',mapId:'999'},decisionAt:AT}),/selected_map_not_in_series/);assert.throws(()=>createDiagnosticTargetRouter({journal:f.journal,targetDocument:f.targetDocument,expectedSchemaHashes:{}}),/exact_schema_allowlist/);await assert.rejects(()=>f.router.read({seriesInput:series(),phase:'COMPLETE',decisionAt:AT}),/series_not_complete/);
});
test('same-series corrected score, draft, or BO format cannot relabel an old feature trace',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},original=series(3,1),traceSha256=f.trace('LIVE',currentMap,{seriesInput:original});
 for(const change of [s=>{s.bestOf=5;},s=>{s.previousMaps[0].winnerTeamId='200';},s=>{s.previousMaps[0].team1Heroes=[51,52,53,54,55];}]){
  const changed=JSON.parse(original.utf8);change(changed);const r=await f.router.read({traceSha256,seriesInput:pinned(changed),phase:'LIVE',currentMap,decisionAt:AT});assert.equal(r.sourceRejection,'trace_series_receipt_binding');assert.equal(r.main.status,'unavailable');
 }
 const moved={...original,pin:{...original.pin,path:'relocated-identical-series.json'}},r=await f.router.read({traceSha256,seriesInput:moved,phase:'LIVE',currentMap,decisionAt:AT});assert.equal(r.main.status,'diagnostic_features_available');
});
test('series pre cannot erase the existing score, while upcoming map PRE remains usable alone',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),args={seriesInput,phase:'PRE',currentMap,decisionAt:AT};
 const invalid=await f.router.read({...args,traceSha256:f.trace('PRE',currentMap,{seriesInput})});assert.equal(invalid.sourceRejection,'route_phase_or_schema');
 const valid=await f.router.read({...args,traceSha256:f.trace('PRE',currentMap,{seriesInput,change:b=>{b.routes=b.routes.filter(r=>r.targetId!=='SERIES_PRE');}})});assert.equal(valid.main.status,'unavailable');assert.equal(valid.detail.targets.length,3);
 await assert.rejects(()=>f.router.read({seriesInput,phase:'SERIES_PRE',decisionAt:AT}),/phase_series_progress/);
 await assert.rejects(()=>f.router.read({seriesInput:series(),phase:'BETWEEN',decisionAt:AT}),/phase_series_progress/);
});
test('retained replay binds series facts to the original source horizon, not later materialization',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),args={seriesInput,phase:'LIVE',currentMap,decisionAt:AT};
 const bad=await f.router.read({...args,traceSha256:f.trace('LIVE',currentMap,{seriesInput,change:b=>{b.reconstruction={sourceDecisionAt:'2026-10-23T12:29:59.999999999Z'};}})});assert.equal(bad.sourceRejection,'trace_series_source_horizon');
 const exact=await f.router.read({...args,traceSha256:f.trace('LIVE',currentMap,{seriesInput,change:b=>{b.reconstruction={sourceDecisionAt:'2026-10-23T12:30:00Z'};b.featureInputCutoffAt=b.reconstruction.sourceDecisionAt;}})});assert.equal(exact.main.status,'diagnostic_features_available');
 const forged=await f.router.read({...args,traceSha256:f.trace('LIVE',currentMap,{seriesInput,change:b=>{b.reconstruction={sourceDecisionAt:'2026-10-23T12:29:59Z'};b.featureInputCutoffAt=TRACE_AT;}})});assert.equal(forged.sourceRejection,'trace_series_source_horizon');
});

test('dual traces compose inter-map series main with upcoming map PRE without inventing SERIES_PRE',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),seriesTraceSha256=f.trace('BETWEEN',null,{seriesInput}),mapTraceSha256=f.trace('PRE',currentMap,{seriesInput,change:b=>{b.routes=b.routes.filter(r=>r.targetId!=='SERIES_PRE');}}),r=await f.router.read({seriesTraceSha256,mapTraceSha256,seriesInput,phase:'PRE',currentMap,decisionAt:AT});
 assert.equal(r.main.targetId,'SERIES_BETWEEN');assert.equal(r.main.traceSha256,seriesTraceSha256);assert.equal(r.main.team1CurrentSide,null);assert.equal(r.detail.mapId,'102');assert.equal(r.detail.targets.length,3);assert.ok(r.detail.targets.every(t=>t.phase==='PRE'&&t.traceSha256===mapTraceSha256));assert.deepEqual(r.panelRejections,{series:null,map:null});
});
test('explicit dual references cover BO1/BO3/BO5 before map1, next draft and current live',async()=>{
 for(const bestOf of [1,3,5])for(const phase of ['PRE','POST','LIVE']){
  const f=setup(),count=bestOf===1?0:1,currentMap={mapId:String(101+count),mapNumber:count+1},seriesInput=series(bestOf,count),seriesPhase=phase==='PRE'?(count?'BETWEEN':'SERIES_PRE'):phase,seriesTraceSha256=f.trace(seriesPhase,['PRE','SERIES_PRE','BETWEEN'].includes(seriesPhase)?null:currentMap,{seriesInput}),mapTraceSha256=f.trace(phase,currentMap,{seriesInput,change:b=>{if(count&&phase==='PRE')b.routes=b.routes.filter(r=>r.targetId!=='SERIES_PRE');}}),r=await f.router.read({seriesTraceSha256,mapTraceSha256,seriesInput,phase,currentMap,decisionAt:AT});
  assert.equal(r.main.status,'diagnostic_features_available');assert.equal(r.main.targetId,phase==='PRE'?(count?'SERIES_BETWEEN':'SERIES_PRE'):'SERIES_LIVE');assert.equal(r.detail.targets.length,3);assert.equal(r.main.eventRelation,bestOf===1?'same_event_as_only_map':'whole_series');
 }
});
test('independent missing or corrupt trace disables only its own panel',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),base={seriesInput,phase:'PRE',currentMap,decisionAt:AT},seriesTraceSha256=f.trace('BETWEEN',null,{seriesInput}),mapTraceSha256=f.trace('PRE',currentMap,{seriesInput,change:b=>{b.routes=b.routes.filter(r=>r.targetId!=='SERIES_PRE');}});
 for(const bad of [null,'f'.repeat(64)]){const mainOnly=await f.router.read({...base,seriesTraceSha256,mapTraceSha256:bad});assert.equal(mainOnly.main.status,'diagnostic_features_available');assert.equal(mainOnly.detail.status,'unavailable');const detailOnly=await f.router.read({...base,seriesTraceSha256:bad,mapTraceSha256});assert.equal(detailOnly.main.status,'unavailable');assert.equal(detailOnly.detail.status,'diagnostic_features_available');}
 const forged=f.trace('PRE',currentMap,{seriesInput,change:b=>{b.routes=b.routes.filter(r=>r.targetId!=='SERIES_PRE');b.targetBinding.series.team1Id='200';}}),r=await f.router.read({...base,seriesTraceSha256,mapTraceSha256:forged});assert.equal(r.main.status,'diagnostic_features_available');assert.equal(r.panelRejections.map,'trace_series_orientation');
 await assert.rejects(()=>f.router.read({...base,traceSha256:mapTraceSha256,seriesTraceSha256}),/ambiguous_trace_references/);
});
test('each independent trace keeps its own valid source horizon and exact common receipt',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),base={seriesInput,phase:'PRE',currentMap,decisionAt:AT},seriesTraceSha256=f.trace('BETWEEN',null,{seriesInput,change:b=>{b.reconstruction={sourceDecisionAt:'2026-10-23T12:30:00Z'};b.featureInputCutoffAt=b.reconstruction.sourceDecisionAt;}}),mapTraceSha256=f.trace('PRE',currentMap,{seriesInput,change:b=>{b.routes=b.routes.filter(r=>r.targetId!=='SERIES_PRE');b.reconstruction={sourceDecisionAt:'2026-10-23T12:31:00Z'};b.featureInputCutoffAt=b.reconstruction.sourceDecisionAt;}}),r=await f.router.read({...base,seriesTraceSha256,mapTraceSha256});assert.equal(r.main.status,'diagnostic_features_available');assert.equal(r.detail.status,'diagnostic_features_available');
 for(const mutate of [s=>{s.bestOf=5;},s=>{s.previousMaps[0].winnerTeamId='200';},s=>{s.seriesId='different-series';},s=>{s.previousMaps[0].team2Heroes=[81,82,83,84,85];}]){const changed=JSON.parse(seriesInput.utf8);mutate(changed);const changedInput=pinned(changed),wrong=f.trace('PRE',currentMap,{seriesInput:changedInput,change:b=>{b.routes=b.routes.filter(r=>r.targetId!=='SERIES_PRE');}}),bad=await f.router.read({...base,seriesTraceSha256,mapTraceSha256:wrong});assert.equal(bad.main.status,'diagnostic_features_available');assert.equal(bad.detail.status,'unavailable');assert.equal(bad.panelRejections.map,'trace_series_receipt_binding');}
});
test('dual current map traces cannot disagree on the team-side bridge',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),r=await f.router.read({seriesTraceSha256:f.trace('LIVE',currentMap,{seriesInput}),mapTraceSha256:f.trace('LIVE',currentMap,{seriesInput,radiant:'200'}),seriesInput,phase:'LIVE',currentMap,decisionAt:AT});assert.equal(r.main.status,'unavailable');assert.equal(r.detail.status,'unavailable');assert.deepEqual(r.panelRejections,{series:'trace_pair_map_orientation',map:'trace_pair_map_orientation'});
});
test('an exact receipt cannot hide a different declared series transition',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),seriesTraceSha256=f.trace('BETWEEN',null,{seriesInput,change:b=>{b.historicalBindings={kind:'series_history',transitionId:'series:7:after:0'};b.historicalInputRef={contract:'aegis.static-historical-input-reference.v1',sha256:'c'.repeat(64),bytes:500};}}),r=await f.router.read({seriesTraceSha256,seriesInput,phase:'PRE',currentMap,decisionAt:AT});assert.equal(r.main.status,'unavailable');assert.equal(r.panelRejections.series,'trace_series_transition_binding');
});
test('manual prior-map detail preserves its own result when current map evidence is absent or unusable',async()=>{
 const f=setup(),currentMap={mapId:'103',mapNumber:3},seriesInput=series(5,2),r=await f.router.read({seriesTraceSha256:f.trace('LIVE',currentMap,{seriesInput}),mapTraceSha256:'f'.repeat(64),seriesInput,phase:'LIVE',currentMap,selection:{kind:'manual',mapId:'101'},decisionAt:AT});assert.equal(r.main.targetId,'SERIES_LIVE');assert.equal(r.detail.status,'actual_result');assert.deepEqual(r.detail.heroes.team1,[21,22,23,24,25]);assert.equal(r.detail.historicalForecast,null);assert.equal(r.originalForecastReplayEnabled,false);
});
test('configured live eligibility must authorize the exact trace and observation, including silent read expiry',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),observation='d'.repeat(64),key=f.trace('LIVE',currentMap,{seriesInput,change:b=>{b.nativeObservationId=observation;}}),base={seriesTraceSha256:key,mapTraceSha256:key,seriesInput,phase:'LIVE',currentMap,decisionAt:AT};let eligible=true,lastTraceSha256=key,observationId=observation,calls=0;
 const router=createDiagnosticTargetRouter({...f,now:()=>AT,readLiveEligibility:input=>{calls++;assert.equal(input.matchId,'102');assert.equal(input.decisionAt,AT);return{eligibleForRetainingForecast:eligible,lastTraceSha256,stateView:{observationId,lastConfirmedAt:'2026-10-23T12:55:00Z',expiresAt:AT,continuityGeneration:0},ageSeconds:300,reason:'synthetic_qualified_state'};}});
 const accepted=await router.read(base);assert.equal(accepted.main.currentLiveEligibility.eligibleForRetainingForecast,true);assert.equal(accepted.detail.currentLiveEligibility.lastTraceSha256,key);assert.equal(accepted.main.prediction,null);assert.equal(accepted.main.eligibleForServing,false);
 for(const mutate of [()=>{eligible=false;},()=>{eligible=true;lastTraceSha256='a'.repeat(64);},()=>{lastTraceSha256=key;observationId='b'.repeat(64);}]){mutate();const rejected=await router.read(base);assert.equal(rejected.main.status,'unavailable');assert.equal(rejected.detail.status,'unavailable');}
 const past=await router.read({...base,selection:{kind:'manual',mapId:'101'}});assert.equal(past.main.status,'unavailable');assert.equal(past.detail.status,'actual_result');assert.equal(calls,5);
 const unconfigured=await f.router.read(base);assert.equal(unconfigured.main.status,'diagnostic_features_available');assert.equal(unconfigured.main.currentLiveEligibility.reason,'owned_live_eligibility_port_not_configured');assert.equal(unconfigured.main.currentLiveEligibility.eligibleForRetainingForecast,false);
});
test('one stale live reference does not suppress the other eligible panel',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),observation='d'.repeat(64),seriesTraceSha256=f.trace('LIVE',currentMap,{seriesInput,change:b=>{b.nativeObservationId=observation;}}),mapTraceSha256=f.trace('LIVE',currentMap,{seriesInput,change:b=>{b.nativeObservationId=observation;b.decisionAt='2026-10-23T12:39:59Z';}}),router=createDiagnosticTargetRouter({...f,now:()=>AT,readLiveEligibility:()=>({eligibleForRetainingForecast:true,lastTraceSha256:seriesTraceSha256,stateView:{observationId:observation,lastConfirmedAt:'2026-10-23T12:55:00Z',expiresAt:AT},reason:'synthetic_current_reference'})}),r=await router.read({seriesTraceSha256,mapTraceSha256,seriesInput,phase:'LIVE',currentMap,decisionAt:AT});assert.equal(r.main.status,'diagnostic_features_available');assert.equal(r.detail.status,'unavailable');assert.equal(r.panelRejections.map,'current_live_trace_binding');assert.equal(r.panelRejections.series,null);
});
test('deferred evidence IO uses one final source snapshot across expiry, STOP and a changed observation',async()=>{
 for(const change of ['expiry','stop','observation']){
  const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),observation='d'.repeat(64),key=f.trace('LIVE',currentMap,{seriesInput,change:b=>{b.nativeObservationId=observation;}});
  let time='2026-10-23T12:59:59Z',eligible=true,observationId=observation,reads=0,receivedAt=null,release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;}),original=f.journal.loadSchema;
  f.journal.loadSchema=async hash=>{entered();await gate;return original(hash);};
  const router=createDiagnosticTargetRouter({...f,now:()=>time,readLiveEligibility:input=>{reads++;receivedAt=input.decisionAt;return{eligibleForRetainingForecast:eligible,lastTraceSha256:key,stateView:{observationId,lastConfirmedAt:'2026-10-23T12:55:00Z',expiresAt:AT,continuityGeneration:1}};}});
  const pending=router.read({seriesTraceSha256:key,mapTraceSha256:key,seriesInput,phase:'LIVE',currentMap,decisionAt:time});await started;
  if(change==='expiry')time='2026-10-23T13:00:00.000000001Z';else if(change==='stop')eligible=false;else observationId='e'.repeat(64);
  release();const r=await pending;assert.equal(reads,1);assert.equal(receivedAt,time);assert.equal(r.main.status,'unavailable');assert.equal(r.detail.status,'unavailable');assert.equal(r.panelRejections.series,change==='observation'?'current_live_trace_binding':'current_live_state_ineligible');assert.equal(r.panelRejections.map,r.panelRejections.series);
 }
});
test('owned finalizer closes the router-await boundary while preserving prior-map actuals',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),observation='d'.repeat(64),key=f.trace('LIVE',currentMap,{seriesInput,change:b=>{b.nativeObservationId=observation;}});
 let eligible=true,time=AT,reads=0;const router=createDiagnosticTargetRouter({...f,now:()=>time,readLiveEligibility:()=>{reads++;return{eligibleForRetainingForecast:eligible,lastTraceSha256:key,stateView:{observationId:observation,lastConfirmedAt:'2026-10-23T12:55:00Z',expiresAt:AT,continuityGeneration:2}};}}),context={seriesTraceSha256:key,mapTraceSha256:key,seriesInput,phase:'LIVE',currentMap,selection:{kind:'manual',mapId:'101'},decisionAt:AT};
 const route=await router.read(context);assert.equal(route.main.currentLiveEligibility.evaluatedAt,AT);assert.equal(route.main.currentLiveEligibility.continuityGeneration,2);assert.equal(reads,1);
 assert.throws(()=>router.finalizeRead(structuredClone(route)),/owned_route_read_required/);
 time='2026-10-23T13:00:00.000000001Z';const expired=router.finalizeRead(route);assert.equal(expired.main.status,'unavailable');assert.equal(expired.detail.status,'actual_result');assert.deepEqual(expired.detail.heroes.team1,[21,22,23,24,25]);
 time=AT;const api=createDiagnosticFeatureReadApi({journal:f.journal,enabled:true,now:()=>time,resolveRouteContext:async()=>context,targetRouter:{async read(input){const value=await router.read(input);eligible=false;return value;},finalizeRead:router.finalizeRead}});
 const response=await api.handle({url:'/admin/feature-diagnostics/series/series%3A7/routes?mapId=101'});assert.equal(response.status,200);assert.equal(response.body.main.status,'unavailable');assert.equal(response.body.detail.status,'actual_result');
 const entry=await api.handle({url:'/admin/feature-diagnostics/series/series%3A7/routes'});assert.equal(entry.status,200);assert.equal(entry.body.selectedMapId,currentMap.mapId);assert.equal(entry.body.detail.status,'unavailable');
});
test('async eligibility ports cannot mint a final current claim and backwards final clocks fail closed',async()=>{
 const f=setup(),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1),observation='d'.repeat(64),key=f.trace('LIVE',currentMap,{seriesInput,change:b=>{b.nativeObservationId=observation;}}),state={eligibleForRetainingForecast:true,lastTraceSha256:key,stateView:{observationId:observation,lastConfirmedAt:'2026-10-23T12:55:00Z',expiresAt:AT}},args={seriesTraceSha256:key,mapTraceSha256:key,seriesInput,phase:'LIVE',currentMap,decisionAt:AT};
 const asyncRouter=createDiagnosticTargetRouter({...f,now:()=>AT,readLiveEligibility:async()=>state}),rejected=await asyncRouter.read(args);assert.equal(rejected.main.status,'unavailable');assert.equal(rejected.detail.status,'unavailable');
 let time=AT;const router=createDiagnosticTargetRouter({...f,now:()=>time,readLiveEligibility:()=>state}),route=await router.read({...args,decisionAt:'2026-10-23T12:59:00Z'});assert.equal(route.main.status,'diagnostic_features_available');
 time='2026-10-23T12:59:59Z';assert.equal(router.finalizeRead(route).main.status,'unavailable');
});
test('dual routing and saved feature reader use an actual content-addressed journal without starting collection',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aegis-dual-route-'));
 try{
  const f=setup(),journal=createDiagnosticFeatureJournal({directory}),currentMap={mapId:'102',mapNumber:2},seriesInput=series(3,1);
  for(const [schemaHash,schema]of f.schemas)await journal.writeSchema({schemaHash,schema});
  async function persist(key){const body=structuredClone(f.traces.get(key));body.vectors={};for(const route of body.routes){const schema=f.schemas.get(route.schemaRef.sha256),vector={namesHash:digest(schema.definitions.map(d=>d.name)),values:[1],missing:[false]};route.vectorRef=digest(vector);body.vectors[route.vectorRef]=vector;}const utf8=JSON.stringify(body),hash=createHash('sha256').update(utf8).digest('hex');await journal.appendTrace({contract:body.contract,utf8,sha256:hash,bytes:Buffer.byteLength(utf8)});return hash;}
  const seriesTraceSha256=await persist(f.trace('BETWEEN',null,{seriesInput})),mapTraceSha256=await persist(f.trace('PRE',currentMap,{seriesInput,change:b=>{b.routes=b.routes.filter(r=>r.targetId!=='SERIES_PRE');}})),router=createDiagnosticTargetRouter({...f,journal}),r=await router.read({seriesTraceSha256,mapTraceSha256,seriesInput,phase:'PRE',currentMap,decisionAt:AT});assert.equal(r.main.targetId,'SERIES_BETWEEN');assert.equal(r.detail.targets.length,3);
  const api=createDiagnosticFeatureReadApi({journal,enabled:true}),main=await api.handle({url:'/admin/feature-diagnostics/traces/'+seriesTraceSha256}),page=await api.handle({url:'/admin/feature-diagnostics/traces/'+mapTraceSha256+'/features/PRE_MAP_WIN?limit=1'});assert.equal(main.status,200);assert.equal(main.body.routes[0].targetId,'SERIES_BETWEEN');assert.equal(page.status,200);assert.equal(page.body.features[0].value,1);assert.equal(page.body.recordedPrediction,false);
  let resolved=0;const routesApi=createDiagnosticFeatureReadApi({journal,enabled:true,targetRouter:router,now:()=>AT,resolveRouteContext:async({seriesId})=>{resolved++;assert.equal(seriesId,'series:7');return{seriesTraceSha256,mapTraceSha256,seriesInput,phase:'PRE',currentMap,decisionAt:'2026-10-23T00:00:00Z'};}}),endpoint='/admin/feature-diagnostics/series/'+encodeURIComponent('series:7')+'/routes',routeResult=await routesApi.handle({url:endpoint});assert.equal(routeResult.status,200);assert.equal(routeResult.body.main.targetId,'SERIES_BETWEEN');assert.equal(routeResult.body.detail.targets[0].targetId,'PRE_MAP_WIN');assert.equal(routeResult.body.detail.mapId,'102');assert.equal(resolved,1);assert.equal((await routesApi.handle({url:endpoint+'?decisionAt='+TRACE_AT})).status,400);assert.equal(resolved,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
