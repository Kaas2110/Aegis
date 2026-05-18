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
import { withOpenDotaKey } from './lib/openDotaUrl';

// Premium OpenDota key: 1200 req/min = 20 req/s. Держим 10 req/s — половина
// потолка, оставляем запас для parse:request и live-poll.
const RATE_LIMIT_MS = 100;

// Текущая версия структуры payload. Бамп при изменении набора сохраняемых полей.
const PAYLOAD_SCHEMA_VERSION = 1;

function arg(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10);
  return def;
}

const LIMIT = arg('--limit', 200);
const TIMEOUT_HOURS = arg('--timeout-hours', 2);
const REINGEST = process.argv.includes('--reingest');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Извлечение нужных полей из OD-ответа. Если OD изменит схему — здесь же
// апдейтим маппинг и бампаем PAYLOAD_SCHEMA_VERSION.
interface OdPlayer {
  player_slot: number;
  account_id: number | null;
  hero_id: number;
  gold_t?: number[] | null;
  xp_t?: number[] | null;
  lh_t?: number[] | null;
  dn_t?: number[] | null;
  kills_log?: unknown[] | null;
  buyback_log?: unknown[] | null;
  purchase_log?: unknown[] | null;
  lane_role?: number | null;
  is_roaming?: boolean | null;
  obs_log?: unknown[] | null;
  sen_log?: unknown[] | null;
  ability_upgrades_arr?: unknown[] | null;
}
interface OdMatchDetail {
  match_id: number;
  version: number | null;
  players: OdPlayer[];
  objectives?: unknown[] | null;
  teamfights?: unknown[] | null;
  draft_timings?: unknown[] | null;
}

function pickPlayer(p: OdPlayer) {
  return {
    player_slot: p.player_slot,
    account_id: p.account_id ?? null,
    hero_id: p.hero_id,
    gold_t: p.gold_t ?? null,
    xp_t: p.xp_t ?? null,
    lh_t: p.lh_t ?? null,
    dn_t: p.dn_t ?? null,
    kills_log: p.kills_log ?? null,
    buyback_log: p.buyback_log ?? null,
    purchase_log: p.purchase_log ?? null,
    lane_role: p.lane_role ?? null,
    is_roaming: p.is_roaming ?? null,
    obs_log: p.obs_log ?? null,
    sen_log: p.sen_log ?? null,
    ability_upgrades_arr: p.ability_upgrades_arr ?? null,
  };
}

async function fetchMatch(matchId: number): Promise<{ data: OdMatchDetail | null; error: string | null }> {
  try {
    const r = await fetch(withOpenDotaKey(`https://api.opendota.com/api/matches/${matchId}`), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return { data: null, error: `HTTP ${r.status}` };
    const data = (await r.json()) as OdMatchDetail;
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
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

  for (let i = 0; i < todo.length; i++) {
    const { matchId, requestedAt, attempts } = todo[i];
    const ageMs = Date.now() - new Date(requestedAt).getTime();
    const { data, error } = await fetchMatch(matchId);

    if (error) {
      httpErrors++;
      await db.update(matchParseQueueTable)
        .set({
          attempts: attempts + 1,
          lastError: error,
          updatedAt: new Date(),
        })
        .where(eq(matchParseQueueTable.matchId, matchId));
    } else if (data && data.version != null) {
      // ✓ parsed — три записи в одной транзакции, чтобы не оставить
      // несогласованное состояние (parsed row есть, но queue всё ещё queued
      // или pro_matches.is_parsed=false) при прерывании процесса.
      const players = (data.players ?? []).map(pickPlayer);
      const objectives = data.objectives ?? null;
      const teamfights = data.teamfights ?? null;
      const draftTimings = data.draft_timings ?? null;
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.insert(matchParsedTable)
          .values({
            matchId,
            payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
            odVersion: data.version!,
            players,
            objectives,
            teamfights,
            draftTimings,
          })
          .onConflictDoUpdate({
            target: matchParsedTable.matchId,
            set: {
              payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
              odVersion: data.version!,
              players,
              objectives,
              teamfights,
              draftTimings,
              parsedAt: now,
            },
          });

        await tx.update(proMatchesTable)
          .set({ isParsed: true, parsedAt: now })
          .where(eq(proMatchesTable.matchId, matchId));

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
