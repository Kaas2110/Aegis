/**
 * ingest:od-player-wl-pro — pro-only win/loss игрока за окно (180 дней).
 * Источник: /players/{id}/wl?date=180&significant=1
 *   { win: N, lose: N }
 *
 * Freshness 14 дней. ~3000 уникальных pro-игроков.
 */
import { db, matchDraftsTable, playerWlProTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { fetchOdJson, sleep, DELAY_MS, OdQuotaExhaustedError } from './lib/odPace.js';

const FRESHNESS_DAYS = 14;
const WINDOW_DAYS = 180;

interface OdWl {
  win: number;
  lose: number;
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
    SELECT account_id FROM player_wl_pro WHERE fetched_at > ${cutoff}
  `);
  const freshSet = new Set(((fresh.rows ?? fresh as unknown as { account_id: number }[]) as { account_id: number }[])
    .map(r => Number(r.account_id)));
  const toFetch = allIds.filter(id => !freshSet.has(id));
  console.log(`[od-player-wl-pro] ${toFetch.length} to fetch, ${freshSet.size} fresh`);

  let saved = 0, failed = 0;
  const now = new Date();
  for (let i = 0; i < toFetch.length; i++) {
    const accountId = toFetch[i]!;
    try {
      const data = await fetchOdJson<OdWl>(`/players/${accountId}/wl?date=${WINDOW_DAYS}&significant=1`);
      if (data && typeof data === 'object' && (typeof data.win === 'number' || typeof data.lose === 'number')) {
        await db.insert(playerWlProTable).values({
          accountId,
          win: data.win ?? 0,
          lose: data.lose ?? 0,
          windowDays: WINDOW_DAYS,
          fetchedAt: now,
        }).onConflictDoUpdate({
          target: playerWlProTable.accountId,
          set: {
            win: sql`excluded.win`,
            lose: sql`excluded.lose`,
            windowDays: sql`excluded.window_days`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
        saved++;
      }
    } catch (e) {
      if (e instanceof OdQuotaExhaustedError) {
        console.warn(`[od-player-wl-pro] ${e.message} — прерываю цикл (saved=${saved} failed=${failed})`);
        throw e;
      }
      failed++;
      if (failed <= 5) console.warn(`[od-player-wl-pro] acct=${accountId} ${(e as Error).message}`);
    }
    if (i % 200 === 199) console.log(`[od-player-wl-pro] progress ${i + 1}/${toFetch.length} saved=${saved} failed=${failed}`);
    await sleep(DELAY_MS);
  }
  console.log(`[od-player-wl-pro] DONE saved=${saved} failed=${failed}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
