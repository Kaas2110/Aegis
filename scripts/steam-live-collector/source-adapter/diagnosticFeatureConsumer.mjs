/** Opt-in trusted-background-host orchestration. No IO, provider, DB, model,
 * scheduler or HTTP entrypoint. Call only after an owned archive commit.
 * Canonical generation/proofs remain responsible for actual source admission.
 */
import {readDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {encodeDiagnosticFeatureTrace,UNIFIED_PRODUCER_CONTRACT} from './unifiedFeatureProducer.mjs';
import {instantNs} from './causalTime.mjs';
import {evidenceHash} from './playerHeroEconomyFeatures.mjs';
export const CONSUMER_CONTRACT='aegis.background-diagnostic-feature-consumer.v1';
const SHA=/^[a-f0-9]{64}$/,ID=/^[1-9]\d{0,19}$/;
const DEFAULTS={maxMaps:8,maxPending:16,maxReceipts:64,maxSchemas:32,maxInputBytes:128*1024*1024,maxPendingBytes:128*1024*1024,maxTraceBytes:16*1024*1024};
const CAPS={maxMaps:16,maxPending:64,maxReceipts:256,maxSchemas:128,maxInputBytes:128*1024*1024,maxPendingBytes:512*1024*1024,maxTraceBytes:64*1024*1024};
const flags={diagnosticOnly:true,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false,publicPromotion:false};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const receipt=(status,reason,extra={})=>({contract:CONSUMER_CONTRACT,status,reason,stateAdvanced:false,...extra,...flags});
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const INPUT_KEYS=['matchId','decisionAt','historyProof','sourceExportInput','expectedSourceSnapshotHash','livePrefixInputs','seriesInput','currentMapNumber','mode','patch','rulesEvidence','expectedRulesSha256','eventsEvidence','expectedEventsSha256'];
function inputSize(input){
 let bytes=0;
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
 const {historyProof,...serializable}=input;
 return Buffer.byteLength(JSON.stringify(serializable));
}

/** The callbacks are trusted host ports, not caller/client selectors:
 * writeSchema({schemaHash,schema}) -> {status:'created'|'existing_verified',schemaHash}
 * appendTrace(encodedTrace) -> {status:'created'|'existing_verified',sha256}
 * Callbacks must be bounded/abort-aware in the actual host. A pending write is
 * not forcibly cancelled; after it settles the consumer checks stop again.
 */
export function createDiagnosticFeatureConsumer({producer,writeSchema,appendTrace,shouldContinue=()=>true,signal=null,limits={}}={}){
 if(producer?.contract!==UNIFIED_PRODUCER_CONTRACT||typeof producer.generateFeatureBundle!=='function'||typeof producer.getSchema!=='function'||typeof writeSchema!=='function'||typeof appendTrace!=='function'||typeof shouldContinue!=='function'||signal!==null&&(typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'))throw Error('diagnostic_consumer_owned_ports_required');
 if(!object(limits)||Object.keys(limits).some(k=>!Object.hasOwn(DEFAULTS,k)))throw Error('diagnostic_consumer_limit_keys');
 const config={...DEFAULTS,...limits};for(const [k,v]of Object.entries(config))if(!Number.isSafeInteger(v)||v<1||v>CAPS[k]||k==='maxTraceBytes'&&v<1024)throw Error('diagnostic_consumer_limit_bound:'+k);
 const maps=new Map(),flights=new Map(),completed=new Map(),schemas=new Map(),schemaFlights=new Map();let pending=0,pendingBytes=0;
 let recorded=0,failed=0,blocked=0;
 const continuing=()=>{try{return signal?.aborted!==true&&shouldContinue()===true;}catch{return false;}};
 function remember(key,value){completed.set(key,freeze(structuredClone(value)));while(completed.size>config.maxReceipts)completed.delete(completed.keys().next().value);}
 function blockedReceipt(reason,extra={}){blocked++;return receipt('blocked',reason,extra);}
 async function ensureSchema(hash){
  if(schemas.has(hash))return;
  if(!schemaFlights.has(hash)){
   if(schemas.size+schemaFlights.size>=config.maxSchemas)throw Error('schema_cache_bound');
   const schema=producer.getSchema(hash);if(!schema)throw Error('schema_reference_unavailable');
   const immutable=freeze(structuredClone(schema));
   const promise=Promise.resolve().then(()=>writeSchema({schemaHash:hash,schema:immutable})).then(r=>{
    if(!r||!['created','existing_verified'].includes(r.status)||r.schemaHash!==hash)throw Error('schema_write_receipt_invalid');
    schemas.set(hash,{schemaHash:hash,status:r.status});
   });
   schemaFlights.set(hash,promise);promise.then(()=>schemaFlights.delete(hash),()=>schemaFlights.delete(hash));
  }
  await schemaFlights.get(hash);
 }
 function prepare(input){
  if(!object(input)||Object.keys(input).some(k=>!INPUT_KEYS.includes(k))||!ID.test(input.matchId??'')||instantNs(input.decisionAt)===null||!SHA.test(input.expectedSourceSnapshotHash??'')||input.sourceExportInput===null||input.sourceExportInput===undefined)throw Error('host_input_contract');
  const mode=input.mode??'AUTO';if(!['AUTO','POST','LIVE'].includes(mode))throw Error('host_map_phase_only');
  const h=readDynamicHistoryProof(input.historyProof,{matchId:input.matchId,decisionAt:input.decisionAt});if(!h.accepted)throw Error(h.reason);
  const size=inputSize(input);if(size>config.maxInputBytes)throw Error('input_bytes_bound');
  const {historyProof,...data}=input,copy=structuredClone(data);copy.mode=mode;
  // All actual bytes and review pins participate. Pin-only deduplication would
  // let a changed corrupt body reuse an earlier successful job.
  const key=evidenceHash({contract:CONSUMER_CONTRACT,input:copy,historyContentHash:h.context.contentHash});
  const historyKey=evidenceHash({contentHash:h.context.contentHash,sourceSnapshotHash:copy.expectedSourceSnapshotHash,envelopePin:copy.sourceExportInput.pin??null});
  return{input:freeze(copy),historyProof,context:h.context,historyKey,key,size};
 }
 async function execute(job,slot){
  const input=job.input,meta={matchId:input.matchId,decisionAt:input.decisionAt,jobKey:job.key};
  if(!continuing())return blockedReceipt('manual_stop_or_session_abort',meta);
  const prior=slot.committed,context=job.context;
  if(prior){
   if(instantNs(input.decisionAt)<instantNs(prior.decisionAt))return blockedReceipt('decision_time_regression',meta);
   if(instantNs(context.historyCutoffAt)!==instantNs(prior.historyCutoffAt))return blockedReceipt('immutable_history_cutoff_changed',meta);
   if(context.draftState.revision<prior.revision||instantNs(context.computedAt)<instantNs(prior.historyComputedAt))return blockedReceipt('stale_history_provenance',meta);
  }
  const reset=prior!==null&&prior.historyKey!==job.historyKey,previousLiveState=prior&&!reset?prior.liveState:null;
  // A new historical export resets feature windows, not the observed progress
  // of this map. Only explicit forgetMap releases this independent watermark.
  let liveWatermark=prior?.liveWatermark??null,bundle,trace;
  try{
   bundle=producer.generateFeatureBundle({...input,historyProof:job.historyProof,previousLiveState});
   if(bundle?.contract!==UNIFIED_PRODUCER_CONTRACT||bundle.matchId!==input.matchId||bundle.decisionAt!==input.decisionAt||bundle.sourceSnapshotHash!==input.expectedSourceSnapshotHash||bundle.historyContextHash!==context.contentHash||instantNs(bundle.historyCutoffAt)!==instantNs(context.historyCutoffAt)||!['POST','LIVE'].includes(bundle.mode)||bundle.eligibleForServing!==false||bundle.eligibleForTraining!==false||bundle.recordedPrediction!==false||!Array.isArray(bundle.routes)||bundle.routes.some(r=>r.eligibleForServing!==false||r.eligibleForTraining!==false||r.inferenceVector!==null))throw Error('producer_output_identity_or_admission');
   if(liveWatermark!==null&&bundle.mode!=='LIVE')throw Error('map_phase_regression_after_history_reset');
   if(bundle.mode==='LIVE'){
    const admission=bundle.sourceAdmission,clock=admission?.clock,received=instantNs(admission?.provenance?.receivedAt);
    if(admission?.classification!=='observed_live'||admission.dynamicDiagnosticAllowed!==true||typeof clock!=='number'||!Number.isFinite(clock)||clock<0||received===null||received>instantNs(input.decisionAt))throw Error('live_watermark_source_admission');
    if(liveWatermark!==null&&(clock<liveWatermark.clockSeconds||received<instantNs(liveWatermark.receivedAt)))throw Error('map_clock_or_receipt_regression_after_history_reset');
    liveWatermark={clockSeconds:clock,receivedAt:admission.provenance.receivedAt};
   }
   trace=freeze(encodeDiagnosticFeatureTrace(bundle,{maxBytes:config.maxTraceBytes}));
  }catch{failed++;return receipt('failed','generation_or_source_contract_failed',meta);}
  if(!continuing())return blockedReceipt('manual_stop_before_schema_write',meta);
  try{for(const hash of [...new Set(bundle.routes.map(r=>r.schemaRef?.sha256))]){if(!SHA.test(hash??''))throw Error('schema_reference_invalid');await ensureSchema(hash);if(!continuing())return blockedReceipt('manual_stop_after_schema_write',meta);}}
  catch{failed++;return receipt('failed','schema_registration_failed',meta);}
  if(!continuing())return blockedReceipt('manual_stop_before_trace_write',meta);
  let saved;const expectedTraceSha256=trace.sha256;
  try{saved=await appendTrace(trace);if(!saved||!['created','existing_verified'].includes(saved.status)||saved.sha256!==expectedTraceSha256)throw Error('trace_write_receipt_invalid');}
  catch{failed++;return receipt('failed','trace_append_failed',{...meta,traceCommitStatus:'unknown_callback_failed'});}
  if(!continuing())return blockedReceipt('manual_stop_after_trace_commit',{...meta,traceSha256:trace.sha256,traceCommitted:true});
  // Commit the opaque next state ONLY after durable schema+trace receipts.
  slot.committed={historyKey:job.historyKey,historyCutoffAt:context.historyCutoffAt,historyComputedAt:context.computedAt,revision:context.draftState.revision,decisionAt:input.decisionAt,liveState:bundle.nextLiveState??null,liveWatermark};
  recorded++;
  const result=receipt('recorded_diagnostic',null,{...meta,mode:bundle.mode,seriesId:bundle.seriesId??null,traceSha256:trace.sha256,traceBytes:trace.bytes,vectorPoolSize:trace.vectorPoolSize,schemaRefs:bundle.routes.map(r=>r.schemaRef),traceCommitted:true,provenanceReset:reset,stateAdvanced:true});
  remember(job.key,result);return result;
 }
 return Object.freeze({
  contract:CONSUMER_CONTRACT,
  consume(input){
   if(!continuing())return Promise.resolve(blockedReceipt('manual_stop_or_session_abort'));
   let job;try{job=prepare(input);}catch{return Promise.resolve(blockedReceipt('host_input_or_history_contract'));}
   if(completed.has(job.key))return Promise.resolve({...structuredClone(completed.get(job.key)),stateAdvanced:false,reusedReceipt:true});
   if(flights.has(job.key))return flights.get(job.key).then(r=>({...structuredClone(r),stateAdvanced:false,coalescedReceipt:true}));
   if(pending>=config.maxPending||pendingBytes+job.size>config.maxPendingBytes)return Promise.resolve(blockedReceipt('pending_work_bound',{matchId:job.input.matchId}));
   let slot=maps.get(job.input.matchId);
   if(!slot){if(maps.size>=config.maxMaps)return Promise.resolve(blockedReceipt('map_cache_bound'));slot={tail:Promise.resolve(),pending:0,committed:null};maps.set(job.input.matchId,slot);}
   pending++;pendingBytes+=job.size;slot.pending++;
   const promise=slot.tail.catch(()=>{}).then(()=>execute(job,slot)).catch(()=>{failed++;return receipt('failed','unexpected_host_port_failure');});
   slot.tail=promise;flights.set(job.key,promise);
   promise.finally(()=>{pending--;pendingBytes-=job.size;slot.pending--;flights.delete(job.key);if(slot.pending===0&&slot.committed===null)maps.delete(job.input.matchId);});
   return promise.then(structuredClone);
  },
  forgetMap(matchId){const slot=maps.get(matchId);if(!slot)return{released:false,reason:'map_not_cached'};if(slot.pending)return{released:false,reason:'map_work_pending'};maps.delete(matchId);for(const[key,r]of completed)if(r.matchId===matchId)completed.delete(key);return{released:true,reason:'explicit_host_cache_release; durable_trace_unchanged'};},
  status(){return{contract:CONSUMER_CONTRACT,maps:maps.size,pending,pendingBytes,successfulReceipts:completed.size,registeredSchemas:schemas.size,schemaWritesInFlight:schemaFlights.size,recorded,failed,blocked,limits:{...config},...flags};}
 });
}
