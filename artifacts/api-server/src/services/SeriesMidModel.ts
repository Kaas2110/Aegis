/**
 * T003 (Layer B) — runtime inference mid-series модели (kind='series_mid').
 *
 * Модель обучена в scripts/src/train-series-model.ts (LightGBM через
 * ml-service). Предсказывает P(team A берёт СЕРИЮ | серия идёт, счёт sA:sB).
 *
 * Контракт фичей (12) — синхронизирован с тренером:
 *   [bias, rating_diff_norm, winrate_diff, need_a, need_b,
 *    prev_won_by_a, prev_duration_norm, prev_kill_diff_norm,
 *    drop_rate_a, drop_rate_b, pick_strangeness_a, pick_strangeness_b]
 *
 * Требует данные предыдущей карты серии: ищем в pro_matches самый свежий
 * матч этих двух команд за последние 24h. Если prev-карта не найдена (ingest
 * ещё не догнал) — возвращаем null → caller остаётся на Layer A (аналитика).
 *
 * Drop-rate команд считается из bo3_series (сглаживание как в тренере),
 * кэш 15 минут. Странность пика — match_drafts × player_hero_stats.
 */

import {
  db, modelVersionsTable, teamsTable, proMatchesTable, bo3SeriesTable,
  matchDraftsTable, playerHeroStatsTable,
} from '@workspace/db';
import { eq, and, or, desc, gte, inArray } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { logger } from '../lib/logger';

const KIND = 'series_mid';
const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';
const PREDICT_TIMEOUT_MS = Number(process.env.ML_PREDICT_TIMEOUT_MS ?? 1500);
const DROP_CACHE_TTL_MS = 15 * 60 * 1000;
const DROP_SMOOTH_K = 5;
const PREV_MAP_WINDOW_SEC = 24 * 3600;

let model: { blobB64: string; version: string } | null = null;

let dropRates = new Map<number, { opps: number; drops: number }>();
let globalDropRate = 0.44;
let dropLoadedAt = 0;

function mlServiceToken(): string | null {
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) return env;
  try { return readFileSync(ML_TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
}

export async function loadActiveSeriesMidModel(): Promise<boolean> {
  try {
    const rows = await db.select()
      .from(modelVersionsTable)
      .where(and(
        eq(modelVersionsTable.kind, KIND),
        eq(modelVersionsTable.engine, 'lightgbm'),
        eq(modelVersionsTable.isActive, true),
      ))
      .limit(1);
    if (rows.length === 0 || !rows[0].binaryBlob) {
      model = null;
      logger.info('[SeriesMid] no active series_mid model — Layer A only');
      return false;
    }
    const blob = rows[0].binaryBlob as Buffer | Uint8Array;
    model = {
      blobB64: Buffer.isBuffer(blob) ? blob.toString('base64') : Buffer.from(blob).toString('base64'),
      version: rows[0].version,
    };
    const meta = (rows[0].metadata ?? {}) as Record<string, unknown>;
    if (typeof meta['globalDropRate'] === 'number') globalDropRate = meta['globalDropRate'];
    logger.info({ version: model.version }, '[SeriesMid] active model loaded');
    return true;
  } catch (err) {
    logger.error({ err }, '[SeriesMid] load failed');
    model = null;
    return false;
  }
}

export function isSeriesMidModelActive(): boolean {
  return model != null;
}

interface MapEntry {
  matchId: number; mapNumber: number; finished: boolean;
  winnerSide: 'radiant' | 'dire'; radiantTeamId: number; direTeamId: number;
}

async function refreshDropRates(): Promise<void> {
  if (Date.now() - dropLoadedAt < DROP_CACHE_TTL_MS && dropRates.size > 0) return;
  try {
    const rows = await db.select({ maps: bo3SeriesTable.maps })
      .from(bo3SeriesTable)
      .where(eq(bo3SeriesTable.finished, true));
    const next = new Map<number, { opps: number; drops: number }>();
    let gOpps = 0; let gDrops = 0;
    for (const r of rows) {
      const maps = ((r.maps as MapEntry[]) ?? [])
        .filter(m => m.finished && m.radiantTeamId && m.direTeamId)
        .sort((a, b) => a.mapNumber - b.mapNumber);
      for (let i = 0; i + 1 < maps.length; i++) {
        const w = maps[i].winnerSide === 'radiant' ? maps[i].radiantTeamId : maps[i].direTeamId;
        const nw = maps[i + 1].winnerSide === 'radiant' ? maps[i + 1].radiantTeamId : maps[i + 1].direTeamId;
        const dropped = nw !== w ? 1 : 0;
        const e = next.get(w) ?? { opps: 0, drops: 0 };
        e.opps += 1; e.drops += dropped; next.set(w, e);
        gOpps += 1; gDrops += dropped;
      }
    }
    dropRates = next;
    if (gOpps > 0) globalDropRate = gDrops / gOpps;
    dropLoadedAt = Date.now();
  } catch (err) {
    logger.warn({ err }, '[SeriesMid] drop-rate refresh failed');
  }
}

function dropRateFor(teamId: number): number {
  const e = dropRates.get(teamId) ?? { opps: 0, drops: 0 };
  return (e.drops + DROP_SMOOTH_K * globalDropRate) / (e.opps + DROP_SMOOTH_K);
}

async function strangenessFor(
  picks: number[], accs: number[] | null,
): Promise<number | null> {
  if (!accs || accs.length === 0 || picks.length === 0) return null;
  try {
    const rows = await db.select({
      accountId: playerHeroStatsTable.accountId,
      heroId: playerHeroStatsTable.heroId,
      games: playerHeroStatsTable.games,
    }).from(playerHeroStatsTable)
      .where(and(
        inArray(playerHeroStatsTable.accountId, accs),
        inArray(playerHeroStatsTable.heroId, picks),
      ));
    const byHero = new Map<number, number>(); // hero → max games среди аккаунтов
    for (const r of rows) {
      byHero.set(r.heroId, Math.max(byHero.get(r.heroId) ?? 0, r.games));
    }
    const vals = picks.map(h => 1 - Math.min(1, (byHero.get(h) ?? 0) / 20));
    return vals.reduce((x, y) => x + y, 0) / vals.length;
  } catch {
    return null;
  }
}

export interface SeriesMidResult {
  probTeamAWinsSeries: number;
  modelVersion: string;
  prevMapMatchId: number;
}

/**
 * P(team A берёт серию) mid-series. teamA/teamB — в нотации caller'а
 * (radiant/dire текущей карты не важны — нотация серии).
 * Возвращает null если модель неактивна / нет prev-карты / нет рейтингов.
 */
export async function predictSeriesMid(
  teamAId: number,
  teamBId: number,
  format: 'BO1' | 'BO2' | 'BO3' | 'BO5',
  scoreA: number,
  scoreB: number,
): Promise<SeriesMidResult | null> {
  if (!model) return null;
  if (format === 'BO1') return null;
  if (scoreA === 0 && scoreB === 0) return null; // серия не началась — Layer A/прематч

  const need = format === 'BO5' ? 3 : 2;
  if (scoreA >= need || scoreB >= need) return null; // серия решена

  // Рейтинги команд
  const teams = await db.select({
    teamId: teamsTable.teamId, rating: teamsTable.rating,
    wins: teamsTable.wins, losses: teamsTable.losses,
  }).from(teamsTable)
    .where(inArray(teamsTable.teamId, [teamAId, teamBId]));
  const tA = teams.find(t => Number(t.teamId) === teamAId);
  const tB = teams.find(t => Number(t.teamId) === teamBId);
  if (!tA?.rating || !tB?.rating) return null;
  const gA = (tA.wins ?? 0) + (tA.losses ?? 0);
  const gB = (tB.wins ?? 0) + (tB.losses ?? 0);
  if (gA < 5 || gB < 5) return null;

  // Предыдущая карта серии: свежайший завершённый матч этой пары за 24h
  const sinceTs = Math.floor(Date.now() / 1000) - PREV_MAP_WINDOW_SEC;
  const prevRows = await db.select({
    matchId: proMatchesTable.matchId,
    duration: proMatchesTable.duration,
    rScore: proMatchesTable.radiantScore,
    dScore: proMatchesTable.direScore,
    radiantWin: proMatchesTable.radiantWin,
    radiantTeamId: proMatchesTable.radiantTeamId,
  }).from(proMatchesTable)
    .where(and(
      gte(proMatchesTable.startTime, sinceTs),
      or(
        and(eq(proMatchesTable.radiantTeamId, teamAId), eq(proMatchesTable.direTeamId, teamBId)),
        and(eq(proMatchesTable.radiantTeamId, teamBId), eq(proMatchesTable.direTeamId, teamAId)),
      ),
    ))
    .orderBy(desc(proMatchesTable.startTime))
    .limit(1);
  if (prevRows.length === 0) return null;
  const prev = prevRows[0];
  const aWasRadiant = Number(prev.radiantTeamId) === teamAId;
  const prevWonByA = prev.radiantWin === aWasRadiant ? 1 : 0;
  const killsA = aWasRadiant ? (prev.rScore ?? 0) : (prev.dScore ?? 0);
  const killsB = aWasRadiant ? (prev.dScore ?? 0) : (prev.rScore ?? 0);

  await refreshDropRates();

  // Странность пика prev-карты
  let strA: number | null = null;
  let strB: number | null = null;
  try {
    const d = await db.select({
      rPicks: matchDraftsTable.radiantPicks,
      dPicks: matchDraftsTable.direPicks,
      rAcc: matchDraftsTable.radiantAccountIds,
      dAcc: matchDraftsTable.direAccountIds,
    }).from(matchDraftsTable)
      .where(eq(matchDraftsTable.matchId, Number(prev.matchId)))
      .limit(1);
    if (d.length > 0 && Array.isArray(d[0].rPicks) && Array.isArray(d[0].dPicks)) {
      const rAcc = Array.isArray(d[0].rAcc) ? d[0].rAcc as number[] : null;
      const dAcc = Array.isArray(d[0].dAcc) ? d[0].dAcc as number[] : null;
      const [sR, sD] = await Promise.all([
        strangenessFor(d[0].rPicks as number[], rAcc),
        strangenessFor(d[0].dPicks as number[], dAcc),
      ]);
      strA = aWasRadiant ? sR : sD;
      strB = aWasRadiant ? sD : sR;
    }
  } catch { /* нейтральные 0.5 ниже */ }

  const features = [
    1,
    (tA.rating - tB.rating) / 200,
    (tA.wins ?? 0) / gA - (tB.wins ?? 0) / gB,
    need - scoreA,
    need - scoreB,
    prevWonByA,
    prev.duration / 2400,
    (killsA - killsB) / 20,
    dropRateFor(teamAId),
    dropRateFor(teamBId),
    strA ?? 0.5,
    strB ?? 0.5,
  ];

  const token = mlServiceToken();
  if (!token) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PREDICT_TIMEOUT_MS);
  try {
    const res = await fetch(`${ML_SERVICE_URL}/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ml-token': token },
      body: JSON.stringify({ blob_b64: model.blobB64, features }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { calibrated_prob?: number };
    if (typeof data.calibrated_prob !== 'number') return null;
    const p = Math.max(0.02, Math.min(0.98, data.calibrated_prob));
    return {
      probTeamAWinsSeries: p,
      modelVersion: model.version,
      prevMapMatchId: Number(prev.matchId),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
