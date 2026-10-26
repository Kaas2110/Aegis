/** Retained-only candidate measurement bridge; never a serving source adapter.
 * Uses existing OpenDota retained-response verification and original Steam raw
 * replay. Source-code study qualifies a candidate formula, not an archive build
 * or automatic equivalence of measurements. No IO/providers/models/weights. */
import {readRetainedOpenDotaResponse} from './retainedOpenDotaFacts.mjs';
import {readPinnedHistoricalJson} from './historicalAlignment.mjs';
import {verifyRecordedNormalizedObservation} from './recordedNormalization.mjs';
import {instantNs} from './causalTime.mjs';
import {snapshotPlainRecord} from './diagnosticResourceArena.mjs';
export const OPENDOTA_STEAM_BRIDGE_CONTRACT='aegis.retained-opendota-steam-measurement-bridge.v1';
export const OPENDOTA_PARSER_STUDY_PIN='927adf6bbd1fd321b711f544a5d754bfe75d89a7';
export const OPENDOTA_CORE_STUDY_PIN='86e09304d7775540fd5e22e9a94d930034c4da09';
const flags={diagnosticOnly:true,eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false,providerCalls:0,trainingRuns:0};
const fail=reason=>{throw Error('opendota_steam_bridge:'+reason);},finite=x=>typeof x==='number'&&Number.isFinite(x),HASH=/^[a-f0-9]{64}$/;
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const side=slot=>Number.isSafeInteger(slot)&&slot>=0&&slot<=4?'radiant':Number.isSafeInteger(slot)&&slot>=128&&slot<=132?'dire':null;
const id=x=>(typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x))||(Number.isSafeInteger(x)&&x>0);
const account=x=>id(x)&&BigInt(x)<4294967295n?String(x):null;
const PORTS=freeze([
 {field:'gold_t',port:'historical.opendota.cumulative_earned_gold',quantity:'cumulative_earned_gold',units:'gold_earned',steamCounterpart:null,alignment:'required_base_times',sourceProperty:'m_iTotalEarnedGold'},
 {field:'networth_t',port:'historical.opendota.native_net_worth',quantity:'current_assets_value',units:'gold_current_assets',steamCounterpart:'steam.GetLiveLeagueGames.v1.scoreboard.net_worth',alignment:'optional_exact_times_only',sourceProperty:'m_iNetWorth'},
 {field:'xp_t',port:'historical.opendota.cumulative_earned_xp',quantity:'cumulative_earned_experience',units:'xp_earned',steamCounterpart:null,alignment:'required_base_times',sourceProperty:'m_iTotalEarnedXP'},
 {field:'lh_t',port:'historical.opendota.cumulative_last_hits',quantity:'cumulative_last_hits',units:'last_hits',steamCounterpart:'steam.GetLiveLeagueGames.v1.scoreboard.last_hits',alignment:'required_base_times',sourceProperty:'m_iLastHitCount'},
 {field:'dn_t',port:'historical.opendota.cumulative_denies',quantity:'cumulative_denies',units:'denies',steamCounterpart:'steam.GetLiveLeagueGames.v1.scoreboard.denies',alignment:'required_base_times',sourceProperty:'m_iDenyCount'},
 {field:'hero_damage_t',port:'historical.opendota.cumulative_hero_damage',quantity:'cumulative_hero_damage_counter',units:'damage',steamCounterpart:null,alignment:'optional_exact_times_only',sourceProperty:'rounded_native_hero_damage_counter'},
 {field:'tower_damage_t',port:'historical.opendota.cumulative_tower_damage',quantity:'cumulative_tower_damage_counter',units:'damage',steamCounterpart:null,alignment:'optional_exact_times_only',sourceProperty:'rounded_native_tower_damage_counter'},
 {field:'camps_stacked_t',port:'historical.opendota.cumulative_camps_stacked',quantity:'cumulative_camps_stacked',units:'camps',steamCounterpart:null,alignment:'optional_exact_times_only',sourceProperty:'m_iCampsStacked'},
 {field:'hero_healing_t',port:'historical.opendota.cumulative_filtered_healing',quantity:'cumulative_healing_excluding_illusions_and_self',units:'healing',steamCounterpart:null,alignment:'exact_times_and_source_rules_required',sourceProperty:'filtered_heal_events'}
]);
export const OPENDOTA_STEAM_CANDIDATE_PORT_MATRIX=freeze({contract:OPENDOTA_STEAM_BRIDGE_CONTRACT,parserRepository:'odota/parser',parserCommit:OPENDOTA_PARSER_STUDY_PIN,implementationFamily:'java_blob',coreCommit:OPENDOTA_CORE_STUDY_PIN,ports:PORTS,nonAliases:{radiant_gold_adv:'earned-gold lead in pinned implementation; NOT native net-worth lead',net_gold:'separate Steam endpoint field; physical equivalence unqualified',gold_per_min:'final scalar is not early GPM',gold_t:'not wallet, not net worth, not early GPM',xp_t:'not level or XPM',purchase_log:'purchase events do not establish complete current inventory'},parseVersionAloneQualifiesImplementation:false,automaticMeasurementSubstitution:false,...flags});

function review(source,parserReviewInput,expectedParserReviewSha256,computedAt){
 if(parserReviewInput===null)return{qualified:false,reason:'archive_parser_implementation_lineage_unproven',reference:null};
 const p=readPinnedHistoricalJson(parserReviewInput,{maxBytes:65536}),r=p.data;if(!HASH.test(expectedParserReviewSha256??'')||p.pin.sha256!==expectedParserReviewSha256||r.contract!=='aegis.opendota-parser-lineage-review.v1'||r.reviewed!==true||r.parserRepository!=='odota/parser'||r.parserCommit!==OPENDOTA_PARSER_STUDY_PIN||r.implementationFamily!=='java_blob'||r.matchId!==source.matchId||r.payloadSha256!==source.payloadSha256||r.evidenceBasis!=='retained_parser_implementation_lineage'||typeof r.evidenceRef!=='string'||r.evidenceRef.length<1||r.evidenceRef.length>512||instantNs(r.reviewedAt)===null||instantNs(r.reviewedAt)>instantNs(computedAt))fail('host_pinned_parser_lineage_review');
 return{qualified:true,reason:'explicit_host_pinned_lineage_not_parse_version',reference:p.pin};
}
function roster(payload){if(!Array.isArray(payload.players)||payload.players.length>10)fail('player_roster_bound');const slots=new Set(),heroes=new Set(),accounts=new Set(),players=[];for(const p of payload.players){const playerAccount=account(p?.account_id);if(!p||!side(p.player_slot)||slots.has(p.player_slot)||!Number.isSafeInteger(p.hero_id)||p.hero_id<1||p.hero_id>250||heroes.has(p.hero_id)||playerAccount!==null&&accounts.has(playerAccount))fail('player_identity');slots.add(p.player_slot);heroes.add(p.hero_id);if(playerAccount!==null)accounts.add(playerAccount);players.push(p);}return players;}
function sample(player,port,cutoff,tolerance,sourceMeaningQualified){
 const base={port:port.port,field:port.field,quantity:port.quantity,units:port.units,steamCounterpart:port.steamCounterpart,sourceMeaningQualified,available:false,value:null,sampleAtGameSeconds:null,anchorLagSeconds:null,causalHorizonGameSeconds:null,reason:null};
 if(!Object.hasOwn(player,port.field))return{...base,reason:'source_field_absent'};if(player[port.field]===null)return{...base,reason:'source_field_explicit_null'};
 const times=player.times,values=player[port.field];if(!Array.isArray(times)||times.length>20000||times.some((t,i)=>!Number.isSafeInteger(t)||t<0||t>86400||i>0&&t<=times[i-1]))return{...base,reason:'time_axis_invalid'};
 if(sourceMeaningQualified&&times.some(t=>t%60!==0))return{...base,reason:'time_axis_incompatible_with_reviewed_java_minute_profile'};
 if(!Array.isArray(values))return{...base,reason:'source_array_invalid'};if(values.length!==times.length)return{...base,reason:'array_time_alignment_ambiguous'};
 let index=-1;for(let i=0;i<times.length&&times[i]<=cutoff;i++)index=i;if(index<0)return{...base,reason:'no_at_or_before_sample'};
 if(cutoff-times[index]>tolerance)return{...base,reason:'preceding_sample_lag_exceeded'};
 // Only the retained prefix values are inspected as causal operands. No later
 // sample participates in an interpolation or backwards cumulative check.
 if(values.slice(0,index+1).some(v=>!finite(v)||v<0))return{...base,reason:'nonfinite_or_negative_prefix_value'};
 return{...base,available:true,value:values[index],sampleAtGameSeconds:times[index],anchorLagSeconds:cutoff-times[index],causalHorizonGameSeconds:times[index],reason:sourceMeaningQualified?'qualified_candidate_measurement':'literal_array_candidate_unqualified_lineage'};
}

/** Legitimate post-match reconstruction stays explicitly separate from original
 * online observation. No source receipt is rewritten to event/start time. */
export function extractRetainedOpenDotaPrefix({sourceInputs,decisionGameSeconds,computedAt,maximumAnchorLagSeconds=30,parserReviewInput=null,expectedParserReviewSha256=null}={}){
 if(!finite(decisionGameSeconds)||decisionGameSeconds<0||decisionGameSeconds>86400||instantNs(computedAt)===null||!finite(maximumAnchorLagSeconds)||maximumAnchorLagSeconds<0||maximumAnchorLagSeconds>300)fail('prefix_horizon_or_bound');
 const checked=readRetainedOpenDotaResponse(sourceInputs);if(instantNs(checked.source.receivedAt)>instantNs(computedAt)||checked.source.payloadPersistedAt!==null&&instantNs(checked.source.payloadPersistedAt)>instantNs(computedAt))fail('source_after_materialization');const lineage=review(checked.source,parserReviewInput,expectedParserReviewSha256,computedAt),players=roster(checked.payload).map(p=>({playerSlot:p.player_slot,side:side(p.player_slot),heroId:p.hero_id,accountId:account(p.account_id),samples:PORTS.map(port=>sample(p,port,decisionGameSeconds,maximumAnchorLagSeconds,lineage.qualified))}));
 const nw=players.map(p=>({player:p,sample:p.samples.find(x=>x.field==='networth_t')})),coherent=nw.length===10&&['radiant','dire'].every(s=>nw.filter(x=>x.player.side===s).length===5)&&nw.every(x=>x.sample.available)&&new Set(nw.map(x=>x.sample.sampleAtGameSeconds)).size===1;
 const totals=Object.fromEntries(['radiant','dire'].map(s=>[s,coherent?nw.filter(x=>x.player.side===s).reduce((a,x)=>a+x.sample.value,0):null])),teamNetWorth=coherent&&Object.values(totals).every(finite)?{available:true,quantity:'current_assets_value',units:'gold_current_assets',sampleAtGameSeconds:nw[0].sample.sampleAtGameSeconds,...totals,sourceMeaningQualified:lineage.qualified,source:'sum_of_ten_same_time_native_networth_t_samples'}:{available:false,quantity:'current_assets_value',reason:'ten_coherent_same_time_finite_native_networth_samples_required',sourceMeaningQualified:false};
 return freeze({contract:OPENDOTA_STEAM_BRIDGE_CONTRACT,matchId:checked.source.matchId,teamIds:{radiant:id(checked.payload.radiant_team_id)?String(checked.payload.radiant_team_id):null,dire:id(checked.payload.dire_team_id)?String(checked.payload.dire_team_id):null},source:checked.source,decisionGameSeconds,maximumAnchorLagSeconds,parserLineage:lineage,observedParseVersion:checked.payload.version??null,players,teamNetWorth,rawRadiantGoldAdvPresent:Object.hasOwn(checked.payload,'radiant_gold_adv'),radiantGoldAdvUsedAsNetWorth:false,finalGpmUsedForEarlyState:false,provenance:{rawObservationBasis:'retrospective_source_reconstruction',featureMaterializationBasis:'replayed_derived_features',sourceReceivedAt:checked.source.receivedAt,computedAt,originalLiveAvailabilityProven:false,originallyIssuedPrediction:false,historyAsOfAdmissionStillRequired:true},...flags});
}

/** Per-field horizon; the event's displayed timestamp alone is insufficient.
 * Pause duration is WALL time. It is deliberately not added to GAME time to
 * invent a resume point; no resume-order evidence exists in this input profile. */
export function evaluateOpenDotaDerivedFieldHorizon({kind,event,decisionGameSeconds}={}){
 event=snapshotPlainRecord(event??{},{maxKeys:64});if(!finite(decisionGameSeconds)||decisionGameSeconds<0||decisionGameSeconds>86400)fail('event_horizon');let horizon=null,reason;
 if(kind==='death_duration'){if(finite(event.time)&&event.time>=0&&finite(event.time_dead)&&event.time_dead>=0){horizon=Math.max(event.time+event.time_dead,event.time+4);reason='respawn_and_reincarnation_classification_horizon';}else reason='death_duration_or_respawn_horizon_missing';}
 else if(kind==='death_gold'){if(finite(event.time)&&event.time>=0){horizon=event.time+4;reason='death_classification_and_two_second_gold_matching_horizon';}else reason='death_event_time_missing';}
 else if(kind==='finalized_teamfight'){if(finite(event.start)&&finite(event.end)&&finite(event.last_death)&&event.start>=-15&&event.end>=event.start&&event.last_death>=event.start&&event.last_death<=event.end){horizon=Math.max(event.end,event.last_death+15);reason='fight_final_end_and_quiet_closure_horizon';}else reason='finalized_fight_closure_horizon_missing';}
 else if(kind==='pause_duration')reason='pause_resume_order_unproven_in_game_clock;wall_duration_is_not_game_elapsed';
 else if(kind==='position_est'){horizon=720;reason='role_heuristic_requires_full_10_to_12_minute_dependency_window';}
 else if(kind==='current_rank_or_benchmark')reason='request_time_enrichment_is_not_historical_asof_snapshot';
 else fail('unsupported_derived_field_kind');
 return freeze({contract:OPENDOTA_STEAM_BRIDGE_CONTRACT,kind,causalHorizonGameSeconds:horizon,admissibleAtGameCutoff:horizon!==null&&horizon<=decisionGameSeconds,reason,sourceMeaningQualificationStillRequired:true,originalAvailabilityProven:false,...flags});
}

/** Candidate paired measurement audit only. Ten identity/coherent-clock pairs
 * do not prove global source equivalence and do not alter any old model vector. */
export function compareRetainedOpenDotaNetWorthToSteam({sourceInputs,steamObservationInput,steamRawCaptureInput,computedAt,maximumAnchorLagSeconds=30,parserReviewInput=null,expectedParserReviewSha256=null}={}){
 const o=readPinnedHistoricalJson(steamObservationInput,{maxBytes:6*1024**2}),raw=readPinnedHistoricalJson(steamRawCaptureInput,{maxBytes:6*1024**2}),cap=o.data.source?.capture;if(!cap||raw.pin.sha256!==cap.rawSha256)fail('steam_raw_binding');const verification=verifyRecordedNormalizedObservation({body:Buffer.from(steamRawCaptureInput.utf8),endpoint:cap.endpoint,httpStatus:cap.httpStatus,requestStartedAt:cap.requestStartedAt,receivedAt:cap.receivedAt,persistedAt:cap.persistedAt,rawSha256:raw.pin.sha256,payloadRef:'journal:'+raw.pin.sha256,authenticatedAttempt:cap.authenticatedAttempt},o.data),steam=verification.replayedObservation,clock=steam.providerGameClockSeconds;if(clock.missing!==false||!finite(clock.value)||clock.value<0||instantNs(computedAt)===null||instantNs(steam.source.capture.receivedAt)>instantNs(computedAt)||instantNs(steam.source.capture.persistedAt)>instantNs(computedAt))fail('steam_clock_or_receipt');
 const historical=extractRetainedOpenDotaPrefix({sourceInputs,decisionGameSeconds:clock.value,computedAt,maximumAnchorLagSeconds,parserReviewInput,expectedParserReviewSha256});if(historical.matchId!==steam.matchId)fail('cross_map_measurement_pair');const pairs=[];
 for(const s of ['radiant','dire']){if(historical.teamIds[s]===null||steam.sides[s].teamId!==historical.teamIds[s])fail('team_side_identity_unproven');for(const p of steam.sides[s].players){const selected=historical.players.find(x=>String(x.heroId)===p.identity.heroId&&x.side===s),native=selected?.samples.find(x=>x.field==='networth_t');if(!selected||selected.accountId===null||p.identity.accountId===null||selected.accountId!==p.identity.accountId)fail('player_identity_or_side_unproven');if(native?.available!==true||p.netWorth.missing!==false||!finite(p.netWorth.value))fail('paired_native_networth_missing');pairs.push({heroId:selected.heroId,accountId:selected.accountId,side:s,openDotaValue:native.value,steamValue:p.netWorth.value,difference: p.netWorth.value-native.value,openDotaGameSeconds:native.sampleAtGameSeconds,steamGameSeconds:clock.value,anchorLagSeconds:clock.value-native.sampleAtGameSeconds});}}
 if(pairs.length!==10||new Set(pairs.map(p=>p.heroId)).size!==10||new Set(pairs.map(p=>p.openDotaGameSeconds)).size!==1)fail('ten_same_clock_identity_pairs_required');return freeze({contract:OPENDOTA_STEAM_BRIDGE_CONTRACT,matchId:steam.matchId,comparison:'candidate_identity_and_clock_checked_pairs_only',quantity:'current_assets_value',units:'gold_current_assets',parserLineage:historical.parserLineage,steamSourceProfile:steam.dynamic.sourceProfile,sourcePins:{openDotaReceipt:historical.source.receiptSha256,openDotaPayload:historical.source.payloadSha256,steamObservation:o.pin.sha256,steamRaw:raw.pin.sha256},pairs,globalMeasurementEquivalenceProven:false,automaticMeasurementSubstitution:false,source95Claimed:false,...flags});
}
