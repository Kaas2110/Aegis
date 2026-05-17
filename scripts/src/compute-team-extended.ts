/**
 * Wave 5: пересчитывает team_extended_features для всех команд.
 *
 * Один chronological pass по pro_matches → финальное "as-of-now" состояние
 * каждой команды записывается в team_extended_features (PK=team_id, upsert).
 *
 * Используется PredictionModel на inference'е для расширенных фичей v1
 * (win_streak, rest_days, matches_30d, avg_duration_30d, fb_rate_30d,
 * side_winrates).
 *
 * Запуск: pnpm --filter @workspace/scripts run compute:team-extended
 */

import {
  db,
  proMatchesTable,
  teamExtendedFeaturesTable,
} from '@workspace/db';
import { asc, isNotNull, and, sql } from 'drizzle-orm';
import {
  applyMatch,
  newRollingState,
  snapshotAt,
  type TeamRollingState,
  type MatchForRollup,
} from './lib/team-extended';

const PEER_WINDOW_DAYS = 365;
const ROSTER_TOP_N = 5;
const MIN_PEER_GAMES = 10;  // мин. совместных игр для учёта пары (фильтр шумных wr)

/**
 * Считает peer-synergy для каждой команды:
 *   1. core roster = top-5 account_id по числу появлений за 365d
 *   2. для всех C(5,2)=10 пар core'а тянем player_peers.winrate
 *   3. peerSynergy = средний winrate, взвешенный по games (мин. 10)
 *
 * Возвращает Map<teamId, peerSynergy 0..1> (null/missing = недостаточно данных).
 */
async function computePeerSynergy(): Promise<Map<number, number>> {
  console.log('[compute-team-extended] peer-synergy: загружаю составы за 365d …');
  const cutoff = Math.floor(Date.now() / 1000) - PEER_WINDOW_DAYS * 86400;

  const rosterRows = await db.execute(sql`
    WITH roster AS (
      SELECT pm.radiant_team_id AS team_id,
             (jsonb_array_elements_text(md.radiant_account_ids))::bigint AS acct
        FROM pro_matches pm
        JOIN match_drafts md ON md.match_id = pm.match_id
       WHERE pm.start_time > ${cutoff}
         AND pm.radiant_team_id IS NOT NULL
         AND md.radiant_account_ids IS NOT NULL
      UNION ALL
      SELECT pm.dire_team_id,
             (jsonb_array_elements_text(md.dire_account_ids))::bigint
        FROM pro_matches pm
        JOIN match_drafts md ON md.match_id = pm.match_id
       WHERE pm.start_time > ${cutoff}
         AND pm.dire_team_id IS NOT NULL
         AND md.dire_account_ids IS NOT NULL
    )
    SELECT team_id, acct, count(*)::int AS games
      FROM roster
     GROUP BY team_id, acct
  `);

  // Group → top-5 per team
  const perTeam = new Map<number, Array<{ acct: bigint; games: number }>>();
  for (const r of rosterRows.rows as Array<{ team_id: string | number; acct: string | number | bigint; games: number }>) {
    const teamId = Number(r.team_id);
    const acct = typeof r.acct === 'bigint' ? r.acct : BigInt(r.acct);
    let arr = perTeam.get(teamId);
    if (!arr) { arr = []; perTeam.set(teamId, arr); }
    arr.push({ acct, games: r.games });
  }
  console.log(`[compute-team-extended] peer-synergy: ${perTeam.size} команд имеют составы`);

  // Собираем все pair-запросы одним SQL: для каждой команды берём top-5,
  // строим пары (a < b), тянем player_peers.
  const pairsByTeam = new Map<number, Array<{ a: bigint; b: bigint }>>();
  const allAccts = new Set<bigint>();
  for (const [teamId, accts] of perTeam) {
    accts.sort((x, y) => y.games - x.games);
    const core = accts.slice(0, ROSTER_TOP_N).map((x) => x.acct);
    if (core.length < 2) continue;
    const pairs: Array<{ a: bigint; b: bigint }> = [];
    for (let i = 0; i < core.length; i++) {
      for (let j = i + 1; j < core.length; j++) {
        const [a, b] = core[i] < core[j] ? [core[i], core[j]] : [core[j], core[i]];
        pairs.push({ a, b });
        allAccts.add(a); allAccts.add(b);
      }
    }
    pairsByTeam.set(teamId, pairs);
  }

  if (allAccts.size === 0) return new Map();

  // Одним запросом тянем все winrate'ы для нужных account_id
  console.log(`[compute-team-extended] peer-synergy: запрос player_peers для ${allAccts.size} аккаунтов …`);
  const acctList = Array.from(allAccts).map((a) => a.toString()).join(',');
  const peerRows = await db.execute(sql.raw(`
    SELECT account_id, peer_id, games, winrate
      FROM player_peers
     WHERE account_id IN (${acctList})
       AND peer_id    IN (${acctList})
       AND games >= ${MIN_PEER_GAMES}
  `));

  // Map<"a_b" key (a<b)>, { winrate, games }
  const peerMap = new Map<string, { wr: number; games: number }>();
  for (const r of peerRows.rows as Array<{ account_id: string | bigint; peer_id: string | bigint; games: number; winrate: number }>) {
    const a = BigInt(r.account_id);
    const b = BigInt(r.peer_id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}_${hi}`;
    const existing = peerMap.get(key);
    // (a,b) и (b,a) дают одинаковую пару → берём максимум games (наиболее свежие данные)
    if (!existing || r.games > existing.games) {
      peerMap.set(key, { wr: r.winrate, games: r.games });
    }
  }

  const result = new Map<number, number>();
  for (const [teamId, pairs] of pairsByTeam) {
    let sumW = 0, totalGames = 0, hits = 0;
    for (const { a, b } of pairs) {
      const key = `${a}_${b}`;
      const peer = peerMap.get(key);
      if (!peer) continue;
      sumW += peer.wr * peer.games;
      totalGames += peer.games;
      hits += 1;
    }
    if (hits >= 3 && totalGames > 0) {  // мин. 3 из 10 возможных пар иначе слишком шумно
      result.set(teamId, sumW / totalGames);
    }
  }
  console.log(`[compute-team-extended] peer-synergy: посчитано для ${result.size} команд из ${pairsByTeam.size}`);
  return result;
}

async function main() {
  console.log('[compute-team-extended] loading pro_matches …');
  const rows = await db
    .select({
      matchId: proMatchesTable.matchId,
      startTime: proMatchesTable.startTime,
      duration: proMatchesTable.duration,
      radiantTeamId: proMatchesTable.radiantTeamId,
      direTeamId: proMatchesTable.direTeamId,
      radiantWin: proMatchesTable.radiantWin,
      firstBloodTime: proMatchesTable.firstBloodTime,
    })
    .from(proMatchesTable)
    .where(and(isNotNull(proMatchesTable.radiantTeamId), isNotNull(proMatchesTable.direTeamId)))
    .orderBy(asc(proMatchesTable.startTime));
  console.log(`[compute-team-extended] matches=${rows.length}`);

  const states = new Map<number, TeamRollingState>();
  function get(id: number): TeamRollingState {
    let s = states.get(id);
    if (!s) { s = newRollingState(); states.set(id, s); }
    return s;
  }

  for (const r of rows) {
    if (!r.radiantTeamId || !r.direTeamId) continue;
    const m: MatchForRollup = {
      matchId: r.matchId,
      startTime: r.startTime,
      duration: r.duration,
      radiantTeamId: r.radiantTeamId,
      direTeamId: r.direTeamId,
      radiantWin: r.radiantWin,
      firstBloodTime: r.firstBloodTime,
    };
    applyMatch(get(r.radiantTeamId), get(r.direTeamId), m);
  }

  const peerSynergyMap = await computePeerSynergy();

  const nowSec = Math.floor(Date.now() / 1000);
  const inserts: (typeof teamExtendedFeaturesTable.$inferInsert)[] = [];
  for (const [teamId, state] of states.entries()) {
    const snap = snapshotAt(state, nowSec);
    inserts.push({
      teamId,
      winStreak: snap.winStreak,
      daysSinceLastMatch: snap.daysSinceLastMatch ?? null,
      matches30d: snap.matches30d,
      avgDurationSec30d: snap.avgDurationSec30d ?? null,
      firstBloodRate30d: snap.firstBloodRate30d ?? null,
      radiantWinrate: snap.radiantWinrate ?? null,
      direWinrate: snap.direWinrate ?? null,
      peerSynergy: peerSynergyMap.get(teamId) ?? null,
      lastMatchTime: state.lastMatchTime ?? null,
    });
  }
  const withPeer = inserts.filter((x) => x.peerSynergy != null).length;
  console.log(`[compute-team-extended] team rows to upsert: ${inserts.length} (с peer_synergy: ${withPeer})`);

  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const slice = inserts.slice(i, i + CHUNK);
    await db.insert(teamExtendedFeaturesTable).values(slice).onConflictDoUpdate({
      target: teamExtendedFeaturesTable.teamId,
      set: {
        winStreak: sql`excluded.win_streak`,
        daysSinceLastMatch: sql`excluded.days_since_last_match`,
        matches30d: sql`excluded.matches_30d`,
        avgDurationSec30d: sql`excluded.avg_duration_sec_30d`,
        firstBloodRate30d: sql`excluded.first_blood_rate_30d`,
        radiantWinrate: sql`excluded.radiant_winrate`,
        direWinrate: sql`excluded.dire_winrate`,
        peerSynergy: sql`excluded.peer_synergy`,
        lastMatchTime: sql`excluded.last_match_time`,
        computedAt: sql`now()`,
      },
    });
    written += slice.length;
    if (written % 2000 === 0 || written === inserts.length) {
      console.log(`  written ${written}/${inserts.length}`);
    }
  }

  console.log(`[compute-team-extended] ✅ done — ${inserts.length} teams updated`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
