/**
 * Загружает сценарные winrate героев из OpenDota premium /api/scenarios/*.
 *
 * Три endpoint'а:
 *   - /api/scenarios/itemTimings?hero_id={id}  — item timing winrate per hero
 *   - /api/scenarios/laneRoles?hero_id={id}    — lane role winrate per hero
 *   - /api/scenarios/misc                      — misc scenarios (один запрос)
 *
 * Данные хранятся в hero_scenarios (hero_id, scenario_type, data jsonb).
 * Используются как prematch фичи в ML моделях: для каждого героя в драфте
 * добавляем «item timing winrate» и «lane role winrate» текущей меты.
 *
 * Freshness: 24h (скрипт пропускает строки моложе FRESHNESS_HOURS).
 * Runs as step in run-enrichment-pipeline.sh (E0.2).
 *
 * OD premium даёт 3000 req/min. Между запросами 150ms = ~400/min — безопасно.
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run ingest:od-scenarios
 */

import { db, heroStatsTable, heroScenariosTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { odThrottleMs } from './lib/openDotaUrl.js';
import { fetchOdJson, sleep, OdQuotaExhaustedError } from './lib/odPace.js';

const FRESHNESS_HOURS = 24;
const DELAY_MS = odThrottleMs(150);

// Аудит 2026-07-17: общий fetchOdJson с 429 circuit-breaker вместо локального fetch.
async function odGet(path: string): Promise<unknown> {
  const data = await fetchOdJson<unknown>(path, 10_000);
  if (data == null) throw new Error(`OD ${path} → HTTP 404`);
  return data;
}

async function upsertScenario(heroId: number, scenarioType: string, data: unknown[]) {
  await db
    .insert(heroScenariosTable)
    .values({ heroId, scenarioType, data, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: [heroScenariosTable.heroId, heroScenariosTable.scenarioType],
      set: { data: sql`excluded.data`, fetchedAt: sql`excluded.fetched_at` },
    });
}

async function isFresh(heroId: number, scenarioType: string): Promise<boolean> {
  const row = await db.query.heroScenariosTable?.findFirst({
    where: (t, { and, eq, gt }) => and(
      eq(t.heroId, heroId),
      eq(t.scenarioType, scenarioType),
      gt(t.fetchedAt, new Date(Date.now() - FRESHNESS_HOURS * 3_600_000))
    ),
  });
  return !!row;
}

async function main() {
  const heroRows = await db.select({ heroId: heroStatsTable.heroId }).from(heroStatsTable);
  const heroIds = heroRows.map(r => r.heroId).filter(Boolean) as number[];
  console.log(`[od-scenarios] ${heroIds.length} heroes to process`);

  let saved = 0;
  let skipped = 0;
  let failed = 0;

  // misc — один запрос, hero_id=0
  const miscFresh = await isFresh(0, 'misc');
  if (!miscFresh) {
    try {
      const data = await odGet('/scenarios/misc') as unknown[];
      await upsertScenario(0, 'misc', Array.isArray(data) ? data : [data as unknown]);
      saved++;
      console.log(`[od-scenarios] misc → ${Array.isArray(data) ? data.length : 1} rows`);
    } catch (err) {
      if (err instanceof OdQuotaExhaustedError) throw err;
      failed++;
      console.warn(`[od-scenarios] misc FAILED: ${err}`);
    }
    await sleep(DELAY_MS);
  } else {
    skipped++;
  }

  for (let i = 0; i < heroIds.length; i++) {
    const heroId = heroIds[i]!;

    for (const scenarioType of ['itemTimings', 'laneRoles'] as const) {
      const fresh = await isFresh(heroId, scenarioType);
      if (fresh) { skipped++; continue; }

      try {
        const data = await odGet(`/scenarios/${scenarioType}?hero_id=${heroId}`) as unknown[];
        await upsertScenario(heroId, scenarioType, Array.isArray(data) ? data : []);
        saved++;
      } catch (err) {
        if (err instanceof OdQuotaExhaustedError) {
          console.warn(`[od-scenarios] ${err.message} — прерываю цикл (saved=${saved} failed=${failed})`);
          throw err;
        }
        failed++;
        console.warn(`[od-scenarios] hero=${heroId} type=${scenarioType} FAILED: ${err}`);
      }
      await sleep(DELAY_MS);
    }

    if ((i + 1) % 20 === 0) {
      console.log(`[od-scenarios] ${i + 1}/${heroIds.length} heroes · saved=${saved} skipped=${skipped} failed=${failed}`);
    }
  }

  console.log(`[od-scenarios] DONE saved=${saved} skipped=${skipped} failed=${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
