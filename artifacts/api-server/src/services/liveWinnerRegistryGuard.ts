/** Guard for this legacy positional logistic loader only; no inference changes. */
const LEGACY_FEATURES = [
  'bias', 'game_time_norm', 'nw_lead_norm', 'kill_diff_norm', 'tower_diff_norm',
  'prematch_logit', 'is_real_live', 'has_draft', 'recency_days_norm',
] as const;

export interface LiveRegistryArtifact {
  engine: unknown;
  algorithm: unknown;
  features: unknown;
  weights: unknown;
  binaryBlob?: unknown;
}

export type LegacyLiveValidation =
  | { ok: true; dimensions: 6 | 9; weights: number[] }
  | { ok: false; reason: string };

export function validateLegacyLiveArtifact(row: LiveRegistryArtifact): LegacyLiveValidation {
  if (row.engine !== 'logreg') return { ok: false, reason: 'unsupported_engine' };
  if (row.algorithm !== 'logistic_regression_live') return { ok: false, reason: 'unsupported_algorithm' };
  if (row.binaryBlob != null) return { ok: false, reason: 'unexpected_binary_artifact' };
  const features = row.features;
  if (!Array.isArray(features) || (features.length !== 6 && features.length !== 9)
      || LEGACY_FEATURES.slice(0, features.length).some((name, i) => features[i] !== name)) {
    return { ok: false, reason: 'unsupported_feature_contract' };
  }
  const weights = row.weights;
  if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) {
    return { ok: false, reason: 'invalid_weights_object' };
  }
  const dimensions = features.length as 6 | 9;
  const keys = Object.keys(weights);
  if (keys.length !== dimensions || keys.some(key => !/^w[0-8]$/.test(key) || Number(key.slice(1)) >= dimensions)) {
    return { ok: false, reason: 'incomplete_or_extra_weights' };
  }
  const validated: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    const key = `w${i}`;
    const value = (weights as Record<string, unknown>)[key];
    if (!Object.prototype.hasOwnProperty.call(weights, key) || typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, reason: 'nonfinite_or_missing_weight' };
    }
    validated.push(value);
  }
  // The old six-feature contract intentionally leaves the last three inputs
  // unused. Only a fully validated six-weight row receives these padding zeros.
  while (validated.length < LEGACY_FEATURES.length) validated.push(0);
  return { ok: true, dimensions, weights: validated };
}

/** Latest-started reload owns the cache, regardless of completion order. */
export class LiveRegistryCache<T> {
  private generation = 0;
  private value: T | null = null;

  beginReload(): number {
    return ++this.generation;
  }

  finishReload(generation: number, value: T | null): boolean {
    if (generation !== this.generation) return false;
    this.value = value;
    return true;
  }

  failReload(generation: number): boolean {
    return this.finishReload(generation, null);
  }

  get(): T | null {
    return this.value;
  }
}
