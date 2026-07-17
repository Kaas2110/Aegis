/**
 * Backfill для команд, которые встречаются в pro_matches за 365d,
 * но отсутствуют в teams (например, tier-2/3 nonames, не вошедшие в топ-1013
 * OD /api/teams). Тянет полную карточку через GET /api/teams/{id}, upsert
 * в teams (и в team_rating_snapshots — даёт первую точку для rating_growth_*).
 *
 * Запускается:
 *   - однократно вручную после деплоя (~6 мин на 1816 команд при 5 req/s)
 *   - еженедельно как часть Daily Ingest (delta — десятки новых nonames в неделю)
 *
 * Rate limit: 5 req/s (200ms throttle). OD ключ даёт 1200 req/min = 20 req/s,
 * но держим консервативно — конкурируем с другими ingest-od-* воркерами.
 */

import { db, teamsTable, teamRatingSnapshotsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { odThrottleMs } from './lib/openDotaUrl';

interface OpenDotaTeamDetail {
  team_id: number;
  rating: number | null;
  wins: number | null;
  losses: number | null;
  last_match_time: number | null;
  name: string | null;
  tag: string | null;
}

const THROTTLE_MS = odThrottleMs(200); // premium: 5 req/s; free: ~1 req/s

async function fetchTeam(id: number, withKey: (url: string) => string): Promise<OpenDotaTeamDetail | null> {
  const url = withKey(`https://api.opendota.com/api/teams/${id}`);
  try {
    const resp = await fetch(url);
    if (resp.status === 404) return null;
    if (!resp.ok) {
      console.warn(`[ingest-missing-teams] HTTP ${resp.status} team_id=${id}`);
      return null;
    }
    const body = (await resp.json()) as OpenDotaTeamDetail | null;
    if (!body || !body.team_id) return null;
    return body;
  } catch (err) {
    console.warn(`[ingest-missing-teams] fetch fail team_id=${id}`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function main() {
  const { withOpenDotaKey } = await import('./lib/openDotaUrl');

  console.log('[ingest-missing-teams] Resolving missing team_ids from pro_matches (365d)...');
  const rows = await db.execute<{ team_id: number; games: number }>(sql`
    WITH missing AS (
      SELECT radiant_team_id AS team_id FROM pro_matches
        WHERE start_time > extract(epoch from now() - interval '365 days')
          AND radiant_team_id IS NOT NULL AND radiant_team_id > 0
          AND radiant_team_id NOT IN (SELECT team_id FROM teams)
      UNION ALL
      SELECT dire_team_id AS team_id FROM pro_matches
        WHERE start_time > extract(epoch from now() - interval '365 days')
          AND dire_team_id IS NOT NULL AND dire_team_id > 0
          AND dire_team_id NOT IN (SELECT team_id FROM teams)
    )
    SELECT team_id, count(*)::int AS games
      FROM missing
      GROUP BY team_id
      ORDER BY games DESC
  `);
  const targets = rows.rows.map(r => ({ teamId: Number(r.team_id), games: Number(r.games) }));
  console.log(`[ingest-missing-teams] Found ${targets.length} missing team_ids`);

  if (targets.length === 0) {
    console.log('[ingest-missing-teams] Nothing to do.');
    process.exit(0);
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const { teamId } = targets[i];
    const detail = await fetchTeam(teamId, withOpenDotaKey);

    if (!detail) {
      failed++;
    } else if (!detail.name && detail.rating == null) {
      // Пустая карточка — OD не знает команду; пропускаем (не пишем bogus row).
      skipped++;
    } else {
      await db
        .insert(teamsTable)
        .values({
          teamId: detail.team_id,
          name: detail.name ?? null,
          tag: detail.tag ?? null,
          rating: detail.rating ?? null,
          wins: detail.wins ?? 0,
          losses: detail.losses ?? 0,
          lastMatchTime: detail.last_match_time ?? null,
        })
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

      if (detail.rating != null) {
        await db
          .insert(teamRatingSnapshotsTable)
          .values({
            teamId: detail.team_id,
            capturedAt: new Date().toISOString().slice(0, 10),
            rating: detail.rating,
            wins: detail.wins ?? 0,
            losses: detail.losses ?? 0,
          })
          .onConflictDoNothing();
      }

      ok++;
    }

    if ((i + 1) % 25 === 0 || i === targets.length - 1) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stdout.write(
        `\r[ingest-missing-teams] ${i + 1}/${targets.length} (ok=${ok} skip=${skipped} fail=${failed}) ${elapsedSec}s`,
      );
    }
    if (i < targets.length - 1) await new Promise(r => setTimeout(r, THROTTLE_MS));
  }
  console.log(`\n[ingest-missing-teams] Done. ok=${ok} skipped=${skipped} failed=${failed}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest-missing-teams] FATAL', err);
  process.exit(1);
});
