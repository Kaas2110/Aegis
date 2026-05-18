/**
 * ingest:od-player-totals — долгосрочные суммы статистик игрока.
 * Источник: /players/{id}/totals → массив { field, n, sum }
 *
 * Идём по уникальным account_id из match_drafts (как в ingest:od-player-peers).
 * Freshness 14 дней. Один запрос на игрока.
 */
import { db, matchDraftsTable, playerTotalsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { fetchOdJson, sleep, DELAY_MS } from './lib/odPace.js';

const FRESHNESS_DAYS = 14;

interface OdTotal {
  field: string;
  n: number;
  sum: number;
}

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
    SELECT DISTINCT account_id FROM player_totals WHERE fetched_at > ${cutoff}
  `);
  const freshSet = new Set(((fresh.rows ?? fresh as unknown as { account_id: number }[]) as { account_id: number }[])
    .map(r => Number(r.account_id)));
  const toFetch = allIds.filter(id => !freshSet.has(id));
  console.log(`[od-player-totals] ${toFetch.length} to fetch, ${freshSet.size} fresh (${allIds.length} total)`);

  let saved = 0, failed = 0;
  const now = new Date();
  for (let i = 0; i < toFetch.length; i++) {
    const accountId = toFetch[i]!;
    try {
      const totals = await fetchOdJson<OdTotal[]>(`/players/${accountId}/totals`);
      if (totals && Array.isArray(totals) && totals.length > 0) {
        const rows = totals
          .filter(t => t.field && typeof t.n === 'number' && t.n > 0)
          .map(t => ({
            accountId,
            field: t.field,
            n: t.n,
            sum: t.sum ?? 0,
            avg: t.n > 0 ? (t.sum ?? 0) / t.n : 0,
            fetchedAt: now,
          }));
        if (rows.length > 0) {
          await db.insert(playerTotalsTable).values(rows).onConflictDoUpdate({
            target: [playerTotalsTable.accountId, playerTotalsTable.field],
            set: {
              n: sql`excluded.n`,
              sum: sql`excluded.sum`,
              avg: sql`excluded.avg`,
              fetchedAt: sql`excluded.fetched_at`,
            },
          });
          saved += rows.length;
        }
      }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[od-player-totals] acct=${accountId} ${(e as Error).message}`);
    }
    if (i % 200 === 199) console.log(`[od-player-totals] progress ${i + 1}/${toFetch.length} saved=${saved} failed=${failed}`);
    await sleep(DELAY_MS);
  }
  console.log(`[od-player-totals] DONE saved=${saved} failed=${failed}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
