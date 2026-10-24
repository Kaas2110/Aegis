/** Immutable bridge: retained OpenDota bytes -> frozen draft history -> shared
 * producer source envelope. Local corpus coverage is explicit; no SQL read,
 * invented prior Steam observations or provider/serving/training admission. */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {draftHash} from './observedDraft.mjs';
import {replayPinnedDraftPrefix} from './observedDraftHistory.mjs';
import {exportHistoricalFactsFromVersions,verifyHistoricalFactVersion,pinRetainedHistoryJson} from './retainedOpenDotaFacts.mjs';
export const RETAINED_HISTORY_SOURCE_EXPORT_CONTRACT='aegis.immutable-retained-history-source-export.v1';
const REFERENCE='aegis.history-source-export-reference.v1',MAX_BYTES=64*1024*1024;
const flags={eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const account=x=>id(x)&&BigInt(x)<4294967295n;
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=reason=>{throw Error('retained_history_source:'+reason);};
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const sorted=xs=>[...new Set(xs)].sort((a,b)=>String(a).localeCompare(String(b),'en'));
function identityOf(state){
 const p=state.identity.players,selectors={sourceUniverse:'locally_retained_opendota_responses',selection:'provided_version_inputs_only',targetTeamIds:sorted(p.map(x=>x.teamId).filter(id)),targetAccountIds:sorted(p.map(x=>x.accountId).filter(account)),targetHeroIds:[...new Set(p.map(x=>Number(x.heroId)))].sort((a,b)=>a-b)};
 const revisionBody={contract:state.contract,matchId:state.matchId,historyCutoffAt:state.historyCutoffAt,firstCompleteObservationId:state.firstCompleteObservationId,revision:state.revision,validFromObservationId:state.validFromObservationId,validFrom:state.validFrom,identity:state.identity};
 return{matchId:state.matchId,sourceProfile:state.sourceProfile,cutoffPolicy:state.cutoffPolicy,historyCutoffAt:state.historyCutoffAt,validFrom:state.validFrom,validFromObservationId:state.validFromObservationId,revision:state.revision,draftRevisionHash:draftHash(revisionBody),draftHash:state.identity.draftHash,rosterHash:state.identity.rosterHash,sideIdentityHash:state.identity.sideIdentityHash,selectors,selectorsSha256:draftHash(selectors)};
}
function readEnvelope(input){
 const bytes=typeof input?.utf8==='string'?Buffer.byteLength(input.utf8):0;
 if(bytes<1||bytes>MAX_BYTES||input?.pin?.bytes!==bytes||!hash(input?.pin?.sha256)||sha(input.utf8)!==input.pin.sha256)fail('envelope_bytes_or_bound');
 let body;try{body=JSON.parse(input.utf8);}catch{fail('envelope_json');}return body;
}
/** exportedAt is required: the pure builder cannot know when an actual host
 * completed/persisted calculation, and never invents that clock from receipt. */
export function createRetainedHistorySourceExport({draftPrefixInputs,matchId,computedAt,exportedAt,versionInputs,scope=null}={}){
 const computed=instantNs(computedAt),exported=instantNs(exportedAt);if(computed===null||exported===null||computed>exported)fail('materialization_times');
 const draft=replayPinnedDraftPrefix({draftPrefixInputs,matchId,computedAt});if(!draft.accepted)fail('draft_not_accepted:'+draft.reason);
 const identity=identityOf(draft.state),initial=exportHistoricalFactsFromVersions({versionInputs,targetMapId:matchId,historyCutoffAt:identity.historyCutoffAt,scope});
 // Retain all selected-field, contradiction and identity-continuity evidence.
 // Irrelevant future appends cannot change a frozen source/context identity.
 const required=new Set(initial.bindings.sourceVersions.map(v=>v.versionSha256)),versions=new Map();
 for(const input of versionInputs){const checked=verifyHistoricalFactVersion(input);if(required.has(checked.versionSha256))versions.set(checked.versionSha256,checked.versionInput);}
 const retainedVersionInputs=[...versions.entries()].sort(([a],[b])=>a.localeCompare(b,'en')).map(([,v])=>v);
 const facts=exportHistoricalFactsFromVersions({versionInputs:retainedVersionInputs,targetMapId:matchId,historyCutoffAt:identity.historyCutoffAt,scope});
 if(facts.factsInput.utf8!==initial.factsInput.utf8)fail('selected_evidence_not_self_contained');
 for(const binding of facts.bindings.sourceVersions)if(binding.source.payloadPersistedAt!==null&&instantNs(binding.source.payloadPersistedAt)>exported)fail('source_persisted_after_export');
 const nativeInput=pinRetainedHistoryJson({contract:'aegis.pinned-native-economy-observations.v1',observations:[]},'retained-history/no-native-observations.json');
 const rowCount=JSON.parse(facts.factsInput.utf8).maps.length,population={facts:rowCount?'complete_nonempty_within_provided_retained_corpus':'complete_empty_within_provided_retained_corpus',native:'not_provided',factsUsable:true,nativeCandidatesPinned:false,allCollectionsComplete:false,zeroHistoryStatisticsInvented:false,globalPopulationComplete:false};
 const body={contract:RETAINED_HISTORY_SOURCE_EXPORT_CONTRACT,identity,computedAt,exportedAt,draftPrefixInputs:structuredClone(draftPrefixInputs),versionInputs:retainedVersionInputs,scope,factsInput:facts.factsInput,nativeInput,readReceiptInput:null,population,sourceVersionSetSha256:facts.bindings.sourceVersionSetSha256,sourceBindings:facts.bindings,evidencePolicy:{contentAddress:'sha256_of_actual_envelope_utf8',completenessBasis:'all_provided_retained_versions_replayed_within_local_corpus',sourceAuthenticity:'local_collector_receipt_assertion_not_provider_signature',availabilityBasis:'retained_collector_response_receipt',originalHistoricalAvailabilityProven:false,independentFieldAvailabilityAttested:false,mutableDatabaseSnapshot:false,priorNativeRawAdmissionPerformed:false},...flags};
 const envelopeInput=pinRetainedHistoryJson(body,'retained-history/source-export.json');if(envelopeInput.pin.bytes>MAX_BYTES)fail('envelope_bytes_or_bound');
 return freeze({contract:RETAINED_HISTORY_SOURCE_EXPORT_CONTRACT,envelopeInput,sourceSnapshotHash:envelopeInput.pin.sha256,identity,population,reference:{contract:REFERENCE,sha256:envelopeInput.pin.sha256,bytes:envelopeInput.pin.bytes},inputAudit:initial.audit,...flags});
}
export const encodeRetainedHistorySourceExport=createRetainedHistorySourceExport;
export function verifyRetainedHistorySourceExport(envelopeInput,{expectedSourceSnapshotHash=null,matchId=null,decisionAt=null,readMode='recorded'}={}){
 if(!['recorded','reconstructed'].includes(readMode)||expectedSourceSnapshotHash!==null&&!hash(expectedSourceSnapshotHash))fail('reader_contract');
 const body=readEnvelope(envelopeInput);if(body?.contract!==RETAINED_HISTORY_SOURCE_EXPORT_CONTRACT||expectedSourceSnapshotHash!==null&&expectedSourceSnapshotHash!==envelopeInput.pin.sha256||matchId!==null&&matchId!==body.identity?.matchId)fail('reader_hash_or_match');
 const rebuilt=createRetainedHistorySourceExport({draftPrefixInputs:body.draftPrefixInputs,matchId:body.identity?.matchId,computedAt:body.computedAt,exportedAt:body.exportedAt,versionInputs:body.versionInputs,scope:body.scope});
 if(rebuilt.envelopeInput.utf8!==envelopeInput.utf8)fail('derived_or_source_tamper');
 if(decisionAt!==null){const decision=instantNs(decisionAt);if(decision===null||decision<instantNs(rebuilt.identity.validFrom)||readMode==='recorded'&&decision<instantNs(body.exportedAt))fail('not_available_at_decision');}
 return rebuilt;
}
