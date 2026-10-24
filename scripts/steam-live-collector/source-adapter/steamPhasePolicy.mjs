/** Pure routing policy over an already raw-replayed Steam observation.
 * This function does not authenticate source bytes or infer phase from clocks.
 * Static retained draft diagnostics are not an early/postdraft cohort claim.
 */
import {instantNs} from './causalTime.mjs';
export const STEAM_PHASE_POLICY_CONTRACT='aegis.steam-observed-phase-policy.v1';
const PROFILE='steam.GetLiveLeagueGames.v1.scoreboard';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o??{},k);
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x)&&BigInt(x)<(1n<<64n);
const OUTCOME_KEYS=['radiant_win','winner','match_outcome','final_score','finished','match_status'];

export function classifySteamObservationPhase(observation,{decisionAt=null}={}){
 const o=observation,c=o?.source?.capture,p=o?.dynamic?.phase,clock=o?.providerGameClockSeconds;
 const observedClock=clock?.missing===false&&finite(clock.value)?clock.value:null;
 const outcomeIndicatorNames=OUTCOME_KEYS.filter(k=>own(o?.source?.rawPacket,k));
 if(o?.sourceQualityReasons?.includes('outcome_marker_present'))outcomeIndicatorNames.push('normalized_outcome_marker_present');
 const provenance={sourceProfile:o?.dynamic?.sourceProfile??null,endpoint:c?.endpoint??null,
  matchId:o?.matchId??null,observationId:o?.observationId??null,rawSha256:c?.rawSha256??null,
  receivedAt:c?.receivedAt??null,providerGameClockSeconds:observedClock,
  providerPhaseValue:p?.value??null,providerPhaseStatus:p?.status??null,
  outcomeIndicatorNames,sourceBytesAuthenticatedHere:false,providerEventTimeProven:false};
 const identity={fullHeroDraft:false,teamIdentitiesKnown:false,knownAccounts:0,issues:[]};
 const result=(classification,reason,{dynamic=false,staticDraft=false,terminal=false}={})=>({
  contract:STEAM_PHASE_POLICY_CONTRACT,classification,reason,
  dynamicDiagnosticAllowed:dynamic,staticDraftDiagnosticAllowed:staticDraft,terminal,outcomeKnown:false,
  cohort:classification==='observed_postdraft'?'observed_explicit_draft_phase':classification==='observed_live'?'observed_explicit_live_phase':'unknown_or_late_not_early_postdraft',
  phase:{value:p?.value??null,status:p?.status??null,clockDoesNotProvePhase:true},clock:observedClock,identity,provenance,
  eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false});
 if(o?.contract!=='steam-live-scoreboard-candidate.v1'||o?.dynamic?.contract!=='steam-glg-dynamic-observation.v1'||o.dynamic.sourceProfile!==PROFILE||c?.endpoint!=='GetLiveLeagueGames/v1'||!id(o.matchId)||!sha(o.observationId)||!sha(c.rawSha256)||instantNs(c.receivedAt)===null)return result('blocked','normalized_source_profile_or_identity_invalid');
 if(decisionAt!==null&&(instantNs(decisionAt)===null||instantNs(c.receivedAt)>instantNs(decisionAt)))return result('blocked','observation_receipt_after_or_invalid_decision');
 const phaseAbsent=p?.status==='absent'&&p.missing===true&&p.value===null&&(p.rawValue===null||p.rawValue===undefined);
 const phaseObserved=p?.status==='observed'&&p.missing===false&&Number.isSafeInteger(p.value)&&p.value>=0&&p.value<=13&&(p.rawValue===undefined||p.rawValue===p.value);
 // Presence of an unmapped outcome marker blocks prediction, without reading a
 // winner or asserting a completed result. DISCONNECT(7) is not POST_GAME(6).
 if(outcomeIndicatorNames.includes('normalized_outcome_marker_present'))return result('terminal_or_outcome_indicator','outcome_indicator_present',{terminal:true});
 if(outcomeIndicatorNames.length)return result('blocked','raw_completion_indicator_unclassified');
 if(phaseObserved&&p.value===6)return result('observed_post_game','explicit_post_game_phase',{terminal:true});
 if(!phaseAbsent&&!phaseObserved)return result('blocked','phase_encoding_invalid');
 const heroes=[],accounts=[],teams=[];
 for(const side of ['radiant','dire']){
  const s=o.sides?.[side];
  if(!s||!Array.isArray(s.players)||s.players.length>5){identity.issues.push(side+'_player_shape');continue;}
  if(s.players.length!==5)identity.issues.push(side+'_draft_incomplete');
  if(s.teamId!==null&&!id(s.teamId))identity.issues.push(side+'_team_identity_invalid');
  teams.push(s.teamId??null);
  for(const q of s.players){const x=q?.identity;
   if(!x||x.side!==side||x.teamId!==s.teamId)identity.issues.push(side+'_player_side_or_team_conflict');
   if(!id(x?.heroId))identity.issues.push(side+'_hero_unknown_or_invalid');else heroes.push(x.heroId);
   if(x?.accountId!==null&&!id(x?.accountId))identity.issues.push(side+'_account_invalid');
   else if(x?.accountId!==null)accounts.push(x.accountId);
  }
 }
 if(new Set(heroes).size!==heroes.length)identity.issues.push('duplicate_hero_identity');
 if(new Set(accounts).size!==accounts.length)identity.issues.push('duplicate_account_identity');
 if(teams.length===2&&teams[0]!==null&&teams[0]===teams[1])identity.issues.push('same_team_identity');
 identity.fullHeroDraft=heroes.length===10&&identity.issues.length===0;
 identity.teamIdentitiesKnown=teams.length===2&&teams.every(x=>x!==null)&&teams[0]!==teams[1];
 identity.knownAccounts=accounts.length;
 if(!identity.fullHeroDraft)return result('blocked','complete_coherent_draft_required');
 if(phaseObserved&&p.value===5){
  if(observedClock===null||observedClock<0)return result('blocked','explicit_live_phase_requires_nonnegative_clock');
  return result('observed_live','explicit_observed_live_phase',{dynamic:true});
 }
 if(phaseObserved&&[2,3,4].includes(p.value))return result('observed_postdraft','explicit_draft_phase_complete_hero_roster',{staticDraft:true});
 if(phaseAbsent)return result('unclassified_static_draft_only','phase_absent_complete_draft_only',{staticDraft:true});
 return result('blocked','explicit_phase_not_supported_for_prediction');
}
