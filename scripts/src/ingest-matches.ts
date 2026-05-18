/**
 * Загружает исторические про-матчи из OpenDota /api/proMatches.
 * Пагинация: less_than_match_id. Каждый запрос отдаёт ~100 строк.
 *
 * Запуск: pnpm --filter @workspace/scripts run ingest:matches [pages=20]
 *   pages=20 → ~2000 матчей.
 */

import { db, proMatchesTable } from '@workspace/db';
import { sql } from 'drizzle-orm';

interface OpenDotaProMatch {
  match_id: number;
  duration: number;
  start_time: number;
  radiant_team_id: number;
  dire_team_id: number;
  leagueid: number;
  league_name: string;
  series_id: number;
  series_type: number;
  radiant_score: number;
  dire_score: number;
  radiant_name: string | null;
  dire_name: string | null;
  radiant_win: boolean;
  // Wave 3.D — derived market fields. Часто отдаются /proMatches'ом.
  first_blood_time?: number | null;
  barracks_status_radiant?: number | null;
  barracks_status_dire?: number | null;
  tower_status_radiant?: number | null;
  tower_status_dire?: number | null;
}

async function fetchPage(lessThan?: number): Promise<OpenDotaProMatch[]> {
  const { withOpenDotaKey } = await import('./lib/openDotaUrl');
  const url = lessThan
    ? withOpenDotaKey(`https://api.opendota.com/api/proMatches?less_than_match_id=${lessThan}`)
    : withOpenDotaKey('https://api.opendota.com/api/proMatches');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`OpenDota: HTTP ${resp.status}`);
  return (await resp.json()) as OpenDotaProMatch[];
}

async function main() {
  const pages = Number(process.argv[2] ?? 20);
  console.log(`[ingest-matches] Pulling ${pages} pages from OpenDota /api/proMatches …`);

  let lessThan: number | undefined;
  let totalInserted = 0;
  let totalSkipped = 0;

  for (let p = 0; p < pages; p++) {
    const matches = await fetchPage(lessThan);
    if (matches.length === 0) {
      console.log('[ingest-matches] No more matches.');
      break;
    }

    // Фильтруем «мусорные» матчи: с отсутствующими team id или нулевой длительностью
    const valid = matches.filter(
      m => m.match_id && m.radiant_team_id && m.dire_team_id && m.duration > 600,
    );

    if (valid.length > 0) {
      const rows = valid.map(m => ({
        matchId: m.match_id,
        startTime: m.start_time,
        duration: m.duration,
        radiantTeamId: m.radiant_team_id,
        direTeamId: m.dire_team_id,
        radiantName: m.radiant_name,
        direName: m.dire_name,
        radiantScore: m.radiant_score,
        direScore: m.dire_score,
        radiantWin: m.radiant_win,
        leagueId: m.leagueid,
        leagueName: m.league_name,
        series_id: m.series_id ?? null,
        series_type: m.series_type,
        firstBloodTime: m.first_blood_time ?? null,
        barracksStatusRadiant: m.barracks_status_radiant ?? null,
        barracksStatusDire: m.barracks_status_dire ?? null,
        towerStatusRadiant: m.tower_status_radiant ?? null,
        towerStatusDire: m.tower_status_dire ?? null,
      }));

      await db.insert(proMatchesTable).values(rows).onConflictDoNothing();
    }

    totalInserted += valid.length;
    totalSkipped += matches.length - valid.length;
    lessThan = matches[matches.length - 1].match_id;
    process.stdout.write(
      `\r[ingest-matches] Page ${p + 1}/${pages} · total ok: ${totalInserted} · skipped: ${totalSkipped}`,
    );

    // Premium OD: 3000 req/min = 50 req/s. Держим 10 req/s — запас под параллельные скрипты.
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n[ingest-matches] Done.');
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest-matches] FATAL', err);
  process.exit(1);
});
