import {createHash} from 'node:crypto';
import type {WideSourceFreshness} from './WideSourceFreshness';
import {stableJson,evidenceHash} from '../lib/predictionEvidence';
import {verifyAnchor} from './wide-observed-v2/rosterResolution';
import {WIDE_PINS as P,WIDE_FALSE_FLAGS,WIDE_BODY_LIMIT} from './WideShadowPins';
export type Json=Record<string,any>;
export type WideBody={operation:'anchor'|'predict';dispatchId:string;expectedMatchId:number;candidateManifestSha256:string;
 outcomeKnownAtDispatch:boolean|null;reader:Json};
export type WideAttempt={id:string;observationId:string;matchId:number;clock:number|null;operation:'anchor'|'predict'|'unsupported';
 receivedAt:Date;recordedAt:Date;capture:boolean|null;sourceInputHash:string;sourceSchemaHash:string;createdAt:Date};
export type WideDispatch={attempt:WideAttempt;body:WideBody;bodyText:string;bodySha256:string;dispatchedAt:Date;outcomeKnownAtDispatch:boolean|null;sourceFreshness:WideSourceFreshness};
export const hashBytes=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export const record=(v:unknown):v is Json=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const same=(a:unknown,b:unknown)=>{try{return stableJson(a)===stableJson(b);}catch{return false;}};
const fail=(reason='wide_response_contract_rejected'):never=>{throw new Error(reason);};
const validDate=(x:unknown):x is Date=>x instanceof Date&&Number.isFinite(x.getTime());
export function fresh(received:unknown,recorded:unknown,now:Date):boolean{
 const r=received instanceof Date?received.getTime():typeof received==='string'?Date.parse(received):NaN;
 const s=recorded instanceof Date?recorded.getTime():typeof recorded==='string'?Date.parse(recorded):NaN;
 return validDate(now)&&Number.isFinite(r)&&Number.isFinite(s)&&r<=s&&s<=now.getTime()&&now.getTime()-r<=180000;
}
export function preflight(a:WideAttempt,now=new Date()):string|null{
 if(!fresh(a.receivedAt,a.recordedAt,now))return 'wide_observation_stale_or_future';
 if(a.capture!==false)return a.capture===true?'wide_outcome_already_known':'wide_capture_outcome_unknown';
 if(a.sourceSchemaHash!==P.sourceSchemaSha256)return 'wide_source_schema_changed';
 if(a.operation==='unsupported')return 'wide_phase_unsupported';
 return null;
}
export function vectorHash(raw:unknown,width=36114):string{
 if(!record(raw)||!same(Object.keys(raw).sort(),['float32Sha256','missing','values'])||!Array.isArray(raw.values)||!Array.isArray(raw.missing)
  ||raw.values.length!==width||raw.missing.length!==width||!hex(raw.float32Sha256))return fail();
 const bytes=Buffer.alloc(width*4);
 for(let i=0;i<width;i++){
  const v=raw.values[i],m=raw.missing[i];
  if(typeof m!=='boolean'||(v===null)!==m)return fail();
  if(m)bytes.writeUInt32LE(0x7fc00000,i*4);
  else{if(typeof v!=='number'||!Number.isFinite(v)||Math.fround(v)!==v)return fail();bytes.writeFloatLE(v,i*4);}
 }
 const result=hashBytes(bytes);if(result!==raw.float32Sha256)return fail();return result;
}
export function checkedBinding(raw:unknown,matchId:number):Json{
 if(!record(raw)||raw.contract!=='wide36114.shadow.binding.v1'||raw.status!=='anchor_binding'
  ||raw.candidateManifestSha256!==P.candidateManifestSha256||WIDE_FALSE_FLAGS.some(k=>raw[k]!==false)||!record(raw.binding))return fail('wide_anchor_binding_unavailable');
 const b=raw.binding;
 if(b.contract!=='wide.verified-stored-anchor-binding.v1'||b.matchId!==matchId||!hex(b.anchorSha256)
  ||b.builderBundleSha256!==P.builderBundleSha256||b.priorFeatureNamesSha256!==P.priorFeatureNamesSha256
  ||b.anchorStoreValidated!==true||b.trustedCallerRequired!==true||b.eligibleForServing!==false||!record(b.anchorObservation))return fail();
 verifyAnchor(b.anchorObservation as any,P.sourceSchemaSha256,evidenceHash);
 if(b.anchorObservation.match_id!==matchId||b.featureAsOf!==b.anchorObservation.received_at
  ||!Number.isFinite(Date.parse(b.priorComputedAt))||Date.parse(b.priorComputedAt)<Date.parse(b.featureAsOf))return fail();
 return b;
}
export function checkedResponse(raw:unknown,d:WideDispatch,completed=new Date()):Json{
 if(!record(raw)||!validDate(completed)||!validDate(d.dispatchedAt)||d.dispatchedAt>completed)return fail();
 if(hashBytes(d.bodyText)!==d.bodySha256||!same(JSON.parse(d.bodyText),d.body)||Buffer.byteLength(d.bodyText)>WIDE_BODY_LIMIT)return fail();
 if(raw.contract!=='wide36114.shadow.response.v1'||raw.requestBodySha256!==d.bodySha256
  ||raw.executionMode!=='runtime_shadow'||raw.measuredEndToEndLatencySeconds!==null||WIDE_FALSE_FLAGS.some(k=>raw[k]!==false))return fail();
 if(raw.status==='unavailable'){
  if(typeof raw.reason!=='string'||!/^[a-z][a-z0-9_]{2,95}$/.test(raw.reason)||raw.prediction!==null||raw.diagnostic!==null)return fail();
  // Keep only a safe refusal envelope, never unknown extra payload fields.
  return {contract:raw.contract,status:'unavailable',reason:raw.reason,prediction:null,diagnostic:null,
   requestBodySha256:d.bodySha256,executionMode:'runtime_shadow',measuredEndToEndLatencySeconds:null,
   ...Object.fromEntries(WIDE_FALSE_FLAGS.map(k=>[k,false]))};
 }
 const b=d.body,r=b.reader,current=r.current;
 if(b.dispatchId!==d.attempt.id||b.expectedMatchId!==d.attempt.matchId||b.candidateManifestSha256!==P.candidateManifestSha256
  ||!record(current)||current.id!==d.attempt.observationId||current.input_hash!==d.attempt.sourceInputHash
  ||current.schema_hash!==d.attempt.sourceSchemaHash||current.match_id!==d.attempt.matchId
  ||current.game_time_sec!==d.attempt.clock||Date.parse(current.received_at)!==d.attempt.receivedAt.getTime()
  ||Date.parse(current.recorded_at)!==d.attempt.recordedAt.getTime())return fail();
 if(!fresh(current?.received_at,current?.recorded_at,completed)||d.attempt.capture!==false||d.outcomeKnownAtDispatch!==false
  ||b.outcomeKnownAtDispatch!==false||r.captureOutcomeKnown!==false||r.outcomeKnownAtRead!==false)return fail('wide_completion_stale_or_outcome_unknown');
 if(raw.dispatchId!==d.attempt.id||raw.matchId!==d.attempt.matchId||raw.operation!==b.operation
  ||raw.candidateManifestSha256!==P.candidateManifestSha256||raw.reason!==null||!record(raw.diagnostic)
  ||raw.outcomeKnownAtCapture!==false||raw.outcomeKnownAtRead!==false||raw.outcomeKnownAtDispatch!==false||raw.outcomeKnownAtFinish!==null)return fail();
 const computed=Date.parse(raw.completedAt);
 if(!Number.isFinite(computed)||computed<d.dispatchedAt.getTime()-1||computed>completed.getTime()+1)return fail();
 const q=raw.diagnostic;
 if(b.operation==='anchor'){
  if(raw.status!=='anchor_ready'||raw.prediction!==null||raw.sourceLineageCanonicalJson!==null||!hex(q.anchorSha256)
   ||q.featureAsOf!==current.received_at||q.builderBundleSha256!==P.builderBundleSha256
   ||q.priorFeatureNamesSha256!==P.priorFeatureNamesSha256||!hex(q.priorVectorSha256)||!record(q.snapshotProof))return fail();
  const s=q.snapshotProof,cutoff=Date.parse(s.snapshotCutoff),captured=Date.parse(s.capturedAt),built=Date.parse(s.cacheBuiltAt),receipt=Date.parse(current.received_at);
  if(s.builderBundleSha256!==P.builderBundleSha256||s.currentMapExcludedAtAnchor!==true||s.originalHistoricalReceiptProven!==false
   ||![cutoff,captured,built,receipt].every(Number.isFinite)||!(cutoff<=captured&&captured<=built&&built<=receipt&&receipt-cutoff<=86400000)
   ||!hex(s.snapshotManifestSha256)||!hex(s.rawSnapshotSha256)||!hex(s.referenceSha256))return fail();
  return raw;
 }
 const p=raw.prediction;
 if(raw.status!=='shadow_predicted'||!record(p)||p.target!==P.target||p.unit!=='probability'
  ||typeof p.rawProbability!=='number'||!Number.isFinite(p.rawProbability)||p.rawProbability<0||p.rawProbability>1||p.calibratedProbability!==null
  ||p.modelSha256!==P.modelSha256||p.candidateId!==P.candidateId||p.candidateManifestSha256!==P.candidateManifestSha256
  ||p.trainingProtocolSha256!==P.trainingProtocolSha256||p.featureNamesSha256!==P.featureNamesSha256
  ||p.projectionBundleSha256!==P.projectionBundleSha256||p.weightPolicy!=='constant_one_per_checkpoint'
  ||p.candidateOrigin!=='frozen_research_fold_not_selected_refit'||p.selectedByValidation!==false||p.finalProductionRefit!==false
  ||p.clockSupportValidated!==false||!same(p.empiricalTrainClockSeconds,[300,6600])||p.betweenTrainingCheckpoints!==(current.game_time_sec%300!==0))return fail();
 if(q.contract!=='observed_wide36114_immutable_roster_projection_v2'||q.status!=='projected_diagnostic'||q.phase!=='live'
  ||q.matchId!==d.attempt.matchId||q.gameTimeSeconds!==current.game_time_sec||q.featureAsOf!==current.received_at
  ||q.builderBundleSha256!==P.builderBundleSha256||q.projectionBundleSha256!==P.projectionBundleSha256||q.featureNamesSha256!==P.featureNamesSha256
  ||q.sourceSchemaSha256!==P.sourceSchemaSha256||q.readerPolicy!==P.readerPolicy||q.rosterPolicy!==P.rosterPolicy
  ||q.prediction!==null||q.modelHash!==null||q.actualGameStart!==null||q.modelClockSupportValidated!==false
  ||q.measuredEventToReceiptSeconds!==null||!record(q.quality)||Object.values(q.quality).some(v=>v!==false)
  ||['eligibleForServing','eligibleForPromotion','prospectiveValidated','coverage95Validated','eventLatencyVerified',
    'currentStateFreshnessIndependentlyVerified','originalHistoricalReceiptProven','currentPlayerStatisticsReconstructed'].some(k=>q.quality[k]!==false))return fail();
 const source=q.sourceLineage;
 if(!record(source)||typeof raw.sourceLineageCanonicalJson!=='string'||Buffer.byteLength(raw.sourceLineageCanonicalJson)>WIDE_BODY_LIMIT
  ||hashBytes(raw.sourceLineageCanonicalJson)!==q.sourceInputSha256||!same(JSON.parse(raw.sourceLineageCanonicalJson),source))return fail();
 const candidateLineage=r.candidates.map((row:Json)=>Object.fromEntries(['id','input_hash','schema_hash','match_id','game_time_sec','received_at','recorded_at'].map(k=>[k,row[k]])));
 const expected={current,candidateLineage,queryTruncated:false,selection:r.selection,storedAnchor:r.storedAnchor,
  anchorSha256:r.storedAnchor.anchorSha256,captureOutcomeKnown:false,outcomeKnownAtRead:false,
  readerProvenance:r.provenance,projectionBundleSha256:P.projectionBundleSha256};
 if(!same(source,expected)||q.anchorSha256!==r.storedAnchor.anchorSha256||q.priorFeatureAsOf!==r.storedAnchor.featureAsOf
  ||!same(q.rosterResolution,r.selection.rosterResolution)||p.anchorSha256!==q.anchorSha256||p.sourceInputSha256!==q.sourceInputSha256)return fail();
 if(vectorHash(q.features36114)!==p.featureVectorSha256)return fail();
 return raw;
}
