/** Draft-frozen history, separate from legacy prematch_frozen v2.
 * Pure local-byte replay and shared feature algebra; no IO, fit or serving change. */
import {instantNs} from './causalTime.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {createDraftCaptureProof,advanceObservedDraft,draftHash} from './observedDraft.mjs';
import {readPinnedHistoricalJson} from './historicalAlignment.mjs';
import {pinned,calculateHistoryCore,qualifyRetainedHistoryCorpus,FACTS_CONTRACT,NATIVE_CONTRACT} from './historyCalculationCore.mjs';
import {evidenceHash} from './playerHeroEconomyFeatures.mjs';
import {readRetainedMapViewCoreInputs} from './retainedHistoryViewInputs.mjs';

export const PRODUCER_CONTRACT='aegis.observed-draft-history-producer.v3';
export const CONTEXT_CONTRACT='aegis.frozen-team-style-context.v3';
export const DRAFT_METADATA_CONTRACT='aegis.retained-draft-capture-metadata.v1';
const MAX_BYTES=64*1024*1024,MAX_PREFIX=2048;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const account=x=>id(x)&&BigInt(x)<4294967295n;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const excluded={APIcalls:0,nativeFits:0,publicPromotion:false,eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
const blocked=(reason,audit={},bindings={})=>({contract:PRODUCER_CONTRACT,status:'blocked',reason,context:null,audit,bindings,...excluded});
const PERSONAL_KEYS=['recentForm','heroForm','playerLateTendency','playerHeroLateTendency'];
const TEAM_KEYS=['teamForm','aggression','lateTendency'];

/** A full bounded retained prefix is replayed from null, never from caller state.
 * Prefix completeness is NOT inferred from the presence of these retained bytes.
 * This revision uses unknown_prefix, so it cannot claim a zero-minute cohort. */
export function replayPinnedDraftPrefix({draftPrefixInputs,matchId,computedAt}={}){
 if(!id(matchId)||instantNs(computedAt)===null||!Array.isArray(draftPrefixInputs)||!draftPrefixInputs.length||draftPrefixInputs.length>MAX_PREFIX)throw Error('draft_history_prefix_contract_or_bound');
 let total=0,state=null,lastReceipt=null,accepted=0;
 const bindings=[],rejections=[];
 for(const entry of draftPrefixInputs){
  for(const input of [entry?.rawInput,entry?.metadataInput]){if(!Number.isSafeInteger(input?.pin?.bytes)||input.pin.bytes<1||(total+=input.pin.bytes)>MAX_BYTES)throw Error('draft_history_prefix_bytes_bound');}
  const raw=readPinnedHistoricalJson(entry.rawInput,{maxBytes:6*1024*1024}),meta=readPinnedHistoricalJson(entry.metadataInput,{maxBytes:256*1024}),m=meta.data;
  const allowed=['contract','matchId','observationId','decisionAt','capture','identityCorrection'];
  if(m.contract!==DRAFT_METADATA_CONTRACT||m.matchId!==matchId||!hash(m.observationId)||!object(m.capture)||Object.keys(m).some(k=>!allowed.includes(k)))throw Error('draft_history_metadata_contract');
  const captureFields=['endpoint','httpStatus','requestStartedAt','receivedAt','persistedAt','authenticatedAttempt'];
  if(Object.keys(m.capture).some(k=>!captureFields.includes(k)))throw Error('draft_history_capture_metadata_fields');
  const at=instantNs(m.capture.receivedAt),decision=instantNs(m.decisionAt),computed=instantNs(computedAt);
  if(at===null||decision===null||at>decision||decision>computed||lastReceipt!==null&&at<lastReceipt)throw Error('draft_history_prefix_chronology');
  lastReceipt=at;
  const capture={...m.capture,body:Buffer.from(entry.rawInput.utf8,'utf8'),rawSha256:raw.pin.sha256,payloadRef:'journal:'+raw.pin.sha256};
  const observations=normalizeLocalCapture(capture).observations.filter(o=>o.matchId===matchId&&o.observationId===m.observationId);
  if(observations.length!==1)throw Error('draft_history_observation_not_in_raw');
  const result=advanceObservedDraft(state,observations[0],{decisionAt:m.decisionAt,prefixBasis:'unknown_prefix',identityCorrection:m.identityCorrection??null,captureProof:createDraftCaptureProof(capture)});
  bindings.push({raw:raw.pin,metadata:meta.pin,observationId:m.observationId,receivedAt:m.capture.receivedAt});
  if(result.status!=='observed_draft_diagnostic'){
   if(result.reason==='ten_confirmed_heroes_and_sides_required'&&state===null){rejections.push({observationId:m.observationId,reason:result.reason});continue;}
   return{accepted:false,reason:result.reason,state:null,bindings,rejections};
  }
  accepted++;state=result.state;
 }
 if(!state)return{accepted:false,reason:'complete_draft_not_observed',state:null,bindings,rejections};
 return{accepted:true,reason:'pinned_draft_prefix_replayed',state,bindings,rejections,acceptedObservations:accepted,prefixCompleteness:'unproven',rawBytesVerified:true,zeroMinuteCohortClaimed:false};
}

/** Structural verification of a produced/stored diagnostic v3 context. A content
 * hash alone does not authenticate a receipt; production callers use the producer's
 * actual-byte replay and retain its input bindings. This is not serving admission. */
export function validateObservedDraftHistory(context,{matchId,decisionAt,readMode='recorded'}={}){
 const reject=reason=>({accepted:false,reason,featurePayload:null});
 if(!object(context)||context.contract!==CONTEXT_CONTRACT||context.mode!=='observed_draft_frozen'||!id(matchId)||context.matchId!==matchId||!['recorded','reconstructed'].includes(readMode))return reject('draft_history_contract');
 const cutoff=instantNs(context.historyCutoffAt),valid=instantNs(context.validFrom),computed=instantNs(context.computedAt),decision=instantNs(decisionAt);
 if(cutoff===null||valid===null||computed===null||decision===null||cutoff>valid||valid>computed||valid>decision||readMode==='recorded'&&computed>decision)return reject('draft_history_times');
 if(context.recordedPrediction!==false||context.eligibleForServing!==false||context.eligibleForTraining!==false||context.cutoffPolicy!=='first_complete_draft_receipt'||!['recorded_input_receipts','database_timestamp_reconstruction','retained_receipt_reconstruction'].includes(context.availabilityBasis))return reject('draft_history_nonadmission_or_basis');
 if(context.availabilityBasis==='retained_receipt_reconstruction'&&(context.producer?.sourcePopulation?.basis!=='provided_retained_response_corpus_only'||context.producer.sourcePopulation.originalHistoricalAvailabilityProven!==false||context.producer.sourcePopulation.globalPopulationComplete!==false))return reject('draft_history_retained_population_required');
 const {contentHash,...body}=context;if(!hash(contentHash)||evidenceHash(body)!==contentHash)return reject('draft_history_content_hash');
 const draft=context.draftState,{stateHash,...draftBody}=draft??{};
 if(!draft||draft.matchId!==matchId||draft.historyCutoffAt!==context.historyCutoffAt||draft.validFrom!==context.validFrom||!hash(stateHash)||draftHash(draftBody)!==stateHash)return reject('draft_history_state_binding');
 const emptyRetained=context.producer?.emptyRetainedCorpus===true;
 if(!Array.isArray(context.dependencies)||context.dependencies.length>100000||!context.dependencies.length&&!emptyRetained)return reject('draft_history_dependencies');
 if(emptyRetained){
  // Empty verified supplied corpus is a missing-history state, not evidence of
  // zero form or permission to create history. Opaque proof/source replay still
  // establishes authority; this validator checks its structural consequences.
  const payload=context.featurePayload,pop=context.producer?.sourcePopulation;
  const emptyProfiles=object(payload)&&['players','heroes','teams'].every(k=>Array.isArray(payload[k])&&payload[k].every(p=>object(p)&&object(p.values)&&object(p.statistics)&&Object.values(p.values).every(v=>v===null)&&Object.values(p.statistics).every(s=>object(s)&&s.value===null&&s.supportMaps===0)));
  if(context.availabilityBasis!=='retained_receipt_reconstruction'||pop?.providedMapCount!==0||context.dependencies.length||!Array.isArray(context.sourceMatches)||context.sourceMatches.length||!emptyProfiles||payload.heroes.length!==10||payload.teams.length!==2||!Array.isArray(payload.roles)||payload.roles.length||!Array.isArray(payload.heroMinuteReferences)||payload.heroMinuteReferences.length)return reject('draft_history_empty_retained_contract');
 }
 const outcomes=new Set();
 for(const d of context.dependencies){
  const at=instantNs(d?.availableAt);
  if(!id(d?.matchId)||d.matchId===matchId||!hash(d.sha256)||typeof d.evidenceRef!=='string'||at===null||at>cutoff||!['outcome','roster','hero_roster','native_frame'].includes(d.kind))return reject('draft_history_future_or_current_dependency');
  if(d.kind==='outcome'){if(instantNs(d.endedAt)===null||instantNs(d.endedAt)>at||typeof d.value!=='boolean')return reject('draft_history_outcome_dependency');outcomes.add(d.matchId);}
 }
 if(context.dependencies.some(d=>!outcomes.has(d.matchId)))return reject('draft_history_prior_completion');
 if(!object(context.featurePayload)||['currentOutcome','label','targetLabel'].some(k=>Object.hasOwn(context,k)||Object.hasOwn(context.featurePayload,k)))return reject('draft_history_payload');
 return{accepted:true,reason:'observed_draft_history_valid',featurePayload:context.featurePayload,context};
}

export function produceObservedDraftHistory({matchId,computedAt,draftPrefixInputs,factsInput,nativeInput,minimumSupport=5,nativeEvidenceInputs=[],nativeAlignmentInputs=[],expectedProfileReviewSha256=null,availabilityBasis='database_timestamp_reconstruction'}={}){
 if(!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000)throw Error('minimum_support_3_to_1000');
 if(!['recorded_input_receipts','database_timestamp_reconstruction','retained_receipt_reconstruction'].includes(availabilityBasis))throw Error('draft_history_availability_basis');
 const draft=replayPinnedDraftPrefix({draftPrefixInputs,matchId,computedAt});
 if(!draft.accepted)return blocked(draft.reason,{draftRejections:draft.rejections},{draftPrefix:draft.bindings});
 const facts=pinned(factsInput,FACTS_CONTRACT,100000),native=pinned(nativeInput,NATIVE_CONTRACT,20000);
 return produceResolvedObservedDraftHistory({matchId,computedAt,minimumSupport,nativeEvidenceInputs,nativeAlignmentInputs,expectedProfileReviewSha256,availabilityBasis},draft,facts,native);
}
function produceResolvedObservedDraftHistory({matchId,computedAt,minimumSupport,nativeEvidenceInputs,nativeAlignmentInputs,expectedProfileReviewSha256,availabilityBasis},draft,facts,native){
 const state=draft.state,known=instantNs(state.historyCutoffAt);
 const retainedScope=qualifyRetainedHistoryCorpus(facts.data,known),retained=retainedScope.verified;
 if(availabilityBasis==='retained_receipt_reconstruction'&&!retained||facts.data.scope?.contract==='aegis.retained-history-selection-scope.v1'&&availabilityBasis!=='retained_receipt_reconstruction')throw Error('draft_history_retained_source_scope_or_basis');
 if(facts.rows.some(m=>m?.matchId===matchId))throw Error('draft_history_current_map_facts_not_allowed');
 const bindings={facts:facts.pin,nativeObservations:native.pin,draftPrefix:draft.bindings};
 const audit={factRows:facts.rows.length,nativeRows:native.rows.length,draftAcceptedObservations:draft.acceptedObservations,draftRejections:draft.rejections,prefixCompleteness:draft.prefixCompleteness};
 const roster=state.identity.players.map(p=>({...p,heroId:Number(p.heroId)}));
 const target={matchId,knownAt:state.historyCutoffAt,players:roster};
 const emptyRetained=retained&&facts.rows.length===0&&native.rows.length===0;
 const calculated=calculateHistoryCore({target,known,roster,facts,native,roleProofs:[],minimumSupport,audit,bindings,nativeEvidenceInputs,nativeAlignmentInputs,nativeProofPolicy:'raw_replay_required',alignmentComputedAt:computedAt,expectedProfileReviewSha256,allowEmptyRetainedCorpus:emptyRetained});
 if(calculated.status==='blocked')return blocked(calculated.reason,audit,bindings);
 const {players,roles,references,sourceMatches,heroCohort}=calculated;
 // Late identity is a new selector at the original cutoff. A complete old query
 // for different accounts is not a complete history for newly disclosed players.
 const scope=facts.data.scope,ids=xs=>Array.isArray(xs)&&xs.every(id)&&new Set(xs).size===xs.length;
 const scopeBase=object(scope)&&scope.contract==='aegis.prior-map-selection-scope.v1'&&scope.sourceUniverse==='local_pro_matches_join_match_parsed'&&scope.selection==='target_teams_or_accounts_or_heroes'&&scope.windowDays===90&&instantNs(scope.asOf)===known&&scope.completeWithinSource===true&&scope.truncated===false&&scope.rowCount===facts.rows.length&&hash(scope.selectionSqlSha256)&&typeof scope.queryEvidenceRef==='string'&&scope.queryEvidenceRef.length>0;
 const accountScope=retained||scopeBase&&ids(scope.targetAccountIds),teamScope=retained||scopeBase&&ids(scope.targetTeamIds);
 const suppress=(p,keys,reason)=>{for(const k of keys){p.values[k]=null;p.statistics[k]={...p.statistics[k],value:null,cohortQualified:false,reason,population:'conditional_provided_maps_only'};}};
 for(const p of players){
  if(p.accountId!==null&&(!accountScope||!retained&&!scope.targetAccountIds.includes(p.accountId)))suppress(p,PERSONAL_KEYS,'player_source_scope_coverage_unproven');
  if(p.teamId!==null&&(!teamScope||!retained&&!scope.targetTeamIds.includes(p.teamId)))suppress(p,TEAM_KEYS,'team_source_scope_coverage_unproven');
  if(retained)for(const statistic of Object.values(p.statistics)){statistic.sourcePopulation='provided_retained_response_corpus_only';statistic.globalPopulationComplete=false;}
 }
 audit.targetHistoryScope={metadataValid:!!scopeBase||retained,accountIdsQualified:accountScope?roster.filter(p=>p.accountId!==null&&(retained||scope.targetAccountIds.includes(p.accountId))).length:0,teamIdsQualified:teamScope?[...new Set(roster.map(p=>p.teamId).filter(x=>x!==null&&(retained||scope.targetTeamIds.includes(x))))].length:0,...(retained?{population:'provided_retained_response_corpus_only',globalPopulationComplete:false}: {})};
 const heroKeys=['heroLateTendency'],teamKeys=TEAM_KEYS;
 const subset=(p,keys)=>({values:Object.fromEntries(keys.map(k=>[k,p.values[k]])),definitions:Object.fromEntries(keys.map(k=>[k,p.definitions[k]])),statistics:Object.fromEntries(keys.map(k=>[k,p.statistics[k]]))});
 const heroes=players.map(p=>({heroId:p.heroId,side:p.side,teamId:p.teamId,...subset(p,heroKeys)}));
 const teams=['radiant','dire'].map(side=>{const p=players.find(x=>x.side===side);return{side,teamId:p.teamId,...subset(p,teamKeys)};});
 const featurePayload={players:players.filter(p=>account(p.accountId)),heroes,teams,roles,heroMinuteReferences:references};
 const dependencies=[];
 for(const m of calculated.usedMapRecords){
  const common={matchId:m.matchId,sha256:facts.pin.sha256,evidenceRef:facts.ref+'#map/'+m.matchId};
  dependencies.push({...common,kind:'outcome',availableAt:m.outcomeKnownAt,endedAt:m.endedAt,value:m.radiantWon});
  if(m.players.length)dependencies.push({...common,kind:'roster',availableAt:m.playersKnownAt});
  if(m.heroRoster.length)dependencies.push({...common,kind:'hero_roster',availableAt:m.heroesKnownAt});
 }
 const frameIds=new Set();for(const ref of references)for(const o of ref.sourceObservations){if(frameIds.has(o.observationId))continue;frameIds.add(o.observationId);dependencies.push({kind:'native_frame',matchId:o.matchId,availableAt:o.knownAt,sha256:native.pin.sha256,evidenceRef:native.ref+'#observation/'+o.observationId,rawSha256:o.rawSha256,observationId:o.observationId});}
 const body={contract:CONTEXT_CONTRACT,mode:'observed_draft_frozen',matchId,historyCutoffAt:state.historyCutoffAt,validFrom:state.validFrom,computedAt,cutoffPolicy:state.cutoffPolicy,availabilityBasis,draftState:state,sourceMatches,dependencies,featurePayload,
  producer:{contract:PRODUCER_CONTRACT,bindings,minimumSupport,newLateMinimumSupport:Math.max(5,minimumSupport),heroCohort,aggressionIsKillPaceProxy:true,lateThresholdMinutes:40,nativeMinuteSelection:'last_clock_at_or_before_minute_within_30_seconds',recordsPerMapHeroMinuteMaximum:1,noNetWorthToGpmSubstitution:true,nativeProofPolicy:'raw_replay_required',nativeAlignmentBindings:calculated.nativeAlignmentBindings,nativeEvidenceBindings:calculated.nativeEvidenceBindings,originalCutoffImmutable:true,lateIdentityDoesNotExpandHistory:true,zeroMinuteCohortClaimed:false,learnedState:null,...(emptyRetained?{emptyRetainedCorpus:true}:{}),...(retained?{sourcePopulation:{basis:'provided_retained_response_corpus_only',...retainedScope,originalHistoricalAvailabilityProven:false,...(emptyRetained?{providedMapCount:0}:{})}}:{})},
  eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
 const context={...body,contentHash:evidenceHash(body)};
 const verified=validateObservedDraftHistory(context,{matchId,decisionAt:computedAt});if(!verified.accepted)throw Error('generated_draft_context_invalid:'+verified.reason);
 audit.knownTargetPlayers=featurePayload.players.length;audit.heroProfiles=heroes.length;audit.teamProfiles=teams.filter(x=>x.teamId!==null).length;audit.nativeAlignmentEvidence=calculated.nativeAlignmentBindings.length;audit.nativeRawEvidence=calculated.nativeEvidenceBindings.length;
 audit.profilesWithAnyValue=players.filter(p=>Object.values(p.values).some(finite)).length;
 return{contract:PRODUCER_CONTRACT,status:'produced_reconstruction',context,audit,bindings,...excluded};
}

/** Additive actual-byte route over privately verified map parts. The retained
 * contract has no qualified prior Steam frames; it never fabricates them from
 * post-match trajectories. The unchanged core/formulas consume a proven minimal
 * projection while their pin still binds all complete normalized source rows. */
export async function produceObservedDraftHistoryFromRetainedMapView({historyView,matchId,computedAt,minimumSupport=5,resourceArena=null}={}){
 if(!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000)throw Error('minimum_support_3_to_1000');
 const inputs=await readRetainedMapViewCoreInputs({historyView,matchId,computedAt,resourceArena});try{
  const draft=replayPinnedDraftPrefix({draftPrefixInputs:inputs.draftPrefixInputs,matchId,computedAt});if(!draft.accepted)return blocked(draft.reason);
  const d=inputs.view.descriptor;if(draft.state.historyCutoffAt!==d.historyCutoffAt||draft.state.validFrom!==d.validFrom||draft.state.revision!==d.identity.revision||draft.state.identity.draftHash!==d.identity.draftHash)throw Error('retained_map_view_draft_binding');
  return produceResolvedObservedDraftHistory({matchId,computedAt,minimumSupport,nativeEvidenceInputs:[],nativeAlignmentInputs:[],expectedProfileReviewSha256:null,availabilityBasis:'retained_receipt_reconstruction'},draft,inputs.facts,pinned(inputs.nativeInput,NATIVE_CONTRACT,20000));
 }finally{inputs.release();}
}
