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
      lastMatchTime: state.lastMatchTime ?? null,
    });
  }
  console.log(`[compute-team-extended] team rows to upsert: ${inserts.length}`);

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
