/**
 * Wave 3: per-player Glicko-1 ratings из pro_matches × match_drafts.
 *
 * Алгоритм:
 *   1. Загружаем все матчи с обоими radiant_account_ids и dire_account_ids
 *      длины 5, сортируем по start_time asc.
 *   2. Для каждого матча:
 *      - Применяем RD time decay: RD = min(sqrt(RD² + c²·Δperiods), 350),
 *        c=63, period=30d (Glickman default).
 *      - Сохраняем pre-update ratings всех 10 игроков.
 *      - Для каждого radiant игрока — Glicko-1 multi-opponent batch update
 *        против 5 dire (s = radiant_win), и наоборот.
 *      - Обновляем rating, RD, games, wins, lastMatchTime, lastMatchId.
 *   3. Bulk-upsert в player_ratings (chunked).
 *
 * Поведение per-match-batch (а не per-day): pro Dota играет ~5-15 матчей в день,
 * шаг достаточно мелкий чтобы Glicko-1 не давал артефактов. Day-batching можно
 * добавить позже если volatility станет проблемой.
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run compute:player-glicko
 *   pnpm --filter @workspace/scripts run compute:player-glicko --reset
 */

import { db, proMatchesTable, matchDraftsTable, playerRatingsTable } from '@workspace/db';
import { asc, isNotNull, and, sql } from 'drizzle-orm';

// ── Glicko-1 константы ───────────────────────────────────────────────────
const Q = Math.log(10) / 400;          // ≈ 0.00575646273
const PI_SQ = Math.PI * Math.PI;
const DEFAULT_RATING = 1500;
const DEFAULT_RD = 350;
const MAX_RD = 350;
const C = 63;                          // RD inflation per rating period
const RATING_PERIOD_SEC = 30 * 24 * 60 * 60;  // 30 days

interface PlayerState {
  rating: number;
  rd: number;
  games: number;
  wins: number;
  lastMatchTime: number | null;
  lastMatchId: number | null;
  dirty: boolean;
}

function newPlayer(): PlayerState {
  return {
    rating: DEFAULT_RATING,
    rd: DEFAULT_RD,
    games: 0,
    wins: 0,
    lastMatchTime: null,
    lastMatchId: null,
    dirty: false,
  };
}

function decayRD(rd: number, lastTime: number | null, nowTime: number): number {
  if (lastTime == null || nowTime <= lastTime) return Math.min(rd, MAX_RD);
  const periods = (nowTime - lastTime) / RATING_PERIOD_SEC;
  const next = Math.sqrt(rd * rd + C * C * periods);
  return Math.min(next, MAX_RD);
}

function gFn(rd: number): number {
  return 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / PI_SQ);
}

interface OpponentSnapshot { rating: number; rd: number; result: number; }

function glickoUpdate(p: PlayerState, opponents: OpponentSnapshot[]): { rating: number; rd: number } {
  let invDsq = 0;
  let scoreSum = 0;
  for (const o of opponents) {
    const g = gFn(o.rd);
    const expDelta = (-g * (p.rating - o.rating)) / 400;
    const E = 1 / (1 + Math.pow(10, expDelta));
    invDsq += g * g * E * (1 - E);
    scoreSum += g * (o.result - E);
  }
  invDsq *= Q * Q;
  const invRDsq = 1 / (p.rd * p.rd);
  const newRD = Math.sqrt(1 / (invRDsq + invDsq));
  const newRating = p.rating + Q / (invRDsq + invDsq) * scoreSum;
  return { rating: newRating, rd: newRD };
}

function isValidAccountIds(arr: number[] | null | undefined): arr is number[] {
  if (!arr || arr.length !== 5) return false;
  for (const a of arr) if (!a || a <= 0) return false;
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');

  console.log('[compute-player-glicko] Loading matches with full account_ids …');
  const rows = await db.select({
    matchId: proMatchesTable.matchId,
    startTime: proMatchesTable.startTime,
    radiantWin: proMatchesTable.radiantWin,
    radiantAccountIds: matchDraftsTable.radiantAccountIds,
    direAccountIds: matchDraftsTable.direAccountIds,
  })
    .from(proMatchesTable)
    .innerJoin(matchDraftsTable, sql`${matchDraftsTable.matchId} = ${proMatchesTable.matchId}`)
    .where(and(
      isNotNull(matchDraftsTable.radiantAccountIds),
      isNotNull(matchDraftsTable.direAccountIds),
    ))
    .orderBy(asc(proMatchesTable.startTime));

  console.log(`[compute-player-glicko] candidate matches=${rows.length}`);

  // Загружаем существующие рейтинги (если не --reset).
  const players = new Map<number, PlayerState>();
  if (!reset) {
    const existing = await db.select().from(playerRatingsTable);
    for (const e of existing) {
      players.set(e.accountId, {
        rating: e.rating,
        rd: e.rd,
        games: e.games,
        wins: e.wins,
        lastMatchTime: e.lastMatchTime,
        lastMatchId: e.lastMatchId,
        dirty: false,
      });
    }
    console.log(`[compute-player-glicko] preloaded ${players.size} existing player ratings`);
  } else {
    console.log('[compute-player-glicko] --reset: truncating player_ratings …');
    await db.execute(sql`TRUNCATE TABLE player_ratings`);
  }

  let processed = 0;
  let skippedAlreadySeen = 0;
  let skippedBadIds = 0;
  let lastProcessedMatchId: number | null = null;

  for (const m of rows) {
    if (!isValidAccountIds(m.radiantAccountIds) || !isValidAccountIds(m.direAccountIds)) {
      skippedBadIds++;
      continue;
    }

    const radIds = m.radiantAccountIds;
    const direIds = m.direAccountIds;
    const allIds = [...radIds, ...direIds];
    const radWin = m.radiantWin ? 1 : 0;
    const dirWin = 1 - radWin;
    const t = m.startTime;
    const mid = m.matchId;

    // Идемпотентность: если хотя бы у одного игрока этот матч уже последний — скип.
    // (Простая эвристика; полностью корректно — иметь отдельный processed_matches set.)
    let alreadySeen = false;
    for (const a of allIds) {
      const p = players.get(a);
      if (p && p.lastMatchId === mid) { alreadySeen = true; break; }
      if (p && p.lastMatchTime != null && p.lastMatchTime > t) {
        // Уже есть более поздний матч у этого игрока — нужно пропустить, иначе
        // нарушим хронологию. На практике такое может случиться при бэкфилле.
        alreadySeen = true; break;
      }
    }
    if (alreadySeen) { skippedAlreadySeen++; continue; }

    // Pre-decay: применяем RD-инфляцию для всех 10 ДО снимка.
    const preStates = new Map<number, PlayerState>();
    for (const a of allIds) {
      const p = players.get(a) ?? newPlayer();
      p.rd = decayRD(p.rd, p.lastMatchTime, t);
      preStates.set(a, { ...p });   // снимок (used as opponent)
      players.set(a, p);
    }

    // Snapshots для оппонентов.
    const radSnap: OpponentSnapshot[] = direIds.map(a => ({
      rating: preStates.get(a)!.rating,
      rd: preStates.get(a)!.rd,
      result: radWin,
    }));
    const direSnap: OpponentSnapshot[] = radIds.map(a => ({
      rating: preStates.get(a)!.rating,
      rd: preStates.get(a)!.rd,
      result: dirWin,
    }));

    // Update radiant players
    for (const a of radIds) {
      const p = players.get(a)!;
      const upd = glickoUpdate(preStates.get(a)!, radSnap);
      p.rating = upd.rating;
      p.rd = upd.rd;
      p.games += 1;
      p.wins += radWin;
      p.lastMatchTime = t;
      p.lastMatchId = mid;
      p.dirty = true;
    }
    // Update dire players
    for (const a of direIds) {
      const p = players.get(a)!;
      const upd = glickoUpdate(preStates.get(a)!, direSnap);
      p.rating = upd.rating;
      p.rd = upd.rd;
      p.games += 1;
      p.wins += dirWin;
      p.lastMatchTime = t;
      p.lastMatchId = mid;
      p.dirty = true;
    }

    processed++;
    lastProcessedMatchId = mid;
    if (processed % 500 === 0) {
      console.log(`  … processed ${processed} matches (last match_id=${mid}, players=${players.size})`);
    }
  }

  console.log(
    `[compute-player-glicko] processed=${processed} skippedAlreadySeen=${skippedAlreadySeen} ` +
    `skippedBadIds=${skippedBadIds} totalPlayers=${players.size} lastMatchId=${lastProcessedMatchId}`,
  );

  // Bulk-upsert dirty players.
  const dirty = [...players.entries()].filter(([, p]) => p.dirty);
  console.log(`[compute-player-glicko] upserting ${dirty.length} dirty players …`);
  const CHUNK = 500;
  for (let i = 0; i < dirty.length; i += CHUNK) {
    const chunk = dirty.slice(i, i + CHUNK).map(([accountId, p]) => ({
      accountId,
      rating: p.rating,
      rd: p.rd,
      games: p.games,
      wins: p.wins,
      lastMatchTime: p.lastMatchTime,
      lastMatchId: p.lastMatchId,
    }));
    await db.insert(playerRatingsTable).values(chunk).onConflictDoUpdate({
      target: playerRatingsTable.accountId,
      set: {
        rating: sql`excluded.rating`,
        rd: sql`excluded.rd`,
        games: sql`excluded.games`,
        wins: sql`excluded.wins`,
        lastMatchTime: sql`excluded.last_match_time`,
        lastMatchId: sql`excluded.last_match_id`,
        updatedAt: sql`now()`,
      },
    });
    if ((i / CHUNK) % 10 === 0) console.log(`  … upserted ${Math.min(i + CHUNK, dirty.length)}/${dirty.length}`);
  }

  // Quick sanity stats.
  const stats = await db.execute(sql`
    SELECT
      count(*)::int AS total,
      avg(rating)::float AS avg_rating,
      min(rating)::float AS min_rating,
      max(rating)::float AS max_rating,
      avg(rd)::float AS avg_rd,
      count(*) FILTER (WHERE rd < 100)::int AS rd_lt_100,
      count(*) FILTER (WHERE games >= 20)::int AS games_ge_20
    FROM player_ratings
  `);
  console.log('[compute-player-glicko] stats:', stats.rows[0]);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
