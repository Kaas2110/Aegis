import { openDotaBackgroundFetch as fetch, OdQuotaExhaustedError } from '@workspace/db/opendota';
/**
 * Загружает рейтинги команд из OpenDota /api/teams (~3000 команд).
 * Один запрос — весь список топ-команд по рейтингу Glicko.
 */

import { db, teamsTable, teamRatingSnapshotsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';

interface OpenDotaTeam {
  team_id: number;
  rating: number | null;
  wins: number;
  losses: number;
  last_match_time: number;
  name: string | null;
  tag: string | null;
}

async function main() {
  console.log('[ingest-teams] Fetching from OpenDota /api/teams …');
  const { withOpenDotaKey } = await import('./lib/openDotaUrl');
  const resp = await fetch(withOpenDotaKey('https://api.opendota.com/api/teams'));
  if (!resp.ok) {
    throw new Error(`OpenDota /api/teams: HTTP ${resp.status}`);
  }
  const teams = (await resp.json()) as OpenDotaTeam[];
  console.log(`[ingest-teams] Got ${teams.length} teams`);

  const valid = teams.filter(t => t.team_id && t.team_id > 0);
  console.log(`[ingest-teams] Inserting ${valid.length} valid teams …`);

  // Батчевая вставка по 200 строк
  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < valid.length; i += BATCH) {
    const chunk = valid.slice(i, i + BATCH).map(t => ({
      teamId: t.team_id,
      name: t.name ?? null,
      tag: t.tag ?? null,
      rating: t.rating ?? null,
      wins: t.wins ?? 0,
      losses: t.losses ?? 0,
      lastMatchTime: t.last_match_time ?? null,
    }));

    await db
      .insert(teamsTable)
      .values(chunk)
      .onConflictDoUpdate({
        target: teamsTable.teamId,
        set: {
          name: sql`excluded.name`,
          tag: sql`excluded.tag`,
          rating: sql`excluded.rating`,
          wins: sql`excluded.wins`,
          losses: sql`excluded.losses`,
          lastMatchTime: sql`excluded.last_match_time`,
          updatedAt: sql`now()`,
        },
      });

    inserted += chunk.length;
    process.stdout.write(`\r[ingest-teams] Inserted ${inserted}/${valid.length}`);
  }
  console.log('');

  // Дневной снапшот рейтинга для фич rating_growth_{7d,14d,30d,90d}.
  // PK(team_id, captured_at) + ON CONFLICT DO NOTHING — повторный прогон
  // в те же сутки идемпотентен.
  const today = new Date().toISOString().slice(0, 10);
  const withRating = valid.filter(t => t.rating != null);
  let snapshotted = 0;
  for (let i = 0; i < withRating.length; i += BATCH) {
    const chunk = withRating.slice(i, i + BATCH).map(t => ({
      teamId: t.team_id,
      capturedAt: today,
      rating: t.rating as number,
      wins: t.wins ?? 0,
      losses: t.losses ?? 0,
    }));
    await db.insert(teamRatingSnapshotsTable).values(chunk).onConflictDoNothing();
    snapshotted += chunk.length;
  }
  console.log(`[ingest-teams] Snapshotted ratings: ${snapshotted}/${withRating.length} for ${today}`);
  console.log('[ingest-teams] Done.');
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest-teams] FATAL', err);
  process.exit(1);
});
