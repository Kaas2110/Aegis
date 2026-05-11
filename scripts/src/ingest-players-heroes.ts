/**
 * Wave 3: загружает per-hero статистику для каждого pro-игрока.
 *
 * Шаги:
 *  1. Собирает уникальные account_id из match_drafts (radiant_account_ids + dire_account_ids).
 *  2. Для каждого account_id дёргает OpenDota /players/{id}/heroes (все герои сразу).
 *  3. Upsert в player_hero_stats.
 *  4. Также подтягивает /players/{id} для personaName/proName в players.
 *
 * Идемпотентно: пропускает игроков, у которых player_hero_stats обновлены < freshDays назад.
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run ingest:players-heroes
 *   pnpm --filter @workspace/scripts run ingest:players-heroes 100        # только первые 100
 *   pnpm --filter @workspace/scripts run ingest:players-heroes --fresh-days 30
 */

import { db, matchDraftsTable, playersTable, playerHeroStatsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';

const SLEEP_MS = 1100;
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
    name?: string | null;          // pro name
    loccountrycode?: string | null;
  };
  last_match_time?: number | null;
}

async function fetchPlayerHeroes(accountId: number): Promise<OpenDotaPlayerHero[]> {
  const r = await fetch(`https://api.opendota.com/api/players/${accountId}/heroes`);
  if (!r.ok) throw new Error(`HTTP ${r.status} for /players/${accountId}/heroes`);
  return (await r.json()) as OpenDotaPlayerHero[];
}

async function fetchPlayerProfile(accountId: number): Promise<OpenDotaPlayerProfile> {
  const r = await fetch(`https://api.opendota.com/api/players/${accountId}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} for /players/${accountId}`);
  return (await r.json()) as OpenDotaPlayerProfile;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = args.find(a => /^\d+$/.test(a)) ? Number(args.find(a => /^\d+$/.test(a))) : null;
  const freshDaysIdx = args.indexOf('--fresh-days');
  const freshDays = freshDaysIdx >= 0 && args[freshDaysIdx + 1] ? Number(args[freshDaysIdx + 1]) : 7;

  console.log(`[ingest-players-heroes] freshDays=${freshDays} limit=${limit ?? 'all'}`);

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

  // 2) Из них пропускаем тех, у кого свежие данные.
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
  console.log(`[ingest-players-heroes] ${todo.length} to fetch (skipped ${fresh.size} fresh, ≈${(todo.length * 2.2 / 60).toFixed(1)} min)`);

  if (todo.length === 0) {
    console.log('[ingest-players-heroes] Nothing to do.');
    process.exit(0);
  }

  let okHeroes = 0;
  let okProfile = 0;
  let failed = 0;

  for (let i = 0; i < todo.length; i++) {
    const accountId = todo[i];
    try {
      const heroes = await fetchPlayerHeroes(accountId);
      if (heroes.length > 0) {
        const rows = heroes
          .filter(h => Number(h.games) > 0)
          .map(h => ({
            accountId,
            heroId: Number(h.hero_id),
            games: Number(h.games) || 0,
            wins: Number(h.win) || 0,
            lastPlayed: h.last_played ?? null,
          }));
        if (rows.length > 0) {
          await db
            .insert(playerHeroStatsTable)
            .values(rows)
            .onConflictDoUpdate({
              target: [playerHeroStatsTable.accountId, playerHeroStatsTable.heroId],
              set: {
                games: sql`EXCLUDED.games`,
                wins: sql`EXCLUDED.wins`,
                lastPlayed: sql`EXCLUDED.last_played`,
                updatedAt: sql`NOW()`,
              },
            });
        }
        okHeroes++;
      }
      await sleep(SLEEP_MS);

      // Профиль игрока (best-effort, не критично)
      try {
        const profile = await fetchPlayerProfile(accountId);
        const p = profile.profile;
        await db
          .insert(playersTable)
          .values({
            accountId,
            personaName: p?.personaname ?? null,
            proName: p?.name ?? null,
            countryCode: p?.loccountrycode ?? null,
            lastSeen: profile.last_match_time ?? null,
          })
          .onConflictDoUpdate({
            target: playersTable.accountId,
            set: {
              personaName: sql`EXCLUDED.persona_name`,
              proName: sql`EXCLUDED.pro_name`,
              countryCode: sql`EXCLUDED.country_code`,
              lastSeen: sql`EXCLUDED.last_seen`,
              updatedAt: sql`NOW()`,
            },
          });
        okProfile++;
      } catch {
        // ignore
      }
    } catch {
      failed++;
    }
    if ((i + 1) % 10 === 0 || i === todo.length - 1) {
      process.stdout.write(
        `\r[ingest-players-heroes] ${i + 1}/${todo.length} · heroes:${okHeroes} profile:${okProfile} failed:${failed}`,
      );
    }
    await sleep(SLEEP_MS);
  }
  console.log(`\n[ingest-players-heroes] Done. heroes=${okHeroes} profile=${okProfile} failed=${failed}`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n[ingest-players-heroes] FATAL', err);
  process.exit(1);
});
