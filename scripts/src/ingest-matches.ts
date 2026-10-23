/**
 * Загружает исторические про-матчи из OpenDota /api/proMatches.
 * Пагинация: less_than_match_id. Каждый запрос отдаёт ~100 строк.
 *
 * Запуск: pnpm --filter @workspace/scripts run ingest:matches [pages=20]
 *   pages=20 → ~2000 матчей.
 */

import { db, proMatchesTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { withOpenDotaKey, odThrottleMs } from './lib/openDotaUrl.js';
import { fetchJsonGet } from './lib/fetchJsonGet.js';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { archiveFetch } from './lib/archive-fetch.js';
import { openDotaBackgroundFetch } from '@workspace/db/opendota';

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
  const url = lessThan
    ? withOpenDotaKey(`https://api.opendota.com/api/proMatches?less_than_match_id=${lessThan}`)
    : withOpenDotaKey('https://api.opendota.com/api/proMatches');
  return fetchJsonGet<OpenDotaProMatch[]>(url, {
    fetchImpl: process.argv.includes('--archive') ? archiveFetch : openDotaBackgroundFetch,
    timeoutMs: 30_000,
    minDelayMs: odThrottleMs(1000),
    onRetry: (attempt, reason, delayMs) => {
      console.warn(`[ingest-matches] ${reason}; retry ${attempt}/2 in ${delayMs}ms`);
    },
  });
}

async function main() {
  const pages = Number(process.argv[2] ?? 20);
  if (!Number.isInteger(pages) || pages < 1 || pages > 100) throw new Error('pages must be 1..100');
  const option = (key: string) => process.argv.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
  const beforeArg = option('--before-match-id');
  const stopArg = option('--stop-after-unix');
  const checkpointArg = option('--checkpoint');
  const positiveInteger = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive safe integer`);
    return n;
  };
  const stopAfter = positiveInteger(stopArg, 'stop-after-unix');
  let lessThan = positiveInteger(beforeArg, 'before-match-id');
  // A named checkpoint is confined to the installation's state directory.
  if (checkpointArg && !/^[a-zA-Z0-9_-]{1,64}$/.test(checkpointArg)) throw new Error('invalid checkpoint name');
  const stateDir = process.env.AEGIS_STATE_DIR;
  if (checkpointArg && !stateDir) throw new Error('AEGIS_STATE_DIR required for checkpoint');
  const checkpointPath = checkpointArg ? path.join(stateDir!, `opendota-backfill-${checkpointArg}.json`) : undefined;
  if (checkpointPath && beforeArg === undefined) {
    let saved: { nextBefore?: string; stopAfter?: number; complete?: boolean } | undefined;
    try { saved = JSON.parse(readFileSync(checkpointPath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid backfill checkpoint'); }
    if (saved) {
      if (saved.stopAfter !== stopAfter) throw new Error('Checkpoint cutoff differs from requested cutoff');
      if (saved.complete) { console.log('[ingest-matches] Checkpoint already complete.'); return; }
      lessThan = positiveInteger(saved.nextBefore, 'checkpoint cursor');
    }
  }
  console.log(`[ingest-matches] Pulling ${pages} pages from OpenDota /api/proMatches …`);

  let totalInserted = 0;
  let totalProcessed = 0;
  let totalSkipped = 0;

  for (let p = 0; p < pages; p++) {
    if (p > 0) await new Promise(r => setTimeout(r, odThrottleMs(100)));
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

      const inserted = await db.insert(proMatchesTable).values(rows).onConflictDoNothing().returning({ matchId: proMatchesTable.matchId });
      totalInserted += inserted.length;
    }

    totalProcessed += valid.length;
    totalSkipped += matches.length - valid.length;
    lessThan = matches[matches.length - 1].match_id;
    const complete = stopAfter !== undefined && Math.min(...matches.map(m => m.start_time)) <= stopAfter;
    if (checkpointPath) {
      mkdirSync(path.dirname(checkpointPath), { recursive: true });
      const tempPath = checkpointPath + '.partial';
      writeFileSync(tempPath, JSON.stringify({ nextBefore: String(lessThan), stopAfter, complete, updatedAt: new Date().toISOString() }, null, 2));
      renameSync(tempPath, checkpointPath);
    }
    process.stdout.write(
      `\r[ingest-matches] Page ${p + 1}/${pages} · processed: ${totalProcessed} · new: ${totalInserted} · skipped: ${totalSkipped}`,
    );
    if (complete) { console.log('\n[ingest-matches] Requested history boundary reached.'); break; }

  }

  console.log('\n[ingest-matches] Done.');
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest-matches] FATAL', err);
  process.exit(1);
});
