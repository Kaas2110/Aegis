/** Host-only diagnostic admission from original committed collector bytes.
 * This is observed progress, never a provider phase or an event-latency claim.
 * Feed EVERY committed capture, including failures and missing-map captures.
 * Pure replay cannot independently prove that the host enumerated its journal.
 * Tokens/proofs cannot be persisted: restart replays original receipts and raw.
 */
import {instantNs} from './causalTime.mjs';
import {normalizeLocalCapture,canonical,sha,NORMALIZATION_CONTRACT} from './steamLiveAdapter.mjs';
import {readPinnedHistoricalJson} from './historicalAlignment.mjs';
import {classifySteamObservationPhase} from './steamPhasePolicy.mjs';
import {steamObservationIdentity} from './steamObservationIdentity.mjs';
export const ADMISSION_CONTRACT='aegis.steam-observed-progression-admission.v1';
export const ADMISSION_PROFILE='GLG_PROGRESSING_OBSERVED.v1';
export const SOURCE_PROFILE='steam.GetLiveLeagueGames.v1.scoreboard';
export const PROGRESSION_POLICY=Object.freeze({contract:'aegis.steam-progression-policy.v1',maximumReceiptGapSeconds:180,leaseSeconds:180,clockPlausibilitySlackSeconds:30});
const states=new WeakMap(),proofs=new WeakMap(),NS=1000000000n;
const outcomes=['radiant_win','winner','match_outcome','final_score','finished','match_status'];
const flags={eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false,publicPromotion:false};
const hash=x=>sha(canonical(x));
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function freeze(x){if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x);}return x;}
function iso(ns){let seconds=ns/NS,part=ns%NS;if(part<0n){seconds--;part+=NS;}return new Date(Number(seconds)*1000).toISOString().replace('.000Z','.'+String(part).padStart(9,'0')+'Z');}
function decode(entry,decision){
 const receipt=readPinnedHistoricalJson(entry?.receiptInput,{maxBytes:65536}),raw=readPinnedHistoricalJson(entry?.rawInput,{maxBytes:6*1024*1024}),r=receipt.data;
 if(r.version!=='steam-live-diagnostic-collector.v1'||r.source!=='steam'||r.diagnosticOnly!==true||r.servingEnabled!==false||r.trainingEnabled!==false||r.publicPromotion!==false||typeof r.requestId!=='string'||r.requestId.length>128||r.rawSha256!==raw.pin.sha256||r.rawFile!=='raw/'+raw.pin.sha256+'.body'||r.payloadRef!=='journal:'+raw.pin.sha256||r.bodyBytes!==raw.pin.bytes)throw Error('progression_committed_capture_contract');
 const received=instantNs(r.receivedAt),persisted=instantNs(r.rawPersistedAt),complete=instantNs(r.completedAt);
 if([received,persisted,complete].some(x=>x===null)||received>persisted||persisted>complete||complete>decision)throw Error('progression_committed_capture_chronology');
 const capture={endpoint:r.endpoint,httpStatus:r.httpStatus,requestStartedAt:r.requestStartedAt,receivedAt:r.receivedAt,persistedAt:r.rawPersistedAt,authenticatedAttempt:true,body:Buffer.from(entry.rawInput.utf8),rawSha256:raw.pin.sha256,payloadRef:r.payloadRef};
 let normalized=null;try{normalized=normalizeLocalCapture(capture);}catch{}
 return{receipt:receipt.pin,raw:raw.pin,r,received,complete,normalized,rawDocument:raw.data,binding:hash({receipt:receipt.pin,raw:raw.pin,normalizationContract:NORMALIZATION_CONTRACT,admissionContract:ADMISSION_CONTRACT})};
}
/** Consecutive original committed captures, bounded to 2048 frames / 64 MiB.
 * policy is an exact versioned policy, not caller-adjustable relaxed thresholds.
 * A blocked result carries nextPrivateToken: commit that barrier in the host.
 * STOP is passed as stopped:true and clears continuity; it never renews a lease.
 */
export function advanceSteamProgressionAdmission(previousPrivateToken,{retainedPrefixInputs,matchId,decisionAt,policy=PROGRESSION_POLICY,stopped=false}={}){
 const decision=instantNs(decisionAt),old=previousPrivateToken==null?null:states.get(previousPrivateToken);
 const reject=reason=>({contract:ADMISSION_CONTRACT,status:'blocked',reason,privateProof:null,nextPrivateToken:null,provenance:null,expiresAt:null,...flags});
 if(previousPrivateToken!=null&&!old)return reject('owned_progression_state_required');
 if(typeof matchId!=='string'||!/^[1-9]\d{0,19}$/.test(matchId)||decision===null||hash(policy)!==hash(PROGRESSION_POLICY))return reject('progression_policy_map_or_decision');
 if(old&&old.matchId!==matchId)return reject('progression_state_map_mismatch');
 let s=old?{...old}: {matchId,lastReceipt:null,lastBinding:null,last:null,lastProgress:null,maximumClock:null,terminal:false,prefixHash:hash({matchId,policy:PROGRESSION_POLICY}),captures:0};
 let reason='consecutive_positive_progress_required',privateProof=null,provenance=null;
 function finish(){
  const nextPrivateToken=Object.freeze({contract:ADMISSION_CONTRACT+'.state'});states.set(nextPrivateToken,freeze(s));
  return{contract:ADMISSION_CONTRACT,status:privateProof?'admitted_diagnostic':'blocked',reason,privateProof,nextPrivateToken,provenance,expiresAt:provenance?.expiresAt??null,...flags};
 }
 if(stopped){s={...s,last:null,lastProgress:null};reason='manual_stop_or_abort';return finish();}
 if(!Array.isArray(retainedPrefixInputs)||!retainedPrefixInputs.length||retainedPrefixInputs.length>2048)return reject('progression_prefix_bound');
 let bytes=0;
 for(const entry of retainedPrefixInputs){
  privateProof=null;provenance=null;
  for(const p of [entry?.rawInput?.pin,entry?.receiptInput?.pin])if(!Number.isSafeInteger(p?.bytes)||p.bytes<1||(bytes+=p.bytes)>64*1024*1024)return reject('progression_prefix_bytes_bound');
  let d;try{d=decode(entry,decision);}catch(error){s={...s,last:null,lastProgress:null};reason=error.message;continue;}
  if(s.lastReceipt!==null&&d.received<=s.lastReceipt){s={...s,last:null,lastProgress:null};reason='progression_receipt_not_strictly_increasing';continue;}
  const gap=s.lastReceipt===null?null:d.received-s.lastReceipt;
  s={...s,lastReceipt:d.received,lastBinding:d.binding,prefixHash:hash({previous:s.prefixHash,binding:d.binding}),captures:s.captures+1};
  if(s.terminal){reason='progression_terminal_source_closed';continue;}
  if(d.r.endpoint!=='GetLiveLeagueGames/v1'||d.r.httpStatus!==200||d.r.status!=='captured_diagnostic'||!['normalized_capture_diagnostic','empty_games_diagnostic'].includes(d.normalized?.status)||d.normalized.rejections.length){s={...s,last:null,lastProgress:null};reason='progression_complete_glg_capture_required';continue;}
  const rows=d.normalized.observations.filter(o=>o.matchId===matchId);
  if(rows.length!==1){s={...s,last:null,lastProgress:null};reason='progression_map_missing_or_invalid';continue;}
  const o=freeze(rows[0]),phase=classifySteamObservationPhase(o,{decisionAt}),rawGames=d.rawDocument?.result?.games??[],rawGame=rawGames.find(g=>String(g?.match_id)===matchId);
  if(phase.terminal||outcomes.some(k=>Object.hasOwn(rawGame??{},k))){s={...s,last:null,lastProgress:null,terminal:true};reason='progression_terminal_or_completion_indicator';continue;}
  if(phase.classification!=='unclassified_static_draft_only'||!phase.identity.fullHeroDraft||o.dynamic.sourceProfile!==SOURCE_PROFILE){s={...s,last:null,lastProgress:null};reason='progression_absent_phase_coherent_draft_required';continue;}
  const identityHash=steamObservationIdentity(o).key,clock=o.providerGameClockSeconds?.missing===false?o.providerGameClockSeconds.value:null;
  if(identityHash===null||!Number.isFinite(clock)||clock<=0){s={...s,last:null,lastProgress:null};reason='progression_positive_clock_identity_required';continue;}
  if(s.maximumClock!==null&&clock<s.maximumClock){s={...s,last:null,lastProgress:null};reason='progression_game_clock_regression';continue;}
  const current={observation:o,observationHash:hash(o),identityHash,clock,received:d.received,receivedAt:d.r.receivedAt,receipt:d.receipt,raw:d.raw,binding:d.binding};
  const previous=s.last;
  const expired=s.lastProgress!==null&&d.received>s.lastProgress+180n*NS;
  const coherent=previous&&previous.identityHash===identityHash&&gap!==null&&gap<=180n*NS&&!expired;
  if(!coherent){s={...s,last:current,lastProgress:null,maximumClock:clock};reason=expired?'progression_lease_expired_pair_required':previous&&previous.identityHash!==identityHash?'progression_identity_changed':gap!==null&&gap>180n*NS?'progression_receipt_gap_exceeded':'consecutive_positive_progress_required';continue;}
  const deltaClock=clock-previous.clock;
  // Compare the fractional receipt gap directly; never round to milliseconds.
  if(deltaClock>Number(gap)/1e9+30){s={...s,last:null,lastProgress:null};reason='progression_implausible_clock_advance';continue;}
  const lastProgress=deltaClock>0?d.received:s.lastProgress;
  const lastProgressBindings=deltaClock>0?{previous:{raw:previous.raw,receipt:previous.receipt,observationId:previous.observation.observationId,clockSeconds:previous.clock},current:{raw:d.raw,receipt:d.receipt,observationId:o.observationId,clockSeconds:clock}}:s.lastProgressBindings;
  s={...s,last:current,lastProgress,lastProgressBindings,maximumClock:clock};
  if(lastProgress===null){reason='consecutive_positive_progress_required';continue;}
  const expires=lastProgress+180n*NS;
  if(decision>expires){reason='progression_lease_expired';continue;}
  provenance=freeze({contract:ADMISSION_CONTRACT,admissionProfile:ADMISSION_PROFILE,sourceProfile:SOURCE_PROFILE,matchId,observationId:o.observationId,rawSha256:d.raw.sha256,identityHash,receivedAt:d.r.receivedAt,lastProgressAt:iso(lastProgress),expiresAt:iso(expires),providerGameClockSeconds:clock,providerPhaseValue:null,providerPhaseStatus:'absent',prefixHash:s.prefixHash,captureCount:s.captures,normalizationContract:NORMALIZATION_CONTRACT,policy:PROGRESSION_POLICY,bindings:{current:{raw:d.raw,receipt:d.receipt},previous:{raw:previous.raw,receipt:previous.receipt},lastTrueAdvance:lastProgressBindings},sourceAuthenticity:'trusted host committed journal; no provider signature',journalEnumerationCompletenessProven:false,providerEventTimeProven:false});
  privateProof=Object.freeze({contract:ADMISSION_CONTRACT+'.proof',admissionProfile:ADMISSION_PROFILE,bindingHash:hash(provenance)});
  proofs.set(privateProof,freeze({provenance,observation:o,observationHash:current.observationHash,lastReceipt:d.received,complete:d.complete,lastProgress,expires}));reason='consecutive_actual_glg_progress_observed';
 }
 return finish();
}
/** Reads the held immutable raw replay. Optional observation binds every current
 * normalized field too; callers computing features must pass it or use the held
 * observation. Public provenance/bindingHash is diagnostic and conveys no power. */
export function readSteamProgressionProof(privateProof,{matchId,observationId,rawSha256,sourceProfile,decisionAt,identityHash,observation=null}={}){
 const p=object(privateProof)?proofs.get(privateProof):null,decision=instantNs(decisionAt);
 const reject=reason=>({accepted:false,reason,admissionProfile:null,provenance:null,observation:null,...flags});
 if(!p)return reject('owned_progression_proof_required');
 const v=p.provenance;
 if(decision===null||p.lastReceipt>decision||p.complete>decision||p.lastProgress>decision||decision>p.expires)return reject('progression_proof_outside_lease_or_decision');
 if(matchId!==v.matchId||observationId!==v.observationId||rawSha256!==v.rawSha256||sourceProfile!==v.sourceProfile||identityHash!==v.identityHash)return reject('progression_proof_binding_mismatch');
 if(observation!==null&&hash(observation)!==p.observationHash)return reject('progression_normalized_observation_mismatch');
 return{accepted:true,reason:'held_actual_raw_progression_proof',admissionProfile:ADMISSION_PROFILE,bindingHash:privateProof.bindingHash,provenance:v,observation:p.observation,expiresAt:v.expiresAt,...flags};
}
