/**
 * Обучение LIVE-модели победителя матча — FEATURES_VERSION 8 (dim=9).
 *
 * Фичи:
 *   x0 = 1                                    bias
 *   x1 = (gameTimeSec - 1800) / 1800          нормализованная минута
 *   x2 = radiantLead / 10000                  net worth преимущество
 *   x3 = (radiantScore - direScore) / 15      разница убийств
 *   x4 = towerDiff / 11                       разница башен
 *   x5 = logit(prematchProb)                  прематч как приор
 *   x6 = is_real_live                         1=live-polling, 0=backfill
 *   x7 = has_draft                            1=драфт известен
 *   x8 = recency_days_norm                    -(дней с матча)/365 (0=сейчас)
 *
 * Сплит: по матчам, хронологический (startTime), с 1-суточным зазором
 * между train/test во избежание утечки данных в пограничных матчах.
 *
 * Чемпион: выводится composite score = brier + 0.3 * logLoss.
 */

import { db, modelVersionsTable } from '@workspace/db';
import { sql, and, eq } from 'drizzle-orm';
import { assertCandidateOnlyArgs, saveLegacyCandidates } from './lib/training-candidates';
import { trainingSeed, seededRandom, shuffleInPlace } from './lib/training-random';

const FEATURES_VERSION = 8;
const TRAINING_SEED = trainingSeed();
const DIM = 9;

interface Sample {
  features: number[];
  label: number;
  matchId: number;
  bucket: number;
  startTime: number;
}

const EPOCHS = 200;
const LR = 0.05;
const L2 = 0.001;

function towerCountsFromBuildingState(bs: number | null | undefined): { r: number; d: number } {
  if (bs == null || !Number.isFinite(bs)) return { r: 11, d: 11 };
  let r = 0, d = 0;
  for (let i = 0; i < 11; i++) if (bs & (1 << i)) r++;
  for (let i = 11; i < 22; i++) if (bs & (1 << i)) d++;
  return { r, d };
}

function logit(p: number): number {
  const eps = 1e-4;
  const q = Math.min(Math.max(p, eps), 1 - eps);
  return Math.log(q / (1 - q));
}

function sigmoid(z: number): number {
  if (z >= 0) { const ez = Math.exp(-z); return 1 / (1 + ez); }
  const ez = Math.exp(z); return ez / (1 + ez);
}

function dot(w: number[], x: number[]): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

function trainLogisticRegression(samples: Sample[], dim: number): number[] {
  const random = seededRandom(TRAINING_SEED);
  const w = new Array(dim).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    let totalLoss = 0;
    shuffleInPlace(samples, random);
    for (const s of samples) {
      const z = dot(w, s.features);
      const p = sigmoid(z);
      const err = p - s.label;
      for (let i = 0; i < dim; i++) {
        const grad = err * s.features[i] + (i === 0 ? 0 : L2 * w[i]);
        w[i] -= LR * grad;
      }
      const eps = 1e-9;
      totalLoss += -(s.label * Math.log(p + eps) + (1 - s.label) * Math.log(1 - p + eps));
    }
    if ((epoch + 1) % 20 === 0) {
      console.log(`  epoch ${epoch + 1}/${EPOCHS} loss=${(totalLoss / samples.length).toFixed(4)}`);
    }
  }
  return w;
}

function evaluate(samples: Sample[], w: number[]): { acc: number; logLoss: number; brier: number; composite: number } {
  let correct = 0, logLoss = 0, brier = 0;
  for (const s of samples) {
    const p = sigmoid(dot(w, s.features));
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === s.label) correct++;
    const eps = 1e-9;
    logLoss += -(s.label * Math.log(p + eps) + (1 - s.label) * Math.log(1 - p + eps));
    brier += (p - s.label) ** 2;
  }
  const n = samples.length;
  const b = brier / n, ll = logLoss / n;
  return { acc: correct / n, logLoss: ll, brier: b, composite: b + 0.3 * ll };
}

async function main() {
  assertCandidateOnlyArgs();
  console.log('[train-live-model] Joining live_snapshots × prematch_outcomes (fv=8) …');

  const nowUnix = Math.floor(Date.now() / 1000);

  const rows = await db.execute(sql`
    SELECT
      ls.match_id          AS "matchId",
      ls.game_time_sec     AS "gameTimeSec",
      ls.radiant_lead      AS "radiantLead",
      ls.radiant_score     AS "radiantScore",
      ls.dire_score        AS "direScore",
      ls.building_state    AS "buildingState",
      ls.source            AS "source",
      pm.start_time        AS "startTime",
      COALESCE(po.predicted_radiant_win_prob, 0.5) AS "prematchProb",
      COALESCE(po.actual_radiant_win, pm.radiant_win) AS "actualRadiantWin",
      CASE WHEN md.match_id IS NOT NULL THEN 1 ELSE 0 END AS "hasDraft"
    FROM live_snapshots ls
    INNER JOIN pro_matches pm ON pm.match_id = ls.match_id
    LEFT JOIN prematch_outcomes po ON po.match_id = ls.match_id
    LEFT JOIN match_drafts md ON md.match_id = ls.match_id
    WHERE pm.radiant_win IS NOT NULL
      AND ls.source = 'live'
      AND ls.game_time_sec IS NOT NULL
      AND ls.game_time_sec >= 60
      AND ls.game_time_sec <= 7200
      AND ls.game_time_sec < pm.duration
    ORDER BY pm.start_time ASC, ls.match_id, ls.game_time_sec, ls.captured_at
    LIMIT 200000
  `);

  console.log(`[train-live-model] Joined ${rows.rows.length} snapshot rows`);

  if (rows.rows.length < 50) {
    console.error(
      '[train-live-model] Not enough joined data (need 50+ resolved snapshots).\n' +
      '  Запусти переобучение через 1-2 недели работы воркеров.',
    );
    process.exit(0);
  }

  const seenBuckets = new Set<string>();
  const samples: Sample[] = [];
  const matchStartTimes = new Map<number, number>();

  const toNum = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  for (const raw of rows.rows as unknown as Record<string, unknown>[]) {
    const matchId = toNum(raw.matchId);
    const gameTimeSec = toNum(raw.gameTimeSec);
    const prematchProb = toNum(raw.prematchProb);
    const startTime = toNum(raw.startTime) ?? 0;
    if (matchId == null || gameTimeSec == null || prematchProb == null) continue;
    if (prematchProb <= 0 || prematchProb >= 1) continue;

    const bucket = Math.floor(gameTimeSec / 180);
    const key = `${matchId}:${bucket}`;
    if (seenBuckets.has(key)) continue;
    seenBuckets.add(key);

    matchStartTimes.set(matchId, startTime);

    const towers = towerCountsFromBuildingState(toNum(raw.buildingState));
    const radiantLead = toNum(raw.radiantLead) ?? 0;
    const killDiff = (toNum(raw.radiantScore) ?? 0) - (toNum(raw.direScore) ?? 0);
    const towerDiff = towers.r - towers.d;
    const isRealLive = String(raw.source) === 'live' ? 1 : 0;
    const hasDraft = toNum(raw.hasDraft) ?? 0;
    const recencyDaysNorm = (startTime - nowUnix) / (365 * 86400); // negative = past match

    const x = [
      1,
      (gameTimeSec - 1800) / 1800,
      radiantLead / 10000,
      killDiff / 15,
      towerDiff / 11,
      logit(prematchProb),
      isRealLive,
      hasDraft,
      recencyDaysNorm,
    ];
    samples.push({
      features: x,
      label: raw.actualRadiantWin ? 1 : 0,
      matchId,
      bucket,
      startTime,
    });
  }

  console.log(`[train-live-model] After bucket sampling: ${samples.length} examples (dim=${DIM})`);

  if (samples.length < 50) {
    console.error('[train-live-model] Not enough sampled data.');
    process.exit(0);
  }

  // Хронологический сплит по матчам с 1-суточным зазором для предотвращения
  // утечки данных в матчах на границе сплита.
  const allMatches = Array.from(
    new Set(samples.map(s => s.matchId)),
    id => ({ id, startTime: matchStartTimes.get(id) ?? 0 }),
  );
  allMatches.sort((a, b) => a.startTime - b.startTime);

  const splitIdx = Math.floor(allMatches.length * 0.8);
  const splitTime = allMatches[splitIdx]?.startTime ?? 0;
  const gapSec = 86400; // 1 день

  const trainMatchSet = new Set(
    allMatches.filter(m => m.startTime <= splitTime - gapSec).map(m => m.id),
  );
  const testMatchSet = new Set(
    allMatches.filter(m => m.startTime > splitTime).map(m => m.id),
  );

  const train = samples.filter(s => trainMatchSet.has(s.matchId));
  const test = samples.filter(s => testMatchSet.has(s.matchId));
  console.log(`[train-live-model] Matches train/test: ${trainMatchSet.size}/${testMatchSet.size} (gap=${gapSec}s)`);
  console.log(`[train-live-model] Samples  train/test: ${train.length}/${test.length}`);

  if (train.length < 30 || test.length < 5) {
    console.error('[train-live-model] Too few samples after temporal split.');
    process.exit(0);
  }

  console.log('[train-live-model] Training logistic regression …');
  const w = trainLogisticRegression([...train], DIM);
  console.log('[train-live-model] Weights:', w.map(x => x.toFixed(4)));

  const trainMetrics = evaluate(train, w);
  const testMetrics = evaluate(test, w);
  console.log(
    `[train-live-model] TRAIN  acc=${(trainMetrics.acc * 100).toFixed(2)}%  logloss=${trainMetrics.logLoss.toFixed(4)}  brier=${trainMetrics.brier.toFixed(4)}  composite=${trainMetrics.composite.toFixed(4)}`,
  );
  console.log(
    `[train-live-model] TEST   acc=${(testMetrics.acc * 100).toFixed(2)}%  logloss=${testMetrics.logLoss.toFixed(4)}  brier=${testMetrics.brier.toFixed(4)}  composite=${testMetrics.composite.toFixed(4)}`,
  );

  // Baseline: только прематч-прогноз
  let baselineCorrect = 0, baselineBrier = 0;
  for (const s of test) {
    const prematchProb = sigmoid(s.features[5]);
    if ((prematchProb >= 0.5 ? 1 : 0) === s.label) baselineCorrect++;
    baselineBrier += (prematchProb - s.label) ** 2;
  }
  const baselineAcc = baselineCorrect / test.length;
  const baselineBrierAvg = baselineBrier / test.length;
  console.log(
    `[train-live-model] Baseline (только прематч): acc=${(baselineAcc * 100).toFixed(2)}%  brier=${baselineBrierAvg.toFixed(4)}`,
  );
  console.log(
    `[train-live-model] Live model lift: Δacc=${((testMetrics.acc - baselineAcc) * 100).toFixed(2)}pp  Δbrier=${(baselineBrierAvg - testMetrics.brier).toFixed(4)}`,
  );

  const version = `lr-live-v${FEATURES_VERSION}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  console.log(`[train-live-model] Saving as ${version} …`);

  const weights: Record<string, number> = {};
  for (let i = 0; i < w.length; i++) weights[`w${i}`] = w[i];

  await saveLegacyCandidates(db, [{
      version,
      kind: 'live_winner',
      featuresVersion: FEATURES_VERSION,
      algorithm: 'logistic_regression_live',
      engine: 'logreg',
      features: [
        'bias', 'game_time_norm', 'nw_lead_norm', 'kill_diff_norm', 'tower_diff_norm',
        'prematch_logit', 'is_real_live', 'has_draft', 'recency_days_norm',
      ],
      weights,
      trainAccuracy: trainMetrics.acc,
      testAccuracy: testMetrics.acc,
      brierScore: testMetrics.brier,
      trainSampleSize: train.length,
      testSampleSize: test.length,
      metadata: {
        featuresVersion: FEATURES_VERSION,
        dim: DIM,
        logLossTrain: trainMetrics.logLoss,
        logLossTest: testMetrics.logLoss,
        compositeScoreTrain: trainMetrics.composite,
        compositeScoreTest: testMetrics.composite,
        baselineAcc,
        baselineBrier: baselineBrierAvg,
        liftAcc: testMetrics.acc - baselineAcc,
        liftBrier: baselineBrierAvg - testMetrics.brier,
        epochs: EPOCHS,
        learningRate: LR,
        l2: L2,
        matchesTrain: trainMatchSet.size,
        matchesTest: testMatchSet.size,
        gapSeconds: gapSec,
        bucketingSeconds: 180,
      },
      isActive: false,
    }], {
    trainer: 'train-live-model', seed: TRAINING_SEED,
    limitations: ['historical_prematch_prior_provenance_unverified', 'independent_calibration_required', 'live_source_only'],
  });

  console.log(`[train-live-model] Inactive, unvalidated candidate ${version} saved (fv=${FEATURES_VERSION}); active models unchanged.`);
  process.exit(0);
}

main().catch(err => {
  console.error('[train-live-model] FATAL', err);
  process.exit(1);
});
