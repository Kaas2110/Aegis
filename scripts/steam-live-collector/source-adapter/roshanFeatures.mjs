/** Shared causal feature code for archived and serving observations. No IO or training.
 * Evidence is accepted only as-of this observation, within one map/source/patch/profile.
 * Rules are explicit versioned inputs; there is deliberately no global current-patch default.
 */
import {createHash} from 'node:crypto';
import {DYNAMIC_CONTRACT} from './dynamicFields.mjs';
import {instantNs} from './causalTime.mjs';
import {validateFrozenHistory} from './causalContext.mjs';
import {steamObservationIdentity} from './steamObservationIdentity.mjs';
export const FEATURE_CONTRACT='aegis.roshan-dynamic-features.v3';
const finite=x=>typeof x==='number'&&Number.isFinite(x),nn=x=>finite(x)&&x>=0;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const val=x=>x?.missing===false&&finite(x.value)?x.value:null;
const proof=x=>typeof x==='string'&&x.length>0&&x.length<256;
const time=instantNs;
function validateRules(r,patch,profile,at){
 if(!r||!proof(patch)||r.contract!=='aegis.roshan-rules.v1'||!proof(r.version)||!proof(r.evidenceRef)||r.patch!==patch||r.sourceProfile!==profile||time(r.knownAt)===null||time(r.knownAt)>at)return null;
 if(!finite(r.respawnMinimumSeconds)||r.respawnMinimumSeconds<=0||!finite(r.respawnMaximumSeconds)||r.respawnMaximumSeconds<r.respawnMinimumSeconds||r.respawnMaximumSeconds>3600||!finite(r.aegisLifetimeSeconds)||r.aegisLifetimeSeconds<=0||r.aegisLifetimeSeconds>3600)return null;
 return r;
}
function emptyState(key){return {contract:FEATURE_CONTRACT,key,lastClock:null,lastKnownAt:null,lastTimer:null,death:null,lastLifeEvent:null,confirmedDeaths:[],seenEvents:[],aegis:null,lastEconomy:null,economyIdentityKey:null};}
function eventAllowed(e,o,clock,at){return e&&e.matchId===o.matchId&&e.sourceProfile===o.dynamic.sourceProfile&&proof(e.id)&&proof(e.evidenceRef)&&e.confirmed===true&&nn(e.gameTimeSeconds)&&e.gameTimeSeconds<=clock&&time(e.knownAt)!==null&&time(e.knownAt)<=at;}
function economy(o){
 const result={};
 for(const side of ['radiant','dire']){
  const ps=o.sides?.[side]?.players??[];
  for(const [name,key]of [['nw','netWorth'],['gpm','goldPerMinute'],['xpm','experiencePerMinute'],['level','level']]){
   const values=ps.map(p=>val(p[key]));
   const complete=values.length===5&&values.every(finite);
   result[side+'_'+name+'_sum']=complete?values.reduce((a,b)=>a+b,0):null;
   result[side+'_'+name+'_max']=complete?Math.max(...values):null;
   result[side+'_'+name+'_min']=complete?Math.min(...values):null;
   result[side+'_'+name+'_spread']=complete?Math.max(...values)-Math.min(...values):null;
   result[side+'_'+name+'_top_share']=complete&&result[side+'_'+name+'_sum']>0?Math.max(...values)/result[side+'_'+name+'_sum']:null;
  }
  result[side+'_score']=val(o.sides?.[side]?.score);
 }
 for(const key of ['nw_sum','gpm_sum','xpm_sum','level_sum','nw_max','gpm_max','nw_top_share','score']){
  const a=result['radiant_'+key],b=result['dire_'+key];result[key+'_diff']=finite(a)&&finite(b)?a-b:null;
 }
 return result;
}
/** Returns a new state without mutating prior state. Never sort inputs by future game time.
 * events must represent already confirmed source events, not retrospective labels.
 * Historical context is frozen before this map; producers must supply as-of proof.
 */
export function advanceRoshanFeatures(previous,observation,{patch=null,rules=null,events=[],historicalContext=null}={}){
 const o=observation,d=o?.dynamic,clock=val(o?.providerGameClockSeconds),knownAt=o?.source?.capture?.receivedAt,at=time(knownAt);
 if(d?.contract!==DYNAMIC_CONTRACT||!proof(o.matchId)||!proof(d.sourceProfile)||at===null)throw Error('dynamic_observation_contract');
 const r=validateRules(rules,patch,d.sourceProfile,at);
 const timerSemanticsAccepted=!!(r&&r.timerSemantics==='confirmed_seconds_until_respawn'&&proof(r.timerSemanticsEvidenceRef)&&time(r.timerSemanticsKnownAt)!==null&&time(r.timerSemanticsKnownAt)<=time(r.knownAt));
 if(!Array.isArray(events)||events.length>2048)throw Error('event_evidence_bound');
 const key=JSON.stringify([o.matchId,d.sourceProfile,d.contract,patch,r?digest(r):null]);
 const resetReasons=[];let s=previous?structuredClone(previous):emptyState(key);
 if(s.contract!==FEATURE_CONTRACT||s.key!==key){resetReasons.push('map_profile_patch_or_rules_changed');s=emptyState(key);}
 if(s.lastKnownAt!==null&&(time(s.lastKnownAt)===null||at<time(s.lastKnownAt))){resetReasons.push('receipt_time_regression');s=emptyState(key);}
 if(finite(clock)&&finite(s.lastClock)&&clock<s.lastClock){resetReasons.push('game_clock_regression');s=emptyState(key);}
 if(clock===null||clock<0){resetReasons.push('game_clock_unusable');s=emptyState(key);}
 const explicitPhase=val(d.phase),phaseProvided=d.phase?.status==='invalid'||d.phase?.rawValue!==null&&d.phase?.rawValue!==undefined;
 const explicitNonLive=phaseProvided&&explicitPhase!==5;
 if(explicitNonLive){resetReasons.push('explicit_non_live_phase');s=emptyState(key);}
 const terminalOutcome=Array.isArray(o.sourceQualityReasons)&&o.sourceQualityReasons.includes('outcome_marker_present');
 if(terminalOutcome){resetReasons.push('terminal_outcome_present');s=emptyState(key);}
 const identity=steamObservationIdentity(o);
 if(identity.key===null){resetReasons.push('player_side_team_identity_invalid');s.lastEconomy=null;}
 else if(s.economyIdentityKey!==null&&s.economyIdentityKey!==identity.key){resetReasons.push('player_side_team_identity_changed');s.lastEconomy=null;}
 const canAdvance=finite(clock)&&clock>=0&&!explicitNonLive&&!terminalOutcome;
 const timer=val(d.roshan?.respawnTimer),features={clock_seconds:clock,phase_code:val(d.phase),roshan_timer_raw:timer};
 let pairConsistent=null;
 if(canAdvance&&finite(s.lastClock)&&clock>s.lastClock&&timer>0&&s.lastTimer>0){
  const delta=clock-s.lastClock;pairConsistent=Math.abs((s.lastTimer-timer)-delta)<=2;
 }
 features.roshan_timer_decreasing_pair=pairConsistent===null?null:Number(pairConsistent);
 features.roshan_timer_positive=timer===null?null:Number(timer>0);
 let life='unknown',lifeEvidence=null;
 const acceptedEvents=[],rejectedEvents=[];
 const ordered=[...events].sort((a,b)=>(a?.gameTimeSeconds??Infinity)-(b?.gameTimeSeconds??Infinity)||String(a?.id).localeCompare(String(b?.id)));
 for(const e of ordered){
  if(!canAdvance||!eventAllowed(e,o,clock,at)){rejectedEvents.push(e?.id??'invalid_event');continue;}
  if(!['roshan_death','roshan_alive','roshan_respawn','aegis_pickup','aegis_consumed','aegis_expired','aegis_destroyed'].includes(e.kind)){rejectedEvents.push(e.id);continue;}
  if(s.seenEvents.includes(e.id))continue;
  if(s.seenEvents.length>=2048)throw Error('event_history_bound');
  s.seenEvents.push(e.id);
  acceptedEvents.push(e.id);
  if(e.kind==='roshan_death'){
   if(!s.death||e.gameTimeSeconds>=s.death.gameTimeSeconds)s.death={...e};
   if(!s.confirmedDeaths.includes(e.id))s.confirmedDeaths.push(e.id);
  }
  if(['roshan_death','roshan_alive','roshan_respawn'].includes(e.kind)&&(!s.lastLifeEvent||e.gameTimeSeconds>=s.lastLifeEvent.gameTimeSeconds))s.lastLifeEvent={...e};
  if(e.kind==='aegis_pickup'&&['radiant','dire'].includes(e.side)&&proof(e.accountId)){
   if(!s.aegis||e.gameTimeSeconds>=s.aegis.gameTimeSeconds)s.aegis={...e,status:'pickup_confirmed'};
  }
  if(['aegis_consumed','aegis_expired','aegis_destroyed'].includes(e.kind)&&s.aegis&&e.gameTimeSeconds>=s.aegis.gameTimeSeconds&&e.pickupEventId===s.aegis.id)s.aegis={...s.aegis,status:e.kind,terminalEvent:e};
 }
 const elapsed=canAdvance&&s.death?clock-s.death.gameTimeSeconds:null;
 let lower=null,upper=null,countdown=null,inferredDeathLower=null,inferredDeathUpper=null,inferredElapsedLower=null,inferredElapsedUpper=null;
 if(r&&elapsed!==null){lower=Math.max(0,r.respawnMinimumSeconds-elapsed);upper=Math.max(0,r.respawnMaximumSeconds-elapsed);}
 // A positive timer is an observed field, not proof of death unless its semantics are explicitly validated.
 if(canAdvance&&timerSemanticsAccepted&&timer>0&&timer<=r.respawnMaximumSeconds){
  const deathLower=clock+timer-r.respawnMaximumSeconds,deathUpper=Math.min(clock,clock+timer-r.respawnMinimumSeconds);
  if(deathLower<=deathUpper){life='dead';lifeEvidence='validated_provider_timer';countdown=timer;
   inferredDeathLower=deathLower;inferredDeathUpper=deathUpper;inferredElapsedLower=Math.max(0,r.respawnMinimumSeconds-timer);inferredElapsedUpper=r.respawnMaximumSeconds-timer;
  }
 }
 else if(canAdvance&&s.lastLifeEvent?.kind==='roshan_death'&&r&&elapsed!==null&&elapsed<r.respawnMinimumSeconds){life='dead';lifeEvidence='confirmed_death_before_earliest_respawn';}
 else if(canAdvance&&['roshan_alive','roshan_respawn'].includes(s.lastLifeEvent?.kind)&&s.lastLifeEvent.gameTimeSeconds===clock){life='alive';lifeEvidence='confirmed_event_at_current_clock';}
 // Even after the upper bound a new kill could have occurred between polls. Do not assert alive.
 features.roshan_elapsed_since_confirmed_death=elapsed;
 features.roshan_respawn_lower_seconds=lower;features.roshan_respawn_upper_seconds=upper;
 features.roshan_confirmed_countdown_seconds=countdown;
 // Interval inference from an attested timer is deliberately separate from a confirmed death event.
 features.roshan_inferred_death_game_clock_lower_seconds=inferredDeathLower;features.roshan_inferred_death_game_clock_upper_seconds=inferredDeathUpper;
 features.roshan_inferred_elapsed_since_death_lower_seconds=inferredElapsedLower;features.roshan_inferred_elapsed_since_death_upper_seconds=inferredElapsedUpper;
 features.roshan_dead=life==='unknown'?null:Number(life==='dead');features.roshan_alive=life==='unknown'?null:Number(life==='alive');
 features.roshan_confirmed_death_count=s.confirmedDeaths.length||null;
 let holder=null;
 const candidates=[];
 if(canAdvance&&r&&Number.isSafeInteger(r.aegisItemId)&&r.aegisItemId>0){
  for(const side of ['radiant','dire'])for(const p of o.sides?.[side]?.players??[])if(p.observedItemFields?.some(x=>val(x)===r.aegisItemId))candidates.push({side,accountId:p.identity.accountId,heroId:p.identity.heroId,netWorth:val(p.netWorth),level:val(p.level),evidence:'current_observed_inventory_slot'});
  if(candidates.length===1)holder=candidates[0];
 }
 const pickup=s.aegis?.status==='pickup_confirmed'?s.aegis:null;
 const aegisElapsed=canAdvance&&pickup?clock-pickup.gameTimeSeconds:null;
 const aegisRemaining=r&&aegisElapsed!==null?Math.max(0,r.aegisLifetimeSeconds-aegisElapsed):null;
 features.aegis_observed_in_slot=holder?1:null; // no slot match does not prove absence, slots are incomplete
 features.aegis_holder_side=holder?(holder.side==='radiant'?1:-1):null;
 features.aegis_holder_hero=holder&&holder.heroId!==null?Number(holder.heroId):null;
 features.aegis_holder_nw=holder?.netWorth??null;features.aegis_holder_level=holder?.level??null;
 features.aegis_elapsed_since_confirmed_pickup=aegisElapsed;features.aegis_lifetime_upper_seconds=aegisRemaining;
 features.aegis_confirmed_steal=pickup&&s.death&&pickup.roshanDeathEventId===s.death.id&&['radiant','dire'].includes(s.death.side)?Number(pickup.side!==s.death.side):null;
 const econ=economy(o);Object.assign(features,econ);
 const delta=canAdvance&&finite(s.lastClock)?clock-s.lastClock:null;
 for(const key of ['nw_sum_diff','gpm_sum_diff','score_diff'])features[key+'_change_per_game_minute']=delta>0&&finite(econ[key])&&finite(s.lastEconomy?.[key])?(econ[key]-s.lastEconomy[key])*60/delta:null;
 const historical={},history=validateFrozenHistory(historicalContext,{matchId:o.matchId,receivedAt:knownAt});
 if(history.accepted)for(const [k,v]of Object.entries(history.features))if(/^(radiant|dire)_(form|finish_speed|late_propensity|push_strength|carry_power|mid_power|offlane_power)$/.test(k))historical[k]=finite(v)?v:null;
 for(const side of ['radiant','dire'])for(const key of ['form','finish_speed','late_propensity','push_strength','carry_power','mid_power','offlane_power'])features['history_'+side+'_'+key]=historical[side+'_'+key]??null;
 const gates=['roshan_timer_raw','roshan_elapsed_since_confirmed_death','roshan_respawn_lower_seconds','roshan_respawn_upper_seconds','roshan_confirmed_countdown_seconds','roshan_inferred_death_game_clock_lower_seconds','roshan_inferred_death_game_clock_upper_seconds','roshan_inferred_elapsed_since_death_lower_seconds','roshan_inferred_elapsed_since_death_upper_seconds','aegis_lifetime_upper_seconds','aegis_holder_side','aegis_holder_nw'];
 const contextKeys=['clock_seconds',...Object.keys(econ),...Object.keys(features).filter(k=>k.startsWith('history_'))];
 for(const a of gates)for(const b of contextKeys){const v=finite(features[a])&&finite(features[b])?features[a]*features[b]:null;features[a+'__x__'+b]=finite(v)?v:null;}
 if(canAdvance){s.lastClock=clock;s.lastTimer=timer;s.lastEconomy=identity.key===null?null:econ;s.lastKnownAt=knownAt;s.economyIdentityKey=identity.key;}
 const missing=Object.fromEntries(Object.entries(features).map(([k,v])=>[k,v===null]));
 return {contract:FEATURE_CONTRACT,observationId:o.observationId,matchId:o.matchId,sourceProfile:d.sourceProfile,sourceInputHash:o.inputHash,rawSha256:o.source.capture.rawSha256,
  knownAt,gameClockSeconds:clock,patch,rulesVersion:r?.version??null,rulesAccepted:r!==null,timerSemanticsAccepted,historyContext:{accepted:history.accepted,reason:history.reason,mode:history.accepted?'prematch_frozen':null},
  roshan:{state:life,evidence:lifeEvidence,inferredDeathBoundsEvidence:inferredDeathLower===null?null:'attested_timer_and_versioned_respawn_bounds'},aegis:{holder,status:s.aegis?.status??'unknown',absenceProven:false},
  resetReasons,acceptedEventIds:acceptedEvents,rejectedEventIds:rejectedEvents,state:s,features,missing,
  schemaHash:digest(Object.keys(features).sort()),eligibleForServing:false,eligibleForTraining:false};
}
export function featureVector(result){
 if(result?.contract!==FEATURE_CONTRACT)throw Error('feature_contract');
 const names=Object.keys(result.features).sort();
 return {contract:FEATURE_CONTRACT,names,values:names.map(k=>result.features[k]),missing:names.map(k=>result.missing[k]),schemaHash:result.schemaHash};
}
