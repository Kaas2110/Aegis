/**
 * ingest:od-hero-item-popularity — популярность шмоток героя по фазам.
 * Источник: /heroes/{id}/itemPopularity
 *   { start_game_items: {item:count}, early_game_items, mid_game_items, late_game_items }
 *
 * ~138 героев. Раз в неделю.
 */
import { db, heroStatsTable, heroItemPopularityTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { fetchOdJson, sleep, DELAY_MS, OdQuotaExhaustedError } from './lib/odPace.js';

interface OdItemPop {
  start_game_items?: Record<string, number>;
  early_game_items?: Record<string, number>;
  mid_game_items?: Record<string, number>;
  late_game_items?: Record<string, number>;
}

async function main() {
  const heroRows = await db.select({ heroId: heroStatsTable.heroId }).from(heroStatsTable);
  const heroIds = heroRows.map(r => r.heroId).filter((id): id is number => typeof id === 'number' && id > 0);
  console.log(`[od-hero-item-pop] ${heroIds.length} heroes`);

  let saved = 0, failed = 0;
  const now = new Date();
  for (let i = 0; i < heroIds.length; i++) {
    const heroId = heroIds[i]!;
    try {
      const data = await fetchOdJson<OdItemPop>(`/heroes/${heroId}/itemPopularity`);
      if (data && typeof data === 'object') {
        await db.insert(heroItemPopularityTable).values({
          heroId,
          startGameItems: data.start_game_items ?? {},
          earlyGameItems: data.early_game_items ?? {},
          midGameItems: data.mid_game_items ?? {},
          lateGameItems: data.late_game_items ?? {},
          fetchedAt: now,
        }).onConflictDoUpdate({
          target: heroItemPopularityTable.heroId,
          set: {
            startGameItems: sql`excluded.start_game_items`,
            earlyGameItems: sql`excluded.early_game_items`,
            midGameItems: sql`excluded.mid_game_items`,
            lateGameItems: sql`excluded.late_game_items`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
        saved++;
      }
    } catch (e) {
      if (e instanceof OdQuotaExhaustedError) {
        console.warn(`[od-hero-item-pop] ${e.message} — прерываю цикл (failed=${failed})`);
        throw e;
      }
      failed++;
      if (failed <= 5) console.warn(`[od-hero-item-pop] hero=${heroId} ${(e as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`[od-hero-item-pop] DONE saved=${saved} failed=${failed}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
