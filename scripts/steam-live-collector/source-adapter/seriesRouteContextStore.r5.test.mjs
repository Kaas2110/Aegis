import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSeriesRouteContextStore,SERIES_ROUTE_REVISION_KIND as REV,SERIES_ROUTE_POINTER_KIND as PTR} from './seriesRouteContextStore.mjs';
import {createDiagnosticTargetRouter} from './diagnosticTargetRouting.mjs';
import {createDiagnosticFeatureJournal} from './diagnosticFeatureJournal.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {TARGET_IDS,digest} from '../../feature-registry/registry-contract.mjs';
const AT='2026-10-24T13:00:00Z',KNOWN='2026-10-24T12:00:00Z';
const hash=x=>createHash('sha256').update(x).digest('hex');
function pin(data){const utf8=typeof data==='string'?data:JSON.stringify(data);return{utf8,pin:{path:'synthetic-local-path-never-opened',sha256:hash(utf8),bytes:Buffer.byteLength(utf8)}};}
function receipt({bestOf=3,count=0,winners=null,availableAt=KNOWN,seriesId='series:7'}={}){
 return pin({contract:'aegis.series-map-receipts.v1',seriesId,team1Id:'100',team2Id:'200',bestOf,availableAt,completeThroughMapNumber:count,previousMaps:Array.from({length:count},(_,i)=>({mapId:String(101+i),mapNumber:i+1,winnerTeamId:winners?.[i]??(i%2?'200':'100'),durationSeconds:1800,team1Kills:20+i,team2Kills:10+i,finishedAt:`2026-10-${10+i}T12:30:00Z`,availableAt:`2026-10-${10+i}T13:00:00Z`,team1Heroes:[21+i*10,22+i*10,23+i*10,24+i*10,25+i*10],team2Heroes:[26+i*10,27+i*10,28+i*10,29+i*10,30+i*10]}))});
}
function memoryCas(){
 const values=new Map(),calls=[];let beforeCommit=null,afterCommit=null;
 return{values,calls,setBefore(fn){beforeCommit=fn;},setAfter(fn){afterCommit=fn;},async commit(input){calls.push(input);if(beforeCommit)await beforeCommit(input);assert.equal(hash(input.utf8),input.expectedSha256);const ref=Object.freeze({kind:input.kind,sha256:input.expectedSha256,bytes:Buffer.byteLength(input.utf8)});values.set(ref.kind+':'+ref.sha256,input.utf8);if(afterCommit)await afterCommit(input,ref);return ref;},async read(ref){const value=values.get(ref.kind+':'+ref.sha256);if(value===undefined)throw Error('synthetic_missing_object');return value;}};
}
function setup(options={}){const storage=options.storage??memoryCas();let time=AT,continueWork=true;const store=createSeriesRouteContextStore({storage,now:()=>time,shouldContinue:()=>continueWork,...options});return{storage,store,setTime(x){time=x;},stop(){continueWork=false;},resume(){continueWork=true;}};}
const entry=(seriesInput,phase='SERIES_PRE',rest={})=>({seriesInput,phase,...rest});
const currentMap=(number=1)=>({mapId:String(100+number),mapNumber:number});
const changed=(old,mutate)=>{const data=JSON.parse(old.utf8);mutate(data);return pin(data);};
const correction=(old,availableAt='2026-10-24T12:01:00Z')=>pin({contract:'aegis.series-route-correction-receipt.v1',seriesId:JSON.parse(old.utf8).seriesId,supersedesSeriesReceiptSha256:old.pin.sha256,availableAt,reason:'Synthetic retained source correction'});

test('owned immutable PRE context needs no map ID, sides, caller time or path IO',async()=>{
 const f=setup(),original=receipt(),input=entry(original),saved=await f.store.commitContext(input);assert.equal(saved.status,'committed_current_context');assert.deepEqual(f.storage.calls.map(x=>x.kind),[REV,PTR]);
 original.pin.path='https://untrusted.example/never-fetch';input.phase='LIVE';const resolved=f.store.resolve({seriesId:'series:7'});assert.equal(resolved.phase,'SERIES_PRE');assert.equal(resolved.currentMap,null);assert.equal(resolved.mapTraceSha256,null);assert.equal(resolved.seriesInput.pin.path,'series-receipts/'+original.pin.sha256+'.json');assert.ok(Object.isFrozen(resolved.seriesInput.pin));
 assert.throws(()=>f.store.resolve({seriesId:'series:7',decisionAt:KNOWN}),/object_keys_or_accessor/);assert.equal(f.store.resolve({seriesId:'absent'}),null);
 const reused=await f.store.commitContext(entry(receipt()));assert.equal(reused.status,'existing_current_context');assert.equal(f.storage.calls.length,2);
});

test('BO1, BO3 and BO5 retain exact causal prefix through all maps and terminal actuals',async()=>{
 for(const bestOf of [1,3,5]){const f=setup(),needed=(bestOf+1)/2;await f.store.commitContext(entry(receipt({bestOf})));
  for(let n=1;n<=needed;n++){const seriesInput=receipt({bestOf,count:n-1,winners:Array(n-1).fill('100'),availableAt:`2026-10-24T12:0${(n-1)*2}:00Z`});for(const phase of ['PRE','POST','LIVE'])await f.store.commitContext(entry(seriesInput,phase,{currentMap:currentMap(n)}));
   const terminal=n===needed,completed=receipt({bestOf,count:n,winners:Array(n).fill('100'),availableAt:`2026-10-24T12:0${(n-1)*2+1}:00Z`});await f.store.commitContext(entry(completed,terminal?'COMPLETE':'BETWEEN'));
   const route=f.store.resolve({seriesId:'series:7',selection:{kind:'manual',mapId:'101'}});assert.equal(route.currentMap,null);assert.equal(route.phase,terminal?'COMPLETE':'BETWEEN');assert.equal(route.selection.mapId,'101');assert.equal(JSON.parse(route.seriesInput.utf8).previousMaps[0].winnerTeamId,'100');
  }
 }
});

test('completed prefix, identity, current map, phase and source time cannot silently regress',async()=>{
 const scenarios=[
  {old:entry(receipt({count:1}),'BETWEEN'),next:entry(receipt({availableAt:'2026-10-24T12:01:00Z'})),error:/completed_prefix_regression/},
  {old:entry(receipt()),next:entry(changed(receipt(),s=>{s.availableAt='2026-10-24T11:59:59Z';})),error:/availability_regression/},
  {old:entry(receipt()),next:entry(changed(receipt(),s=>{s.team1Id='300';s.availableAt='2026-10-24T12:01:00Z';})),error:/known_series_identity/},
  {old:entry(receipt(),'LIVE',{currentMap:currentMap()}),next:entry(receipt(),'POST',{currentMap:currentMap()}),error:/phase_regression/},
  {old:entry(receipt(),'POST',{currentMap:currentMap()}),next:entry(receipt(),'POST',{currentMap:{mapId:'999',mapNumber:1}}),error:/retraction_or_replacement/},
  {old:entry(receipt(),'LIVE',{currentMap:currentMap()}),next:entry(receipt()),error:/retraction_or_replacement/},
  {old:entry(receipt(),'LIVE',{currentMap:currentMap()}),next:entry(changed(receipt({count:1,availableAt:'2026-10-24T12:01:00Z'}),s=>{s.previousMaps[0].mapId='999';}),'BETWEEN'),error:/completed_current_map_identity_conflict/},
  {old:entry(receipt({count:1}),'BETWEEN'),next:entry(changed(receipt({count:1,availableAt:'2026-10-24T12:01:00Z'}),s=>{s.previousMaps[0].mapId='999';}),'BETWEEN'),error:/known_map_prefix_identity/}
 ];
 for(const s of scenarios){const f=setup();await f.store.commitContext(s.old);await assert.rejects(f.store.commitContext(s.next),s.error);assert.equal(f.storage.calls.length,2);}
 const f=setup();await f.store.commitContext(entry(receipt()));f.setTime('2026-10-24T12:59:59Z');await assert.rejects(f.store.commitContext(entry(receipt(),'PRE',{currentMap:currentMap()})),/availability_regression/);assert.throws(()=>f.store.resolve({seriesId:'series:7'}),/clock_regression/);
});

test('corrected known facts require linked later receipt and cannot inherit old trace references',async()=>{
 const f=setup(),old=receipt({count:1}),original=entry(old,'BETWEEN',{seriesTraceSha256:'a'.repeat(64)});await f.store.commitContext(original);
 const sameTime=changed(old,s=>{s.previousMaps[0].winnerTeamId='200';});await assert.rejects(f.store.commitContext(entry(sameTime,'BETWEEN')),/same_time_series_receipt_conflict/);
 const newer=changed(sameTime,s=>{s.availableAt='2026-10-24T12:01:00Z';}),correct=correction(old);
 await assert.rejects(f.store.commitContext(entry(newer,'BETWEEN')),/explicit_linked_correction_required/);
 await assert.rejects(f.store.commitContext(entry(newer,'BETWEEN',{correctionInput:correct,seriesTraceSha256:'a'.repeat(64)})),/correction_reuses_prior_trace/);
 await assert.rejects(f.store.commitContext(entry(newer,'BETWEEN',{correctionInput:correction(receipt({count:0}))})),/correction_receipt_binding/);
 await f.store.commitContext(entry(newer,'BETWEEN',{correctionInput:correct,seriesTraceSha256:'b'.repeat(64)}));assert.equal(f.store.resolve({seriesId:'series:7'}).seriesTraceSha256,'b'.repeat(64));
 await assert.rejects(f.store.commitContext(entry(newer,'BETWEEN',{correctionInput:correct})),/correction_without_changed_known_fact/);
});

test('semantically unchanged reformatted receipt is allowed but its exact new bytes stay pinned',async()=>{
 const f=setup(),original=receipt({count:1});await f.store.commitContext(entry(original,'BETWEEN'));const data=JSON.parse(original.utf8);data.previousMaps[0].team1Heroes.reverse();const reformatted=pin(JSON.stringify(data,null,2));await f.store.commitContext(entry(reformatted,'BETWEEN'));const r=f.store.resolve({seriesId:'series:7'});assert.equal(r.seriesInput.pin.sha256,reformatted.pin.sha256);assert.notEqual(r.seriesInput.pin.sha256,original.pin.sha256);
});

test('pointer-last ambiguous commit blocks partial exposure and explicit verified recovery restores it',async()=>{
 const f=setup(),first=await f.store.commitContext(entry(receipt()));let committedPointer=null;f.storage.setAfter((input,ref)=>{if(input.kind===PTR){committedPointer=ref;throw Error('synthetic_callback_lost');}});
 await assert.rejects(f.store.commitContext(entry(receipt(),'PRE',{currentMap:currentMap()})),/callback_lost/);assert.throws(()=>f.store.resolve({seriesId:'series:7'}),/outcome_unknown/);await assert.rejects(f.store.commitContext(entry(receipt())),/outcome_unknown/);await assert.rejects(f.store.restorePointer(first.pointerRef),/rollback_or_fork/);
 f.storage.setAfter(null);const recovered=await f.store.restorePointer(committedPointer);assert.equal(recovered.verifiedRevisions,2);assert.equal(f.store.resolve({seriesId:'series:7'}).currentMap.mapId,'101');await assert.rejects(f.store.restorePointer(first.pointerRef),/rollback_or_fork/);
 const restarted=setup({storage:f.storage});await restarted.store.restorePointer(committedPointer);assert.equal(restarted.store.resolve({seriesId:'series:7'}).phase,'PRE');
});

test('failed revision commit leaves prior context visible, while missing pointer outcome remains closed',async()=>{
 const f=setup(),first=await f.store.commitContext(entry(receipt()));f.storage.setBefore(input=>{if(input.kind===REV)throw Error('synthetic_revision_failure');});await assert.rejects(f.store.commitContext(entry(receipt(),'PRE',{currentMap:currentMap()})),/revision_failure/);assert.equal(f.store.resolve({seriesId:'series:7'}).phase,'SERIES_PRE');
 f.storage.setBefore(input=>{if(input.kind===PTR)throw Error('synthetic_pointer_failure');});await assert.rejects(f.store.commitContext(entry(receipt(),'PRE',{currentMap:currentMap()})),/pointer_failure/);const pending=f.store.status().tracked[0].uncertainPointer;await assert.rejects(f.store.restorePointer(pending),/missing_object/);await assert.rejects(f.store.restorePointer(first.pointerRef),/rollback_or_fork/);assert.throws(()=>f.store.resolve({seriesId:'series:7'}),/outcome_unknown/);
});

test('restore validates every retained byte, ordinal and owned clock; no raw path accepted',async()=>{
 const f=setup(),first=await f.store.commitContext(entry(receipt())),second=await f.store.commitContext(entry(receipt(),'PRE',{currentMap:currentMap()}));const replay=setup({storage:f.storage});replay.setTime('2026-10-24T12:59:59Z');await assert.rejects(replay.store.restorePointer(second.pointerRef),/future_context/);replay.setTime(AT);
 const key=REV+':'+first.revisionRef.sha256,original=f.storage.values.get(key);f.storage.values.set(key,original+' ');await assert.rejects(replay.store.restorePointer(second.pointerRef),/artifact_read_bytes/);f.storage.values.set(key,original);await replay.store.restorePointer(second.pointerRef);
 await assert.rejects(replay.store.restorePointer({...first.pointerRef,path:'C:/private'}),/object_keys_or_accessor/);await assert.rejects(replay.store.restorePointer({kind:PTR,sha256:'a'.repeat(64),bytes:4097}),/artifact_reference/);
 const small=setup({storage:f.storage,limits:{maxRestoreDepth:1}});await assert.rejects(small.store.restorePointer(second.pointerRef),/pointer_chain_bound/);
});

test('manual STOP during commit blocks visibility; queue bound precedes getters and expensive copying',async()=>{
 const f=setup({limits:{maxPending:1}});let release,started;const entered=new Promise(resolve=>{started=resolve;}),held=new Promise(resolve=>{release=resolve;});f.storage.setBefore(async input=>{if(input.kind===REV){started();await held;}});
 const pending=f.store.commitContext(entry(receipt()));await entered;let getterCalls=0;const hostile={get seriesInput(){getterCalls++;throw Error('must_not_execute');},phase:'SERIES_PRE'};await assert.rejects(f.store.commitContext(hostile),/pending_bound/);assert.equal(getterCalls,0);f.stop();release();await assert.rejects(pending,/manual_stop_or_abort/);assert.equal(f.storage.calls.length,1);assert.throws(()=>f.store.resolve({seriesId:'series:7'}),/manual_stop_or_abort/);f.resume();assert.equal(f.store.resolve({seriesId:'series:7'}),null);
 await assert.rejects(f.store.commitContext(hostile),/object_keys_or_accessor/);assert.equal(getterCalls,0);await assert.rejects(f.store.commitContext(entry(receipt(),{get toJSON(){getterCalls++;throw Error('never');}})),/phase/);assert.equal(getterCalls,0);
});

test('bounded store rejects invalid phase, future sources, unknown selection and excessive series',async()=>{
 const f=setup({limits:{maxSeries:1}});for(const input of [entry(receipt(),'BETWEEN'),entry(receipt(),'COMPLETE'),entry(receipt(),'LIVE'),entry(receipt(),'SERIES_PRE',{currentMap:currentMap()}),entry(receipt(),'SERIES_PRE',{mapTraceSha256:'a'.repeat(64)}),entry(receipt({availableAt:'2026-10-24T13:00:00.000000001Z'}))])await assert.rejects(f.store.commitContext(input));
 await f.store.commitContext(entry(receipt()));assert.throws(()=>f.store.resolve({seriesId:'series:7',selection:{kind:'manual',mapId:'999'}}),/selected_map_not_in_series/);await assert.rejects(f.store.commitContext(entry(receipt({seriesId:'series:8'}))),/series_bound/);assert.equal(f.storage.calls.length,2);
});

test('owned context token fences a newer series revision across awaited route reads',async()=>{
 const f=setup();await f.store.commitContext(entry(receipt()));const first=f.store.resolve({seriesId:'series:7'});assert.equal(f.store.isCurrentContext(first),true);assert.equal(f.store.isCurrentContext(structuredClone(first)),false);
 await f.store.commitContext(entry(receipt()));assert.equal(f.store.isCurrentContext(first),true);let release;const held=new Promise(resolve=>{release=resolve;}),inFlightRead=(async()=>{await held;return f.store.isCurrentContext(first);})();await f.store.commitContext(entry(receipt(),'PRE',{currentMap:currentMap()}));release();assert.equal(await inFlightRead,false);assert.equal(f.store.isCurrentContext(first),false);const next=f.store.resolve({seriesId:'series:7'});assert.equal(f.store.isCurrentContext(next),true);f.stop();assert.equal(f.store.isCurrentContext(next),false);f.resume();f.setTime('2026-10-24T12:59:59Z');assert.equal(f.store.isCurrentContext(next),false);
});

test('store composes with real diagnostic journal and router using independent exact series/map traces',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aegis-series-r5-'));
 try{
  const journal=createDiagnosticFeatureJournal({directory}),targetDocument=syntheticRegistry()[2],schemas=new Map(),expectedSchemaHashes=Object.fromEntries(TARGET_IDS.map(id=>[id,[]]));
  for(const meta of targetDocument.targets)for(const stateMode of meta.stateModes){const schema={contract:'aegis.unified-feature-projection-schema.v1',targetId:meta.id,stateMode,definitions:[{name:'synthetic.'+meta.id}]},key=digest(schema);schemas.set(meta.id+':'+stateMode,{schema,key});expectedSchemaHashes[meta.id].push(key);await journal.writeSchema({schemaHash:key,schema});}
  async function trace(mode,seriesInput,map=null){
   const targetIds=mode==='BETWEEN'?['SERIES_BETWEEN']:mode==='SERIES_PRE'?['SERIES_PRE']:['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION'],vectors={},routes=[];
   for(const targetId of targetIds){const stateMode=targetDocument.targets.find(t=>t.id===targetId).stateModes[0],{schema,key}=schemas.get(targetId+':'+stateMode),vector={namesHash:digest(schema.definitions.map(d=>d.name)),values:[1],missing:[false]},vectorRef=digest(vector);vectors[vectorRef]=vector;routes.push({targetId,stateMode,schemaRef:{sha256:key,featureCount:1},featureCount:1,vectorRef});}
   const factsInput=pin({syntheticFacts:true}),targetInput=pin({syntheticTarget:true}),historical=(await journal.writeHistoricalInputs({mode,factsInput,targetInput,seriesInput})).reference;
   const body={contract:'aegis.diagnostic-feature-trace.v1',mode,matchId:map?.mapId??null,seriesId:'series:7',seriesReceiptPin:seriesInput.pin,decisionAt:AT,availableAt:AT,timings:{featuresReadyAt:AT},sourceSnapshotHash:null,historicalInputRef:historical,historicalBindings:{kind:'series_history',transitionId:'series:7:after:'+JSON.parse(seriesInput.utf8).previousMaps.length,factsSha256:factsInput.pin.sha256,targetSha256:targetInput.pin.sha256},targetBinding:{mapId:map?.mapId??null,mapOutcome:map?'map_radiant_win':null,mapSides:map?{radiant:'100',dire:'200'}:null,series:{seriesId:'series:7',team1Id:'100',team2Id:'200',outcome:'series_team1_win',team1CurrentSide:map?'radiant':null}},routes,vectors,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
   const utf8=JSON.stringify(body),sha256=hash(utf8);await journal.appendTrace({contract:body.contract,utf8,bytes:Buffer.byteLength(utf8),sha256});return sha256;
  }
  const f=setup(),router=createDiagnosticTargetRouter({journal,targetDocument,expectedSchemaHashes,now:()=>AT}),pre=receipt(),preTrace=await trace('SERIES_PRE',pre);await f.store.commitContext(entry(pre,'SERIES_PRE',{seriesTraceSha256:preTrace}));const first=await router.read({...f.store.resolve({seriesId:'series:7'}),decisionAt:AT});assert.equal(first.main.targetId,'SERIES_PRE');assert.equal(first.main.status,'diagnostic_features_available');assert.equal(first.currentMapId,null);
  const next=receipt({count:1,availableAt:'2026-10-24T12:01:00Z'}),map=currentMap(2),seriesTraceSha256=await trace('BETWEEN',next),mapTraceSha256=await trace('PRE',next,map);await f.store.commitContext(entry(next,'PRE',{currentMap:map,seriesTraceSha256,mapTraceSha256}));const both=await router.read({...f.store.resolve({seriesId:'series:7'}),decisionAt:AT});assert.equal(both.main.targetId,'SERIES_BETWEEN');assert.equal(both.main.status,'diagnostic_features_available');assert.equal(both.detail.status,'diagnostic_features_available');assert.equal(both.detail.targets.length,3);assert.ok(both.main.sourceEvidence.historicalInputRef);assert.ok(both.detail.targets.every(t=>t.sourceEvidence.historicalInputRef));
  const selected=await router.read({...f.store.resolve({seriesId:'series:7',selection:{kind:'manual',mapId:'101'}}),decisionAt:AT});assert.equal(selected.detail.status,'actual_result');assert.deepEqual(selected.detail.heroes.team1,[21,22,23,24,25]);assert.equal(selected.detail.historicalForecast,null);
  const correctionInput=correction(next,'2026-10-24T12:02:00Z'),revised=changed(next,s=>{s.availableAt='2026-10-24T12:02:00Z';s.previousMaps[0].winnerTeamId='200';});await f.store.commitContext(entry(revised,'PRE',{currentMap:map,correctionInput}));const unavailable=await router.read({...f.store.resolve({seriesId:'series:7'}),decisionAt:AT});assert.equal(unavailable.main.status,'unavailable');assert.equal(unavailable.detail.status,'unavailable');
  const stale=await router.read({...f.store.resolve({seriesId:'series:7'}),seriesTraceSha256,mapTraceSha256,decisionAt:AT});assert.equal(stale.panelRejections.series,'trace_series_receipt_binding');assert.equal(stale.panelRejections.map,'trace_series_receipt_binding');
 }finally{await rm(directory,{recursive:true,force:true});}
});
