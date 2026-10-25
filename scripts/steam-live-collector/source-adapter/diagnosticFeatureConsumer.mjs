/** Opt-in trusted-background-host orchestration. No IO, provider, DB, model,
 * scheduler or HTTP entrypoint. Call only after an owned archive commit.
 * Canonical generation/proofs remain responsible for actual source admission.
 */
import {readDynamicHistoryProof,CONTRACT as OBSERVED_BUNDLE_CONTRACT,PROGRESSING_CONTRACT as PROGRESSING_OBSERVED_BUNDLE_CONTRACT} from './observedDraftFeatureBundle.mjs';
import {BUNDLE_CONTRACT as NATIVE_BUNDLE_CONTRACT,PROGRESSING_BUNDLE_CONTRACT as PROGRESSING_NATIVE_BUNDLE_CONTRACT} from './steamFeatureBundle.mjs';
import {encodeDiagnosticFeatureTrace,UNIFIED_PRODUCER_CONTRACT} from './unifiedFeatureProducer.mjs';
import {instantNs} from './causalTime.mjs';
import {readCurrentSteamInput} from './currentSteamInput.mjs';
import {evidenceHash} from './playerHeroEconomyFeatures.mjs';
import {createDiagnosticResourceArena,measureBoundedJsonBytes,snapshotPlainRecord} from './diagnosticResourceArena.mjs';
import {readVerifiedHistorySourceHandle} from './historySourceVerifier.mjs';
import {VERIFIED_RETAINED_REFERENCE_SOURCE_HANDLE_CONTRACT,readVerifiedRetainedReferenceSourceHandle} from './retainedReferenceCorpus.mjs';
import {VERIFIED_RETAINED_NATIVE_SOURCE_HANDLE_CONTRACT,readVerifiedRetainedNativeSourceHandle} from './retainedNativeHistoryView.mjs';
import {compactTraceMatchesBundle} from './compactDiagnosticRestore.mjs';
export const CONSUMER_CONTRACT='aegis.background-diagnostic-feature-consumer.v2';
const SHA=/^[a-f0-9]{64}$/,ID=/^[1-9]\d{0,19}$/;
const DEFAULTS={maxMaps:8,maxPending:16,maxReceipts:64,maxSchemas:32,maxInputBytes:128*1024*1024,maxPendingBytes:128*1024*1024,maxTraceBytes:16*1024*1024};
const CAPS={maxMaps:16,maxPending:64,maxReceipts:256,maxSchemas:128,maxInputBytes:128*1024*1024,maxPendingBytes:512*1024*1024,maxTraceBytes:64*1024*1024};
const flags={diagnosticOnly:true,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false,publicPromotion:false};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const receipt=(status,reason,extra={})=>({contract:CONSUMER_CONTRACT,status,reason,stateAdvanced:false,...extra,...flags});
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const INPUT_KEYS=['matchId','decisionAt','historyProof','sourceExportInput','sourceExportHandle','expectedSourceSnapshotHash','livePrefixInputs','seriesInput','currentMapNumber','mode','patch','rulesEvidence','expectedRulesSha256','eventsEvidence','expectedEventsSha256','progressionProof','retainedReplayProof'];
const PRIVATE_STATE_CONTRACTS=new Set([OBSERVED_BUNDLE_CONTRACT+'.state',PROGRESSING_OBSERVED_BUNDLE_CONTRACT+'.state']),NATIVE_STATE_CONTRACTS=new Set([NATIVE_BUNDLE_CONTRACT,PROGRESSING_NATIVE_BUNDLE_CONTRACT]);
const MAX_CONTINUATION_ROWS=2048,LEAD_ROW_ESTIMATED_BYTES=2048;
function inputSize(input){
 let bytes=0;
 const {historyProof,progressionProof,retainedReplayProof,sourceExportHandle,...serializable}=input;
 const size=measureBoundedJsonBytes(serializable,{maxBytes:CAPS.maxInputBytes});
 const allowed=(value,keys)=>object(value)&&Object.keys(value).every(k=>keys.includes(k));
 for(const [name,max]of [['patch',128],['expectedRulesSha256',64],['expectedEventsSha256',64]])if(input[name]!==null&&input[name]!==undefined&&(typeof input[name]!=='string'||Buffer.byteLength(input[name])>max||name!=='patch'&&!SHA.test(input[name])))throw Error('scalar_metadata_bound');
 if(input.decisionAt.length>64||input.currentMapNumber!==undefined&&input.currentMapNumber!==null&&(!Number.isSafeInteger(input.currentMapNumber)||input.currentMapNumber<1||input.currentMapNumber>5))throw Error('scalar_metadata_bound');
 function pin(p,max){
  if(p===null||p===undefined)return;
  if(!allowed(p,['utf8','pin'])||typeof p.utf8!=='string'||Buffer.byteLength(p.utf8)>max||!allowed(p.pin,['path','bytes','sha256'])||typeof p.pin.path!=='string'||!p.pin.path.length||Buffer.byteLength(p.pin.path)>512||!Number.isSafeInteger(p.pin.bytes)||p.pin.bytes<1||p.pin.bytes>max||!SHA.test(p.pin.sha256??''))throw Error('pinned_input_shape_or_bound');
  bytes+=Buffer.byteLength(p.utf8);
 }
 pin(input.sourceExportInput,64*1024*1024);pin(input.seriesInput,2*1024*1024);pin(input.rulesEvidence,512*1024);pin(input.eventsEvidence,512*1024);
 if(input.livePrefixInputs!==null&&input.livePrefixInputs!==undefined){if(!Array.isArray(input.livePrefixInputs)||input.livePrefixInputs.length>2048)throw Error('live_prefix_bound');for(const e of input.livePrefixInputs){if(!allowed(e,['rawInput','metadataInput']))throw Error('live_prefix_metadata_bound');pin(e.rawInput,6*1024*1024);pin(e.metadataInput,256*1024);}}
 if(bytes>CAPS.maxInputBytes)throw Error('input_bytes_bound');
 // Include escape expansion, scalar metadata, pin objects and punctuation. The
 // opaque proof is held by reference and is not serialized/cloned as trusted JSON.
 return size;
}

/** The callbacks are trusted host ports, not caller/client selectors:
 * writeSchema({schemaHash,schema}) -> {status:'created'|'existing_verified',schemaHash}
 * appendTrace(encodedTrace) -> {status:'created'|'existing_verified',sha256}
 * Callbacks must be bounded/abort-aware in the actual host. A pending write is
 * not forcibly cancelled; after it settles the consumer checks stop again.
 */
export function createDiagnosticFeatureConsumer({producer,writeSchema,appendTrace,loadCommittedTrace=null,compactJournal=null,isCurrentInput=null,shouldContinue=()=>true,signal=null,limits={},resourceArena=null,now=()=>new Date().toISOString()}={}){
 const compact=compactJournal!==null,restoreTrace=loadCommittedTrace??(compact?compactJournal.loadTrace:null);
 if(typeof now!=='function'||producer?.contract!==UNIFIED_PRODUCER_CONTRACT||typeof producer.generateFeatureBundle!=='function'||typeof producer.getSchema!=='function'||(!compact&&(typeof writeSchema!=='function'||typeof appendTrace!=='function'))||compact&&(compactJournal.contract!=='aegis.compact-diagnostic-feature-journal.v2'||typeof compactJournal.appendBundle!=='function'||typeof compactJournal.loadTrace!=='function')||isCurrentInput!==null&&typeof isCurrentInput!=='function'||typeof shouldContinue!=='function'||signal!==null&&(typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'))throw Error('diagnostic_consumer_owned_ports_required');
 if(!object(limits)||Object.keys(limits).some(k=>!Object.hasOwn(DEFAULTS,k)))throw Error('diagnostic_consumer_limit_keys');
 const config={...DEFAULTS,...limits};for(const [k,v]of Object.entries(config))if(!Number.isSafeInteger(v)||v<1||v>CAPS[k]||k==='maxTraceBytes'&&v<1024)throw Error('diagnostic_consumer_limit_bound:'+k);
 const arena=resourceArena??createDiagnosticResourceArena();if(typeof arena?.reserve!=='function'||typeof arena?.status!=='function')throw Error('diagnostic_consumer_owned_arena');
 const maps=new Map(),flights=new Map(),completed=new Map(),schemas=new Map(),schemaFlights=new Map();let pending=0,pendingBytes=0,globalTail=Promise.resolve();
 const preparation={measurements:0,ownedCopies:0,evidenceHashes:0};
 let recorded=0,failed=0,blocked=0;
 const continuing=()=>{try{return signal?.aborted!==true&&shouldContinue()===true;}catch{return false;}};
 const currentInput=(job,bundle)=>{if(isCurrentInput===null)return true;try{const current=isCurrentInput({input:{...job.input,historyProof:job.historyProof,sourceExportHandle:job.sourceExportHandle},bundle});if(current&&typeof current.then==='function'){Promise.resolve(current).catch(()=>{});return false;}return current===true;}catch{return false;}};
 function remember(key,value){completed.set(key,freeze(structuredClone(value)));while(completed.size>config.maxReceipts)completed.delete(completed.keys().next().value);}
 function blockedReceipt(reason,extra={}){blocked++;return receipt('blocked',reason,extra);}
 /** The opaque token is transferred unchanged. The observed bundle separately
  * clones legacyNative.state into its private WeakMap; releasing the public
  * bundle does not release that continuation. Charge its inspectable native
  * state plus the source's bounded 2048-row lead trace until slot replacement.
  * This conservative engineering estimate is not measured private heap size. */
 function prepareContinuation(bundle){
  const liveState=bundle.nextLiveState??null;
  if(liveState===null)return{liveState,lease:null,bytes:0,basis:'no_dynamic_continuation'};
  const token=snapshotPlainRecord(liveState,{maxKeys:8});
  // Legacy trusted callback fixtures can expose plain inspectable states. They
  // have no private native payload contract and cannot claim native ownership.
  if(!PRIVATE_STATE_CONTRACTS.has(token.contract))return{liveState,lease:null,bytes:0,basis:'private_payload_not_inspected'};
  const native=snapshotPlainRecord(bundle.components?.legacyNative,{maxKeys:64}),state=snapshotPlainRecord(native.state,{maxKeys:8});
  if(token.matchId!==bundle.matchId||token.historyContentHash!==bundle.historyContextHash||token.lastObservationId!==native.observationId||!NATIVE_STATE_CONTRACTS.has(native.contract)||state.contract!==native.contract||!Array.isArray(state.history)||state.history.length>MAX_CONTINUATION_ROWS)throw Error('continuation_state_binding');
  const serializedBytes=measureBoundedJsonBytes(state,{maxBytes:config.maxInputBytes}),bytes=serializedBytes*6+MAX_CONTINUATION_ROWS*LEAD_ROW_ESTIMATED_BYTES+65536,lease=typeof arena.retainAsset==='function'?arena.retainAsset(liveState,bytes):null;
  if(!lease)throw Error('continuation_memory_reservation');
  return{liveState,lease,bytes,basis:'public_native_state_plus_bounded_private_leads_explicit_estimate'};
 }
 function commitContinuation(slot,metadata,continuation){
  const old=slot.committed?.continuationLease;
  slot.committed={...metadata,liveState:continuation.liveState,continuationLease:continuation.lease,continuationBytes:continuation.bytes,continuationBasis:continuation.basis};
  continuation.lease=null;old?.release();
 }
 async function ensureSchema(hash,immutable){
  if(schemas.has(hash)){const known=schemas.get(hash);schemas.delete(hash);schemas.set(hash,known);return;}
  if(!schemaFlights.has(hash)){
   // Pending work already bounds active schema writes; never evict their owned
   // immutable inputs. The LRU holds completed registration metadata only.
   if(!immutable)throw Error('schema_reference_unavailable');
   const promise=Promise.resolve().then(()=>writeSchema({schemaHash:hash,schema:immutable})).then(r=>{
    if(!r||!['created','existing_verified'].includes(r.status)||r.schemaHash!==hash)throw Error('schema_write_receipt_invalid');
    schemas.delete(hash);while(schemas.size>=config.maxSchemas)schemas.delete(schemas.keys().next().value);
    schemas.set(hash,{schemaHash:hash,status:r.status});
   });
   schemaFlights.set(hash,promise);promise.then(()=>schemaFlights.delete(hash),()=>schemaFlights.delete(hash));
  }
  await schemaFlights.get(hash);
 }
 function prepare(input,{restoreTraceSha256=null}={},size){
  if(restoreTraceSha256!==null&&(typeof restoreTraceSha256!=='string'||!SHA.test(restoreTraceSha256)||typeof restoreTrace!=='function'))throw Error('owned_trace_restore_port_required');
  if(!object(input)||Object.keys(input).some(k=>!INPUT_KEYS.includes(k))||!ID.test(input.matchId??'')||instantNs(input.decisionAt)===null||!SHA.test(input.expectedSourceSnapshotHash??'')||Number(input.sourceExportInput!=null)+Number(input.sourceExportHandle!=null)!==1)throw Error('host_input_contract');
  const mode=input.mode??'AUTO';if(!['AUTO','POST','LIVE'].includes(mode))throw Error('host_map_phase_only');
  const h=readDynamicHistoryProof(input.historyProof,{matchId:input.matchId,decisionAt:input.decisionAt});if(!h.accepted)throw Error(h.reason);
  let sourceDescriptor=null;
  if(input.sourceExportHandle!=null){const handleContract=snapshotPlainRecord(input.sourceExportHandle,{maxKeys:8}).contract,options={expectedSourceSnapshotHash:input.expectedSourceSnapshotHash,matchId:input.matchId,decisionAt:input.decisionAt};sourceDescriptor=handleContract===VERIFIED_RETAINED_NATIVE_SOURCE_HANDLE_CONTRACT?readVerifiedRetainedNativeSourceHandle(input.sourceExportHandle,options):handleContract===VERIFIED_RETAINED_REFERENCE_SOURCE_HANDLE_CONTRACT?readVerifiedRetainedReferenceSourceHandle(input.sourceExportHandle,options):readVerifiedHistorySourceHandle(input.sourceExportHandle,options);}
  preparation.ownedCopies++;
  const {historyProof,sourceExportHandle=null,progressionProof=null,retainedReplayProof=null,...data}=input,copy=structuredClone(data);copy.mode=mode;
  let progressionBindingHash=null;
  let replayBinding=null;
  if(progressionProof!==null||retainedReplayProof!==null){const current=readCurrentSteamInput({prefix:copy.livePrefixInputs,context:h.context,matchId:copy.matchId,decisionAt:copy.decisionAt,progressionProof,retainedReplayProof});progressionBindingHash=current.admission.progressionBindingHash??null;replayBinding=current.reconstruction;}
  // All actual bytes and review pins participate. Pin-only deduplication would
  // let a changed corrupt body reuse an earlier successful job.
  preparation.evidenceHashes++;
  const key=evidenceHash({contract:CONSUMER_CONTRACT,input:copy,sourceDescriptor,progressionBindingHash,replayBinding,restoreTraceSha256,historyContentHash:h.context.contentHash});
  const historyKey=evidenceHash({contentHash:h.context.contentHash,sourceSnapshotHash:copy.expectedSourceSnapshotHash,envelopePin:sourceDescriptor?.reference??copy.sourceExportInput?.pin??null});
  return{input:freeze(copy),historyProof,sourceExportHandle,progressionProof,retainedReplayProof,restoreTraceSha256,context:h.context,historyKey,key,size};
 }
 async function execute(job,slot){
  const input=job.input,meta={matchId:input.matchId,decisionAt:input.decisionAt,jobKey:job.key};
  if(!continuing())return blockedReceipt('manual_stop_or_session_abort',meta);
  if(job.sourceEpoch!==slot.sourceEpoch)return blockedReceipt('source_continuity_changed_while_queued',meta);
  const prior=slot.committed,context=job.context,sourceEpoch=job.sourceEpoch;
  if(prior){
   if(instantNs(input.decisionAt)<instantNs(prior.decisionAt))return blockedReceipt('decision_time_regression',meta);
   if(instantNs(context.historyCutoffAt)!==instantNs(prior.historyCutoffAt))return blockedReceipt('immutable_history_cutoff_changed',meta);
   if(context.draftState.revision<prior.revision||instantNs(context.computedAt)<instantNs(prior.historyComputedAt))return blockedReceipt('stale_history_provenance',meta);
  }
  const reset=prior!==null&&prior.historyKey!==job.historyKey,previousLiveState=prior&&!reset?prior.liveState:null;
  // A new historical export resets feature windows, not the observed progress
  // of this map. Only explicit forgetMap releases this independent watermark.
  let liveWatermark=prior?.liveWatermark??null,bundle,trace,continuation=null,priorLease=null,generationStartedAt;const ownedSchemas=new Map();
  try{
  try{
   // Retain the actual previous token before any reentrant host clock/generation
   // port or await. A source barrier can drop the slot while this job still uses
   // its prior reference; that borrow must remain byte owned until this finally.
   if(prior?.continuationLease&&prior.liveState!==null){priorLease=typeof arena.retainAsset==='function'?arena.retainAsset(prior.liveState,prior.continuationBytes):null;if(!priorLease)throw Error('continuation_borrow_admission');}
   generationStartedAt=now();
   if(instantNs(generationStartedAt)===null||instantNs(generationStartedAt)<instantNs(input.decisionAt))throw Error('generation_clock_contract');
   bundle=producer.generateFeatureBundle({...input,historyProof:job.historyProof,sourceExportHandle:job.sourceExportHandle,previousLiveState,progressionProof:job.progressionProof,retainedReplayProof:job.retainedReplayProof});
   if(bundle?.contract!==UNIFIED_PRODUCER_CONTRACT||bundle.matchId!==input.matchId||bundle.decisionAt!==input.decisionAt||bundle.sourceSnapshotHash!==input.expectedSourceSnapshotHash||bundle.historyContextHash!==context.contentHash||instantNs(bundle.historyCutoffAt)!==instantNs(context.historyCutoffAt)||!['POST','LIVE'].includes(bundle.mode)||bundle.eligibleForServing!==false||bundle.eligibleForTraining!==false||bundle.recordedPrediction!==false||!Array.isArray(bundle.routes)||bundle.routes.some(r=>r.eligibleForServing!==false||r.eligibleForTraining!==false||r.inferenceVector!==null))throw Error('producer_output_identity_or_admission');
   // Capture every schema before the first await: another map can churn the
   // compiler cache while this bundle is committing its earlier route schemas.
   if(!compact)for(const route of bundle.routes){const hash=route.schemaRef?.sha256;if(!SHA.test(hash??''))throw Error('schema_reference_invalid');if(!ownedSchemas.has(hash)){const schema=route.diagnosticSchema??producer.getSchema(hash);if(!schema)throw Error('schema_reference_unavailable');ownedSchemas.set(hash,Object.isFrozen(schema)?schema:freeze(structuredClone(schema)));}}
   if(liveWatermark!==null&&bundle.mode!=='LIVE')throw Error('map_phase_regression_after_history_reset');
   if(bundle.mode==='LIVE'){
    const admission=bundle.sourceAdmission,clock=admission?.clock,received=instantNs(admission?.provenance?.receivedAt);
    if(!['observed_live','observed_progressing_live'].includes(admission?.classification)||admission.dynamicDiagnosticAllowed!==true||typeof clock!=='number'||!Number.isFinite(clock)||clock<0||received===null||received>instantNs(input.decisionAt))throw Error('live_watermark_source_admission');
    if(liveWatermark!==null&&(clock<liveWatermark.clockSeconds||received<instantNs(liveWatermark.receivedAt)))throw Error('map_clock_or_receipt_regression_after_history_reset');
    liveWatermark={clockSeconds:clock,receivedAt:admission.provenance.receivedAt};
   }
   continuation=prepareContinuation(bundle);
   const featuresReadyAt=now();
   if(instantNs(generationStartedAt)===null||instantNs(featuresReadyAt)===null||instantNs(generationStartedAt)<instantNs(input.decisionAt)||instantNs(featuresReadyAt)<instantNs(generationStartedAt))throw Error('generation_clock_contract');
   bundle.timings={decisionInputCutoff:input.decisionAt,generationStartedAt,featuresReadyAt,originalPredictionTimingClaimed:false};
   if(!compact)trace=freeze(encodeDiagnosticFeatureTrace(bundle,{maxBytes:config.maxTraceBytes}));
  }catch{failed++;return receipt('failed','generation_or_source_contract_failed',meta);}
  if(job.restoreTraceSha256!==null){
   try{
    const stored=await restoreTrace(job.restoreTraceSha256);
    if(compact&&stored?.body){try{if(!compactTraceMatchesBundle(stored,bundle))throw Error('durable_trace_reconstruction_mismatch');}finally{stored?.release?.();}}
    else{if(!trace)trace=freeze(encodeDiagnosticFeatureTrace(bundle,{maxBytes:config.maxTraceBytes}));const fresh=JSON.parse(trace.utf8);
    // Re-materialization time/context hash may change after restart. Only a
    // verified durable trace with exactly the same source and computed vector
    // can restore the newly reconstructed opaque state. Never rewrite it.
    const keys=['contract','producerContract','matchId','seriesId','mode','featureInputCutoffAt','historyCutoffAt','sourceSnapshotHash','historicalBindings','historicalInputRef','semanticEvidence','targetBinding','sourceAdmission','inputSourceBindings','draftObservation','liveRejection','nativeObservationId','nativeRawSha256','nativeKnownAt','nativeGameClock','seriesReceiptPin','routes','vectors','eligibleForTraining','eligibleForServing','recordedPrediction'];
    const select=x=>({...Object.fromEntries(keys.map(k=>[k,x[k]??null])),reconstruction:x.reconstruction===null||x.reconstruction===undefined?null:Object.fromEntries(Object.entries(x.reconstruction).filter(([k])=>k!=='reconstructedAt'))});
    if(!stored||evidenceHash(select(stored))!==evidenceHash(select(fresh)))throw Error('durable_trace_reconstruction_mismatch');
    }
    if(!continuing())return blockedReceipt('manual_stop_during_trace_restore',meta);
    const restoredAt=now();if(instantNs(restoredAt)===null||instantNs(restoredAt)<instantNs(bundle.timings.featuresReadyAt))throw Error('trace_restore_clock_contract');
    if(slot.sourceEpoch!==sourceEpoch)return blockedReceipt('source_continuity_changed_during_restore',meta);
    if(!currentInput(job,bundle))return blockedReceipt('owned_input_changed_during_restore',meta);
    commitContinuation(slot,{historyKey:job.historyKey,historyCutoffAt:context.historyCutoffAt,historyComputedAt:context.computedAt,revision:context.draftState.revision,decisionAt:input.decisionAt,liveWatermark},continuation);
    const result=receipt('restored_diagnostic_state',null,{...meta,mode:bundle.mode,traceSha256:job.restoreTraceSha256,restoredFromTraceSha256:job.restoreTraceSha256,traceCommitted:true,stateAdvanced:true,generationTimings:bundle.timings});remember(job.key,result);return result;
   }catch{failed++;return receipt('failed','durable_trace_restore_failed',meta);}
  }
  if(!continuing())return blockedReceipt('manual_stop_before_schema_write',meta);
  try{if(!compact)for(const hash of [...new Set(bundle.routes.map(r=>r.schemaRef?.sha256))]){if(!SHA.test(hash??''))throw Error('schema_reference_invalid');await ensureSchema(hash,ownedSchemas.get(hash));if(!continuing())return blockedReceipt('manual_stop_after_schema_write',meta);}}
  catch{failed++;return receipt('failed','schema_registration_failed',meta);}
  if(!continuing())return blockedReceipt('manual_stop_before_trace_write',meta);
  if(slot.sourceEpoch!==sourceEpoch)return blockedReceipt('source_continuity_changed_before_trace',meta);
  if(!currentInput(job,bundle))return blockedReceipt('owned_input_changed_before_trace',meta);
  let saved;const expectedTraceSha256=trace?.sha256;
  try{if(compact){saved=await compactJournal.appendBundle(bundle);const ref=saved?.reference;if(saved?.contract!=='aegis.compact-diagnostic-feature-journal.v2'||ref?.kind!=='compact-feature-trace-v2'||!SHA.test(ref.sha256??'')||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||saved.eligibleForServing!==false||saved.eligibleForTraining!==false)throw Error('trace_write_receipt_invalid');trace={sha256:ref.sha256,bytes:ref.bytes,vectorPoolSize:new Set(bundle.routes.map(r=>r.diagnosticVector)).size};}else{saved=await appendTrace(trace);if(!saved||!['created','existing_verified'].includes(saved.status)||saved.sha256!==expectedTraceSha256)throw Error('trace_write_receipt_invalid');}}
  catch{failed++;return receipt('failed','trace_append_failed',{...meta,traceCommitStatus:'unknown_callback_failed'});}
  if(!continuing())return blockedReceipt('manual_stop_after_trace_commit',{...meta,traceSha256:trace.sha256,traceCommitted:true});
  const journalCommittedAt=now();
  if(instantNs(journalCommittedAt)===null||instantNs(journalCommittedAt)<instantNs(bundle.timings.featuresReadyAt)){failed++;return receipt('failed','journal_commit_clock_contract',{...meta,traceSha256:trace.sha256,traceCommitted:true});}
  if(slot.sourceEpoch!==sourceEpoch)return blockedReceipt('source_continuity_changed_after_trace',{...meta,traceSha256:trace.sha256,traceCommitted:true});
  if(!currentInput(job,bundle))return blockedReceipt('owned_input_changed_after_trace',{...meta,traceSha256:trace.sha256,traceCommitted:true});
  // Commit the opaque next state ONLY after durable schema+trace receipts.
  commitContinuation(slot,{historyKey:job.historyKey,historyCutoffAt:context.historyCutoffAt,historyComputedAt:context.computedAt,revision:context.draftState.revision,decisionAt:input.decisionAt,liveWatermark},continuation);
  recorded++;
  const result=receipt('recorded_diagnostic',null,{...meta,mode:bundle.mode,seriesId:bundle.seriesId??null,traceSha256:trace.sha256,traceBytes:trace.bytes,vectorPoolSize:trace.vectorPoolSize,schemaRefs:bundle.routes.map(r=>r.schemaRef),...(compact?{traceFormat:'compact_v2',compactTraceReference:saved.reference}:{}),traceCommitted:true,journalCommittedAt,generationTimings:bundle.timings,provenanceReset:reset,stateAdvanced:true});
  remember(job.key,result);return result;
  }finally{
   // v1 trusted producers have no release port. A current bundle remains owned
   // through every awaited callback/restore check, then releases exactly once.
   // Token borrows outlive this potentially reentrant cleanup port as well.
   try{if(typeof bundle?.release==='function')bundle.release();}finally{continuation?.lease?.release();priorLease?.release();}
  }
 }
 return Object.freeze({
  contract:CONSUMER_CONTRACT,
  consume(input,options={}){
   if(!continuing())return Promise.resolve(blockedReceipt('manual_stop_or_session_abort'));
   // Admission precedes traversal/serialization/copy/hash. Rejected overload
   // cannot amplify already held work with another large temporary snapshot.
   if(pending>=config.maxPending||pendingBytes>=config.maxPendingBytes)return Promise.resolve(blockedReceipt('pending_work_bound'));
   try{input=snapshotPlainRecord(input);options=snapshotPlainRecord(options);}catch{return Promise.resolve(blockedReceipt('host_input_or_history_contract'));}
   if(!object(input)||typeof input.matchId!=='string'||!ID.test(input.matchId))return Promise.resolve(blockedReceipt('host_input_or_history_contract'));
   if(!maps.has(input.matchId)&&maps.size>=config.maxMaps)return Promise.resolve(blockedReceipt('map_cache_bound',{matchId:input.matchId}));
   let size,allocation,job;
   try{
    if(!object(options)||Object.keys(options).some(k=>k!=='restoreTraceSha256'))throw Error('consume_options');
    preparation.measurements++;size=inputSize(input);if(size>config.maxInputBytes)throw Error('input_bytes_bound');
    if(size>config.maxPendingBytes-pendingBytes)return Promise.resolve(blockedReceipt('pending_work_bound',{matchId:input.matchId}));
    allocation=arena.reserve(size*6+65536);if(!allocation)return Promise.resolve(blockedReceipt('memory_reservation_bound',{matchId:input.matchId}));
    job=prepare(input,options,size);
   }catch{allocation?.release();return Promise.resolve(blockedReceipt('host_input_or_history_contract'));}
   job.sourceEpoch=maps.get(job.input.matchId)?.sourceEpoch??0;
   job.key=evidenceHash({inputKey:job.key,sourceEpoch:job.sourceEpoch});
   if(completed.has(job.key)){allocation.release();return Promise.resolve({...structuredClone(completed.get(job.key)),stateAdvanced:false,reusedReceipt:true});}
   if(flights.has(job.key)){allocation.release();return flights.get(job.key).then(r=>({...structuredClone(r),stateAdvanced:false,coalescedReceipt:true}));}
   let slot=maps.get(job.input.matchId);
   if(!slot){slot={tail:Promise.resolve(),pending:0,committed:null,sourceEpoch:0};maps.set(job.input.matchId,slot);}
   pending++;pendingBytes+=job.size;slot.pending++;
   const promise=globalTail.catch(()=>{}).then(()=>execute(job,slot)).catch(()=>{failed++;return receipt('failed','unexpected_host_port_failure');});
   globalTail=promise;slot.tail=promise;flights.set(job.key,promise);
   promise.finally(()=>{allocation.release();pending--;pendingBytes-=job.size;slot.pending--;flights.delete(job.key);if(slot.pending===0&&slot.committed===null)maps.delete(job.input.matchId);});
   return promise.then(structuredClone);
  },
  invalidateSourceContinuity(matchId){
   const slot=maps.get(matchId);if(!slot)return{cleared:false,reason:'map_not_cached'};
   slot.sourceEpoch++;if(slot.committed){slot.committed.continuationLease?.release();slot.committed={...slot.committed,liveState:null,continuationLease:null,continuationBytes:0,continuationBasis:'source_continuity_reset'};}
   for(const[key,r]of completed)if(r.matchId===matchId)completed.delete(key);
   return{cleared:true,reason:'source_window_reset; history_and_clock_watermarks_preserved'};
  },
  forgetMap(matchId){const slot=maps.get(matchId);if(!slot)return{released:false,reason:'map_not_cached'};if(slot.pending)return{released:false,reason:'map_work_pending'};slot.committed?.continuationLease?.release();maps.delete(matchId);for(const[key,r]of completed)if(r.matchId===matchId)completed.delete(key);return{released:true,reason:'explicit_host_cache_release; durable_trace_unchanged'};},
  status(){const retained=[...maps.values()].map(s=>s.committed).filter(Boolean);return{contract:CONSUMER_CONTRACT,maps:maps.size,pending,pendingBytes,successfulReceipts:completed.size,registeredSchemas:schemas.size,schemaWritesInFlight:schemaFlights.size,recorded,failed,blocked,preparation:{...preparation},continuationOwnership:{estimatedBytes:retained.reduce((n,s)=>n+(s.continuationBytes??0),0),ownedMaps:retained.filter(s=>s.continuationLease!==null&&s.continuationLease!==undefined).length,unmeasuredMaps:retained.filter(s=>s.liveState!==null&&!s.continuationLease).length,accounting:'conservative_public_state_proxy_not_measured_private_heap'},resourceArena:arena.status(),globalRichExecutionConcurrency:1,limits:{...config},...flags};}
 });
}
