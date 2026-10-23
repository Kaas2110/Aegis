/**
 * Этап C — тренировка ASYM live-winner модели (kind='live_winner_asym', fv=1).
 *
 * Зачем: main live-модель (`train-live-model.ts`, kind='live_winner') обучается
 * на ВСЕХ live_snapshots × prematch_outcomes. На tier-3 / новых командах prematch
 * prior (x5 = logit(prematchProb)) часто = logit(0.5) ≈ 0 → live-модель почти
 * не получает приор и проседает acc. Asym-prematch (Этап B) даёт куда более
 * информативный prior для таких матчей; asym-live учится корректировать его
 * текущим состоянием матча на ИМЕННО asym-эпизодах.
 *
 * Контракт фичей идентичен main live (dim=9, LIVE_WINNER_ASYM=1):
 *   x0 = bias
 *   x1 = (gameTimeSec - 1800) / 1800
 *   x2 = radiantLead / 10000
 *   x3 = (radiantScore - direScore) / 15
 *   x4 = towerDiff / 11
 *   x5 = logit(prematchProb)         — в asym sample'ах это уже asym prior, иначе v3
 *   x6 = is_real_live                — 1=live polling, 0=backfill
 *   x7 = has_draft                   — для asym фильтра всегда 1
 *   x8 = recency_days_norm
 *
 * Eligibility (mirror runtime AsymPrematchModel.isAsymEligible):
 *   games_in_prior_180d у радианта<5 ИЛИ у дайра<5  ── as-of по pro_matches
 *   AND match_drafts row есть
 *   AND радиант ИЛИ дайр имеет account_ids
 *
 * Сплит: по матчам, хронологический (startTime) с 1-суточным gap'ом.
 * Не запускаем здесь обучение без явного «да» пользователя.
 */

import {
  db,
  modelVersionsTable,
  proMatchesTable,
  matchDraftsTable,
} from '@workspace/db';
import { sql, and, eq, asc } from 'drizzle-orm';
import { assertCandidateOnlyArgs, saveLegacyCandidates } from './lib/training-candidates';
import { trainingSeed, seededRandom, shuffleInPlace } from './lib/training-random';

const FEATURES_VERSION = 1; // LIVE_WINNER_ASYM=1
const TRAINING_SEED = trainingSeed();
const DIM = 9;
const ASYM_PRIOR_DAYS = 180;
const TEAM_GAMES_THRESHOLD = 5;
const MIN_SAMPLES = 80;

const EPOCHS = 200;
const LR = 0.05;
const L2 = 0.001;

interface Sample {
  features: number[];
  label: number;
  matchId: number;
  bucket: number;
  startTime: number;
}

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
  const n = samples.length || 1;
  const b = brier / n, ll = logLoss / n;
  return { acc: correct / n, logLoss: ll, brier: b, composite: b + 0.3 * ll };
}

async function main() {
  assertCandidateOnlyArgs();
  console.log('[train-asym-live] Computing as-of games_180d for ASYM eligibility …');

  // Полный history pro_matches для sliding-window asof.
  const allMatches = await db.select({
    matchId: proMatchesTable.matchId,
    radiantTeamId: proMatchesTable.radiantTeamId,
    direTeamId: proMatchesTable.direTeamId,
    startTime: proMatchesTable.startTime,
  }).from(proMatchesTable).orderBy(asc(proMatchesTable.startTime));

  const recentByTeam = new Map<number, number[]>();
  const games180dByMatch = new Map<number, { r: number; d: number }>();
  const WINDOW = ASYM_PRIOR_DAYS * 86_400;
  for (const m of allMatches) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const cutoff = m.startTime - WINDOW;
    const rArr = recentByTeam.get(m.radiantTeamId) ?? [];
    const dArr = recentByTeam.get(m.direTeamId) ?? [];
    while (rArr.length && rArr[0] < cutoff) rArr.shift();
    while (dArr.length && dArr[0] < cutoff) dArr.shift();
    games180dByMatch.set(m.matchId, { r: rArr.length, d: dArr.length });
    rArr.push(m.startTime); recentByTeam.set(m.radiantTeamId, rArr);
    dArr.push(m.startTime); recentByTeam.set(m.direTeamId, dArr);
  }
  console.log(`[train-asym-live] as-of games_180d computed for ${games180dByMatch.size} matches`);

  // Драфты — для has_account_ids фильтра.
  const draftsRows = await db.select({
    matchId: matchDraftsTable.matchId,
    radiantAccountIds: matchDraftsTable.radiantAccountIds,
    direAccountIds: matchDraftsTable.direAccountIds,
  }).from(matchDraftsTable);
  const hasAcc = new Map<number, boolean>();
  for (const d of draftsRows) {
    const r = (d.radiantAccountIds as number[] | null) ?? null;
    const dd = (d.direAccountIds as number[] | null) ?? null;
    hasAcc.set(d.matchId, !!(r?.length || dd?.length));
  }
  console.log(`[train-asym-live] drafts loaded: ${hasAcc.size}`);

  // Live snapshots × prematch_outcomes (mirror train-live-model.ts).
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
  console.log(`[train-asym-live] joined ${rows.rows.length} snapshot rows (pre-asym filter)`);

  const seen = new Set<string>();
  const samples: Sample[] = [];
  const matchStart = new Map<number, number>();
  let skipNotAsym = 0, skipNoDraft = 0, skipNoAcc = 0, skipBadProb = 0;

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
    if (prematchProb <= 0 || prematchProb >= 1) { skipBadProb++; continue; }

    const g = games180dByMatch.get(matchId);
    if (!g) continue;
    if (g.r >= TEAM_GAMES_THRESHOLD && g.d >= TEAM_GAMES_THRESHOLD) { skipNotAsym++; continue; }

    const hasDraftFlag = toNum(raw.hasDraft) ?? 0;
    if (!hasDraftFlag) { skipNoDraft++; continue; }
    if (!hasAcc.get(matchId)) { skipNoAcc++; continue; }

    const bucket = Math.floor(gameTimeSec / 180);
    const key = `${matchId}:${bucket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matchStart.set(matchId, startTime);

    const towers = towerCountsFromBuildingState(toNum(raw.buildingState));
    const radiantLead = toNum(raw.radiantLead) ?? 0;
    const killDiff = (toNum(raw.radiantScore) ?? 0) - (toNum(raw.direScore) ?? 0);
    const towerDiff = towers.r - towers.d;
    const isRealLive = String(raw.source) === 'live' ? 1 : 0;
    const recencyDaysNorm = (startTime - nowUnix) / (365 * 86400);

    samples.push({
      features: [
        1,
        (gameTimeSec - 1800) / 1800,
        radiantLead / 10000,
        killDiff / 15,
        towerDiff / 11,
        logit(prematchProb),
        isRealLive,
        1, // has_draft (фильтр гарантирует)
        recencyDaysNorm,
      ],
      label: raw.actualRadiantWin ? 1 : 0,
      matchId,
      bucket,
      startTime,
    });
  }

  console.log(
    `[train-asym-live] asym samples=${samples.length} ` +
    `(skip: not_asym=${skipNotAsym} no_draft=${skipNoDraft} no_acc=${skipNoAcc} bad_prob=${skipBadProb}) dim=${DIM}`,
  );
  if (samples.length < MIN_SAMPLES) {
    console.error(`[train-asym-live] Not enough asym samples (need ${MIN_SAMPLES}+).`);
    process.exit(0);
  }

  // Хронологический сплит по матчам с 1-суточным gap'ом.
  const allM = Array.from(
    new Set(samples.map(s => s.matchId)),
    id => ({ id, startTime: matchStart.get(id) ?? 0 }),
  );
  allM.sort((a, b) => a.startTime - b.startTime);
  const splitIdx = Math.floor(allM.length * 0.8);
  const splitTime = allM[splitIdx]?.startTime ?? 0;
  const gapSec = 86400;
  const trainMatchSet = new Set(allM.filter(m => m.startTime <= splitTime - gapSec).map(m => m.id));
  const testMatchSet = new Set(allM.filter(m => m.startTime > splitTime).map(m => m.id));
  const train = samples.filter(s => trainMatchSet.has(s.matchId));
  const test = samples.filter(s => testMatchSet.has(s.matchId));
  console.log(`[train-asym-live] matches train/test: ${trainMatchSet.size}/${testMatchSet.size} (gap=${gapSec}s)`);
  console.log(`[train-asym-live] samples  train/test: ${train.length}/${test.length}`);
  if (train.length < 30 || test.length < 5) {
    console.error('[train-asym-live] Too few samples after temporal split.');
    process.exit(0);
  }

  console.log('[train-asym-live] Training logistic regression …');
  const w = trainLogisticRegression([...train], DIM);
  console.log('[train-asym-live] Weights:', w.map(x => x.toFixed(4)));

  const trainMetrics = evaluate(train, w);
  const testMetrics = evaluate(test, w);
  console.log(`[train-asym-live] TRAIN acc=${(trainMetrics.acc*100).toFixed(2)}% logloss=${trainMetrics.logLoss.toFixed(4)} brier=${trainMetrics.brier.toFixed(4)} composite=${trainMetrics.composite.toFixed(4)}`);
  console.log(`[train-asym-live] TEST  acc=${(testMetrics.acc*100).toFixed(2)}% logloss=${testMetrics.logLoss.toFixed(4)} brier=${testMetrics.brier.toFixed(4)} composite=${testMetrics.composite.toFixed(4)}`);

  // Baseline: только prematchProb (без живого состояния).
  let baselineCorrect = 0, baselineBrier = 0;
  for (const s of test) {
    const p = sigmoid(s.features[5]);
    if ((p >= 0.5 ? 1 : 0) === s.label) baselineCorrect++;
    baselineBrier += (p - s.label) ** 2;
  }
  const baselineAcc = test.length ? baselineCorrect / test.length : 0;
  const baselineBrierAvg = test.length ? baselineBrier / test.length : 0;
  console.log(`[train-asym-live] Baseline (только prematch): acc=${(baselineAcc*100).toFixed(2)}% brier=${baselineBrierAvg.toFixed(4)}`);
  console.log(`[train-asym-live] Lift: Δacc=${((testMetrics.acc - baselineAcc)*100).toFixed(2)}pp Δbrier=${(baselineBrierAvg - testMetrics.brier).toFixed(4)}`);

  const version = `lr-asym-live-v${FEATURES_VERSION}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}`;
  console.log(`[train-asym-live] Saving as ${version} …`);

  const weights: Record<string, number> = {};
  for (let i = 0; i < w.length; i++) weights[`w${i}`] = w[i];

  await saveLegacyCandidates(db, [{
      version,
      kind: 'live_winner_asym',
      featuresVersion: FEATURES_VERSION,
      algorithm: 'logistic_regression_live_asym',
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
        asymThreshold: TEAM_GAMES_THRESHOLD,
        asymPriorDays: ASYM_PRIOR_DAYS,
      },
      isActive: false,
    }], {
    trainer: 'train-asym-live', seed: TRAINING_SEED,
    limitations: ['historical_asym_prior_provenance_unverified', 'independent_calibration_required', 'live_source_only'],
  });

  console.log(`[train-asym-live] Saved inactive, unvalidated candidate ${version} (fv=${FEATURES_VERSION}); active models unchanged.`);
  process.exit(0);
}

main().catch(err => {
  console.error('[train-asym-live] FATAL', err);
  process.exit(1);
});
