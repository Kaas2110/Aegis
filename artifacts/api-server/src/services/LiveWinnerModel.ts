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
 */

import { db, modelVersionsTable } from '@workspace/db';
import { eq, desc, and } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { logger } from '../lib/logger';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_PREDICT_TIMEOUT_MS = Number(process.env.ML_PREDICT_TIMEOUT_MS ?? 200);
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';
const LIGHTGBM_BACKOFF_MS = 60_000;

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
  blobB64: string | null;    // lightgbm only
  weights: number[];         // logreg only [w0..w5]
  trainAccuracy: number;
  testAccuracy: number;
  brierScore: number;
  trainSize: number;
  testSize: number;
  loadedAt: Date;
  metadata: Record<string, unknown> | null;
}

// Prefer LGB; keep LR as fallback
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
  return {
    version: m.version,
    engine,
    algorithm,
    blobB64,
    weights: keys.map(k => wRaw[k] ?? 0),
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

    // Для live_winner предпочитаем LR: LGB требует ~2000+ уникальных матчей для
    // устойчивой калибровки (много коррелированных снапшотов). Переключить на
    // LGB-приоритет, когда trainSize > 10000.
    const shouldPreferLgbm = (cachedLgbm?.trainSize ?? 0) > 10_000;
    const primary = shouldPreferLgbm ? (cachedLgbm ?? cachedLr) : (cachedLr ?? cachedLgbm);
    if (!primary) {
      logger.info('[LiveWinnerModel] No active live model — will fallback to prematch prob.');
      return null;
    }

    logger.info(
      {
        version: primary.version,
        testAcc: primary.testAccuracy,
        brier: primary.brierScore,
        lgbm: cachedLgbm?.version ?? 'none',
        lr: cachedLr?.version ?? 'none',
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

function towerCountsFromBuildingState(bs: number | null | undefined): { r: number; d: number } {
  if (bs == null || !Number.isFinite(bs)) return { r: 11, d: 11 };
  let r = 0, d = 0;
  for (let i = 0; i < 11; i++) if (bs & (1 << i)) r++;
  for (let i = 11; i < 22; i++) if (bs & (1 << i)) d++;
  return { r, d };
}

export interface LiveSnapshotInput {
  gameTimeSec: number | null;
  radiantLead: number | null;
  radiantScore: number | null;
  direScore: number | null;
  buildingState: number | null;
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
  let z = 0;
  for (let i = 0; i < weights.length; i++) z += weights[i] * features[i];
  return sigmoid(z);
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

  const towers = towerCountsFromBuildingState(snap.buildingState);
  const radiantLead = snap.radiantLead ?? 0;
  const killDiff = (snap.radiantScore ?? 0) - (snap.direScore ?? 0);
  const towerDiff = towers.r - towers.d;

  const featureVec = [
    1,
    (snap.gameTimeSec - 1800) / 1800,
    radiantLead / 10000,
    killDiff / 15,
    towerDiff / 11,
    logit(prematchProb),
  ];

  const featuresNamed: Record<string, number> = {
    bias: featureVec[0],
    game_time_norm: featureVec[1],
    nw_lead_norm: featureVec[2],
    kill_diff_norm: featureVec[3],
    tower_diff_norm: featureVec[4],
    prematch_logit: featureVec[5],
  };

  // Try LGB primary
  if (cachedLgbm?.blobB64) {
    const p = await predictViaLgbm(cachedLgbm.blobB64, featureVec);
    if (p !== null) {
      return { probRadiantWin: p, modelVersion: cachedLgbm.version, engine: 'lightgbm', features: featuresNamed };
    }
  }

  // Fallback to LR
  const lrModel = cachedLr ?? (cachedLgbm?.engine === 'logreg' ? cachedLgbm : null);
  if (lrModel && lrModel.weights.length >= 6) {
    const p = predictViaLr(lrModel.weights, featureVec);
    return { probRadiantWin: p, modelVersion: lrModel.version, engine: 'logreg', features: featuresNamed };
  }

  return null;
}
