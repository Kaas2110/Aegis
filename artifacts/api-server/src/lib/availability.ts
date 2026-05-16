/**
 * Серверная сторона контракта `docs/data-availability-rules.md`.
 *
 * Содержит общие пороги для prune-логики, LiveWorker и формирования
 * `match.status`. Mobile-зеркало — `artifacts/mobile/lib/availability.ts`
 * (пороги ОБЯЗАНЫ совпадать).
 */

// Пороги (миллисекунды). См. docs/data-availability-rules.md §1.
export const FRESH_MS = 90 * 1000;                     // 0-90s
export const STALE_SOFT_MS = 3 * 60 * 1000;            // 90s-3min
export const LIVE_STALE_HARD_MS = 25 * 60 * 1000;      // 3-25min → дальше «карта закончилась»
export const LIKELY_ENDED_MS = 6 * 60 * 60 * 1000;     // 25min-6h

/** between_maps дольше этого — считаем что серия фактически закончилась без апдейта PandaScore. */
export const BETWEEN_MAPS_TIMEOUT_MS = 20 * 60 * 1000;
