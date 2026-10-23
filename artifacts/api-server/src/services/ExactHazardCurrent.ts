import {readFiniteAuthorizedResult} from './ExactHazardFinite';
/** Read-only candidate consumer. No provider client, model process or public serving path. */
import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {
  FLAGS,parseHazardTransport,ownHazardDiagnosticLadder,bookmakerHazardDiagnosticLadder,
  type HazardTransport,type Target,type DiagnosticBookQuote,
} from './ExactHazardDiagnostic';
import type {FeedSnapshot} from '../lib/backgroundFeed';
import {resolveLadderIdentity,uniqueBookmakerEvent} from './BookmakerTotalsLadder';
import type {UnifiedBookmakerEvent} from '../routes/bookmakers';
import type {ServingOutcomeMetadata} from './ServingOutcomeGuard';

const CONTRACT='aegis.exact-hazard-admin-current.v2';
const DESCRIPTOR='aegis.reviewed-exact-hazard-result.v2';
const MAX_AGE_MS=180_000;
type Obj=Record<string,any>;
type Feed=FeedSnapshot<unknown[]>;
export type Options={target:Target;candidate:'live.C1'|'live.C2'|'prematch'|'postdraft';bookmakerId:string|null};
export type Saved={matchId:number;radiantTeamId:number;direTeamId:number;receivedAt:string;
  computedAt:string;clockSeconds:number;resultFileSha256:string;distribution:HazardTransport;
  phase?:'prematch'|'postdraft';currentReceivedAt?:string;currentClockSeconds?:number;guardCheckedAt?:string;
  retained?:boolean;informationSet?:string;receiptInformationCategory?:string;
  authorization?:{kind:'root_approved_finite_producer';individualResultReviewed:false;namespaceId:string;configSha256:string;sequence:number};
  revalidateSource?:()=>void};
export interface ExactHazardDependencies {
  readSaved:(options:Options)=>Saved;
  outcome:(matchId:number)=>Promise<ServingOutcomeMetadata|null>;
  readFeed:(name:'opendota_live'|'pandascore_running'|'pandascore_upcoming')=>Promise<Feed>;
  readEvents:(bookmakerId:string)=>Promise<UnifiedBookmakerEvent[]>;
  now?:()=>number;
}
const object=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const pin=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function need(ok:unknown,reason:string):asserts ok {if(!ok)throw Error(reason);}
const unavailable=(reason:string)=>({contract:CONTRACT,...FLAGS,status:'unavailable',reason,lines:[],
  providerCalls:0,modelCalls:0,sourceKind:'saved_server_candidate_result',coverage95Validated:false});

/** Only scalar selectors are accepted. No client path, quote, team, clock or probability. */
export function exactHazardOptions(query:Record<string,unknown>):Options|null {
  if(Object.keys(query).some(k=>!['target','candidate','bookmakerId'].includes(k)))return null;
  if(!['kills','duration'].includes(String(query.target))||
    !['live.C1','live.C2','prematch','postdraft'].includes(String(query.candidate)))return null;
  if(typeof query.target!=='string'||typeof query.candidate!=='string')return null;
  const b=query.bookmakerId;
  if(b!==undefined&&(typeof b!=='string'||!/^[a-z0-9_-]{1,40}$/.test(b)))return null;
  return {target:query.target as Target,candidate:query.candidate as Options['candidate'],
    bookmakerId:b===undefined?null:b as string};
}
function fileBytes(file:unknown,max:number):Buffer {
  need(typeof file==='string'&&isAbsolute(file),'descriptor_path');
  const before=statSync(file);
  need(before.isFile()&&before.size>0&&before.size<=max,'file_bound');
  const b=readFileSync(file),after=statSync(file);
  need(b.length===before.size&&after.size===before.size&&after.mtimeMs===before.mtimeMs,'file_changed');
  return b;
}
function disabled(v:Obj):boolean {
  return v.active===false&&v.eligibleForServing===false&&v.eligibleForPromotion===false&&
    v.eligibleForQualityClaims===false;
}
/** The descriptor is configured by the server operator and pinned out of band.
 * It references exact worker output bytes; it never creates a candidate receipt.
 * LIVE and receipt-phase envelopes are validated separately; retained source time is preserved. */
export function readReviewedExactHazard(options:Options,
  env:NodeJS.ProcessEnv=process.env):Saved {
  if(env.AEGIS_EXACT_HAZARD_FINITE_CONFIG||env.AEGIS_EXACT_HAZARD_FINITE_CONFIG_SHA256){
    need(!env.AEGIS_EXACT_HAZARD_CURRENT_CONFIG&&!env.AEGIS_EXACT_HAZARD_CURRENT_CONFIG_SHA256,'ambiguous_result_authorization');
    return readFiniteAuthorizedResult(options,env,(envelope,identity)=>readEnvelope(envelope,identity,options,'c2_authorized_finite_result.v1'));
  }
  need(env.AEGIS_EXACT_HAZARD_CURRENT_CONFIG&&pin(env.AEGIS_EXACT_HAZARD_CURRENT_CONFIG_SHA256),
    'descriptor_unconfigured');
  const b=fileBytes(env.AEGIS_EXACT_HAZARD_CURRENT_CONFIG,64*1024);
  need(hash(b)===env.AEGIS_EXACT_HAZARD_CURRENT_CONFIG_SHA256,'descriptor_pin');
  const c:unknown=JSON.parse(b.toString('utf8'));
  need(object(c)&&c.contract===DESCRIPTOR&&c.rootReviewed===true&&
    c.diagnosticOnly===true&&c.publicPromotion===false,'descriptor_not_reviewed');
  need(object(c.result)&&pin(c.result.sha256)&&pin(c.sourceInputSha256)&&pin(c.dispatchSha256)&&
    positive(c.matchId)&&positive(c.radiantTeamId)&&positive(c.direTeamId)&&
    c.radiantTeamId!==c.direTeamId,'descriptor_identity');
  const raw=fileBytes(c.result.path,16*1024*1024);
  need(hash(raw)===c.result.sha256,'result_pin');
  const envelope:unknown=JSON.parse(raw.toString('utf8'));
  return readEnvelope(envelope,c,options,'c2_standalone_result.v1');
}
function readEnvelope(envelope:unknown,c:Obj,options:Options,expectedContract:string):Saved {
  need(object(envelope)&&envelope.contract===expectedContract&&disabled(envelope)&&
    envelope.readerSha256===c.sourceInputSha256&&
    envelope.dispatchSha256===c.dispatchSha256&&envelope.prediction===null,'result_envelope');
  if(options.candidate==='prematch'||options.candidate==='postdraft')return readPhase(envelope,c,options.candidate,options.target);
  need(envelope.sourceInputSha256===c.sourceInputSha256,'live_envelope_source');
  const r=envelope.result;
  need(object(r)&&disabled(r)&&r.status==='projected_diagnostic'&&r.matchId===c.matchId&&
    r.sourceInputSha256===c.sourceInputSha256,'result_projection');
  const intake=r.steamCommittedIntake,identity=r.steamPerPacketStartEvidence?.sourceIdentity;
  need(object(intake)&&intake.originalReceiptPreserved===true&&intake.providerCalls===0&&
    pin(intake.archiveCompleteSha256)&&intake.readerSha256===c.sourceInputSha256&&
    object(identity)&&identity.matchIdDecimal===String(c.matchId)&&
    identity.radiantTeamIdDecimal===String(c.radiantTeamId)&&
    identity.direTeamIdDecimal===String(c.direTeamId),'server_map_identity');
  const d=r.richTotalsDiagnostic;
  need(object(d)&&d.contract==='rich_totals_fitted_candidate_binding.v1'&&disabled(d)&&
    d.status==='predicted_diagnostic'&&d.phase==='live'&&d.publicPrediction===null&&
    d.inTraining===false&&d.actualBookmakerQuotes===false&&d.noWinnerSelected===true,
    'prospective_live_diagnostic_required');
  const e=d.sourceEvidence;
  need(object(e)&&e.mode==='prospective_receipt_diagnostic'&&e.phase==='live'&&
    e.matchId===c.matchId&&e.sourceInputSha256===c.sourceInputSha256&&e.observedFloorKnown===true&&
    Number.isSafeInteger(e.clockSeconds)&&e.clockSeconds>=300&&
    e.readerProvenance?.sourceAvailability?.outcomeKnownAtCapture===false,'source_evidence');
  const head=d.candidates?.[options.candidate]?.[options.target];
  need(object(head)&&head.calibration==='none_raw_hazard'&&head.temperature===1&&
    object(head.distributionTransport),'exact_cdf_missing');
  const distribution=parseHazardTransport(head.distributionTransport);
  need(distribution.phase==='live'&&distribution.target===options.target&&
    distribution.metadata.matchId===c.matchId&&distribution.metadata.candidate===options.candidate&&
    distribution.metadata.sourceInputSha256===c.sourceInputSha256&&
    distribution.metadata.modelBindingSha256===d.modelBindingSha256&&
    distribution.metadata.modelSha256===head.modelSha256&&
    distribution.metadata.stateFloat32Sha256===head.stateFloat32Sha256&&
    distribution.metadata.rawLogitsSha256===head.rawLogitsSha256&&
    distribution.coordinateOffset===head.coordinateOffset&&
    (options.target!=='duration'||distribution.coordinateOffset===e.clockSeconds),'cdf_binding');
  const receipt=Date.parse(e.observationReceivedAt),recorded=Date.parse(e.observationRecordedAt),
    computed=Date.parse(d.computedAt),modelKnown=Date.parse(d.modelBindingKnownAt);
  need([receipt,recorded,computed,modelKnown].every(Number.isFinite)&&
    modelKnown<=receipt&&receipt<=recorded&&recorded<=computed,'receipt_chronology');
  return {matchId:c.matchId,radiantTeamId:c.radiantTeamId,direTeamId:c.direTeamId,
    receivedAt:e.observationReceivedAt,computedAt:d.computedAt,clockSeconds:e.clockSeconds,
    resultFileSha256:c.result.sha256,distribution};
}
const PHASE_KERNEL='f659e84fc59167c68d28db65f0e1b42e24a073de8ef6ffa27e95fb38aa771fed';
/** Installed receipt_phase.py uses a separate envelope. Its standalone top-level
 * sourceInputSha256 is null; original projection source remains explicit below. */
function readPhase(envelope:Obj,c:Obj,phase:'prematch'|'postdraft',target:Target):Saved {
  const r=envelope.result;
  need(envelope.sourceInputSha256===null&&object(r)&&disabled(r)&&
    r.contract==='c2_steam_phase_dispatch_result.v1'&&r.matchId===c.matchId&&r.phase==='postdraft'&&
    r.prediction===null&&r.physicalScoreAssumed===false&&r.actualGameStartAssumed===false&&
    r.sourceStartUsedAsFeatureCutoff===false&&r.readerContract==='steam_rt_committed_reader.candidate.v3'&&
    r.phaseKernelManifestSha256===PHASE_KERNEL&&pin(c.phaseHookSourceManifestSha256)&&
    r.hookSourceManifestSha256===c.phaseHookSourceManifestSha256&&pin(r.hookConfigSha256),'phase_dispatch');
  const intake=r.steamCommittedIntake,current=r.currentObservation;
  need(object(intake)&&intake.originalReceiptPreserved===true&&intake.providerCalls===0&&
    pin(intake.archiveCompleteSha256)&&intake.readerSha256===c.sourceInputSha256&&
    object(current)&&current.readerSha256===c.sourceInputSha256&&pin(current.rawSourceSha256)&&
    typeof current.receivedAt==='string'&&Number.isSafeInteger(current.gameTimeSeconds),'phase_current_receipt');
  const retained=r.status==='retained_postdraft_diagnostic',retention=r.retention;
  need(retained||r.status==='projected_diagnostic','phase_status');
  let original=current;
  if(retained) {
    need(phase==='postdraft'&&object(retention)&&
      retention.contract==='c2_retained_beforeplay_forecast_not_live.v1'&&
      retention.newModelInference===false&&retention.newFeatureProjection===false&&
      retention.liveFitDomainSupported===false&&retention.identityRevalidated===true&&
      current.gameTimeSeconds>=1&&current.gameTimeSeconds<300&&
      typeof retention.maxAgeSeconds==='number'&&retention.maxAgeSeconds>0&&retention.maxAgeSeconds<=300&&
      object(retention.originalObservation),'retained_beforeplay_contract');
    original=retention.originalObservation;
    const age=(Date.parse(r.computedAt)-Date.parse(original.receivedAt))/1000;
    need(Number.isFinite(age)&&age>=0&&age<=retention.maxAgeSeconds&&
      Math.abs(age-retention.ageSeconds)<1e-6&&pin(c.phaseSourceInputSha256)&&
      original.readerSha256===c.phaseSourceInputSha256,'retained_original_receipt');
  } else need(retention===null&&current.gameTimeSeconds>=-3600&&current.gameTimeSeconds<=0,'beforeplay_clock');
  need(Number.isSafeInteger(original.gameTimeSeconds)&&original.gameTimeSeconds>=-3600&&
    (phase==='prematch'?original.gameTimeSeconds<0:original.gameTimeSeconds<=0)&&
    original.sourceObservedPhase===(original.gameTimeSeconds<0?'post_draft':'live'),'original_phase_clock');
  const v=r.phaseDiagnostics?.[phase],p=v?.phaseProjection,d=v?.totalsDiagnostics;
  need(object(v)&&disabled(v)&&v.contract==='receipt_phase_candidate_result.v1'&&
    v.status==='projected_diagnostic'&&v.phase===phase&&v.matchId===c.matchId&&
    v.sourceProducerManifestSha256===PHASE_KERNEL,'phase_candidate');
  need(object(p)&&disabled(p)&&p.contract==='guarded_receipt_phase_projection.v1'&&
    p.status==='projected_diagnostic'&&p.phase===phase&&p.mode==='prospective_receipt_diagnostic'&&
    p.matchId===c.matchId&&p.sourceProducerManifestSha256===PHASE_KERNEL&&
    p.sourceInputSha256===original.readerSha256&&p.observationReceivedAt===original.receivedAt&&
    p.featureAsOf===original.receivedAt&&p.observedGameClockSeconds===original.gameTimeSeconds&&
    p.sourceObservedPhase===original.sourceObservedPhase&&p.actualGameStartAssumed===false&&
    p.physicalScoreAssumed===false&&pin(p.projectionSha256)&&pin(p.sourceNormalizedInputHash),
    'phase_projection_binding');
  need(p.informationSet===(phase==='prematch'?'confirmed_team_pair_only':'confirmed_full_draft')&&
    p.receiptInformationCategory===(phase==='prematch'
      ?'prematch_information_at_'+original.sourceObservedPhase+'_receipt':'confirmed_full_draft_at_beforeplay_receipt')&&
    p.runtimeAsOfCategory==='actual_observation_receipt_time'&&
    p.actualStartTrainingVsEarlierReceiptParityProven===false,'phase_information_set');
  const sides=p.observedSides,receipt=Date.parse(p.featureAsOf),cache=p.cacheAvailability;
  need(object(sides)&&sides.radiantTeamId===c.radiantTeamId&&sides.direTeamId===c.direTeamId&&
    Date.parse(sides.knownAt)<=receipt&&p.teamA===Math.min(c.radiantTeamId,c.direTeamId)&&
    p.teamB===Math.max(c.radiantTeamId,c.direTeamId)&&
    p.readerProvenance?.sourceAvailability?.outcomeKnownAtCapture===false,'phase_server_identity');
  need(object(cache)&&['cutoff','sourceKnownAt','materializedAt','latestFeatureOutcome']
    .every(k=>typeof cache[k]==='number'&&Number.isFinite(cache[k]))&&
    cache.cutoff<=cache.sourceKnownAt&&cache.sourceKnownAt<=cache.materializedAt&&
    cache.materializedAt<=receipt/1000&&cache.latestFeatureOutcome<receipt/1000&&
    receipt/1000-cache.cutoff<=86400&&receipt/1000-cache.materializedAt<=86400,'phase_cache_asof');
  need(p.totals?.coordinate==='final_total_origin_zero'&&p.totals.observedPhysicalScoreKnown===false&&
    pin(p.totals.stateNamesSha256)&&pin(p.totals.state?.float32Sha256)&&object(d)&&disabled(d)&&
    d.contract==='rich_totals_fitted_candidate_binding.v1'&&d.status==='predicted_diagnostic'&&
    d.phase===phase&&d.inTraining===false&&d.publicPrediction===null&&d.actualBookmakerQuotes===false&&
    d.noWinnerSelected===true,'phase_exact_totals');
  const e=d.sourceEvidence;
  need(object(e)&&e.phase===phase&&e.mode==='prospective_receipt_diagnostic'&&e.matchId===c.matchId&&
    e.sourceInputSha256===p.sourceInputSha256&&e.sourceProjectionSha256===p.projectionSha256&&
    e.sourceProducerManifestSha256===PHASE_KERNEL&&e.featureAsOf===p.featureAsOf&&
    e.observationReceivedAt===p.observationReceivedAt&&e.observedFloorKnown===false&&
    e.informationSet===p.informationSet&&e.receiptInformationCategory===p.receiptInformationCategory&&
    e.sourceObservedPhase===p.sourceObservedPhase&&e.actualStartTrainingVsEarlierReceiptParityProven===false,
    'phase_totals_source');
  const head=d.candidates?.[phase]?.[target];
  need(object(head)&&head.calibration==='none_raw_hazard'&&head.temperature===1&&
    head.stateFeatures===37024&&head.modelFeatures===37025&&
    head.stateFloat32Sha256===p.totals.state.float32Sha256&&object(head.distributionTransport),'phase_cdf_missing');
  const distribution=parseHazardTransport(head.distributionTransport);
  need(distribution.phase===phase&&distribution.target===target&&distribution.coordinate==='final_total_origin_zero'&&
    distribution.coordinateOffset===0&&distribution.observedFinalFloor===null&&
    head.coordinateOffset===0&&head.observedFinalFloor===null&&
    distribution.metadata.candidate===phase&&distribution.metadata.matchId===c.matchId&&
    distribution.metadata.sourceInputSha256===p.sourceInputSha256&&
    distribution.metadata.modelBindingSha256===d.modelBindingSha256&&
    distribution.metadata.modelSha256===head.modelSha256&&
    distribution.metadata.stateFloat32Sha256===head.stateFloat32Sha256&&
    distribution.metadata.rawLogitsSha256===head.rawLogitsSha256,'phase_cdf_binding');
  const guard=r.knownOutcomeGuard;
  need(object(guard)&&guard.contract==='c2_phase_before_after_outcome_presence.v1'&&guard.outcomeValuesInFeatures===false&&
    ['before','after'].every(k=>object(guard[k])&&guard[k].contract==='local_known_outcome_presence.v1'&&
      guard[k].matchId===c.matchId&&guard[k].known===false&&guard[k].readOnly===true&&
      guard[k].outcomeValueRead===false&&Number.isFinite(Date.parse(guard[k].checkedAt))),'phase_producer_outcome_guard');
  const computed=Date.parse(d.computedAt),wrapped=Date.parse(r.computedAt);
  need(Number.isFinite(receipt)&&Number.isFinite(computed)&&Number.isFinite(wrapped)&&
    Date.parse(d.modelBindingKnownAt)<=receipt&&receipt<=computed&&computed<=wrapped&&
    d.computedAt===p.computedAt&&Date.parse(guard.before.checkedAt)<=wrapped&&
    wrapped<=Date.parse(guard.after.checkedAt)&&(!retained||retention.originalComputedAt===p.computedAt),
    'phase_chronology');
  return {matchId:c.matchId,radiantTeamId:c.radiantTeamId,direTeamId:c.direTeamId,
    receivedAt:p.observationReceivedAt,computedAt:d.computedAt,clockSeconds:p.observedGameClockSeconds,
    currentReceivedAt:current.receivedAt,currentClockSeconds:current.gameTimeSeconds,guardCheckedAt:guard.after.checkedAt,
    resultFileSha256:c.result.sha256,distribution,phase,retained,informationSet:p.informationSet,
    receiptInformationCategory:p.receiptInformationCategory};
}
function fresh(s:Saved,now:number) {
  const receipt=Date.parse(s.receivedAt),computed=Date.parse(s.computedAt);
  const current=Date.parse(s.currentReceivedAt??s.receivedAt);
  return Number.isFinite(now)&&receipt<=computed&&computed<=now&&current<=now&&
    now-current<MAX_AGE_MS&&now-receipt<(s.retained?300_000:MAX_AGE_MS)&&
    (s.guardCheckedAt===undefined||Date.parse(s.guardCheckedAt)<=now);
}
function outcomeOK(meta:ServingOutcomeMetadata|null,s:Saved) {
  // Steam's pinned identity does not depend on an OD live snapshot being present.
  // An existing conflicting DB identity nevertheless vetoes the response.
  return meta!==null&&meta.known===false&&
    (meta.radiantTeamId===null||meta.radiantTeamId===s.radiantTeamId)&&
    (meta.direTeamId===null||meta.direTeamId===s.direTeamId);
}
export async function exactHazardCurrent(query:Record<string,unknown>,deps:ExactHazardDependencies) {
  const options=exactHazardOptions(query);if(!options)return unavailable('invalid_diagnostic_selectors');
  let s:Saved;try{s=deps.readSaved(options);}catch{return unavailable('saved_exact_cdf_unavailable');}
  const now=deps.now??Date.now;
  if(!fresh(s,now()))return unavailable('saved_receipt_stale_or_future');
  let before:ServingOutcomeMetadata|null;
  try{before=await deps.outcome(s.matchId);}catch{return unavailable('outcome_check_unavailable');}
  if(!outcomeOK(before,s))return unavailable('outcome_or_identity_unavailable');
  let ladder:unknown;
  if(options.bookmakerId===null)ladder=ownHazardDiagnosticLadder(s.distribution);
  else {
    try {
      const [od,running,upcoming]=await Promise.all(
        (['opendota_live','pandascore_running','pandascore_upcoming'] as const).map(n=>deps.readFeed(n)));
      const identity=resolveLadderIdentity('od_'+s.matchId,{od,running,upcoming},now());
      if(!identity||identity.input.team1.teamId!==s.radiantTeamId||
        identity.input.team2.teamId!==s.direTeamId)return unavailable('server_book_map_identity_unconfirmed');
      const event=uniqueBookmakerEvent(identity,options.bookmakerId,await deps.readEvents(options.bookmakerId));
      if(!event)return unavailable('server_book_event_unconfirmed');
      const context={matchId:s.matchId,mapNumber:identity.mapNumber,bookmakerId:options.bookmakerId,eventId:event.eventId};
      const rows=options.target==='kills'?event.markets.totalKills:event.markets.totalDuration;
      const quotes:DiagnosticBookQuote[]=(rows??[]).filter(r=>r.scope==='map'&&r.map===identity.mapNumber)
        .map(r=>({...context,target:options.target,scope:'map',unit:r.unit as 'kills'|'minutes',line:r.line,
          oddsOver:r.over??null,oddsUnder:r.under??null,receivedAt:event.receivedAt??event.updatedAt,
          expiresAt:event.expiresAt??'',
          // The current source cache has no independently verified duration
          // settlement evidence. A generic integer_push (or a bare claimed
          // exact_seconds_push string) cannot establish exact-second rules.
          settlement:options.target==='kills'&&(r as typeof r&{settlement?:string}).settlement==='integer_push'
            ?'integer_kills_push':'unknown'}));
      ladder=bookmakerHazardDiagnosticLadder(s.distribution,context,quotes,now());
    }catch{return unavailable('saved_book_feed_unavailable');}
  }
  let after:ServingOutcomeMetadata|null;
  try{after=await deps.outcome(s.matchId);}catch{return unavailable('outcome_check_unavailable');}
  if(!outcomeOK(after,s)||!before||!after||before.radiantTeamId!==after.radiantTeamId||
    before.direTeamId!==after.direTeamId)return unavailable('outcome_or_identity_changed_before_response');
  try{s.revalidateSource?.();}catch{return unavailable('finite_source_changed_before_response');}
  if(!fresh(s,now()))return unavailable('saved_receipt_expired_before_response');
  return {contract:CONTRACT,...FLAGS,status:'diagnostic_ready',sourceKind:'saved_server_candidate_result',
    matchId:s.matchId,target:options.target,candidate:options.candidate,receivedAt:s.receivedAt,
    computedAt:s.computedAt,clockSeconds:s.clockSeconds,resultFileSha256:s.resultFileSha256,
    authorization:s.authorization??{kind:'individually_reviewed_result_descriptor',individualResultReviewed:true},
    phase:s.phase??'live',retainedBeforeplayForecast:s.retained??false,
    currentReceivedAt:s.currentReceivedAt??s.receivedAt,featureAsOf:s.receivedAt,
    currentClockSeconds:s.currentClockSeconds??s.clockSeconds,
    informationSet:s.informationSet??'observed_live_state',receiptInformationCategory:s.receiptInformationCategory??'live_receipt',
    observedPhysicalFloorKnown:s.distribution.observedFinalFloor!==null,
    sourceInputSha256:s.distribution.metadata.sourceInputSha256,modelSha256:s.distribution.metadata.modelSha256,
    coverage95Validated:false,eventLatencyVerified:false,providerCalls:0,modelCalls:0,
    probabilitiesAreCalibrated:false,ladder};
}
