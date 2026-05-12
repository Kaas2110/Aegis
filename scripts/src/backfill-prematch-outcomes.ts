/**
 * backfill:prematch-outcomes
 *
 * Заполняет таблицу prematch_outcomes историческими записями для всех
 * про-матчей с известным исходом. Используется для:
 *   1. Увеличения training-набора live-модели (feature prematch_logit)
 *   2. Бэктест-метрик качества prematch-прогнозов
 *
 * Вычисляет prematch-вероятность по ELO-рейтингам команд (сигмоида
 * нормализованного разрыва + 30-дн. форма) — тот же подход что в
 * train-live-model.ts для fv=4.
 *
 * Уже существующие записи в prematch_outcomes пропускаются (ON CONFLICT DO NOTHING).
 *
 * CLI:
 *   pnpm --filter @workspace/scripts run backfill:prematch-outcomes
 *   [--limit N]        максимум матчей (default: все)
 *   [--dry-run]        не писать в БД
 *   [--since-unix N]   только матчи после этого времени
 */

import {
  db,
  proMatchesTable,
  teamsTable,
  teamRecentFormTable,
  prematchOutcomesTable,
} from '@workspace/db';
import { gte, and, isNotNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

const BATCH_SIZE = 500;

function parseCli() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    limit: get('--limit') ? parseInt(get('--limit')!, 10) : null,
    dryRun: args.includes('--dry-run'),
    sinceUnix: get('--since-unix') ? parseInt(get('--since-unix')!, 10) : null,
  };
}

function sigmoid(z: number): number {
  if (z >= 0) { const ez = Math.exp(-z); return 1 / (1 + ez); }
  const ez = Math.exp(z); return ez / (1 + ez);
}

function eloPrematchProb(
  rRating: number, dRating: number,
  rWins: number, rLosses: number,
  dWins: number, dLosses: number,
  rWinrate30: number | null,
  dWinrate30: number | null,
): number {
  const eloDiff = (rRating - dRating) / 200;
  const rWr = rWins / Math.max(rWins + rLosses, 1);
  const dWr = dWins / Math.max(dWins + dLosses, 1);
  const wrDiff = (rWinrate30 ?? rWr) - (dWinrate30 ?? dWr);
  const combined = eloDiff * 0.7 + wrDiff * 0.3;
  return sigmoid(combined);
}

async function main() {
  const { limit, dryRun, sinceUnix } = parseCli();
  console.log(`[backfill:prematch-outcomes] dry-run=${dryRun} limit=${limit ?? 'all'} since=${sinceUnix ?? 'all'}`);

  // Загружаем рейтинги команд и 30-дн. форму
  console.log('[backfill:prematch-outcomes] Loading team ratings & form …');
  const [teamsRows, formRows] = await Promise.all([
    db.select({
      teamId: teamsTable.teamId,
      rating: teamsTable.rating,
      wins: teamsTable.wins,
      losses: teamsTable.losses,
      name: teamsTable.name,
    }).from(teamsTable),
    db.select({
      teamId: teamRecentFormTable.teamId,
      winRate: teamRecentFormTable.winRate,
    }).from(teamRecentFormTable).where(
      and(
        isNotNull(teamRecentFormTable.winRate),
        sql`${teamRecentFormTable.periodDays} = 30`,
      ),
    ),
  ]);

  const teamMap = new Map<number, { rating: number; wins: number; losses: number; name: string | null }>();
  for (const t of teamsRows) {
    if (t.rating != null) teamMap.set(t.teamId, { rating: t.rating, wins: t.wins ?? 0, losses: t.losses ?? 0, name: t.name });
  }
  const formMap = new Map<number, number>();
  for (const f of formRows) {
    if (f.winRate != null) formMap.set(f.teamId, f.winRate);
  }
  console.log(`[backfill:prematch-outcomes] teams=${teamMap.size} with ratings, form=${formMap.size} with 30d winrate`);

  // Существующие matchId (чтобы не дублировать)
  console.log('[backfill:prematch-outcomes] Fetching existing prematch_outcomes match IDs …');
  const existingRows = await db.execute(sql`SELECT match_id FROM prematch_outcomes`);
  const existingIds = new Set<number>(
    (existingRows.rows as { match_id: number }[]).map(r => r.match_id),
  );
  console.log(`[backfill:prematch-outcomes] existing records: ${existingIds.size}`);

  // Загружаем матчи с известными исходами и командами
  const conditions = [
    isNotNull(proMatchesTable.radiantWin),
    isNotNull(proMatchesTable.radiantTeamId),
    isNotNull(proMatchesTable.direTeamId),
  ];
  if (sinceUnix) conditions.push(gte(proMatchesTable.startTime, sinceUnix));

  const allMatches = await db.select({
    matchId: proMatchesTable.matchId,
    radiantTeamId: proMatchesTable.radiantTeamId,
    direTeamId: proMatchesTable.direTeamId,
    radiantWin: proMatchesTable.radiantWin,
    startTime: proMatchesTable.startTime,
    radiantScore: proMatchesTable.radiantScore,
    direScore: proMatchesTable.direScore,
    duration: proMatchesTable.duration,
  }).from(proMatchesTable).where(and(...conditions));

  // Фильтруем уже существующие
  const toProcess = allMatches
    .filter(m => !existingIds.has(m.matchId))
    .slice(0, limit ?? allMatches.length);

  console.log(`[backfill:prematch-outcomes] matches to process: ${toProcess.length} (skipping ${existingIds.size} existing)`);

  if (toProcess.length === 0) {
    console.log('[backfill:prematch-outcomes] Nothing to do — all matches already have prematch_outcomes.');
    process.exit(0);
  }

  // Вставляем батчами
  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const rows: (typeof prematchOutcomesTable.$inferInsert)[] = [];

    for (const m of batch) {
      const rId = m.radiantTeamId!;
      const dId = m.direTeamId!;
      const rTeam = teamMap.get(rId);
      const dTeam = teamMap.get(dId);

      if (!rTeam || !dTeam) {
        skipped++;
        continue;
      }

      const prob = eloPrematchProb(
        rTeam.rating, dTeam.rating,
        rTeam.wins, rTeam.losses,
        dTeam.wins, dTeam.losses,
        formMap.get(rId) ?? null,
        formMap.get(dId) ?? null,
      );

      rows.push({
        matchId: m.matchId,
        modelVersion: 'elo_backfill_v1',
        radiantTeamId: rId,
        direTeamId: dId,
        radiantName: rTeam.name ?? null,
        direName: dTeam.name ?? null,
        predictedRadiantWinProb: prob,
        predictedConfidence: null,
        // Исход уже известен — проставляем сразу
        actualRadiantWin: m.radiantWin ?? null,
        actualRadiantScore: m.radiantScore ?? null,
        actualDireScore: m.direScore ?? null,
        actualDurationSec: m.duration ?? null,
        resolvedAt: m.radiantWin != null ? new Date(m.startTime * 1000) : null,
        features: {
          elo_r: rTeam.rating,
          elo_d: dTeam.rating,
          wr30_r: formMap.get(rId) ?? -1,
          wr30_d: formMap.get(dId) ?? -1,
        },
      });
    }

    if (rows.length === 0) continue;

    if (!dryRun) {
      await db.insert(prematchOutcomesTable)
        .values(rows)
        .onConflictDoNothing({ target: prematchOutcomesTable.matchId });
    }
    inserted += rows.length;

    const pct = Math.round(((i + batch.length) / toProcess.length) * 100);
    process.stdout.write(`\r[backfill:prematch-outcomes] ${pct}% (${inserted} inserted, ${skipped} skipped — no team data)`);
  }

  console.log(`\n[backfill:prematch-outcomes] ✅ Done: ${inserted} inserted, ${skipped} skipped`);
  if (dryRun) console.log('[backfill:prematch-outcomes] DRY-RUN — nothing written to DB');
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill:prematch-outcomes] FATAL', err);
  process.exit(1);
});
