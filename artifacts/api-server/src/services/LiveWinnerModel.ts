/**
 * Загрузчик и инференс LIVE-модели победителя матча — FEATURES_VERSION 8 (dim=9).
 *
 * Фичи (должно совпадать с train-live-model.ts):
 *   x0 = 1                                    bias
 *   x1 = (gameTimeSec - 1800) / 1800          нормализованная минута
 *   x2 = radiantLead / 10000                  net worth преимущество
 *   x3 = (radiantScore - direScore) / 15      разница убийств
 *   x4 = towerDiff / 11                       разница башен
 *   x5 = logit(prematchProb)                  прематч как приор
 *   x6 = is_real_live                         1=live-polling, 0=backfill
 *   x7 = has_draft                            1=драфт известен
 *   x8 = recency_days_norm                    0=сейчас, отрицательное=старший матч
 *
 * При отсутствии активной live-модели в БД → возвращает null (вызывающий код
 * должен использовать прематч-вероятность как fallback).
 */

import { db, modelVersionsTable } from '@workspace/db';
import { eq, desc, and } from 'drizzle-orm';
import { logger } from '../lib/logger';

interface LoadedLiveModel {
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

let cached: LoadedLiveModel | null = null;

export async function loadActiveLiveModel(): Promise<LoadedLiveModel | null> {
  try {
    const rows = await db
      .select()
      .from(modelVersionsTable)
      .where(and(eq(modelVersionsTable.kind, 'live_winner'), eq(modelVersionsTable.isActive, true)))
      .orderBy(desc(modelVersionsTable.createdAt))
      .limit(1);

    if (rows.length === 0) {
      logger.info('[LiveWinnerModel] No active live model — will fallback to prematch prob.');
      cached = null;
      return null;
    }

    const m = rows[0];
    const w = m.weights as Record<string, number>;
    // Support both old (6-weight) and new (9-weight) models gracefully.
    cached = {
      version: m.version,
      algorithm: m.algorithm,
      weights: [
        w.w0 ?? 0, w.w1 ?? 0, w.w2 ?? 0, w.w3 ?? 0, w.w4 ?? 0, w.w5 ?? 0,
        w.w6 ?? 0, w.w7 ?? 0, w.w8 ?? 0,
      ],
      trainAccuracy: m.trainAccuracy ?? 0,
      testAccuracy: m.testAccuracy ?? 0,
      brierScore: m.brierScore ?? 0,
      trainSize: m.trainSampleSize ?? 0,
      testSize: m.testSampleSize ?? 0,
      loadedAt: new Date(),
      metadata: m.metadata ?? null,
    };
    const dim = (m.features as string[] | null)?.length ?? 6;
    logger.info(
      { version: m.version, testAcc: cached.testAccuracy, brier: cached.brierScore, dim },
      '[LiveWinnerModel] Active live model loaded',
    );
    return cached;
  } catch (err) {
    logger.error({ err }, '[LiveWinnerModel] Failed to load live model');
    return null;
  }
}

export function getActiveLiveModel(): LoadedLiveModel | null {
  return cached;
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
): { probRadiantWin: number; modelVersion: string; features: Record<string, number> } | null {
  if (!cached) return null;
  if (snap.gameTimeSec == null || snap.gameTimeSec < 60) return null;
  if (!Number.isFinite(prematchProb) || prematchProb <= 0 || prematchProb >= 1) return null;

  const towers = towerCountsFromBuildingState(snap.buildingState);
  const radiantLead = snap.radiantLead ?? 0;
  const killDiff = (snap.radiantScore ?? 0) - (snap.direScore ?? 0);
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
