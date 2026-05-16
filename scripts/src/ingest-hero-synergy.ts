/**
 * Загружает матрицу синергии героев (две героя в ОДНОЙ команде).
 *
 * Источник: Stratz `heroStats.matchUp.with` (top-N партнёров на героя).
 * 1 запрос ≈3.5s, ~16k уникальных пар на ~127 героев. Брекет DIVINE_IMMORTAL.
 *
 * Поведение: атомарный snapshot — DELETE + INSERT в транзакции (как у matchups).
 * Sanity-floor: если Stratz вернул мало пар (<8000) — отказываемся свопать,
 * считаем это partial outage CF challenge посреди ответа.
 *
 * STRATZ_TOKEN обязателен — OpenDota не отдаёт «with» данные.
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run ingest:hero-synergy
 */

import { db, heroStatsTable, heroSynergyTable } from '@workspace/db';
import {
  fetchHeroSynergyRanked,
  StratzUnavailableError,
  getStratzPoolSize,
  type StratzHeroSynergyRow,
} from './lib/stratz.js';

interface SynergyRow {
  heroId: number;
  withHeroId: number;
  games: number;
  wins: number;
  winRate: number;
  updatedAt: Date;
}

function buildRows(snapshot: StratzHeroSynergyRow[]): SynergyRow[] {
  const now = new Date();
  const out: SynergyRow[] = [];
  for (const row of snapshot) {
    if (!row.heroId || !row.with) continue;
    for (const w of row.with) {
      if (!w.heroId2 || w.matchCount <= 0) continue;
      // Защита от мусорных «героев» (heroId2 == heroId — теоретически не должно
      // случиться, но Stratz иногда возвращает странное).
      if (w.heroId2 === row.heroId) continue;
      const wins = Math.round(w.winsAverage * w.matchCount);
      out.push({
        heroId: row.heroId,
        withHeroId: w.heroId2,
        games: w.matchCount,
        wins,
        winRate: w.winsAverage,
        updatedAt: now,
      });
    }
  }
  return out;
}

const INSERT_CHUNK = 1000;

async function writeSnapshot(rows: SynergyRow[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(heroSynergyTable);
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      await tx.insert(heroSynergyTable).values(chunk);
    }
  });
}

async function main() {
  if (getStratzPoolSize() === 0) {
    console.error('[ingest-hero-synergy] STRATZ_TOKEN обязателен — OpenDota не отдаёт synergy');
    process.exit(2);
  }

  console.log('[ingest-hero-synergy] Loading hero list from DB …');
  const allHeroes = await db
    .select({ heroId: heroStatsTable.heroId, name: heroStatsTable.name })
    .from(heroStatsTable);
  if (allHeroes.length === 0) {
    throw new Error('No heroes in hero_stats — run ingest:hero-stats first.');
  }

  const heroIds = allHeroes.map((h) => h.heroId);
  console.log(
    `[ingest-hero-synergy] Stratz: requesting synergy matrix for ${heroIds.length} heroes ` +
    `(pool=${getStratzPoolSize()}, bracket=DIVINE_IMMORTAL) …`,
  );

  const t0 = Date.now();
  let snapshot: StratzHeroSynergyRow[];
  try {
    snapshot = await fetchHeroSynergyRanked(heroIds, 200);
  } catch (e) {
    if (e instanceof StratzUnavailableError) {
      console.error(`[ingest-hero-synergy] Stratz unavailable: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const fetchMs = Date.now() - t0;

  const rows = buildRows(snapshot);

  // Sanity-floor: типичный полный ответ ~16k пар на ~127 героев. Меньше 8k — отказ.
  const MIN_PAIRS_FOR_SWAP = 8000;
  const MIN_HEROES_FOR_SWAP = 100;
  if (snapshot.length < MIN_HEROES_FOR_SWAP || rows.length < MIN_PAIRS_FOR_SWAP) {
    console.error(
      `[ingest-hero-synergy] Stratz returned suspiciously small snapshot ` +
      `(heroes=${snapshot.length} < ${MIN_HEROES_FOR_SWAP}, ` +
      `pairs=${rows.length} < ${MIN_PAIRS_FOR_SWAP}) — refusing to swap`,
    );
    process.exit(3);
  }

  console.log(
    `[ingest-hero-synergy] Stratz: got ${snapshot.length} heroes, ${rows.length} pairs ` +
    `in ${fetchMs}ms — performing atomic swap …`,
  );
  await writeSnapshot(rows);
  console.log(
    `[ingest-hero-synergy] DONE. heroes=${snapshot.length} pairs=${rows.length} ` +
    `source=stratz(DIVINE_IMMORTAL)`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[ingest-hero-synergy] FATAL', err);
  process.exit(1);
});
