/**
 * Этап C — ASYM live-winner loader/inference (kind='live_winner_asym', fv=1).
 *
 * Контракт фичей идентичен main live (9 фич, см. train-asym-live.ts). Эта
 * модель применяется ТОЛЬКО на asym-eligible матчах (см. AsymPrematchModel.
 * isAsymEligible): обе/одна команда tier-3 + есть драфт с account_ids.
 *
 * LiveWorker сам решает, какую модель применить (asym vs main). При отсутствии
 * активной asym-live в БД — `loadActiveAsymLiveModel()` возвращает null,
 * `predictAsymLiveWinner()` возвращает null, и вызывающий код должен
 * использовать main `predictLiveWinner()` как fallback.
 */

import { db, modelVersionsTable } from '@workspace/db';
import { eq, desc, and } from 'drizzle-orm';
import { logger } from '../lib/logger';

import {evidenceHash, predictionEvidence, type PredictionEvidence} from '../lib/predictionEvidence';
const JOURNAL_FEATURE_NAMES = ['bias','game_time_norm','provider_lead_norm','kill_diff_norm','legacy_tower_diff_norm','prematch_logit','is_real_live','has_draft','recency_days_norm'];

interface LoadedAsymLiveModel {
  artifactHash: string;
  version: string;
  algorithm: string;
  weights: number[];
  trainAccuracy: number;
  testAccuracy: number;
  brierScore: number;
  trainSize: number;
  testSize: number;
  loadedAt: Date;
  metadata: Record<string, unknown> | null;
}

let cached: LoadedAsymLiveModel | null = null;

export async function loadActiveAsymLiveModel(): Promise<LoadedAsymLiveModel | null> {
  try {
    const rows = await db
      .select()
      .from(modelVersionsTable)
      .where(and(
        eq(modelVersionsTable.kind, 'live_winner_asym'),
        eq(modelVersionsTable.isActive, true),
      ))
      .orderBy(desc(modelVersionsTable.createdAt))
      .limit(1);

    if (rows.length === 0) {
      logger.info('[AsymLiveModel] No active asym-live model — will fallback to main live.');
      cached = null;
      return null;
    }

    const m = rows[0];
    const w = m.weights as Record<string, number>;
    cached = {
      artifactHash: evidenceHash({engine:'logreg',weights:w,features:JOURNAL_FEATURE_NAMES}),
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
    const dim = (m.features as string[] | null)?.length ?? 9;
    logger.info(
      { version: m.version, testAcc: cached.testAccuracy, brier: cached.brierScore, dim },
      '[AsymLiveModel] Active asym-live model loaded',
    );
    return cached;
  } catch (err) {
    logger.error({ err }, '[AsymLiveModel] Failed to load asym-live model');
    return null;
  }
}

export function getActiveAsymLiveModel(): LoadedAsymLiveModel | null {
  return cached;
}

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

export interface AsymLiveSnapshotInput {
  gameTimeSec: number | null;
  radiantLead: number | null;
  radiantScore: number | null;
  direScore: number | null;
  buildingState: number | null;
  isRealLive?: number;
  hasDraft?: number;
  recencyDaysNorm?: number;
}

/**
 * Считает P(radiant_win) на asym-эпизоде (mirror predictLiveWinner). Возвращает
 * null если модель не загружена / снапшот не валиден / prematchProb выродился.
 * Вызывающий код должен заранее убедиться, что матч asym-eligible.
 */
export function predictAsymLiveWinner(
  snap: AsymLiveSnapshotInput,
  prematchProb: number,
): { probRadiantWin: number; modelVersion: string; evidence: PredictionEvidence; features: Record<string, number> } | null {
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
    snap.hasDraft ?? 1,
    snap.recencyDaysNorm ?? 0,
  ];

  const w = cached.weights;
  let z = 0;
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
