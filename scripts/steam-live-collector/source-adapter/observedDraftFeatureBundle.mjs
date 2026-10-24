/** Diagnostic v3 history + one coherent native Steam trajectory.
 * Host code owns the retained journal and reviewed semantic pins. No IO or fit.
 * Proof/state tokens are deliberately not serializable: restart replays bytes.
 */
import {instantNs} from './causalTime.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {readPinnedHistoricalJson} from './historicalAlignment.mjs';
import {produceObservedDraftHistory,validateObservedDraftHistory,replayPinnedDraftPrefix} from './observedDraftHistory.mjs';
import {advanceSteamFeatureBundle,BUNDLE_CONTRACT} from './steamFeatureBundle.mjs';
import {HERO_IDS,evidenceHash} from './playerHeroEconomyFeatures.mjs';
import {produceHistoricalRelationalFeatures,HISTORICAL_PLAYER_PROFILE_KEYS} from './historicalRelationalFeatures.mjs';

export const CONTRACT='aegis.observed-draft-steam-feature-bundle.v2';
export const HISTORY_PROOF_CONTRACT='aegis.verified-dynamic-history-context.v1';
const histories=new WeakMap(),states=new WeakMap();
const PROFILE='steam.GetLiveLeagueGames.v1.scoreboard',SIDES=['radiant','dire'];
const METRICS={native_nw:['netWorth','gold_value','L02'],native_gpm:['goldPerMinute','gold_per_minute','L03'],native_xpm:['experiencePerMinute','xp_per_minute','L03'],native_level:['level','level','L04'],native_gold:['gold','provider_gold','L02']};
const CONTEXT_KEYS=['recentForm','heroForm','teamForm','aggression','lateTendency','playerLateTendency','heroLateTendency','playerHeroLateTendency'];
const CONTEXT_UNITS={aggression:'kills_per_played_minute'};
const PLAYER_DYNAMICS={kills:['kills','count','L10'],deaths:['deaths','count','L10'],assists:['assists','count','L10'],last_hits:['lastHits','count','L10'],denies:['denies','count','L10'],respawn_timer_raw:['respawnTimer','provider_timer_seconds_candidate','L11'],ultimate_state_raw:['ultimateState','opaque_provider_enum','L12'],ultimate_cooldown_raw:['ultimateCooldown','provider_timer_seconds_candidate','L12'],buyback_cooldown_raw:['buybackCooldown','provider_timer_seconds_candidate','L15'],position_x_raw:['positionX','provider_coordinate_unverified','L16'],position_y_raw:['positionY','provider_coordinate_unverified','L16']};
const ROSHAN_KEYS=['roshan_timer_raw','roshan_elapsed_since_confirmed_death','roshan_respawn_lower_seconds','roshan_respawn_upper_seconds','roshan_confirmed_countdown_seconds','roshan_dead','roshan_alive','aegis_lifetime_upper_seconds','aegis_holder_side','aegis_confirmed_steal'];
const LEAD_KEYS=['nw_sum_diff','gpm_sum_diff','xpm_sum_diff','level_sum_diff','score_diff'];
const LEAD_UNITS={nw_sum_diff:'gold_value',gpm_sum_diff:'gold_per_minute',xpm_sum_diff:'xp_per_minute',level_sum_diff:'level',score_diff:'kills'};
const ROSHAN_UNITS={roshan_timer_raw:'provider_timer_seconds_candidate',roshan_dead:'boolean',roshan_alive:'boolean',aegis_holder_side:'side_sign',aegis_confirmed_steal:'boolean'};
const FINISH_KEYS=['meanDurationSeconds90d','winMeanDurationSeconds90d','lossMeanDurationSeconds90d','late40Fraction90d','meanOwnKillsPerMinute90d'];
const WINDOWS=[60,180,300,600];
const LIVE_TARGETS=['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE'];
// Explicit source-backed base projection. Never concatenate the old native
// bundle or make basic current inputs conditional on historical support.
const ROSHAN_BASE_FIELDS={
 roshan_timer_raw:['R01','provider_timer_seconds_candidate'],roshan_timer_positive:['R01','boolean'],roshan_timer_decreasing_pair:['R01','boolean'],
 roshan_elapsed_since_confirmed_death:['R02','seconds'],roshan_respawn_lower_seconds:['R02','seconds'],roshan_respawn_upper_seconds:['R02','seconds'],roshan_confirmed_countdown_seconds:['R02','seconds'],
 roshan_inferred_death_game_clock_lower_seconds:['R02','game_seconds'],roshan_inferred_death_game_clock_upper_seconds:['R02','game_seconds'],roshan_inferred_elapsed_since_death_lower_seconds:['R02','seconds'],roshan_inferred_elapsed_since_death_upper_seconds:['R02','seconds'],
 roshan_dead:['R02','boolean'],roshan_alive:['R02','boolean'],roshan_confirmed_death_count:['R02','confirmed_event_count_not_spawn_ordinal'],
 aegis_observed_in_slot:['R03','boolean'],aegis_holder_side:['R03','side_sign'],aegis_holder_hero:['R03','hero_id'],aegis_holder_nw:['R03','gold_value'],aegis_holder_level:['R03','level'],aegis_elapsed_since_confirmed_pickup:['R03','seconds'],aegis_lifetime_upper_seconds:['R03','seconds'],aegis_confirmed_steal:['R04','boolean']
};
const finite=x=>typeof x==='number'&&Number.isFinite(x),field=x=>x?.missing===false&&finite(x.value)?x.value:null;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const blocked=(reason,audit={})=>({contract:CONTRACT,status:'blocked',reason,vector:null,audit,eligibleForServing:false,eligibleForTraining:false,publicPromotion:false,recordedPrediction:false});
const product=(...v)=>v.every(finite)&&finite(v.reduce((a,b)=>a*b,1))?v.reduce((a,b)=>a*b,1):null;
function identity(players){return players.map(p=>({side:p.identity?.side??p.side,teamId:p.identity?.teamId??p.teamId??null,heroId:Number(p.identity?.heroId??p.heroId),accountId:p.identity?.accountId??p.accountId??null})).sort((a,b)=>a.side.localeCompare(b.side)||a.heroId-b.heroId);}
function deepFreeze(x){if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))deepFreeze(v);Object.freeze(x);}return x;}

/** Actual-byte historical producer and relational algebra run ONCE per t0/t1
 * revision. Neither a JSON content hash nor a user-supplied context is a proof.
 * Public copies are inspectable; the private token retains immutable originals.
 */
export function createDynamicHistoryProof(historyProducerInputs){
 const input=structuredClone(historyProducerInputs),produced=produceObservedDraftHistory(input);
 if(produced.status==='blocked'||!produced.context)throw Error('dynamic_history_producer_blocked:'+produced.reason);
 const context=deepFreeze(structuredClone(produced.context));
 const relational=produceHistoricalRelationalFeatures({historyContext:context,factsInput:input.factsInput,matchId:input.matchId,decisionAt:input.computedAt,minimumSupport:input.minimumSupport??5});
 if(relational.status!=='diagnostic_produced')throw Error('dynamic_relational_history_blocked:'+relational.reason);
 const proof=Object.freeze({contract:HISTORY_PROOF_CONTRACT,historyContentHash:context.contentHash,relationalContentHash:relational.contentHash??evidenceHash(relational)});
 histories.set(proof,{context,relational:deepFreeze(structuredClone(relational))});
 return {contract:HISTORY_PROOF_CONTRACT,proof,context:structuredClone(context),relational:structuredClone(relational),eligibleForServing:false,eligibleForTraining:false};
}

/** Authoritative read for the shared POST/LIVE entrypoint. Returned originals
 * are recursively immutable. Public wrapper copies are never consulted. */
export function readDynamicHistoryProof(historyProof,{matchId,decisionAt,readMode='recorded'}={}){
 const history=histories.get(historyProof);
 if(!history)return {accepted:false,reason:'verified_dynamic_history_token_required',context:null,relational:null};
 const gate=validateObservedDraftHistory(history.context,{matchId,decisionAt,readMode});
 if(!gate.accepted)return {accepted:false,reason:gate.reason,context:null,relational:null};
 return {accepted:true,reason:'actual_byte_producer_context_from_owned_proof',context:history.context,relational:history.relational,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
}

function descriptor(name,{familyId,formula,units,inputScopes=['current_live'],inputFields=[],historyDefinitions=[]}){
 return {contract:'aegis.executable-feature-definition.v1',id:CONTRACT+':'+name,name,version:'1',familyId,formula,formulaVersion:'1',units,dtype:'float64',missingPolicy:'null_with_separate_missing_mask; absent hero interaction is structural zero',timePolicy:'coherent current capture; prior history available no later than immutable first_complete_draft_receipt; receipt <= decision',sourceProfile:PROFILE,learnedStatePolicy:'none',inputScopes,allowedTargets:LIVE_TARGETS,semanticStatus:'specified',inputFields,historyDefinitions,legacyCounterpart:legacyCounterpartForDynamicFeature(name)};
}
/** Mapping evidence, NOT a global alias/dedup assertion. The legacy columns stay
 * missing in the native-only component. Their v2 context gate is unchanged. */
export function legacyCounterpartForDynamicFeature(name){
 const product=name.match(/^draft_live\.hero\.(\d+)\.(native_nw|native_gpm|native_xpm)\.(recentForm|heroForm|teamForm|aggression|lateTendency|playerLateTendency|heroLateTendency|playerHeroLateTendency)\.history_product$/);
 const reference=name.match(/^draft_live\.hero\.(\d+)\.(native_nw|native_gpm|native_xpm)\.(hero_minute_residual|hero_minute_standardized)$/);
 const literal=name.match(/^draft_live\.hero\.(\d+)\.(native_nw|native_gpm|native_xpm)\.observed_value$/);
 return product||reference||literal?{name:product?`native_economy.hero.${product[1]}.${product[2]}.context_${product[3]}`:reference?`native_economy.hero.${reference[1]}.${reference[2]}.${reference[3]}`:`native_economy.hero.${literal[1]}.${literal[2]}.value`,relationship:'same arithmetic, different historical-context/anonymous-identity admission; not unconditional alias',policy:'v3 diagnostic projection chooses this column explicitly; preserve old archived schema'}:null;
}
function boundEvidence(input,expected,kind){
 if(input===null||input===undefined)return null;
 if(!sha(expected)||input.pin?.sha256!==expected)throw Error('dynamic_'+kind+'_host_review_pin_required');
 return readPinnedHistoricalJson(input,{maxBytes:512*1024}).data;
}
function historyValue(p,key){
 const v=p?.values?.[key],s=p?.statistics?.[key];
 return finite(v)&&s?.value===v&&typeof s.definition==='string'&&s.definition.length>0&&Number.isSafeInteger(s.supportMaps)&&Number.isSafeInteger(s.minimumSupport)&&s.supportMaps>=s.minimumSupport&&s.minimumSupport>=3&&s.cohortQualified!==false?v:null;
}
function profileFor(context,p){return context.featurePayload.players.find(q=>q.accountId===p.identity.accountId&&q.accountId!==null&&Number(q.heroId)===Number(p.identity.heroId)&&q.side===p.identity.side&&q.teamId===p.identity.teamId)??null;}
function contextValues(context,p){
 const player=profileFor(context,p),hero=context.featurePayload.heroes.find(q=>Number(q.heroId)===Number(p.identity.heroId)&&q.side===p.identity.side&&q.teamId===p.identity.teamId),team=context.featurePayload.teams.find(q=>q.side===p.identity.side&&q.teamId===p.identity.teamId);
 return Object.fromEntries(CONTEXT_KEYS.map(k=>[k,historyValue(k==='heroLateTendency'?hero:['teamForm','aggression','lateTendency'].includes(k)?team:player,k)]));
}
function relationalFor(relational,p){return relational.profiles.players.find(q=>q.accountId===p.identity.accountId&&Number(q.heroId)===Number(p.identity.heroId)&&q.side===p.identity.side&&q.teamId===p.identity.teamId)??null;}
function summary(xs){return xs.length===5&&xs.every(finite)?{sum:xs.reduce((a,b)=>a+b,0),mean:xs.reduce((a,b)=>a+b,0)/5,min:Math.min(...xs),max:Math.max(...xs)}:null;}

/** A new current-frame packet or bounded sequential prefix uses the same code.
 * livePrefixInputs has the retained raw/metadata format of draftPrefixInputs.
 * State is an in-memory opaque handle, never an unchecked caller checkpoint.
 * Rules/events are optional ACTUAL pinned bytes plus independently configured
 * host-review hashes. Their semantic truth remains a reviewed host assumption;
 * absence retains unknown Roshan/respawn/Aegis semantics.
 */
export function advanceObservedDraftFeatureBundle(previous,{livePrefixInputs,matchId,decisionAt,historyProof,patch=null,rulesEvidence=null,expectedRulesSha256=null,eventsEvidence=null,expectedEventsSha256=null}={}){
 const history=readDynamicHistoryProof(historyProof,{matchId,decisionAt});
 if(!history.accepted)return blocked(history.reason);
 const {context,relational}=history;
 let internal=previous===null||previous===undefined?null:states.get(previous);
 if(previous!==null&&previous!==undefined&&!internal)return blocked('owned_dynamic_state_required');
 if(internal&&(internal.matchId!==matchId||internal.historyContentHash!==context.contentHash))return blocked('dynamic_history_revision_or_map_changed_reset_required');
 const replay=replayPinnedDraftPrefix({draftPrefixInputs:livePrefixInputs,matchId,computedAt:decisionAt});
 if(!replay.accepted)return blocked(replay.reason);
 const rules=boundEvidence(rulesEvidence,expectedRulesSha256,'rules'),eventDocument=boundEvidence(eventsEvidence,expectedEventsSha256,'events');
 if(eventDocument!==null&&(eventDocument.contract!=='aegis.confirmed-live-objective-events.v1'||!Array.isArray(eventDocument.events)||eventDocument.events.length>2048))throw Error('dynamic_events_contract');
 const events=eventDocument?.events??[];
 let native=internal?.nativeState??null,lastReceived=internal?.lastReceivedAt??null,lastClock=internal?.lastClock??null,lastObservation=null,lastNative=null,leadHistory=structuredClone(internal?.leadHistory??[]),bindings=[];
 for(const entry of livePrefixInputs){
  const raw=readPinnedHistoricalJson(entry.rawInput,{maxBytes:6*1024*1024}),metadata=readPinnedHistoricalJson(entry.metadataInput,{maxBytes:256*1024}).data;
  const capture={...metadata.capture,body:Buffer.from(entry.rawInput.utf8,'utf8'),rawSha256:raw.pin.sha256,payloadRef:'journal:'+raw.pin.sha256};
  const rows=normalizeLocalCapture(capture).observations.filter(o=>o.matchId===matchId&&o.observationId===metadata.observationId);
  if(rows.length!==1)return blocked('dynamic_observation_not_in_raw');
  const o=rows[0],receipt=instantNs(o.source.capture.receivedAt),clock=field(o.providerGameClockSeconds),phase=o.dynamic?.phase;
  if(lastReceived!==null&&receipt<instantNs(lastReceived))return blocked('dynamic_receipt_regression');
  if(context.validFrom&&instantNs(context.validFrom)>receipt)return blocked('dynamic_context_not_known_at_capture');
  const players=SIDES.flatMap(side=>o.sides[side].players);
  if(evidenceHash(identity(players))!==evidenceHash(identity(context.draftState.identity.players)))return blocked('dynamic_history_roster_mismatch');
  // Positive clock never upgrades an omitted phase to GAME_IN_PROGRESS.
  // A future profile-specific live attestation is a separate reviewed contract.
  if(o.dynamic.sourceProfile!==PROFILE||clock===null||clock<0||phase?.status!=='observed'||phase?.missing!==false||phase.value!==5||o.sourceQualityReasons?.includes('outcome_marker_present'))return blocked('dynamic_live_clock_or_phase_unavailable');
  // Resetting a feature window is not authority to replace an accepted current
  // game with an earlier clock. A future remake/epoch needs its own proof.
  if(lastClock!==null&&clock<lastClock)return blocked('dynamic_game_clock_regression',{previousClockSeconds:lastClock,observedClockSeconds:clock,receivedAt:o.source.capture.receivedAt,rawSha256:raw.pin.sha256});
  const frame=advanceSteamFeatureBundle(native,o,{patch,rules,events,historicalContext:null});
  if(frame.resetReasons.length)leadHistory=[];
  leadHistory=leadHistory.filter(p=>p.clock>=clock-630&&p.observationId!==o.observationId);
  const nativeValues=new Map(frame.vector.names.map((name,i)=>[name,frame.vector.values[i]]));
  leadHistory.push({clock,knownAt:o.source.capture.receivedAt,observationId:o.observationId,leads:Object.fromEntries(LEAD_KEYS.map(k=>[k,nativeValues.get('roshan.'+k)??null]))});
  if(leadHistory.length>2048)throw Error('dynamic_lead_history_bound');
  native=frame.state;lastReceived=o.source.capture.receivedAt;lastClock=clock;
  lastObservation=o;lastNative=frame;
  bindings.push({observationId:o.observationId,rawSha256:raw.pin.sha256,metadataSha256:entry.metadataInput.pin.sha256,receivedAt:o.source.capture.receivedAt});
 }
 if(!lastObservation)return blocked('dynamic_live_prefix_empty');
 const result=projectInteractions(lastObservation,lastNative,context,relational,leadHistory);
 const state=Object.freeze({contract:CONTRACT+'.state',matchId,lastObservationId:result.observationId,historyContentHash:context.contentHash});
 // Do not expose the retained state through nativeBundle.state: callers can
 // inspect/mutate that public copy without mutating the trusted next-step state.
 states.set(state,{matchId,nativeState:deepFreeze(structuredClone(native)),leadHistory:deepFreeze(structuredClone(leadHistory)),lastReceivedAt:lastReceived,lastClock,historyContentHash:context.contentHash});
 return {...result,state,sourceBindings:bindings,historyRefs:{contentHash:context.contentHash,historyCutoffAt:context.historyCutoffAt,validFrom:context.validFrom,computedAt:context.computedAt,identityRevision:context.draftState.revision,factsSha256:context.producer.bindings.facts.sha256},semanticEvidence:{rulesSha256:rulesEvidence?.pin?.sha256??null,eventsSha256:eventsEvidence?.pin?.sha256??null,trust:'optional reviewed host-pinned artifact, not independent event truth'},sourceCoherence:{sourceProfile:PROFILE,oneNativeProfile:true,rawBytesReplayed:true,explicitPhase5:true,historyAsOfOriginalCutoff:true,receiptAuthenticity:'trusted host retained journal; no provider signature verified'},zeroMinuteCohortClaimed:false,jointTimelyCoverageProven:false,eligibleForServing:false,eligibleForTraining:false,publicPromotion:false,recordedPrediction:false};
}

function projectInteractions(o,native,context,relational,leadHistory){
 // Fix arithmetic order by identity, including floating-point reductions. Raw
 // array positions and economic ranks are not identity or farm roles.
 const players=SIDES.flatMap(side=>[...o.sides[side].players].sort((a,b)=>Number(a.identity.heroId)-Number(b.identity.heroId))),minute=field(o.providerGameClockSeconds)/60;
 const names=[],values=[],masks=[],definitions=[],put=(name,value,definition)=>{names.push(name);values.push(finite(value)?value:null);masks.push(finite(value)?0:1);definitions.push(descriptor(name,definition));};
 const nativeValues=new Map(native.vector.names.map((name,i)=>[name,native.vector.values[i]]));
 const nativeValue=name=>nativeValues.get('roshan.'+name)??null;
 const base=(name,value,familyId,units,inputFields,formula)=>put('draft_live.base.'+name,value,{familyId,units,inputFields,formula,inputScopes:['current_live']});
 base('clock_seconds',nativeValue('clock_seconds'),'L01','game_seconds',['providerGameClockSeconds'],'literal coherent provider game clock from the admitted current capture');
 base('phase_code',nativeValue('phase_code'),'L01','DOTA_GameState',['dynamic.phase'],'literal observed provider phase; never inferred from clock');
 for(const side of SIDES)base(side+'_kills',nativeValue(side+'_score'),'L01','kills',['sides.'+side+'.score'],'literal same-frame provider team score');
 const rs=nativeValue('radiant_score'),ds=nativeValue('dire_score');
 base('total_kills',finite(rs)&&finite(ds)?rs+ds:null,'L01','kills',['sides.radiant.score','sides.dire.score'],'Radiant score + Dire score, only when both observed in the same frame');
 base('kills_diff',nativeValue('score_diff'),'L01','kills',['sides.radiant.score','sides.dire.score'],'existing coherent native Radiant score - Dire score');
 for(const lead of LEAD_KEYS)base(lead,nativeValue(lead),lead.startsWith('nw_')?'L02':lead.startsWith('level_')?'L04':lead.startsWith('score_')?'L01':'L03',LEAD_UNITS[lead],['native.vector.roshan.'+lead],'existing same-frame native component Radiant-Dire lead; five observed players per side required for economy aggregates');
 for(const [name,[familyId,units]]of Object.entries(ROSHAN_BASE_FIELDS))base(name,nativeValue(name),familyId,units,['native.vector.roshan.'+name],'direct projection of existing reviewed causal Roshan/Aegis component value; preserve missing, rule/event qualification and unresolved raw timer semantics; no new inference');
 const historiesByHero=new Map(players.map(p=>[Number(p.identity.heroId),contextValues(context,p)]));
 const relByHero=new Map(players.map(p=>[Number(p.identity.heroId),relationalFor(relational,p)]));
 const profileDefinition=key=>relational.profiles.players.find(p=>p.statistics?.[key])?.statistics[key]??null;
 const teamDefinition=key=>relational.profiles.teams.find(p=>p.statistics?.[key])?.statistics[key]??null;
 const profileBySide={};
 for(const side of SIDES)for(const k of CONTEXT_KEYS)profileBySide[side+'|'+k]=summary(players.filter(p=>p.identity.side===side).map(p=>historiesByHero.get(Number(p.identity.heroId))[k]));
 for(const heroId of HERO_IDS){
  const p=players.find(p=>Number(p.identity.heroId)===heroId),sign=p?.identity.side==='radiant'?1:-1,h=p?historiesByHero.get(heroId):null;
  for(const [metric,[fieldName,units,familyId]]of Object.entries(METRICS))put(`draft_live.hero.${heroId}.${metric}.observed_value`,p?product(field(p[fieldName]),sign):0,{familyId,formula:'side_sign * literal native metric for raw-confirmed hero; public player account not required; no field substitution',units,inputScopes:['current_live','current_draft'],inputFields:[fieldName]});
  for(const [metric,[fieldName,units,familyId]]of Object.entries(METRICS))for(const key of CONTEXT_KEYS)for(const term of ['history_product','history_minute_product']){
   const v=p?product(field(p[fieldName]),h[key],term==='history_minute_product'?minute:1,sign):0;
   put(`draft_live.hero.${heroId}.${metric}.${key}.${term}`,v,{familyId:'L14',formula:'side_sign * native_metric * qualified_frozen_history'+(term==='history_minute_product'?' * (clock_seconds / 60)':''),units:units+' * '+(CONTEXT_UNITS[key]??'fraction')+(term==='history_minute_product'?' * minute':''),inputScopes:['current_live','current_draft','prior_maps'],inputFields:[fieldName,key,'providerGameClockSeconds'],historyDefinitions:[key]});
  }
  for(const [key,[fieldName,units,familyId]]of Object.entries(PLAYER_DYNAMICS))put(`draft_live.hero.${heroId}.${key}`,p?product(field(p.dynamic?.[fieldName]),sign):0,{familyId,formula:'side_sign * observed provider field; no state interpretation',units,inputScopes:['current_live','current_draft'],inputFields:['players.dynamic.'+fieldName]});
  const rawBool=p?.dynamic?.hasBuyback;
  put(`draft_live.hero.${heroId}.has_buyback_raw`,p?(rawBool?.missing===false&&typeof rawBool.value==='boolean'?Number(rawBool.value):null):0,{familyId:'L15',formula:'literal observed has_buyback boolean mapped false=0,true=1; no cooldown/gold inference and no semantic availability claim',units:'provider_boolean',inputScopes:['current_live','current_draft'],inputFields:['players.dynamic.hasBuyback']});
  put(`draft_live.hero.${heroId}.net_gold_raw`,p?product(field(p.netGoldRaw),sign):0,{familyId:'L02',formula:'side_sign * literal provider net_gold; semantics unresolved; not earned gold or native NW',units:'provider_net_gold_raw',inputScopes:['current_live','current_draft'],inputFields:['players.netGoldRaw']});
  for(let slot=0;slot<6;slot++)put(`draft_live.hero.${heroId}.item${slot}_raw_id`,p?field(p.observedItemFields?.[slot]):0,{familyId:'L13',formula:'literal provider item'+slot+' ID; hero identity or nonapplicable structural zero; no active/backpack/empty inference',units:'categorical_provider_item_id',inputScopes:['current_live','current_draft'],inputFields:['observedItemFields['+slot+']']});
  for(const [metric,[fieldName,units]]of Object.entries(METRICS))for(const key of ['hero_minute_residual','hero_minute_standardized']){
   const references=context.featurePayload.heroMinuteReferences.filter(r=>Number(r.heroId)===heroId&&r.metric===metric&&Number.isSafeInteger(r.minute)&&r.minute<=minute&&minute-r.minute<=5&&finite(r.mean)&&finite(r.scale)&&r.scale>0&&Number.isSafeInteger(r.supportMaps)&&r.supportMaps>=1).sort((a,b)=>b.minute-a.minute);
   const ref=references.length&&references.filter(x=>x.minute===references[0].minute).length===1?references[0]:null,v=p?field(p[fieldName]):null;
   put(`draft_live.hero.${heroId}.${metric}.${key}`,p?(v!==null&&ref?sign*(v-ref.mean)/(key==='hero_minute_standardized'?ref.scale:1):null):0,{familyId:'L06',formula:'side_sign * (native_metric - latest qualified prior hero/minute mean)'+(key==='hero_minute_standardized'?' / prior sample scale':''),units:key==='hero_minute_standardized'?'z_score':units,inputScopes:['current_live','current_draft','prior_maps'],inputFields:[fieldName,'heroMinuteReferences','providerGameClockSeconds']});
  }
 }
 for(const side of [...SIDES,'diff'])for(const [metric,[fieldName,units]]of Object.entries(METRICS))for(const key of CONTEXT_KEYS)for(const term of ['native_history_sum','native_weighted_history_mean','native_opponent_history_product_sum']){
  const calc=s=>{const ps=players.filter(p=>p.identity.side===s),opposite=s==='radiant'?'dire':'radiant',vs=ps.map(p=>field(p[fieldName])),hs=ps.map(p=>historiesByHero.get(Number(p.identity.heroId))[key]);if(!vs.every(finite))return null;if(term==='native_opponent_history_product_sum'){const opp=profileBySide[opposite+'|'+key];return opp?vs.reduce((a,b)=>a+b,0)*opp.mean:null;}if(!hs.every(finite))return null;const sum=vs.reduce((a,b,i)=>a+b*hs[i],0);return term==='native_history_sum'?sum:vs.reduce((a,b)=>a+b,0)>0?sum/vs.reduce((a,b)=>a+b,0):null;};
  const v=side==='diff'?(finite(calc('radiant'))&&finite(calc('dire'))?calc('radiant')-calc('dire'):null):calc(side);
  put(`draft_live.team.${side}.${metric}.${key}.${term}`,v,{familyId:'L14',formula:term+' over five same-frame players; all required history present; diff=Radiant-Dire; descriptive interaction, not fitted strength',units:term==='native_weighted_history_mean'?(CONTEXT_UNITS[key]??'fraction'):units+' * '+(CONTEXT_UNITS[key]??'fraction'),inputScopes:['current_live','prior_maps'],inputFields:[fieldName,key],historyDefinitions:[key]});
 }
 for(const basis of ['native_nw','native_gpm'])for(let rank=1;rank<=5;rank++)for(const side of SIDES){
  const ps=players.filter(p=>p.identity.side===side),fieldName=METRICS[basis][0],ranked=ps.every(p=>field(p[fieldName])!==null)?[...ps].sort((a,b)=>field(b[fieldName])-field(a[fieldName])||Number(a.identity.heroId)-Number(b.identity.heroId)):null,p=ranked?.[rank-1];
  for(const key of HISTORICAL_PLAYER_PROFILE_KEYS){const prof=p?relByHero.get(Number(p.identity.heroId)):null,h=historyValue(prof,key),d=profileDefinition(key);for(const [metric,[nativeField,units]]of Object.entries(METRICS))put(`draft_live.economic_rank.${basis}.${rank}.${side}.${metric}.${key}.product`,p?product(field(p[nativeField]),h):null,{familyId:'L14',formula:'native_metric * qualified player history at native economic rank; ties by hero ID; rank is not role',units:units+' * '+(d?.units??'unresolved_historical_units'),inputScopes:['current_live','prior_maps','current_draft'],inputFields:[nativeField,key],historyDefinitions:[d?.definition??key]});}
 }
 for(const side of SIDES){const team=relational.profiles.teams.find(p=>p.side===side&&p.teamId===o.sides[side].teamId);for(const rk of ROSHAN_KEYS)for(const lead of LEAD_KEYS)for(const finish of FINISH_KEYS){const r=native.vector.values[native.vector.names.indexOf('roshan.'+rk)],l=native.vector.values[native.vector.names.indexOf('roshan.'+lead)],h=historyValue(team,finish),d=teamDefinition(finish);put(`draft_live.roshan.${side}.${rk}.${lead}.${finish}`,product(r,l,h),{familyId:'R06',formula:'existing causal Roshan feature * coherent native Radiant-Dire lead * qualified same-side frozen historical closing-style statistic; no invented timer semantics',units:(ROSHAN_UNITS[rk]??'seconds')+' * '+LEAD_UNITS[lead]+' * '+(d?.units??'unresolved_historical_units'),inputScopes:['current_live','prior_maps'],inputFields:['roshan.'+rk,'roshan.'+lead,finish],historyDefinitions:[d?.definition??finish]});}}
 const clock=field(o.providerGameClockSeconds);
 for(const lead of LEAD_KEYS)for(const window of WINDOWS){
  // Same game-clock values can have distinct causal receipts. The latest
  // admissible anchor is an INDEX in receipt order; filtering by clock alone
  // would accidentally reintroduce an older equal-clock state before it.
  const target=clock-window,anchorIndex=leadHistory.findLastIndex(p=>p.clock<=target&&target-p.clock<=30),rows=anchorIndex>=0?leadHistory.slice(anchorIndex).filter(p=>p.clock<=clock):[],valid=rows.length>=2&&rows.every(p=>finite(p.leads[lead]));
  const vs=rows.map(p=>p.leads[lead]);let changes=null,lastChange=null;
  if(valid){changes=0;let sign=0;for(const p of rows){const current=Math.sign(p.leads[lead]);if(current!==0){if(sign!==0&&current!==sign){changes++;lastChange=p.clock;}sign=current;}}}
  const stats={observed_span_seconds:rows.length?clock-rows[0].clock:null,observations:rows.length||null,min:valid?Math.min(...vs):null,max:valid?Math.max(...vs):null,recovery_from_observed_min:valid?vs.at(-1)-Math.min(...vs):null,retreat_from_observed_max:valid?Math.max(...vs)-vs.at(-1):null,observed_sign_changes:changes,seconds_since_observed_sign_change:lastChange===null?null:clock-lastChange,change_per_played_minute:valid?(vs.at(-1)-vs[0])/((clock-rows[0].clock)/60):null};
  for(const [stat,v]of Object.entries(stats)){
   const base=`draft_live.trajectory.${lead}.past_${window}s.${stat}`,definition={familyId:'L09',formula:stat+' across retained same-map/profile/identity frames from latest receipt-order anchor <= current-clock-window, max30s anchor gap; exclude earlier equal-clock receipts; complete finite lead required; observed transitions are not unseen event times',units:stat.includes('seconds')?'seconds':stat==='observations'||stat==='observed_sign_changes'?'count':stat==='change_per_played_minute'?LEAD_UNITS[lead]+'_per_minute':LEAD_UNITS[lead],inputScopes:['current_live'],inputFields:[lead,'retained causal native prefix','providerGameClockSeconds']};
   put(base,v,definition);
   for(const side of SIDES){const team=relational.profiles.teams.find(p=>p.side===side&&p.teamId===o.sides[side].teamId);for(const historyKey of ['formWinFraction30d','late40Fraction90d','winMeanDurationSeconds90d']){const d=teamDefinition(historyKey);put(base+'.'+side+'.'+historyKey+'.product',product(v,historyValue(team,historyKey)),{...definition,familyId:'L14',formula:definition.formula+' * qualified frozen '+historyKey,units:definition.units+' * '+(d?.units??'unresolved_historical_units'),inputScopes:['current_live','prior_maps'],historyDefinitions:[d?.definition??historyKey]});}}
  }
 }
 if(names.length!==new Set(names).size||names.length!==values.length||definitions.length!==names.length)throw Error('dynamic_interaction_schema');
 const semanticSchemaHash=evidenceHash({contract:CONTRACT,nativeComponentContracts:native.componentContracts,historicalProducer:{contract:context.producer.contract,minimumSupport:context.producer.minimumSupport,newLateMinimumSupport:context.producer.newLateMinimumSupport,nativeProofPolicy:context.producer.nativeProofPolicy,nativeMinuteSelection:context.producer.nativeMinuteSelection},relationalSchemaHash:relational.schemaHash,definitions});
 return {contract:CONTRACT,status:'diagnostic_produced',matchId:o.matchId,observationId:o.observationId,sourceProfile:PROFILE,knownAt:o.source.capture.receivedAt,eventClockSeconds:field(o.providerGameClockSeconds),nativeBundle:native,vector:{names,values,masks,definitions,featureCount:names.length,semanticSchemaHash},componentContracts:{native:BUNDLE_CONTRACT,history:context.contract,relational:relational.contract},families:[...new Set(definitions.map(d=>d.familyId))].map(familyId=>({familyId,status:'implemented_partial_diagnostic',fullFamilyComplete:false})),historyReuse:{legacyV2GateChanged:false,v3DisguisedAsV2:false,nativeStaticContextSupplied:false,sourceFieldSubstitution:false,handmadeStrengthCoefficient:false},noNetWorthDividedByMinuteGpm:true};
}
