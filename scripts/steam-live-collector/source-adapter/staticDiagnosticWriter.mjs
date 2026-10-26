/** Explicit owned diagnostic port for map PRE and series PRE/BETWEEN. No model,
 * provider, request-triggered collection or implicit listener. Disabled by default. */
import {encodeDiagnosticFeatureTrace,UNIFIED_PRODUCER_CONTRACT} from './unifiedFeatureProducer.mjs';
import {instantNs} from './causalTime.mjs';
import {snapshotPlainRecord,measureBoundedJsonBytes} from './diagnosticResourceArena.mjs';
import {canonical} from '../../feature-registry/registry-contract.mjs';
import {readRetainedStaticHistoryProof,readRetainedStaticHistoryAuthority} from './retainedStaticHistoryView.mjs';
const flags={diagnosticOnly:true,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
const allowed={PRE:['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','SERIES_PRE'],SERIES_PRE:['SERIES_PRE'],BETWEEN:['SERIES_BETWEEN']};
export function createStaticDiagnosticWriter({producer,journal,enabled=false,now=()=>new Date().toISOString(),shouldContinue=()=>true,signal=null,readCurrentAuthority=null}={}){
 const compact=journal?.contract==='aegis.compact-diagnostic-feature-journal.v2';
 if(producer?.contract!==UNIFIED_PRODUCER_CONTRACT||(compact?typeof journal?.appendBundle!=='function':typeof journal?.writeSchema!=='function'||typeof journal?.appendTrace!=='function')||typeof enabled!=='boolean'||typeof now!=='function'||typeof shouldContinue!=='function'||readCurrentAuthority!==null&&typeof readCurrentAuthority!=='function')throw Error('static_diagnostic_writer:owned_ports');
 let busy=false;
 const blocked=reason=>({status:'blocked',reason,...flags});
 const continuing=()=>signal?.aborted!==true&&shouldContinue()===true;
 // The configured host owns this port; per-request flags cannot mint authority.
 // Legacy forensic-only writers may omit it, which is reported explicitly.
 function authority(input,expected){
  if(readCurrentAuthority===null)return null;
  const matchId=input.matchId??input.prematchInput?.matchId??null;
  const seriesId=input.seriesId??(typeof input.seriesInput?.utf8==='string'?JSON.parse(input.seriesInput.utf8).seriesId:null)??null;
  const value=readCurrentAuthority({mode:input.mode,decisionAt:input.decisionAt,matchId,seriesId});
  const record=snapshotPlainRecord(value,{maxKeys:8});
  measureBoundedJsonBytes(record,{maxBytes:16384,maxNodes:512,maxDepth:12});
  if(record.terminal!==false)throw Error('static_current_authority');
  if(expected!==null){
   if(record.contract!=='aegis.static-current-authority.v1'||Object.keys(record).sort().join(',')!=='activeTargetBinding,contract,frozenHistoricalBinding,terminal'||canonical(record)!==canonical(expected))throw Error('static_current_authority_binding');
  }else{
   // Historical v1 fixture callers may retain the change fence, but an unbound
   // stamp can never certify that a candidate matches the active private proof.
   if(Object.keys(record).sort().join(',')!=='identityRevision,seriesRevision,sourceGeneration,targetGeneration,terminal')throw Error('static_current_authority');
   for(const key of ['identityRevision','seriesRevision','sourceGeneration','targetGeneration'])if(typeof record[key]!=='string'||record[key].length<1||record[key].length>256)throw Error('static_current_authority');
  }
  return canonical(record);
 }
 return Object.freeze({async consume(input){
  if(!enabled)return blocked('diagnostic_writer_disabled');
  if(busy)return blocked('diagnostic_writer_busy');
  if(!continuing())return blocked('manual_stop');
  if(!input||!Object.hasOwn(allowed,input.mode))return blocked('static_phase_required');
  busy=true;let bundle=null,committed=null;
  try{
   input=snapshotPlainRecord(input,{maxKeys:32});
   if(input.staticHistoryProof!==undefined&&input.staticHistoryProof!==null){
    if(!compact)throw Error('bounded_static_requires_compact_journal');
    const verified=readRetainedStaticHistoryProof(input.staticHistoryProof,{mode:input.mode,matchId:input.matchId??null,...(input.seriesId===undefined?{}:{seriesId:input.seriesId}),decisionAt:input.decisionAt});
    if(input.seriesInput!==undefined&&input.seriesInput!==null&&(input.seriesInput.pin?.sha256!==verified.seriesInput?.pin.sha256||input.seriesInput.pin?.bytes!==verified.seriesInput?.pin.bytes||input.seriesInput.utf8!==verified.seriesInput?.utf8))throw Error('static_series_receipt_binding');
    input={...input,seriesInput:verified.seriesInput};
   }
   const expectedAuthority=input.staticHistoryProof?readRetainedStaticHistoryAuthority(input.staticHistoryProof,{mode:input.mode,matchId:input.matchId??null,...(input.seriesId===undefined?{}:{seriesId:input.seriesId}),decisionAt:input.decisionAt}):null;
   const originalAuthority=authority(input,expectedAuthority);
   const checkAuthority=()=>{if(expectedAuthority!==null&&canonical(readRetainedStaticHistoryAuthority(input.staticHistoryProof,{mode:input.mode,matchId:input.matchId??null,...(input.seriesId===undefined?{}:{seriesId:input.seriesId}),decisionAt:input.decisionAt}))!==canonical(expectedAuthority))throw Error('static_private_authority_changed');if(authority(input,expectedAuthority)!==originalAuthority)throw Error('static_authority_changed_after_io');};
   const generationStartedAt=now();if(instantNs(input.decisionAt)===null||instantNs(generationStartedAt)===null||instantNs(input.decisionAt)>instantNs(generationStartedAt))throw Error('static_input_cutoff_after_calculation');
   bundle=producer.generateFeatureBundle(input);const featuresReadyAt=now();
   if(bundle.contract!==UNIFIED_PRODUCER_CONTRACT||bundle.mode!==input.mode||bundle.decisionAt!==input.decisionAt||bundle.eligibleForServing!==false||bundle.eligibleForTraining!==false||bundle.recordedPrediction!==false||instantNs(input.decisionAt)===null||instantNs(generationStartedAt)===null||instantNs(featuresReadyAt)===null||instantNs(generationStartedAt)<instantNs(input.decisionAt)||instantNs(featuresReadyAt)<instantNs(generationStartedAt)||bundle.routes.some(r=>!allowed[input.mode].includes(r.targetId)||r.inferenceVector!==null))throw Error('static_producer_contract');
   if(bundle.status==='series_complete_actual_result')return {status:bundle.status,seriesId:bundle.seriesId,...flags};
   bundle.timings={decisionInputCutoff:input.decisionAt,generationStartedAt,featuresReadyAt,originalPredictionTimingClaimed:false};
   const historical=input.staticHistoryProof?{staticHistoryProof:input.staticHistoryProof,minimumSupport:readRetainedStaticHistoryProof(input.staticHistoryProof,{mode:input.mode,decisionAt:input.decisionAt}).component.audit.minimumSupport}:input.mode==='PRE'?input.prematchInput:input.seriesHistoryInput;
   if(!historical||typeof journal.writeHistoricalInputs!=='function'||!continuing())throw Error('static_historical_input_store_required');
   const storedInputs=await journal.writeHistoricalInputs({mode:input.mode,...historical,seriesInput:input.seriesInput??null,...(compact?{decisionAt:input.decisionAt}:{})});
   try{if(!(compact?storedInputs?.status==='committed_and_dependencies_verified':['created','existing_verified'].includes(storedInputs?.status))||storedInputs.reference?.contract!==(compact?'aegis.static-historical-input-reference.v2':'aegis.static-historical-input-reference.v1')||!/^[a-f0-9]{64}$/.test(storedInputs.reference.sha256??''))throw Error('static_historical_input_receipt');bundle.historicalInputRef=storedInputs.reference;}finally{storedInputs?.release?.();}
   checkAuthority();
   const trace=compact?null:encodeDiagnosticFeatureTrace(bundle);
   if(!compact)for(const schemaHash of new Set(bundle.routes.map(r=>r.schemaRef.sha256))){
    if(!continuing())return blocked('manual_stop_before_schema');
    const r=await journal.writeSchema({schemaHash,schema:producer.getSchema(schemaHash)});if(!['created','existing_verified'].includes(r?.status)||r.schemaHash!==schemaHash)throw Error('schema_receipt');checkAuthority();
   }
   if(!continuing())return blocked('manual_stop_before_trace');
   const saved=compact?await journal.appendBundle(bundle):await journal.appendTrace(trace);
   if(compact){if(saved?.contract!==journal.contract||saved.reference?.kind!=='compact-feature-trace-v2'||!/^[a-f0-9]{64}$/.test(saved.reference.sha256??''))throw Error('trace_receipt');committed=saved.reference.sha256;}
   else{if(!['created','existing_verified'].includes(saved?.status)||saved.sha256!==trace.sha256)throw Error('trace_receipt');committed=trace.sha256;}
   const journalCommittedAt=now();if(instantNs(journalCommittedAt)===null||instantNs(journalCommittedAt)<instantNs(featuresReadyAt))return {status:'failed',reason:'journal_commit_clock_contract',traceSha256:committed,traceCommitted:true,...flags};
   if(!continuing())return {...blocked('manual_stop_after_trace'),traceSha256:committed,traceCommitted:true,currentAuthorityVerified:false};
   checkAuthority();
   return {status:'recorded_diagnostic',mode:bundle.mode,matchId:bundle.matchId,seriesId:bundle.seriesId,traceSha256:committed,targetIds:bundle.routes.map(r=>r.targetId),journalCommittedAt,currentAuthorityVerified:expectedAuthority!==null&&originalAuthority!==null,...flags};
  }catch{return{status:'failed',reason:'static_diagnostic_contract_or_storage',...(committed?{traceSha256:committed,traceCommitted:true}:{}),currentAuthorityVerified:false,...flags};}finally{try{if(typeof bundle?.release==='function')bundle.release();}finally{busy=false;}}
 }});
}
