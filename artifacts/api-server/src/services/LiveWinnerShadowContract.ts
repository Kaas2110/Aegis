import { createHash } from 'node:crypto';
import { evidenceHash } from '../lib/predictionEvidence';
import { performance } from 'node:perf_hooks';
import { WINNER_HISTORY_POLICY, WINNER_HISTORY_POLICY_HASH } from './liveWinnerHistoryPolicy';
import { ShadowDiagnosticError, safeResponseMetadata } from './liveWinnerShadowDiagnostics';

export const WINNER_SHADOW = {
  contract: 'observed_live_winner_runtime_shadow_v1',
  candidateId: 'observed-v2-shared-before80-diagnostic',
  modelSha256: 'a0a5c6c8293ae0dd5d4009d25cf22ba81f6d49eefc03ecf047cb1e061851c806',
  featureSchemaHash: 'edc218ef8ad91809790c70ead2c7a8f93b8c2769e94c38ecff349660eded79c4',
  manifestSha256: 'a686c4e7490ae2aebce3dd924185b031b7d712124f4838a8798bac6bb8488149',
} as const;
export const WINNER_SHADOW_CANDIDATE_HASH = () => evidenceHash({...WINNER_SHADOW,
  inputPolicy:WINNER_HISTORY_POLICY,inputPolicyHash:WINNER_HISTORY_POLICY_HASH});
const SOURCE_HASHES = {
  'source/architecture_contract.py':'1e2dce1034dcdd788c84ad1c27ed2c9ca95e512e4096f65a285481e55257f16f',
  'source/run_comparison.py':'faa3fcafa109725c41e8faa7906d79d2088d3dc0e3572b6dcb2ff4e4703beeba',
  'protocol.json':'5dfafe946f32a5c31a4ac20498e454901f9ed171ea5c348cd943ed1ac328ff9a',
  'features.npz':'8f3081b7342966c808b667fee6226a462617d6effdae64c60ca5efe3283d2a2e',
  'rows.json':'56ed8e7b77e164f2418e1ae645faad87861e28bba02d06e49b3f677f1aa336a6',
  'fit-report.json':'41d558cb6219a563c6c88ff28b61791ec121cfcb617a09d983be619a8a73dc1b',
};
export const WINNER_SHADOW_SOURCE_HASHES = Object.freeze(SOURCE_HASHES);
export const shadowRequestBodyHash = (body: ShadowBody) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
export const WINNER_SHADOW_FEATURE_NAMES = [
  'observed_game_minutes', 'radiant_score', 'dire_score', 'kill_diff', 'total_kills',
  'kills_per_minute', 'raw_provider_lead_k', 'draft_valid',
  ...[120,300].flatMap(w => ['trajectory_available','actual_gap_minutes','raw_lead_slope_k','total_kill_slope','kill_diff_slope'].map(n => `${n}_${w}`)),
  ...Array.from({length:250},(_,i) => `observed_draft_signed_hero_${i+1}`),
];
export interface ObservationEnvelope {
  observationId: string;
  source: 'opendota'; targetScope: 'map'; clockUnit: 'seconds'; scoreUnit: 'kills';
  receivedAt: string; recordedAt: string; input: Record<string, unknown>;
}
export interface ShadowBody {
  current: ObservationEnvelope; history: ObservationEnvelope[]; expectedMatchId: number;
}
export interface ShadowRequest {
  id: string; body: ShadowBody; dispatchedAt: Date;
  outcomeKnownAtDispatch: boolean | null;
  evidence: Record<string, unknown>;
}
export interface ShadowCompletion {
  status: 'predicted' | 'unavailable' | 'error'; reason: string | null;
  completedAt: Date; response: Record<string, unknown> | null;
  assessment: Record<string, unknown>;
}
const hex = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
// Windows Node/Python/PostgreSQL clocks showed an 8 ms ordering skew. This is
// only timestamp precision tolerance, never additional event/freshness budget.
const LOCAL_PROCESS_CLOCK_TOLERANCE_MS = 100;
const safeIso=(date:Date|undefined)=>date instanceof Date&&Number.isFinite(date.getTime())?date.toISOString():null;

/** Validate the authenticated service response before allowing a durable success. */
export function checkedShadowResponse(raw: unknown, body: ShadowBody, completedAt = new Date(), dispatchedAt?: Date): Record<string, unknown> {
  function reject(predicate:string):never {throw new ShadowDiagnosticError('shadow_response_contract_rejected',{predicate});}
  if (!record(raw)) reject('response_not_object');
  try{evidenceHash(raw);}catch{reject('response_not_finite_json');}
  for (const [key, expected] of Object.entries(WINNER_SHADOW))
    if (raw[key] !== expected) reject('model_or_contract_pin_mismatch');
  if (raw.executionMode !== 'runtime_shadow' || raw.target !== 'map_radiant_win' || raw.targetScope !== 'map'
    || raw.observationId !== body.current.observationId || raw.matchId !== body.expectedMatchId
    || !hex(raw.currentObservationHash) || !record(raw.sourceHashes)
    || evidenceHash(raw.sourceHashes) !== evidenceHash(SOURCE_HASHES)
    || raw.requestBodySha256 !== shadowRequestBodyHash(body)
    || typeof raw.receivedAt !== 'string' || Date.parse(raw.receivedAt) !== Date.parse(body.current.receivedAt)
    || typeof raw.recordedAt !== 'string' || Date.parse(raw.recordedAt) !== Date.parse(body.current.recordedAt))
    reject('request_identity_or_source_binding_mismatch');
  if(typeof raw.computedAt !== 'string'||!Number.isFinite(Date.parse(raw.computedAt)))reject('computed_at_invalid');
  const lower=Math.max(Date.parse(body.current.recordedAt),dispatchedAt?.getTime()??0);
  const upper=completedAt.getTime(),computed=Date.parse(raw.computedAt as string);
  if(!Number.isFinite(lower)||!Number.isFinite(upper)||lower-upper>2*LOCAL_PROCESS_CLOCK_TOLERANCE_MS)
    throw new ShadowDiagnosticError('shadow_clock_inconsistent',{predicate:'dispatch_completion_bounds_inconsistent',
      dispatchAt:safeIso(dispatchedAt),completedAt:safeIso(completedAt),
      dispatchToCompletionSeconds:dispatchedAt&&Number.isFinite(upper-dispatchedAt.getTime())?(upper-dispatchedAt.getTime())/1000:null});
  if(computed+LOCAL_PROCESS_CLOCK_TOLERANCE_MS<lower||computed>upper+LOCAL_PROCESS_CLOCK_TOLERANCE_MS)
    throw new ShadowDiagnosticError('shadow_clock_inconsistent',{predicate:'computed_at_outside_clock_bounds',
      computedAt:new Date(computed).toISOString(),dispatchAt:safeIso(dispatchedAt),completedAt:safeIso(completedAt)});
  for (const key of ['active', 'eligibleForServing', 'eligibleForPromotion', 'prospectiveValidated',
    'eventLatencyVerified', 'meetsVerifiedLiveLatencyPolicy'])
    if (raw[key] !== false) reject('shadow_or_quality_flag_mismatch');
  if (raw.measuredEndToEndLatencySeconds !== null || raw.calibratedProbability !== null)
    reject('unvalidated_probability_or_latency');
  if (raw.status === 'unavailable') {
    if (typeof raw.reason !== 'string' || !raw.reason || raw.reason.length > 200
      || raw.rawProbability !== null || raw.featureValues !== null || raw.missingMask !== null)
      reject('unavailable_result_has_invalid_values');
    return raw;
  }
  const values = raw.featureValues, masks = raw.missingMask, names = raw.featureNames;
  if (raw.status !== 'shadow_predicted' || raw.reason !== null || !finite(raw.rawProbability)
    || raw.rawProbability < 0 || raw.rawProbability > 1 || raw.featureDtype !== 'float32'
    || !hex(raw.inputHash) || !hex(raw.featureVectorHash)
    || !Array.isArray(values) || !Array.isArray(masks) || !Array.isArray(names)
    || values.length !== 268 || masks.length !== 268 || names.length !== 268
    || names.some((x,i) => x !== WINNER_SHADOW_FEATURE_NAMES[i])
    || values.some((v, i) => typeof masks[i] !== 'boolean' || (v === null) !== masks[i]
      || (v !== null && (!finite(v) || !Number.isFinite(Math.fround(v)) || Math.fround(v) !== v))))
    reject('prediction_vector_schema_or_probability_invalid');
  const historyIds = new Set(body.history.map(h => h.observationId));
  for (const key of ['historyLineageInReceiptOrder', 'contributingHistory']) {
    if (!Array.isArray(raw[key]) || (raw[key] as unknown[]).some(x => !record(x)
      || typeof x.observationId !== 'string' || !historyIds.has(x.observationId)
      || !hex(x.observationHash))) reject('history_lineage_invalid');
  }
  return raw;
}

export function shadowAssessment(request: ShadowRequest, completedAt: Date) {
  const localAgeSeconds = (completedAt.getTime() - Date.parse(request.body.current.receivedAt)) / 1000;
  return {
    executionMode: 'runtime_shadow', targetScope: 'map',
    eligibleForServing: false, eligibleForPromotion: false,
    eligibleForProspectiveEvaluation: false,
    prospectiveValidated: false, meetsVerifiedLiveLatencyPolicy: false,
    eventLatencyVerified: false, measuredEndToEndLatencySeconds: null,
    totalEventLagLimitSeconds: 300, localStateAgeLimitSeconds: 180,
    receiptToCompletionSeconds: Number.isFinite(localAgeSeconds)?localAgeSeconds:null,
    localProcessClockToleranceMs: LOCAL_PROCESS_CLOCK_TOLERANCE_MS,
    receiptAgeWithinLimit: localAgeSeconds >= 0 && localAgeSeconds <= 180,
    // Local receipt age alone does not establish state progression or event age.
    outcomeCheckMeaning: 'DB snapshots at dispatch and result insert; not event time or exact commit time',
    sourceAssessment: request.evidence.sourceAssessment ?? null,
    inputHistoryPolicy:request.evidence.inputHistoryPolicy??null,
    servingIndependent: true,
  };
}

export interface ShadowRunnerDeps<T> {
  prepare: (context: T) => Promise<ShadowRequest | null>;
  infer: (body: ShadowBody) => Promise<unknown>;
  finish: (request: ShadowRequest, result: ShadowCompletion) => Promise<void>;
  now?: () => Date;
  monotonicNow?: () => number;
}
export async function runLiveWinnerShadow<T>(context: T, deps: ShadowRunnerDeps<T>): Promise<void> {
  // prepare commits the immutable attempt before inference. Duplicate attempts stop here.
  const request = await deps.prepare(context);
  if (!request) return;
  let response: Record<string, unknown> | null = null;
  let completedAt: Date;
  let status: ShadowCompletion['status'] = 'error', reason: string | null = 'shadow_inference_failed';
  let diagnostics:Record<string,unknown>={};let inferenceDurationSeconds:number|null=null;
  const mono=deps.monotonicNow??(()=>performance.now());
  const capture=request.evidence.outcomeKnownAtCapture;
  if(capture!==false||request.outcomeKnownAtDispatch!==false){
    completedAt=(deps.now??(()=>new Date()))();
    const known=capture===true||request.outcomeKnownAtDispatch===true;
    await deps.finish(request,{status:'unavailable',reason:known?'shadow_outcome_known_before_inference':'shadow_outcome_status_unverified',
      completedAt,response:null,assessment:{...shadowAssessment(request,completedAt),inferenceCalled:false,inferenceDurationSeconds:null}});
    return;
  }
  let raw:unknown;const started=mono();
  try {
    raw = await deps.infer(request.body);
    completedAt = (deps.now ?? (() => new Date()))();
    response = checkedShadowResponse(raw, request.body, completedAt, request.dispatchedAt);
    status = response.status === 'shadow_predicted' ? 'predicted' : 'unavailable';
    reason = status === 'predicted' ? null : response.reason as string;
  } catch (err) {
    completedAt = (deps.now ?? (() => new Date()))();
    const code = (err as Error)?.message;
    if(err instanceof ShadowDiagnosticError){reason=err.code;diagnostics={...err.diagnostics};
      if(reason==='shadow_input_contract_rejected'||reason==='shadow_request_rejected')status='unavailable';
    } else if (['shadow_response_contract_rejected', 'shadow_service_timeout', 'shadow_service_unauthorized',
      'shadow_service_unavailable', 'shadow_service_token_missing'].includes(code)) reason = code;
    if(raw!==undefined)diagnostics.responseMetadata=safeResponseMetadata(raw);
  }
  const elapsed=mono()-started;
  if(Number.isFinite(elapsed)&&elapsed>=0)inferenceDurationSeconds=elapsed/1000;
  await deps.finish(request, { status, reason, completedAt, response,
    assessment:{...shadowAssessment(request,completedAt),diagnostics,inferenceCalled:true,inferenceDurationSeconds} });
}
