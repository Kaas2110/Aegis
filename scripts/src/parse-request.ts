/**
 * parse-request — T0.7 stage 1.
 *
 * Отправляет батч запросов на replay-парсинг OpenDota для матчей, у которых
 * is_parsed=false и нет активной записи в match_parse_queue. Идемпотентно:
 * повторный запуск пропускает уже поставленные в очередь матчи.
 *
 * OpenDota `POST /api/request/{match_id}` ставит .dem файл в очередь парсера
 * на их стороне (30-120s обработки). Возвращает { job: { jobId: number } }.
 *
 * Дефолтный лимит — 500 матчей за запуск, бережём квоту OD для оперативных
 * запросов. ETA 500 × 0.5s = ~4 минуты.
 *
 * CLI:
 *   --limit N        макс. запросов за запуск (default 500)
 *   --since-days D   рассматривать матчи моложе D дней (default 180)
 *   --order asc|desc по start_time (default desc — свежие сначала)
 *   --requeue-failed повторно запросить status='failed' или 'timeout' (default нет)
 *
 * Запуск: pnpm --filter @workspace/scripts run parse:request [-- --limit 500]
 */

import { db, proMatchesTable, matchParseQueueTable } from '@workspace/db';
import { and, eq, isNull, sql, or, inArray } from 'drizzle-orm';
import { withOpenDotaKey, odThrottleMs } from './lib/openDotaUrl';

// Premium OpenDota key: 3000 req/min = 50 req/s по всем эндпоинтам, неограниченно/мес.
// Держим 20 req/s — комфортный запас под параллельные скрипты (ingest:parsed,
// ingest:matches, live-poll). В replay-parse-loop скрипты идут последовательно,
// конкуренции нет.
const RATE_LIMIT_MS = odThrottleMs(50);

function arg(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10);
  return def;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

const LIMIT = arg('--limit', 500);
const SINCE_DAYS = arg('--since-days', 180);
const ORDER_DESC = !process.argv.includes('--order') || process.argv[process.argv.indexOf('--order') + 1] !== 'asc';
const REQUEUE_FAILED = flag('--requeue-failed');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function requestParse(matchId: number): Promise<{ jobId: number | null; error: string | null }> {
  try {
    const r = await fetch(withOpenDotaKey(`https://api.opendota.com/api/request/${matchId}`), {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { jobId: null, error: `HTTP ${r.status} ${body.slice(0, 120)}` };
    }
    const json = (await r.json()) as { job?: { jobId?: number } };
    return { jobId: json.job?.jobId ?? null, error: null };
  } catch (e) {
    return { jobId: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  console.log(`[parse-request] limit=${LIMIT} since=${SINCE_DAYS}d order=${ORDER_DESC ? 'desc' : 'asc'} requeueFailed=${REQUEUE_FAILED}`);

  const cutoff = Math.floor(Date.now() / 1000) - SINCE_DAYS * 86_400;

  // Селектор: pro_matches.is_parsed=false, нет успешной записи в queue.
  // При REQUEUE_FAILED — учитываем также 'failed'/'timeout' для retry.
  const skipStatuses = REQUEUE_FAILED ? ['queued', 'parsed'] : ['queued', 'parsed', 'failed', 'timeout'];

  const todo = await db
    .select({ matchId: proMatchesTable.matchId })
    .from(proMatchesTable)
    .leftJoin(matchParseQueueTable, eq(matchParseQueueTable.matchId, proMatchesTable.matchId))
    .where(
      and(
        eq(proMatchesTable.isParsed, false),
        sql`${proMatchesTable.startTime} >= ${cutoff}`,
        or(
          isNull(matchParseQueueTable.matchId),
          sql`${matchParseQueueTable.status} NOT IN (${sql.join(skipStatuses.map(s => sql`${s}`), sql`, `)})`,
        ),
      ),
    )
    .orderBy(ORDER_DESC ? sql`${proMatchesTable.startTime} DESC` : sql`${proMatchesTable.startTime} ASC`)
    .limit(LIMIT);

  console.log(`[parse-request] ${todo.length} matches selected (≈${(todo.length * RATE_LIMIT_MS / 1000 / 60).toFixed(1)} min)`);
  if (todo.length === 0) {
    console.log('[parse-request] Nothing to do.');
    process.exit(0);
  }

  let ok = 0, failed = 0;
  for (let i = 0; i < todo.length; i++) {
    const matchId = todo[i].matchId;
    const { jobId, error } = await requestParse(matchId);
    const status = error ? 'failed' : 'queued';

    await db.insert(matchParseQueueTable)
      .values({ matchId, status, jobId, lastError: error, attempts: 1 })
      .onConflictDoUpdate({
        target: matchParseQueueTable.matchId,
        set: {
          status,
          jobId: jobId ?? matchParseQueueTable.jobId,
          lastError: error,
          attempts: sql`${matchParseQueueTable.attempts} + 1`,
          requestedAt: new Date(),
          updatedAt: new Date(),
        },
      });

    if (error) {
      failed++;
      console.warn(`  [parse-request] ${matchId}: ${error}`);
    } else {
      ok++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  [parse-request] progress ${i + 1}/${todo.length} ok=${ok} failed=${failed}`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`[parse-request] Done. requested=${ok} failed=${failed}`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error('[parse-request] FATAL', e);
  process.exit(1);
});
