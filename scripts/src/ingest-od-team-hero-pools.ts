/**
 * ingest:od-team-hero-pools — hero pool команды.
 * Источник: /teams/{team_id}/heroes → [{hero_id, name, games_played, wins}]
 *
 * Freshness 7 дней.
 */
import { db, teamHeroPoolTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { fetchOdJson, sleep, DELAY_MS, OdQuotaExhaustedError } from './lib/odPace.js';

const FRESHNESS_DAYS = 7;
const ACTIVE_WINDOW_DAYS = 365;

interface OdTeamHero {
  hero_id: number;
  games_played: number;
  wins: number;
}

async function main() {
  const cutoffSec = Math.floor((Date.now() - ACTIVE_WINDOW_DAYS * 86_400_000) / 1000);
  const freshCutoff = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000);

  const teams = await db.execute<{ team_id: number }>(sql`
    SELECT team_id FROM teams
    WHERE last_match_time IS NOT NULL AND last_match_time >= ${cutoffSec}
    ORDER BY rating DESC NULLS LAST
  `);
  const allIds = ((teams.rows ?? teams as unknown as { team_id: number }[]) as { team_id: number }[])
    .map(r => Number(r.team_id)).filter(Boolean);

  const fresh = await db.execute<{ team_id: number }>(sql`
    SELECT DISTINCT team_id FROM team_hero_pool WHERE fetched_at > ${freshCutoff}
  `);
  const freshSet = new Set(((fresh.rows ?? fresh as unknown as { team_id: number }[]) as { team_id: number }[])
    .map(r => Number(r.team_id)));
  const toFetch = allIds.filter(id => !freshSet.has(id));
  console.log(`[od-team-hero-pools] ${toFetch.length} to fetch, ${freshSet.size} fresh`);

  let saved = 0, failed = 0;
  const now = new Date();

  for (let i = 0; i < toFetch.length; i++) {
    const teamId = toFetch[i]!;
    try {
      const heroes = await fetchOdJson<OdTeamHero[]>(`/teams/${teamId}/heroes`);
      if (heroes && Array.isArray(heroes) && heroes.length > 0) {
        const insertRows = heroes
          .filter(h => h.hero_id > 0 && h.games_played > 0)
          .map(h => ({
            teamId,
            heroId: h.hero_id,
            gamesPlayed: h.games_played,
            wins: h.wins ?? 0,
            fetchedAt: now,
          }));
        if (insertRows.length > 0) {
          await db.insert(teamHeroPoolTable).values(insertRows)
            .onConflictDoUpdate({
              target: [teamHeroPoolTable.teamId, teamHeroPoolTable.heroId],
              set: {
                gamesPlayed: sql`excluded.games_played`,
                wins: sql`excluded.wins`,
                fetchedAt: sql`excluded.fetched_at`,
              },
            });
          saved += insertRows.length;
        }
      }
    } catch (e) {
      if (e instanceof OdQuotaExhaustedError) {
        console.warn(`[od-team-hero-pools] ${e.message} — прерываю цикл (saved=${saved} failed=${failed})`);
        break;
      }
      failed++;
      if (failed <= 5) console.warn(`[od-team-hero-pools] team=${teamId} ${(e as Error).message}`);
    }
    if (i % 100 === 99) console.log(`[od-team-hero-pools] progress ${i + 1}/${toFetch.length} saved=${saved} failed=${failed}`);
    await sleep(DELAY_MS);
  }
  console.log(`[od-team-hero-pools] DONE saved=${saved} failed=${failed}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
