/**
 * Wave 3.A — агрегация BO3/BO5 серий из pro_matches.series_id.
 *
 * Подход:
 *   - Группируем pro_matches по series_id (NOT NULL, series_type IN (1,2)).
 *   - В одной серии порядок карт = ORDER BY start_time.
 *   - Для каждой карты: радиант = radiantTeamId, дайр = direTeamId, победитель
 *     стороны = radiantWin ? 'radiant' : 'dire'.
 *   - Канонически teamA = меньший teamId, teamB = больший. winsA/winsB
 *     считаются глобально для серии.
 *   - finished = true если кто-то набрал 2 победы (BO3) или 3 победы (BO5).
 *
 * Идемпотентно: ON CONFLICT DO UPDATE по seriesId, обновляет maps + winsA/B
 * + updatedAt. Нет каскадного удаления. Re-run безопасен.
 *
 * Запуск:  pnpm --filter @workspace/scripts run compute:bo3-series [days=180]
 */

import { db, proMatchesTable, bo3SeriesTable } from '@workspace/db';
import { gte, isNotNull, and, inArray, asc } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

const DEFAULT_DAYS = 180;

interface MatchRow {
  matchId: number;
  seriesId: number;
  seriesType: number;
  startTime: number;
  radiantTeamId: number | null;
  direTeamId: number | null;
  radiantWin: boolean;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const days = arg ? Math.max(7, parseInt(arg, 10)) : DEFAULT_DAYS;
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  console.log(`[compute-bo3-series] window=${days}d since=${new Date(since * 1000).toISOString()}`);

  // Шаг 1: находим все series_id, у которых хотя бы одна карта попала в окно.
  const recent = await db
    .select({ seriesId: proMatchesTable.series_id })
    .from(proMatchesTable)
    .where(and(gte(proMatchesTable.startTime, since), isNotNull(proMatchesTable.series_id), inArray(proMatchesTable.series_type, [1, 2])));
  const seriesIds = Array.from(new Set(recent.map(r => r.seriesId).filter((x): x is number => x != null)));
  console.log(`[compute-bo3-series] series in window=${seriesIds.length}`);
  if (seriesIds.length === 0) return;

  // Шаг 2: тянем ВСЕ карты этих series_id (без time-фильтра), чтобы не
  // обрезать серию у границы окна — иначе winsA/winsB и mapNumber поедут.
  const rows: MatchRow[] = await db
    .select({
      matchId: proMatchesTable.matchId,
      seriesId: proMatchesTable.series_id,
      seriesType: proMatchesTable.series_type,
      startTime: proMatchesTable.startTime,
      radiantTeamId: proMatchesTable.radiantTeamId,
      direTeamId: proMatchesTable.direTeamId,
      radiantWin: proMatchesTable.radiantWin,
    })
    .from(proMatchesTable)
    .where(and(inArray(proMatchesTable.series_id, seriesIds), inArray(proMatchesTable.series_type, [1, 2])))
    .orderBy(asc(proMatchesTable.startTime)) as MatchRow[];

  console.log(`[compute-bo3-series] full-series matches=${rows.length}`);
  if (rows.length === 0) return;

  const bySeries = new Map<number, MatchRow[]>();
  for (const r of rows) {
    if (!r.seriesId) continue;
    let list = bySeries.get(r.seriesId);
    if (!list) { list = []; bySeries.set(r.seriesId, list); }
    list.push(r);
  }
  console.log(`[compute-bo3-series] distinct series=${bySeries.size}`);

  let upserted = 0;
  for (const [seriesId, mapsRaw] of bySeries) {
    if (mapsRaw.length === 0) continue;
    const seriesType = mapsRaw[0].seriesType;
    const format = seriesType === 2 ? 2 : 1;
    const target = format === 2 ? 3 : 2;

    // Канонический порядок команд серии: пытаемся определить по первой карте.
    const first = mapsRaw[0];
    if (!first.radiantTeamId || !first.direTeamId) continue;
    const teamAId = Math.min(first.radiantTeamId, first.direTeamId);
    const teamBId = Math.max(first.radiantTeamId, first.direTeamId);

    let winsA = 0;
    let winsB = 0;
    const maps = mapsRaw.map((m, idx) => {
      const winnerSide: 'radiant' | 'dire' = m.radiantWin ? 'radiant' : 'dire';
      const winnerTeamId = m.radiantWin ? m.radiantTeamId : m.direTeamId;
      if (winnerTeamId === teamAId) winsA++;
      else if (winnerTeamId === teamBId) winsB++;
      return {
        mapNumber: idx + 1,
        matchId: m.matchId,
        finished: true,  // в pro_matches мы видим только сыгранные карты
        winnerSide,
        radiantTeamId: m.radiantTeamId ?? undefined,
        direTeamId: m.direTeamId ?? undefined,
      };
    });

    const finished = winsA >= target || winsB >= target;

    await db.insert(bo3SeriesTable).values({
      seriesId,
      teamAId,
      teamBId,
      format,
      maps,
      winsA,
      winsB,
      finished,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: bo3SeriesTable.seriesId,
      set: {
        teamAId,
        teamBId,
        format,
        maps: sql`excluded.maps`,
        winsA,
        winsB,
        finished,
        updatedAt: new Date(),
      },
    });
    upserted++;
  }

  console.log(`[compute-bo3-series] upserted ${upserted} series`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[compute-bo3-series] FATAL', err);
    process.exit(1);
  });
