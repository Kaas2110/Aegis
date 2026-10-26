/** SYNTHETIC STATE-MACHINE REGRESSIONS ONLY.
 * Real pipeline, original pinned capture admission and private history/source
 * proofs; deliberately tiny trusted diagnostic producer and in-memory journal.
 * This is not rich-vector, format durability, model or source95 acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRetainedFeaturePipeline} from './retainedFeaturePipeline.mjs';
import {UNIFIED_PRODUCER_CONTRACT} from './unifiedFeatureProducer.mjs';
import {readDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {readVerifiedHistorySourceHandle} from './historySourceVerifier.mjs';
import {readCurrentSteamInput} from './currentSteamInput.mjs';
import {digest} from '../../feature-registry/registry-contract.mjs';
import {draftEntry,draftArgs,pinned} from './observedDraftHistory.fixtures.mjs';
const FIRST='2026-10-23T11:58:00Z',LIVE='2026-10-23T12:31:00Z',GAP='2026-10-23T12:31:30Z';
const rawPin=utf8=>({utf8,pin:{path:'synthetic-raw.body',bytes:Buffer.byteLength(utf8),sha256:createHash('sha256').update(utf8).digest('hex')}});
function capture({time=FIRST,clock=null,phase=null,maps=['90001'],body=null,httpStatus=200,status='captured_diagnostic'}={}){
 const rawInput=typeof body==='string'?rawPin(body):pinned(body??{result:{games:maps.map(matchId=>JSON.parse(draftEntry({matchId,time,clock,phase,accounts:true}).rawInput.utf8).result.games[0])}}),requestId=String(Date.parse(time))+'-'+randomUUID();return{rawInput,receiptInput:pinned({version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:'GetLiveLeagueGames/v1',httpStatus,status,diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId,requestStartedAt:time,receivedAt:time,rawPersistedAt:time,completedAt:time,rawSha256:rawInput.pin.sha256,rawFile:'raw/'+rawInput.pin.sha256+'.body',payloadRef:'journal:'+rawInput.pin.sha256,bodyBytes:rawInput.pin.bytes})};
}
function syntheticStateProducer(){
 const schemas=new Map(),calls=[];
 return{calls,producer:{contract:UNIFIED_PRODUCER_CONTRACT,getSchema:hash=>schemas.get(hash)??null,generateFeatureBundle(input){
  const h=readDynamicHistoryProof(input.historyProof,{matchId:input.matchId,decisionAt:input.decisionAt});assert.equal(h.accepted,true);
  const source=readVerifiedHistorySourceHandle(input.sourceExportHandle,{expectedSourceSnapshotHash:input.expectedSourceSnapshotHash,matchId:input.matchId,decisionAt:input.decisionAt}),context=h.context;
  assert.equal(source.factsSha256,h.relational.factsSha256);assert.equal(source.identity.historyCutoffAt,context.historyCutoffAt);assert.equal(source.identity.draftHash,context.draftState.identity.draftHash);assert.equal(source.identity.rosterHash,context.draftState.identity.rosterHash);assert.equal(source.nativeSha256,context.producer.bindings.nativeObservations.sha256);
  const current=readCurrentSteamInput({prefix:input.livePrefixInputs,context,matchId:input.matchId,decisionAt:input.decisionAt,progressionProof:input.progressionProof??null,retainedReplayProof:input.retainedReplayProof??null}),mode=current.admission.dynamicDiagnosticAllowed?'LIVE':'POST',targetId=mode+'_MAP_WIN',schema={contract:'synthetic.r8-state-machine-schema.v1',targetId,stateMode:mode,definitions:[{name:'synthetic.observed_clock'}]},hash=digest(schema),clock=current.admission.clock??null;schemas.set(hash,schema);calls.push({mode,matchId:input.matchId,cutoff:context.historyCutoffAt,clock});
  return{contract:UNIFIED_PRODUCER_CONTRACT,mode,matchId:input.matchId,seriesId:null,decisionAt:input.decisionAt,availableAt:input.decisionAt,historyCutoffAt:context.historyCutoffAt,historyContextHash:context.contentHash,sourceSnapshotHash:input.expectedSourceSnapshotHash,sourceAdmission:current.admission,inputSourceBindings:current.bindings,reconstruction:current.reconstruction,components:{legacyNative:null,series:null},nextLiveState:null,routes:[{targetId,stateMode:mode,schemaRef:{sha256:hash,featureCount:1},diagnosticVector:{names:['synthetic.observed_clock'],values:[clock],missing:[clock===null]},inferenceVector:null,eligibleForServing:false,eligibleForTraining:false}],eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
 }}};
}
function fixture(){
 const produced=syntheticStateProducer(),objects=new Map(),revisions=new Map(),traces=new Map(),rows=JSON.parse(draftArgs({accounts:true}).factsInput.utf8).maps.map(m=>({...m,players:m.players.map((p,i)=>({account_id:Number(p.accountId),hero_id:Number(p.heroId),player_slot:p.side==='radiant'?i%5:128+i%5,historical_performance:{}}))}));let now='2026-10-23T12:31:01Z',allowed=true,appendHook=null;
 const journal={writeSchema:async({schemaHash})=>({status:'created',schemaHash}),async appendTrace(trace){if(appendHook)await appendHook(trace);traces.set(trace.sha256,JSON.parse(trace.utf8));return{status:'created',sha256:trace.sha256};}},pipeline=createRetainedFeaturePipeline({producer:produced.producer,historyProfileSha256:'b'.repeat(64),now:()=>now,shouldContinue:()=>allowed,db:{query:async sql=>({rows:structuredClone(sql.includes('FROM pro_matches')?rows:[])})},sourceStore:{async put(e){objects.set(e.sourceSnapshotHash,e);return{reference:e.reference,sourceSnapshotHash:e.sourceSnapshotHash};},async load(r){return objects.get(r.sha256);}},historyRevisions:{async getOrCreate(key,fn){if(!revisions.has(key))revisions.set(key,await fn({}));return revisions.get(key);}},featureJournal:journal});
 return{pipeline,traces,calls:produced.calls,setNow(value){now=value;},setAllowed(value){allowed=value;},setAppendHook(fn){appendHook=fn;}};
}
async function initial(f,maps=['90001']){const first=await f.pipeline.consumeCapture(capture({maps}));assert.ok(first.results.every(r=>r.status==='recorded_diagnostic'),JSON.stringify(first));const live=await f.pipeline.consumeCapture(capture({maps,time:LIVE,clock:900,phase:5}));assert.ok(live.results.every(r=>r.status==='recorded_diagnostic'),JSON.stringify(live));return live;}

for(const kind of ['HTTP500','HTTP500_EMPTY','empty_list','missing_map'])test('synthetic actual-pipeline '+kind+' classified gap retains299s and expires301s without a new target vector',async()=>{
 const f=fixture();try{const live=await initial(f),trace=live.results[0].traceSha256,before=f.pipeline.readLiveEligibility({matchId:'90001'}),calls=f.calls.length;f.setNow('2026-10-23T12:31:31Z');let next;
  if(kind.startsWith('HTTP500'))next=capture({time:GAP,httpStatus:500,status:'degraded',body:kind==='HTTP500_EMPTY'?'':{error:'synthetic failure'}});
  else next=capture({time:GAP,clock:930,phase:5,maps:kind==='empty_list'?[]:['90002']});
  const result=await f.pipeline.consumeCapture(next);assert.notEqual(result.status,'failed');const retained=f.pipeline.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:35:59Z'});assert.equal(retained.eligibleForRetainingForecast,true);assert.equal(retained.lastTraceSha256,trace);assert.equal(retained.stateView.observationId,before.stateView.observationId);assert.equal(retained.stateView.lastConfirmedAt,LIVE);assert.equal(retained.stateView.expiresAt,before.stateView.expiresAt);assert.notEqual(retained.reason,'newer_committed_source_pending');assert.equal(f.pipeline.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:36:01Z'}).reason,'eligible_state_expired');if(kind!=='missing_map')assert.equal(f.calls.length,calls);assert.equal(f.calls.filter(x=>x.matchId==='90001').length,2);assert.ok(f.calls.every(x=>x.cutoff===FIRST||x.matchId==='90002'));assert.equal(f.pipeline.status().pending,0);
 }finally{f.pipeline.close();}
});
test('synthetic actual-pipeline old executingB never acknowledges queued terminalC',async()=>{
 const f=fixture();let release;try{await initial(f);let entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.setAppendHook(async()=>{entered();await gate;});f.setNow('2026-10-23T12:32:01Z');const b=f.pipeline.consumeCapture(capture({time:'2026-10-23T12:32:00Z',clock:960,phase:5}));await started;const c=f.pipeline.consumeCapture(capture({time:'2026-10-23T12:32:01Z',clock:961,phase:6}));assert.equal(f.pipeline.readLiveEligibility({matchId:'90001'}).reason,'newer_committed_source_pending');release();const old=await b;assert.equal(old.results[0].traceCommitted,true);assert.equal(old.results[0].stateAdvanced,false);assert.notEqual(old.results[0].status,'recorded_diagnostic');const terminal=await c;assert.equal(terminal.results[0].status,'source_closed');assert.equal(f.pipeline.readLiveEligibility({matchId:'90001'}).eligibleForRetainingForecast,false);assert.equal(f.pipeline.status().tracked[0].classifiedSourceHead.key,f.pipeline.status().admittedSourceHead);
 }finally{release?.();f.pipeline.close();}
});
test('synthetic actual-pipeline aggregate head classifies missingM independently from progressingN',async()=>{
 const f=fixture();try{await initial(f,['90001','90002']);const before=f.pipeline.readLiveEligibility({matchId:'90001'}),beforeN=f.pipeline.readLiveEligibility({matchId:'90002'});f.setNow('2026-10-23T12:31:31Z');const next=await f.pipeline.consumeCapture(capture({time:GAP,clock:930,phase:5,maps:['90002']}));assert.equal(next.results[0].status,'recorded_diagnostic');const m=f.pipeline.readLiveEligibility({matchId:'90001'}),n=f.pipeline.readLiveEligibility({matchId:'90002'});assert.equal(m.eligibleForRetainingForecast,true);assert.equal(m.lastTraceSha256,before.lastTraceSha256);assert.equal(m.stateView.lastConfirmedAt,LIVE);assert.equal(n.eligibleForRetainingForecast,true);assert.equal(n.stateView.lastConfirmedAt,GAP);assert.notEqual(n.lastTraceSha256,beforeN.lastTraceSha256);assert.ok(f.pipeline.status().tracked.every(x=>x.classifiedSourceHead.key===f.pipeline.status().admittedSourceHead));
 }finally{f.pipeline.close();}
});
test('synthetic actual-pipeline integrity/STOP barriers do not borrow ordinary gap retention',async()=>{
 const f=fixture();try{await initial(f);f.setNow('2026-10-23T12:31:31Z');const invalid=capture({time:GAP,clock:930,phase:5}),r=JSON.parse(invalid.receiptInput.utf8);invalid.receiptInput=pinned({...r,bodyBytes:r.bodyBytes+1});assert.equal((await f.pipeline.consumeCapture(invalid)).reason,'capture_pin_or_contract');assert.equal(f.pipeline.readLiveEligibility({matchId:'90001'}).reason,'invalid_committed_source_contract');f.setAllowed(false);assert.equal(f.pipeline.readLiveEligibility({matchId:'90001'}).reason,'manual_stop_or_abort');assert.equal((await f.pipeline.consumeCapture(capture({time:'2026-10-23T12:32:00Z',clock:960,phase:5}))).reason,'manual_stop_or_abort');
 }finally{f.pipeline.close();}
});
