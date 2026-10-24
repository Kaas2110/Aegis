/** Explicit owned diagnostic port for map PRE and series PRE/BETWEEN. No model,
 * provider, request-triggered collection or implicit listener. Disabled by default. */
import {encodeDiagnosticFeatureTrace,UNIFIED_PRODUCER_CONTRACT} from './unifiedFeatureProducer.mjs';
import {instantNs} from './causalTime.mjs';
const flags={diagnosticOnly:true,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
const allowed={PRE:['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','SERIES_PRE'],SERIES_PRE:['SERIES_PRE'],BETWEEN:['SERIES_BETWEEN']};
export function createStaticDiagnosticWriter({producer,journal,enabled=false,now=()=>new Date().toISOString(),shouldContinue=()=>true}={}){
 if(producer?.contract!==UNIFIED_PRODUCER_CONTRACT||typeof journal?.writeSchema!=='function'||typeof journal?.appendTrace!=='function'||typeof enabled!=='boolean'||typeof now!=='function'||typeof shouldContinue!=='function')throw Error('static_diagnostic_writer:owned_ports');
 let busy=false;
 const blocked=reason=>({status:'blocked',reason,...flags});
 return Object.freeze({async consume(input){
  if(!enabled)return blocked('diagnostic_writer_disabled');
  if(busy)return blocked('diagnostic_writer_busy');
  if(shouldContinue()!==true)return blocked('manual_stop');
  if(!input||!Object.hasOwn(allowed,input.mode))return blocked('static_phase_required');
  busy=true;
  try{
   const generationStartedAt=now();if(instantNs(input.decisionAt)===null||instantNs(generationStartedAt)===null||instantNs(input.decisionAt)>instantNs(generationStartedAt))throw Error('static_input_cutoff_after_calculation');
   const bundle=producer.generateFeatureBundle(input),featuresReadyAt=now();
   if(bundle.contract!==UNIFIED_PRODUCER_CONTRACT||bundle.mode!==input.mode||bundle.decisionAt!==input.decisionAt||bundle.eligibleForServing!==false||bundle.eligibleForTraining!==false||bundle.recordedPrediction!==false||instantNs(input.decisionAt)===null||instantNs(generationStartedAt)===null||instantNs(featuresReadyAt)===null||instantNs(generationStartedAt)<instantNs(input.decisionAt)||instantNs(featuresReadyAt)<instantNs(generationStartedAt)||bundle.routes.some(r=>!allowed[input.mode].includes(r.targetId)||r.inferenceVector!==null))throw Error('static_producer_contract');
   if(bundle.status==='series_complete_actual_result')return {status:bundle.status,seriesId:bundle.seriesId,...flags};
   bundle.timings={decisionInputCutoff:input.decisionAt,generationStartedAt,featuresReadyAt,originalPredictionTimingClaimed:false};
   const historical=input.mode==='PRE'?input.prematchInput:input.seriesHistoryInput;
   if(!historical||typeof journal.writeHistoricalInputs!=='function'||shouldContinue()!==true)throw Error('static_historical_input_store_required');
   const storedInputs=await journal.writeHistoricalInputs({mode:input.mode,...historical,seriesInput:input.seriesInput??null});
   if(!['created','existing_verified'].includes(storedInputs?.status)||storedInputs.reference?.contract!=='aegis.static-historical-input-reference.v1'||!/^[a-f0-9]{64}$/.test(storedInputs.reference.sha256??''))throw Error('static_historical_input_receipt');
   bundle.historicalInputRef=storedInputs.reference;
   const trace=encodeDiagnosticFeatureTrace(bundle);
   for(const schemaHash of new Set(bundle.routes.map(r=>r.schemaRef.sha256))){
    if(shouldContinue()!==true)return blocked('manual_stop_before_schema');
    const r=await journal.writeSchema({schemaHash,schema:producer.getSchema(schemaHash)});if(!['created','existing_verified'].includes(r?.status)||r.schemaHash!==schemaHash)throw Error('schema_receipt');
   }
   if(shouldContinue()!==true)return blocked('manual_stop_before_trace');
   const saved=await journal.appendTrace(trace);if(!['created','existing_verified'].includes(saved?.status)||saved.sha256!==trace.sha256)throw Error('trace_receipt');
   const journalCommittedAt=now();if(instantNs(journalCommittedAt)===null||instantNs(journalCommittedAt)<instantNs(featuresReadyAt))return {status:'failed',reason:'journal_commit_clock_contract',traceSha256:trace.sha256,traceCommitted:true,...flags};
   return {status:'recorded_diagnostic',mode:bundle.mode,matchId:bundle.matchId,seriesId:bundle.seriesId,traceSha256:trace.sha256,targetIds:bundle.routes.map(r=>r.targetId),journalCommittedAt,...flags};
  }catch{return{status:'failed',reason:'static_diagnostic_contract_or_storage',...flags};}finally{busy=false;}
 }});
}
