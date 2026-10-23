/**
 * ingest:od-hero-benchmarks — перцентили статов героев.
 * Источник: /benchmarks?hero_id=N
 *   { hero_id, result: { gold_per_min: [{percentile,value},...],
 *     xp_per_min, kills_per_min, last_hits_per_min,
 *     hero_damage_per_min, hero_healing_per_min, tower_damage } }
 *
 * ~138 героев, 1 запрос на героя. Раз в неделю.
 */
import { db, heroStatsTable, heroBenchmarksTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { fetchOdJson, sleep, DELAY_MS, OdQuotaExhaustedError } from './lib/odPace.js';

interface OdBenchmarks {
  hero_id: number;
  result: Record<string, Array<{ percentile: number; value: number }>>;
}

async function main() {
  const heroRows = await db.select({ heroId: heroStatsTable.heroId }).from(heroStatsTable);
  const heroIds = heroRows.map(r => r.heroId).filter((id): id is number => typeof id === 'number' && id > 0);
  console.log(`[od-hero-benchmarks] ${heroIds.length} heroes`);

  let saved = 0, failed = 0;
  const now = new Date();
  for (let i = 0; i < heroIds.length; i++) {
    const heroId = heroIds[i]!;
    try {
      const data = await fetchOdJson<OdBenchmarks>(`/benchmarks?hero_id=${heroId}`);
      if (data && data.result && Object.keys(data.result).length > 0) {
        await db.insert(heroBenchmarksTable).values({
          heroId,
          data: data.result,
          fetchedAt: now,
        }).onConflictDoUpdate({
          target: heroBenchmarksTable.heroId,
          set: { data: sql`excluded.data`, fetchedAt: sql`excluded.fetched_at` },
        });
        saved++;
      }
    } catch (e) {
      if (e instanceof OdQuotaExhaustedError) {
        console.warn(`[od-hero-benchmarks] ${e.message} — прерываю цикл (failed=${failed})`);
        throw e;
      }
      failed++;
      if (failed <= 5) console.warn(`[od-hero-benchmarks] hero=${heroId} ${(e as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`[od-hero-benchmarks] DONE saved=${saved} failed=${failed}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
