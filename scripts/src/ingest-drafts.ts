/**
 * Загружает picks/bans для исторических про-матчей из OpenDota /api/matches/:id.
 *
 * Идемпотентно: только матчи без записи в match_drafts.
 * 1.1 сек/запрос (rate limit OpenDota free tier).
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run ingest:drafts          # все необработанные
 *   pnpm --filter @workspace/scripts run ingest:drafts 500      # лимит 500 матчей
 *
 * Можно безопасно прерывать и перезапускать — продолжит с того же места.
 */

import { db, proMatchesTable, matchDraftsTable, teamsTable } from '@workspace/db';
import { sql, isNull, and } from 'drizzle-orm';

// Должно совпадать с MIN_AVG_GLICKO в train-model.ts.
const MIN_AVG_GLICKO = 1200;

interface OpenDotaPickBan {
  is_pick: boolean;
  hero_id: number;
  team: 0 | 1;             // 0 = radiant, 1 = dire
  order: number;
}

interface OpenDotaPlayer {
  account_id?: number | null;
  player_slot: number;        // 0..4 = radiant, 128..132 = dire
  hero_id: number;
}

interface OpenDotaMatch {
  match_id: number;
  picks_bans: OpenDotaPickBan[] | null;
  players?: OpenDotaPlayer[];
  first_blood_time?: number | null;
  barracks_status_radiant?: number | null;
  barracks_status_dire?: number | null;
  tower_status_radiant?: number | null;
  tower_status_dire?: number | null;
}

/** Вытаскивает account_ids в порядке pick'ов команды (radiant/dire). */
function extractAccountIds(
  players: OpenDotaPlayer[] | undefined,
  picks: { radiantPicks: number[]; direPicks: number[] },
): { radiantAccountIds: number[] | null; direAccountIds: number[] | null } {
  if (!players || players.length === 0) {
    return { radiantAccountIds: null, direAccountIds: null };
  }
  const heroToAccount = new Map<number, { radiant: number | null; dire: number | null }>();
  for (const p of players) {
    if (!p.hero_id || p.hero_id <= 0) continue;
    const isRadiant = p.player_slot < 128;
    const cur = heroToAccount.get(p.hero_id) ?? { radiant: null, dire: null };
    if (isRadiant) cur.radiant = p.account_id ?? null;
    else cur.dire = p.account_id ?? null;
    heroToAccount.set(p.hero_id, cur);
  }
  const rIds = picks.radiantPicks.map(h => heroToAccount.get(h)?.radiant ?? 0);
  const dIds = picks.direPicks.map(h => heroToAccount.get(h)?.dire ?? 0);
  // Если все 0 (анонимные) — храним null чтобы playerSkill фича не считалась.
  const r = rIds.every(x => x === 0) ? null : rIds;
  const d = dIds.every(x => x === 0) ? null : dIds;
  return { radiantAccountIds: r, direAccountIds: d };
}

const SLEEP_MS = 1100;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchMatch(matchId: number): Promise<OpenDotaMatch> {
  const url = `https://api.opendota.com/api/matches/${matchId}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for match ${matchId}`);
  return (await resp.json()) as OpenDotaMatch;
}

function partition(pb: OpenDotaPickBan[]): {
  radiantPicks: number[];
  direPicks: number[];
  radiantBans: number[];
  direBans: number[];
} {
  const radiantPicks: number[] = [];
  const direPicks: number[] = [];
  const radiantBans: number[] = [];
  const direBans: number[] = [];
  for (const p of pb) {
    if (p.is_pick) {
      (p.team === 0 ? radiantPicks : direPicks).push(p.hero_id);
    } else {
      (p.team === 0 ? radiantBans : direBans).push(p.hero_id);
    }
  }
  return { radiantPicks, direPicks, radiantBans, direBans };
}

async function main() {
  const args = process.argv.slice(2);
  const backfill = args.includes('--backfill-accounts');
  const limit = args.find(a => /^\d+$/.test(a)) ? Number(args.find(a => /^\d+$/.test(a))) : null;

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
  } else {
    console.log('[ingest-drafts] Selecting v2-eligible matches without drafts …');
    // Только матчи где обе команды есть в teams и avg Glicko >= MIN_AVG_GLICKO.
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
  console.log(`[ingest-drafts] ${todo.length} matches to fetch (≈${(todo.length * 1.1 / 60).toFixed(1)} min)`);

  if (todo.length === 0) {
    console.log('[ingest-drafts] Nothing to do.');
    process.exit(0);
  }

  let saved = 0;
  let nullDraft = 0;
  let failed = 0;

  for (let i = 0; i < todo.length; i++) {
    const matchId = todo[i].matchId;
    try {
      const m = await fetchMatch(matchId);
      if (!m.picks_bans || m.picks_bans.length === 0) {
        nullDraft++;
        // Записываем пустые массивы — чтобы не дёргать этот матч повторно.
        await db
          .insert(matchDraftsTable)
          .values({
            matchId,
            radiantPicks: [],
            direPicks: [],
            radiantBans: [],
            direBans: [],
          })
          .onConflictDoNothing();
      } else {
        const parts = partition(m.picks_bans);
        const accs = extractAccountIds(m.players, parts);
        if (backfill) {
          // Только обновляем account_ids; picks/bans не трогаем.
          await db
            .update(matchDraftsTable)
            .set({
              radiantAccountIds: accs.radiantAccountIds,
              direAccountIds: accs.direAccountIds,
            })
            .where(sql`${matchDraftsTable.matchId} = ${matchId}`);
        } else {
          await db
            .insert(matchDraftsTable)
            .values({ matchId, ...parts, ...accs })
            .onConflictDoNothing();
        }
        saved++;
      }
    } catch (e) {
      failed++;
      const msg = (e as Error).message;
      // 404 — матч удалён из OpenDota; помечаем пустым драфтом чтобы не повторять.
      if (msg.includes('HTTP 404')) {
        await db
          .insert(matchDraftsTable)
          .values({
            matchId,
            radiantPicks: [],
            direPicks: [],
            radiantBans: [],
            direBans: [],
          })
          .onConflictDoNothing();
      }
    }
    if ((i + 1) % 10 === 0 || i === todo.length - 1) {
      process.stdout.write(
        `\r[ingest-drafts] ${i + 1}/${todo.length} · saved: ${saved} · null: ${nullDraft} · failed: ${failed}`,
      );
    }
    await sleep(SLEEP_MS);
  }

  console.log(`\n[ingest-drafts] Done. saved=${saved} null=${nullDraft} failed=${failed}`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n[ingest-drafts] FATAL', err);
  process.exit(1);
});
