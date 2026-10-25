import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDiagnosticFeatureConsumer} from './diagnosticFeatureConsumer.mjs';
import {createDynamicHistoryProof,readDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {collectDraftHistorySourceExport,verifyHistorySourceExport} from './historySourceExport.mjs';
import {createUnifiedFeatureProducer,UNIFIED_PRODUCER_CONTRACT} from './unifiedFeatureProducer.mjs';
import {draftArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {evidenceHash} from './playerHeroEconomyFeatures.mjs';
import {createFeatureProjectionCompiler} from './featureProjectionCompiler.mjs';
import {digest,validateRegistry} from '../../feature-registry/registry-contract.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createRetainedReferenceCorpus,materializeRetainedReferenceHistoryV2} from './retainedReferenceCorpus.mjs';
import {deriveHistoricalFactVersionV2} from './retainedOpenDotaFacts.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
const AT='2026-10-23T12:40:00Z';
async function bound({accounts=true,late=false,computedAt='2026-10-23T12:30:00Z',matchId='90001'}={}){
 const a=draftArgs({accounts,matchId});a.matchId=matchId;a.computedAt=computedAt;
 if(late)a.draftPrefixInputs=[draftEntry({accounts:false,matchId}),draftEntry({accounts:true,matchId,time:'2026-10-23T12:01:00Z'})];
 const rows=JSON.parse(a.factsInput.utf8).maps.map(m=>({...m,players:m.players.map((p,i)=>({account_id:Number(p.accountId),hero_id:Number(p.heroId),player_slot:p.side==='radiant'?i%5:128+i%5}))}));
 const exp=await collectDraftHistorySourceExport({query:async sql=>({rows:sql.includes('FROM pro_matches')?rows:[]})},{...a,now:()=>computedAt});
 const b=JSON.parse(exp.envelopeInput.utf8),h=createDynamicHistoryProof({...a,factsInput:b.factsInput,nativeInput:b.nativeInput});
 return{h,exp,input:{matchId,decisionAt:AT,historyProof:h.proof,sourceExportInput:exp.envelopeInput,expectedSourceSnapshotHash:exp.sourceSnapshotHash,mode:'POST'}};
}
const base=await bound();
function instrumentedProducer(){
 const calls=[],schema={contract:'synthetic-schema',definitions:[{name:'synthetic.value'}]},hash=evidenceHash(schema);
 return{calls,producer:Object.freeze({contract:UNIFIED_PRODUCER_CONTRACT,getSchema:h=>h===hash?schema:null,generateFeatureBundle(input){
  verifyHistorySourceExport(input.sourceExportInput,{expectedSourceSnapshotHash:input.expectedSourceSnapshotHash,matchId:input.matchId,decisionAt:input.decisionAt});
  const h=readDynamicHistoryProof(input.historyProof,{matchId:input.matchId,decisionAt:input.decisionAt});assert.equal(h.accepted,true);
  calls.push({previousLiveState:input.previousLiveState,patch:input.patch,sourceInput:input.sourceExportInput.utf8,rules:input.expectedRulesSha256,events:input.expectedEventsSha256});
  const step=(input.previousLiveState?.step??0)+1;
  return{contract:UNIFIED_PRODUCER_CONTRACT,mode:input.mode==='AUTO'?'POST':input.mode,matchId:input.matchId,seriesId:null,decisionAt:input.decisionAt,availableAt:h.context.computedAt,historyCutoffAt:h.context.historyCutoffAt,historyContextHash:h.context.contentHash,sourceSnapshotHash:input.expectedSourceSnapshotHash,components:{legacyNative:null,series:null},semanticEvidence:{patch:input.patch??null,rulesSha256:input.expectedRulesSha256??null,eventsSha256:input.expectedEventsSha256??null},nextLiveState:{step},routes:[{targetId:'POST_MAP_WIN',stateMode:'POST',schemaRef:{sha256:hash,featureCount:1},diagnosticVector:{names:['synthetic.value'],values:[step],missing:[false]},inferenceVector:null,eligibleForServing:false,eligibleForTraining:false}],eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
 }})};
}
function ports(extra={}){const schemas=[],traces=[],existing=new Set();return{schemas,traces,writeSchema:async({schemaHash})=>{schemas.push(schemaHash);return{status:'created',schemaHash};},appendTrace:async trace=>{traces.push(trace);const status=existing.has(trace.sha256)?'existing_verified':'created';existing.add(trace.sha256);return{status,sha256:trace.sha256};},...extra};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('calculation cannot precede its input cutoff; commit clock rollback preserves trace but not state',async()=>{
 const p=instrumentedProducer(),s=ports(),early=createDiagnosticFeatureConsumer({...p,...s,now:()=> '2026-10-23T12:00:00Z'});
 assert.equal((await early.consume(base.input)).reason,'generation_or_source_contract_failed');assert.equal(s.traces.length,0);
 const times=['2026-10-23T12:40:00Z','2026-10-23T12:40:01Z','2026-10-23T12:39:59Z'],late=createDiagnosticFeatureConsumer({...p,...s,now:()=>times.shift()});
 const r=await late.consume(base.input);assert.equal(r.reason,'journal_commit_clock_contract');assert.equal(r.traceCommitted,true);assert.equal(r.stateAdvanced,false);assert.equal(late.status().recorded,0);assert.equal(s.traces.length,1);
});

test('concurrent duplicate work shares one generation/schema/trace and successful receipt',async()=>{
 const p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s});const[a,b]=await Promise.all([c.consume(base.input),c.consume(base.input)]);assert.equal(a.status,'recorded_diagnostic');assert.equal(a.traceSha256,b.traceSha256);assert.equal(a.stateAdvanced,true);assert.equal(b.stateAdvanced,false);assert.equal(b.coalescedReceipt,true);assert.equal(p.calls.length,1);assert.equal(s.schemas.length,1);assert.equal(s.traces.length,1);assert.equal(c.status().pending,0);assert.equal(c.status().recorded,1);const reused=await c.consume(base.input);assert.equal(reused.stateAdvanced,false);assert.equal(reused.reusedReceipt,true);assert.equal(p.calls.length,1);
 const body=JSON.parse(s.traces[0].utf8);assert.equal(body.recordedPrediction,false);assert.equal(body.eligibleForServing,false);assert.equal(body.sourceSnapshotHash,base.exp.sourceSnapshotHash);assert.equal(body.historyContextHash,base.h.context.contentHash);
});
test('trace failure does not advance state; only a new explicit consume retries',async()=>{
 const p=instrumentedProducer(),s=ports();let tries=0;const c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,appendTrace:async trace=>{tries++;if(tries===1)throw Error('synthetic bounded write failure');return s.appendTrace(trace);}});
 const first=await c.consume(base.input);assert.equal(first.reason,'trace_append_failed');assert.equal(first.stateAdvanced,false);await tick();assert.equal(tries,1);const retry=await c.consume(base.input);assert.equal(retry.status,'recorded_diagnostic');assert.equal(p.calls.length,2);assert.equal(p.calls[0].previousLiveState,null);assert.equal(p.calls[1].previousLiveState,null);assert.equal(s.schemas.length,1);
 await c.consume({...base.input,decisionAt:'2026-10-23T12:41:00Z'});assert.deepEqual(p.calls[2].previousLiveState,{step:1});
});
test('schema failure prevents trace and explicit retry validates the schema receipt',async()=>{
 const p=instrumentedProducer(),s=ports();let tries=0;const c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,writeSchema:async o=>{tries++;return tries===1?{status:'created',schemaHash:'f'.repeat(64)}:s.writeSchema(o);}});const a=await c.consume(base.input);assert.equal(a.reason,'schema_registration_failed');assert.equal(s.traces.length,0);assert.equal((await c.consume(base.input)).status,'recorded_diagnostic');assert.equal(s.traces.length,1);assert.equal(p.calls[1].previousLiveState,null);
});
test('stop before generation and after schema preserves prior state without automatic restart',async()=>{
 const p=instrumentedProducer(),s=ports();let allowed=false;const c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,shouldContinue:()=>allowed});assert.equal((await c.consume(base.input)).status,'blocked');assert.equal(p.calls.length,0);allowed=true;const d=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,shouldContinue:()=>allowed,writeSchema:async o=>{const r=await s.writeSchema(o);allowed=false;return r;}});assert.equal((await d.consume(base.input)).reason,'manual_stop_after_schema_write');assert.equal(s.traces.length,0);allowed=true;assert.equal((await d.consume(base.input)).status,'recorded_diagnostic');assert.equal(s.schemas.length,1);assert.equal(p.calls.at(-1).previousLiveState,null);
});
test('abort after durable trace reports committed artifact but does not advance until explicit verified retry',async()=>{
 const p=instrumentedProducer(),s=ports();let allowed=true;const c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,shouldContinue:()=>allowed,appendTrace:async t=>{const r=await s.appendTrace(t);allowed=false;return r;}});const a=await c.consume(base.input);assert.equal(a.reason,'manual_stop_after_trace_commit');assert.equal(a.traceCommitted,true);assert.equal(a.stateAdvanced,false);allowed=true;const b=await c.consume(base.input);assert.equal(b.traceSha256,a.traceSha256);assert.equal(p.calls[1].previousLiveState,null);assert.equal(s.traces.length,2);
});
test('AbortSignal and callback control failures stop without invoking generation',async()=>{
 const p=instrumentedProducer(),s=ports(),control=new AbortController();control.abort();const c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,signal:control.signal});assert.equal((await c.consume(base.input)).status,'blocked');const d=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,shouldContinue:()=>{throw Error('synthetic control failure');}});assert.equal((await d.consume(base.input)).status,'blocked');assert.equal(p.calls.length,0);
});
test('new history provenance and late identity reset owned continuation while t0 remains fixed',async()=>{
 const anon=await bound({accounts:false}),late=await bound({late:true}),p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s});await c.consume(anon.input);const b=await c.consume({...late.input,decisionAt:'2026-10-23T12:41:00Z'});assert.equal(b.status,'recorded_diagnostic');assert.equal(b.provenanceReset,true);assert.equal(p.calls[1].previousLiveState,null);assert.equal(anon.h.context.historyCutoffAt,late.h.context.historyCutoffAt);
 const old=await c.consume({...anon.input,decisionAt:'2026-10-23T12:42:00Z'});assert.equal(old.reason,'stale_history_provenance');assert.equal(p.calls.length,2);
});
test('a later materialization with the same roster also resets provenance explicitly',async()=>{
 const late=await bound({computedAt:'2026-10-23T12:32:00Z'}),p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s});await c.consume(base.input);const b=await c.consume({...late.input,decisionAt:'2026-10-23T12:42:00Z'});assert.equal(b.provenanceReset,true);assert.equal(p.calls[1].previousLiveState,null);
});
test('decision rewind, wrong map identity, forged proof and unsupported host phase are blocked',async()=>{
 const p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s});await c.consume(base.input);assert.equal((await c.consume({...base.input,decisionAt:'2026-10-23T12:39:59Z'})).reason,'decision_time_regression');for(const change of [{matchId:'90002'},{historyProof:structuredClone(base.h.proof)},{mode:'PRE'},{mode:'BETWEEN'},{untrustedClientPayload:true}])assert.equal((await c.consume({...base.input,...change})).reason,'host_input_or_history_contract');assert.equal(p.calls.length,1);
});
test('byte tampering and changed patch/rule/event pins do not reuse successful job keys',async()=>{
 const p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s});await c.consume({...base.input,patch:'7.41e'});for(const change of [{patch:'7.42'},{patch:'7.41e',expectedRulesSha256:'b'.repeat(64)},{patch:'7.41e',expectedEventsSha256:'c'.repeat(64)}])await c.consume({...base.input,...change});assert.equal(p.calls.length,4);
 const bad=structuredClone(base.input.sourceExportInput);bad.utf8+=' ';assert.equal((await c.consume({...base.input,sourceExportInput:bad})).reason,'generation_or_source_contract_failed');assert.equal(s.traces.length,4);
});
test('input mutation after enqueue cannot change the retained job snapshot',async()=>{
 const p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s}),input={...base.input,patch:'7.41e'},promise=c.consume(input);input.patch='7.42';await promise;assert.equal(p.calls[0].patch,'7.41e');
});
test('oversized allowed metadata cannot bypass complete input and pending byte budgets',async()=>{
 const p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,limits:{maxInputBytes:200000,maxPendingBytes:200000}});const patch=await c.consume({...base.input,patch:'x'.repeat(300000)});assert.equal(patch.reason,'host_input_or_history_contract');const source=structuredClone(base.input.sourceExportInput);source.pin.extraMetadata='x'.repeat(300000);const pin=await c.consume({...base.input,sourceExportInput:source});assert.equal(pin.reason,'host_input_or_history_contract');assert.equal(p.calls.length,0);assert.equal(c.status().pendingBytes,0);
});
test('trace callback cannot mutate the expected durable hash before returning a matching forged receipt',async()=>{
 const p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,appendTrace:async t=>{t.sha256='e'.repeat(64);return{status:'created',sha256:t.sha256};}});const r=await c.consume(base.input);assert.equal(r.reason,'trace_append_failed');assert.equal(r.stateAdvanced,false);assert.equal(c.status().recorded,0);
});
test('pending and pending-byte caps do not duplicate or restart queued work',async()=>{
 const p=instrumentedProducer(),s=ports();let release;const gate=new Promise(r=>{release=r;});const c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,limits:{maxPending:1},writeSchema:async o=>{await gate;return s.writeSchema(o);}});const a=c.consume(base.input);await tick();assert.equal((await c.consume({...base.input,decisionAt:'2026-10-23T12:41:00Z'})).reason,'pending_work_bound');const duplicate=c.consume(base.input);release();await Promise.all([a,duplicate]);assert.equal(p.calls.length,1);assert.equal(c.status().pendingBytes,0);
 const d=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,limits:{maxPendingBytes:1}});assert.equal((await d.consume(base.input)).reason,'pending_work_bound');
});
test('map capacity and explicit cache release stay bounded without altering saved trace',async()=>{
 const other=await bound({matchId:'90002'}),p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,limits:{maxMaps:1,maxReceipts:1}});await c.consume(base.input);assert.equal((await c.consume(other.input)).reason,'map_cache_bound');assert.equal(c.forgetMap('90001').released,true);assert.equal((await c.consume(other.input)).status,'recorded_diagnostic');assert.equal(c.status().maps,1);assert.equal(c.status().successfulReceipts,1);assert.equal(s.traces.length,2);
});
test('trace size bound and invalid durable receipt both fail without state advancement',async()=>{
 const p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,limits:{maxTraceBytes:1024}});assert.equal((await c.consume(base.input)).reason,'generation_or_source_contract_failed');assert.equal(s.traces.length,0);const d=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s,appendTrace:async()=>({status:'created',sha256:'d'.repeat(64)})});assert.equal((await d.consume(base.input)).reason,'trace_append_failed');assert.equal(d.status().recorded,0);
});
test('actual unified producer binds retained export and refuses inconsistent current map/series context',async()=>{
 const[index,familyDocument,targetDocument]=syntheticRegistry(),sourceInventory=Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.synthetic.mjs',sha256:'a'.repeat(64)}]}])),actual=createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory}),errors=[],producer={contract:actual.contract,getSchema:actual.getSchema,generateFeatureBundle(input){try{return actual.generateFeatureBundle(input);}catch(error){errors.push(error.message);throw error;}}},s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",producer,...s});
 const series=pinned({contract:'aegis.series-map-receipts.v1',seriesId:'synthetic-series',bestOf:3,team1Id:'100',team2Id:'200',availableAt:'2026-10-23T11:50:00Z',completeThroughMapNumber:0,previousMaps:[]});
 const bad=await c.consume({...base.input,seriesInput:series,currentMapNumber:2});assert.equal(bad.reason,'generation_or_source_contract_failed');assert.equal(s.traces.length,0);
 const good=await c.consume({...base.input,seriesInput:series,currentMapNumber:1});assert.equal(good.status,'recorded_diagnostic',JSON.stringify({good,errors}));const body=JSON.parse(s.traces[0].utf8);assert.equal(body.seriesId,'synthetic-series');assert.ok(body.routes.some(r=>r.targetId==='SERIES_LIVE'));assert.equal(body.matchId,'90001');assert.equal(body.historyCutoffAt,base.h.context.historyCutoffAt);
});

test('explicit map release clears success dedupe so original bytes reconstruct fresh state',async()=>{
 const p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=>"2026-10-23T13:00:00Z",...p,...s});
 const a=await c.consume(base.input);assert.equal(a.status,'recorded_diagnostic');assert.equal(c.forgetMap('90001').released,true);
 const b=await c.consume(base.input);assert.equal(b.reusedReceipt,undefined);assert.equal(b.stateAdvanced,true);assert.equal(p.calls.length,2);assert.equal(p.calls[1].previousLiveState,null);
});

test('source discontinuity clears windows and dedupe but preserves live and clock watermarks',async()=>{
 const p=instrumentedProducer(),s=ports(),producer={...p.producer,generateFeatureBundle(input){
  const b=p.producer.generateFeatureBundle(input);if(input.mode==='LIVE')b.sourceAdmission={classification:'observed_live',dynamicDiagnosticAllowed:true,clock:Number(input.patch),provenance:{receivedAt:input.decisionAt}};return b;
 }},c=createDiagnosticFeatureConsumer({producer,...s,now:()=> '2026-10-23T13:00:00Z'});
 const first={...base.input,mode:'LIVE',patch:'900'};
 assert.equal((await c.consume(first)).status,'recorded_diagnostic');
 assert.equal(c.invalidateSourceContinuity(base.input.matchId).cleared,true);
 assert.equal((await c.consume({...first,decisionAt:'2026-10-23T12:41:00Z',patch:'920'})).status,'recorded_diagnostic');
 assert.equal(p.calls.at(-1).previousLiveState,null);
 c.invalidateSourceContinuity(base.input.matchId);
 assert.equal((await c.consume({...first,decisionAt:'2026-10-23T12:42:00Z',patch:'899'})).reason,'generation_or_source_contract_failed');
 assert.equal((await c.consume({...base.input,decisionAt:'2026-10-23T12:42:00Z'})).reason,'generation_or_source_contract_failed');
});

test('a source barrier during durable append cannot commit pre-barrier dynamic state',async()=>{
 const p=instrumentedProducer(),s=ports();let barrier=true,c;
 c=createDiagnosticFeatureConsumer({...p,...s,now:()=> '2026-10-23T13:00:00Z',appendTrace:async t=>{
  const r=await s.appendTrace(t);if(barrier){barrier=false;c.invalidateSourceContinuity(base.input.matchId);}return r;
 }});
 const a=await c.consume(base.input);assert.equal(a.reason,'source_continuity_changed_after_trace');assert.equal(a.traceCommitted,true);assert.equal(a.stateAdvanced,false);
 assert.equal((await c.consume({...base.input,decisionAt:'2026-10-23T12:41:00Z'})).status,'recorded_diagnostic');assert.equal(p.calls.at(-1).previousLiveState,null);
});

test('same-input request after a barrier cannot coalesce with an old-epoch flight',async()=>{
 const p=instrumentedProducer(),s=ports();let release;const gate=new Promise(r=>{release=r;});
 const c=createDiagnosticFeatureConsumer({now:()=> '2026-10-23T13:00:00Z',...p,...s,writeSchema:async o=>{await gate;return s.writeSchema(o);}});
 const old=c.consume(base.input);await tick();assert.equal(c.invalidateSourceContinuity(base.input.matchId).cleared,true);
 const fresh=c.consume(base.input);release();const[a,b]=await Promise.all([old,fresh]);
 assert.equal(a.stateAdvanced,false);assert.equal(b.status,'recorded_diagnostic');assert.equal(b.stateAdvanced,true);assert.equal(b.coalescedReceipt,undefined);assert.notEqual(a.jobKey,b.jobKey);assert.equal(p.calls.length,2);assert.equal(s.traces.length,1);assert.equal(c.status().pending,0);assert.equal(c.status().pendingBytes,0);
});

test('queued jobs admitted before an observed source barrier cannot advance a new continuity epoch',async()=>{
 const p=instrumentedProducer(),s=ports();let release;const gate=new Promise(r=>{release=r;});
 const c=createDiagnosticFeatureConsumer({now:()=> '2026-10-23T13:00:00Z',...p,...s,writeSchema:async o=>{await gate;return s.writeSchema(o);}});
 const first=c.consume(base.input);await tick();
 const queued=c.consume({...base.input,decisionAt:'2026-10-23T12:41:00Z'});
 assert.equal(c.invalidateSourceContinuity(base.input.matchId).cleared,true);release();
 const [a,b]=await Promise.all([first,queued]);assert.equal(a.stateAdvanced,false);assert.equal(b.stateAdvanced,false,JSON.stringify(b));assert.equal(s.traces.length,0);
});

function tinyChurningProducer(){
 const legacy=instrumentedProducer(),[index,familyDocument,targetDocument]=syntheticRegistry(),compiler=createFeatureProjectionCompiler({registry:validateRegistry(index,familyDocument,targetDocument),registryHash:digest(index),sourceInventory:{history:{primarySha256:'a'.repeat(64),files:[{path:'synthetic-cache-history.mjs',sha256:'a'.repeat(64)}]}},sourceProfiles:{history:'synthetic-prior'},maxSchemas:1,maxComponentSchemas:1});
 return{calls:legacy.calls,compiler,producer:{contract:UNIFIED_PRODUCER_CONTRACT,getSchema:compiler.getSchema,generateFeatureBundle(input){
  const bundle=legacy.producer.generateFeatureBundle(input),version=input.patch??'1',component={names:['synthetic.hist'],values:[Number(version)],masks:[0],schemaHash:digest({version}),definitions:[{name:'synthetic.hist',familyId:'H02',formula:'synthetic cache test value',formulaVersion:version,units:'fraction',inputScopes:['prior_completed_maps','current_identity']}]},blocks=[compiler.normalize(component,'history')];
  bundle.routes=['POST_MAP_WIN','POST_KILLS'].map(target=>compiler.project(blocks,target,'POST'));return bundle;
 }}};
}
test('schema registration LRU re-verifies evicted schemas without pruning routes or continuation state',async()=>{
 const p=tinyChurningProducer(),s=ports(),known=new Set(),c=createDiagnosticFeatureConsumer({now:()=> '2026-10-23T13:00:00Z',...p,...s,limits:{maxSchemas:1},writeSchema:async o=>{const prior=known.has(o.schemaHash);known.add(o.schemaHash);s.schemas.push(o.schemaHash);assert.equal(digest(o.schema),o.schemaHash);return{status:prior?'existing_verified':'created',schemaHash:o.schemaHash};}});
 const first=await c.consume({...base.input,patch:'1'});assert.equal(first.status,'recorded_diagnostic');const firstBody=JSON.parse(s.traces[0].utf8);assert.equal(firstBody.routes.length,2);
 assert.equal((await c.consume({...base.input,patch:'2',decisionAt:'2026-10-23T12:41:00Z'})).status,'recorded_diagnostic');
 assert.equal((await c.consume({...base.input,patch:'1',decisionAt:'2026-10-23T12:42:00Z'})).status,'recorded_diagnostic');const reloaded=JSON.parse(s.traces[2].utf8);assert.deepEqual(reloaded.routes,firstBody.routes);assert.deepEqual(reloaded.vectors,firstBody.vectors);assert.equal(s.schemas.length,6);assert.equal(c.status().registeredSchemas,1);assert.equal(c.status().maps,1);assert.equal(c.status().schemaWritesInFlight,0);assert.deepEqual(p.calls.at(-1).previousLiveState,{step:2});assert.equal(p.compiler.status().projectionSchemas,1);
});
test('different maps serialize rich generation and preserve route schemas while a write is pending',async()=>{
 const other=await bound({matchId:'90002'}),p=tinyChurningProducer(),s=ports();let release;const gate=new Promise(r=>{release=r;}),seen=[];
 const c=createDiagnosticFeatureConsumer({now:()=> '2026-10-23T13:00:00Z',...p,...s,limits:{maxSchemas:1},writeSchema:async o=>{seen.push(o);await gate;assert.equal(digest(o.schema),o.schemaHash);return s.writeSchema(o);}});
 const first=c.consume({...base.input,patch:'1'});await tick();const second=c.consume({...other.input,patch:'2'});await tick();assert.equal(c.status().schemaWritesInFlight,1);assert.equal(p.calls.length,1);assert.equal(p.compiler.status().projectionSchemas,1);release();const[a,b]=await Promise.all([first,second]);assert.equal(a.status,'recorded_diagnostic');assert.equal(b.status,'recorded_diagnostic');assert.equal(s.traces.length,2);assert.equal(seen.length,4);assert.equal(c.status().registeredSchemas,1);assert.equal(c.status().pending,0);assert.equal(c.status().maps,2);assert.equal(c.status().resourceArena.chargedBytes,0);for(const schema of seen)assert.equal(Object.isFrozen(schema.schema),true);
});

test('R5 saturated queue refuses work before reading a large body or running preparation',async()=>{
 const p=instrumentedProducer(),s=ports();let release;const gate=new Promise(r=>{release=r;});
 const c=createDiagnosticFeatureConsumer({now:()=> '2026-10-23T13:00:00Z',...p,...s,limits:{maxPending:1},writeSchema:async o=>{await gate;return s.writeSchema(o);}});
 const first=c.consume(base.input);await tick();const before=c.status().preparation;let reads=0;
 const input={...base.input};Object.defineProperty(input,'sourceExportInput',{enumerable:true,get(){reads++;throw Error('should_not_prepare_overload');}});
 const rejected=await c.consume(input);assert.equal(rejected.reason,'pending_work_bound');assert.equal(reads,0);assert.deepEqual(c.status().preparation,before);release();assert.equal((await first).status,'recorded_diagnostic');assert.equal(c.status().resourceArena.chargedBytes,0);
});
test('R5 byte reservation denies ownership copying and releases after source failure',async()=>{
 const p=instrumentedProducer(),s=ports(),arena={reserve(){return null;},status(){return{chargedBytes:0};}};
 const c=createDiagnosticFeatureConsumer({now:()=> '2026-10-23T13:00:00Z',...p,...s,resourceArena:arena});assert.equal((await c.consume(base.input)).reason,'memory_reservation_bound');assert.equal(c.status().preparation.ownedCopies,0);assert.equal(p.calls.length,0);
 const d=createDiagnosticFeatureConsumer({now:()=> '2026-10-23T13:00:00Z',...p,...s});assert.equal((await d.consume({...base.input,historyProof:{}})).reason,'host_input_or_history_contract');assert.equal(d.status().resourceArena.chargedBytes,0);assert.equal(d.status().pending,0);
});
test('R5 available capacity still rejects nested and top-level accessors without reentry',async()=>{
 const p=instrumentedProducer(),s=ports(),c=createDiagnosticFeatureConsumer({now:()=> '2026-10-23T13:00:00Z',...p,...s});let entered=0;
 const top={...base.input};Object.defineProperty(top,'matchId',{enumerable:true,get(){entered++;c.consume(base.input);return'90001';}});
 assert.equal((await c.consume(top)).reason,'host_input_or_history_contract');
 const nested=structuredClone(base.input.sourceExportInput);Object.defineProperty(nested,'utf8',{enumerable:true,get(){entered++;return'{}';}});
 assert.equal((await c.consume({...base.input,sourceExportInput:nested})).reason,'host_input_or_history_contract');assert.equal(entered,0);assert.equal(p.calls.length,0);assert.equal(c.status().preparation.ownedCopies,0);assert.equal(c.status().resourceArena.chargedBytes,0);
});

function releasingProducer({nativeContinuation=false,afterGenerate=null}={}){
 const legacy=instrumentedProducer(),bundles=[];
 const producer={...legacy.producer,generateFeatureBundle(input){
  const bundle=legacy.producer.generateFeatureBundle(input),entry={bundle,releases:0,active:true};
  if(nativeContinuation){
   const nativeContract='aegis.steam-coherent-feature-bundle.v3',observationId='synthetic-native-'+bundles.length;
   bundle.components.legacyNative={contract:nativeContract,observationId,state:{contract:nativeContract,admissionProfile:null,continuityId:null,roshanState:{},history:[]}};
   bundle.nextLiveState=Object.freeze({contract:'aegis.observed-draft-steam-feature-bundle.v2.state',matchId:bundle.matchId,lastObservationId:observationId,historyContentHash:bundle.historyContextHash});
  }
  Object.defineProperty(bundle,'release',{enumerable:false,value(){entry.releases++;entry.active=false;return entry.releases===1;}});bundles.push(entry);afterGenerate?.(entry);return bundle;
 }};
 return{...legacy,producer,bundles};
}
test('R6 bundle ownership spans asynchronous callbacks and releases once without changing continuation identity',async()=>{
 const p=releasingProducer(),s=ports(),c=createDiagnosticFeatureConsumer({...p,...s,now:()=> '2026-10-23T13:00:00Z',writeSchema:async o=>{assert.equal(p.bundles.at(-1).active,true);await tick();assert.equal(p.bundles.at(-1).active,true);return s.writeSchema(o);},appendTrace:async trace=>{assert.equal(p.bundles.at(-1).active,true);await tick();assert.equal(p.bundles.at(-1).active,true);return s.appendTrace(trace);}});
 const first=await c.consume(base.input);assert.equal(first.status,'recorded_diagnostic');assert.equal(p.bundles[0].releases,1);assert.equal(p.bundles[0].active,false);
 const second=await c.consume({...base.input,decisionAt:'2026-10-23T12:41:00Z'});assert.equal(second.status,'recorded_diagnostic');assert.equal(p.calls[1].previousLiveState,p.bundles[0].bundle.nextLiveState);assert.equal(p.bundles[1].releases,1);assert.deepEqual(p.calls[1].previousLiveState,{step:1});
 assert.equal(c.status().continuationOwnership.unmeasuredMaps,1);assert.equal(c.forgetMap(base.input.matchId).released,true);
});
test('R6 generated bundle releases on output, encode, schema, append, STOP and commit-clock failures',async()=>{
 const cases=[
  {reason:'generation_or_source_contract_failed',afterGenerate:entry=>{entry.bundle.matchId='wrong';}},
  {reason:'generation_or_source_contract_failed',limits:{maxTraceBytes:1024}},
  {reason:'manual_stop_before_schema_write',stopAfterGeneration:true},
  {reason:'schema_registration_failed',schemaFails:true},
  {reason:'manual_stop_after_schema_write',stopAfterSchema:true},
  {reason:'trace_append_failed',appendFails:true},
  {reason:'manual_stop_after_trace_commit',stopAfterAppend:true},
  {reason:'journal_commit_clock_contract',clockRollback:true}
 ];
 for(const config of cases){
  let allowed=true;const p=releasingProducer({afterGenerate:entry=>{config.afterGenerate?.(entry);if(config.stopAfterGeneration)allowed=false;}}),s=ports(),times=['2026-10-23T12:40:00Z','2026-10-23T12:40:01Z','2026-10-23T12:39:59Z'];
  const c=createDiagnosticFeatureConsumer({...p,...s,limits:config.limits??{},shouldContinue:()=>allowed,now:()=>config.clockRollback?times.shift():'2026-10-23T13:00:00Z',writeSchema:async o=>{if(config.schemaFails)throw Error('synthetic schema failure');const r=await s.writeSchema(o);if(config.stopAfterSchema)allowed=false;return r;},appendTrace:async trace=>{if(config.appendFails)throw Error('synthetic append failure');const r=await s.appendTrace(trace);if(config.stopAfterAppend)allowed=false;return r;}});
  const result=await c.consume(base.input);assert.equal(result.reason,config.reason);assert.equal(result.stateAdvanced,false);assert.equal(p.bundles.length,1);assert.equal(p.bundles[0].releases,1);assert.equal(c.status().resourceArena.chargedBytes,0);
 }
});
test('R6 restore success, mismatch, STOP and source barrier each release their generated bundle',async()=>{
 const original=releasingProducer(),s=ports(),first=createDiagnosticFeatureConsumer({...original,...s,now:()=> '2026-10-23T13:00:00Z'});const saved=await first.consume(base.input),stored=JSON.parse(s.traces[0].utf8);
 for(const variant of ['success','mismatch','stop','barrier']){
  let allowed=true,c;const p=releasingProducer();c=createDiagnosticFeatureConsumer({...p,...ports(),now:()=> '2026-10-23T13:00:00Z',shouldContinue:()=>allowed,loadCommittedTrace:async()=>{assert.equal(p.bundles[0].active,true);await tick();if(variant==='stop')allowed=false;if(variant==='barrier')c.invalidateSourceContinuity(base.input.matchId);const copy=structuredClone(stored);if(variant==='mismatch')copy.sourceSnapshotHash='d'.repeat(64);return copy;}});
  const restored=await c.consume(base.input,{restoreTraceSha256:saved.traceSha256}),expected={success:null,mismatch:'durable_trace_restore_failed',stop:'manual_stop_during_trace_restore',barrier:'source_continuity_changed_during_restore'}[variant];assert.equal(restored.reason,expected);assert.equal(p.bundles[0].releases,1);assert.equal(restored.stateAdvanced,variant==='success');
  if(variant==='success'){assert.equal(restored.status,'restored_diagnostic_state');await c.consume({...base.input,decisionAt:'2026-10-23T12:41:00Z'});assert.equal(p.calls[1].previousLiveState,p.bundles[0].bundle.nextLiveState);assert.equal(p.bundles[1].releases,1);}
 }
});
test('R6 inspectable native continuation estimate transfers to the slot and releases on replacement or source reset',async()=>{
 const arena=createDiagnosticResourceArena(),p=releasingProducer({nativeContinuation:true}),s=ports(),c=createDiagnosticFeatureConsumer({...p,...s,resourceArena:arena,now:()=> '2026-10-23T13:00:00Z'});
 assert.equal((await c.consume(base.input)).status,'recorded_diagnostic');let status=c.status();assert.equal(status.continuationOwnership.ownedMaps,1);assert.equal(status.continuationOwnership.unmeasuredMaps,0);assert.ok(status.continuationOwnership.estimatedBytes>=2048*2048);assert.equal(arena.status().chargedBytes,status.continuationOwnership.estimatedBytes);const firstBytes=arena.status().chargedBytes;
 assert.equal((await c.consume({...base.input,decisionAt:'2026-10-23T12:41:00Z'})).status,'recorded_diagnostic');assert.equal(p.calls[1].previousLiveState,p.bundles[0].bundle.nextLiveState);assert.equal(arena.status().chargedBytes,firstBytes);assert.equal(p.bundles[0].releases,1);assert.equal(p.bundles[1].releases,1);
 assert.equal(c.invalidateSourceContinuity(base.input.matchId).cleared,true);assert.equal(arena.status().chargedBytes,0);assert.equal(c.status().maps,1);assert.equal((await c.consume({...base.input,decisionAt:'2026-10-23T12:42:00Z'})).status,'recorded_diagnostic');assert.equal(p.calls[2].previousLiveState,null);assert.equal(c.forgetMap(base.input.matchId).released,true);assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);
});
test('R6 denied continuation reservation releases the failed bundle and preserves the last committed state',async()=>{
 const ownedArena=createDiagnosticResourceArena();let deny=false,firstToken=null;const arena={reserve:ownedArena.reserve,retainAsset(asset,bytes){if(deny&&bytes>=2048*2048&&asset!==firstToken)return null;const lease=ownedArena.retainAsset(asset,bytes);if(lease&&firstToken===null)firstToken=asset;return lease;},status:ownedArena.status},p=releasingProducer({nativeContinuation:true}),c=createDiagnosticFeatureConsumer({...p,...ports(),resourceArena:arena,now:()=> '2026-10-23T13:00:00Z'});
 assert.equal((await c.consume(base.input)).status,'recorded_diagnostic');const priorBytes=ownedArena.status().chargedBytes;deny=true;const failed=await c.consume({...base.input,decisionAt:'2026-10-23T12:41:00Z'});assert.equal(failed.reason,'generation_or_source_contract_failed');assert.equal(failed.stateAdvanced,false);assert.equal(p.bundles[1].releases,1);assert.equal(ownedArena.status().chargedBytes,priorBytes);
 deny=false;assert.equal((await c.consume({...base.input,decisionAt:'2026-10-23T12:42:00Z'})).status,'recorded_diagnostic');assert.equal(p.calls[2].previousLiveState,p.bundles[0].bundle.nextLiveState);c.forgetMap(base.input.matchId);assert.equal(ownedArena.status().chargedBytes,0);
});
test('R6 actual producer releases compiled routes after v1 consumer persistence',async()=>{
 const[index,familyDocument,targetDocument]=syntheticRegistry(),sourceInventory=Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.synthetic.mjs',sha256:'a'.repeat(64)}]}])),arena=createDiagnosticResourceArena(),producer=createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory,resourceArena:arena}),c=createDiagnosticFeatureConsumer({producer,...ports(),resourceArena:arena,now:()=> '2026-10-23T13:00:00Z'});
 const result=await c.consume(base.input);assert.equal(result.status,'recorded_diagnostic');assert.equal(producer.resourceStatus().activeBundles,0);assert.equal(producer.compilerStatus().activeRoutes,0);assert.equal(producer.compilerStatus().activeBlocks,0);c.forgetMap(base.input.matchId);producer.close();assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);
});
test('R6 source invalidation during IO preserves the active prior-token asset borrow until execution finishes',async()=>{
 const arena=createDiagnosticResourceArena(),p=releasingProducer({nativeContinuation:true}),s=ports();let release,appends=0;const gate=new Promise(resolve=>{release=resolve;}),c=createDiagnosticFeatureConsumer({...p,...s,resourceArena:arena,now:()=> '2026-10-23T13:00:00Z',appendTrace:async trace=>{if(++appends===2)await gate;return s.appendTrace(trace);}});
 assert.equal((await c.consume(base.input)).status,'recorded_diagnostic');const firstBytes=c.status().continuationOwnership.estimatedBytes;assert.equal(arena.status().heldAssets,1);
 const pending=c.consume({...base.input,decisionAt:'2026-10-23T12:41:00Z'});await tick();assert.equal(appends,2);assert.equal(p.calls[1].previousLiveState,p.bundles[0].bundle.nextLiveState);assert.equal(arena.status().heldAssets,2);
 assert.equal(c.invalidateSourceContinuity(base.input.matchId).cleared,true);assert.equal(c.status().continuationOwnership.ownedMaps,0);assert.equal(arena.status().heldAssets,2);assert.ok(arena.status().chargedBytes>=firstBytes*2);assert.equal(p.bundles[1].active,true);
 release();const result=await pending;assert.equal(result.reason,'source_continuity_changed_after_trace');assert.equal(result.stateAdvanced,false);assert.equal(result.traceCommitted,true);assert.equal(p.bundles[1].releases,1);assert.equal(arena.status().heldAssets,0);assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);c.forgetMap(base.input.matchId);
});

test('R6 actual retained v2 private source handle passes consumer preparation and producer binding',async()=>{
 const objects=new Map(),sha=text=>createHash('sha256').update(text).digest('hex'),writer={contract:'aegis.persistent-artifact-writer.v1',async commit({kind,utf8,expectedSha256}){assert.equal(sha(utf8),expectedSha256);const ref={kind,sha256:expectedSha256,bytes:Buffer.byteLength(utf8)};objects.set(kind+':'+expectedSha256,utf8);return ref;},async read(ref){const utf8=objects.get(ref.kind+':'+ref.sha256);assert.equal(typeof utf8,'string');return utf8;},async inspect(){return{objects:objects.size};}};
 const payload={match_id:101,start_time:1792494000,duration:1800,radiant_win:true,radiant_team_id:100,dire_team_id:200,radiant_score:25,dire_score:10,players:[{player_slot:0,hero_id:1,account_id:101,gold_per_min:600,kills:10,deaths:2,assists:3,times:[0,60],gold_t:[600,1200]}]},selectedInput=pinned({schemaVersion:1,source:'opendota',endpoint:'https://api.opendota.com/api/matches/101',matchId:101,receivedAt:'2026-10-20T12:00:00Z',availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:sha(JSON.stringify(payload)),payload}),versionInput=deriveHistoricalFactVersionV2({selectedInput}).versionInput;
 const clock=()=> '2026-10-23T12:30:00Z',a=draftArgs({accounts:true}),corpus=await createRetainedReferenceCorpus({artifactStore:writer,versionInputs:[versionInput],clock}),view=await materializeRetainedReferenceHistoryV2({corpusHandle:corpus.handle,matchId:a.matchId,draftPrefixInputs:a.draftPrefixInputs});assert.equal(view.status,'bounded_reference_ready');
 const retainedInputs={...a,factsInput:view.factsInput,nativeInput:view.nativeInput};assert.throws(()=>createDynamicHistoryProof(retainedInputs),/draft_history_retained_source_scope_or_basis/);
 const h=createDynamicHistoryProof({...retainedInputs,availabilityBasis:'retained_receipt_reconstruction'});assert.equal(h.context.availabilityBasis,'retained_receipt_reconstruction');
 const[index,familyDocument,targetDocument]=syntheticRegistry(),sourceInventory=Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.synthetic.mjs',sha256:'a'.repeat(64)}]}])),arena=createDiagnosticResourceArena(),producer=createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory,resourceArena:arena}),s=ports(),c=createDiagnosticFeatureConsumer({producer,...s,resourceArena:arena,now:()=> '2026-10-23T13:00:00Z'}),input={matchId:a.matchId,decisionAt:AT,historyProof:h.proof,sourceExportHandle:view.sourceExportHandle,expectedSourceSnapshotHash:view.sourceSnapshotHash,mode:'POST'};
 const result=await c.consume(input);assert.equal(result.status,'recorded_diagnostic');assert.equal(JSON.parse(s.traces[0].utf8).sourceSnapshotHash,view.sourceSnapshotHash);assert.equal(producer.resourceStatus().activeBundles,0);
 assert.equal((await c.consume({...input,sourceExportHandle:structuredClone(view.sourceExportHandle)})).reason,'host_input_or_history_contract');let reads=0;const getter=Object.freeze({get contract(){reads++;return 'aegis.verified-retained-reference-source-handle.v2';}});assert.equal((await c.consume({...input,sourceExportHandle:getter})).reason,'host_input_or_history_contract');assert.equal(reads,0);c.forgetMap(input.matchId);producer.close();assert.equal(arena.status().chargedBytes,0);
});
function consumerLiveFrame(time,clock){
 const entry=draftEntry({accounts:true,time,clock,phase:5}),raw=JSON.parse(entry.rawInput.utf8),metadata=JSON.parse(entry.metadataInput.utf8);for(const side of ['radiant','dire'])for(const player of raw.result.games[0].scoreboard[side].players)Object.assign(player,{net_worth:5000+player.hero_id*100+clock,gold_per_min:400+player.hero_id,xp_per_min:500+player.hero_id,level:10,gold:100});
 const rawInput=pinned(raw),observation=normalizeLocalCapture({...metadata.capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0];return{rawInput,metadataInput:pinned({...metadata,observationId:observation.observationId})};
}
test('R6 actual LIVE two-frame continuation survives released rich bundles and closes retained token ownership',async()=>{
 const[index,familyDocument,targetDocument]=syntheticRegistry(),sourceInventory=Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.synthetic.mjs',sha256:'a'.repeat(64)}]}])),arena=createDiagnosticResourceArena(),actual=createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory,resourceArena:arena});let firstState=null,secondReceivedPrior=false,generations=0;
 const producer={contract:actual.contract,getSchema:actual.getSchema,generateFeatureBundle(input){if(generations===1)secondReceivedPrior=input.previousLiveState===firstState;const bundle=actual.generateFeatureBundle(input);if(generations++===0)firstState=bundle.nextLiveState;return bundle;}},s=ports(),c=createDiagnosticFeatureConsumer({producer,...s,resourceArena:arena,now:()=> '2026-10-23T13:00:00Z'});
 const first=await c.consume({...base.input,mode:'LIVE',livePrefixInputs:[consumerLiveFrame('2026-10-23T12:39:00Z',900)]});assert.equal(first.status,'recorded_diagnostic');assert.equal(first.mode,'LIVE');assert.ok(firstState);assert.equal(actual.resourceStatus().activeBundles,0);assert.equal(c.status().continuationOwnership.ownedMaps,1);assert.equal(arena.status().heldAssets>=1,true);
 const second=await c.consume({...base.input,mode:'LIVE',decisionAt:'2026-10-23T12:41:00Z',livePrefixInputs:[consumerLiveFrame('2026-10-23T12:40:00Z',960)]});assert.equal(second.status,'recorded_diagnostic');assert.equal(secondReceivedPrior,true);assert.equal(generations,2);assert.equal(actual.resourceStatus().activeBundles,0);assert.equal(actual.compilerStatus().activeRoutes,0);assert.equal(c.status().continuationOwnership.ownedMaps,1);assert.equal(c.status().continuationOwnership.unmeasuredMaps,0);firstState=null;c.forgetMap(base.input.matchId);actual.close();assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);
});
