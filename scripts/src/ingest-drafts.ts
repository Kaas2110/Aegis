/**
 * Загружает picks/bans для исторических про-матчей.
 *
 * Источники (в порядке приоритета):
 *   1. Stratz GraphQL — STRATZ_TOKEN в env → 250 req/min, 1 запрос на матч,
 *      picks/bans + steamAccountId всех игроков сразу. ~260ms/матч.
 *   2. OpenDota REST  — fallback если токен не задан → 1.1s/матч (rate-limit).
 *
 * Идемпотентно: только матчи без записи в match_drafts.
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run ingest:drafts                # все (фильтр Glicko >=1200)
 *   pnpm --filter @workspace/scripts run ingest:drafts 500            # лимит 500
 *   pnpm --filter @workspace/scripts run ingest:drafts --backfill-accounts
 *   pnpm --filter @workspace/scripts run ingest:drafts --no-stratz    # форс OpenDota
 *   pnpm --filter @workspace/scripts run ingest:drafts --live-backfill      # матчи из live_snapshots без драфта (без фильтра Glicko)
 *   pnpm --filter @workspace/scripts run ingest:drafts --live-backfill 200  # с лимитом
 */

import { db, proMatchesTable, matchDraftsTable, teamsTable, liveSnapshotsTable } from '@workspace/db';
import { sql, isNull, and } from 'drizzle-orm';
import {
  fetchMatchDetail,
  stratzSleep,
  StratzUnavailableError,
  type StratzPickBan,
  type StratzPlayerSlot,
} from './lib/stratz.js';

const MIN_AVG_GLICKO = 1200;

// ---------- OpenDota types ----------

interface OpenDotaPickBan {
  is_pick: boolean;
  hero_id: number;
  team: 0 | 1;
  order: number;
}

interface OpenDotaPlayer {
  account_id?: number | null;
  player_slot: number;
  hero_id: number;
}

interface OpenDotaMatch {
  match_id: number;
  picks_bans: OpenDotaPickBan[] | null;
  players?: OpenDotaPlayer[];
}

// ---------- OpenDota helpers ----------

const OD_SLEEP_MS = 1100;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchMatchOpenDota(matchId: number): Promise<OpenDotaMatch> {
  const resp = await fetch(`https://api.opendota.com/api/matches/${matchId}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for match ${matchId}`);
  return (await resp.json()) as OpenDotaMatch;
}

function partitionOD(pb: OpenDotaPickBan[]) {
  const radiantPicks: number[] = [];
  const direPicks: number[] = [];
  const radiantBans: number[] = [];
  const direBans: number[] = [];
  for (const p of pb) {
    if (p.is_pick) (p.team === 0 ? radiantPicks : direPicks).push(p.hero_id);
    else (p.team === 0 ? radiantBans : direBans).push(p.hero_id);
  }
  return { radiantPicks, direPicks, radiantBans, direBans };
}

function extractAccountIdsOD(
  players: OpenDotaPlayer[] | undefined,
  picks: { radiantPicks: number[]; direPicks: number[] },
) {
  if (!players?.length) return { radiantAccountIds: null, direAccountIds: null };
  const heroToAccount = new Map<number, { radiant: number | null; dire: number | null }>();
  for (const p of players) {
    if (!p.hero_id || p.hero_id <= 0) continue;
    const isR = p.player_slot < 128;
    const cur = heroToAccount.get(p.hero_id) ?? { radiant: null, dire: null };
    if (isR) cur.radiant = p.account_id ?? null;
    else cur.dire = p.account_id ?? null;
    heroToAccount.set(p.hero_id, cur);
  }
  const rIds = picks.radiantPicks.map(h => heroToAccount.get(h)?.radiant ?? 0);
  const dIds = picks.direPicks.map(h => heroToAccount.get(h)?.dire ?? 0);
  return {
    radiantAccountIds: rIds.every(x => x === 0) ? null : rIds,
    direAccountIds: dIds.every(x => x === 0) ? null : dIds,
  };
}

// ---------- Stratz helpers ----------

function partitionStratz(pickBans: StratzPickBan[]) {
  const radiantPicks: number[] = [];
  const direPicks: number[] = [];
  const radiantBans: number[] = [];
  const direBans: number[] = [];
  // Stratz отдаёт пики/баны в порядке order — сохраняем как есть.
  const sorted = [...pickBans].sort((a, b) => a.order - b.order);
  for (const p of sorted) {
    if (!p.heroId) continue;
    if (p.isPick) (p.isRadiant ? radiantPicks : direPicks).push(p.heroId);
    else (p.isRadiant ? radiantBans : direBans).push(p.heroId);
  }
  return { radiantPicks, direPicks, radiantBans, direBans };
}

function extractAccountIdsStratz(
  players: StratzPlayerSlot[],
  picks: { radiantPicks: number[]; direPicks: number[] },
) {
  // steamAccountId в Stratz — это Steam64 сдвинутый в Steam32 (или уже Steam32?).
  // Stratz возвращает 32-битный steamAccountId (тот же что account_id в OpenDota).
  const heroToAccount = new Map<number, { radiant: number | null; dire: number | null }>();
  for (const p of players) {
    const heroId = p.hero?.id;
    if (!heroId) continue;
    const cur = heroToAccount.get(heroId) ?? { radiant: null, dire: null };
    const accId = p.steamAccountId && p.steamAccountId > 0 ? p.steamAccountId : null;
    if (p.isRadiant) cur.radiant = accId;
    else cur.dire = accId;
    heroToAccount.set(heroId, cur);
  }
  const rIds = picks.radiantPicks.map(h => heroToAccount.get(h)?.radiant ?? 0);
  const dIds = picks.direPicks.map(h => heroToAccount.get(h)?.dire ?? 0);
  return {
    radiantAccountIds: rIds.every(x => x === 0) ? null : rIds,
    direAccountIds: dIds.every(x => x === 0) ? null : dIds,
  };
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  const backfill = args.includes('--backfill-accounts');
  const liveBackfill = args.includes('--live-backfill');
  const forceOpenDota = args.includes('--no-stratz');
  const limitArg = args.find(a => /^\d+$/.test(a));
  const limit = limitArg ? Number(limitArg) : null;

  const useStratz = !forceOpenDota && !!process.env['STRATZ_TOKEN'];
  console.log(`[ingest-drafts] source=${useStratz ? 'Stratz (primary) + OpenDota (fallback)' : 'OpenDota only'}`);
  if (!useStratz && !forceOpenDota) {
    console.log('[ingest-drafts] Tip: добавьте STRATZ_TOKEN в Replit Secrets для 4× ускорения (250 req/min вместо ~60).');
  }

  let todo: { matchId: number }[];

  if (backfill) {
    console.log('[ingest-drafts] BACKFILL: matches with picks but NULL account_ids …');
    const q = db
      .select({ matchId: matchDraftsTable.matchId })
      .from(matchDraftsTable)
      .where(
        and(
          isNull(matchDraftsTable.radiantAccountIds),
          sql`jsonb_array_length(${matchDraftsTable.radiantPicks}) = 5`,
        ),
      )
      .orderBy(sql`${matchDraftsTable.matchId} DESC`);
    todo = limit !== null ? await q.limit(limit) : await q;
  } else if (liveBackfill) {
    // Режим --live-backfill: матчи из live_snapshots без записи в match_drafts.
    // Без фильтра по рейтингу команд — нужны все матчи у которых есть снапшоты,
    // даже если команды не попадают в обычный порог Glicko.
    console.log('[ingest-drafts] LIVE-BACKFILL: live_snapshot matches without drafts (no team rating filter) …');
    const q = db
      .selectDistinct({ matchId: liveSnapshotsTable.matchId })
      .from(liveSnapshotsTable)
      .leftJoin(matchDraftsTable, sql`${matchDraftsTable.matchId} = ${liveSnapshotsTable.matchId}`)
      .where(isNull(matchDraftsTable.matchId))
      .orderBy(sql`${liveSnapshotsTable.matchId} DESC`);
    todo = limit !== null ? await q.limit(limit) : await q;
  } else {
    console.log('[ingest-drafts] Selecting v2-eligible matches without drafts …');
    const tR = teamsTable;
    const radiantTeams = db.$with('rt').as(
      db.select({ teamId: tR.teamId, rating: tR.rating }).from(tR),
    );
    const direTeams = db.$with('dt').as(
      db.select({ teamId: tR.teamId, rating: tR.rating }).from(tR),
    );
    const q = db
      .with(radiantTeams, direTeams)
      .select({ matchId: proMatchesTable.matchId })
      .from(proMatchesTable)
      .leftJoin(matchDraftsTable, sql`${matchDraftsTable.matchId} = ${proMatchesTable.matchId}`)
      .innerJoin(radiantTeams, sql`${radiantTeams.teamId} = ${proMatchesTable.radiantTeamId}`)
      .innerJoin(direTeams, sql`${direTeams.teamId} = ${proMatchesTable.direTeamId}`)
      .where(
        and(
          isNull(matchDraftsTable.matchId),
          sql`(${radiantTeams.rating} + ${direTeams.rating}) / 2.0 >= ${MIN_AVG_GLICKO}`,
        ),
      )
      .orderBy(sql`${proMatchesTable.startTime} DESC`);
    todo = limit !== null ? await q.limit(limit) : await q;
  }

  const etaMins = useStratz
    ? (todo.length * 0.26 / 60).toFixed(1)
    : (todo.length * 1.1 / 60).toFixed(1);
  console.log(`[ingest-drafts] ${todo.length} matches to fetch (≈${etaMins} min)`);

  if (todo.length === 0) {
    console.log('[ingest-drafts] Nothing to do.');
    process.exit(0);
  }

  let saved = 0;
  let nullDraft = 0;
  let failed = 0;
  let stratzFallbacks = 0;

  for (let i = 0; i < todo.length; i++) {
    const matchId = todo[i].matchId;
    let usedSource = 'opendota';

    try {
      if (useStratz) {
        usedSource = 'stratz';
        try {
          const m = await fetchMatchDetail(matchId);
          const pb = m.pickBans ?? [];
          if (pb.length === 0) {
            nullDraft++;
            await db.insert(matchDraftsTable)
              .values({ matchId, radiantPicks: [], direPicks: [], radiantBans: [], direBans: [] })
              .onConflictDoNothing();
          } else {
            const parts = partitionStratz(pb);
            const accs = extractAccountIdsStratz(m.players ?? [], parts);
            if (backfill) {
              await db.update(matchDraftsTable)
                .set({ radiantAccountIds: accs.radiantAccountIds, direAccountIds: accs.direAccountIds })
                .where(sql`${matchDraftsTable.matchId} = ${matchId}`);
            } else {
              await db.insert(matchDraftsTable)
                .values({ matchId, ...parts, ...accs })
                .onConflictDoNothing();
            }
            saved++;
          }
          await stratzSleep();
        } catch (stratzErr) {
          if (stratzErr instanceof StratzUnavailableError) {
            // Stratz не отвечает — уходим на OpenDota для этого матча
            stratzFallbacks++;
            usedSource = 'opendota(fallback)';
            const m = await fetchMatchOpenDota(matchId);
            if (!m.picks_bans?.length) {
              nullDraft++;
              await db.insert(matchDraftsTable)
                .values({ matchId, radiantPicks: [], direPicks: [], radiantBans: [], direBans: [] })
                .onConflictDoNothing();
            } else {
              const parts = partitionOD(m.picks_bans);
              const accs = extractAccountIdsOD(m.players, parts);
              if (backfill) {
                await db.update(matchDraftsTable)
                  .set({ radiantAccountIds: accs.radiantAccountIds, direAccountIds: accs.direAccountIds })
                  .where(sql`${matchDraftsTable.matchId} = ${matchId}`);
              } else {
                await db.insert(matchDraftsTable)
                  .values({ matchId, ...parts, ...accs })
                  .onConflictDoNothing();
              }
              saved++;
            }
            await sleep(OD_SLEEP_MS);
          } else {
            throw stratzErr;
          }
        }
      } else {
        // OpenDota-only path
        const m = await fetchMatchOpenDota(matchId);
        if (!m.picks_bans?.length) {
          nullDraft++;
          await db.insert(matchDraftsTable)
            .values({ matchId, radiantPicks: [], direPicks: [], radiantBans: [], direBans: [] })
            .onConflictDoNothing();
        } else {
          const parts = partitionOD(m.picks_bans);
          const accs = extractAccountIdsOD(m.players, parts);
          if (backfill) {
            await db.update(matchDraftsTable)
              .set({ radiantAccountIds: accs.radiantAccountIds, direAccountIds: accs.direAccountIds })
              .where(sql`${matchDraftsTable.matchId} = ${matchId}`);
          } else {
            await db.insert(matchDraftsTable)
              .values({ matchId, ...parts, ...accs })
              .onConflictDoNothing();
          }
          saved++;
        }
        await sleep(OD_SLEEP_MS);
      }
    } catch (e) {
      failed++;
      const msg = (e as Error).message;
      // 404 — матч удалён из источника; помечаем пустым чтобы не повторять.
      if (msg.includes('HTTP 404') || msg.includes('not found')) {
        await db.insert(matchDraftsTable)
          .values({ matchId, radiantPicks: [], direPicks: [], radiantBans: [], direBans: [] })
          .onConflictDoNothing();
      }
      // При ошибке Stratz делаем небольшую паузу чтобы не долбить эндпоинт
      if (usedSource.startsWith('stratz')) await stratzSleep();
    }

    if ((i + 1) % 10 === 0 || i === todo.length - 1) {
      const fb = stratzFallbacks > 0 ? ` fb=${stratzFallbacks}` : '';
      process.stdout.write(
        `\r[ingest-drafts] ${i + 1}/${todo.length} · saved=${saved} null=${nullDraft} failed=${failed}${fb}`,
      );
    }
  }

  console.log(`\n[ingest-drafts] Done. saved=${saved} null=${nullDraft} failed=${failed} stratz_fallbacks=${stratzFallbacks}`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n[ingest-drafts] FATAL', err);
  process.exit(1);
});
