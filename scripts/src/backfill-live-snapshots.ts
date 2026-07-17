/**
 * backfill:live-snapshots
 *
 * Заполняет live_snapshots синтетическими данными из OpenDota /api/matches/{id}.
 * Для каждого матча с известным исходом (prematch_outcomes), у которого ещё нет
 * backfill-снапшотов, запрашивает поминутный radiant_gold_adv[] и вставляет
 * синтетические строки с source='backfill'.
 *
 * Синтетические снапшоты не прунятся автоматически — они постоянные.
 * Повторный запуск идемпотентен: уже обработанные match_id пропускаются.
 *
 * CLI:
 *   --limit N       Макс. матчей за один запуск (default 300)
 *   --since-unix T  Обрабатывать только матчи >= T (default 365 дней назад)
 *   --min-pairs N   Остановиться заранее если пар уже >= N (default 200)
 *   --force         Перезаписать уже имеющиеся backfill-снапшоты
 */

import { db, liveSnapshotsTable, proMatchesTable, prematchOutcomesTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { withOpenDotaKey, odThrottleMs } from './lib/openDotaUrl';

const OPENDOTA_BASE = 'https://api.opendota.com/api';
const RATE_LIMIT_MS = odThrottleMs(100);

const TRAIN_WINDOW_DAYS = 365;

function parseArg(flag: string, def: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return def;
}

const LIMIT = parseArg('--limit', 300);
const MIN_PAIRS = parseArg('--min-pairs', 200);
const SINCE_UNIX = parseArg('--since-unix', Math.floor(Date.now() / 1000) - TRAIN_WINDOW_DAYS * 86_400);
const FORCE = process.argv.includes('--force');

interface OpenDotaMatchDetail {
  match_id: number;
  start_time: number;
  duration: number;
  radiant_win: boolean;
  radiant_score: number;
  dire_score: number;
  radiant_gold_adv: (number | null)[] | null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchMatchDetail(matchId: number): Promise<OpenDotaMatchDetail | null> {
  try {
    const resp = await fetch(withOpenDotaKey(`${OPENDOTA_BASE}/matches/${matchId}`), {
      headers: { 'User-Agent': 'DotaEdgeAnalyzer/1.0 backfill' },
    });
    if (resp.status === 404) {
      console.warn(`  [backfill] ${matchId}: not found`);
      return null;
    }
    if (resp.status === 429) {
      console.warn(`  [backfill] rate limited — sleeping 15s`);
      await sleep(15_000);
      return null;
    }
    if (!resp.ok) {
      console.warn(`  [backfill] ${matchId}: HTTP ${resp.status}`);
      return null;
    }
    return (await resp.json()) as OpenDotaMatchDetail;
  } catch (err) {
    console.warn(`  [backfill] ${matchId}: fetch error — ${(err as Error).message}`);
    return null;
  }
}

async function main() {
  console.log(`[backfill] since=${new Date(SINCE_UNIX * 1000).toISOString().slice(0, 10)} limit=${LIMIT} min-pairs=${MIN_PAIRS} force=${FORCE}`);

  // Текущее количество pro_matches с хотя бы одним снапшотом (live или backfill)
  const pairsRes = await db.execute(sql`
    SELECT COUNT(DISTINCT ls.match_id) AS cnt
    FROM live_snapshots ls
    JOIN pro_matches pm ON pm.match_id = ls.match_id
    WHERE pm.radiant_win IS NOT NULL
      AND ls.game_time_sec >= 60
  `);
  const existingPairs = Number((pairsRes.rows[0] as Record<string, unknown>)?.cnt ?? 0);
  console.log(`[backfill] matches with snapshots+outcome: ${existingPairs}`);

  if (!FORCE && existingPairs >= MIN_PAIRS) {
    console.log(`[backfill] already ${existingPairs} >= ${MIN_PAIRS} covered matches — exiting cleanly. Use --force to rerun.`);
    process.exit(0);
  }

  // Матчи, уже имеющие снапшоты (любой источник) — пропускаем
  const alreadyDoneRes = FORCE
    ? { rows: [] }
    : await db.execute(sql`SELECT DISTINCT match_id FROM live_snapshots`);
  const alreadyDone = new Set(
    (alreadyDoneRes.rows as { match_id: string | number }[]).map(r => Number(r.match_id)),
  );
  console.log(`[backfill] matches already have snapshots: ${alreadyDone.size}`);

  // Кандидаты: любые pro_matches с известным исходом, БЕЗ снапшотов, в окне
  const candidatesRes = await db.execute(sql`
    SELECT
      pm.match_id,
      pm.start_time,
      pm.radiant_team_id,
      pm.dire_team_id
    FROM pro_matches pm
    WHERE pm.radiant_win IS NOT NULL
      AND pm.start_time >= ${SINCE_UNIX}
    ORDER BY RANDOM()
    LIMIT ${LIMIT + alreadyDone.size + 50}
  `);

  type CandRow = { match_id: string; start_time: string; radiant_team_id: string | null; dire_team_id: string | null };
  const candidates = (candidatesRes.rows as CandRow[])
    .filter(r => !alreadyDone.has(Number(r.match_id)))
    .slice(0, LIMIT);

  console.log(`[backfill] candidates to process: ${candidates.length}`);

  let processed = 0, insertedSnapshots = 0, skipped = 0;

  for (const row of candidates) {
    const matchId = Number(row.match_id);
    const startTimeSec = Number(row.start_time);
    const radiantTeamId = row.radiant_team_id ? Number(row.radiant_team_id) : null;
    const direTeamId = row.dire_team_id ? Number(row.dire_team_id) : null;
    processed++;

    const detail = await fetchMatchDetail(matchId);
    await sleep(RATE_LIMIT_MS);

    if (!detail?.radiant_gold_adv?.length) {
      console.log(`  [${processed}/${candidates.length}] ${matchId}: no gold_adv — skip`);
      skipped++;
      continue;
    }

    const durationMin = Math.floor(detail.duration / 60);
    const goldAdv = detail.radiant_gold_adv;
    const totalRadiant = detail.radiant_score ?? 0;
    const totalDire = detail.dire_score ?? 0;
    const snapshots: {
      matchId: number;
      capturedAt: Date;
      gameTimeSec: number;
      radiantTeamId: number | null;
      direTeamId: number | null;
      radiantScore: number;
      direScore: number;
      radiantLead: number;
      buildingState: null;
      source: string;
      rawPayload: Record<string, unknown>;
    }[] = [];

    // Синтетический снапшот на каждую минуту от 3 до конца матча.
    // Тренировочный скрипт дополнительно сэмплирует (1 снапшот / 3-мин ведро),
    // так что плотность не критична.
    for (let min = 3; min <= Math.min(durationMin, goldAdv.length - 1); min++) {
      const goldAdvAtMin = goldAdv[min];
      if (goldAdvAtMin == null) continue;

      const progress = durationMin > 0 ? min / durationMin : 0;
      const gameTimeSec = min * 60;

      snapshots.push({
        matchId,
        capturedAt: new Date((startTimeSec + gameTimeSec) * 1000),
        gameTimeSec,
        radiantTeamId,
        direTeamId,
        // Линейная интерполяция убийств от итоговых значений
        radiantScore: Math.round(totalRadiant * progress),
        direScore: Math.round(totalDire * progress),
        radiantLead: goldAdvAtMin,
        buildingState: null,
        source: 'backfill',
        rawPayload: { source: 'backfill', minute: min, goldAdv: goldAdvAtMin },
      });
    }

    if (snapshots.length === 0) {
      console.log(`  [${processed}/${candidates.length}] ${matchId}: empty snapshots after filter — skip`);
      skipped++;
      continue;
    }

    // Если force — удаляем старые backfill перед вставкой
    if (FORCE) {
      await db.execute(sql`DELETE FROM live_snapshots WHERE match_id = ${matchId} AND source = 'backfill'`);
    }

    await db.insert(liveSnapshotsTable).values(snapshots);
    insertedSnapshots += snapshots.length;

    if (processed % 10 === 0 || processed === candidates.length) {
      console.log(`  progress: ${processed}/${candidates.length} matches — ${insertedSnapshots} snapshots inserted`);
    }
  }

  // Итого покрытых матчей после backfill
  const newPairsRes = await db.execute(sql`
    SELECT COUNT(DISTINCT ls.match_id) AS cnt
    FROM live_snapshots ls
    JOIN pro_matches pm ON pm.match_id = ls.match_id
    WHERE pm.radiant_win IS NOT NULL AND ls.game_time_sec >= 60
  `);
  const newPairs = Number((newPairsRes.rows[0] as Record<string, unknown>)?.cnt ?? 0);

  console.log(`\n[backfill] DONE`);
  console.log(`  matches processed: ${processed}`);
  console.log(`  snapshots inserted: ${insertedSnapshots}`);
  console.log(`  skipped: ${skipped}`);
  console.log(`  snapshot-outcome pairs now: ${newPairs} match(es)`);
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill] FATAL', err);
  process.exit(1);
});
