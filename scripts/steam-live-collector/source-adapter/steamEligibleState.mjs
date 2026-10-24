/** Owned eligibility over original committed GLG bytes, separate from inference.
 * A receipt proves local availability, not provider event time. Read expiry at
 * the actual serving horizon; a replay's original horizon never asserts live now.
 * Restart reconstructs these opaque tokens by replaying original receipts.
 */
import {instantNs} from './causalTime.mjs';
import {normalizeLocalCapture,canonical,sha} from './steamLiveAdapter.mjs';
import {readPinnedHistoricalJson} from './historicalAlignment.mjs';
import {classifySteamObservationPhase,STEAM_ELIGIBLE_STATE_FRESHNESS_SECONDS} from './steamPhasePolicy.mjs';
import {steamObservationIdentity} from './steamObservationIdentity.mjs';
import {readSteamProgressionProof,PROGRESSION_POLICY} from './steamProgressionAdmission.mjs';
import {isPlausibleSteamClockAdvance} from './steamClockProgress.mjs';

export const ELIGIBLE_STATE_CONTRACT='aegis.steam-eligible-state.v1';
export const STEAM_PAUSE_CAPABILITY=Object.freeze({status:'unavailable_source_evidence',profile:'steam.GetLiveLeagueGames.v1.scoreboard',reason:'no_qualified_live_pause_or_current_state_timestamp_in_retained_profile',canMintConfirmedPause:false});
const held=new WeakMap(),NS=1000000000n,LIMIT=BigInt(STEAM_ELIGIBLE_STATE_FRESHNESS_SECONDS)*NS;
const flags={eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false,publicPromotion:false};
const hash=x=>sha(canonical(x));
const iso=ns=>new Date(Number(ns/NS)*1000).toISOString().replace('.000Z','.'+String(ns%NS).padStart(9,'0')+'Z');
const immutable=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))immutable(v);Object.freeze(x);}return x;};
const validMap=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x)&&BigInt(x)<(1n<<64n);

function decode(entry,decision){
 const receipt=readPinnedHistoricalJson(entry?.receiptInput,{maxBytes:65536}),r=receipt.data,input=entry?.rawInput;
 if(typeof input?.utf8!=='string'||input.pin?.bytes!==Buffer.byteLength(input.utf8)||input.pin.bytes<1||input.pin.bytes>6*1024*1024||sha(input.utf8)!==input.pin.sha256)throw Error('eligible_state_actual_pinned_raw_required');
 if(r.version!=='steam-live-diagnostic-collector.v1'||r.source!=='steam'||r.diagnosticOnly!==true||r.servingEnabled!==false||r.trainingEnabled!==false||r.publicPromotion!==false||typeof r.requestId!=='string'||!r.requestId.length||r.requestId.length>128||r.rawSha256!==input.pin.sha256||r.rawFile!=='raw/'+input.pin.sha256+'.body'||r.payloadRef!=='journal:'+input.pin.sha256||r.bodyBytes!==input.pin.bytes)throw Error('eligible_state_committed_receipt_required');
 const received=instantNs(r.receivedAt),started=instantNs(r.requestStartedAt),persisted=instantNs(r.rawPersistedAt),complete=instantNs(r.completedAt);
 if([received,started,persisted,complete].some(x=>x===null)||started>received||received>persisted||persisted>complete||complete>decision)throw Error('eligible_state_capture_chronology');
 let normalized=null;try{normalized=normalizeLocalCapture({endpoint:r.endpoint,httpStatus:r.httpStatus,requestStartedAt:r.requestStartedAt,receivedAt:r.receivedAt,persistedAt:r.rawPersistedAt,authenticatedAttempt:true,body:Buffer.from(input.utf8),rawSha256:input.pin.sha256,payloadRef:r.payloadRef});}catch{}
 return{r,received,complete,normalized,receiptSha256:receipt.pin.sha256,rawSha256:input.pin.sha256};
}

function view(s){return immutable({contract:ELIGIBLE_STATE_CONTRACT,matchId:s.matchId,classification:s.classification,reason:s.reason,lastHttpReceiptAt:s.lastHttpReceiptAt,lastConfirmedAt:s.lastConfirmedAt,lastClockAdvanceAt:s.lastClockAdvanceAt,providerGameClockSeconds:s.providerGameClockSeconds,maximumClockSeconds:s.maximumClockSeconds,identityHash:s.identityHash,observationId:s.observationId,rawSha256:s.rawSha256,confirmationReceiptSha256:s.confirmationReceiptSha256,confirmationReceivedAt:s.confirmationReceivedAt,expiresAt:s.lastConfirmedNs===null?null:iso(s.lastConfirmedNs+LIMIT),pauseEvidenceStatus:STEAM_PAUSE_CAPABILITY.status,terminal:s.terminal,continuityGeneration:s.continuityGeneration,latestObservationId:s.latestObservationId,latestRawSha256:s.latestRawSha256,latestReceivedAt:s.latestReceivedAt});}

const identitySnapshot=o=>Object.fromEntries(['radiant','dire'].map(side=>[side,{teamId:o.sides[side].teamId,players:Object.fromEntries(o.sides[side].players.map(p=>[p.identity.heroId,{accountId:p.identity.accountId,teamId:p.identity.teamId}]))}]));
function compareIdentity(previous,current){
 if(previous===null)return'initial';let disclosed=false;
 const field=(a,b)=>{if(a!==null&&a!==b)return false;if(a===null&&b!==null)disclosed=true;return true;};
 for(const side of ['radiant','dire']){
  const a=previous[side],b=current[side];if(!field(a.teamId,b.teamId))return'conflict';
  const heroes=Object.keys(a.players);if(heroes.length!==Object.keys(b.players).length)return'conflict';
  for(const hero of heroes){const x=a.players[hero],y=b.players[hero];if(!y||!field(x.accountId,y.accountId)||!field(x.teamId,y.teamId))return'conflict';}
 }
 return disclosed?'monotone_disclosure':'same';
}

export function readSteamEligibleState(privateToken,{matchId,decisionAt}={}){
 const s=held.get(privateToken),decision=instantNs(decisionAt);
 const invalid=reason=>({contract:ELIGIBLE_STATE_CONTRACT,status:'unavailable',reason,stateView:s?view(s):null,eligibleForRetainingForecast:false,mayGenerateNewVector:false,ageSeconds:null,userMessage:'Прогноз недоступен',...flags});
 if(!s)return invalid('owned_eligible_state_required');
 if(!validMap(matchId)||matchId!==s.matchId||decision===null||s.lastDecisionNs>decision)return invalid('eligible_state_map_or_read_horizon');
 if(s.terminal||s.integrityBlocked)return invalid(s.reason);
 if(s.lastConfirmedNs===null)return invalid('no_qualified_current_state');
 const age=decision-s.lastConfirmedNs;if(age<0n)return invalid('qualified_state_after_read_horizon');
 if(age>LIMIT)return{...invalid('eligible_state_expired'),ageSeconds:Number(age)/1e9};
 return{contract:ELIGIBLE_STATE_CONTRACT,status:'eligible_retention_candidate',reason:s.classification==='unknown_repeated'?'retaining_last_qualified_state_until_expiry':s.reason,stateView:view(s),eligibleForRetainingForecast:true,mayGenerateNewVector:false,ageSeconds:Number(age)/1e9,userMessage:null,...flags};
}

/** Return authority is process-owned. Public stateView/provenance cannot restore
 * or mint it. A pause flag supplied by a caller is deliberately unsupported.
 * barrier can only reduce authority; source_gap preserves the original deadline.
 */
export function advanceSteamEligibleState(previousPrivateToken,{retainedEntry=null,matchId,decisionAt,progressionProof=null,stopped=false,barrier=null,...unsupported}={}){
 const previous=previousPrivateToken==null?null:held.get(previousPrivateToken),decision=instantNs(decisionAt);
 const reject=reason=>({contract:ELIGIBLE_STATE_CONTRACT,status:'unavailable',reason,nextPrivateToken:null,stateView:null,eligibleForRetainingForecast:false,mayGenerateNewVector:false,confirmationRenewed:false,resetDynamicWindows:true,...flags});
 if(previousPrivateToken!=null&&!previous)return reject('owned_eligible_state_required');
 if(!validMap(matchId)||decision===null||previous&&previous.matchId!==matchId||previous&&previous.lastDecisionNs>decision)return reject('eligible_state_map_or_decision');
 let s=previous?{...previous}:{matchId,lastDecisionNs:decision,lastHttpReceiptAt:null,lastHttpReceiptNs:null,lastReceiptBinding:null,lastConfirmedAt:null,lastConfirmedNs:null,lastClockAdvanceAt:null,providerGameClockSeconds:null,maximumClockSeconds:null,identityHash:null,identitySnapshot:null,observationId:null,rawSha256:null,confirmationReceiptSha256:null,confirmationReceivedAt:null,latestObservationId:null,latestRawSha256:null,latestReceivedAt:null,classification:'unqualified',reason:'no_qualified_current_state',terminal:false,integrityBlocked:false,continuityGeneration:0};
 s.lastDecisionNs=decision;let confirmationRenewed=false,mayGenerateNewVector=false,resetDynamicWindows=false;
 const invalidate=(reason,terminal=false)=>{s.integrityBlocked=true;s.terminal=s.terminal||terminal;s.classification=terminal?'terminal':'blocked_integrity';s.reason=reason;s.continuityGeneration++;resetDynamicWindows=true;};
 const finish=()=>{const token=Object.freeze({contract:ELIGIBLE_STATE_CONTRACT+'.private'});held.set(token,immutable(s));return{...readSteamEligibleState(token,{matchId,decisionAt}),nextPrivateToken:token,confirmationRenewed,mayGenerateNewVector,resetDynamicWindows};};
 if(Object.keys(unsupported).length){invalidate('unsupported_source_confirmation_input');return finish();}
 if(stopped||barrier&&barrier!=='source_gap'){invalidate(stopped?'manual_stop':String(barrier),barrier==='terminal');return finish();}
 if(s.terminal)return finish();
 if(barrier==='source_gap'){s.classification='unknown_source';s.reason='source_gap_original_deadline_preserved';s.continuityGeneration++;resetDynamicWindows=true;return finish();}
 if(retainedEntry===null)return finish();
 let d;try{d=decode(retainedEntry,decision);}catch(error){invalidate(error.message);return finish();}
 const binding=hash({rawSha256:d.rawSha256,receiptSha256:d.receiptSha256});
 if(s.lastHttpReceiptNs!==null&&d.received===s.lastHttpReceiptNs&&binding===s.lastReceiptBinding){s.classification='unknown_repeated';s.reason='identical_committed_capture_already_observed';return finish();}
 if(s.lastHttpReceiptNs!==null&&d.received<=s.lastHttpReceiptNs){invalidate('eligible_state_receipt_not_increasing');return finish();}
 const receiptGap=s.lastHttpReceiptNs===null?null:d.received-s.lastHttpReceiptNs;
 s.lastHttpReceiptAt=d.r.receivedAt;s.lastHttpReceiptNs=d.received;s.lastReceiptBinding=binding;s.latestReceivedAt=d.r.receivedAt;s.latestRawSha256=d.rawSha256;
 if(d.r.endpoint!=='GetLiveLeagueGames/v1'||d.r.httpStatus!==200||d.r.status!=='captured_diagnostic'||d.normalized?.rejections?.length||!['normalized_capture_diagnostic','empty_games_diagnostic'].includes(d.normalized?.status)){
  s.classification='unknown_source';s.reason='usable_current_source_packet_missing';s.continuityGeneration++;resetDynamicWindows=true;return finish();
 }
 const rows=d.normalized.observations.filter(o=>o.matchId===matchId);
 if(rows.length!==1){s.classification='unknown_source';s.reason='current_map_not_observed';s.continuityGeneration++;resetDynamicWindows=true;return finish();}
 const o=rows[0],phase=classifySteamObservationPhase(o,{decisionAt}),identity=steamObservationIdentity(o).key,clock=phase.clock;
 s.latestObservationId=o.observationId;
 if(phase.terminal){invalidate('confirmed_terminal_or_completion_indicator',true);return finish();}
 if(!phase.identity.fullHeroDraft||identity===null||clock===null||clock<0){invalidate('eligible_state_identity_or_clock_invalid');return finish();}
 const snapshot=identitySnapshot(o),identityRelation=compareIdentity(s.identitySnapshot,snapshot);
 if(identityRelation==='conflict'){invalidate('eligible_state_identity_changed');return finish();}
 if(identityRelation==='monotone_disclosure'){resetDynamicWindows=true;s.continuityGeneration++;}
 if(s.maximumClockSeconds!==null&&clock<s.maximumClockSeconds){invalidate('eligible_state_clock_rewind');return finish();}
 const explicit=phase.classification==='observed_live';
 const progressing=!explicit&&phase.classification==='unclassified_static_draft_only'?readSteamProgressionProof(progressionProof,{matchId,observationId:o.observationId,rawSha256:d.rawSha256,sourceProfile:o.dynamic.sourceProfile,identityHash:identity,observation:o,decisionAt}):null;
 const admitted=explicit||progressing?.accepted===true;
 if(!admitted){s.classification='unknown_source';s.reason='authoritative_live_admission_required';return finish();}
 if(decision-d.received>LIMIT){s.classification='unknown_source';s.reason='late_source_packet_cannot_renew';return finish();}
 const advanced=s.maximumClockSeconds!==null&&clock>s.maximumClockSeconds;
 const initial=s.lastConfirmedNs===null&&s.maximumClockSeconds===null;
 if(!initial&&!advanced){s.classification='unknown_repeated';s.reason='stationary_state_pause_unconfirmed';return finish();}
 // Compare clocks against their associated confirmation timestamps. An HTTP
 // repeat can be much newer than the qualified clock and cannot shorten that
 // clock's real elapsed interval, nor extend its qualified freshness deadline.
  if(advanced&&s.lastConfirmedNs!==null&&!isPlausibleSteamClockAdvance({anchorClockSeconds:s.maximumClockSeconds,anchorReceivedNs:s.lastConfirmedNs,clockSeconds:clock,receivedNs:d.received,slackSeconds:PROGRESSION_POLICY.clockPlausibilitySlackSeconds})){invalidate('eligible_state_implausible_clock_advance');return finish();}
 if(s.integrityBlocked||receiptGap!==null&&receiptGap>BigInt(PROGRESSION_POLICY.maximumReceiptGapSeconds)*NS||s.lastConfirmedNs!==null&&d.received-s.lastConfirmedNs>BigInt(PROGRESSION_POLICY.leaseSeconds)*NS){resetDynamicWindows=true;s.continuityGeneration++;}
 s.integrityBlocked=false;s.classification='confirmed_active';s.reason=initial?'first_authoritative_live_state':'native_game_clock_advanced';s.identityHash=identity;s.identitySnapshot=snapshot;s.lastConfirmedNs=d.received;s.lastConfirmedAt=d.r.receivedAt;s.confirmationReceivedAt=d.r.receivedAt;s.confirmationReceiptSha256=d.receiptSha256;s.observationId=o.observationId;s.rawSha256=d.rawSha256;s.providerGameClockSeconds=clock;s.maximumClockSeconds=clock;if(advanced)s.lastClockAdvanceAt=d.r.receivedAt;
 confirmationRenewed=true;mayGenerateNewVector=true;return finish();
}
