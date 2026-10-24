/** Shared causal feature code for archived and serving observations. No IO or training.
 * Evidence is accepted only as-of this observation, within one map/source/patch/profile.
 * Rules are explicit versioned inputs; there is deliberately no global current-patch default.
 */
import {createHash} from 'node:crypto';
import {DYNAMIC_CONTRACT} from './dynamicFields.mjs';
import {instantNs} from './causalTime.mjs';
import {validateFrozenHistory} from './causalContext.mjs';
import {steamObservationIdentity} from './steamObservationIdentity.mjs';
export const FEATURE_CONTRACT='aegis.roshan-dynamic-features.v6';
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
const LEDGER_CONTRACT='aegis.roshan-event-ledger.v1',MAX_EVENT_IDS=2048,MAX_EVENT_VARIANTS=4096,MAX_LEDGER_BYTES=4*1024*1024;
const LIFE_KINDS=new Set(['roshan_death','roshan_alive','roshan_respawn']),TERMINAL_KINDS=new Set(['aegis_consumed','aegis_expired','aegis_destroyed']);
const EVENT_KINDS=new Set([...LIFE_KINDS,'aegis_pickup',...TERMINAL_KINDS]);
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x!==null&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
// Availability receipts corroborate a fact; they are not physical event content.
// Retain only the earliest supplied qualified receipt (tie: evidence reference),
// so a repeated fetch cannot add an event or shift its original availability.
const eventDigest=e=>createHash('sha256').update(canonical(Object.fromEntries(Object.entries(e).filter(([k])=>k!=='knownAt'&&k!=='evidenceRef')))).digest('hex');
const earlierReceipt=(a,b)=>time(a.knownAt)<time(b.knownAt)||time(a.knownAt)===time(b.knownAt)&&lexical(a.evidenceRef,b.evidenceRef)<0;
const lexical=(a,b)=>a<b?-1:a>b?1:0;
function emptyState(key){return {contract:FEATURE_CONTRACT,key,lastClock:null,lastKnownAt:null,lastTimer:null,death:null,lastLifeEvent:null,confirmedDeaths:[],seenEvents:[],aegis:null,eventLedger:{contract:LEDGER_CONTRACT,entries:[]},lastEconomy:null,economyIdentityKey:null};}
function eventAllowed(e,o,clock,at,patch){return e&&e.matchId===o.matchId&&e.sourceProfile===o.dynamic.sourceProfile&&(e.patch===undefined||e.patch===null||e.patch===patch)&&proof(e.id)&&proof(e.evidenceRef)&&e.confirmed===true&&nn(e.gameTimeSeconds)&&e.gameTimeSeconds<=clock&&time(e.knownAt)!==null&&time(e.knownAt)<=at;}
// Keep only the bounded event contract. Property order and absent/null optional
// fields do not create different content; changed actual event facts do.
function normalizedEvent(e){
 if(!EVENT_KINDS.has(e.kind)||e.side!=null&&!['radiant','dire'].includes(e.side)||['accountId','pickupEventId','roshanDeathEventId'].some(k=>e[k]!=null&&!proof(e[k]))||e.heroId!=null&&(!Number.isSafeInteger(e.heroId)||e.heroId<1||e.heroId>250))return null;
 if(e.kind==='aegis_pickup'&&(!['radiant','dire'].includes(e.side)||!proof(e.accountId))||TERMINAL_KINDS.has(e.kind)&&!proof(e.pickupEventId))return null;
 return Object.fromEntries(['id','kind','matchId','sourceProfile','patch','confirmed','evidenceRef','knownAt','gameTimeSeconds','side','accountId','heroId','pickupEventId','roshanDeathEventId'].map(k=>[k,e[k]??null]));
}
function checkLedger(ledger){
 if(ledger?.contract!==LEDGER_CONTRACT||!Array.isArray(ledger.entries)||ledger.entries.length>MAX_EVENT_IDS)throw Error('event_ledger_state_contract');
 let variants=0,previous=null;
 for(const row of ledger.entries){
  if(!proof(row?.id)||previous!==null&&lexical(previous,row.id)>=0||!Array.isArray(row.variants)||!row.variants.length)throw Error('event_ledger_state_identity');previous=row.id;
  let priorDigest=null;
  for(const v of row.variants){if(++variants>MAX_EVENT_VARIANTS||typeof v?.digest!=='string'||!v.event||!proof(v.event.evidenceRef)||time(v.event.knownAt)===null||v.digest!==eventDigest(v.event)||v.event.id!==row.id||priorDigest!==null&&lexical(priorDigest,v.digest)>=0)throw Error('event_ledger_state_variant');priorDigest=v.digest;}
 }
 if(Buffer.byteLength(canonical(ledger))>MAX_LEDGER_BYTES)throw Error('event_ledger_byte_bound');
}
function appendEvents(ledger,events,o,clock,at,patch,canAdvance){
 checkLedger(ledger);const rows=new Map(ledger.entries.map(row=>[row.id,{id:row.id,variants:[...row.variants]}])),accepted=[],rejected=[];let variants=ledger.entries.reduce((n,row)=>n+row.variants.length,0);
 for(const e of events){
  if(!canAdvance||!eventAllowed(e,o,clock,at,patch)){rejected.push(e?.id??'invalid_event');continue;}
  const event=normalizedEvent(e);if(event===null){rejected.push(e.id);continue;}
  const digest=eventDigest(event);let row=rows.get(event.id);
  const same=row?.variants.findIndex(v=>v.digest===digest)??-1;
  if(same>=0){if(earlierReceipt(event,row.variants[same].event))row.variants[same]={digest,event};continue;}
  if(!row){if(rows.size>=MAX_EVENT_IDS)throw Error('event_history_bound');row={id:event.id,variants:[]};rows.set(event.id,row);}
  if(++variants>MAX_EVENT_VARIANTS)throw Error('event_variant_history_bound');row.variants.push({digest,event});accepted.push(event.id);
 }
 const next={contract:LEDGER_CONTRACT,entries:[...rows.values()].sort((a,b)=>lexical(a.id,b.id)).map(row=>({...row,variants:row.variants.sort((a,b)=>lexical(a.digest,b.digest))}))};checkLedger(next);
 return{ledger:next,accepted:[...new Set(accepted)].sort(lexical),rejected:[...new Set(rejected)].sort(lexical)};
}
// Selection uses game-time evidence. A lexical ID is never a tiebreaker for
// contradictory truth; equal-time distinct assertions remain explicitly unknown.
function latestEvidence(ledger,kinds){
 const candidates=ledger.entries.flatMap(row=>row.variants.filter(v=>kinds.has(v.event.kind)).map(v=>({event:v.event,conflicted:row.variants.length!==1})));
 if(!candidates.length)return{event:null,conflicted:false};
 const clock=Math.max(...candidates.map(x=>x.event.gameTimeSeconds)),latest=candidates.filter(x=>x.event.gameTimeSeconds===clock);
 if(latest.some(x=>x.conflicted)||latest.length!==1)return{event:null,conflicted:true};return{event:latest[0].event,conflicted:false};
}
function reduceEvents(ledger){
 const byId=new Map(ledger.entries.map(row=>[row.id,row])),life=latestEvidence(ledger,LIFE_KINDS),death=latestEvidence(ledger,new Set(['roshan_death'])),pickup=latestEvidence(ledger,new Set(['aegis_pickup']));
 const conflicts=ledger.entries.filter(row=>row.variants.length>1).map(row=>row.id),confirmedDeaths=ledger.entries.filter(row=>row.variants.length===1&&row.variants[0].event.kind==='roshan_death').map(row=>row.id);
 let aegis=pickup.conflicted?{id:null,status:'conflicted_pickup'}:pickup.event?{...pickup.event,status:'pickup_confirmed'}:null;
 const unresolved=[],invalidLinks=[];
 for(const row of ledger.entries)for(const v of row.variants)if(TERMINAL_KINDS.has(v.event.kind)){
  const linked=byId.get(v.event.pickupEventId);if(!linked)unresolved.push(v.event.id);else if(linked.variants.length===1&&linked.variants[0].event.kind==='aegis_pickup'&&v.event.gameTimeSeconds<linked.variants[0].event.gameTimeSeconds)invalidLinks.push(v.event.id);
 }
 if(pickup.event){
  const rows=ledger.entries.filter(row=>row.variants.some(v=>TERMINAL_KINDS.has(v.event.kind)&&v.event.pickupEventId===pickup.event.id&&v.event.gameTimeSeconds>=pickup.event.gameTimeSeconds));
  const terminal=rows.flatMap(row=>row.variants.filter(v=>TERMINAL_KINDS.has(v.event.kind)&&v.event.pickupEventId===pickup.event.id&&v.event.gameTimeSeconds>=pickup.event.gameTimeSeconds).map(v=>v.event));
  const signatures=new Set(terminal.map(e=>canonical({kind:e.kind,gameTimeSeconds:e.gameTimeSeconds})));
  if(rows.some(row=>row.variants.length!==1)||signatures.size>1)aegis={...pickup.event,status:'conflicted_terminal_events'};
  else if(terminal.length){const event=[...terminal].sort((a,b)=>lexical(a.id,b.id))[0];aegis={...pickup.event,status:event.kind,terminalEvent:event};}
 }
 const deathConflict=ledger.entries.some(row=>row.variants.length>1&&row.variants.some(v=>v.event.kind==='roshan_death'));
 return{life:life.event,lifeConflicted:life.conflicted,death:death.event,deathConflicted:death.conflicted,aegis,byId,confirmedDeaths,deathCountConflicted:deathConflict,audit:{conflictingEventIds:conflicts,unresolvedTerminalEventIds:[...new Set(unresolved)].sort(lexical),invalidEpisodeChronologyEventIds:[...new Set(invalidLinks)].sort(lexical),pickupConflicted:pickup.conflicted,lifeConflicted:life.conflicted}};
}
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
 const resetReasons=[];let s;
 if(previous&&previous.contract!==FEATURE_CONTRACT){resetReasons.push('state_contract_changed_reset_required');s=emptyState(key);}
 else if(previous&&previous.key!==key){resetReasons.push('map_profile_patch_or_rules_changed');s=emptyState(key);}
 else if(previous){checkLedger(previous.eventLedger);s=structuredClone(previous);}
 else s=emptyState(key);
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
 const appended=appendEvents(s.eventLedger,events,o,clock,at,patch,canAdvance),acceptedEvents=appended.accepted,rejectedEvents=appended.rejected;
 s.eventLedger=appended.ledger;const reduced=reduceEvents(s.eventLedger);s.death=reduced.death;s.lastLifeEvent=reduced.life;s.confirmedDeaths=reduced.confirmedDeaths;s.seenEvents=s.eventLedger.entries.map(row=>row.id);s.aegis=reduced.aegis;
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
 if(reduced.lifeConflicted){life='unknown';lifeEvidence='conflicting_confirmed_events';features.roshan_dead=null;features.roshan_alive=null;}
 features.roshan_confirmed_death_count=reduced.deathCountConflicted?null:s.confirmedDeaths.length||null;
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
 const linkedDeath=pickup?reduced.byId.get(pickup.roshanDeathEventId):null,stealDeath=linkedDeath?.variants.length===1&&linkedDeath.variants[0].event.kind==='roshan_death'?linkedDeath.variants[0].event:null;
 features.aegis_confirmed_steal=pickup&&stealDeath&&stealDeath.gameTimeSeconds<=pickup.gameTimeSeconds&&['radiant','dire'].includes(stealDeath.side)?Number(pickup.side!==stealDeath.side):null;
 // Positive evidence for the retained pickup episode only. Other statuses do
 // do not prove a negative; neither missing slots nor elapsed lifetime establish an event.
 const terminalEvent=canAdvance?s.aegis?.terminalEvent:null;
 const terminalKnown=terminalEvent&&['aegis_consumed','aegis_expired','aegis_destroyed'].includes(s.aegis.status)&&terminalEvent.kind===s.aegis.status&&terminalEvent.pickupEventId===s.aegis.id;
 for(const kind of ['consumed','expired','destroyed']){
  const confirmed=terminalKnown&&s.aegis.status==='aegis_'+kind;
  features['aegis_confirmed_'+kind]=confirmed?1:null;
  features['aegis_elapsed_since_confirmed_'+kind]=confirmed?clock-terminalEvent.gameTimeSeconds:null;
 }
 features.aegis_confirmed_terminal_event_count_for_retained_pickup=terminalKnown?1:null;
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
  resetReasons,acceptedEventIds:acceptedEvents,rejectedEventIds:rejectedEvents,eventAudit:{contract:LEDGER_CONTRACT,eventIds:s.eventLedger.entries.length,variants:s.eventLedger.entries.reduce((n,row)=>n+row.variants.length,0),...reduced.audit},state:s,features,missing,
  schemaHash:digest(Object.keys(features).sort()),eligibleForServing:false,eligibleForTraining:false};
}
export function featureVector(result){
 if(result?.contract!==FEATURE_CONTRACT)throw Error('feature_contract');
 const names=Object.keys(result.features).sort();
 return {contract:FEATURE_CONTRACT,names,values:names.map(k=>result.features[k]),missing:names.map(k=>result.missing[k]),schemaHash:result.schemaHash};
}
