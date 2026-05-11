/**
 * Загружает лиги из OpenDota /api/leagues (~5000 записей, один запрос).
 * Используется для обогащения live/upcoming матчей человеческими названиями.
 */

import { db, leaguesTable } from '@workspace/db';

interface OpenDotaLeague {
  leagueid: number;
  ticket: string | null;
  banner: string | null;
  tier: string | null;
  name: string | null;
}

async function main() {
  console.log('[ingest-leagues] Fetching from OpenDota /api/leagues …');
  const resp = await fetch('https://api.opendota.com/api/leagues');
  if (!resp.ok) throw new Error(`OpenDota /api/leagues: HTTP ${resp.status}`);
  const leagues = (await resp.json()) as OpenDotaLeague[];
  console.log(`[ingest-leagues] Got ${leagues.length} leagues`);

  const valid = leagues.filter(l => l.leagueid && l.leagueid > 0);
  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < valid.length; i += BATCH) {
    const chunk = valid.slice(i, i + BATCH).map(l => ({
      leagueId: l.leagueid,
      name: l.name ?? null,
      tier: l.tier ?? null,
      ticket: l.ticket ?? null,
      banner: l.banner ?? null,
    }));
    await db
      .insert(leaguesTable)
      .values(chunk)
      .onConflictDoUpdate({
        target: leaguesTable.leagueId,
        set: {
          name: leaguesTable.name,
          tier: leaguesTable.tier,
          ticket: leaguesTable.ticket,
          banner: leaguesTable.banner,
        },
      });
    inserted += chunk.length;
    console.log(`[ingest-leagues] ${inserted}/${valid.length}`);
  }
  console.log('[ingest-leagues] Done');
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest-leagues] FAILED', err);
  process.exit(1);
});
