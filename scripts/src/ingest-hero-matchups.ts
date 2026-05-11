/**
 * Загружает матчапы героев из OpenDota /api/heroes/:id/matchups.
 * 138 запросов × 1.1 сек = ~3 минуты.
 *
 * Каждый запрос отдаёт массив матчапов: с какими героями этот герой
 * сыграл и сколько выиграл. Записываем как (heroId, vsHeroId) пары.
 *
 * Идемпотентно: при повторном запуске обновляет существующие записи.
 *
 * Источник списка героев — таблица hero_stats (предварительно загружена
 * через ingest-hero-stats.ts).
 */

import { db, heroStatsTable, heroMatchupsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';

interface OpenDotaMatchup {
  hero_id: number;          // соперник
  games_played: number;
  wins: number;
}

const SLEEP_MS = 1100;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchMatchups(heroId: number): Promise<OpenDotaMatchup[]> {
  const url = `https://api.opendota.com/api/heroes/${heroId}/matchups`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for hero ${heroId}`);
  return (await resp.json()) as OpenDotaMatchup[];
}

async function main() {
  console.log('[ingest-hero-matchups] Loading hero list from DB …');
  const allHeroes = await db
    .select({ heroId: heroStatsTable.heroId, name: heroStatsTable.name })
    .from(heroStatsTable);
  if (allHeroes.length === 0) {
    throw new Error('No heroes in hero_stats — run ingest:hero-stats first.');
  }
  // Инкрементально: пропускаем тех, у кого уже есть >0 матчапов в БД.
  // Если запуск убили на полпути — следующий запуск продолжит с прерванного места.
  const doneRows = await db
    .selectDistinct({ heroId: heroMatchupsTable.heroId })
    .from(heroMatchupsTable);
  const doneSet = new Set<number>(doneRows.map(r => r.heroId));
  const heroes = allHeroes.filter(h => !doneSet.has(h.heroId));
  console.log(
    `[ingest-hero-matchups] ${heroes.length} heroes to fetch (skipped ${doneSet.size} already done) ` +
    `(≈${(heroes.length * 1.1 / 60).toFixed(1)} min)`,
  );
  if (heroes.length === 0) {
    console.log('[ingest-hero-matchups] All done — nothing to fetch.');
    process.exit(0);
  }

  let inserted = 0;
  let failed = 0;
  for (let i = 0; i < heroes.length; i++) {
    const h = heroes[i];
    try {
      const matchups = await fetchMatchups(h.heroId);
      const rows = matchups
        .filter(m => m.games_played > 0)
        .map(m => ({
          heroId: h.heroId,
          vsHeroId: m.hero_id,
          games: m.games_played,
          wins: m.wins,
          winRate: m.wins / m.games_played,
          updatedAt: new Date(),
        }));
      if (rows.length > 0) {
        await db
          .insert(heroMatchupsTable)
          .values(rows)
          .onConflictDoUpdate({
            target: [heroMatchupsTable.heroId, heroMatchupsTable.vsHeroId],
            set: {
              games: sql`excluded.games`,
              wins: sql`excluded.wins`,
              winRate: sql`excluded.win_rate`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
        inserted += rows.length;
      }
    } catch (e) {
      failed++;
      console.warn(`\n[ingest-hero-matchups] Hero ${h.heroId} (${h.name}) failed: ${(e as Error).message}`);
    }
    process.stdout.write(
      `\r[ingest-hero-matchups] ${i + 1}/${heroes.length} · pairs: ${inserted} · failed: ${failed}`,
    );
    await sleep(SLEEP_MS);
  }

  console.log(`\n[ingest-hero-matchups] Done. ${inserted} pairs inserted/updated, ${failed} heroes failed.`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n[ingest-hero-matchups] FATAL', err);
  process.exit(1);
});
