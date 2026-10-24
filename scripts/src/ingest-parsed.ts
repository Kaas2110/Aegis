import { openDotaBackgroundFetch as fetch, OdQuotaExhaustedError } from '@workspace/db/opendota';
/**
 * ingest-parsed — T0.7 stage 2.
 *
 * Для каждого матча в match_parse_queue со status='queued' старше 90s:
 *   GET /api/matches/{id}
 *   ├ version != null  → парс готов → сохранить в match_parsed, отметить
 *   │                    pro_matches.is_parsed=true, queue.status='parsed'
 *   ├ version == null  → ещё парсится; если requested_at > 2h назад →
 *   │                    queue.status='timeout', иначе оставить queued
 *   └ HTTP не-200      → attempts++, оставить queued
 *
 * Идемпотентно: запускайте каждые 10-30 минут (cron или вручную).
 * Не трогает уже parsed/failed/timeout записи (если только --reingest не передан).
 *
 * CLI:
 *   --limit N         макс. матчей за запуск (default 200)
 *   --timeout-hours H после H часов в queued → status='timeout' (default 2)
 *   --reingest        перетянуть match_parsed для status='parsed' (bump schema_ver)
 *
 * Запуск: pnpm --filter @workspace/scripts run ingest:parsed
 */

import {
  db,
  proMatchesTable,
  matchParseQueueTable,
  matchParsedTable,
} from '@workspace/db';
import { and, eq, sql } from 'drizzle-orm';
import { withOpenDotaKey, odThrottleMs } from './lib/openDotaUrl';
import { retainRawMatchResponse } from './lib/raw-match-response.js';
import { extractParsedPayload, PARSED_PAYLOAD_SCHEMA_VERSION } from './lib/parsed-payload';
import { planParsedWrite } from './lib/parsed-write.js';

// Every request uses the shared free OpenDota budget gate.
const RATE_LIMIT_MS = odThrottleMs(50);

// Текущая версия структуры payload. Бамп при изменении набора сохраняемых полей.
const PAYLOAD_SCHEMA_VERSION = PARSED_PAYLOAD_SCHEMA_VERSION;

function arg(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10);
  return def;
}

const LIMIT = arg('--limit', 200);
const TIMEOUT_HOURS = arg('--timeout-hours', 2);
const REINGEST = process.argv.includes('--reingest');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface OdMatchDetail {
  match_id: number;
  version?: number | null;
  players?: unknown;
  objectives?: unknown;
  teamfights?: unknown;
  draft_timings?: unknown;
}

async function fetchMatch(matchId: number): Promise<{ data: OdMatchDetail | null; receivedAt: Date | null; error: string | null }> {
  try {
    const requestStartedAt = new Date();
    const r = await fetch(withOpenDotaKey(`https://api.opendota.com/api/matches/${matchId}`), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return { data: null, receivedAt: null, error: `HTTP ${r.status}` };
    const data = (await r.json()) as OdMatchDetail;
    if (data.match_id !== matchId) return { data: null, receivedAt: null, error: 'Provider returned a different match ID' };
    const receivedAt = new Date();
    // The existing direct parser still receives the same complete object.
    const raw = retainRawMatchResponse(process.env.AEGIS_STATE_DIR, data,
      { matchId, job: 'ingest_parsed', requestStartedAt, receivedAt });
    if (raw.status === 'not_retained') console.warn(`[raw-match-json] ${matchId}: ${raw.reason}`);
    return { data, receivedAt, error: null };
  } catch (e) {
    if (e instanceof OdQuotaExhaustedError) throw e;
    return { data: null, receivedAt: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  console.log(`[ingest-parsed] limit=${LIMIT} timeoutH=${TIMEOUT_HOURS} reingest=${REINGEST} payloadSchemaVer=${PAYLOAD_SCHEMA_VERSION}`);

  const minAgeSec = 90; // не дёргать раньше чем через 90s после request
  const statusFilter = REINGEST ? 'parsed' : 'queued';

  const todo = await db
    .select({
      matchId: matchParseQueueTable.matchId,
      requestedAt: matchParseQueueTable.requestedAt,
      attempts: matchParseQueueTable.attempts,
    })
    .from(matchParseQueueTable)
    .where(
      and(
        eq(matchParseQueueTable.status, statusFilter),
        sql`${matchParseQueueTable.requestedAt} < NOW() - INTERVAL '${sql.raw(String(minAgeSec))} seconds'`,
      ),
    )
    .orderBy(sql`${matchParseQueueTable.requestedAt} ASC`)
    .limit(LIMIT);

  console.log(`[ingest-parsed] ${todo.length} matches to check (status=${statusFilter})`);
  if (todo.length === 0) {
    console.log('[ingest-parsed] Nothing to do.');
    process.exit(0);
  }

  let parsed = 0;
  let stillWaiting = 0;
  let timedOut = 0;
  let httpErrors = 0;

  // Shared quota errors abort before updating queue attempts or status.
  for (let i = 0; i < todo.length; i++) {
    const { matchId, requestedAt, attempts } = todo[i];
    const ageMs = Date.now() - new Date(requestedAt).getTime();
    const { data, receivedAt, error } = await fetchMatch(matchId);
    const payload = extractParsedPayload(data);

    if (error) {
      httpErrors++;
      await db.update(matchParseQueueTable)
        .set({
          attempts: attempts + 1,
          lastError: error,
          updatedAt: new Date(),
        })
        .where(eq(matchParseQueueTable.matchId, matchId));
    } else if (payload && receivedAt) {
      // ✓ parsed — три записи в одной транзакции, чтобы не оставить
      // несогласованное состояние (parsed row есть, но queue всё ещё queued
      // или pro_matches.is_parsed=false) при прерывании процесса.
      const now = new Date();
      await db.transaction(async (tx) => {
        const parent = await tx.select({ matchId: proMatchesTable.matchId }).from(proMatchesTable)
          .where(eq(proMatchesTable.matchId, matchId)).limit(1).for('update');
        if (!parent.length) throw new Error('parsed_write_parent_missing');
        const existing = await tx.select().from(matchParsedTable).where(eq(matchParsedTable.matchId, matchId)).limit(1);
        const plan = planParsedWrite(existing[0] ?? null, payload, { receivedAt, materializedAt: new Date() });
        if (plan.status === 'write') {
          const written = await tx.insert(matchParsedTable)
            .values({ matchId, ...plan.values, parsedAt: plan.parsedAt })
            .onConflictDoUpdate({ target: matchParsedTable.matchId, set: { ...plan.values, parsedAt: plan.parsedAt },
              setWhere: sql`${matchParsedTable.parsedAt} IS NULL OR ${matchParsedTable.parsedAt} < ${plan.parsedAt}` })
            .returning({ matchId: matchParsedTable.matchId });
          if (written.length) await tx.update(proMatchesTable)
            .set({ isParsed: true, parsedAt: plan.parsedAt })
            .where(eq(proMatchesTable.matchId, matchId));
        }

        await tx.update(matchParseQueueTable)
          .set({ status: 'parsed', lastError: null, updatedAt: now })
          .where(eq(matchParseQueueTable.matchId, matchId));
      });

      parsed++;
    } else if (ageMs > TIMEOUT_HOURS * 3600_000) {
      // timeout
      await db.update(matchParseQueueTable)
        .set({ status: 'timeout', updatedAt: new Date() })
        .where(eq(matchParseQueueTable.matchId, matchId));
      timedOut++;
    } else {
      stillWaiting++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  [ingest-parsed] progress ${i + 1}/${todo.length} parsed=${parsed} waiting=${stillWaiting} timeout=${timedOut} errs=${httpErrors}`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`[ingest-parsed] Done. parsed=${parsed} waiting=${stillWaiting} timeout=${timedOut} httpErrors=${httpErrors}`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error('[ingest-parsed] FATAL', e);
  process.exit(1);
});
