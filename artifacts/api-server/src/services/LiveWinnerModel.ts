/**
 * Загрузчик и инференс LIVE-модели победителя матча — FEATURES_VERSION 8 (dim=9).
 *
 * Фичи (должно совпадать с train-live-model.ts):
 *   x0 = 1                                    bias
 *   x1 = (gameTimeSec - 1800) / 1800          нормализованная минута
 *   x2 = radiantLead / 10000                  raw provider lead (legacy name nw_lead_norm)
 *   x3 = (radiantScore - direScore) / 15      разница убийств
 *   x4 = towerDiff / 11                       разница башен
 *   x5 = logit(prematchProb)                  прематч как приор
 *   x6 = is_real_live                         1=live-polling, 0=backfill
 *   x7 = has_draft                            1=драфт известен
 *   x8 = recency_days_norm                    0=сейчас, отрицательное=старший матч
 *
 * Без проверенного serving-контракта возвращает null; прежняя строка БД
 * сохраняется для диагностики. Публичный live не подменяется прематчем.
 */

import { db, modelVersionsTable } from '@workspace/db';
import { eq, desc, and } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { LiveRegistryCache, validateLegacyLiveArtifact } from './liveWinnerRegistryGuard';
import { hasRequiredLiveWinnerFields } from './liveWinnerRequiredInputs';
import { validateLegacyLiveServingAdmission } from './legacyLiveServingAdmission';

import {evidenceHash, predictionEvidence, type PredictionEvidence} from '../lib/predictionEvidence';
const JOURNAL_FEATURE_NAMES = ['bias','game_time_norm','provider_lead_norm','kill_diff_norm','legacy_tower_diff_norm','prematch_logit','is_real_live','has_draft','recency_days_norm'];

interface LoadedLiveModel {
  artifactHash: string;
  version: string;
  algorithm: string;
  weights: number[]; // [w0..w8]
  trainAccuracy: number;
  testAccuracy: number;
  brierScore: number;
  trainSize: number;
  testSize: number;
  loadedAt: Date;
  metadata: Record<string, unknown> | null;
}

const activeCache = new LiveRegistryCache<LoadedLiveModel>();
type LegacyLiveDiagnostic = {version: string | null; status: 'not_loaded' | 'unavailable' | 'rejected' | 'admitted'; reason: string | null; approvalId?: string};
let legacyDiagnostic: LegacyLiveDiagnostic = {version: null, status: 'not_loaded', reason: null};
/** Diagnostics only; does not expose weights or turn a rejected row into a model. */
export function getLegacyLiveModelDiagnostic(): LegacyLiveDiagnostic { return {...legacyDiagnostic}; }


export async function loadActiveLiveModel(): Promise<LoadedLiveModel | null> {
  const reload = activeCache.beginReload();
  try {
    const rows = await db
      .select()
      .from(modelVersionsTable)
      .where(and(eq(modelVersionsTable.kind, 'live_winner'), eq(modelVersionsTable.isActive, true)))
      .orderBy(desc(modelVersionsTable.createdAt))
      .limit(1);

    if (rows.length === 0) {
      if (activeCache.finishReload(reload, null)) {
        legacyDiagnostic = {version: null, status: 'unavailable', reason: 'no_active_live_model'};
        logger.info('[LiveWinnerModel] No admitted live model; live map estimate unavailable.');
      }
      return activeCache.get();
    }

    const m = rows[0];
    const validation = validateLegacyLiveArtifact(m);
    if (!validation.ok) {
      if (activeCache.finishReload(reload, null)) {
        legacyDiagnostic = {version: m.version, status: 'rejected', reason: validation.reason};
        logger.warn({ version: m.version, engine: m.engine, reason: validation.reason },
          '[LiveWinnerModel] Active row is unsupported by the legacy live loader');
      }
      return activeCache.get();
    }
    const admission = validateLegacyLiveServingAdmission(m);
    if (!admission.ok) {
      if (activeCache.finishReload(reload, null)) {
        legacyDiagnostic = {version: m.version, status: 'rejected', reason: admission.reason};
        logger.warn({version: m.version, reason: admission.reason},
          '[LiveWinnerModel] Legacy artifact retained in registry but not admitted for live serving');
      }
      return activeCache.get();
    }
    const w = m.weights as Record<string, number>;
    // Preserve the confirmed six/nine-weight logistic contracts only.
    const loaded: LoadedLiveModel = {
      artifactHash: evidenceHash({engine:'logreg',weights:w,features:JOURNAL_FEATURE_NAMES}),
      version: m.version,
      algorithm: m.algorithm,
      weights: validation.weights,
      trainAccuracy: m.trainAccuracy ?? 0,
      testAccuracy: m.testAccuracy ?? 0,
      brierScore: m.brierScore ?? 0,
      trainSize: m.trainSampleSize ?? 0,
      testSize: m.testSampleSize ?? 0,
      loadedAt: new Date(),
      metadata: m.metadata ?? null,
    };
    if (activeCache.finishReload(reload, loaded)) {
      legacyDiagnostic = {version: m.version, status: 'admitted', reason: null, approvalId: admission.approvalId};
      logger.info(
        { version: m.version, testAcc: loaded.testAccuracy, brier: loaded.brierScore, dim: validation.dimensions },
        '[LiveWinnerModel] Active live model loaded',
      );
    }
    return activeCache.get();
  } catch (err) {
    if (activeCache.failReload(reload)) {
      legacyDiagnostic = {version: null, status: 'unavailable', reason: 'live_registry_read_failed'};
      logger.error({ err }, '[LiveWinnerModel] Failed to load live model; cache cleared');
    }
    return null;
  }
}

export function getActiveLiveModel(): LoadedLiveModel | null {
  return activeCache.get();
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function logit(p: number): number {
  const eps = 1e-4;
  const q = Math.min(Math.max(p, eps), 1 - eps);
  return Math.log(q / (1 - q));
}

// Должно совпадать с логикой в train-live-model.ts.
function towerCountsFromBuildingState(bs: number): { r: number; d: number } {
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
  /** 1 если снапшот пришёл из live-поллинга (не backfill); default 1 */
  isRealLive?: number;
  /** 1 если к моменту предсказания был известен драфт обеих команд; default 0 */
  hasDraft?: number;
  /** -(дней с начала матча)/365; 0 = прямо сейчас, отрицательное = прошлый матч */
  recencyDaysNorm?: number;
}

/**
 * Считает P(radiant_win) с учётом текущего состояния матча и прематч-приора.
 * Возвращает null если модель не загружена или снапшот не валиден (game_time < 60
 * → драфт-фаза, для неё используем прематч).
 *
 * Обратно совместим со старыми 6-весовыми моделями: x6/x7/x8 тогда умножаются
 * на w6=w7=w8=0, т.е. не влияют.
 */
export function predictLiveWinner(
  snap: LiveSnapshotInput,
  prematchProb: number,
): { probRadiantWin: number; modelVersion: string; evidence: PredictionEvidence; features: Record<string, number> } | null {
  const cached = activeCache.get();
  if (!cached) return null;
  if (!hasRequiredLiveWinnerFields(snap)) return null;
  if (!Number.isFinite(prematchProb) || prematchProb <= 0 || prematchProb >= 1) return null;

  const towers = towerCountsFromBuildingState(snap.buildingState);
  const radiantLead = snap.radiantLead;
  const killDiff = snap.radiantScore - snap.direScore;
  const towerDiff = towers.r - towers.d;

  const x: number[] = [
    1,
    (snap.gameTimeSec - 1800) / 1800,
    radiantLead / 10000,
    killDiff / 15,
    towerDiff / 11,
    logit(prematchProb),
    snap.isRealLive ?? 1,
    snap.hasDraft ?? 0,
    snap.recencyDaysNorm ?? 0,
  ];

  const w = cached.weights;
  let z = 0;
  // Use only as many weights as the model has (backward-compat with fv<8 models).
  const dim = Math.min(x.length, w.length);
  for (let i = 0; i < dim; i++) z += w[i] * x[i];
  const p = sigmoid(z);

  return {
    probRadiantWin: p,
    evidence: predictionEvidence(cached.artifactHash, JOURNAL_FEATURE_NAMES.slice(0,dim), x.slice(0,dim)),
    modelVersion: cached.version,
    features: {
      bias: x[0],
      game_time_norm: x[1],
      nw_lead_norm: x[2],
      kill_diff_norm: x[3],
      tower_diff_norm: x[4],
      prematch_logit: x[5],
      is_real_live: x[6],
      has_draft: x[7],
      recency_days_norm: x[8],
    },
  };
}
