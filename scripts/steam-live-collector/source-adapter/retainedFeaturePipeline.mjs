/** Explicit retained-archive -> history export -> shared diagnostic vector path.
 * No provider, scheduler, model, API route or migration. Host owns DB and stop.
 * Historical replay materializes NOW; never relabel it as an old prediction. */
import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {replayPinnedDraftPrefix,DRAFT_METADATA_CONTRACT} from './observedDraftHistory.mjs';
import {draftHash} from './observedDraft.mjs';
import {collectDraftHistorySourceExport} from './historySourceExport.mjs';
import {createDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {createDiagnosticFeatureConsumer} from './diagnosticFeatureConsumer.mjs';
import {instantNs} from './causalTime.mjs';
export const RETAINED_PIPELINE_CONTRACT='aegis.retained-steam-feature-pipeline.v1';
const sha=x=>createHash('sha256').update(x).digest('hex');
const flags={diagnosticOnly:true,eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
const fail=x=>{throw Error('retained_feature_pipeline:'+x);};
const pinned=(value,path)=>{const utf8=typeof value==='string'?value:JSON.stringify(value);return{utf8,pin:{path,bytes:Buffer.byteLength(utf8),sha256:sha(utf8)}};};
const isHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function verified(input,max){if(!input||Object.keys(input).sort().join(',')!=='pin,utf8'||typeof input.utf8!=='string'||!input.pin||Object.keys(input.pin).sort().join(',')!=='bytes,path,sha256'||typeof input.pin.path!=='string'||input.pin.path.length>1024||input.pin.bytes!==Buffer.byteLength(input.utf8)||input.pin.bytes>max||!isHash(input.pin.sha256)||sha(input.utf8)!==input.pin.sha256)fail('input_pin_or_bound');return JSON.parse(input.utf8);}
async function bounded(path,max){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>max)fail('archive_file_bound');const b=await readFile(path);if(b.length>max||!Buffer.from(b.toString('utf8')).equals(b))fail('archive_utf8_or_bound');return b.toString('utf8');}
async function plainDirectory(path){const s=await lstat(path),actual=await realpath(path),equal=process.platform==='win32'?actual.toLowerCase()===path.toLowerCase():actual===path;if(!s.isDirectory()||s.isSymbolicLink()||!equal)fail('archive_directory');}
/** Read only a collector completion receipt and its exact raw file. A raw body
 * without a committed receipt is not an eligible input. Files are host evidence,
 * not an independently signed provider attestation. */
export async function readCommittedSteamCapture({archive,receiptFile}={}){
 if(!isAbsolute(archive??'')||typeof receiptFile!=='string'||!/^\d{13}-[a-f0-9-]{36}\.json$/.test(receiptFile))fail('archive_or_receipt_name');
 const root=resolve(archive);await plainDirectory(root);await plainDirectory(join(root,'observations'));await plainDirectory(join(root,'raw'));
 const receiptInput=pinned(await bounded(join(root,'observations',receiptFile),65536),'steam-archive/observations/'+receiptFile),r=JSON.parse(receiptInput.utf8);
 if(r.requestId+'.json'!==receiptFile||!isHash(r.rawSha256)||r.rawFile!=='raw/'+r.rawSha256+'.body')fail('committed_receipt_file_identity');
 const rawInput=pinned(await bounded(join(root,'raw',r.rawSha256+'.body'),4*1024*1024),'steam-archive/raw/'+r.rawSha256+'.body');
 if(rawInput.pin.sha256!==r.rawSha256)fail('committed_raw_hash');
 return{receiptInput,rawInput};
}
function decodeCapture(input,decisionAt){
 const r=verified(input.receiptInput,65536);verified(input.rawInput,4*1024*1024);
 if(r.version!=='steam-live-diagnostic-collector.v1'||r.source!=='steam'||r.endpoint!=='GetLiveLeagueGames/v1'||r.httpStatus!==200||r.status!=='captured_diagnostic'||r.diagnosticOnly!==true||r.servingEnabled!==false||r.trainingEnabled!==false||r.publicPromotion!==false||r.rawSha256!==input.rawInput.pin.sha256)fail('successful_owned_capture_required');
 const received=instantNs(r.receivedAt),persisted=instantNs(r.rawPersistedAt),complete=instantNs(r.completedAt),decision=instantNs(decisionAt);
 if([received,persisted,complete,decision].some(x=>x===null)||received>persisted||persisted>complete||complete>decision)fail('receipt_chronology');
 const capture={endpoint:r.endpoint,httpStatus:200,requestStartedAt:r.requestStartedAt,receivedAt:r.receivedAt,persistedAt:r.rawPersistedAt,authenticatedAttempt:true};
 const normalized=normalizeLocalCapture({...capture,body:Buffer.from(input.rawInput.utf8),rawSha256:r.rawSha256,payloadRef:'journal:'+r.rawSha256});
 if(!['normalized_capture_diagnostic','empty_games_diagnostic'].includes(normalized.status))fail('raw_replay_rejected');
 return{receipt:r,capture,normalized};
}
export function createRetainedFeaturePipeline({db,producer,sourceStore,historyRevisions,historyProfileSha256,materializationGeneration='initial',featureJournal,now=()=>new Date().toISOString(),shouldContinue=()=>true,signal=null,limits={}}={}){
 if(typeof db?.query!=='function'||typeof sourceStore?.put!=='function'||typeof sourceStore?.load!=='function'||typeof historyRevisions?.getOrCreate!=='function'||!isHash(historyProfileSha256)||typeof materializationGeneration!=='string'||!/^[-A-Za-z0-9_.]{1,64}$/.test(materializationGeneration)||typeof featureJournal?.writeSchema!=='function'||typeof featureJournal?.appendTrace!=='function'||typeof now!=='function'||typeof shouldContinue!=='function')fail('owned_ports_required');
 const defaults={maxMaps:8,maxFramesPerMap:512,maxPrefixBytesPerMap:32*1024*1024,maxHistoryMaps:20000,maxNativeHistoryFrames:10000,maxPendingCaptures:4},caps={maxMaps:16,maxFramesPerMap:2048,maxPrefixBytesPerMap:64*1024*1024,maxHistoryMaps:50000,maxNativeHistoryFrames:20000,maxPendingCaptures:16};
 if(!limits||typeof limits!=='object'||Array.isArray(limits)||Object.keys(limits).some(k=>!Object.hasOwn(defaults,k)))fail('limit_keys');const config={...defaults,...limits};for(const[k,v]of Object.entries(config))if(!Number.isSafeInteger(v)||v<1||v>caps[k])fail('limit_bound');
 const consumer=createDiagnosticFeatureConsumer({producer,writeSchema:x=>featureJournal.writeSchema(x),appendTrace:x=>featureJournal.appendTrace(x),shouldContinue,signal,limits:{maxMaps:config.maxMaps}}),maps=new Map(),completed=new Map();let tail=Promise.resolve(),pending=0;
 const continuing=()=>{try{return signal?.aborted!==true&&shouldContinue()===true;}catch{return false;}};
 const status=(state,reason,extra={})=>({contract:RETAINED_PIPELINE_CONTRACT,status:state,reason,...extra,...flags});
 async function execute(input){
  if(!continuing())return status('blocked','manual_stop_or_abort');
  const captureKey=draftHash(input);if(completed.has(captureKey)){const cached=structuredClone(completed.get(captureKey));cached.reusedReceipt=true;cached.results=cached.results.map(r=>({...r,stateAdvanced:false}));return cached;}
  const decisionAt=now();let decoded;try{decoded=decodeCapture(input,decisionAt);}catch{return status('blocked','capture_pin_or_contract');}
  const results=[];
  for(const o of decoded.normalized.observations){
   if(!continuing())return status('blocked','manual_stop_or_abort',{results});
   let slot=maps.get(o.matchId);if(!slot){if(maps.size>=config.maxMaps){results.push(status('blocked','map_bound',{matchId:o.matchId}));continue;}slot={prefix:[],prefixBytes:0,source:null,proof:null,revision:null,lastObservationId:null,blockedReason:null};maps.set(o.matchId,slot);}
   if(slot.blockedReason){results.push(status('blocked',slot.blockedReason,{matchId:o.matchId}));continue;}
   const entry={rawInput:input.rawInput,metadataInput:pinned({contract:DRAFT_METADATA_CONTRACT,matchId:o.matchId,observationId:o.observationId,decisionAt:decoded.receipt.completedAt,capture:decoded.capture},'steam-archive/draft-metadata.json')};
   const bytes=entry.rawInput.pin.bytes+entry.metadataInput.pin.bytes,isNew=slot.lastObservationId!==o.observationId;
   if(isNew&&slot.prefix.length&&instantNs(decoded.receipt.receivedAt)<instantNs(JSON.parse(slot.prefix.at(-1).metadataInput.utf8).capture.receivedAt)){results.push(status('blocked','out_of_order_retained_capture',{matchId:o.matchId}));continue;}
   if(isNew&&(slot.prefix.length>=config.maxFramesPerMap||slot.prefixBytes+bytes>config.maxPrefixBytesPerMap)){results.push(status('blocked','retained_prefix_bound',{matchId:o.matchId}));continue;}
   const proposedPrefix=isNew?[...slot.prefix,entry]:slot.prefix;
   let replay;try{replay=replayPinnedDraftPrefix({matchId:o.matchId,computedAt:decisionAt,draftPrefixInputs:proposedPrefix});}catch{slot.blockedReason='draft_prefix_requires_manual_review';results.push(status('blocked',slot.blockedReason,{matchId:o.matchId}));continue;}
   if(!replay.accepted&&replay.reason!=='complete_draft_not_observed'){slot.blockedReason='draft_identity_requires_manual_review';results.push(status('blocked',slot.blockedReason,{matchId:o.matchId}));continue;}
   if(isNew){slot.prefix=proposedPrefix;slot.prefixBytes+=bytes;slot.lastObservationId=o.observationId;}
   if(!replay.accepted){results.push(status('blocked',replay.reason,{matchId:o.matchId}));continue;}
   const d=replay.state,revision=draftHash({matchId:d.matchId,historyCutoffAt:d.historyCutoffAt,revision:d.revision,validFrom:d.validFrom,validFromObservationId:d.validFromObservationId,identity:d.identity});
   let stopPoint='manual_stop_during_history_materialization';
   try{
    if(slot.revision!==revision){
     const key=draftHash({contract:RETAINED_PIPELINE_CONTRACT,revision,historyProfileSha256,materializationGeneration,maxHistoryMaps:config.maxHistoryMaps,maxNativeHistoryFrames:config.maxNativeHistoryFrames,includePlayerPerformance:true});
     const reference=await historyRevisions.getOrCreate(key,async control=>{
      if(!continuing())throw Error('manual_stop_before_history_read');
      const signals=[signal,control?.signal].filter(Boolean),boundedSignal=signals.length?AbortSignal.any(signals):null;
      const exported=await collectDraftHistorySourceExport(db,{matchId:o.matchId,computedAt:now(),draftPrefixInputs:slot.prefix,maxMaps:config.maxHistoryMaps,maxFrames:config.maxNativeHistoryFrames,includePlayerPerformance:true,signal:boundedSignal,now});
      if(!exported.population.factsUsable)throw Error('history_source_unavailable');
      if(!continuing()||boundedSignal?.aborted)throw Error('manual_stop_after_history_read');
      const stored=await sourceStore.put(exported);if(stored.sourceSnapshotHash!==exported.sourceSnapshotHash)throw Error('history_store_receipt');
      stopPoint='manual_stop_after_source_commit';
      if(!continuing()||boundedSignal?.aborted)throw Error('manual_stop_after_source_commit');
      return{reference:stored.reference,sourceSnapshotHash:stored.sourceSnapshotHash};
     });
     if(!continuing())return status('blocked','manual_stop_after_source_commit',{results});
     const exported=await sourceStore.load(reference.reference,{matchId:o.matchId,decisionAt:now()});
     if(exported.sourceSnapshotHash!==reference.sourceSnapshotHash)throw Error('history_revision_source_binding');
     if(!continuing())return status('blocked','manual_stop_before_history_proof',{results});
     const body=JSON.parse(exported.envelopeInput.utf8),materializedAt=now(),proof=createDynamicHistoryProof({matchId:o.matchId,computedAt:materializedAt,draftPrefixInputs:body.draftPrefixInputs,factsInput:body.factsInput,nativeInput:body.nativeInput});
     slot.source=exported;slot.proof=proof.proof;slot.revision=revision;
    }
    if(!continuing())return status('blocked','manual_stop_before_generation',{results});
    const series=input.seriesByMatch?.[o.matchId]??{};
    results.push(await consumer.consume({mode:'AUTO',matchId:o.matchId,decisionAt:now(),historyProof:slot.proof,sourceExportInput:slot.source.envelopeInput,expectedSourceSnapshotHash:slot.source.sourceSnapshotHash,livePrefixInputs:[entry],...(series.seriesInput?{seriesInput:series.seriesInput,currentMapNumber:series.currentMapNumber}:{})}));
   }catch{if(!continuing())return status('blocked',stopPoint,{results});results.push(status('failed','history_materialization_or_generation',{matchId:o.matchId}));}
  }
  const result=status('processed_diagnostic',null,{requestId:decoded.receipt.requestId,results,sourceRejections:decoded.normalized.rejections.length,recordedInputReceipts:true,materializationBasis:'current_local_reconstruction_not_original_prediction',providerCalls:0});
  if(results.length&&results.every(r=>r.status==='recorded_diagnostic')){completed.set(captureKey,structuredClone(result));while(completed.size>64)completed.delete(completed.keys().next().value);}
  return result;
 }
 return Object.freeze({
  consumeCapture(input){
   if(!continuing())return Promise.resolve(status('blocked','manual_stop_or_abort'));
   if(pending>=config.maxPendingCaptures)return Promise.resolve(status('blocked','pending_capture_bound'));
   // Own bytes/scalars before the first await; do not let host mutation rewrite
   // a queued capture or its series orientation.
   let owned;try{if(!input||Object.keys(input).some(k=>!['receiptInput','rawInput','seriesByMatch'].includes(k)))fail('capture_keys');verified(input.receiptInput,65536);verified(input.rawInput,4*1024*1024);if(input.seriesByMatch!==undefined&&Buffer.byteLength(JSON.stringify(input.seriesByMatch))>4*1024*1024)fail('series_bound');owned=structuredClone(input);}catch{return Promise.resolve(status('blocked','capture_input_bound'));}
   pending++;const promise=tail.catch(()=>{}).then(()=>execute(owned)).catch(()=>status('failed','unexpected_pipeline_failure'));tail=promise;promise.finally(()=>{pending--;});return promise;
  },
  forgetMap(matchId){const slot=maps.get(matchId);if(pending)return{released:false,reason:'pipeline_work_pending'};if(!slot)return{released:false,reason:'map_not_cached'};consumer.forgetMap(matchId);maps.delete(matchId);return{released:true,reason:'explicit_host_release_restart_requires_retained_prefix_replay'};},
  status(){return{contract:RETAINED_PIPELINE_CONTRACT,maps:maps.size,pending,limits:{...config},consumer:consumer.status(),...flags};}
 });
}
