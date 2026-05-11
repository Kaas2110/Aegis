/**
 * Бакетирование пар команд по тиру для раздельных моделей.
 *
 * Тир определяется средним Glicko-рейтингом пары (radiant + dire) / 2.
 * Это даёт более устойчивую классификацию, чем брать тир каждой команды
 * отдельно: пара T1 vs T3 попадёт в T2-бакет, что и логично — апсет-зона.
 *
 * Пороги стартовые. После первого прогона можно подкрутить, чтобы выровнять
 * распределение матчей по бакетам (~33/33/33%).
 */

export type Tier = 't1' | 't2' | 't3';

export const TIER_THRESHOLDS = {
  /** avg(rating) >= 1400 → T1 (топ-команды, чёткие фавориты). */
  t1Min: 1400,
  /** 1200 <= avg(rating) < 1400 → T2 (мид-тир, много апсетов). */
  t2Min: 1200,
} as const;

/**
 * Классифицирует пару команд в тир по среднему рейтингу.
 * Возвращает null если хотя бы одна команда без рейтинга — такие матчи
 * идут в fallback-модель.
 */
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

/**
 * Имя `kind` в таблице model_versions для модели данного тира.
 * Зеркалится между training script и API server, поэтому утилита
 * дублируется в обоих пакетах (тривиальный код, шарить либ не оправдано).
 */
export function tierKind(tier: Tier): 'prematch_winner_t1' | 'prematch_winner_t2' | 'prematch_winner_t3' {
  return `prematch_winner_${tier}` as const;
}

/** Все возможные kind'ы прематч-моделей, которые могут быть активны одновременно. */
export const ALL_PREMATCH_KINDS = [
  'prematch_winner',         // fallback (тренируется на всех матчах)
  'prematch_winner_t1',
  'prematch_winner_t2',
  'prematch_winner_t3',
] as const;

export type PrematchKind = typeof ALL_PREMATCH_KINDS[number];
