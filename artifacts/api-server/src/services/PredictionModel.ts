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
  playerHeroStatsTable,
  teamRecentFormTable,
  teamH2HTable,
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
  type PlayerHeroStatsMap,
  type RecentFormMap,
  type H2HMap,
} from '../lib/hero-features';

const TEAM_FEATURE_NAMES = ['bias', 'elo_diff_norm', 'winrate_diff', 'experience_diff', 'is_high_tier'] as const;
const TEAM_FEATURE_DIM = TEAM_FEATURE_NAMES.length;

interface LoadedModel {
  version: string;
  kind: PrematchKind;
  featuresVersion: 1 | 2 | 3;
  tier: Tier | null;
  algorithm: string;
  weights: number[];          // длина зависит от featuresVersion
  calibration: CalibrationModel | null;
  trainAccuracy: number;
  testAccuracy: number;
  brierScore: number;
  trainSize: number;
  testSize: number;
  loadedAt: Date;
}

export interface DraftInput {
  radiantPicks: number[];
  direPicks: number[];
  radiantBans: number[];
  direBans: number[];
  radiantAccountIds?: number[] | null;
  direAccountIds?: number[] | null;
}

function modelKey(kind: PrematchKind, fv: 1 | 2 | 3): string {
  return `${kind}|v${fv}`;
}

let cachedModels: Map<string, LoadedModel> = new Map();
let lastModelLoad = 0;
let teamRatings: Map<number, { rating: number; wins: number; losses: number }> = new Map();
let lastTeamLoad = 0;
const TEAM_CACHE_TTL_MS = 15 * 60 * 1000;
const HERO_CACHE_TTL_MS = 60 * 60 * 1000;

let heroStatsCache: HeroStatsMap = new Map();
let heroMatchupsCache: HeroMatchupsMap = new Map();
let lastHeroLoad = 0;

// Wave 3 caches (загружаются лениво при первом v3-запросе).
let playerHeroStatsCache: PlayerHeroStatsMap = new Map();
let recentFormCache: RecentFormMap = new Map();
let h2hCache: H2HMap = new Map();
let lastWave3Load = 0;
const WAVE3_CACHE_TTL_MS = 30 * 60 * 1000;

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
  // Веса хранятся как { w0, w1, ... }. Длина определяется по фактическим
  // ключам, чтобы безопасно пережить добавление новых фичей в будущем.
  const keys = Object.keys(wRaw)
    .filter(k => /^w\d+$/.test(k))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const weights = keys.map(k => wRaw[k] ?? 0);
  return {
    version: m.version,
    kind: m.kind as PrematchKind,
    featuresVersion: fv,
    tier,
    algorithm: m.algorithm,
    weights,
    calibration,
    trainAccuracy: m.trainAccuracy ?? 0,
    testAccuracy: m.testAccuracy ?? 0,
    brierScore: m.brierScore ?? 0,
    trainSize: m.trainSampleSize ?? 0,
    testSize: m.testSampleSize ?? 0,
    loadedAt: new Date(),
  };
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
      const key = modelKey(loaded.kind, loaded.featuresVersion);
      if (!next.has(key)) next.set(key, loaded);
    }
    cachedModels = next;
    lastModelLoad = Date.now();

    const fallbackV1 = next.get(modelKey('prematch_winner', 1));
    const anyFallback = fallbackV1 ?? next.get(modelKey('prematch_winner', 2)) ?? null;
    const surface = anyFallback ?? next.values().next().value ?? null;

    logger.info(
      {
        loaded: Array.from(next.keys()),
        v1Fallback: fallbackV1?.version,
        v2Fallback: next.get(modelKey('prematch_winner', 2))?.version,
        v3Fallback: next.get(modelKey('prematch_winner', 3))?.version,
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

/** Backward-compat: возвращает v1 fallback (или любую первую) из кеша. */
export function getActiveModel(): LoadedModel | null {
  return (
    cachedModels.get(modelKey('prematch_winner', 1)) ??
    cachedModels.get(modelKey('prematch_winner', 2)) ??
    cachedModels.values().next().value ??
    null
  );
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

async function refreshWave3Data(): Promise<void> {
  if (Date.now() - lastWave3Load < WAVE3_CACHE_TTL_MS && playerHeroStatsCache.size > 0) return;
  try {
    const [phs, form, h2hRows] = await Promise.all([
      db.select({
        accountId: playerHeroStatsTable.accountId,
        heroId: playerHeroStatsTable.heroId,
        games: playerHeroStatsTable.games,
        wins: playerHeroStatsTable.wins,
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
    ]);
    const phsMap: PlayerHeroStatsMap = new Map();
    for (const r of phs) {
      let inner = phsMap.get(r.accountId);
      if (!inner) { inner = new Map(); phsMap.set(r.accountId, inner); }
      inner.set(r.heroId, { games: r.games, wins: r.wins });
    }
    const formMap: RecentFormMap = new Map();
    for (const r of form) formMap.set(r.teamId, { winRate: r.winRate, games: r.games });
    const h2hMap: H2HMap = new Map();
    for (const r of h2hRows) {
      h2hMap.set(`${r.teamLowId}_${r.teamHighId}`, { games: r.games, winsLow: r.winsLow });
    }
    playerHeroStatsCache = phsMap;
    recentFormCache = formMap;
    h2hCache = h2hMap;
    lastWave3Load = Date.now();
    logger.info(
      { phsAccounts: phsMap.size, formTeams: formMap.size, h2hPairs: h2hMap.size },
      '[PredictionModel] Wave 3 data refreshed',
    );
  } catch (err) {
    logger.error({ err }, '[PredictionModel] Failed to load Wave 3 data');
  }
}

async function refreshHeroData(): Promise<void> {
  if (Date.now() - lastHeroLoad < HERO_CACHE_TTL_MS && heroStatsCache.size > 0) return;
  try {
    const [statRows, matchRows] = await Promise.all([
      db
        .select({
          heroId: heroStatsTable.heroId,
          proWinRate: heroStatsTable.proWinRate,
          proPickRate: heroStatsTable.proPickRate,
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
    ]);
    const stats: HeroStatsMap = new Map();
    for (const h of statRows) {
      stats.set(h.heroId, { proWinRate: h.proWinRate, proPickRate: h.proPickRate });
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
    heroStatsCache = stats;
    heroMatchupsCache = matchups;
    lastHeroLoad = Date.now();
    logger.info(
      { heroes: stats.size, matchupPairs: matchRows.length },
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
): number[] {
  const rGames = r.wins + r.losses;
  const dGames = d.wins + d.losses;
  return [
    1,
    (r.rating - d.rating) / 200,
    r.wins / rGames - d.wins / dGames,
    Math.log(rGames + 1) - Math.log(dGames + 1),
    rGames >= 50 && dGames >= 50 ? 1 : 0,
  ];
}

function pickModel(tier: Tier | null, fv: 1 | 2 | 3): LoadedModel | null {
  if (tier) {
    const tierModel = cachedModels.get(modelKey(tierKind(tier), fv));
    if (tierModel) return tierModel;
  }
  return cachedModels.get(modelKey('prematch_winner', fv)) ?? null;
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
  if (cachedModels.size === 0) return null;
  if (!radiantTeamId || !direTeamId) return null;

  const r = await getTeamRating(radiantTeamId);
  const d = await getTeamRating(direTeamId);
  if (!r || !d) return null;

  const rGames = r.wins + r.losses;
  const dGames = d.wins + d.losses;
  if (rGames < 5 || dGames < 5) return null;

  const tier = classifyTier(r.rating, d.rating);
  const teamFeats = buildTeamFeatures(r, d);

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
    });
    const v3Model = pickModel(tier, 3);
    if (v3Model && v3Model.weights.length === teamFeats.length + heroFeats.length + extraFeats.length) {
      model = v3Model;
      features = [...teamFeats, ...heroFeats, ...extraFeats];
      usedFv = 3;
    }
  }

  // v2 fallback
  if (!model && heroFeats) {
    const v2Model = pickModel(tier, 2);
    if (v2Model && v2Model.weights.length === teamFeats.length + heroFeats.length) {
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
      if (m.weights.length === teamFeats.length) {
        model = m;
        features = teamFeats;
        usedFv = m.featuresVersion;
        break;
      }
    }
  }

  if (!model) return null;
  if (model.weights.length !== features.length) {
    logger.warn(
      { modelVersion: model.version, modelDim: model.weights.length, featDim: features.length },
      '[PredictionModel] dim mismatch, refusing prediction',
    );
    return null;
  }

  let z = 0;
  for (let i = 0; i < features.length; i++) z += model.weights[i] * features[i];
  const rawProb = sigmoid(z);
  const calibrated = applyCalibration(rawProb, model.calibration);

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
