/**
 * ingest:od-pro-players — список pro-игроков с актуальным team_id.
 * Источник: /proPlayers (один запрос).
 *
 * Запуск раз в неделю. Полный rewrite (upsert) — pro-сцена не очень большая.
 */
import { db, proPlayersTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { fetchOdJson } from './lib/odPace.js';

interface OdProPlayer {
  account_id: number;
  steamid?: string | null;
  avatar?: string | null;
  personaname?: string | null;
  name?: string | null;
  loccountrycode?: string | null;
  country_code?: string | null;
  fantasy_role?: number | null;
  team_id?: number | null;
  team_name?: string | null;
  team_tag?: string | null;
  is_locked?: boolean | null;
  locked_until?: number | null;
  fh_unavailable?: boolean | null;
  full_history_time?: string | null;
  last_login?: string | null;
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

async function main() {
  const data = await fetchOdJson<OdProPlayer[]>(`/proPlayers`, 30_000);
  if (!data || !Array.isArray(data)) {
    console.error(`[od-pro-players] no data`);
    process.exit(1);
  }
  console.log(`[od-pro-players] received ${data.length} pro players`);

  const now = new Date();
  const rows = data
    .filter(p => p.account_id > 0)
    .map(p => ({
      accountId: p.account_id,
      steamid: p.steamid ?? null,
      personaname: p.personaname ?? null,
      name: p.name ?? null,
      countryCode: p.country_code ?? p.loccountrycode ?? null,
      fantasyRole: p.fantasy_role ?? null,
      teamId: p.team_id ?? null,
      teamName: p.team_name ?? null,
      teamTag: p.team_tag ?? null,
      isLocked: p.is_locked ?? null,
      lockedUntil: p.locked_until ?? null,
      fhUnavailable: p.fh_unavailable ?? null,
      fullHistoryTime: parseDate(p.full_history_time),
      lastLogin: parseDate(p.last_login),
      fetchedAt: now,
    }));

  // Батчами по 500
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    await db.insert(proPlayersTable).values(batch).onConflictDoUpdate({
      target: proPlayersTable.accountId,
      set: {
        steamid: sql`excluded.steamid`,
        personaname: sql`excluded.personaname`,
        name: sql`excluded.name`,
        countryCode: sql`excluded.country_code`,
        fantasyRole: sql`excluded.fantasy_role`,
        teamId: sql`excluded.team_id`,
        teamName: sql`excluded.team_name`,
        teamTag: sql`excluded.team_tag`,
        isLocked: sql`excluded.is_locked`,
        lockedUntil: sql`excluded.locked_until`,
        fhUnavailable: sql`excluded.fh_unavailable`,
        fullHistoryTime: sql`excluded.full_history_time`,
        lastLogin: sql`excluded.last_login`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    });
  }
  console.log(`[od-pro-players] DONE upserted=${rows.length}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
