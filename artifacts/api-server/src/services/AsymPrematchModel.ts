/**
 * Asymmetric prematch winner inference (Этап B).
 *
 * Закрывает «слепое пятно» основной v3 модели для матчей где у одной/обеих
 * команд нет 5+ pro-игр за 180d. Тогда основная модель отказывается давать
 * прогноз (см. PredictionModel `rGames<5 || dGames<5`). Asym использует
 * player-level фичи (glicko/wl_pro/pro_exp/roster_known) + hero draft + team
 * pool — то что есть когда team-history тонкая.
 *
 * Контракт фичей — побайтово идентичен `scripts/src/train-asym-prematch.ts`
 * (ASYM_FEATURE_NAMES, dim=22). Любое изменение здесь требует синхронной
 * правки трейнера и retrain (bump PREMATCH_ASYM в feature-view.ts).
 *
 * Routing (caller — PredictionModel.predictMatchWinner):
 *   call → если есть драфт с account_ids И (team A или team B имеет
 *   games_180d<5) → попробуем asym. При null/ошибке — fallback на основную
 *   логику (glicko-synth + main v3).
 *
 * Никаких прямых апстрим-вызовов. Только in-process caches и БД.
 */

import {
  db,
  modelVersionsTable,
  proMatchesTable,
  teamsTable,
  heroStatsTable,
  playerRatingsTable,
  playerWlProTable,
  playerTotalsTable,
  teamExtendedFeaturesTable,
  teamRostersTable,
  teamHeroPoolTable,
} from '@workspace/db';
import { eq, and, gte, or, inArray, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
// F9 (Phase 9): timeout 200 → 1500ms. См. комментарий в `MarketLgbm.ts`.
const ML_PREDICT_TIMEOUT_MS = Number(process.env.ML_PREDICT_TIMEOUT_MS ?? 1500);
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';

const CACHE_TTL_MS = 15 * 60 * 1000;
const GAMES180_TTL_MS = 5 * 60 * 1000;
const CIRCUIT_BACKOFF_MS = 60_000;
const ASYM_PRIOR_DAYS = 180;
const TEAM_GAMES_THRESHOLD = 5;
// Per-cache cap (availability — review #2). При превышении удаляем самые старые
// 20% записей. Map в JS сохраняет insertion order, поэтому первые keys() — самые
// старые. Этого достаточно — точная LRU не нужна, цель — ограничить рост.
const PER_TEAM_CACHE_CAP = 2000;
function evictIfOversize<K, V>(m: Map<K, V>, cap: number): void {
  if (m.size <= cap) return;
  const drop = Math.ceil(cap * 0.2);
  let n = 0;
  for (const k of m.keys()) {
    if (n++ >= drop) break;
    m.delete(k);
  }
}

// Имена и порядок ТОЧНО как в trainer'е — иначе blob инферит на «других» фичах.
export const ASYM_FEATURE_NAMES = [
  'bias',
  'radiant_side_logit', 'recency_days_norm', 'series_type_norm', 'map_no_norm',
  'team_games_180d_R', 'team_games_180d_D',
  'team_rating_diff',
  'player_glicko_avg_diff', 'player_glicko_avg_R', 'player_glicko_avg_D',
  'player_glicko_spread_R', 'player_glicko_spread_D',
  'wl_pro_180d_diff', 'wl_pro_180d_R', 'wl_pro_180d_D',
  'pro_exp_avg_diff',
  'peer_synergy_diff',
  'roster_known_radiant', 'roster_known_dire',
  'team_pool_winrate_diff',
  'hero_draft_strength_diff',
] as const;
export const ASYM_FEATURE_DIM = ASYM_FEATURE_NAMES.length;

// ── Loaded model bundle ────────────────────────────────────────────────────
import {evidenceHash, predictionEvidence, type PredictionEvidence} from '../lib/predictionEvidence';

interface LoadedAsymModel {
  artifactHash: string;
  version: string;
  featuresVersion: number;
  blobB64: string;
  loadedAt: number;
}
let cachedModel: LoadedAsymModel | null = null;

export async function loadActiveAsymPrematchModel(): Promise<LoadedAsymModel | null> {
  try {
    const rows = await db
      .select()
      .from(modelVersionsTable)
      .where(and(
        eq(modelVersionsTable.kind, 'prematch_winner_asym'),
        eq(modelVersionsTable.engine, 'lightgbm'),
        eq(modelVersionsTable.isActive, true),
      ));
    if (rows.length === 0) {
      cachedModel = null;
      logger.info('[AsymPrematch] no active asym model — feature disabled');
      return null;
    }
    // Берём самую свежую (на случай если partial-unique-index не сработал).
    rows.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    const r = rows[0];
    const blob = r.binaryBlob as Buffer | Uint8Array | null;
    if (!blob) {
      cachedModel = null;
      logger.warn({ version: r.version }, '[AsymPrematch] active row has no binary blob');
      return null;
    }
    const loaded: LoadedAsymModel = {
      artifactHash: evidenceHash({blobB64:Buffer.from(blob).toString('base64'),features:ASYM_FEATURE_NAMES}),
      version: r.version,
      featuresVersion: r.featuresVersion ?? 1,
      blobB64: Buffer.isBuffer(blob) ? blob.toString('base64') : Buffer.from(blob).toString('base64'),
      loadedAt: Date.now(),
    };
    cachedModel = loaded;
    logger.info({ version: loaded.version, fv: loaded.featuresVersion }, '[AsymPrematch] active asym model loaded');
    return loaded;
  } catch (err) {
    logger.error({ err }, '[AsymPrematch] failed to load active model');
    return null;
  }
}

export function getActiveAsymPrematchModel(): LoadedAsymModel | null {
  return cachedModel;
}

// ── ml-service client (own circuit breaker — не валим main predict при сбое asym).
let circuitOpenUntil = 0;
let _cachedToken: string | null = null;
function mlServiceToken(): string | null {
  if (_cachedToken) return _cachedToken;
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) { _cachedToken = env; return env; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const v = fs.readFileSync(ML_TOKEN_FILE, 'utf8').trim();
    if (v) { _cachedToken = v; return v; }
  } catch { /* not yet written */ }
  return null;
}
function circuitOpen(): boolean { return Date.now() < circuitOpenUntil; }
function tripCircuit(reason: string): void {
  if (!circuitOpen()) logger.warn({ reason }, '[AsymPrematch] tripping ml-service circuit-breaker');
  circuitOpenUntil = Date.now() + CIRCUIT_BACKOFF_MS;
}

async function callMlPredict(blobB64: string, features: number[]): Promise<number | null> {
  if (circuitOpen()) return null;
  const token = mlServiceToken();
  if (!token) { tripCircuit('no ML_SERVICE_TOKEN'); return null; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ML_PREDICT_TIMEOUT_MS);
  try {
    const res = await fetch(`${ML_SERVICE_URL}/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ml-token': token },
      body: JSON.stringify({ blob_b64: blobB64, features }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      tripCircuit(`ml-service ${res.status}: ${body.slice(0, 120)}`);
      return null;
    }
    const data = (await res.json()) as { task_type?: string; calibrated_prob?: number };
    if (typeof data.calibrated_prob !== 'number') {
      tripCircuit('bad classification payload'); return null;
    }
    return data.calibrated_prob;
  } catch (e) {
    // F9 (Phase 9): timeout НЕ открывает circuit. См. `MarketLgbm.ts`.
    if ((e as Error).name === 'AbortError') {
      logger.debug({ timeoutMs: ML_PREDICT_TIMEOUT_MS }, '[AsymPrematch] /predict timeout (no trip)');
      return null;
    }
    tripCircuit((e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Caches с TTL. Лениво грузятся под запрос (первый predict тёплый ~50ms,
// последующие 15 мин — мгновенно из памяти).
interface AsymCaches {
  loadedAt: number;
  teamRating: Map<number, number>;
  heroWR: Map<number, number>;
  playerGlicko: Map<number, number>;
  wlPro: Map<number, number>;
  proGamesByAcc: Map<number, number>;
  peerByTeam: Map<number, number | null>;
}
let caches: AsymCaches | null = null;

async function refreshCaches(): Promise<AsymCaches> {
  if (caches && Date.now() - caches.loadedAt < CACHE_TTL_MS) return caches;
  const [teamsRows, heroRows, prRows, wlProRows, totalsRows, peerRows] = await Promise.all([
    db.select({ teamId: teamsTable.teamId, rating: teamsTable.rating }).from(teamsTable),
    db.select({ heroId: heroStatsTable.heroId, proWinRate: heroStatsTable.proWinRate }).from(heroStatsTable),
    db.select({ accountId: playerRatingsTable.accountId, rating: playerRatingsTable.rating }).from(playerRatingsTable),
    db.select({ accountId: playerWlProTable.accountId, win: playerWlProTable.win, lose: playerWlProTable.lose }).from(playerWlProTable),
    db.select({ accountId: playerTotalsTable.accountId, n: playerTotalsTable.n })
      .from(playerTotalsTable).where(eq(playerTotalsTable.field, 'kills')),
    db.select({ teamId: teamExtendedFeaturesTable.teamId, peerSynergy: teamExtendedFeaturesTable.peerSynergy })
      .from(teamExtendedFeaturesTable),
  ]);
  const teamRating = new Map<number, number>();
  for (const t of teamsRows) if (t.rating != null) teamRating.set(t.teamId, t.rating);
  const heroWR = new Map<number, number>();
  for (const h of heroRows) heroWR.set(h.heroId, h.proWinRate ?? 0.5);
  const playerGlicko = new Map<number, number>();
  for (const r of prRows) playerGlicko.set(r.accountId, r.rating);
  const wlPro = new Map<number, number>();
  for (const r of wlProRows) {
    const total = (r.win ?? 0) + (r.lose ?? 0);
    if (total >= 5) wlPro.set(r.accountId, (r.win ?? 0) / total);
  }
  const proGamesByAcc = new Map<number, number>();
  for (const r of totalsRows) proGamesByAcc.set(r.accountId, r.n ?? 0);
  const peerByTeam = new Map<number, number | null>();
  for (const r of peerRows) peerByTeam.set(r.teamId, r.peerSynergy);
  caches = { loadedAt: Date.now(), teamRating, heroWR, playerGlicko, wlPro, proGamesByAcc, peerByTeam };
  logger.info({
    teams: teamRating.size, hero: heroWR.size, glicko: playerGlicko.size,
    wlPro: wlPro.size, proGames: proGamesByAcc.size, peer: peerByTeam.size,
  }, '[AsymPrematch] caches refreshed');
  return caches;
}

// Per-team games_180d cache. Per-pair lookup батчится одним SQL.
const games180Cache = new Map<number, { v: number; ts: number }>();
export async function getTeamGames180d(teamIds: number[]): Promise<Map<number, number>> {
  const now = Date.now();
  const out = new Map<number, number>();
  const missing: number[] = [];
  for (const id of teamIds) {
    const hit = games180Cache.get(id);
    if (hit && now - hit.ts < GAMES180_TTL_MS) out.set(id, hit.v);
    else missing.push(id);
  }
  if (missing.length === 0) return out;
  try {
    const cutoff = Math.floor(now / 1000) - ASYM_PRIOR_DAYS * 86_400;
    // Per-team COUNT — review fix #1. Прежний CASE-GROUP BY роняла сторону
    // dire когда обе команды пары были в `missing` (radiant вин — count++,
    // dire вин — drop). Per-team count корректен для любого N (для N=2 это
    // 2 SQL'я внутри одного round-trip, 5-минутный кеш снимает нагрузку).
    const cutoffSec = cutoff;
    const counts = await Promise.all(
      missing.map(id =>
        db
          .select({ cnt: sql<number>`count(*)::int` })
          .from(proMatchesTable)
          .where(and(
            gte(proMatchesTable.startTime, cutoffSec),
            or(
              eq(proMatchesTable.radiantTeamId, id),
              eq(proMatchesTable.direTeamId, id),
            ),
          ))
          .then(rows => Number(rows[0]?.cnt ?? 0))
          .catch((err: unknown) => {
            logger.error({ err, teamId: id }, '[AsymPrematch] games_180d per-team count failed');
            return 0;
          }),
      ),
    );
    for (let i = 0; i < missing.length; i++) {
      const id = missing[i];
      const v = counts[i];
      games180Cache.set(id, { v, ts: now });
      out.set(id, v);
    }
    evictIfOversize(games180Cache, PER_TEAM_CACHE_CAP);
  } catch (err) {
    logger.error({ err, teamIds: missing }, '[AsymPrematch] failed to fetch games_180d');
    for (const id of missing) out.set(id, 0);
  }
  return out;
}

// ── E1 lookups (rosters / hero pool) — отдельный TTL (30 мин), батч по teamId.
interface RosterPoolEntry {
  rosterIds: Set<number>;
  pool: Map<number, { games: number; wins: number }>;
  loadedAt: number;
}
const rosterPoolCache = new Map<number, RosterPoolEntry>();
const ROSTER_TTL_MS = 30 * 60 * 1000;

async function getRosterPool(teamIds: number[]): Promise<Map<number, RosterPoolEntry>> {
  const now = Date.now();
  const out = new Map<number, RosterPoolEntry>();
  const missing: number[] = [];
  for (const id of teamIds) {
    const hit = rosterPoolCache.get(id);
    if (hit && now - hit.loadedAt < ROSTER_TTL_MS) out.set(id, hit);
    else missing.push(id);
  }
  if (missing.length === 0) return out;
  try {
    const [rosterRows, poolRows] = await Promise.all([
      db.select({ teamId: teamRostersTable.teamId, accountId: teamRostersTable.accountId })
        .from(teamRostersTable).where(inArray(teamRostersTable.teamId, missing)),
      db.select({
        teamId: teamHeroPoolTable.teamId, heroId: teamHeroPoolTable.heroId,
        games: teamHeroPoolTable.gamesPlayed, wins: teamHeroPoolTable.wins,
      }).from(teamHeroPoolTable).where(inArray(teamHeroPoolTable.teamId, missing)),
    ]);
    const built = new Map<number, RosterPoolEntry>();
    for (const id of missing) built.set(id, { rosterIds: new Set(), pool: new Map(), loadedAt: now });
    for (const r of rosterRows) built.get(r.teamId)?.rosterIds.add(r.accountId);
    for (const r of poolRows) built.get(r.teamId)?.pool.set(r.heroId, { games: r.games ?? 0, wins: r.wins ?? 0 });
    for (const [id, entry] of built) {
      rosterPoolCache.set(id, entry);
      out.set(id, entry);
    }
    evictIfOversize(rosterPoolCache, PER_TEAM_CACHE_CAP);
  } catch (err) {
    logger.error({ err, teamIds: missing }, '[AsymPrematch] failed to fetch roster/pool');
    for (const id of missing) out.set(id, { rosterIds: new Set(), pool: new Map(), loadedAt: now });
  }
  return out;
}

// ── Global radiant-side logit (обновляется раз в час). Тренируется на тех же
// матчах что main v3 — используем последние 365d из pro_matches.
let radiantLogit = Math.log(0.52 / 0.48); // safety baseline
let radiantLogitLoadedAt = 0;
const RADIANT_LOGIT_TTL_MS = 60 * 60 * 1000;
async function refreshRadiantLogit(): Promise<number> {
  if (Date.now() - radiantLogitLoadedAt < RADIANT_LOGIT_TTL_MS) return radiantLogit;
  try {
    const cutoff = Math.floor(Date.now() / 1000) - 365 * 86_400;
    const rows = await db
      .select({
        total: sql<number>`count(*) filter (where ${proMatchesTable.radiantWin} is not null)::int`,
        radWins: sql<number>`count(*) filter (where ${proMatchesTable.radiantWin})::int`,
      })
      .from(proMatchesTable)
      .where(gte(proMatchesTable.startTime, cutoff));
    const row = rows[0];
    if (row && row.total > 0) {
      const wr = Math.min(Math.max(row.radWins / row.total, 1e-4), 1 - 1e-4);
      radiantLogit = Math.log(wr / (1 - wr));
    }
    radiantLogitLoadedAt = Date.now();
  } catch (err) {
    logger.warn({ err }, '[AsymPrematch] failed to refresh radiantSideLogit');
  }
  return radiantLogit;
}

// ── Helpers.
function avg(values: number[]): number {
  if (values.length === 0) return 0;
  let s = 0; for (const v of values) s += v; return s / values.length;
}
function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = avg(values);
  let ss = 0; for (const v of values) ss += (v - m) * (v - m);
  return Math.sqrt(ss / values.length);
}
function poolWeightedWR(picks: number[], pool: Map<number, { games: number; wins: number }>): number {
  if (pool.size === 0 || picks.length === 0) return 0.5;
  let wSum = 0, wWinSum = 0;
  for (const h of picks) {
    const e = pool.get(h);
    if (!e || e.games <= 0) continue;
    const w = Math.log(e.games + 1);
    wSum += w; wWinSum += (e.wins / e.games) * w;
  }
  return wSum > 0 ? wWinSum / wSum : 0.5;
}

// ── Eligibility gate + builder + predict.
export interface AsymInputs {
  radiantTeamId: number;
  direTeamId: number;
  radiantPicks: number[];
  direPicks: number[];
  radiantAccountIds: number[] | null;
  direAccountIds: number[] | null;
  seriesType?: number | null;
  mapNo?: number | null;
  startTime?: number | null;
}
export interface AsymResult {
  evidence: PredictionEvidence;
  probRadiantWin: number;
  rawProb: number;
  modelVersion: string;
  featuresVersion: number;
  features: Record<string, number>;
  /** Сколько игр за 180d у каждой стороны (для логирования). */
  games180d: { r: number; d: number };
}

/**
 * Должны ли мы предпочесть asym модель: хотя бы одна сторона имеет
 * games_180d<5 И передан хоть один из account_ids драфта.
 *
 * Eligibility — это data-driven свойство матча (games_180d + наличие
 * account_ids); НЕ зависит от того, какие asym-модели сейчас загружены.
 * Это важно, потому что Этап C (asym-live) вызывает тот же helper — его
 * работа не должна гаситься отсутствием asym-prematch модели.
 */
export async function isAsymEligible(
  radiantTeamId: number,
  direTeamId: number,
  radiantAccountIds: number[] | null | undefined,
  direAccountIds: number[] | null | undefined,
): Promise<boolean> {
  if (!radiantAccountIds && !direAccountIds) return false;
  const g = await getTeamGames180d([radiantTeamId, direTeamId]);
  const r = g.get(radiantTeamId) ?? 0;
  const d = g.get(direTeamId) ?? 0;
  return r < TEAM_GAMES_THRESHOLD || d < TEAM_GAMES_THRESHOLD;
}

export async function predictAsymPrematch(inp: AsymInputs): Promise<AsymResult | null> {
  if (!cachedModel) return null;
  if (!inp.radiantAccountIds && !inp.direAccountIds) return null;
  if (inp.radiantPicks.length !== 5 || inp.direPicks.length !== 5) return null;

  const [c, gMap, rosterMap, sideLogit] = await Promise.all([
    refreshCaches(),
    getTeamGames180d([inp.radiantTeamId, inp.direTeamId]),
    getRosterPool([inp.radiantTeamId, inp.direTeamId]),
    refreshRadiantLogit(),
  ]);

  const gR = gMap.get(inp.radiantTeamId) ?? 0;
  const gD = gMap.get(inp.direTeamId) ?? 0;

  const rAcc = inp.radiantAccountIds ?? [];
  const dAcc = inp.direAccountIds ?? [];

  const rGlickos: number[] = []; const dGlickos: number[] = [];
  for (const a of rAcc) if (a > 0) rGlickos.push(c.playerGlicko.get(a) ?? 1500);
  for (const a of dAcc) if (a > 0) dGlickos.push(c.playerGlicko.get(a) ?? 1500);
  const rGAvg = avg(rGlickos.length ? rGlickos : [1500]);
  const dGAvg = avg(dGlickos.length ? dGlickos : [1500]);
  const rGStd = std(rGlickos);
  const dGStd = std(dGlickos);

  const rWlVals: number[] = []; const dWlVals: number[] = [];
  for (const a of rAcc) { const v = c.wlPro.get(a); if (v != null) rWlVals.push(v); }
  for (const a of dAcc) { const v = c.wlPro.get(a); if (v != null) dWlVals.push(v); }
  const rWl = rWlVals.length ? avg(rWlVals) : 0.5;
  const dWl = dWlVals.length ? avg(dWlVals) : 0.5;

  const rExp: number[] = []; const dExp: number[] = [];
  for (const a of rAcc) rExp.push(c.proGamesByAcc.get(a) ?? 0);
  for (const a of dAcc) dExp.push(c.proGamesByAcc.get(a) ?? 0);
  const rExpAvg = rExp.length ? avg(rExp) : 0;
  const dExpAvg = dExp.length ? avg(dExp) : 0;

  const rRating = c.teamRating.get(inp.radiantTeamId);
  const dRating = c.teamRating.get(inp.direTeamId);
  const teamRatingDiff = (rRating != null && dRating != null) ? (rRating - dRating) / 200 : 0;

  const rPeer = c.peerByTeam.get(inp.radiantTeamId);
  const dPeer = c.peerByTeam.get(inp.direTeamId);
  const peerDiff = (rPeer ?? 0) - (dPeer ?? 0);

  const rRoster = rosterMap.get(inp.radiantTeamId);
  const dRoster = rosterMap.get(inp.direTeamId);
  const rosterKnownR = rRoster && rAcc.length > 0
    ? rAcc.filter(a => a > 0 && rRoster.rosterIds.has(a)).length / rAcc.length
    : 0;
  const rosterKnownD = dRoster && dAcc.length > 0
    ? dAcc.filter(a => a > 0 && dRoster.rosterIds.has(a)).length / dAcc.length
    : 0;
  const poolWrR = poolWeightedWR(inp.radiantPicks, rRoster?.pool ?? new Map());
  const poolWrD = poolWeightedWR(inp.direPicks, dRoster?.pool ?? new Map());

  const draftStrR = inp.radiantPicks.reduce((s, h) => s + (c.heroWR.get(h) ?? 0.5), 0);
  const draftStrD = inp.direPicks.reduce((s, h) => s + (c.heroWR.get(h) ?? 0.5), 0);

  const now = Math.floor(Date.now() / 1000);
  const startTime = inp.startTime ?? now;
  const recencyDaysNorm = (startTime - now) / (365 * 86400);
  const seriesType = inp.seriesType ?? null;
  const seriesTypeNorm = seriesType === 0 ? 0.0 : seriesType === 2 ? 1.0 : 0.5;
  const mapNo = inp.mapNo ?? 1;
  const mapNoNorm = Math.min(Math.max(mapNo - 1, 0), 4) / 4;

  const feats: number[] = [
    1,
    sideLogit, recencyDaysNorm, seriesTypeNorm, mapNoNorm,
    Math.log(gR + 1), Math.log(gD + 1),
    teamRatingDiff,
    (rGAvg - dGAvg) / 200, (rGAvg - 1500) / 200, (dGAvg - 1500) / 200,
    rGStd / 200, dGStd / 200,
    rWl - dWl, rWl - 0.5, dWl - 0.5,
    Math.log1p(rExpAvg) - Math.log1p(dExpAvg),
    peerDiff,
    rosterKnownR, rosterKnownD,
    poolWrR - poolWrD,
    draftStrR - draftStrD,
  ];
  if (feats.length !== ASYM_FEATURE_DIM) {
    logger.error({ built: feats.length, expected: ASYM_FEATURE_DIM }, '[AsymPrematch] feature dim mismatch');
    return null;
  }

  const inferenceModel = cachedModel;
  const prob = await callMlPredict(inferenceModel.blobB64, feats);
  if (prob == null) return null;

  const features: Record<string, number> = {};
  for (let i = 0; i < ASYM_FEATURE_NAMES.length; i++) features[ASYM_FEATURE_NAMES[i]] = feats[i];

  return {
    probRadiantWin: prob,
    evidence: predictionEvidence(inferenceModel.artifactHash, [...ASYM_FEATURE_NAMES], feats),
    rawProb: prob,  // изотоника внутри bundle
    modelVersion: inferenceModel.version,
    featuresVersion: inferenceModel.featuresVersion,
    features,
    games180d: { r: gR, d: gD },
  };
}

/** Diagnostics для admin /models. */
export function getActiveAsymInfo(): { version: string; featuresVersion: number; loadedAt: number } | null {
  if (!cachedModel) return null;
  return {
    version: cachedModel.version,
    featuresVersion: cachedModel.featuresVersion,
    loadedAt: cachedModel.loadedAt,
  };
}
