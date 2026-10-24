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
import {createVerifiedHistorySourceHandle} from './historySourceVerifier.mjs';
import {createDiagnosticFeatureConsumer} from './diagnosticFeatureConsumer.mjs';
import {instantNs} from './causalTime.mjs';
import {advanceSteamProgressionAdmission} from './steamProgressionAdmission.mjs';
import {classifySteamObservationPhase} from './steamPhasePolicy.mjs';
import {createRetainedReplayFrameProof} from './retainedReplayFrame.mjs';
import {advanceSteamEligibleState,readSteamEligibleState} from './steamEligibleState.mjs';
export const RETAINED_PIPELINE_CONTRACT='aegis.retained-steam-feature-pipeline.v2';
const sha=x=>createHash('sha256').update(x).digest('hex');
const flags={diagnosticOnly:true,eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
const fail=x=>{throw Error('retained_feature_pipeline:'+x);};
const pinned=(value,path)=>{const utf8=typeof value==='string'?value:JSON.stringify(value);return{utf8,pin:{path,bytes:Buffer.byteLength(utf8),sha256:sha(utf8)}};};
const isHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function verified(input,max,json=true){if(!input||Object.keys(input).sort().join(',')!=='pin,utf8'||typeof input.utf8!=='string'||!input.pin||Object.keys(input.pin).sort().join(',')!=='bytes,path,sha256'||typeof input.pin.path!=='string'||input.pin.path.length>1024||input.pin.bytes!==Buffer.byteLength(input.utf8)||input.pin.bytes>max||!isHash(input.pin.sha256)||sha(input.utf8)!==input.pin.sha256)fail('input_pin_or_bound');return json?JSON.parse(input.utf8):input.utf8;}
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
export function createRetainedFeaturePipeline({db,producer,sourceStore,historyRevisions,historyProfileSha256,materializationGeneration='initial',featureJournal,now=()=>new Date().toISOString(),shouldContinue=()=>true,signal=null,limits={},historySourceFactory=null,resourceArena=null}={}){
 if((historySourceFactory===null?typeof db?.query!=='function':typeof historySourceFactory!=='function')||typeof sourceStore?.put!=='function'||typeof sourceStore?.load!=='function'||typeof historyRevisions?.getOrCreate!=='function'||!isHash(historyProfileSha256)||typeof materializationGeneration!=='string'||!/^[-A-Za-z0-9_.]{1,64}$/.test(materializationGeneration)||typeof featureJournal?.writeSchema!=='function'||typeof featureJournal?.appendTrace!=='function'||typeof now!=='function'||typeof shouldContinue!=='function')fail('owned_ports_required');
 const defaults={maxMaps:8,maxFramesPerMap:512,maxPrefixBytesPerMap:32*1024*1024,maxHistoryMaps:20000,maxNativeHistoryFrames:10000,maxPendingCaptures:4},caps={maxMaps:16,maxFramesPerMap:2048,maxPrefixBytesPerMap:64*1024*1024,maxHistoryMaps:50000,maxNativeHistoryFrames:20000,maxPendingCaptures:16};
 if(!limits||typeof limits!=='object'||Array.isArray(limits)||Object.keys(limits).some(k=>!Object.hasOwn(defaults,k)))fail('limit_keys');const config={...defaults,...limits};for(const[k,v]of Object.entries(config))if(!Number.isSafeInteger(v)||v<1||v>caps[k])fail('limit_bound');
 const consumer=createDiagnosticFeatureConsumer({producer,writeSchema:x=>featureJournal.writeSchema(x),appendTrace:x=>featureJournal.appendTrace(x),loadCommittedTrace:typeof featureJournal.loadTrace==='function'?x=>featureJournal.loadTrace(x):null,shouldContinue:()=>continuing(),signal,now,resourceArena,limits:{maxMaps:config.maxMaps}}),maps=new Map(),completed=new Map();let tail=Promise.resolve(),pending=0,stopObserved=false;
 function continuing(){let yes=false;try{yes=signal?.aborted!==true&&shouldContinue()===true;}catch{}
  if(!yes&&!stopObserved){stopObserved=true;for(const[matchId,slot]of maps){const r=advanceSteamProgressionAdmission(slot.progressionToken,{matchId,decisionAt:now(),stopped:true});slot.progressionToken=r.nextPrivateToken;slot.progressionInputKey=null;slot.progressionResult=null;interruptEligibility(slot,matchId,'manual_stop');resetFeatureContinuity(matchId);}}
  if(yes)stopObserved=false;return yes;
 }
 const status=(state,reason,extra={})=>({contract:RETAINED_PIPELINE_CONTRACT,status:state,reason,...extra,...flags});
 function interruptEligibility(slot,matchId,barrier='source_gap',decisionAt=slot.eligibilityDecisionAt??now()){
  if(slot.eligibilityDecisionAt!==undefined&&instantNs(decisionAt)<instantNs(slot.eligibilityDecisionAt))return;
  const r=advanceSteamEligibleState(slot.eligibleStateToken,{matchId,decisionAt,barrier});
  slot.eligibleStateToken=r.nextPrivateToken;slot.eligibility=r;slot.eligibilityDecisionAt=decisionAt;
 }
 function resetFeatureContinuity(matchId){
  consumer.invalidateSourceContinuity(matchId);
  for(const[key,r]of completed)if(r.results.some(x=>x.matchId===matchId))completed.delete(key);
 }
 function progressionFor(slot,input,matchId,decisionAt){
  const key=draftHash({raw:input.rawInput.pin.sha256,receipt:input.receiptInput.pin.sha256});
  if(slot.progressionInputKey===key)return slot.progressionResult;
  let received=null;try{received=instantNs(JSON.parse(input.receiptInput.utf8).receivedAt);}catch{}
  if(received!==null&&slot.lastCaptureReceivedAt!==null&&received<instantNs(slot.lastCaptureReceivedAt))return{privateProof:null,reason:'older_retained_capture_does_not_advance_source_state'};
  const result=advanceSteamProgressionAdmission(slot.progressionToken,{retainedPrefixInputs:[input],matchId,decisionAt});
  slot.progressionToken=result.nextPrivateToken;slot.progressionInputKey=key;slot.progressionResult=result;
  if(received!==null)slot.lastCaptureReceivedAt=JSON.parse(input.receiptInput.utf8).receivedAt;
  return result;
 }
 async function execute(input,{replayOnly=false,restoreTracesByMap={}}){
  if(!continuing())return status('blocked','manual_stop_or_abort');
  const captureKey=draftHash({input,replayOnly,restoreTracesByMap});if(completed.has(captureKey)){const cached=structuredClone(completed.get(captureKey));cached.reusedReceipt=true;cached.results=cached.results.map(r=>({...r,stateAdvanced:false}));return cached;}
  const decisionAt=now();let decoded;try{decoded=decodeCapture(input,decisionAt);}catch{
   // Invalid/failed committed captures break progression for every tracked map.
   const r=JSON.parse(input.receiptInput.utf8),at=instantNs(r?.completedAt)!==null&&instantNs(r?.completedAt)<=instantNs(decisionAt)?r.completedAt:decisionAt;
   for(const[matchId,slot]of maps){
    if(slot.lastCaptureReceivedAt!==null&&instantNs(r?.receivedAt)!==null&&instantNs(r.receivedAt)<instantNs(slot.lastCaptureReceivedAt))continue;
    progressionFor(slot,input,matchId,at);interruptEligibility(slot,matchId,'source_gap',at);resetFeatureContinuity(matchId);
   }
   return status('blocked','capture_pin_or_contract');
  }
  const present=new Set(decoded.normalized.observations.map(o=>o.matchId));
  if(Object.keys(restoreTracesByMap).some(id=>!present.has(id)))return status('blocked','restore_map_missing_from_capture');
  const sourceDecisionAt=decoded.receipt.completedAt,retainedReplayProof=createRetainedReplayFrameProof({...input,reconstructedAt:decisionAt});
  for(const[matchId,slot]of maps)if(!present.has(matchId)){
   if(slot.lastCaptureReceivedAt!==null&&instantNs(decoded.receipt.receivedAt)<instantNs(slot.lastCaptureReceivedAt))continue;
   progressionFor(slot,input,matchId,sourceDecisionAt);interruptEligibility(slot,matchId,'source_gap',sourceDecisionAt);resetFeatureContinuity(matchId);
  }

  const results=[];
  for(const o of decoded.normalized.observations){
   if(!continuing())return status('blocked','manual_stop_or_abort',{results});
   let slot=maps.get(o.matchId);if(!slot){if(maps.size>=config.maxMaps){results.push(status('blocked','map_bound',{matchId:o.matchId}));continue;}slot={prefix:[],prefixBytes:0,source:null,proof:null,revision:null,lastObservationId:null,blockedReason:null,closedSource:null,progressionToken:null,progressionInputKey:null,progressionResult:null,lastCaptureReceivedAt:null,anchors:null,draftRevision:null,captureCount:0,eligibleStateToken:null,eligibility:null,lastLiveTraceSha256:null,lastLiveObservationId:null};maps.set(o.matchId,slot);}
   // Reject out-of-order delivery before touching either private authority.
   // In particular, a rejected earlier decision must not replace a valid token
   // with the null token returned for invalid caller chronology.
   if(slot.lastCaptureReceivedAt!==null&&instantNs(decoded.receipt.receivedAt)<instantNs(slot.lastCaptureReceivedAt)){
    results.push(status('blocked','out_of_order_retained_capture',{matchId:o.matchId}));continue;
   }
   const progression=progressionFor(slot,input,o.matchId,sourceDecisionAt);slot.captureCount++;
   const admission=classifySteamObservationPhase(o,{decisionAt});
   // Static draft packets are not live-state failures. Start the independent
   // eligibility observer only when live is qualified or a live state existed.
   const observeLiveState=admission.dynamicDiagnosticAllowed||admission.terminal||slot.eligibleStateToken!==null||progression.privateProof!=null;
   const eligibility=observeLiveState?advanceSteamEligibleState(slot.eligibleStateToken,{matchId:o.matchId,decisionAt:sourceDecisionAt,retainedEntry:input,progressionProof:progression.privateProof}):{nextPrivateToken:null,mayGenerateNewVector:false,eligibleForRetainingForecast:false,resetDynamicWindows:false};
   slot.eligibleStateToken=eligibility.nextPrivateToken;slot.eligibility=eligibility;slot.eligibilityDecisionAt=sourceDecisionAt;
   if(eligibility.resetDynamicWindows)resetFeatureContinuity(o.matchId);
   if(slot.blockedReason){results.push(status('blocked',slot.blockedReason,{matchId:o.matchId}));continue;}
   if(slot.closedSource){results.push(status('source_closed','terminal_source_closed',{matchId:o.matchId,terminalSource:{...slot.closedSource}}));continue;}
   const entry={rawInput:input.rawInput,metadataInput:pinned({contract:DRAFT_METADATA_CONTRACT,matchId:o.matchId,observationId:o.observationId,decisionAt:decoded.receipt.completedAt,capture:decoded.capture},'steam-archive/draft-metadata.json')};
   const bytes=entry.rawInput.pin.bytes+entry.metadataInput.pin.bytes,isNew=slot.lastObservationId!==o.observationId;
   if(isNew&&slot.prefix.length&&instantNs(decoded.receipt.receivedAt)<instantNs(JSON.parse(slot.prefix.at(-1).metadataInput.utf8).capture.receivedAt)){results.push(status('blocked','out_of_order_retained_capture',{matchId:o.matchId}));continue;}
   if(admission.terminal){
    resetFeatureContinuity(o.matchId);
    // A source closure is not a winner label or an identity contradiction. It
    // cannot reopen from a later live packet without explicit host release.
    slot.closedSource={classification:admission.classification,observationId:o.observationId,receivedAt:o.source.capture.receivedAt};
    results.push(status('source_closed','terminal_source_closed',{matchId:o.matchId,terminalSource:{...slot.closedSource}}));continue;
   }
   if(!admission.dynamicDiagnosticAllowed&&!admission.staticDraftDiagnosticAllowed&&admission.reason!=='complete_coherent_draft_required'){
    // A rejected frame never joins the accepted history prefix or poisons the
    // map's identity checkpoint. An initial incomplete draft still replays below.
    resetFeatureContinuity(o.matchId);results.push(status('blocked','current_source_rejected:'+admission.reason,{matchId:o.matchId}));continue;
   }
   // Repeated unconfirmed state is not another newly observed situation. Keep
   // its original state/trace reference; reader-time expiry never uses NOW as
   // a replacement receipt. Restoration replays the original source evidence.
   const isLiveCandidate=admission.dynamicDiagnosticAllowed||progression.privateProof!==null&&progression.privateProof!==undefined||slot.lastLiveTraceSha256!==undefined&&slot.lastLiveTraceSha256!==null;
   const restoring=restoreTracesByMap[o.matchId]!==undefined;
   const retryQualified=eligibility.eligibleForRetainingForecast===true&&eligibility.stateView?.observationId===o.observationId&&slot.lastLiveObservationId!==o.observationId;
   if(isLiveCandidate&&!eligibility.mayGenerateNewVector&&!retryQualified&&!restoring&&!replayOnly){
    results.push(status('retained_state_diagnostic',eligibility.reason??'unchanged_unconfirmed_source_state',{matchId:o.matchId,traceSha256:slot.lastLiveTraceSha256??null,sourceState:readSteamEligibleState(slot.eligibleStateToken,{matchId:o.matchId,decisionAt:now()}),recordedPrediction:false}));continue;
   }
   const basePrefix=slot.anchors??slot.prefix,baseBytes=basePrefix.reduce((n,e)=>n+e.rawInput.pin.bytes+e.metadataInput.pin.bytes,0);
   if(isNew&&(basePrefix.length+1>config.maxFramesPerMap||baseBytes+bytes>config.maxPrefixBytesPerMap)){results.push(status('blocked','retained_prefix_bound',{matchId:o.matchId}));continue;}
   const proposedPrefix=isNew?[...basePrefix,entry]:slot.prefix;
   let replay;try{replay=replayPinnedDraftPrefix({matchId:o.matchId,computedAt:decisionAt,draftPrefixInputs:proposedPrefix});}catch{resetFeatureContinuity(o.matchId);slot.blockedReason='draft_prefix_requires_manual_review';results.push(status('blocked',slot.blockedReason,{matchId:o.matchId}));continue;}
   if(!replay.accepted&&['draft_terminal_or_invalid_phase','ten_confirmed_heroes_and_sides_required'].includes(replay.reason)){
    resetFeatureContinuity(o.matchId);results.push(status('blocked','current_source_rejected:'+replay.reason,{matchId:o.matchId}));continue;
   }
   if(!replay.accepted&&replay.reason!=='complete_draft_not_observed'){resetFeatureContinuity(o.matchId);slot.blockedReason='draft_identity_requires_manual_review';results.push(status('blocked',slot.blockedReason,{matchId:o.matchId}));continue;}
   if(isNew){slot.prefix=proposedPrefix;slot.prefixBytes+=bytes;slot.lastObservationId=o.observationId;}
   if(!replay.accepted){results.push(status('blocked',replay.reason,{matchId:o.matchId}));continue;}
   const d=replay.state;
   // Preserve only the original complete draft and monotone identity changes.
   // Dynamic trajectories live in their own bounded630s states, not this prefix.
   if(slot.anchors===null){const first=slot.prefix.find(e=>JSON.parse(e.metadataInput.utf8).observationId===d.firstCompleteObservationId);if(!first)throw Error('first_draft_anchor_missing');slot.anchors=[first];}
   else if(slot.draftRevision!==null&&d.revision>slot.draftRevision)slot.anchors.push(entry);
   slot.draftRevision=d.revision;
   slot.prefix=slot.anchors.at(-1).metadataInput.pin.sha256===entry.metadataInput.pin.sha256?[...slot.anchors]:[...slot.anchors,entry];
   slot.prefixBytes=slot.prefix.reduce((n,e)=>n+e.rawInput.pin.bytes+e.metadataInput.pin.bytes,0);
   const restoreTraceSha256=restoreTracesByMap[o.matchId]??null;
   if(replayOnly&&restoreTraceSha256===null){results.push(status('replayed_source_only',null,{matchId:o.matchId}));continue;}
   const revision=draftHash({matchId:d.matchId,historyCutoffAt:d.historyCutoffAt,revision:d.revision,validFrom:d.validFrom,validFromObservationId:d.validFromObservationId,identity:d.identity});
   let stopPoint='manual_stop_during_history_materialization';
   try{
    if(slot.revision!==revision){
     const key=draftHash({contract:RETAINED_PIPELINE_CONTRACT,revision,historyProfileSha256,materializationGeneration,maxHistoryMaps:config.maxHistoryMaps,maxNativeHistoryFrames:config.maxNativeHistoryFrames,includePlayerPerformance:true});
     const reference=await historyRevisions.getOrCreate(key,async control=>{
      if(!continuing())throw Error('manual_stop_before_history_read');
      const signals=[signal,control?.signal].filter(Boolean),boundedSignal=signals.length?AbortSignal.any(signals):null;
      const options={matchId:o.matchId,computedAt:now(),draftPrefixInputs:slot.prefix,maxMaps:config.maxHistoryMaps,maxFrames:config.maxNativeHistoryFrames,includePlayerPerformance:true,signal:boundedSignal,now};
      const exported=historySourceFactory?await historySourceFactory(options):await collectDraftHistorySourceExport(db,options);
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
     const body=JSON.parse(exported.envelopeInput.utf8),materializedAt=now(),proof=createDynamicHistoryProof({matchId:o.matchId,computedAt:materializedAt,draftPrefixInputs:body.draftPrefixInputs,factsInput:body.factsInput,nativeInput:body.nativeInput,...(body.contract==='aegis.immutable-retained-history-source-export.v1'?{availabilityBasis:'retained_receipt_reconstruction'}:{})},{includeInspectionCopies:false});
     // Original source replay is revision-scoped. Keep only the compact private
     // handle after proof construction; queued consumers retain their own token.
     const sourceHandle=createVerifiedHistorySourceHandle(exported.envelopeInput,{expectedSourceSnapshotHash:exported.sourceSnapshotHash,matchId:o.matchId,decisionAt:materializedAt});
     slot.source={sourceSnapshotHash:exported.sourceSnapshotHash};slot.sourceHandle=sourceHandle;slot.proof=proof.proof;slot.revision=revision;
    }
    if(!continuing())return status('blocked','manual_stop_before_generation',{results});
    const series=input.seriesByMatch?.[o.matchId]??{};
    const consumed=await consumer.consume({mode:'AUTO',matchId:o.matchId,decisionAt:now(),historyProof:slot.proof,sourceExportHandle:slot.sourceHandle,expectedSourceSnapshotHash:slot.source.sourceSnapshotHash,livePrefixInputs:[entry],progressionProof:progression.privateProof,retainedReplayProof,...(series.seriesInput?{seriesInput:series.seriesInput,currentMapNumber:series.currentMapNumber}:{})},{restoreTraceSha256});
    if(consumed.traceCommitted&&consumed.stateAdvanced&&consumed.mode==='LIVE'){slot.lastLiveTraceSha256=consumed.traceSha256;slot.lastLiveObservationId=o.observationId;}
    results.push(consumed);
   }catch{if(!continuing())return status('blocked',stopPoint,{results});results.push(status('failed','history_materialization_or_generation',{matchId:o.matchId}));}
  }
  const result=status('processed_diagnostic',null,{requestId:decoded.receipt.requestId,results,sourceRejections:decoded.normalized.rejections.length,recordedInputReceipts:true,materializationBasis:historySourceFactory?'retained_source_versions_reconstructed_not_original_prediction':'current_local_reconstruction_not_original_prediction',providerCalls:0});
  if(results.length&&results.every(r=>r.status==='recorded_diagnostic')){completed.set(captureKey,structuredClone(result));while(completed.size>64)completed.delete(completed.keys().next().value);}
  return result;
 }
 return Object.freeze({
  breakSourceContinuity(){if(pending)return{cleared:false,reason:'pipeline_work_pending'};for(const[matchId,slot]of maps){const r=advanceSteamProgressionAdmission(slot.progressionToken,{matchId,decisionAt:now(),stopped:true});slot.progressionToken=r.nextPrivateToken;slot.progressionInputKey=null;slot.progressionResult=null;interruptEligibility(slot,matchId);resetFeatureContinuity(matchId);}return{cleared:true,reason:'owned_restart_or_stop_barrier; map_watermarks_preserved'};},
  readLiveEligibility({matchId,decisionAt=now()}={}){
   const slot=maps.get(matchId);if(!continuing())return{eligibleForRetainingForecast:false,mayGenerateNewVector:false,reason:'manual_stop_or_abort',userMessage:'Прогноз недоступен'};
   const view=readSteamEligibleState(slot?.eligibleStateToken,{matchId,decisionAt});
   return{...view,lastTraceSha256:slot?.lastLiveTraceSha256??null,recordedPrediction:false};
  },
  consumeCapture(input,options={}){
   if(!continuing())return Promise.resolve(status('blocked','manual_stop_or_abort'));
   if(pending>=config.maxPendingCaptures)return Promise.resolve(status('blocked','pending_capture_bound'));
   // Own bytes/scalars before the first await; do not let host mutation rewrite
   // a queued capture or its series orientation.
   let owned,ownedOptions;try{if(!input||Object.keys(input).some(k=>!['receiptInput','rawInput','seriesByMatch'].includes(k)))fail('capture_keys');verified(input.receiptInput,65536);verified(input.rawInput,4*1024*1024,false);if(input.seriesByMatch!==undefined&&Buffer.byteLength(JSON.stringify(input.seriesByMatch))>4*1024*1024)fail('series_bound');if(!options||Object.keys(options).some(k=>!['replayOnly','restoreTracesByMap'].includes(k))||options.replayOnly!==undefined&&typeof options.replayOnly!=='boolean'||options.restoreTracesByMap!==undefined&&(!options.restoreTracesByMap||Array.isArray(options.restoreTracesByMap)||Object.keys(options.restoreTracesByMap).length>config.maxMaps||Object.entries(options.restoreTracesByMap).some(([id,hash])=>!/^\d{1,20}$/.test(id)||!isHash(hash))))fail('replay_options');owned=structuredClone(input);ownedOptions=structuredClone(options);}catch{return Promise.resolve(status('blocked','capture_input_bound'));}
   pending++;const promise=tail.catch(()=>{}).then(()=>execute(owned,ownedOptions)).catch(()=>status('failed','unexpected_pipeline_failure'));tail=promise;promise.finally(()=>{pending--;});return promise;
  },
  forgetMap(matchId){const slot=maps.get(matchId);if(pending)return{released:false,reason:'pipeline_work_pending'};if(!slot)return{released:false,reason:'map_not_cached'};consumer.forgetMap(matchId);maps.delete(matchId);for(const[key,r]of completed)if(r.results.some(x=>x.matchId===matchId))completed.delete(key);return{released:true,reason:'explicit_host_release_restart_requires_retained_prefix_replay'};},
  status(){return{contract:RETAINED_PIPELINE_CONTRACT,maps:maps.size,pending,limits:{...config},consumer:consumer.status(),tracked:[...maps].map(([matchId,s])=>({matchId,captureCount:s.captureCount,retainedDraftFrames:s.prefix.length,retainedDraftBytes:s.prefixBytes,identityAnchors:s.anchors?.length??0,terminalSourceClosed:s.closedSource!==null})),...flags};}
 });
}
