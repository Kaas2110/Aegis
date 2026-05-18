/**
 * ingest:od-team-rosters — текущий ростер команды + игроки в истории.
 * Источник: /teams/{team_id}/players
 *
 * Для каждой команды из teamsTable (last_match_time за последние 365д) тянет
 * список игроков с games_played, wins, is_current_team_member.
 * Freshness 7 дней. Запуск: pnpm --filter @workspace/scripts run ingest:od-team-rosters
 */
import { db, teamsTable, teamRostersTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { fetchOdJson, sleep, DELAY_MS } from './lib/odPace.js';

const FRESHNESS_DAYS = 7;
const ACTIVE_WINDOW_DAYS = 365;

interface OdTeamPlayer {
  account_id: number;
  name?: string | null;
  games_played: number;
  wins: number;
  is_current_team_member?: boolean | null;
}

async function main() {
  const cutoffSec = Math.floor((Date.now() - ACTIVE_WINDOW_DAYS * 86_400_000) / 1000);
  const freshCutoff = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000);

  const teams = await db.execute<{ team_id: number }>(sql`
    SELECT team_id FROM teams
    WHERE last_match_time IS NOT NULL AND last_match_time >= ${cutoffSec}
    ORDER BY rating DESC NULLS LAST
  `);
  const rows = (teams.rows ?? teams as unknown as { team_id: number }[]) as { team_id: number }[];
  const allIds = rows.map(r => Number(r.team_id)).filter(Boolean);

  const fresh = await db.execute<{ team_id: number }>(sql`
    SELECT DISTINCT team_id FROM team_rosters WHERE fetched_at > ${freshCutoff}
  `);
  const freshSet = new Set(((fresh.rows ?? fresh as unknown as { team_id: number }[]) as { team_id: number }[])
    .map(r => Number(r.team_id)));
  const toFetch = allIds.filter(id => !freshSet.has(id));
  console.log(`[od-team-rosters] ${toFetch.length} to fetch, ${freshSet.size} fresh (${allIds.length} active total)`);

  let saved = 0, failed = 0;
  const now = new Date();

  for (let i = 0; i < toFetch.length; i++) {
    const teamId = toFetch[i]!;
    try {
      const players = await fetchOdJson<OdTeamPlayer[]>(`/teams/${teamId}/players`);
      if (players && Array.isArray(players) && players.length > 0) {
        const insertRows = players
          .filter(p => p.account_id > 0)
          .map(p => ({
            teamId,
            accountId: p.account_id,
            playerName: p.name ?? null,
            gamesPlayed: p.games_played ?? 0,
            wins: p.wins ?? 0,
            isCurrent: !!p.is_current_team_member,
            fetchedAt: now,
          }));
        if (insertRows.length > 0) {
          await db.insert(teamRostersTable).values(insertRows)
            .onConflictDoUpdate({
              target: [teamRostersTable.teamId, teamRostersTable.accountId],
              set: {
                playerName: sql`excluded.player_name`,
                gamesPlayed: sql`excluded.games_played`,
                wins: sql`excluded.wins`,
                isCurrent: sql`excluded.is_current`,
                fetchedAt: sql`excluded.fetched_at`,
              },
            });
          saved += insertRows.length;
        }
      }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[od-team-rosters] team=${teamId} ${(e as Error).message}`);
    }
    if (i % 100 === 99) console.log(`[od-team-rosters] progress ${i + 1}/${toFetch.length} saved=${saved} failed=${failed}`);
    await sleep(DELAY_MS);
  }
  console.log(`[od-team-rosters] DONE saved=${saved} failed=${failed}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
