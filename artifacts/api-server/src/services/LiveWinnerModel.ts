/**
 * Загрузчик и инференс LIVE-модели победителя матча.
 *
 * Два движка (аналогично PredictionModel):
 *   - LightGBM (primary)  — inference через ml-service /predict, blob в памяти
 *   - LogReg   (fallback) — pure-JS sigmoid, без внешних зависимостей
 *
 * Circuit-breaker: при сбоях ml-service переходим на LR на 60 секунд.
 * При отсутствии любой live-модели → возвращаем null (вызывающий код
 * использует прематч-вероятность как fallback).
 *
 * Фичи (14, fv=6) — должны точно соответствовать train-live-model.ts:
 *   bias, game_time_norm, nw_lead_norm, kill_diff_norm,
 *   prematch_logit, kill_pace_norm,
 *   game_phase, nw_x_phase, kill_diff_x_phase, hero_advantage,
 *   nw_lead_per_min, kill_ratio, elo_diff_norm, form_diff
 */

import { db, modelVersionsTable } from '@workspace/db';
import { eq, desc, and } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { logger } from '../lib/logger';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_PREDICT_TIMEOUT_MS = Number(process.env.ML_PREDICT_TIMEOUT_MS ?? 200);
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';
const LIGHTGBM_BACKOFF_MS = 60_000;
const GLOBAL_KPM = 1.1;

// Feature names — must match training script exactly (fv=7, 16 features)
const LIVE_FEATURE_NAMES = [
  'bias',
  'game_time_norm',
  'nw_lead_norm',
  'kill_diff_norm',
  'prematch_logit',
  'kill_pace_norm',
  'game_phase',
  'nw_x_phase',
  'kill_diff_x_phase',
  'hero_advantage',
  'nw_lead_per_min',
  'kill_ratio',
  'elo_diff_norm',
  'form_diff',
  'power_spike_delta',
  'spike_x_nw',
] as const;
const LIVE_FEATURE_DIM = LIVE_FEATURE_NAMES.length;

// --- Circuit-breaker state ---
let lgbmDisabled = false;
let lgbmDisabledUntil = 0;

let _cachedToken: string | null = null;
function mlServiceToken(): string | null {
  if (_cachedToken) return _cachedToken;
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) { _cachedToken = env; return env; }
  try {
    const v = readFileSync(ML_TOKEN_FILE, 'utf8').trim();
    if (v) { _cachedToken = v; return v; }
  } catch { /* ignore */ }
  return null;
}

function lgbmAvailable(): boolean {
  if (!lgbmDisabled) return true;
  if (Date.now() >= lgbmDisabledUntil) { lgbmDisabled = false; return true; }
  return false;
}

function tripLgbm(reason: string): void {
  if (!lgbmDisabled) {
    logger.warn({ reason, backoffMs: LIGHTGBM_BACKOFF_MS }, '[LiveWinnerModel] tripping lgbm circuit-breaker');
  }
  lgbmDisabled = true;
  lgbmDisabledUntil = Date.now() + LIGHTGBM_BACKOFF_MS;
}

// --- Model state ---
interface LoadedLiveModel {
  version: string;
  engine: 'lightgbm' | 'logreg';
  algorithm: string;
  blobB64: string | null;
  weights: number[];
  featureDim: number;
  trainAccuracy: number;
  testAccuracy: number;
  brierScore: number;
  trainSize: number;
  testSize: number;
  loadedAt: Date;
  metadata: Record<string, unknown> | null;
}

let cachedLgbm: LoadedLiveModel | null = null;
let cachedLr: LoadedLiveModel | null = null;

function rowToModel(m: typeof modelVersionsTable.$inferSelect): LoadedLiveModel {
  const engine: 'lightgbm' | 'logreg' = m.engine === 'lightgbm' ? 'lightgbm' : 'logreg';
  const algorithm = m.algorithm ?? (engine === 'lightgbm' ? 'lightgbm_live' : 'logistic_regression_live');
  const wRaw = (m.weights ?? {}) as Record<string, number>;
  const blobRaw = m.binaryBlob as Buffer | Uint8Array | null;
  const blobB64 = blobRaw
    ? (Buffer.isBuffer(blobRaw) ? blobRaw : Buffer.from(blobRaw)).toString('base64')
    : null;
  const keys = Object.keys(wRaw).filter(k => /^w\d+$/.test(k))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const weights = keys.map(k => wRaw[k] ?? 0);

  const storedFeatures = (m.features as string[] | null) ?? [];
  const featureDim = storedFeatures.length > 0 ? storedFeatures.length : Math.max(weights.length, LIVE_FEATURE_DIM);

  return {
    version: m.version,
    engine,
    algorithm,
    blobB64,
    weights,
    featureDim,
    trainAccuracy: m.trainAccuracy ?? 0,
    testAccuracy: m.testAccuracy ?? 0,
    brierScore: m.brierScore ?? 0,
    trainSize: m.trainSampleSize ?? 0,
    testSize: m.testSampleSize ?? 0,
    loadedAt: new Date(),
    metadata: m.metadata ?? null,
  };
}

export async function loadActiveLiveModel(): Promise<LoadedLiveModel | null> {
  try {
    const rows = await db
      .select()
      .from(modelVersionsTable)
      .where(and(eq(modelVersionsTable.kind, 'live_winner'), eq(modelVersionsTable.isActive, true)))
      .orderBy(desc(modelVersionsTable.createdAt));

    cachedLgbm = null;
    cachedLr = null;

    for (const m of rows) {
      const model = rowToModel(m);
      if (model.engine === 'lightgbm' && !cachedLgbm) {
        cachedLgbm = model;
      } else if (model.engine === 'logreg' && !cachedLr) {
        cachedLr = model;
      }
    }

    // Primary выбирается по testAccuracy: LGB когда точнее LR, иначе LR.
    let primary: LoadedLiveModel | null;
    const lgbmAcc = cachedLgbm?.testAccuracy ?? 0;
    const lrAcc = cachedLr?.testAccuracy ?? 0;
    if (cachedLgbm && lgbmAcc >= lrAcc) {
      primary = cachedLgbm;
    } else {
      primary = cachedLr ?? cachedLgbm;
    }

    if (!primary) {
      logger.info('[LiveWinnerModel] No active live model — will fallback to prematch prob.');
      return null;
    }

    logger.info(
      {
        primary: primary.version,
        primaryEngine: primary.engine,
        primaryTestAcc: primary.testAccuracy.toFixed(4),
        featureDim: primary.featureDim,
        lgbm: cachedLgbm ? `${cachedLgbm.version} acc=${cachedLgbm.testAccuracy.toFixed(3)}` : 'none',
        lr: cachedLr ? `${cachedLr.version} acc=${cachedLr.testAccuracy.toFixed(3)}` : 'none',
        reason: cachedLgbm && lgbmAcc >= lrAcc ? 'lgbm_wins' : 'lr_wins',
      },
      '[LiveWinnerModel] Active live model loaded',
    );
    return primary;
  } catch (err) {
    logger.error({ err }, '[LiveWinnerModel] Failed to load live model');
    return null;
  }
}

export function getActiveLiveModel(): LoadedLiveModel | null {
  return cachedLgbm ?? cachedLr;
}

// --- Feature helpers ---
function sigmoid(z: number): number {
  if (z >= 0) { const ez = Math.exp(-z); return 1 / (1 + ez); }
  const ez = Math.exp(z); return ez / (1 + ez);
}

function logit(p: number): number {
  const eps = 1e-4;
  const q = Math.min(Math.max(p, eps), 1 - eps);
  return Math.log(q / (1 - q));
}

export interface LiveSnapshotInput {
  gameTimeSec: number | null;
  radiantLead: number | null;
  radiantScore: number | null;
  direScore: number | null;
  /** hero matchup advantage (вычисляется в LiveWorker, 0 если драфт неизвестен) */
  heroAdvantage?: number;
  /** (elo_r − elo_d) / 200; 0 если нет данных */
  eloDiffNorm?: number;
  /** form30_r − form30_d; 0 если нет данных */
  formDiff?: number;
  /** разность team spike scores (Gaussian, σ=8мин); 0 если нет драфта */
  powerSpikeDelta?: number;
  /** power_spike_delta × nw_lead_norm; 0 если нет драфта */
  spikeXNw?: number;
}

async function predictViaLgbm(blobB64: string, features: number[]): Promise<number | null> {
  if (!lgbmAvailable()) return null;
  const token = mlServiceToken();
  if (!token) { tripLgbm('no ML_SERVICE_TOKEN'); return null; }
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
      tripLgbm(`ml-service ${res.status}: ${body.slice(0, 120)}`);
      return null;
    }
    const data = (await res.json()) as { calibrated_prob: number };
    if (typeof data.calibrated_prob !== 'number') { tripLgbm('bad payload'); return null; }
    return data.calibrated_prob;
  } catch (e) {
    const reason = (e as Error).name === 'AbortError' ? `timeout ${ML_PREDICT_TIMEOUT_MS}ms` : (e as Error).message;
    tripLgbm(reason);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function predictViaLr(weights: number[], features: number[]): number {
  const dim = Math.min(weights.length, features.length);
  let z = 0;
  for (let i = 0; i < dim; i++) z += weights[i] * features[i];
  return sigmoid(z);
}

/**
 * Строит вектор фич для live-снапшота (14 фич, fv=6).
 * Должно точно совпадать с train-live-model.ts FEATURE_NAMES.
 *
 * Изменения vs fv=5 (12 фич):
 *   - r_towers_lost_ratio + d_towers_lost_ratio убраны (importance=0, 68.4% null)
 *   + nw_lead_per_min  — темп накопления NW (скорость, а не абсолютная величина)
 *   + kill_ratio       — доля убийств radiant (bounded [0,1])
 *   + elo_diff_norm    — (elo_r − elo_d) / 200
 *   + form_diff        — form30_r − form30_d
 * Балансировка 50/50 теперь на уровне данных (не только class_weight).
 */
function buildFeatureVec(
  snap: LiveSnapshotInput,
  prematchProb: number,
): { vec: number[]; named: Record<string, number> } {
  const gameTimeSec = snap.gameTimeSec!;
  const radiantLead = snap.radiantLead ?? 0;
  const radiantScore = snap.radiantScore ?? 0;
  const direScore = snap.direScore ?? 0;
  const killDiff = radiantScore - direScore;
  const totalKills = radiantScore + direScore;

  const gameTimeMins = gameTimeSec / 60;
  const killPaceNorm = gameTimeSec > 0
    ? (totalKills / gameTimeMins) / GLOBAL_KPM
    : 0;

  const gamePhase = Math.min(gameTimeSec / 3600, 1.0);
  const nwNorm = radiantLead / 10000;
  const killDiffNorm = killDiff / 15;
  const nwXPhase = nwNorm * gamePhase;
  const killXPhase = killDiffNorm * gamePhase;
  const prematchLogit = logit(prematchProb);

  const heroAdvantage = snap.heroAdvantage ?? 0;
  const nwLeadPerMin = gameTimeMins > 1 ? (radiantLead / gameTimeMins) / 1000 : 0;
  const killRatio = totalKills > 0 ? radiantScore / totalKills : 0.5;
  const eloDiffNorm = snap.eloDiffNorm ?? 0;
  const formDiff = snap.formDiff ?? 0;
  const powerSpikeDelta = snap.powerSpikeDelta ?? 0;
  const spikeXNw = snap.spikeXNw ?? 0;

  const vec = [
    1,                            // x0  bias
    (gameTimeSec - 1800) / 1800,  // x1  game_time_norm
    nwNorm,                       // x2  nw_lead_norm
    killDiffNorm,                 // x3  kill_diff_norm
    prematchLogit,                // x4  prematch_logit
    killPaceNorm,                 // x5  kill_pace_norm
    gamePhase,                    // x6  game_phase
    nwXPhase,                     // x7  nw_x_phase
    killXPhase,                   // x8  kill_diff_x_phase
    heroAdvantage,                // x9  hero_advantage
    nwLeadPerMin,                 // x10 nw_lead_per_min
    killRatio,                    // x11 kill_ratio
    eloDiffNorm,                  // x12 elo_diff_norm
    formDiff,                     // x13 form_diff
    powerSpikeDelta,              // x14 power_spike_delta
    spikeXNw,                     // x15 spike_x_nw
  ];

  const named: Record<string, number> = {};
  LIVE_FEATURE_NAMES.forEach((name, i) => { named[name] = vec[i]!; });
  return { vec, named };
}

/**
 * Считает P(radiant_win) с учётом текущего состояния матча и прематч-приора.
 * Возвращает null если нет модели или снапшот не валиден (game_time < 60).
 */
export async function predictLiveWinner(
  snap: LiveSnapshotInput,
  prematchProb: number,
): Promise<{ probRadiantWin: number; modelVersion: string; engine: string; features: Record<string, number> } | null> {
  if (snap.gameTimeSec == null || snap.gameTimeSec < 60) return null;
  if (!Number.isFinite(prematchProb) || prematchProb <= 0 || prematchProb >= 1) return null;

  const { vec, named } = buildFeatureVec(snap, prematchProb);

  // Try LGB primary (circuit-breaker trips to LR on ml-service failure)
  if (cachedLgbm?.blobB64) {
    // Проверяем совместимость по размерности — legacy модели (fv=4, 10 фич) уже не используем
    if (cachedLgbm.featureDim === vec.length) {
      const p = await predictViaLgbm(cachedLgbm.blobB64, vec);
      if (p !== null) {
        return { probRadiantWin: p, modelVersion: cachedLgbm.version, engine: 'lightgbm', features: named };
      }
    }
  }

  // Fallback: LR hot-standby — works without ml-service
  const lrModel = cachedLr ?? (cachedLgbm?.engine === 'logreg' ? cachedLgbm : null);
  if (lrModel && lrModel.weights.length > 0) {
    const p = predictViaLr(lrModel.weights, vec);
    return { probRadiantWin: p, modelVersion: lrModel.version, engine: 'logreg', features: named };
  }

  return null;
}
