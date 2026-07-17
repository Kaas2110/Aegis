/**
 * Загружает мета-распределения и длительности матчей per hero из OpenDota premium.
 *
 * Два источника:
 *   1. /api/distributions — глобальные агрегаты (mmr, country_mmr, ranks,
 *      mmr_estimates). Один запрос → несколько строк в meta_distributions (per kind).
 *   2. /api/heroes/{id}/durations — [{duration_bin, games_played, wins}] per hero.
 *      Используется как prior для total_duration модели (q25/q75 квантили):
 *      на старте когда мало specific-samples для пары команд, prior из hero mix
 *      даёт более стабильные квантильные оценки.
 *
 * Freshness: 7 дней (еженедельное обновление достаточно, мета меняется медленно).
 * Runs as step in run-enrichment-pipeline.sh (E0.4).
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run ingest:od-distributions
 */

import { db, heroStatsTable, heroDurationsTable, metaDistributionsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { withOpenDotaKey, odThrottleMs } from './lib/openDotaUrl.js';

const FRESHNESS_DAYS = 7;
const DELAY_MS = odThrottleMs(150);
const OD_BASE = 'https://api.opendota.com/api';

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function odGet(path: string): Promise<unknown> {
  const url = withOpenDotaKey(`${OD_BASE}${path}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OD ${path} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const cutoff = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000);

  // ── 1. /api/distributions ──────────────────────────────────────────────
  const latestDist = await db.query.metaDistributionsTable?.findFirst({
    orderBy: (t, { desc }) => [desc(t.fetchedAt)],
  });
  if (!latestDist || latestDist.fetchedAt < cutoff) {
    console.log('[od-distributions] fetching /api/distributions...');
    try {
      const dist = await odGet('/distributions') as Record<string, unknown>;
      const now = new Date();
      for (const [kind, data] of Object.entries(dist)) {
        await db
          .insert(metaDistributionsTable)
          .values({ kind, data, fetchedAt: now })
          .onConflictDoUpdate({
            target: [metaDistributionsTable.kind],
            set: { data: sql`excluded.data`, fetchedAt: sql`excluded.fetched_at` },
          });
      }
      console.log(`[od-distributions] distributions saved: ${Object.keys(dist).join(', ')}`);
    } catch (err) {
      console.warn(`[od-distributions] distributions FAILED: ${err}`);
    }
  } else {
    console.log(`[od-distributions] distributions fresh (${latestDist.fetchedAt.toISOString()}), skipping`);
  }

  await sleep(DELAY_MS);

  // ── 2. /api/heroes/{id}/durations ─────────────────────────────────────
  const heroRows = await db.select({ heroId: heroStatsTable.heroId }).from(heroStatsTable);
  const heroIds = heroRows.map(r => r.heroId).filter(Boolean) as number[];
  console.log(`[od-distributions] ${heroIds.length} heroes to fetch durations`);

  // Проверяем свежесть одним запросом
  const freshDurations = await db
    .selectDistinct({ heroId: heroDurationsTable.heroId })
    .from(heroDurationsTable)
    .where(sql`${heroDurationsTable.fetchedAt} > ${cutoff}`);
  const freshSet = new Set(freshDurations.map(r => r.heroId));

  let saved = 0;
  let skipped = 0;
  let failed = 0;
  const now = new Date();

  for (let i = 0; i < heroIds.length; i++) {
    const heroId = heroIds[i]!;
    if (freshSet.has(heroId)) { skipped++; continue; }

    try {
      const data = await odGet(`/heroes/${heroId}/durations`) as Array<{ duration_bin: number; games_played: number; wins: number }>;
      await db
        .insert(heroDurationsTable)
        .values({ heroId, data: Array.isArray(data) ? data : [], fetchedAt: now })
        .onConflictDoUpdate({
          target: [heroDurationsTable.heroId],
          set: { data: sql`excluded.data`, fetchedAt: sql`excluded.fetched_at` },
        });
      saved++;
    } catch (err) {
      failed++;
      console.warn(`[od-distributions] hero=${heroId} durations FAILED: ${err}`);
    }
    await sleep(DELAY_MS);

    if ((i + 1) % 20 === 0) {
      console.log(`[od-distributions] ${i + 1}/${heroIds.length} heroes · saved=${saved} skipped=${skipped} failed=${failed}`);
    }
  }

  console.log(`[od-distributions] DONE durations saved=${saved} skipped=${skipped} failed=${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
