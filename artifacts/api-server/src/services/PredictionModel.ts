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
import { currentFeatureViewFor } from '@workspace/db';
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
import {
  loadTeamRostersMap,
  loadTeamHeroPoolMap,
  loadPlayerTotalsMap,
  loadPlayerCountsMap,
  loadPlayerWlProMap,
  buildE1PrematchFeatures,
  E1_PREMATCH_FEATURE_NAMES,
  type TeamRostersMap,
  type TeamHeroPoolMap,
  type PlayerTotalsMap,
  type PlayerCountsMap,
  type PlayerWlProMap,
} from '../lib/e1-features';
import {
  loadActiveAsymPrematchModel,
  isAsymEligible,
  predictAsymPrematch,
  getActiveAsymPrematchModel,
} from './AsymPrematchModel';

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

import {evidenceHash, predictionEvidence, type PredictionEvidence} from '../lib/predictionEvidence';

interface LoadedModel {
  artifactHash: string;
  featureNames: string[];
  version: string;
  kind: PrematchKind;
  featuresVersion: 1 | 2 | 3 | 4;
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
// F9 (Phase 9): timeout 200 → 1500ms. См. комментарий в `MarketLgbm.ts`.
const ML_PREDICT_TIMEOUT_MS = Number(process.env.ML_PREDICT_TIMEOUT_MS ?? 1500);
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

function modelKey(kind: PrematchKind, fv: 1 | 2 | 3 | 4, engine: Engine): string {
  return `${kind}|v${fv}|${engine}`;
}

/** Пытается достать lightgbm-вариант, иначе logreg. */
function getModel(kind: PrematchKind, fv: 1 | 2 | 3 | 4): LoadedModel | null {
  const lgbm = cachedModels.get(modelKey(kind, fv, 'lightgbm'));
  if (lgbm && modelUsable(lgbm)) return lgbm;
  const lr = cachedModels.get(modelKey(kind, fv, 'logreg'));
  return lr && modelUsable(lr) ? lr : null;
}

let cachedModels: Map<string, LoadedModel> = new Map();
export function getPredictionModelRevision(): string {
  return [...cachedModels.values()].map(m => `${m.kind}:${m.version}:${m.featuresVersion}:${m.engine}`).sort().join('|');
}
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

// E1 OD-extension (v4 prematch features). Таблицы маленькие (~33k rows total) —
// грузим полностью одним снапшотом. TTL такой же как Wave 3 (30 мин).
let e1RostersCache: TeamRostersMap = new Map();
let e1PoolCache: TeamHeroPoolMap = new Map();
let e1TotalsCache: PlayerTotalsMap = new Map();
let e1CountsCache: PlayerCountsMap = new Map();
let e1WlProCache: PlayerWlProMap = new Map();
let lastE1Load = 0;
let e1FullyLoaded = false;
const E1_CACHE_TTL_MS = 30 * 60 * 1000;

async function refreshE1Data(): Promise<void> {
  const expired = Date.now() - lastE1Load >= E1_CACHE_TTL_MS;
  if (e1FullyLoaded && !expired) return;
  try {
    const [rosters, pool, totals, counts, wlPro] = await Promise.all([
      loadTeamRostersMap(),
      loadTeamHeroPoolMap(),
      loadPlayerTotalsMap({ fields: ['gold_per_min', 'xp_per_min', 'kills', 'assists', 'deaths'] }),
      loadPlayerCountsMap(),
      loadPlayerWlProMap(),
    ]);
    e1RostersCache = rosters;
    e1PoolCache = pool;
    e1TotalsCache = totals;
    e1CountsCache = counts;
    e1WlProCache = wlPro;
    lastE1Load = Date.now();
    e1FullyLoaded = true;
    logger.info(
      { rosters: rosters.size, pool: pool.size, totals: totals.size, counts: counts.size, wlPro: wlPro.size },
      '[PredictionModel] E1 data refreshed',
    );
  } catch (err) {
    logger.error({ err }, '[PredictionModel] Failed to load E1 data');
  }
}

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
  const fv = (m.featuresVersion ?? 1) as 1 | 2 | 3 | 4;
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
    artifactHash: evidenceHash({engine, weights, blobB64, calibration, features: featuresArr}),
    featureNames: featuresArr.map(String),
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

async function predictViaMlService(blobB64: string, features: number[]): Promise<{raw: number; calibrated: number} | null> {
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
    if (!Number.isFinite(data.calibrated_prob) || data.calibrated_prob < 0 || data.calibrated_prob > 1) {
      tripLightgbm('ml-service bad payload');
      return null;
    }
    return {raw: Number.isFinite(data.raw_prob) ? data.raw_prob : data.calibrated_prob, calibrated: data.calibrated_prob};
  } catch (e) {
    // F9 (Phase 9): timeout НЕ открывает circuit. См. `MarketLgbm.ts`.
    if ((e as Error).name === 'AbortError') {
      logger.debug({ timeoutMs: ML_PREDICT_TIMEOUT_MS }, '[PredictionModel] /predict timeout (no trip)');
      return null;
    }
    tripLightgbm((e as Error).message);
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
    // Этап B — asym prematch модель грузится параллельно. Сбой здесь
    // не должен валить основную загрузку, потому await отдельно с ignore.
    void loadActiveAsymPrematchModel().catch(err => {
      logger.warn({ err }, '[PredictionModel] asym load failed (non-fatal)');
    });
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

    // Fallback display: prefer лучшие фичи (v4) и LightGBM, чтобы model-status
    // показывал реально маршрутизируемую модель, а не худший v1 baseline.
    const surface =
      next.get(modelKey('prematch_winner', 4, 'lightgbm')) ??
      next.get(modelKey('prematch_winner', 4, 'logreg')) ??
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
    // D1 — feature view staleness warning.
    if (surface) {
      const currentFv = currentFeatureViewFor(surface.kind);
      if (currentFv != null && surface.featuresVersion < currentFv) {
        logger.warn(
          { kind: surface.kind, modelFv: surface.featuresVersion, currentFv, version: surface.version },
          '[PredictionModel] Active surface uses STALE featureView — bump CURRENT or retrain',
        );
      }
    }
    // Превентивно подгрузим hero stats, чтобы первые live-предсказания не ждали БД
    void refreshHeroData().catch(() => {});
    return surface;
  } catch (err) {
    logger.error({ err }, '[PredictionModel] Failed to load models from DB');
    return null;
  }
}

/** Backward-compat: возвращает лучшую активную prematch модель (v4 > v3 > v2 > v1, lightgbm > logreg). */
export function getActiveModel(): LoadedModel | null {
  return (
    cachedModels.get(modelKey('prematch_winner', 4, 'lightgbm')) ??
    cachedModels.get(modelKey('prematch_winner', 4, 'logreg')) ??
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
      peerSynergy: teamExtendedFeaturesTable.peerSynergy,
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
        peerSynergy: r.peerSynergy,
      });
    }
    teamExtendedCache = next;
    lastTeamExtendedLoad = Date.now();
    logger.info({ teams: next.size }, '[PredictionModel] Team extended features refreshed');
  } catch (err) {
    logger.error({ err }, '[PredictionModel] Failed to load team_extended_features (table missing? run db push + compute:team-extended)');
  }
}

/**
 * Sets «уже опрошенных» teamId / accountId. Защищает от повторного похода в БД
 * за теми же ID, у которых строк нет вовсе (т.е. отсутствие в кеше != «нужно
 * перезагрузить»). Сбрасываются при full-refresh / TTL expire.
 */
const triedWave3TeamIds = new Set<number>();
const triedWave3AccountIds = new Set<number>();
let wave3FullyLoaded = false;

function resetWave3Caches() {
  playerHeroStatsCache.clear();
  recentFormCache.clear();
  h2hCache.clear();
  playerGlickoCache.clear();
  triedWave3TeamIds.clear();
  triedWave3AccountIds.clear();
  wave3FullyLoaded = false;
}

/**
 * B3: lazy Wave-3 cache.
 *
 * - hint=undefined → full snapshot (используется maintenance-вызовом
 *   `loadActiveModel`/scheduler hot-reload и initial warmup). Грузит все
 *   player_hero_stats / team_recent_form / team_h2h / player_ratings.
 *
 * - hint={teamIds, accountIds} → инкрементальная подгрузка только тех ID,
 *   которых ещё нет в кеше и которые не помечены как «опрошенные пустые».
 *   Используется на inference path в `predictMatchWinner` — экономит десятки
 *   тысяч строк на каждый predict при большой БД.
 *
 * TTL: 30 минут (общий «возраст» снапшота). По истечении — следующий вызов
 * либо с hint, либо без, сбрасывает кеш целиком.
 */
async function refreshWave3Data(
  hint?: { teamIds?: Array<number | null | undefined>; accountIds?: Array<number | null | undefined> | null },
): Promise<void> {
  const expired = Date.now() - lastWave3Load >= WAVE3_CACHE_TTL_MS;
  if (expired) resetWave3Caches();

  if (!hint) {
    if (wave3FullyLoaded && !expired) return;
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
      wave3FullyLoaded = true;
      triedWave3TeamIds.clear();
      triedWave3AccountIds.clear();
      logger.info(
        { phsAccounts: phsMap.size, formTeams: formMap.size, h2hPairs: h2hMap.size, glickoPlayers: prMap.size },
        '[PredictionModel] Wave 3 data refreshed (full)',
      );
    } catch (err) {
      logger.error({ err }, '[PredictionModel] Failed to load Wave 3 data');
    }
    return;
  }

  // Partial / lazy path
  if (wave3FullyLoaded) return; // already have everything

  const teamIds = (hint.teamIds ?? []).filter((id): id is number => typeof id === 'number' && id > 0);
  const accountIds = (hint.accountIds ?? []).filter((id): id is number => typeof id === 'number' && id > 0);

  const needTeams = Array.from(new Set(teamIds.filter(id => !triedWave3TeamIds.has(id))));
  const needAccs = Array.from(new Set(accountIds.filter(id => !triedWave3AccountIds.has(id))));
  if (needTeams.length === 0 && needAccs.length === 0) return;

  try {
    const formP = needTeams.length > 0
      ? db.select({
          teamId: teamRecentFormTable.teamId,
          winRate: teamRecentFormTable.winRate,
          games: teamRecentFormTable.games,
        })
          .from(teamRecentFormTable)
          .where(and(eq(teamRecentFormTable.periodDays, 30), inArray(teamRecentFormTable.teamId, needTeams)))
      : Promise.resolve([] as Array<{ teamId: number; winRate: number; games: number }>);

    // h2h: тянем все пары среди needTeams (обычно 2 ID → 1 пара)
    const h2hP = needTeams.length >= 2
      ? db.select({
          teamLowId: teamH2HTable.teamLowId,
          teamHighId: teamH2HTable.teamHighId,
          games: teamH2HTable.games,
          winsLow: teamH2HTable.winsLow,
        })
          .from(teamH2HTable)
          .where(and(
            eq(teamH2HTable.periodDays, 365),
            inArray(teamH2HTable.teamLowId, needTeams),
            inArray(teamH2HTable.teamHighId, needTeams),
          ))
      : Promise.resolve([] as Array<{ teamLowId: number; teamHighId: number; games: number; winsLow: number }>);

    const phsP = needAccs.length > 0
      ? db.select({
          accountId: playerHeroStatsTable.accountId,
          heroId: playerHeroStatsTable.heroId,
          games: playerHeroStatsTable.games,
          wins: playerHeroStatsTable.wins,
          lastPlayed: playerHeroStatsTable.lastPlayed,
        })
          .from(playerHeroStatsTable)
          .where(inArray(playerHeroStatsTable.accountId, needAccs))
      : Promise.resolve([] as Array<{ accountId: number; heroId: number; games: number; wins: number; lastPlayed: number | null }>);

    const prP = needAccs.length > 0
      ? db.select({
          accountId: playerRatingsTable.accountId,
          rating: playerRatingsTable.rating,
          rd: playerRatingsTable.rd,
        })
          .from(playerRatingsTable)
          .where(inArray(playerRatingsTable.accountId, needAccs))
      : Promise.resolve([] as Array<{ accountId: number; rating: number; rd: number }>);

    const [form, h2hRows, phs, prRows] = await Promise.all([formP, h2hP, phsP, prP]);

    for (const r of form) recentFormCache.set(r.teamId, { winRate: r.winRate, games: r.games });
    for (const r of h2hRows) h2hCache.set(`${r.teamLowId}_${r.teamHighId}`, { games: r.games, winsLow: r.winsLow });
    for (const r of phs) {
      let inner = playerHeroStatsCache.get(r.accountId);
      if (!inner) { inner = new Map(); playerHeroStatsCache.set(r.accountId, inner); }
      inner.set(r.heroId, { games: r.games, wins: r.wins, lastPlayed: r.lastPlayed ?? null });
    }
    for (const r of prRows) playerGlickoCache.set(r.accountId, { rating: r.rating, rd: r.rd });

    for (const id of needTeams) triedWave3TeamIds.add(id);
    for (const id of needAccs) triedWave3AccountIds.add(id);
    if (lastWave3Load === 0) lastWave3Load = Date.now();

    logger.debug(
      { needTeams: needTeams.length, needAccs: needAccs.length,
        found: { form: form.length, h2h: h2hRows.length, phs: phs.length, glicko: prRows.length } },
      '[PredictionModel] Wave 3 partial load',
    );
  } catch (err) {
    logger.error({ err }, '[PredictionModel] Wave 3 partial load failed');
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

function pickModel(tier: Tier | null, fv: 1 | 2 | 3 | 4): LoadedModel | null {
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
  fv: 1 | 2 | 3 | 4,
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
  context?: {format: 'BO1' | 'BO3' | 'BO5'; mapNumber: number},
): Promise<{
  probRadiantWin: number;
  rawProb: number;
  evidence: PredictionEvidence;
  modelVersion: string;
  featuresVersion: 1 | 2 | 3 | 4;
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

  // Этап B — asym fast-path. Для матчей где хотя бы у одной команды
  // games_in_prior_180d<5 (стандартный prematch гейт ниже всё равно отказал бы)
  // и есть драфт с account_ids — пробуем специализированную asym модель.
  // При успехе возвращаем сразу; при null — fall-through на main v3/v2/v1.
  if (
    getActiveAsymPrematchModel() &&
    drafts &&
    drafts.radiantPicks.length === 5 &&
    drafts.direPicks.length === 5 &&
    (drafts.radiantAccountIds || drafts.direAccountIds)
  ) {
    const eligible = await isAsymEligible(
      radiantTeamId,
      direTeamId,
      drafts.radiantAccountIds,
      drafts.direAccountIds,
    ).catch(() => false);
    if (eligible) {
      const asym = await predictAsymPrematch({
        radiantTeamId,
        direTeamId,
        radiantPicks: drafts.radiantPicks,
        direPicks: drafts.direPicks,
        radiantAccountIds: drafts.radiantAccountIds ?? null,
        direAccountIds: drafts.direAccountIds ?? null,
      }).catch(err => {
        logger.warn({ err, radiantTeamId, direTeamId }, '[predict] asym throw — fallback to main');
        return null;
      });
      if (asym) {
        logger.info(
          {
            tag: 'predict', variant: 'asym',
            modelVersion: asym.modelVersion,
            games180d: asym.games180d,
            prob: Math.round(asym.probRadiantWin * 1000) / 1000,
            tookMs: Date.now() - startedAt,
          },
          '[predict] used asym fast-path',
        );
        return {
          probRadiantWin: asym.probRadiantWin,
          evidence: asym.evidence,
          rawProb: asym.rawProb,
          modelVersion: asym.modelVersion,
          featuresVersion: 1,
          tier: null,
          features: asym.features,
        };
      }
    }
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
    await refreshWave3Data({
      teamIds: [radiantTeamId, direTeamId],
      accountIds: [...(drafts.radiantAccountIds ?? []), ...(drafts.direAccountIds ?? [])],
    });
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
  const teamFeats = buildTeamFeatures(r, d, tier, rExt, dExt, context ? {
    seriesTypeNorm: context.format === 'BO1' ? 0 : context.format === 'BO5' ? 1 : 0.5,
    mapNoNorm: Math.min(4, Math.max(0, context.mapNumber - 1)) / 4,
    recencyDaysNorm: 0,
  } : undefined);

  let model: LoadedModel | null = null;
  let features = teamFeats;
  let heroFeats: number[] | null = null;
  let extraFeats: number[] | null = null;
  let e1Feats: number[] | null = null;
  let usedFv: 1 | 2 | 3 | 4 = 1;

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
    await refreshWave3Data({
      teamIds: [radiantTeamId, direTeamId],
      accountIds: [...(drafts.radiantAccountIds ?? []), ...(drafts.direAccountIds ?? [])],
    });
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

    // v4 (E1 OD-extension) пробуем ПЕРЕД v3 — те же входные условия (драфт +
    // хотя бы один массив account_ids). buildE1PrematchFeatures BC-нейтрален:
    // отсутствие данных → 0, размерность фиксирована (18).
    await refreshE1Data();
    e1Feats = buildE1PrematchFeatures({
      radiantTeamId,
      direTeamId,
      radiantPicks: drafts.radiantPicks,
      direPicks: drafts.direPicks,
      radiantAccountIds: drafts.radiantAccountIds ?? null,
      direAccountIds: drafts.direAccountIds ?? null,
      rosters: e1RostersCache,
      pool: e1PoolCache,
      totals: e1TotalsCache,
      counts: e1CountsCache,
      wlPro: e1WlProCache,
    });
    const v4Dim = teamFeats.length + heroFeats.length + extraFeats.length + e1Feats.length;
    const v4Model = pickModel(tier, 4);
    if (v4Model && v4Model.featureDim === v4Dim) {
      model = v4Model;
      features = [...teamFeats, ...heroFeats, ...extraFeats, ...e1Feats];
      usedFv = 4;
    } else if (v4Model && v4Model.engine === 'lightgbm') {
      const v4LR = findLogregFallback(tier ? tierKind(tier) : 'prematch_winner', 4, v4Dim);
      if (v4LR) {
        logger.info(
          { lgbmVersion: v4Model.version, lgbmDim: v4Model.featureDim, lrVersion: v4LR.version, lrDim: v4LR.weights.length },
          '[PredictionModel] v4 LightGBM dim mismatch, falling back to v4 LR',
        );
        model = v4LR;
        features = [...teamFeats, ...heroFeats, ...extraFeats, ...e1Feats];
        usedFv = 4;
      }
    }

    const v3Dim = teamFeats.length + heroFeats.length + extraFeats.length;
    const v3Model = !model ? pickModel(tier, 3) : null;
    if (!model && v3Model && v3Model.featureDim === v3Dim) {
      model = v3Model;
      features = [...teamFeats, ...heroFeats, ...extraFeats];
      usedFv = 3;
    } else if (!model && v3Model && v3Model.engine === 'lightgbm') {
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
      // Fallback chain при сбое ml-service:
      //  1) LR с тем же (kind, fv) lineage (сохраняет tier-routing).
      //  2) Degrade: LR на меньшем fv (v4→v3→v2→v1) с пересборкой features,
      //     чтобы не возвращать null и сохранить бесперебойный inference.
      let fb = findLogregFallback(model.kind, model.featuresVersion, features.length);
      if (!fb) {
        const startFv = (model.featuresVersion - 1) as 3 | 2 | 1 | 0;
        for (let tryFv = startFv; tryFv >= 1; tryFv = (tryFv - 1) as 3 | 2 | 1 | 0) {
          let tryFeats: number[] | null = null;
          if (tryFv === 3 && heroFeats && extraFeats) {
            tryFeats = [...teamFeats, ...heroFeats, ...extraFeats];
          } else if (tryFv === 2 && heroFeats) {
            tryFeats = [...teamFeats, ...heroFeats];
          } else if (tryFv === 1) {
            tryFeats = teamFeats;
          }
          if (!tryFeats) continue;
          const tryLR = findLogregFallback(model.kind, tryFv as 1 | 2 | 3, tryFeats.length);
          if (tryLR) {
            logger.warn(
              { kind: model.kind, fromFv: model.featuresVersion, toFv: tryFv, lrVersion: tryLR.version },
              '[PredictionModel] ml-service down, degrading fv for LR fallback',
            );
            fb = tryLR;
            features = tryFeats;
            usedFv = tryFv as 1 | 2 | 3;
            break;
          }
        }
      }
      if (!fb) return null;
      model = fb;
      let z = 0;
      for (let i = 0; i < features.length; i++) z += model.weights[i] * features[i];
      rawProb = sigmoid(z);
      calibrated = applyCalibration(rawProb, model.calibration);
    } else {
      rawProb = mlProb.raw;
      calibrated = mlProb.calibrated;
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
  if (heroFeats && usedFv === 4) {
    for (let i = 0; i < HERO_FEATURE_NAMES.length; i++) {
      featureRecord[HERO_FEATURE_NAMES[i]] = heroFeats[i];
    }
  }
  if (extraFeats && (usedFv === 3 || usedFv === 4)) {
    for (let i = 0; i < EXTRA_FEATURE_NAMES.length; i++) {
      featureRecord[EXTRA_FEATURE_NAMES[i]] = extraFeats[i];
    }
  }
  if (e1Feats && usedFv === 4) {
    for (let i = 0; i < E1_PREMATCH_FEATURE_NAMES.length; i++) {
      featureRecord[E1_PREMATCH_FEATURE_NAMES[i]] = e1Feats[i];
    }
  }

  return {
    probRadiantWin: calibrated,
    evidence: predictionEvidence(model.artifactHash, model.featureNames, features),
    rawProb,
    modelVersion: model.version,
    featuresVersion: usedFv,
    tier: model.tier,
    features: featureRecord,
  };
}
