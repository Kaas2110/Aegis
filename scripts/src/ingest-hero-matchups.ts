import { openDotaBackgroundFetch as fetch, OdQuotaExhaustedError } from '@workspace/db/opendota';
/**
 * Загружает матрицу матчапов героев hero-vs-hero.
 *
 * Источники (в порядке приоритета):
 *   1. Stratz GraphQL — STRATZ_TOKEN в env → 1 запрос на всю матрицу
 *      (~2.4s, ~830KB, ~16k пар). Брекет DIVINE_IMMORTAL (топ-ранкед,
 *      ближе всего к про-уровню; pro-only фильтра у Stratz нет).
 *   2. OpenDota REST — fallback при недоступности Stratz → 138 запросов × 1.1s.
 *      Каждый запрос отдаёт массив матчапов для одного героя.
 *
 * Поведение:
 *   - Stratz путь: атомарный snapshot — TRUNCATE + INSERT в транзакции.
 *     Stratz возвращает полную матрицу за один запрос → старые записи
 *     удаляются полностью, чтобы не оставалось пар, которых больше нет.
 *   - OpenDota путь: инкрементальный — пропускаем героев, уже загруженных
 *     ранее (полезно если запуск убили на полпути; следующий продолжит).
 *
 * ⚠️ DISTRIBUTION SHIFT: matchCount у Stratz (Immortal ranked, тысячи) и у
 *    OpenDota (только pro, десятки/сотни) отличается на 2-3 порядка. Фича
 *    `matchup_advantage` использует log(games + 1) → переключение источника
 *    меняет распределение этой фичи и требует переобучения v2/v3 моделей:
 *      pnpm --filter @workspace/scripts run train:lightgbm
 *
 * Источник списка героев — таблица hero_stats (предварительно загружена
 * через ingest-hero-stats.ts).
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run ingest:hero-matchups
 *   pnpm --filter @workspace/scripts run ingest:hero-matchups -- --no-stratz
 *   pnpm --filter @workspace/scripts run ingest:hero-matchups -- --no-fallback
 */

import { db, heroStatsTable, heroMatchupsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import {
  fetchHeroMatchupsRanked,
  StratzUnavailableError,
  getStratzPoolSize,
  type StratzHeroMatchupRow,
} from './lib/stratz.js';

// ---------- OpenDota fallback ----------

interface OpenDotaMatchup {
  hero_id: number;
  games_played: number;
  wins: number;
}

const OD_SLEEP_MS = 1100;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchMatchupsOD(heroId: number): Promise<OpenDotaMatchup[]> {
  const { withOpenDotaKey } = await import('./lib/openDotaUrl');
  const url = withOpenDotaKey(`https://api.opendota.com/api/heroes/${heroId}/matchups`);
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for hero ${heroId}`);
  return (await resp.json()) as OpenDotaMatchup[];
}

// ---------- Row shape (общая для обоих источников) ----------

interface MatchupRow {
  heroId: number;
  vsHeroId: number;
  games: number;
  wins: number;
  winRate: number;
  updatedAt: Date;
}

function buildRowsFromStratz(snapshot: StratzHeroMatchupRow[]): MatchupRow[] {
  const now = new Date();
  const out: MatchupRow[] = [];
  for (const row of snapshot) {
    if (!row.heroId || !row.vs) continue;
    for (const v of row.vs) {
      if (!v.heroId2 || v.matchCount <= 0) continue;
      // Stratz отдаёт winsAverage (winrate), wins нужно восстановить.
      // Округляем до целого; small precision loss в wins не критичен,
      // фичи используют только winRate.
      const wins = Math.round(v.winsAverage * v.matchCount);
      out.push({
        heroId: row.heroId,
        vsHeroId: v.heroId2,
        games: v.matchCount,
        wins,
        winRate: v.winsAverage,
        updatedAt: now,
      });
    }
  }
  return out;
}

// ---------- DB writers ----------

const INSERT_CHUNK = 1000;

/**
 * Stratz path: атомарный swap — DELETE + INSERT в одной транзакции.
 * Если транзакция падает (например, дубликаты пар) — старые данные
 * остаются нетронутыми.
 */
async function writeStratzSnapshot(rows: MatchupRow[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(heroMatchupsTable);
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      await tx.insert(heroMatchupsTable).values(chunk);
    }
  });
}

/**
 * OpenDota path: инкрементальный upsert (как было исторически).
 */
async function upsertODHero(rows: MatchupRow[]): Promise<void> {
  if (rows.length === 0) return;
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
}

// ---------- Strategy runners ----------

async function runStratz(heroIds: number[]): Promise<{ rows: number; pairs: number }> {
  const t0 = Date.now();
  console.log(
    `[ingest-hero-matchups] Stratz: requesting matrix for ${heroIds.length} heroes ` +
    `(pool=${getStratzPoolSize()}, bracket=DIVINE_IMMORTAL) …`,
  );
  const snapshot = await fetchHeroMatchupsRanked(heroIds, 200);
  const fetchMs = Date.now() - t0;

  const rows = buildRowsFromStratz(snapshot);

  // Sanity-floor для destructive swap: типичный полный ответ Stratz — ~16k пар
  // на ~127 героев. Если внезапно пришло сильно меньше — это не «герой пропал»,
  // это partial outage Stratz (CF challenge посреди ответа, неполный JSON,
  // временный фильтр на стороне Stratz и т.п.). Отказываемся затирать всю
  // матрицу и идём на OD-fallback. Порог консервативный — должны пройти даже
  // крупные пересмотры пула героев.
  const MIN_PAIRS_FOR_SWAP = 8000;
  const MIN_HEROES_FOR_SWAP = 100;
  if (snapshot.length < MIN_HEROES_FOR_SWAP || rows.length < MIN_PAIRS_FOR_SWAP) {
    throw new StratzUnavailableError(
      `Stratz returned suspiciously small snapshot ` +
      `(heroes=${snapshot.length} < ${MIN_HEROES_FOR_SWAP}, ` +
      `pairs=${rows.length} < ${MIN_PAIRS_FOR_SWAP}) — treating as partial outage`,
    );
  }

  console.log(
    `[ingest-hero-matchups] Stratz: got ${snapshot.length} heroes, ${rows.length} pairs ` +
    `in ${fetchMs}ms — performing atomic swap …`,
  );
  await writeStratzSnapshot(rows);
  return { rows: snapshot.length, pairs: rows.length };
}

async function runOpenDota(
  heroes: { heroId: number; name: string | null }[],
): Promise<{ rows: number; pairs: number; failed: number }> {
  console.log(
    '[ingest-hero-matchups] OpenDota: incremental mode — skip heroes already in DB.',
  );
  const doneRows = await db
    .selectDistinct({ heroId: heroMatchupsTable.heroId })
    .from(heroMatchupsTable);
  const doneSet = new Set<number>(doneRows.map(r => r.heroId));
  const todo = heroes.filter(h => !doneSet.has(h.heroId));
  console.log(
    `[ingest-hero-matchups] OpenDota: ${todo.length} heroes to fetch ` +
    `(skipped ${doneSet.size}) — ETA ≈${(todo.length * 1.1 / 60).toFixed(1)} min`,
  );
  if (todo.length === 0) return { rows: doneSet.size, pairs: 0, failed: 0 };

  let pairs = 0;
  let failed = 0;
  const now = new Date();

  for (let i = 0; i < todo.length; i++) {
    const h = todo[i]!;
    try {
      const matchups = await fetchMatchupsOD(h.heroId);
      const rows: MatchupRow[] = matchups
        .filter(m => m.games_played > 0)
        .map(m => ({
          heroId: h.heroId,
          vsHeroId: m.hero_id,
          games: m.games_played,
          wins: m.wins,
          winRate: m.wins / m.games_played,
          updatedAt: now,
        }));
      await upsertODHero(rows);
      pairs += rows.length;
    } catch (e) {
      if (e instanceof OdQuotaExhaustedError) throw e;
      failed++;
      console.warn(
        `\n[ingest-hero-matchups] OD hero ${h.heroId} (${h.name}) failed: ${(e as Error).message}`,
      );
    }
    process.stdout.write(
      `\r[ingest-hero-matchups] OD ${i + 1}/${todo.length} · pairs: ${pairs} · failed: ${failed}`,
    );
    await sleep(OD_SLEEP_MS);
  }
  process.stdout.write('\n');
  return { rows: todo.length, pairs, failed };
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  const forceOpenDota = args.includes('--no-stratz');
  const noFallback = args.includes('--no-fallback');

  console.log('[ingest-hero-matchups] Loading hero list from DB …');
  const allHeroes = await db
    .select({ heroId: heroStatsTable.heroId, name: heroStatsTable.name })
    .from(heroStatsTable);
  if (allHeroes.length === 0) {
    throw new Error('No heroes in hero_stats — run ingest:hero-stats first.');
  }

  const stratzAvailable = !forceOpenDota && getStratzPoolSize() > 0;

  if (stratzAvailable) {
    try {
      const heroIds = allHeroes.map(h => h.heroId);
      const r = await runStratz(heroIds);
      console.log(
        `\n[ingest-hero-matchups] DONE via Stratz. ` +
        `heroes=${r.rows} pairs=${r.pairs} source=stratz(DIVINE_IMMORTAL)`,
      );
      console.log(
        '[ingest-hero-matchups] ⚠️  matchCount шкала отличается от OpenDota — ' +
        'переобучите v2/v3: pnpm --filter @workspace/scripts run train:lightgbm',
      );
      process.exit(0);
    } catch (e) {
      if (e instanceof OdQuotaExhaustedError) throw e;
      const msg = (e as Error).message;
      if (e instanceof StratzUnavailableError) {
        if (noFallback) {
          console.error(`[ingest-hero-matchups] Stratz failed and --no-fallback set: ${msg}`);
          process.exit(2);
        }
        console.warn(
          `[ingest-hero-matchups] Stratz unavailable (${msg}) — falling back to OpenDota.`,
        );
      } else {
        // Неожиданная ошибка (network/db crash) — не маскируем под fallback.
        throw e;
      }
    }
  } else if (forceOpenDota) {
    console.log('[ingest-hero-matchups] --no-stratz: forcing OpenDota path.');
  } else {
    console.log('[ingest-hero-matchups] STRATZ_TOKEN не задан — using OpenDota.');
  }

  // OpenDota path (forced или fallback)
  const r = await runOpenDota(allHeroes);
  console.log(
    `[ingest-hero-matchups] DONE via OpenDota. ` +
    `heroes_fetched=${r.rows} pairs=${r.pairs} failed=${r.failed} source=opendota`,
  );
  process.exit(0);
}

main().catch(err => {
  console.error('\n[ingest-hero-matchups] FATAL', err);
  process.exit(1);
});
