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
  /**
   * Prematch winner: v1 team-only, v2 team+hero, v3 team+hero+player,
   * v4 = v3 + E1 OD-extension (roster/pool/baseline, +18 features).
   */
  PREMATCH: 4,
  /**
   * Asymmetric prematch winner (Этап B) — отдельная модель для матчей,
   * где у одной/обеих команд мало team-уровневой истории (games_180d<5),
   * но есть `match_drafts.{radiant,dire}_account_ids`. Заменяет null-ответ
   * основной v3 модели на player-driven предсказание. fv=1 (первая итерация).
   */
  PREMATCH_ASYM: 1,
  /**
   * Live winner (LR / LightGBM поверх live_snapshots).
   * v2 = v1 + E1 hero benchmarks (z-score current stats vs hero baseline, +8 features).
   */
  LIVE_WINNER: 2,
  /**
   * Asymmetric live winner (Этап C) — live-prior из asym-prematch для матчей,
   * где основной live-винер не может построить prematch-приор из-за отсутствия
   * team-уровневых данных. fv=1.
   */
  LIVE_WINNER_ASYM: 1,
  /**
   * Live totals — T3.5 kills/duration regression.
   * v2 = v1 + E1 hero benchmarks/item-popularity aggregates (+2 features).
   */
  LIVE_TOTALS: 2,
  /**
   * Derived markets (FB / total_kills / total_duration + квантили).
   * v2 = v1 + E1 OD-extension per-market aggregates
   * (kills: +2, duration: +4, FB: +2).
   */
  MARKET: 2,
} as const;

export type FeatureViewKey = keyof typeof FEATURE_VIEW;

/**
 * Возвращает «текущую» fv для указанного семейства моделей по `kind`.
 * Возвращает null, если kind не маппится (новый kind → не считаем stale).
 */
export function currentFeatureViewFor(kind: string): number | null {
  if (kind === 'live_winner' || kind === 'live_winner_lgbm') return FEATURE_VIEW.LIVE_WINNER;
  if (kind === 'live_winner_asym') return FEATURE_VIEW.LIVE_WINNER_ASYM;
  if (kind.startsWith('live_total_')) return FEATURE_VIEW.LIVE_TOTALS;
  if (kind.startsWith('market_')) return FEATURE_VIEW.MARKET;
  if (kind === 'prematch_winner_asym') return FEATURE_VIEW.PREMATCH_ASYM;
  if (kind === 'prematch_winner' || kind.startsWith('prematch_winner_')) return FEATURE_VIEW.PREMATCH;
  return null;
}
