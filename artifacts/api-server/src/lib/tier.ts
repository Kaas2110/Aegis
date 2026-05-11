/**
 * Inference-side зеркало tier-классификации из scripts/src/lib/tier.ts.
 * См. там же rationale выбора порогов.
 */

export type Tier = 't1' | 't2' | 't3';

export const TIER_THRESHOLDS = {
  t1Min: 1400,
  t2Min: 1200,
} as const;

export function classifyTier(
  radiantRating: number | null | undefined,
  direRating: number | null | undefined,
): Tier | null {
  if (radiantRating == null || direRating == null) return null;
  const avg = (radiantRating + direRating) / 2;
  if (avg >= TIER_THRESHOLDS.t1Min) return 't1';
  if (avg >= TIER_THRESHOLDS.t2Min) return 't2';
  return 't3';
}

export function tierKind(tier: Tier): 'prematch_winner_t1' | 'prematch_winner_t2' | 'prematch_winner_t3' {
  return `prematch_winner_${tier}` as const;
}

export const ALL_PREMATCH_KINDS = [
  'prematch_winner',
  'prematch_winner_t1',
  'prematch_winner_t2',
  'prematch_winner_t3',
] as const;

export type PrematchKind = typeof ALL_PREMATCH_KINDS[number];
