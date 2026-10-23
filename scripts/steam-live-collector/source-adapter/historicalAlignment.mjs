/** Staged, pure decisions. Never rewrites a raw phase, a cutoff, or an observation.
 * These decisions are prerequisites for offline reconstruction, not dataset/model admission.
 */
import {instantNs} from './causalTime.mjs';
import {createHash} from 'node:crypto';
import {verifyRecordedNormalizedObservation} from './recordedNormalization.mjs';
export const PROFILE='steam.GetLiveLeagueGames.v1.scoreboard';
export const ALIGNMENT_CONTRACT='aegis.native-historical-alignment.v1';
export const MATERIALIZATION_CONTRACT='aegis.historical-feature-materialization.v1';
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const proof=x=>typeof x==='string'&&x.length>0&&x.length<256;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const result=(accepted,reason,details={})=>({accepted,reason,...details,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false});
const validEvidence=e=>obj(e)&&hash(e.sha256)&&proof(e.evidenceRef);
const past=(s,t)=>{const n=instantNs(s);return n!==null&&n<=t;};

/** Finished PRIOR maps only. Outcome/roster values must already have been available
 * at the target's history cutoff. Later annotations may validate alignment, not add values.
 * The reviewed-profile route is explicit opt-in; no real profile review is issued here.
 */
export function nativeHistoricalEligibility({observation:o,priorMap:m,profileReview:r,alignment:a,targetMapId,historyCutoffAt,computedAt}={}){
 const cutoff=instantNs(historyCutoffAt),computed=instantNs(computedAt),at=instantNs(o?.source?.capture?.receivedAt);
 if(cutoff===null||computed===null||computed<cutoff||!id(targetMapId)||!id(m?.matchId)||m.matchId===targetMapId||o?.matchId!==m.matchId)return result(false,'identity_or_cutoff');
 if(o.contract!=='steam-live-scoreboard-candidate.v1'||o.dynamic?.sourceProfile!==PROFILE||o.source?.capture?.endpoint!=='GetLiveLeagueGames/v1'||!hash(o.observationId)||!hash(o.source.capture.rawSha256))return result(false,'recorded_source_unproven');
 if(at===null||at>cutoff||typeof m.radiantWon!=='boolean'||!validEvidence(m)||!past(m.outcomeKnownAt,cutoff)||!past(m.durationKnownAt,cutoff)||!past(m.endedAt,instantNs(m.outcomeKnownAt))||!past(m.endedAt,instantNs(m.durationKnownAt)))return result(false,'prior_values_not_available');
 const clock=o.providerGameClockSeconds;
 if(clock?.missing!==false||clock.sourceField!=='duration'||!finite(clock.value)||clock.value<0||!finite(m.durationSeconds)||m.durationSeconds<=0||clock.value>=m.durationSeconds)return result(false,'clock_outside_interior');
 if(o.source.rawPacket?.scoreboard?.duration!==clock.value)return result(false,'normalized_clock_not_raw_duration');
 const p=o.dynamic.phase,provided=p?.status==='invalid'||p?.rawValue!==null&&p?.rawValue!==undefined;
 if(o.sourceQualityReasons?.includes('outcome_marker_present')||provided&&(p?.missing!==false||p?.value!==5)||p?.value!==null&&p?.value!==undefined&&p.value!==5)return result(false,'explicit_nonlive_or_terminal');
 if(!Array.isArray(m.heroes)||m.heroes.length!==10||!past(m.heroesKnownAt,cutoff)||new Set(m.heroes.map(x=>x.heroId)).size!==10||m.heroes.some(x=>!Number.isInteger(x.heroId)||x.heroId<1||x.heroId>250||!['radiant','dire'].includes(x.side)))return result(false,'prior_roster_unproven');
 const current=[];
 for(const side of ['radiant','dire']){
  const players=o.sides?.[side]?.players;
  if(!Array.isArray(players)||players.length!==5)return result(false,'native_roster_incomplete');
  for(const player of players){const x=player?.identity;
   // The installed normalizer keeps decimal IDs as strings; fixtures may use exact
   // integer hero IDs. Normalize the comparison only, never rewrite the observation.
   const h=typeof x?.heroId==='string'&&/^[1-9]\d{0,2}$/.test(x.heroId)?Number(x.heroId):x?.heroId;
   if(!id(x?.accountId)||!Number.isInteger(h)||h<1||h>250||x.side!==side||!m.heroes.some(hero=>hero.heroId===h&&hero.side===side))return result(false,'native_roster_conflict');
   const expectedTeam=m[side+'TeamId'];
   if(!id(expectedTeam)||x.teamId!==expectedTeam)return result(false,'native_team_conflict');
   current.push({...x,heroId:h});
  }
 }
 if(new Set(current.map(x=>x.accountId)).size!==10||new Set(current.map(x=>x.heroId)).size!==10)return result(false,'native_roster_duplicate');
 if(m.players?.length){
  if(!past(m.playersKnownAt,cutoff))return result(false,'prior_players_not_available');
  for(const x of current){const same=m.players.find(p=>p.accountId===x.accountId),hero=m.players.find(p=>p.heroId===x.heroId);
   if(m.players.length===10&&!same||same&&(same.heroId!==x.heroId||same.side!==x.side)||hero&&(hero.accountId!==x.accountId||hero.side!==x.side))return result(false,'prior_account_conflict');
  }
 }
 if(p?.missing===false&&p.value===5)return result(true,'explicit_in_progress_recorded',{alignmentBasis:'explicit_phase',rawPhaseChanged:false,historyCutoffAt});
 if(p?.status!=='absent'||p.missing!==true||p.value!==null||p.rawValue!==null||clock.value===0)return result(false,'phase_absence_or_positive_clock_unproven');
 if(!obj(r)||r.contract!=='aegis.steam-clock-profile-review.v1'||r.reviewed!==true||r.sourceProfile!==PROFILE||r.clockField!=='scoreboard.duration'||r.clockUnits!=='seconds'||r.phaseAbsenceMeaning!=='omitted_not_nonlive'||!validEvidence(r)||!past(r.reviewedAt,computed))return result(false,'missing_phase_profile_review_required');
 if(!obj(a)||a.contract!==ALIGNMENT_CONTRACT||a.purpose!=='alignment_only'||a.phaseClassification!=='in_progress_reconstructed'||a.matchId!==o.matchId||a.observationId!==o.observationId||a.rawSha256!==o.source.capture.rawSha256||a.sourceProfile!==PROFILE||a.priorFactsSha256!==m.sha256||a.profileReviewSha256!==r.sha256||!validEvidence(a)||!past(a.knownAt,computed))return result(false,'alignment_annotation_required');
 const annotated=instantNs(a.knownAt);
 if(annotated<at||annotated<instantNs(m.outcomeKnownAt)||annotated<instantNs(m.durationKnownAt)||annotated<instantNs(m.heroesKnownAt)||annotated<instantNs(r.reviewedAt)||(m.players?.length&&annotated<instantNs(m.playersKnownAt)))return result(false,'alignment_annotation_before_its_evidence');
 return result(true,'historical_alignment_only',{alignmentBasis:'phase_absent_reviewed_profile',historyCutoffAt,alignmentKnownAt:a.knownAt,rawPhaseChanged:false});
}

/** History may be frozen before start while the target's draft identity becomes known
 * at a later LIVE snapshot. Do not pretend that this was an earlier prematch forecast.
 * A late start annotation is validation-only and cannot authorize newly arrived facts.
 */
export function validateHistoricalMaterialization(c){
 if(!obj(c)||c.contract!==MATERIALIZATION_CONTRACT||c.mode!=='frozen_history_at_recorded_live_snapshot'||!id(c.matchId))return result(false,'materialization_contract');
 const prediction=instantNs(c.predictionAt),cutoff=instantNs(c.historyCutoffAt),computed=instantNs(c.computedAt);
 if(prediction===null||cutoff===null||computed===null||cutoff>prediction||computed<prediction)return result(false,'materialization_times');
 const identity=c.targetIdentity;
 if(!validEvidence(identity)||identity.matchId!==c.matchId||!past(identity.knownAt,prediction))return result(false,'target_identity_not_yet_known');
 const a=c.startAlignment,start=instantNs(a?.startedAt);
 if(!obj(a)||a.contract!=='aegis.map-start-alignment.v1'||a.matchId!==c.matchId||a.purpose!=='validation_only'||a.basis!=='provider_recorded_start'||!validEvidence(a)||!past(a.knownAt,computed)||start===null||start<=cutoff||start>prediction||instantNs(a.knownAt)<start)return result(false,'start_alignment_unproven');
 if(!Array.isArray(c.historyDependencies)||!c.historyDependencies.length||c.historyDependencies.length>100000)return result(false,'history_dependencies_required');
 for(const d of c.historyDependencies){
  if(!id(d?.matchId)||d.matchId===c.matchId||!['outcome','roster','hero_roster','native_frame','static_reference'].includes(d.kind)||!validEvidence(d)||!past(d.knownAt,cutoff))return result(false,'history_dependency_future_or_current');
  if(d.kind==='outcome'&&(!past(d.endedAt,instantNs(d.knownAt))||typeof d.value!=='boolean'))return result(false,'outcome_dependency_unproven');
 }
 const outcomes=new Set(c.historyDependencies.filter(x=>x.kind==='outcome').map(x=>x.matchId));
 if(c.historyDependencies.some(d=>!outcomes.has(d.matchId)))return result(false,'completed_prior_map_proof_required');
 if(!['recorded_input_receipts','database_timestamp_reconstruction'].includes(c.availabilityBasis))return result(false,'availability_basis_required');
 return result(true,'offline_materialization_valid',{predictionAt:c.predictionAt,historyCutoffAt:c.historyCutoffAt,alignmentKnownAt:a.knownAt,computedAt:c.computedAt,availabilityBasis:c.availabilityBasis,startAnnotationIsPredictor:false});
}

/** Boundary for actual evidence bytes. Structural predicates above do not establish
 * that referenced bytes were read. Integrations MUST call the pinned wrappers below.
 * No IO: callers resolve the local evidence paths and pass exact bytes as UTF-8.
 */
export function readPinnedHistoricalJson(input,{maxBytes=64*1024*1024}={}){
 if(!obj(input)||typeof input.utf8!=='string'||!obj(input.pin)||typeof input.pin.path!=='string'||!input.pin.path.length||input.pin.path.length>4096||!hash(input.pin.sha256)||!Number.isSafeInteger(input.pin.bytes)||input.pin.bytes<1||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024)throw Error('historical_evidence_pin_contract');
 const bytes=Buffer.from(input.utf8,'utf8');
 if(bytes.length>maxBytes||bytes.length!==input.pin.bytes||createHash('sha256').update(bytes).digest('hex')!==input.pin.sha256)throw Error('historical_evidence_bytes_mismatch');
 const data=JSON.parse(input.utf8);if(!obj(data))throw Error('historical_evidence_json_object');
 return{data,pin:{path:input.pin.path,bytes:bytes.length,sha256:input.pin.sha256},reference:'sha256:'+input.pin.sha256};
}
const withProof=p=>({...p.data,sha256:p.pin.sha256,evidenceRef:p.reference});

/** Native PRIOR-map reference admission, with byte pins and raw->normalized replay.
 * expectedProfileReviewSha256 comes from reviewed host configuration, NEVER from
 * the candidate artifact itself. No real reviewed profile is issued by this module.
 * Even an accepted result is diagnostic/offline-only, not serving/training approval.
 */
export function evaluatePinnedNativeHistory({observationInput,rawCaptureInput,priorMapInput,profileReviewInput=null,alignmentInput=null,expectedProfileReviewSha256=null,targetMapId,historyCutoffAt,computedAt}={}){
 const o=readPinnedHistoricalJson(observationInput),m=readPinnedHistoricalJson(priorMapInput);
 const raw=readPinnedHistoricalJson(rawCaptureInput,{maxBytes:6*1024*1024});
 const cap=o.data.source?.capture;
 if(!obj(cap)||raw.pin.sha256!==cap.rawSha256)return result(false,'raw_capture_content_pin_mismatch');
 let replay;try{replay=verifyRecordedNormalizedObservation({body:Buffer.from(rawCaptureInput.utf8,'utf8'),endpoint:cap.endpoint,httpStatus:cap.httpStatus,requestStartedAt:cap.requestStartedAt,receivedAt:cap.receivedAt,persistedAt:cap.persistedAt,rawSha256:raw.pin.sha256,payloadRef:'journal:'+raw.pin.sha256,authenticatedAttempt:cap.authenticatedAttempt},o.data);}catch{return result(false,'raw_normalized_evidence_mismatch');}
 let r=null,a=null;
 if(profileReviewInput){r=readPinnedHistoricalJson(profileReviewInput);if(!hash(expectedProfileReviewSha256)||r.pin.sha256!==expectedProfileReviewSha256)return result(false,'profile_review_not_in_expected_policy');}
 if(alignmentInput)a=readPinnedHistoricalJson(alignmentInput);
 const decision=nativeHistoricalEligibility({observation:o.data,priorMap:withProof(m),profileReview:r?withProof(r):null,alignment:a?withProof(a):null,targetMapId,historyCutoffAt,computedAt});
 return{...decision,evidenceBytesVerified:true,normalizationReplayed:true,normalizationEvidence:{recordedNormalizationContract:replay.recordedNormalizationContract,replayNormalizationContract:replay.replayNormalizationContract,legacyCompatibilityApplied:replay.legacyCompatibilityApplied,recordedObjectRewritten:false},bindings:{observation:o.pin,rawCapture:raw.pin,priorMap:m.pin,profileReview:r?.pin??null,alignment:a?.pin??null},rawPhaseChanged:false};
}

/** Construct the validation-only context directly from pinned documents. A caller
 * cannot claim a digest for one document while presenting different metadata fields.
 * Dependency documents carry kind/matchId/knownAt and, for outcomes, endedAt/value.
 */
export function evaluatePinnedHistoricalMaterialization({matchId,predictionAt,historyCutoffAt,computedAt,availabilityBasis,targetIdentityInput,startAlignmentInput,historyDependencyInputs}={}){
 if(!Array.isArray(historyDependencyInputs)||!historyDependencyInputs.length||historyDependencyInputs.length>100000)throw Error('historical_dependency_inputs_bound');
 const identity=readPinnedHistoricalJson(targetIdentityInput),start=readPinnedHistoricalJson(startAlignmentInput);
 let total=identity.pin.bytes+start.pin.bytes;
 const dependencies=historyDependencyInputs.map(input=>{if(!Number.isSafeInteger(input?.pin?.bytes)||(total+=input.pin.bytes)>64*1024*1024)throw Error('historical_dependency_total_bytes_bound');return readPinnedHistoricalJson(input);});
 const context={contract:MATERIALIZATION_CONTRACT,mode:'frozen_history_at_recorded_live_snapshot',matchId,predictionAt,historyCutoffAt,computedAt,availabilityBasis,targetIdentity:withProof(identity),startAlignment:withProof(start),historyDependencies:dependencies.map(withProof)};
 const decision=validateHistoricalMaterialization(context);
 return{...decision,evidenceBytesVerified:true,bindings:{targetIdentity:identity.pin,startAlignment:start.pin,historyDependencies:dependencies.map(x=>x.pin)},startAnnotationIsPredictor:false};
}
