/**
 * Загружает peer-winrate для pro-игроков из OpenDota /api/players/{id}/peers.
 *
 * Для каждого аккаунта из match_drafts тянет список пиров — игроков, с которыми
 * чаще всего играл вместе, и их winrate в этих совместных матчах.
 *
 * Данные хранятся в player_peers (account_id, peer_id, games, wins, winrate).
 * Планируется как фича в compute:team-extended: «средний peer-winrate внутри
 * текущего ростера» — усиливает сигнал командной синергии.
 *
 * Freshness: 7 дней — ingest пропускает аккаунты с данными моложе этого порога.
 * Runs as step in run-enrichment-pipeline.sh (E0.3).
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run ingest:od-player-peers
 */

import { db, matchDraftsTable, playerPeersTable } from '@workspace/db';
import { sql, inArray } from 'drizzle-orm';
import { withOpenDotaKey, odThrottleMs } from './lib/openDotaUrl.js';

const FRESHNESS_DAYS = 7;
const DELAY_MS = odThrottleMs(200);
const MIN_GAMES = 5;
const OD_BASE = 'https://api.opendota.com/api';

interface OdPeer {
  account_id: number;
  last_played: number;
  win: number;
  games: number;
  with_win: number;
  with_games: number;
  against_win: number;
  against_games: number;
  winrate?: number;
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchPeers(accountId: number): Promise<OdPeer[]> {
  const url = withOpenDotaKey(`${OD_BASE}/players/${accountId}/peers`);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<OdPeer[]>;
}

async function main() {
  const cutoff = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000);

  // Все уникальные account_id из дraftов (radiant + dire).
  // radiant_account_ids / dire_account_ids — JSONB-массивы, unnest(jsonb) в PG не работает.
  // Используем jsonb_array_elements_text + cast.
  const rawRows = await db.execute<{ account_id: string }>(sql`
    SELECT DISTINCT elem::bigint AS account_id
    FROM match_drafts,
    LATERAL jsonb_array_elements_text(
      COALESCE(${matchDraftsTable.radiantAccountIds}, '[]'::jsonb) ||
      COALESCE(${matchDraftsTable.direAccountIds}, '[]'::jsonb)
    ) AS elem
    WHERE (${matchDraftsTable.radiantAccountIds} IS NOT NULL
        OR ${matchDraftsTable.direAccountIds} IS NOT NULL)
      AND elem ~ '^[0-9]+$'
  `);

  const allIds = [...new Set(
    (rawRows.rows ?? rawRows as unknown as { account_id: string }[])
      .map((r: { account_id: string }) => Number(r.account_id))
      .filter((id: number) => id > 0)
  )];
  console.log(`[od-player-peers] ${allIds.length} distinct account_ids`);

  // Найти свежие аккаунты чтобы пропустить их
  const freshRows = await db
    .selectDistinct({ accountId: playerPeersTable.accountId })
    .from(playerPeersTable)
    .where(sql`${playerPeersTable.fetchedAt} > ${cutoff}`);
  const freshSet = new Set(freshRows.map(r => r.accountId));
  const toFetch = allIds.filter(id => !freshSet.has(id));
  console.log(`[od-player-peers] ${toFetch.length} to fetch, ${freshSet.size} fresh`);

  let saved = 0;
  let failed = 0;
  const now = new Date();

  for (let i = 0; i < toFetch.length; i++) {
    const accountId = toFetch[i]!;
    try {
      const peers = await fetchPeers(accountId);
      const valid = peers.filter(p => p.account_id > 0 && p.with_games >= MIN_GAMES);
      if (valid.length > 0) {
        const insertRows = valid.map(p => ({
          accountId,
          peerId: p.account_id,
          games: p.with_games,
          wins: p.with_win,
          winrate: p.with_games > 0 ? p.with_win / p.with_games : 0,
          fetchedAt: now,
        }));
        await db
          .insert(playerPeersTable)
          .values(insertRows)
          .onConflictDoUpdate({
            target: [playerPeersTable.accountId, playerPeersTable.peerId],
            set: {
              games: sql`excluded.games`,
              wins: sql`excluded.wins`,
              winrate: sql`excluded.winrate`,
              fetchedAt: sql`excluded.fetched_at`,
            },
          });
        saved += insertRows.length;
      }
    } catch (err) {
      failed++;
      console.warn(`[od-player-peers] account=${accountId} FAILED: ${err}`);
    }
    await sleep(DELAY_MS);

    if ((i + 1) % 100 === 0) {
      console.log(`[od-player-peers] ${i + 1}/${toFetch.length} · peerRows=${saved} failed=${failed}`);
    }
  }

  console.log(`[od-player-peers] DONE peerRows=${saved} failed=${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
