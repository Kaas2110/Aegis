/**
 * D1 — Feature view versions.
 *
 * Единый источник правды о том, какая версия фичей сейчас «свежая» для каждого
 * семейства моделей. Используется:
 *  - PredictionModel при загрузке активной модели → если featuresVersion < CURRENT,
 *    логируется warning «running on stale feature view» (но модель используется,
 *    fallback'и важнее).
 *  - Admin endpoint /api/admin/models/:id/calibration → отдаёт `staleFeatureView`
 *    флаг, чтобы UI показал badge «устаревший fv».
 *  - Train-скрипты могут опираться при выборе jobs (но текущий train-lightgbm
 *    обучает все fv параллельно — это нормально и не противоречит этим
 *    константам).
 *
 * Правило: bump'аем CURRENT при добавлении новой v{n} фичевой версии в train
 * (например, появление фичи `peerSynergy` уже было покрыто v3). Старые fv
 * остаются жить в БД как fallback.
 */

export const FEATURE_VIEW = {
  /** Prematch winner: v1 team-only, v2 team+hero, v3 team+hero+player. */
  PREMATCH: 3,
  /** Live winner (LR / LightGBM поверх live_snapshots). */
  LIVE_WINNER: 1,
  /** Live totals — T3.5 kills/duration regression. */
  LIVE_TOTALS: 1,
  /** Derived markets (FB / total_kills / total_duration + квантили). */
  MARKET: 1,
} as const;

export type FeatureViewKey = keyof typeof FEATURE_VIEW;

/**
 * Возвращает «текущую» fv для указанного семейства моделей по `kind`.
 * Возвращает null, если kind не маппится (новый kind → не считаем stale).
 */
export function currentFeatureViewFor(kind: string): number | null {
  if (kind === 'live_winner' || kind === 'live_winner_lgbm') return FEATURE_VIEW.LIVE_WINNER;
  if (kind.startsWith('live_total_')) return FEATURE_VIEW.LIVE_TOTALS;
  if (kind.startsWith('market_')) return FEATURE_VIEW.MARKET;
  if (kind === 'prematch_winner' || kind.startsWith('prematch_winner_')) return FEATURE_VIEW.PREMATCH;
  return null;
}
