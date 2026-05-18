/**
 * ingest:od-player-counts — распределение матчей игрока по lane_role / game_mode /
 * patch / region / leaver_status.
 * Источник: /players/{id}/counts
 * Используется для определения роли игрока (lane_role 1..4 = safe/mid/off/jungle).
 * Freshness 14 дней.
 */
import { db, matchDraftsTable, playerCountsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { fetchOdJson, sleep, DELAY_MS } from './lib/odPace.js';

const FRESHNESS_DAYS = 14;

type OdCounts = Record<string, Record<string, { games: number; win: number }>>;

async function main() {
  const cutoff = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000);

  const rawRows = await db.execute<{ account_id: string }>(sql`
    SELECT DISTINCT elem::bigint AS account_id
    FROM match_drafts,
    LATERAL jsonb_array_elements_text(
      COALESCE(${matchDraftsTable.radiantAccountIds}, '[]'::jsonb) ||
      COALESCE(${matchDraftsTable.direAccountIds}, '[]'::jsonb)
    ) AS elem
    WHERE elem ~ '^[0-9]+$'
  `);
  const allIds = [...new Set(((rawRows.rows ?? rawRows as unknown as { account_id: string }[]) as { account_id: string }[])
    .map(r => Number(r.account_id)).filter(id => id > 0))];

  const fresh = await db.execute<{ account_id: number }>(sql`
    SELECT DISTINCT account_id FROM player_counts WHERE fetched_at > ${cutoff}
  `);
  const freshSet = new Set(((fresh.rows ?? fresh as unknown as { account_id: number }[]) as { account_id: number }[])
    .map(r => Number(r.account_id)));
  const toFetch = allIds.filter(id => !freshSet.has(id));
  console.log(`[od-player-counts] ${toFetch.length} to fetch, ${freshSet.size} fresh`);

  let saved = 0, failed = 0;
  const now = new Date();
  for (let i = 0; i < toFetch.length; i++) {
    const accountId = toFetch[i]!;
    try {
      const data = await fetchOdJson<OdCounts>(`/players/${accountId}/counts`);
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        await db.insert(playerCountsTable).values({
          accountId,
          data,
          fetchedAt: now,
        }).onConflictDoUpdate({
          target: playerCountsTable.accountId,
          set: { data: sql`excluded.data`, fetchedAt: sql`excluded.fetched_at` },
        });
        saved++;
      }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[od-player-counts] acct=${accountId} ${(e as Error).message}`);
    }
    if (i % 200 === 199) console.log(`[od-player-counts] progress ${i + 1}/${toFetch.length} saved=${saved} failed=${failed}`);
    await sleep(DELAY_MS);
  }
  console.log(`[od-player-counts] DONE saved=${saved} failed=${failed}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
