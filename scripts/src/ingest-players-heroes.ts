/**
 * Wave 3: загружает per-hero статистику для каждого pro-игрока.
 *
 * Источники (в порядке приоритета):
 *   1. Stratz GraphQL (если STRATZ_TOKEN задан):
 *      - 1 запрос на игрока → heroesPerformance (PROFESSIONAL + DIVINE + IMMORTAL)
 *      - ~260ms/игрок vs 2×100ms через OpenDota
 *   2. OpenDota REST (fallback или --no-stratz):
 *      - 2 запроса: /players/{id}/heroes + /players/{id} (профиль)
 *      - 100ms каждый (premium key: 3000 req/min)
 *
 * Профиль (personaName, proName, countryCode) тянется из OpenDota в обоих случаях —
 * Stratz не возвращает pro-имена через публичное API.
 *
 * Идемпотентно: пропускает игроков, у которых данные свежее freshDays.
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run ingest:players-heroes
 *   pnpm --filter @workspace/scripts run ingest:players-heroes 100
 *   pnpm --filter @workspace/scripts run ingest:players-heroes --fresh-days 30
 *   pnpm --filter @workspace/scripts run ingest:players-heroes --no-stratz
 */

import { fetchOdJson, OdQuotaExhaustedError } from './lib/odPace.js';
import { db, matchDraftsTable, playersTable, playerHeroStatsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import {
  fetchPlayerHeroes as fetchStratzPlayerHeroes,
  stratzSleep,
  StratzUnavailableError,
} from './lib/stratz.js';

const OD_SLEEP_MS = 1100;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface OpenDotaPlayerHero {
  hero_id: number | string;
  games: number;
  win: number;
  last_played?: number | null;
}

interface OpenDotaPlayerProfile {
  profile?: {
    account_id?: number;
    personaname?: string | null;
    name?: string | null;
    loccountrycode?: string | null;
  };
  last_match_time?: number | null;
}

// Аудит 2026-07-17: общий fetchOdJson с 429 circuit-breaker вместо локального fetch —
// при исчерпании OD-квоты (Stratz-фоллбек-шторм) скрипт прерывается, а не жжёт
// тысячи 429, добивая user-facing live-путь api-server'а.
async function fetchOdPlayerHeroes(accountId: number): Promise<OpenDotaPlayerHero[]> {
  const data = await fetchOdJson<OpenDotaPlayerHero[]>(`/players/${accountId}/heroes`);
  if (data == null) throw new Error(`HTTP 404 for /players/${accountId}/heroes`);
  return data;
}

async function fetchPlayerProfile(accountId: number): Promise<OpenDotaPlayerProfile> {
  const data = await fetchOdJson<OpenDotaPlayerProfile>(`/players/${accountId}`);
  if (data == null) throw new Error(`HTTP 404 for /players/${accountId}`);
  return data;
}

async function upsertProfile(accountId: number): Promise<void> {
  try {
    const profile = await fetchPlayerProfile(accountId);
    const p = profile.profile;
    await db
      .insert(playersTable)
      .values({
        accountId,
        personaName: p?.personaname ?? null,
        proName:     p?.name ?? null,
        countryCode: p?.loccountrycode ?? null,
        lastSeen:    profile.last_match_time ?? null,
      })
      .onConflictDoUpdate({
        target: playersTable.accountId,
        set: {
          personaName: sql`EXCLUDED.persona_name`,
          proName:     sql`EXCLUDED.pro_name`,
          countryCode: sql`EXCLUDED.country_code`,
          lastSeen:    sql`EXCLUDED.last_seen`,
          updatedAt:   sql`NOW()`,
        },
      });
    await sleep(OD_SLEEP_MS);
  } catch {
    // best-effort, не критично
  }
}

async function upsertHeroRows(
  accountId: number,
  rows: Array<{ heroId: number; games: number; wins: number; lastPlayed: number | null }>,
) {
  if (rows.length === 0) return;
  await db
    .insert(playerHeroStatsTable)
    .values(rows.map(r => ({ accountId, ...r })))
    .onConflictDoUpdate({
      target: [playerHeroStatsTable.accountId, playerHeroStatsTable.heroId],
      set: {
        games:      sql`EXCLUDED.games`,
        wins:       sql`EXCLUDED.wins`,
        lastPlayed: sql`EXCLUDED.last_played`,
        updatedAt:  sql`NOW()`,
      },
    });
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find(a => /^\d+$/.test(a));
  const limit = limitArg ? Number(limitArg) : null;
  const freshDaysIdx = args.indexOf('--fresh-days');
  const freshDays = freshDaysIdx >= 0 && args[freshDaysIdx + 1] ? Number(args[freshDaysIdx + 1]) : 7;
  const forceOpenDota = args.includes('--no-stratz');

  const useStratz = !forceOpenDota && !!process.env['STRATZ_TOKEN'];
  console.log(`[ingest-players-heroes] freshDays=${freshDays} limit=${limit ?? 'all'} source=${useStratz ? 'Stratz+OD' : 'OpenDota'}`);
  if (!useStratz && !forceOpenDota) {
    console.log('[ingest-players-heroes] Tip: добавьте STRATZ_TOKEN в Replit Secrets для 4× ускорения.');
  }

  // 1) Уникальные account_ids из drafts.
  const accountsRows = await db.execute(sql`
    SELECT DISTINCT acc FROM (
      SELECT jsonb_array_elements_text(radiant_account_ids)::bigint AS acc
        FROM match_drafts WHERE radiant_account_ids IS NOT NULL
      UNION
      SELECT jsonb_array_elements_text(dire_account_ids)::bigint AS acc
        FROM match_drafts WHERE dire_account_ids IS NOT NULL
    ) t WHERE acc > 0
  `);
  const allAccountIds = (accountsRows.rows as Array<{ acc: string | number }>).map(r => Number(r.acc));
  console.log(`[ingest-players-heroes] ${allAccountIds.length} distinct accounts in drafts`);

  // 2) Пропускаем свежие.
  const stale = await db.execute(sql`
    SELECT account_id, MAX(updated_at) AS last_upd
      FROM player_hero_stats
     WHERE account_id = ANY(${sql.raw(`ARRAY[${allAccountIds.join(',') || 'NULL'}]::bigint[]`)})
     GROUP BY account_id
  `);
  const fresh = new Set<number>();
  const cutoff = Date.now() - freshDays * 86400_000;
  for (const r of stale.rows as Array<{ account_id: string | number; last_upd: string }>) {
    if (new Date(r.last_upd).getTime() > cutoff) fresh.add(Number(r.account_id));
  }
  let todo = allAccountIds.filter(a => !fresh.has(a));
  if (limit !== null) todo = todo.slice(0, limit);

  const etaMins = useStratz
    ? (todo.length * 0.52 / 60).toFixed(1)   // ~260ms heroes + 260ms profile (OD)
    : (todo.length * 0.2 / 60).toFixed(1);    // 2×100ms (premium OD)
  console.log(`[ingest-players-heroes] ${todo.length} to fetch (skipped ${fresh.size} fresh, ≈${etaMins} min)`);

  if (todo.length === 0) {
    console.log('[ingest-players-heroes] Nothing to do.');
    process.exit(0);
  }

  let okHeroes = 0;
  let okProfile = 0;
  let failed = 0;
  let stratzFallbacks = 0;

  for (let i = 0; i < todo.length; i++) {
    const accountId = todo[i];
    try {
      if (useStratz) {
        try {
          const data = await fetchStratzPlayerHeroes(accountId);
          const perf = data.heroesPerformance ?? [];
          const rows = perf
            .filter(p => p.heroId && Number(p.matchCount) > 0)
            .map(p => ({
              heroId:     p.heroId,
              games:      Number(p.matchCount) || 0,
              wins:       Number(p.winCount) || 0,
              lastPlayed: p.lastPlayedDateTime ?? null,
            }));
          await upsertHeroRows(accountId, rows);
          okHeroes++;
          await stratzSleep();
        } catch (e) {
          if (e instanceof StratzUnavailableError) {
            stratzFallbacks++;
            // Fallback: OpenDota для этого игрока
            const heroes = await fetchOdPlayerHeroes(accountId);
            const rows = heroes
              .filter(h => Number(h.games) > 0)
              .map(h => ({
                heroId:     Number(h.hero_id),
                games:      Number(h.games) || 0,
                wins:       Number(h.win) || 0,
                lastPlayed: h.last_played ?? null,
              }));
            await upsertHeroRows(accountId, rows);
            okHeroes++;
            await sleep(OD_SLEEP_MS);
          } else {
            throw e;
          }
        }
      } else {
        // OpenDota-only
        const heroes = await fetchOdPlayerHeroes(accountId);
        const rows = heroes
          .filter(h => Number(h.games) > 0)
          .map(h => ({
            heroId:     Number(h.hero_id),
            games:      Number(h.games) || 0,
            wins:       Number(h.win) || 0,
            lastPlayed: h.last_played ?? null,
          }));
        await upsertHeroRows(accountId, rows);
        okHeroes++;
        await sleep(OD_SLEEP_MS);
      }

      // Профиль игрока — всегда из OpenDota (pro-имена там точнее)
      await upsertProfile(accountId);
      okProfile++;
    } catch (e) {
      if (e instanceof OdQuotaExhaustedError) {
        console.warn(`\n[ingest-players-heroes] ${e.message} — прерываю цикл (heroes=${okHeroes} failed=${failed})`);
        throw e;
      }
      failed++;
    }

    if ((i + 1) % 10 === 0 || i === todo.length - 1) {
      const fb = stratzFallbacks > 0 ? ` fb=${stratzFallbacks}` : '';
      process.stdout.write(
        `\r[ingest-players-heroes] ${i + 1}/${todo.length} · heroes=${okHeroes} profile=${okProfile} failed=${failed}${fb}`,
      );
    }
  }

  console.log(`\n[ingest-players-heroes] Done. heroes=${okHeroes} profile=${okProfile} failed=${failed} stratz_fallbacks=${stratzFallbacks}`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n[ingest-players-heroes] FATAL', err);
  process.exit(1);
});
