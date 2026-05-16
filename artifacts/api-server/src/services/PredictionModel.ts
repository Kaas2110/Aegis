/**
 * Загрузчик и инференс прематч-моделей.
 *
 * Волна 1: тиры (T1/T2/T3 + fallback) + изотоническая калибровка.
 * Волна 2: вторая «версия фичей» v2 = team(5) + hero/draft(7) = 12 фичей.
 *
 * В БД одновременно активны до 8 моделей: 4 кинда × 2 версии фичей.
 *   - prematch_winner (fallback) v1, v2
 *   - prematch_winner_t1/t2/t3 v1, v2
 *
 * На инференсе:
 *   1. Берём рейтинги команд из `teams` (кеш на 15 мин).
 *   2. Классифицируем тир по avg(rating).
 *   3. Если есть драфт + все 10 героев известны (в hero_stats) — пробуем v2.
 *      Иначе — v1.
 *   4. Внутри версии: tier-специфичная > fallback того же featuresVersion.
 *   5. Считаем сырую вероятность через логистическую регрессию.
 *   6. Применяем изотоническую калибровку из `metadata.calibration`.
 *
 * `getActiveModel()` для совместимости со старыми вызовами (model-status route)
 * возвращает v1 fallback — это «лицо» прематч-стека.
 */

import {
  db,
  modelVersionsTable,
  teamsTable,
  heroStatsTable,
  heroMatchupsTable,
  heroSynergyTable,
  playerHeroStatsTable,
  playerRatingsTable,
  teamRecentFormTable,
  teamH2HTable,
  teamExtendedFeaturesTable,
} from '@workspace/db';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { applyCalibration, type CalibrationModel } from '../lib/isotonic';
import { classifyTier, tierKind, ALL_PREMATCH_KINDS, type Tier, type PrematchKind } from '../lib/tier';
import {
  buildHeroFeatures,
  buildExtraFeatures,
  HERO_FEATURE_NAMES,
  EXTRA_FEATURE_NAMES,
  type HeroStatsMap,
  type HeroMatchupsMap,
  type HeroSynergyMap,
  type PlayerHeroStatsMap,
  type PlayerGlickoMap,
  type RecentFormMap,
  type H2HMap,
} from '../lib/hero-features';
import {
  EXTENDED_TEAM_FEATURE_NAMES,
  buildExtendedTeamFeatures,
  type TeamExtendedSnapshot,
} from '../lib/team-extended';

// Wave 6: убрали elo_diff_norm (командный рейтинг OD) → 11 base + 6 extended = 17.
// Сила команды — player_glicko_diff (EXTRA, v3) + form + h2h.
// Имена и порядок ОБЯЗАНЫ совпадать с scripts/src/train-{model,lightgbm}.ts.
const TEAM_FEATURE_NAMES = [
  'bias', 'winrate_diff', 'experience_diff', 'is_high_tier',
  'radiant_side_logit', 'recency_days_norm', 'series_type_norm', 'map_no_norm',
  'tier_t1', 'tier_t2', 'tier_t3',
  ...EXTENDED_TEAM_FEATURE_NAMES,
] as const;
const TEAM_FEATURE_DIM = TEAM_FEATURE_NAMES.length; // 17
/** Inference-time constant: logit(0.52) ≈ radiant historical side advantage in pro matches. */
const RADIANT_SIDE_LOGIT = 0.08;

type Engine = 'logreg' | 'lightgbm';

interface LoadedModel {
  version: string;
  kind: PrematchKind;
  featuresVersion: 1 | 2 | 3;
  tier: Tier | null;
  algorithm: string;
  engine: Engine;
  weights: number[];          // logreg only; lightgbm — пустой массив
  blobB64: string | null;     // lightgbm only — сериализованный bundle (base64)
  featureDim: number;         // источник истины для проверки размерности
  calibration: CalibrationModel | null;
  trainAccuracy: number;
  testAccuracy: number;
  brierScore: number;
  trainSize: number;
  testSize: number;
  loadedAt: Date;
}

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_PREDICT_TIMEOUT_MS = Number(process.env.ML_PREDICT_TIMEOUT_MS ?? 200);
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';

let lightgbmDisabled = false;  // выставляется при долгих сбоях ml-service
let lightgbmDisabledUntil = 0;
const LIGHTGBM_BACKOFF_MS = 60_000;

let _cachedToken: string | null = null;
function mlServiceToken(): string | null {
  if (_cachedToken) return _cachedToken;
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) { _cachedToken = env; return env; }
  // Fallback: dev-режим — ml-service пишет токен в /tmp
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const v = fs.readFileSync(ML_TOKEN_FILE, 'utf8').trim();
    if (v) { _cachedToken = v; return v; }
  } catch { /* file may not exist yet */ }
  return null;
}

function lightgbmAvailable(): boolean {
  if (!lightgbmDisabled) return true;
  if (Date.now() >= lightgbmDisabledUntil) {
    lightgbmDisabled = false;
    return true;
  }
  return false;
}

function tripLightgbm(reason: string): void {
  if (!lightgbmDisabled) {
    logger.warn({ reason, backoffMs: LIGHTGBM_BACKOFF_MS }, '[PredictionModel] tripping lightgbm circuit-breaker');
  }
  lightgbmDisabled = true;
  lightgbmDisabledUntil = Date.now() + LIGHTGBM_BACKOFF_MS;
}

export interface DraftInput {
  radiantPicks: number[];
  direPicks: number[];
  radiantBans: number[];
  direBans: number[];
  radiantAccountIds?: number[] | null;
  direAccountIds?: number[] | null;
}

function modelKey(kind: PrematchKind, fv: 1 | 2 | 3, engine: Engine): string {
  return `${kind}|v${fv}|${engine}`;
}

/** Пытается достать lightgbm-вариант, иначе logreg. */
function getModel(kind: PrematchKind, fv: 1 | 2 | 3): LoadedModel | null {
  const lgbm = cachedModels.get(modelKey(kind, fv, 'lightgbm'));
  if (lgbm && modelUsable(lgbm)) return lgbm;
  const lr = cachedModels.get(modelKey(kind, fv, 'logreg'));
  return lr && modelUsable(lr) ? lr : null;
}

let cachedModels: Map<string, LoadedModel> = new Map();
let lastModelLoad = 0;
let teamRatings: Map<number, { rating: number; wins: number; losses: number }> = new Map();
let lastTeamLoad = 0;
const TEAM_CACHE_TTL_MS = 15 * 60 * 1000;
const HERO_CACHE_TTL_MS = 60 * 60 * 1000;

let heroStatsCache: HeroStatsMap = new Map();
let heroMatchupsCache: HeroMatchupsMap = new Map();
let heroSynergyCache: HeroSynergyMap = new Map();
let lastHeroLoad = 0;

// Wave 3 caches (загружаются лениво при первом v3-запросе).
let playerHeroStatsCache: PlayerHeroStatsMap = new Map();
let recentFormCache: RecentFormMap = new Map();
let h2hCache: H2HMap = new Map();
let playerGlickoCache: PlayerGlickoMap = new Map();
let lastWave3Load = 0;
const WAVE3_CACHE_TTL_MS = 30 * 60 * 1000;

// Wave 5: расширенные team-фичи (snapshot из team_extended_features).
let teamExtendedCache: Map<number, TeamExtendedSnapshot> = new Map();
let lastTeamExtendedLoad = 0;
const TEAM_EXTENDED_CACHE_TTL_MS = 15 * 60 * 1000;

function rowToLoaded(m: typeof modelVersionsTable.$inferSelect): LoadedModel {
  const wRaw = (m.weights ?? {}) as Record<string, number>;
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  const calibrationRaw = meta['calibration'];
  const calibration: CalibrationModel | null =
    calibrationRaw && typeof calibrationRaw === 'object'
      ? (calibrationRaw as CalibrationModel)
      : null;
  const tierRaw = meta['tier'];
  const tier: Tier | null = tierRaw === 't1' || tierRaw === 't2' || tierRaw === 't3' ? tierRaw : null;
  const fv = (m.featuresVersion ?? 1) as 1 | 2 | 3;
  const engine: Engine = m.engine === 'lightgbm' ? 'lightgbm' : 'logreg';

  // logreg: веса в jsonb { w0, w1, ... }
  const keys = Object.keys(wRaw)
    .filter(k => /^w\d+$/.test(k))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const weights = keys.map(k => wRaw[k] ?? 0);

  // lightgbm: blob = bytea, длину фич берём из features jsonb-массива.
  let blobB64: string | null = null;
  if (engine === 'lightgbm') {
    const blob = m.binaryBlob as Buffer | Uint8Array | null;
    if (blob) {
      blobB64 = Buffer.isBuffer(blob)
        ? blob.toString('base64')
        : Buffer.from(blob).toString('base64');
    }
  }
  const featuresArr = Array.isArray(m.features) ? (m.features as unknown[]) : [];
  const featureDim = engine === 'logreg'
    ? weights.length
    : (featuresArr.length || weights.length);

  return {
    version: m.version,
    kind: m.kind as PrematchKind,
    featuresVersion: fv,
    tier,
    algorithm: m.algorithm,
    engine,
    weights,
    blobB64,
    featureDim,
    calibration,
    trainAccuracy: m.trainAccuracy ?? 0,
    testAccuracy: m.testAccuracy ?? 0,
    brierScore: m.brierScore ?? 0,
    trainSize: m.trainSampleSize ?? 0,
    testSize: m.testSampleSize ?? 0,
    loadedAt: new Date(),
  };
}

async function predictViaMlService(blobB64: string, features: number[]): Promise<number | null> {
  if (!lightgbmAvailable()) return null;
  const token = mlServiceToken();
  if (!token) {
    tripLightgbm('no ML_SERVICE_TOKEN');
    return null;
  }
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
      tripLightgbm(`ml-service ${res.status}: ${body.slice(0, 120)}`);
      return null;
    }
    const data = (await res.json()) as { raw_prob: number; calibrated_prob: number };
    if (typeof data.calibrated_prob !== 'number') {
      tripLightgbm('ml-service bad payload');
      return null;
    }
    return data.calibrated_prob;
  } catch (e) {
    const reason = (e as Error).name === 'AbortError'
      ? `timeout ${ML_PREDICT_TIMEOUT_MS}ms`
      : (e as Error).message;
    tripLightgbm(reason);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Загружает все активные прематч-модели одним запросом. Возвращает v1 fallback
 * (или любую первую доступную) для обратной совместимости.
 */
export async function loadActiveModel(): Promise<LoadedModel | null> {
  try {
    const rows = await db
      .select()
      .from(modelVersionsTable)
      .where(
        and(
          inArray(modelVersionsTable.kind, [...ALL_PREMATCH_KINDS]),
          eq(modelVersionsTable.isActive, true),
        ),
      )
      .orderBy(desc(modelVersionsTable.createdAt));

    if (rows.length === 0) {
      logger.warn('[PredictionModel] No active prematch models in DB — predictions disabled');
      cachedModels = new Map();
      return null;
    }

    const next = new Map<string, LoadedModel>();
    for (const r of rows) {
      const loaded = rowToLoaded(r);
      // Ключ теперь включает engine — допускаем одновременно lightgbm + logreg
      // под одну (kind, fv) пару (Wave 4 fallback).
      const key = modelKey(loaded.kind, loaded.featuresVersion, loaded.engine);
      if (!next.has(key)) next.set(key, loaded);
    }
    cachedModels = next;
    lastModelLoad = Date.now();

    // Fallback display: prefer лучшие фичи (v3) и LightGBM, чтобы model-status
    // показывал реально маршрутизируемую модель, а не худший v1 baseline.
    const surface =
      next.get(modelKey('prematch_winner', 3, 'lightgbm')) ??
      next.get(modelKey('prematch_winner', 3, 'logreg')) ??
      next.get(modelKey('prematch_winner', 2, 'lightgbm')) ??
      next.get(modelKey('prematch_winner', 2, 'logreg')) ??
      next.get(modelKey('prematch_winner', 1, 'lightgbm')) ??
      next.get(modelKey('prematch_winner', 1, 'logreg')) ??
      next.values().next().value ?? null;

    logger.info(
      {
        loaded: Array.from(next.keys()),
        surface: surface?.version,
        engineCounts: countByEngine(next),
      },
      '[PredictionModel] Active models loaded',
    );
    // Превентивно подгрузим hero stats, чтобы первые live-предсказания не ждали БД
    void refreshHeroData().catch(() => {});
    return surface;
  } catch (err) {
    logger.error({ err }, '[PredictionModel] Failed to load models from DB');
    return null;
  }
}

/** Backward-compat: возвращает лучшую активную prematch модель (v3 > v2 > v1, lightgbm > logreg). */
export function getActiveModel(): LoadedModel | null {
  return (
    cachedModels.get(modelKey('prematch_winner', 3, 'lightgbm')) ??
    cachedModels.get(modelKey('prematch_winner', 3, 'logreg')) ??
    cachedModels.get(modelKey('prematch_winner', 2, 'lightgbm')) ??
    cachedModels.get(modelKey('prematch_winner', 2, 'logreg')) ??
    cachedModels.get(modelKey('prematch_winner', 1, 'lightgbm')) ??
    cachedModels.get(modelKey('prematch_winner', 1, 'logreg')) ??
    cachedModels.values().next().value ??
    null
  );
}

function countByEngine(m: Map<string, LoadedModel>): Record<Engine, number> {
  const out: Record<Engine, number> = { logreg: 0, lightgbm: 0 };
  for (const v of m.values()) out[v.engine]++;
  return out;
}

/** Все активные модели — для отладки и model-status endpoint. */
export function getAllActiveModels(): LoadedModel[] {
  return Array.from(cachedModels.values());
}

async function refreshTeamRatings(): Promise<void> {
  if (Date.now() - lastTeamLoad < TEAM_CACHE_TTL_MS && teamRatings.size > 0) return;
  try {
    const rows = await db
      .select({
        teamId: teamsTable.teamId,
        rating: teamsTable.rating,
        wins: teamsTable.wins,
        losses: teamsTable.losses,
      })
      .from(teamsTable);
    const next = new Map<number, { rating: number; wins: number; losses: number }>();
    for (const t of rows) {
      if (t.rating != null) {
        next.set(t.teamId, { rating: t.rating, wins: t.wins ?? 0, losses: t.losses ?? 0 });
      }
    }
    teamRatings = next;
    lastTeamLoad = Date.now();
    logger.info({ count: teamRatings.size }, '[PredictionModel] Team ratings refreshed');
  } catch (err) {
    logger.error({ err }, '[PredictionModel] Failed to load team ratings');
  }
}

async function refreshTeamExtended(): Promise<void> {
  if (Date.now() - lastTeamExtendedLoad < TEAM_EXTENDED_CACHE_TTL_MS && teamExtendedCache.size > 0) return;
  try {
    const rows = await db.select({
      teamId: teamExtendedFeaturesTable.teamId,
      winStreak: teamExtendedFeaturesTable.winStreak,
      daysSinceLastMatch: teamExtendedFeaturesTable.daysSinceLastMatch,
      matches30d: teamExtendedFeaturesTable.matches30d,
      avgDurationSec30d: teamExtendedFeaturesTable.avgDurationSec30d,
      firstBloodRate30d: teamExtendedFeaturesTable.firstBloodRate30d,
      radiantWinrate: teamExtendedFeaturesTable.radiantWinrate,
      direWinrate: teamExtendedFeaturesTable.direWinrate,
    }).from(teamExtendedFeaturesTable);
    const next = new Map<number, TeamExtendedSnapshot>();
    for (const r of rows) {
      next.set(r.teamId, {
        winStreak: r.winStreak,
        daysSinceLastMatch: r.daysSinceLastMatch,
        matches30d: r.matches30d,
        avgDurationSec30d: r.avgDurationSec30d,
        firstBloodRate30d: r.firstBloodRate30d,
        radiantWinrate: r.radiantWinrate,
        direWinrate: r.direWinrate,
      });
    }
    teamExtendedCache = next;
    lastTeamExtendedLoad = Date.now();
    logger.info({ teams: next.size }, '[PredictionModel] Team extended features refreshed');
  } catch (err) {
    logger.error({ err }, '[PredictionModel] Failed to load team_extended_features (table missing? run db push + compute:team-extended)');
  }
}

async function refreshWave3Data(): Promise<void> {
  if (Date.now() - lastWave3Load < WAVE3_CACHE_TTL_MS && playerHeroStatsCache.size > 0) return;
  try {
    const [phs, form, h2hRows, prRows] = await Promise.all([
      db.select({
        accountId: playerHeroStatsTable.accountId,
        heroId: playerHeroStatsTable.heroId,
        games: playerHeroStatsTable.games,
        wins: playerHeroStatsTable.wins,
        lastPlayed: playerHeroStatsTable.lastPlayed,
      }).from(playerHeroStatsTable),
      db.select({
        teamId: teamRecentFormTable.teamId,
        winRate: teamRecentFormTable.winRate,
        games: teamRecentFormTable.games,
      })
        .from(teamRecentFormTable)
        .where(eq(teamRecentFormTable.periodDays, 30)),
      db.select({
        teamLowId: teamH2HTable.teamLowId,
        teamHighId: teamH2HTable.teamHighId,
        games: teamH2HTable.games,
        winsLow: teamH2HTable.winsLow,
      })
        .from(teamH2HTable)
        .where(eq(teamH2HTable.periodDays, 365)),
      db.select({
        accountId: playerRatingsTable.accountId,
        rating: playerRatingsTable.rating,
        rd: playerRatingsTable.rd,
      }).from(playerRatingsTable),
    ]);
    const phsMap: PlayerHeroStatsMap = new Map();
    for (const r of phs) {
      let inner = phsMap.get(r.accountId);
      if (!inner) { inner = new Map(); phsMap.set(r.accountId, inner); }
      inner.set(r.heroId, { games: r.games, wins: r.wins, lastPlayed: r.lastPlayed ?? null });
    }
    const formMap: RecentFormMap = new Map();
    for (const r of form) formMap.set(r.teamId, { winRate: r.winRate, games: r.games });
    const h2hMap: H2HMap = new Map();
    for (const r of h2hRows) {
      h2hMap.set(`${r.teamLowId}_${r.teamHighId}`, { games: r.games, winsLow: r.winsLow });
    }
    const prMap: PlayerGlickoMap = new Map();
    for (const r of prRows) prMap.set(r.accountId, { rating: r.rating, rd: r.rd });

    playerHeroStatsCache = phsMap;
    recentFormCache = formMap;
    h2hCache = h2hMap;
    playerGlickoCache = prMap;
    lastWave3Load = Date.now();
    logger.info(
      { phsAccounts: phsMap.size, formTeams: formMap.size, h2hPairs: h2hMap.size, glickoPlayers: prMap.size },
      '[PredictionModel] Wave 3 data refreshed',
    );
  } catch (err) {
    logger.error({ err }, '[PredictionModel] Failed to load Wave 3 data');
  }
}

async function refreshHeroData(): Promise<void> {
  if (Date.now() - lastHeroLoad < HERO_CACHE_TTL_MS && heroStatsCache.size > 0) return;
  try {
    const [statRows, matchRows, synRows] = await Promise.all([
      db
        .select({
          heroId: heroStatsTable.heroId,
          proWinRate: heroStatsTable.proWinRate,
          proPickRate: heroStatsTable.proPickRate,
          earlyGameScore: heroStatsTable.earlyGameScore,
          lateGameScore: heroStatsTable.lateGameScore,
        })
        .from(heroStatsTable),
      db
        .select({
          heroId: heroMatchupsTable.heroId,
          vsHeroId: heroMatchupsTable.vsHeroId,
          games: heroMatchupsTable.games,
          winRate: heroMatchupsTable.winRate,
        })
        .from(heroMatchupsTable),
      // T0 mini-fix: synergy для нового synergy_diff feature.
      db
        .select({
          heroId: heroSynergyTable.heroId,
          withHeroId: heroSynergyTable.withHeroId,
          games: heroSynergyTable.games,
          winRate: heroSynergyTable.winRate,
        })
        .from(heroSynergyTable),
    ]);
    const stats: HeroStatsMap = new Map();
    for (const h of statRows) {
      stats.set(h.heroId, {
        proWinRate: h.proWinRate,
        proPickRate: h.proPickRate,
        earlyGameScore: h.earlyGameScore,
        lateGameScore: h.lateGameScore,
      });
    }
    const matchups: HeroMatchupsMap = new Map();
    for (const m of matchRows) {
      let inner = matchups.get(m.heroId);
      if (!inner) {
        inner = new Map();
        matchups.set(m.heroId, inner);
      }
      inner.set(m.vsHeroId, { games: m.games, winRate: m.winRate });
    }
    const synergy: HeroSynergyMap = new Map();
    for (const s of synRows) {
      let inner = synergy.get(s.heroId);
      if (!inner) { inner = new Map(); synergy.set(s.heroId, inner); }
      inner.set(s.withHeroId, { games: s.games, winRate: s.winRate });
    }
    heroStatsCache = stats;
    heroMatchupsCache = matchups;
    heroSynergyCache = synergy;
    lastHeroLoad = Date.now();
    logger.info(
      { heroes: stats.size, matchupPairs: matchRows.length, synergyPairs: synRows.length },
      '[PredictionModel] Hero data refreshed',
    );
  } catch (err) {
    logger.error({ err }, '[PredictionModel] Failed to load hero data');
  }
}

export async function getTeamRating(teamId: number) {
  await refreshTeamRatings();
  return teamRatings.get(teamId) ?? null;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function buildTeamFeatures(
  r: { rating: number; wins: number; losses: number },
  d: { rating: number; wins: number; losses: number },
  tier: Tier | null,
  rExt: TeamExtendedSnapshot | null,
  dExt: TeamExtendedSnapshot | null,
  ctx?: {
    seriesTypeNorm?: number;  // default 0.5 (BO3)
    mapNoNorm?: number;       // default 0.0 (game 1)
    recencyDaysNorm?: number; // default 0.0 (now)
  },
): number[] {
  const rGames = r.wins + r.losses;
  const dGames = d.wins + d.losses;
  const seriesTypeNorm = ctx?.seriesTypeNorm ?? 0.5;
  const mapNoNorm = ctx?.mapNoNorm ?? 0.0;
  const recencyDaysNorm = ctx?.recencyDaysNorm ?? 0.0;
  const ext = buildExtendedTeamFeatures(rExt, dExt);
  return [
    1,
    r.wins / rGames - d.wins / dGames,
    Math.log(rGames + 1) - Math.log(dGames + 1),
    rGames >= 50 && dGames >= 50 ? 1 : 0,
    RADIANT_SIDE_LOGIT,
    recencyDaysNorm,
    seriesTypeNorm,
    mapNoNorm,
    tier === 't1' ? 1 : 0,
    tier === 't2' ? 1 : 0,
    tier === 't3' ? 1 : 0,
    ...ext,
  ];
}

function pickModel(tier: Tier | null, fv: 1 | 2 | 3): LoadedModel | null {
  if (tier) {
    const tm = getModel(tierKind(tier), fv);
    if (tm) return tm;
  }
  return getModel('prematch_winner', fv);
}

function modelUsable(m: LoadedModel): boolean {
  if (m.engine === 'lightgbm') {
    return m.blobB64 != null && lightgbmAvailable();
  }
  return m.weights.length > 0;
}

/**
 * Ищет logreg-модель в кеше как spare tire для LightGBM. Стратегия —
 * максимально близкая lineage:
 *   1. ровно тот же (kind, fv) на logreg
 *   2. (prematch_winner — общий fallback) на той же fv
 *   3. любой logreg с той же featureDim (последняя соломинка, логируем)
 * Это нужно чтобы при сбое t1-LightGBM не подставился случайный t2-LR
 * другой размерности или другого тира — иначе мы тихо ломаем калибровку
 * и tier-routing.
 */
function findLogregFallback(
  kind: PrematchKind,
  fv: 1 | 2 | 3,
  dim: number,
): LoadedModel | null {
  // exact lineage
  const exact = cachedModels.get(modelKey(kind, fv, 'logreg'));
  if (exact && exact.engine === 'logreg' && exact.weights.length === dim) return exact;
  // generic prematch_winner на той же fv
  if (kind !== 'prematch_winner') {
    const generic = cachedModels.get(modelKey('prematch_winner', fv, 'logreg'));
    if (generic && generic.weights.length === dim) {
      logger.warn(
        { requestedKind: kind, fv, fallbackVersion: generic.version },
        '[PredictionModel] LR fallback: tier-specific LR missing, using prematch_winner',
      );
      return generic;
    }
  }
  // last resort: dim match (логируем как degradation)
  for (const m of cachedModels.values()) {
    if (m.engine === 'logreg' && m.weights.length === dim) {
      logger.warn(
        { requestedKind: kind, fv, fallbackKind: m.kind, fallbackFv: m.featuresVersion, fallbackVersion: m.version },
        '[PredictionModel] LR fallback: lineage mismatch, last-resort dim match',
      );
      return m;
    }
  }
  return null;
}

/**
 * Считает P(radiant_win) с tier- и feature-routing'ом + изотонической калибровкой.
 *
 * Если переданы драфты и все 10 героев есть в hero_stats — используется v2,
 * иначе v1. Если v2 не доступна вовсе (не обучена) — тоже падаем в v1.
 *
 * Возвращает null если:
 *   - модели не загружены вовсе;
 *   - не получены рейтинги команд;
 *   - у команды слишком мало матчей (<5).
 */
export async function predictMatchWinner(
  radiantTeamId: number | null,
  direTeamId: number | null,
  drafts?: DraftInput | null,
): Promise<{
  probRadiantWin: number;
  rawProb: number;
  modelVersion: string;
  featuresVersion: 1 | 2 | 3;
  tier: Tier | null;
  features: Record<string, number>;
} | null> {
  const startedAt = Date.now();
  if (cachedModels.size === 0) {
    logger.debug({ tag: 'predict', reason: 'no_models', radiantTeamId, direTeamId }, '[predict] skip');
    return null;
  }
  if (!radiantTeamId || !direTeamId) {
    logger.debug({ tag: 'predict', reason: 'no_team_ids' }, '[predict] skip');
    return null;
  }

  let r = await getTeamRating(radiantTeamId);
  let d = await getTeamRating(direTeamId);

  // Player-strength fallback: если нет рейтинга команды или мало игр, но переданы
  // account_ids — собираем синтетический TeamRating из среднего Glicko игроков
  // состава. Glicko-1 (≈1500 baseline) и OpenDota team rating живут в сопоставимой
  // шкале, поэтому avg(player.glicko) — разумный прокси «силы команды».
  // Минимум 3 игрока с известным рейтингом на сторону.
  const needRadiantFallback = !r || (r.wins + r.losses) < 5;
  const needDireFallback = !d || (d.wins + d.losses) < 5;
  if ((needRadiantFallback || needDireFallback) && drafts) {
    await refreshWave3Data();
    const synthFromGlicko = (
      accountIds: number[] | null | undefined,
    ): { rating: number; wins: number; losses: number } | null => {
      if (!accountIds || accountIds.length === 0) return null;
      const ratings: number[] = [];
      for (const acc of accountIds) {
        const g = playerGlickoCache.get(acc);
        if (g && g.rating > 0) ratings.push(g.rating);
      }
      if (ratings.length < 3) return null;
      const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      // wins/losses=10/10 — синтетика, чтобы пройти `rGames<5` гейт; реальная
      // история бесполезна когда её нет. Winrate 0.5 нейтрален в фичах.
      return { rating: avg, wins: 10, losses: 10 };
    };
    if (needRadiantFallback) {
      const synth = synthFromGlicko(drafts.radiantAccountIds);
      if (synth) {
        logger.info(
          { tag: 'predict', side: 'radiant', teamId: radiantTeamId, synthRating: Math.round(synth.rating), origRating: r?.rating ?? null, origGames: r ? r.wins + r.losses : 0 },
          '[predict] using player-glicko fallback for radiant',
        );
        r = synth;
      }
    }
    if (needDireFallback) {
      const synth = synthFromGlicko(drafts.direAccountIds);
      if (synth) {
        logger.info(
          { tag: 'predict', side: 'dire', teamId: direTeamId, synthRating: Math.round(synth.rating), origRating: d?.rating ?? null, origGames: d ? d.wins + d.losses : 0 },
          '[predict] using player-glicko fallback for dire',
        );
        d = synth;
      }
    }
  }

  if (!r || !d) {
    logger.debug({ tag: 'predict', reason: 'no_rating', radiantTeamId, direTeamId }, '[predict] skip');
    return null;
  }

  const rGames = r.wins + r.losses;
  const dGames = d.wins + d.losses;
  if (rGames < 5 || dGames < 5) {
    logger.debug({ tag: 'predict', reason: 'too_few_games', rGames, dGames }, '[predict] skip');
    return null;
  }

  const tier = classifyTier(r.rating, d.rating);
  await refreshTeamExtended();
  const rExt = teamExtendedCache.get(radiantTeamId) ?? null;
  const dExt = teamExtendedCache.get(direTeamId) ?? null;
  const teamFeats = buildTeamFeatures(r, d, tier, rExt, dExt);

  let model: LoadedModel | null = null;
  let features = teamFeats;
  let heroFeats: number[] | null = null;
  let extraFeats: number[] | null = null;
  let usedFv: 1 | 2 | 3 = 1;

  // Сначала готовим hero-фичи, если есть драфт.
  if (
    drafts &&
    drafts.radiantPicks.length === 5 &&
    drafts.direPicks.length === 5
  ) {
    await refreshHeroData();
    if (heroStatsCache.size > 0) {
      heroFeats = buildHeroFeatures(
        drafts.radiantPicks,
        drafts.direPicks,
        drafts.radiantBans,
        drafts.direBans,
        heroStatsCache,
        heroMatchupsCache,
        heroSynergyCache,
      );
    }
  }

  // Wave 3: пытаемся v3 если есть драфт + heroFeats + хотя бы один из account_ids
  // массивов передан. Если v3-модели не существует — падаем дальше в v2.
  if (
    heroFeats &&
    drafts &&
    (drafts.radiantAccountIds || drafts.direAccountIds)
  ) {
    await refreshWave3Data();
    extraFeats = buildExtraFeatures({
      radiantTeamId,
      direTeamId,
      radiantPicks: drafts.radiantPicks,
      direPicks: drafts.direPicks,
      radiantAccountIds: drafts.radiantAccountIds ?? null,
      direAccountIds: drafts.direAccountIds ?? null,
      playerHeroStats: playerHeroStatsCache,
      heroStats: heroStatsCache,
      recentForm: recentFormCache,
      h2h: h2hCache,
      playerGlicko: playerGlickoCache,
    });
    const v3Dim = teamFeats.length + heroFeats.length + extraFeats.length;
    const v3Model = pickModel(tier, 3);
    if (v3Model && v3Model.featureDim === v3Dim) {
      model = v3Model;
      features = [...teamFeats, ...heroFeats, ...extraFeats];
      usedFv = 3;
    } else if (v3Model && v3Model.engine === 'lightgbm') {
      // LightGBM v3 устарел (другая dim) — пробуем v3 LR того же tier/generic перед v2 fallback.
      const v3LR = findLogregFallback(tier ? tierKind(tier) : 'prematch_winner', 3, v3Dim);
      if (v3LR) {
        logger.info(
          { lgbmVersion: v3Model.version, lgbmDim: v3Model.featureDim, lrVersion: v3LR.version, lrDim: v3LR.weights.length },
          '[PredictionModel] v3 LightGBM dim mismatch, falling back to v3 LR (kept Wave 3 features)',
        );
        model = v3LR;
        features = [...teamFeats, ...heroFeats, ...extraFeats];
        usedFv = 3;
      }
    }
  }

  // v2 fallback
  if (!model && heroFeats) {
    const v2Model = pickModel(tier, 2);
    if (v2Model && v2Model.featureDim === teamFeats.length + heroFeats.length) {
      model = v2Model;
      features = [...teamFeats, ...heroFeats];
      usedFv = 2;
    }
  }

  // v1 fallback
  if (!model) {
    model = pickModel(tier, 1);
    features = teamFeats;
    usedFv = 1;
  }

  if (!model) {
    // Crash-safe: матчем размерности.
    for (const m of cachedModels.values()) {
      if (modelUsable(m) && m.featureDim === teamFeats.length) {
        model = m;
        features = teamFeats;
        usedFv = m.featuresVersion;
        break;
      }
    }
  }

  if (!model) return null;
  if (model.featureDim !== features.length) {
    logger.warn(
      { modelVersion: model.version, modelDim: model.featureDim, featDim: features.length },
      '[PredictionModel] dim mismatch, refusing prediction',
    );
    return null;
  }

  let rawProb: number;
  let calibrated: number;
  if (model.engine === 'lightgbm' && model.blobB64) {
    const mlProb = await predictViaMlService(model.blobB64, features);
    if (mlProb == null) {
      // Fallback: предпочитаем LR с тем же (kind, fv) lineage,
      // чтобы не сбить tier-routing при сбое ml-service (см. findLogregFallback).
      const fb = findLogregFallback(model.kind, model.featuresVersion, features.length);
      if (!fb) return null;
      model = fb;
      let z = 0;
      for (let i = 0; i < features.length; i++) z += model.weights[i] * features[i];
      rawProb = sigmoid(z);
      calibrated = applyCalibration(rawProb, model.calibration);
    } else {
      rawProb = mlProb;
      calibrated = mlProb;  // изотоника уже внутри bundle
    }
  } else {
    let z = 0;
    for (let i = 0; i < features.length; i++) z += model.weights[i] * features[i];
    rawProb = sigmoid(z);
    calibrated = applyCalibration(rawProb, model.calibration);
  }

  const featureRecord: Record<string, number> = {};
  for (let i = 0; i < TEAM_FEATURE_NAMES.length; i++) {
    featureRecord[TEAM_FEATURE_NAMES[i]] = teamFeats[i];
  }
  if (heroFeats && (usedFv === 2 || usedFv === 3)) {
    for (let i = 0; i < HERO_FEATURE_NAMES.length; i++) {
      featureRecord[HERO_FEATURE_NAMES[i]] = heroFeats[i];
    }
  }
  if (extraFeats && usedFv === 3) {
    for (let i = 0; i < EXTRA_FEATURE_NAMES.length; i++) {
      featureRecord[EXTRA_FEATURE_NAMES[i]] = extraFeats[i];
    }
  }

  return {
    probRadiantWin: calibrated,
    rawProb,
    modelVersion: model.version,
    featuresVersion: usedFv,
    tier: model.tier,
    features: featureRecord,
  };
}
