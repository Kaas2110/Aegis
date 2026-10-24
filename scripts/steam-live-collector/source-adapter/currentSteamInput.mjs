/** One current raw/identity/admission verifier for routing and receipt dedupe. */
import {replayPinnedDraftPrefix} from './observedDraftHistory.mjs';
import {readPinnedHistoricalJson} from './historicalAlignment.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {classifySteamObservationPhase,readSteamReceiptFreshness} from './steamPhasePolicy.mjs';
import {readSteamProgressionProof} from './steamProgressionAdmission.mjs';
import {steamObservationIdentity} from './steamObservationIdentity.mjs';
import {instantNs} from './causalTime.mjs';
import {readRetainedReplayFrameProof} from './retainedReplayFrame.mjs';
const fail=x=>{throw Error('unified_features:'+x);};
export function readCurrentSteamInput({prefix,context,matchId,decisionAt,progressionProof=null,retainedReplayProof=null}){
 const replay=replayPinnedDraftPrefix({draftPrefixInputs:prefix,matchId,computedAt:decisionAt});
 if(!replay.accepted)fail('current_observation:'+replay.reason);
 const state=replay.state,expected=context.draftState;
 if(['draftHash','rosterHash','sideIdentityHash'].some(k=>state.identity[k]!==expected.identity[k])||instantNs(state.lastReceivedAt)<instantNs(context.validFrom))fail('current_observation:history_identity_or_validity');
 const bindings=prefix.map(entry=>{
  const raw=readPinnedHistoricalJson(entry.rawInput,{maxBytes:6*1024*1024}),m=readPinnedHistoricalJson(entry.metadataInput,{maxBytes:256*1024}).data;
  return {observationId:m.observationId,rawSha256:raw.pin.sha256,metadataSha256:entry.metadataInput.pin.sha256,receivedAt:m.capture.receivedAt};
 });
 const last=prefix.at(-1),m=JSON.parse(last.metadataInput.utf8),out=normalizeLocalCapture({...m.capture,body:Buffer.from(last.rawInput.utf8),rawSha256:last.rawInput.pin.sha256,payloadRef:'journal:'+last.rawInput.pin.sha256});
 const rows=out.observations.filter(o=>o.matchId===matchId&&o.observationId===m.observationId);
 if(rows.length!==1)fail('current_observation:raw_identity');
 const reconstruction=retainedReplayProof===null?null:readRetainedReplayFrameProof(retainedReplayProof,{rawSha256:last.rawInput.pin.sha256,receivedAt:m.capture.receivedAt,decisionAt});
 const sourceDecisionAt=reconstruction?.sourceDecisionAt??decisionAt;
 let admission=classifySteamObservationPhase(rows[0],{decisionAt:sourceDecisionAt});
 if(admission.dynamicDiagnosticAllowed){const freshness=readSteamReceiptFreshness(rows[0],{decisionAt:sourceDecisionAt});if(!freshness.accepted)fail('current_observation:'+freshness.reason);}
 if(progressionProof!==null){
  const o=rows[0],p=readSteamProgressionProof(progressionProof,{matchId,observationId:o.observationId,rawSha256:o.source.capture.rawSha256,sourceProfile:o.dynamic.sourceProfile,decisionAt:sourceDecisionAt,identityHash:steamObservationIdentity(o).key,observation:o});
  if(!p.accepted)fail('current_observation:'+p.reason);
  if(admission.classification!=='unclassified_static_draft_only')fail('current_observation:progression_requires_actual_absent_phase');
  admission={...admission,classification:'observed_progressing_live',reason:'owned_consecutive_capture_progression',dynamicDiagnosticAllowed:true,staticDraftDiagnosticAllowed:false,cohort:'observed_progressing_live_not_early_postdraft',admissionProfile:p.admissionProfile,progressionBindingHash:p.bindingHash,expiresAt:p.expiresAt,provenance:{...admission.provenance,progression:p.provenance}};
 }
 if(!admission.dynamicDiagnosticAllowed&&!admission.staticDraftDiagnosticAllowed)fail('current_observation:'+admission.reason);
 return {admission,bindings,sourceDecisionAt,reconstruction};
}
