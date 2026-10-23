/** Admission for the legacy logistic live branch only. Shape != semantic approval. */
import { evidenceHash } from '../lib/predictionEvidence';
import { LIVE_OBSERVATION_SCHEMA_HASH } from '../lib/liveObservationContract';
import { validateLegacyLiveArtifact, type LiveRegistryArtifact } from './liveWinnerRegistryGuard';

export const LEGACY_BUILDING_DECODER_ID = 'legacy-bits-r0-10-d11-21-v1';
export const LEGACY_SERVING_REVIEW_SCHEMA = 'legacy-live-serving-review-v1';
export const LEGACY_LIVE_QUALITY_POLICY_ID = 'observed-state-v4-receipt180s-declared300s-event-latency-unverified';

export interface LegacyLiveServingRow extends LiveRegistryArtifact {
  version: unknown;
  metadata?: unknown;
}
export interface ReviewedLegacyLiveApproval {
  approvalId: string;
  modelVersion: string;
  artifactSha256: string;
  featureSchemaSha256: string;
  observedInputSchemaSha256: string;
  buildingDecoderId: typeof LEGACY_BUILDING_DECODER_ID;
  qualityPolicyId: typeof LEGACY_LIVE_QUALITY_POLICY_ID;
  qualityReportSha256: string;
  status: 'validated';
}

// Intentionally empty. No review currently establishes the meaning of the
// legacy tower input. A metadata flag cannot approve itself. A real entry
// requires independent input/decoder/evaluation evidence and code review.
export const REVIEWED_LEGACY_LIVE_APPROVALS: readonly ReviewedLegacyLiveApproval[] = Object.freeze([]);

export type LegacyLiveServingAdmission =
  | { ok: true; approvalId: string; artifactSha256: string; featureSchemaSha256: string }
  | { ok: false; reason: string };

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

export function legacyLiveArtifactFingerprint(row: LiveRegistryArtifact): string {
  return evidenceHash({engine: row.engine, algorithm: row.algorithm, features: row.features, weights: row.weights});
}
export function legacyLiveFeatureSchemaFingerprint(features: unknown): string {
  return evidenceHash({version: 'legacy-live-ordered-positional-features-v1', names: features});
}

export function validateLegacyLiveServingAdmission(
  row: LegacyLiveServingRow,
  trustedReviews: readonly ReviewedLegacyLiveApproval[] = REVIEWED_LEGACY_LIVE_APPROVALS,
): LegacyLiveServingAdmission {
  const shape = validateLegacyLiveArtifact(row);
  if (!shape.ok) return {ok: false, reason: shape.reason};
  if (typeof row.version !== 'string' || row.version.length === 0)
    return {ok: false, reason: 'missing_model_version'};
  const m = record(row.metadata) ? row.metadata.servingValidation : undefined;
  if (!record(m)) return {ok: false, reason: 'missing_live_serving_review'};
  if (m.schema !== LEGACY_SERVING_REVIEW_SCHEMA || m.status !== 'validated')
    return {ok: false, reason: 'live_serving_review_not_validated'};
  if (typeof m.approvalId !== 'string' || !m.approvalId || !sha(m.artifactSha256)
      || !sha(m.featureSchemaSha256) || !sha(m.observedInputSchemaSha256)
      || !sha(m.qualityReportSha256))
    return {ok: false, reason: 'malformed_live_serving_review'};
  const artifactSha256 = legacyLiveArtifactFingerprint(row);
  const featureSchemaSha256 = legacyLiveFeatureSchemaFingerprint(row.features);
  if (m.artifactSha256 !== artifactSha256 || m.featureSchemaSha256 !== featureSchemaSha256
      || m.modelVersion !== row.version)
    return {ok: false, reason: 'live_serving_artifact_review_mismatch'};
  if (m.observedInputSchemaSha256 !== LIVE_OBSERVATION_SCHEMA_HASH
      || m.buildingDecoderId !== LEGACY_BUILDING_DECODER_ID
      || m.qualityPolicyId !== LEGACY_LIVE_QUALITY_POLICY_ID)
    return {ok: false, reason: 'live_serving_input_contract_unverified'};
  const approved = trustedReviews.some(review => review.status === 'validated'
    && review.approvalId === m.approvalId && review.modelVersion === row.version
    && review.artifactSha256 === artifactSha256 && review.featureSchemaSha256 === featureSchemaSha256
    && review.observedInputSchemaSha256 === LIVE_OBSERVATION_SCHEMA_HASH
    && review.buildingDecoderId === LEGACY_BUILDING_DECODER_ID
    && review.qualityPolicyId === LEGACY_LIVE_QUALITY_POLICY_ID
    && review.qualityReportSha256 === m.qualityReportSha256);
  if (!approved) return {ok: false, reason: 'no_independently_reviewed_live_contract'};
  return {ok: true, approvalId: m.approvalId, artifactSha256, featureSchemaSha256};
}
