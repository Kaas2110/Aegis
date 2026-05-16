/**
 * Сервис «исхода прематч-предсказаний».
 *
 * Архитектура:
 *  1. Когда матч начинается (LiveWorker впервые видит matchId): записываем в
 *     prematch_outcomes прогноз модели (вероятность победы Radiant) ЕСЛИ его
 *     там ещё нет.
 *  2. Когда матч исчезает из /api/live: пытаемся получить финальный исход через
 *     OpenDota /matches/{id} и записываем actualRadiantWin + scores.
 *  3. Раз в 6 часов фоновая задача добивает «недорезолвленные» матчи (когда
 *     OpenDota запоздалая обработка).
 *
 * Эта таблица не подвержена prune-джобу — она и есть «золотой ledger» для
 * метрик качества модели (accuracy, calibration, Brier score) на out-of-sample
 * данных.
 */

import { db, prematchOutcomesTable } from '@workspace/db';
import { eq, isNull, and, lt, sql, isNotNull } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { withOpenDotaKey } from '../lib/openDotaUrl';

// Раз в час, чтобы успевать за live-воркером. При 6 одновременных матчах
// LiveWorker видит ~6 новых рядов в час; resolver обрабатывает до 100 за тик
// со сном 1.1с между OpenDota запросами — суммарно ~110с на тик.
const RESOLVE_INTERVAL_MS = 60 * 60 * 1000;
const RESOLVE_BATCH_SIZE = 100;
const OPENDOTA_MATCH_URL = 'https://api.opendota.com/api/matches';

let resolverTimer: ReturnType<typeof setTimeout> | null = null;

interface SeenMatch {
  matchId: number;
  modelVersion: string;
  predictedRadiantWinProb: number;
  predictedConfidence?: number;
  radiantTeamId?: number | null;
  direTeamId?: number | null;
  radiantName?: string | null;
  direName?: string | null;
  features?: Record<string, number>;
}

/** Записывает прематч-прогноз для матча. Идемпотентно (UNIQUE на match_id). */
export async function recordPrematchPrediction(p: SeenMatch): Promise<void> {
  try {
    await db.insert(prematchOutcomesTable).values({
      matchId: p.matchId,
      modelVersion: p.modelVersion,
      radiantTeamId: p.radiantTeamId ?? null,
      direTeamId: p.direTeamId ?? null,
      radiantName: p.radiantName ?? null,
      direName: p.direName ?? null,
      predictedRadiantWinProb: p.predictedRadiantWinProb,
      predictedConfidence: p.predictedConfidence ?? null,
      features: p.features ?? null,
    }).onConflictDoNothing({ target: prematchOutcomesTable.matchId });
  } catch (err) {
    logger.warn({ err: String(err), matchId: p.matchId }, '[OutcomeTracker] insert failed');
  }
}

interface OpenDotaMatchSummary {
  match_id: number;
  radiant_win?: boolean;
  radiant_score?: number;
  dire_score?: number;
  duration?: number;
  start_time?: number;
}

async function fetchMatchSummary(matchId: number): Promise<OpenDotaMatchSummary | null> {
  try {
    const resp = await fetch(withOpenDotaKey(`${OPENDOTA_MATCH_URL}/${matchId}`), {
      headers: { 'User-Agent': 'DotaEdgeAnalyzer/1.0' },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as OpenDotaMatchSummary;
    if (typeof data.radiant_win !== 'boolean') return null;
    return data;
  } catch {
    return null;
  }
}

/** Фоновая задача: дорезолвить незакрытые исходы. */
async function resolveUnsettled(): Promise<void> {
  // FIFO: самые старые незарезолвленные первыми, чтобы backlog не накапливался.
  const pending = await db
    .select({ matchId: prematchOutcomesTable.matchId })
    .from(prematchOutcomesTable)
    .where(isNull(prematchOutcomesTable.actualRadiantWin))
    .orderBy(prematchOutcomesTable.predictedAt)
    .limit(RESOLVE_BATCH_SIZE);

  if (pending.length === 0) {
    logger.debug('[OutcomeTracker] no unsettled outcomes to resolve');
    return;
  }

  let resolved = 0;
  for (const row of pending) {
    const summary = await fetchMatchSummary(row.matchId);
    if (!summary) {
      // Спим 1.1с между запросами — OpenDota free tier
      await new Promise(r => setTimeout(r, 1100));
      continue;
    }
    await db
      .update(prematchOutcomesTable)
      .set({
        actualRadiantWin: summary.radiant_win!,
        actualRadiantScore: summary.radiant_score ?? null,
        actualDireScore: summary.dire_score ?? null,
        actualDurationSec: summary.duration ?? null,
        resolvedAt: new Date(),
      })
      .where(eq(prematchOutcomesTable.matchId, row.matchId));
    resolved++;
    await new Promise(r => setTimeout(r, 1100));
  }
  logger.info({ checked: pending.length, resolved }, '[OutcomeTracker] resolver tick');
}

export function startOutcomeTracker(): void {
  if (resolverTimer) return;
  logger.info({ intervalH: 6 }, '[OutcomeTracker] starting');
  // Первый запуск через 5 минут (даём серверу подняться)
  resolverTimer = setTimeout(function tick() {
    void resolveUnsettled().finally(() => {
      resolverTimer = setTimeout(tick, RESOLVE_INTERVAL_MS);
    });
  }, 5 * 60 * 1000);
}

export function stopOutcomeTracker(): void {
  if (resolverTimer) {
    clearTimeout(resolverTimer);
    resolverTimer = null;
  }
}

/** Метрики качества модели для админки. */
export async function getModelAccuracyMetrics(): Promise<{
  totalPredictions: number;
  resolved: number;
  pending: number;
  accuracy: number | null;
  brierScore: number | null;
  byModel: Array<{ modelVersion: string; resolved: number; accuracy: number; brierScore: number }>;
  byTier: Array<{ tier: 't1' | 't2' | 't3' | 'unknown'; resolved: number; accuracy: number; brierScore: number }>;
  recent: Array<{
    matchId: number;
    modelVersion: string;
    predictedRadiantWinProb: number;
    actualRadiantWin: boolean | null;
    radiantName: string | null;
    direName: string | null;
    resolvedAt: Date | null;
  }>;
}> {
  const totals = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(actual_radiant_win)::int AS resolved
    FROM prematch_outcomes
  `);
  const trow = (totals.rows[0] ?? { total: 0, resolved: 0 }) as { total: number; resolved: number };

  const byModel = await db.execute(sql`
    SELECT
      model_version AS "modelVersion",
      COUNT(*)::int AS resolved,
      AVG(
        CASE
          WHEN (predicted_radiant_win_prob >= 0.5) = actual_radiant_win THEN 1.0
          ELSE 0.0
        END
      )::float AS accuracy,
      AVG(
        POWER(predicted_radiant_win_prob - (CASE WHEN actual_radiant_win THEN 1 ELSE 0 END), 2)
      )::float AS "brierScore"
    FROM prematch_outcomes
    WHERE actual_radiant_win IS NOT NULL
    GROUP BY model_version
    ORDER BY resolved DESC
    LIMIT 10
  `);

  const recentRows = await db
    .select({
      matchId: prematchOutcomesTable.matchId,
      modelVersion: prematchOutcomesTable.modelVersion,
      predictedRadiantWinProb: prematchOutcomesTable.predictedRadiantWinProb,
      actualRadiantWin: prematchOutcomesTable.actualRadiantWin,
      radiantName: prematchOutcomesTable.radiantName,
      direName: prematchOutcomesTable.direName,
      resolvedAt: prematchOutcomesTable.resolvedAt,
    })
    .from(prematchOutcomesTable)
    .where(isNotNull(prematchOutcomesTable.actualRadiantWin))
    .orderBy(sql`resolved_at DESC NULLS LAST`)
    .limit(20);

  const overallAccRow = await db.execute(sql`
    SELECT
      AVG(CASE WHEN (predicted_radiant_win_prob >= 0.5) = actual_radiant_win THEN 1.0 ELSE 0.0 END)::float AS accuracy,
      AVG(POWER(predicted_radiant_win_prob - (CASE WHEN actual_radiant_win THEN 1 ELSE 0 END), 2))::float AS brier
    FROM prematch_outcomes
    WHERE actual_radiant_win IS NOT NULL
  `);
  const acc = overallAccRow.rows[0] as { accuracy: number | null; brier: number | null } | undefined;

  // Per-tier breakdown: тир определяется ТЕКУЩИМИ рейтингами команд
  // в таблице teams (порог как в lib/tier.ts: t1 ≥1400, t2 ≥1200, иначе t3).
  // Если рейтинга нет — попадает в 'unknown'. Это снимок «тира на момент
  // запроса метрик», а не «тира на момент предсказания» — для отчёта
  // достаточно, точное историческое снапшотирование тира можно добавить
  // позже сохранением tier в prematch_outcomes.metadata.
  const byTierRows = await db.execute(sql`
    SELECT
      CASE
        WHEN rt.rating IS NULL OR dt.rating IS NULL THEN 'unknown'
        WHEN (rt.rating + dt.rating) / 2.0 >= 1400 THEN 't1'
        WHEN (rt.rating + dt.rating) / 2.0 >= 1200 THEN 't2'
        ELSE 't3'
      END AS tier,
      COUNT(*)::int AS resolved,
      AVG(CASE WHEN (predicted_radiant_win_prob >= 0.5) = actual_radiant_win THEN 1.0 ELSE 0.0 END)::float AS accuracy,
      AVG(POWER(predicted_radiant_win_prob - (CASE WHEN actual_radiant_win THEN 1 ELSE 0 END), 2))::float AS "brierScore"
    FROM prematch_outcomes po
    LEFT JOIN teams rt ON rt.team_id = po.radiant_team_id
    LEFT JOIN teams dt ON dt.team_id = po.dire_team_id
    WHERE po.actual_radiant_win IS NOT NULL
    GROUP BY tier
    ORDER BY tier
  `);

  return {
    totalPredictions: trow.total,
    resolved: trow.resolved,
    pending: trow.total - trow.resolved,
    accuracy: acc?.accuracy ?? null,
    brierScore: acc?.brier ?? null,
    byModel: byModel.rows as Array<{ modelVersion: string; resolved: number; accuracy: number; brierScore: number }>,
    byTier: byTierRows.rows as Array<{ tier: 't1' | 't2' | 't3' | 'unknown'; resolved: number; accuracy: number; brierScore: number }>,
    recent: recentRows,
  };
}

/** Удалить snapshot'ы старше N дней.
 *  Backfill-снапшоты (source='backfill') не прунятся — они синтетические
 *  исторические данные и должны жить до ручного удаления. */
export async function pruneLiveSnapshots(days: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM live_snapshots
    WHERE captured_at < now() - (${days}::int * interval '1 day')
      AND (source = 'live' OR source IS NULL)
  `);
  // node-postgres .execute() возвращает {rowCount} но Drizzle обернул, проверим
  const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  logger.info({ days, deleted: count }, '[OutcomeTracker] live_snapshots pruned');
  return count;
}
