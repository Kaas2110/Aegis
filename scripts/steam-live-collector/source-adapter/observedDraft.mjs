/** Pure diagnostic draft trigger. It never assigns game phase or invents economy. */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
export const DRAFT_CONTRACT='aegis.observed-draft.v1';
export const FREEZE_POLICY='first_complete_draft_receipt';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>JSON.stringify(Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])):x);
export const draftHash=x=>createHash('sha256').update(canonical(x)).digest('hex');
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const account=x=>x===null||id(x)&&BigInt(x)<4294967295n;
const PROFILE='steam.GetLiveLeagueGames.v1.scoreboard';
const captureProofs=new WeakMap();
/** Verify retained raw bytes once per capture. The opaque in-memory token cannot
 * be deserialized as a trusted proof; replay/restart must verify the bytes again.
 */
export function createDraftCaptureProof(captureInput){
 const replay=normalizeLocalCapture(captureInput);
 if(replay.status!=='normalized_capture_diagnostic')throw Error('draft_raw_capture_not_normalized');
 const token=Object.freeze({contract:'aegis.verified-draft-capture.v1',rawSha256:replay.capture.rawSha256});
 captureProofs.set(token,new Map(replay.observations.map(o=>[o.observationId,o])));
 return token;
}
const reject=(reason,state)=>({status:'blocked',reason,state,draft:null,eligibleForServing:false,eligibleForTraining:false});

function identity(o){
 const players=[],sides=[];
 const raw=o.source?.rawPacket;
 if(String(raw?.match_id)!==o.matchId)return null;
 for(const side of ['radiant','dire']){
  const team=o.sides?.[side]?.teamId??null,rows=o.sides?.[side]?.players;
  const rawTeam=raw[side+'_team']?.team_id,expectedTeam=rawTeam===undefined||rawTeam===null||String(rawTeam)==='0'?null:String(rawTeam);
  const rawPlayers=raw.scoreboard?.[side]?.players;
  if(team!==expectedTeam||!Array.isArray(rawPlayers)||rawPlayers.length!==5)return null;
  if(team!==null&&!id(team)||!Array.isArray(rows)||rows.length!==5)return null;
  sides.push({side,teamId:team});
  for(const p of rows){
   const x=p?.identity,h=Number(x?.heroId);
   if(!object(x)||x.side!==side||!Number.isSafeInteger(h)||h<1||h>250||!account(x.accountId)||x.teamId!==team)return null;
   const rawPlayer=rawPlayers.find(p=>Number(p.hero_id)===h);
   if(!rawPlayer)return null;
   const rawAccount=rawPlayer.account_id,expectedAccount=rawAccount===undefined||rawAccount===null||['0','4294967295'].includes(String(rawAccount))?null:String(rawAccount);
   if(expectedAccount!==x.accountId)return null;
   players.push({side,teamId:team,heroId:h,accountId:x.accountId});
  }
 }
 if(sides[0].teamId!==null&&sides[0].teamId===sides[1].teamId||new Set(players.map(p=>p.heroId)).size!==10)return null;
 const known=players.map(p=>p.accountId).filter(x=>x!==null);
 if(new Set(known).size!==known.length)return null;
 players.sort((a,b)=>a.side.localeCompare(b.side,'en')||a.heroId-b.heroId);
 return {players,sides,draftHash:draftHash(players.map(({heroId,side})=>({heroId,side}))),rosterHash:draftHash(players),sideIdentityHash:draftHash(sides)};
}

/** Full draft = ten selected heroes with explicit sides, not ten public accounts.
 * State is a recorded-prefix checkpoint, not a claim about the unobserved match.
 */
function projection(o){return {matchId:o.matchId,inputHash:o.inputHash,phase:{status:o.dynamic?.phase?.status??null,missing:o.dynamic?.phase?.missing??null,value:o.dynamic?.phase?.value??null,rawValue:o.dynamic?.phase?.rawValue??null},clock:{status:o.providerGameClockSeconds?.status??null,missing:o.providerGameClockSeconds?.missing??null,value:o.providerGameClockSeconds?.value??null,sourceField:o.providerGameClockSeconds?.sourceField??null},quality:[...(o.sourceQualityReasons??[])].sort(),identity:identity(o)};}
export function advanceObservedDraft(previous,observation,{decisionAt,prefixBasis='unknown_prefix',identityCorrection=null,captureProof=null}={}){
 const o=observation,at=instantNs(o?.source?.capture?.receivedAt),decision=instantNs(decisionAt);
 if(!['unknown_prefix','recorded_from_collector_start'].includes(prefixBasis))throw Error('draft_prefix_basis');
 if(previous!==null&&previous!==undefined){
  if(previous.contract!==DRAFT_CONTRACT||!digest(previous.stateHash))throw Error('draft_state_contract');
  const {stateHash,...body}=previous;
  if(draftHash(body)!==stateHash)throw Error('draft_state_hash');
 }
 if(!id(o?.matchId)||o.contract!=='steam-live-scoreboard-candidate.v1'||o.dynamic?.sourceProfile!==PROFILE||o.source?.capture?.endpoint!=='GetLiveLeagueGames/v1'||!digest(o.observationId)||!digest(o.inputHash)||!digest(o.source?.capture?.rawSha256))return reject('draft_source_identity',previous??null);
 if(!Array.isArray(o.sourceQualityReasons)||o.sourceQualityReasons.length>128||o.sourceQualityReasons.some(x=>typeof x!=='string'||x.length>256))return reject('draft_quality_contract',previous??null);
 if(at===null||decision===null||at>decision)return reject('draft_receipt_after_decision',previous??null);
 const sourceHash=draftHash(o.source);
 if(sourceHash!==o.inputHash||draftHash({contract:'steam-live-scoreboard-source.v1',inputHash:o.inputHash,receivedAt:o.source.capture.receivedAt})!==o.observationId)return reject('draft_source_hash_mismatch',previous??null);
 const replay=captureProofs.get(captureProof)?.get(o.observationId);
 if(!replay)return reject('verified_raw_capture_required',previous??null);
 if(draftHash(projection(o))!==draftHash(projection(replay)))return reject('draft_admission_projection_mismatch',previous??null);
 if(previous&&(previous.matchId!==o.matchId||previous.sourceProfile!==PROFILE))return reject('draft_map_or_profile_changed',previous);
 if(previous&&at<instantNs(previous.lastReceivedAt))return reject('draft_receipt_rewind',previous);
 const phase=o.dynamic?.phase;
 if(phase?.status==='invalid'||phase?.missing===false&&![2,3,4,5].includes(phase.value)||o.sourceQualityReasons?.includes('outcome_marker_present'))return reject('draft_terminal_or_invalid_phase',previous??null);
 const current=identity(o);
 if(!current)return reject('ten_confirmed_heroes_and_sides_required',previous??null);
 let reason=previous?'draft_identity_unchanged':'first_complete_draft',revision=previous?.revision??0;
 if(previous&&current.rosterHash!==previous.identity.rosterHash){
  const old=previous.identity;
  // A previously unknown account or team can become known later. This is an
  // identity revision at this receipt, never permission to move the first draft
  // cutoff or to replace/redact an already known identity without evidence.
  const onlyDisclosure=current.draftHash===old.draftHash
   &&old.sides.every(p=>current.sides.some(q=>q.side===p.side&&(p.teamId===null||p.teamId===q.teamId)))
   &&old.players.every(p=>current.players.some(q=>q.heroId===p.heroId&&q.side===p.side
    &&(p.teamId===null||p.teamId===q.teamId)&&(p.accountId===null||p.accountId===q.accountId)));
  const teamDisclosed=onlyDisclosure&&current.sideIdentityHash!==old.sideIdentityHash;
  const accountDisclosed=onlyDisclosure&&old.players.some(p=>p.accountId===null&&current.players.some(q=>q.heroId===p.heroId&&q.side===p.side&&q.accountId!==null));
  if(!onlyDisclosure){
   const proof=identityCorrection;
   if(!object(proof)||proof.fromStateHash!==previous.stateHash||proof.toRosterHash!==current.rosterHash||!digest(proof.evidenceSha256)||typeof proof.evidenceUtf8!=='string'||Buffer.byteLength(proof.evidenceUtf8)>262144||createHash('sha256').update(proof.evidenceUtf8).digest('hex')!==proof.evidenceSha256||typeof proof.reason!=='string'||proof.reason.length<1||proof.reason.length>256||instantNs(proof.knownAt)===null||instantNs(proof.knownAt)>at)return reject('draft_identity_correction_evidence_required',previous);
   let evidence;try{evidence=JSON.parse(proof.evidenceUtf8);}catch{return reject('draft_identity_correction_evidence_invalid',previous);}
   if(evidence.contract!=='aegis.draft-identity-correction.v1'||evidence.matchId!==o.matchId||evidence.fromStateHash!==previous.stateHash||evidence.toRosterHash!==current.rosterHash||evidence.observationId!==o.observationId||evidence.knownAt!==proof.knownAt||evidence.reason!==proof.reason)return reject('draft_identity_correction_evidence_invalid',previous);
  }
  revision++;reason=!onlyDisclosure?'proven_identity_correction':teamDisclosed
   ?accountDisclosed?'team_and_account_identity_disclosed':'team_identity_disclosed'
   :'account_identity_disclosed';
 }
 const clock=o.providerGameClockSeconds;
 const firstClock=previous?previous.firstClock:(clock?.missing===false&&typeof clock.value==='number'&&Number.isFinite(clock.value)?clock.value:null);
 const cutoff=previous?.historyCutoffAt??o.source.capture.receivedAt;
 const cohort=previous?.firstObservationCohort??(firstClock===null?'game_clock_unknown':firstClock>0?'late_first_observation':'observed_postdraft_before_positive_clock');
 const body={contract:DRAFT_CONTRACT,cutoffPolicy:FREEZE_POLICY,matchId:o.matchId,sourceProfile:PROFILE,
  historyCutoffAt:cutoff,firstCompleteObservationId:previous?.firstCompleteObservationId??o.observationId,
  firstObservedBasis:previous?.firstObservedBasis??prefixBasis,firstClock,firstObservationCohort:cohort,
  postdraftZeroMinuteCohortEligible:cohort==='observed_postdraft_before_positive_clock'&&(previous?.firstObservedBasis??prefixBasis)==='recorded_from_collector_start',
  revision,validFromObservationId:revision===(previous?.revision??-1)?previous.validFromObservationId:o.observationId,
  validFrom:revision===(previous?.revision??-1)?previous.validFrom:o.source.capture.receivedAt,
  changeReason:revision===(previous?.revision??-1)?previous.changeReason:reason,
  identity:current,lastObservationId:o.observationId,lastReceivedAt:o.source.capture.receivedAt,
  rawSha256:o.source.capture.rawSha256,inputHash:o.inputHash};
 const state={...body,stateHash:draftHash(body)};
 return {status:'observed_draft_diagnostic',reason,state,draft:{...state,decisionAt},eligibleForServing:false,eligibleForTraining:false};
}
