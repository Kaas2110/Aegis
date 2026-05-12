/**
 * Обучение LIVE-модели победителя матча.
 *
 * Модель работает ВО ВРЕМЯ матча: текущий снапшот (NW lead, kills,
 * tower ratios, game_time, phase) + прематч-вероятность + hero advantage → P(Radiant).
 *
 * Фичи (11 + bias = 12):
 *   x0  = 1                                         bias
 *   x1  = (gameTimeSec - 1800) / 1800               нормализованное время
 *   x2  = radiantLead / 10000                       net worth преимущество
 *   x3  = (radiantScore - direScore) / 15           разница убийств
 *   x4  = (11 - r_towers_alive) / 11                доля ПОТЕРЯННЫХ башен Radiant (0=нет данных)
 *   x5  = (11 - d_towers_alive) / 11                доля ПОТЕРЯННЫХ башен Dire   (0=нет данных)
 *   x6  = logit(prematchProb)                       прематч как сильный приор
 *   x7  = kills_per_min / 1.1                       темп убийств (time-нормирован)
 *   x8  = clip(gameTimeSec / 3600, 0, 1)            фаза игры 0→1
 *   x9  = (radiantLead / 10000) × game_phase        взаимодействие: NW важнее в лейте
 *   x10 = killDiff / 15 × game_phase                убийства важнее в лейте
 *   x11 = hero_advantage (от matchup-матрицы, 0 если драфт неизвестен)
 *
 * Два движка:
 *   - LightGBM (primary)  — обучается через ml-service, blob в DB
 *   - LogReg   (fallback) — pure-JS, работает без ml-service
 *
 * CLI:
 *   --dry-run        не сохранять, только вывести метрики
 *   --since-unix N   ограничить снапшоты по времени создания (unix)
 *   --min-samples N  минимум сэмплов (default: 50 для обоих)
 */

import {
  db,
  modelVersionsTable,
  teamsTable,
  teamRecentFormTable,
  heroMatchupsTable,
} from '@workspace/db';
import { sql, and, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

const EPOCHS = 300;
const LR_RATE = 0.03;
const L2 = 0.01;

// Версия фич: 5 (12 фич — разделённые башни + kill_pace + hero_advantage)
const FEATURES_VERSION = 5;

const FEATURE_NAMES = [
  'bias',
  'game_time_norm',
  'nw_lead_norm',
  'kill_diff_norm',
  'r_towers_lost_ratio',
  'd_towers_lost_ratio',
  'prematch_logit',
  'kill_pace_norm',
  'game_phase',
  'nw_x_phase',
  'kill_diff_x_phase',
  'hero_advantage',
];
const FEATURE_DIM = FEATURE_NAMES.length;

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';
const TRAIN_TIMEOUT_MS = 90_000;
const GLOBAL_KPM = 1.1;

type HeroMatchupsMap = Map<number, Map<number, { games: number; winRate: number }>>;

function mlServiceToken(): string | null {
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) return env;
  try { return readFileSync(ML_TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
}

function isDryRun(): boolean { return process.argv.includes('--dry-run'); }

function parseSinceUnix(): number | null {
  const idx = process.argv.indexOf('--since-unix');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return null;
}

function parseMinSamples(def: number): number {
  const idx = process.argv.indexOf('--min-samples');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return def;
}

interface Sample { features: number[]; label: number; matchId: number; bucket: number; }

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
  let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * x[i]; return s;
}

/**
 * Вычисляет hero matchup advantage для Radiant относительно Dire.
 * Результат: взвешенное среднее (winRate - 0.5) × log(games+1) для всех 25 пар,
 * делённое на общий вес → диапазон примерно [-0.2, +0.2], 0 если нет данных.
 * Identical formula to inference side in LiveWinnerModel.ts.
 */
function computeHeroAdvantage(
  radiantPicks: number[],
  direPicks: number[],
  matchups: HeroMatchupsMap,
): number {
  let totalAdv = 0;
  let totalWeight = 0;
  for (const r of radiantPicks) {
    const outerMap = matchups.get(r);
    for (const d of direPicks) {
      const direct = outerMap?.get(d);
      if (direct && direct.games >= 5) {
        const w = Math.log(direct.games + 1);
        totalAdv += (direct.winRate - 0.5) * w;
        totalWeight += w;
        continue;
      }
      const inverse = matchups.get(d)?.get(r);
      if (inverse && inverse.games >= 5) {
        const w = Math.log(inverse.games + 1);
        totalAdv += (0.5 - inverse.winRate) * w;
        totalWeight += w;
      }
    }
  }
  return totalWeight > 0 ? totalAdv / totalWeight : 0;
}

function trainLogisticRegression(samples: Sample[], dim: number): number[] {
  const w = new Array(dim).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    for (let i = samples.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [samples[i], samples[j]] = [samples[j], samples[i]];
    }
    for (const s of samples) {
      const p = sigmoid(dot(w, s.features));
      const err = p - s.label;
      for (let i = 0; i < dim; i++) {
        w[i] -= LR_RATE * (err * s.features[i] + (i === 0 ? 0 : L2 * w[i]));
      }
    }
  }
  return w;
}

function evaluate(samples: Sample[], w: number[]): { acc: number; logLoss: number; brier: number } {
  let correct = 0, logLoss = 0, brier = 0;
  for (const s of samples) {
    const p = sigmoid(dot(w, s.features));
    if ((p >= 0.5 ? 1 : 0) === s.label) correct++;
    const eps = 1e-9;
    logLoss += -(s.label * Math.log(p + eps) + (1 - s.label) * Math.log(1 - p + eps));
    brier += (p - s.label) ** 2;
  }
  return { acc: correct / samples.length, logLoss: logLoss / samples.length, brier: brier / samples.length };
}

interface LgbmResult {
  blobB64: string;
  trainAcc: number;
  testAcc: number;
  brier: number;
  trainN: number;
  testN: number;
  baselineAcc: number;
  featureImportance: Record<string, number>;
}

async function trainLgbm(train: Sample[], calib: Sample[], test: Sample[]): Promise<LgbmResult | null> {
  const token = mlServiceToken();
  if (!token) { console.warn('[train-live-model] no ml-service token — skipping LGB'); return null; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAIN_TIMEOUT_MS);
  try {
    const h = await fetch(`${ML_SERVICE_URL}/healthz`, { signal: ctrl.signal });
    if (!h.ok) throw new Error(`ml-service unhealthy: ${h.status}`);

    const res = await fetch(`${ML_SERVICE_URL}/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ml-token': token },
      body: JSON.stringify({
        label: 'live_winner',
        feature_names: FEATURE_NAMES,
        train: train.map(s => ({ features: s.features, label: s.label })),
        calib: calib.map(s => ({ features: s.features, label: s.label })),
        test: test.map(s => ({ features: s.features, label: s.label })),
        task_type: 'classification',
        // Group C: balanced class weights — компенсирует временной сдвиг
        // (test: radiant 64%, train 52%). LGB перевзвешивает minority class.
        class_weight: 'balanced',
        // Сильная регуляризация: малый датасет (~300-2000 снапшотов)
        num_leaves: 15,
        max_depth: 4,
        learning_rate: 0.05,
        n_estimators: 80,
        min_child_samples: 20,
        reg_alpha: 0.5,
        reg_lambda: 1.0,
        feature_fraction: 0.8,
        bagging_fraction: 0.8,
        bagging_freq: 5,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[train-live-model] ml-service ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as {
      blob_b64: string;
      train_metrics: { accuracy: number; n: number };
      test_metrics_calibrated: { accuracy: number; brier: number; n: number };
      baseline_acc: number;
      feature_importance: Record<string, number>;
    };
    return {
      blobB64: data.blob_b64,
      trainAcc: data.train_metrics.accuracy,
      testAcc: data.test_metrics_calibrated.accuracy,
      brier: data.test_metrics_calibrated.brier,
      trainN: data.train_metrics.n,
      testN: data.test_metrics_calibrated.n,
      baselineAcc: data.baseline_acc,
      featureImportance: data.feature_importance,
    };
  } catch (e) {
    console.error(`[train-live-model] LGB training failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ELO-based prematch probability.
 */
function eloPrematchProb(
  rRating: number, dRating: number,
  rWins: number, rLosses: number,
  dWins: number, dLosses: number,
  rWinrate30: number | null, dWinrate30: number | null,
): number {
  const eloDiff = (rRating - dRating) / 200;
  const rWr = rWins / Math.max(rWins + rLosses, 1);
  const dWr = dWins / Math.max(dWins + dLosses, 1);
  const wrDiff = (rWinrate30 ?? rWr) - (dWinrate30 ?? dWr);
  const combined = eloDiff * 0.7 + wrDiff * 0.3;
  return sigmoid(combined);
}

async function main() {
  const dryRun = isDryRun();
  const sinceUnix = parseSinceUnix();
  const minSamples = parseMinSamples(50);

  if (dryRun) console.log('[train-live-model] DRY-RUN mode');
  if (sinceUnix) console.log(`[train-live-model] since_unix=${sinceUnix} (${new Date(sinceUnix * 1000).toISOString().slice(0, 10)})`);

  console.log('[train-live-model] Loading team ratings, form & hero matchups …');
  const [teamsRows, formRows, matchupRows] = await Promise.all([
    db.select({
      teamId: teamsTable.teamId,
      rating: teamsTable.rating,
      wins: teamsTable.wins,
      losses: teamsTable.losses,
    }).from(teamsTable),
    db.select({
      teamId: teamRecentFormTable.teamId,
      winRate: teamRecentFormTable.winRate,
    }).from(teamRecentFormTable).where(eq(teamRecentFormTable.periodDays, 30)),
    db.select({
      heroId: heroMatchupsTable.heroId,
      vsHeroId: heroMatchupsTable.vsHeroId,
      games: heroMatchupsTable.games,
      winRate: heroMatchupsTable.winRate,
    }).from(heroMatchupsTable),
  ]);

  const teamMap = new Map<number, { rating: number; wins: number; losses: number }>();
  for (const t of teamsRows) {
    if (t.rating != null) teamMap.set(t.teamId, { rating: t.rating, wins: t.wins ?? 0, losses: t.losses ?? 0 });
  }
  const formMap = new Map<number, number>();
  for (const f of formRows) {
    if (f.winRate != null) formMap.set(f.teamId, f.winRate);
  }

  // Build hero matchups cache: heroId → vsHeroId → { games, winRate }
  const heroMatchups: HeroMatchupsMap = new Map();
  for (const row of matchupRows) {
    if (!heroMatchups.has(row.heroId)) heroMatchups.set(row.heroId, new Map());
    heroMatchups.get(row.heroId)!.set(row.vsHeroId, {
      games: row.games ?? 0,
      winRate: typeof row.winRate === 'number' ? row.winRate : Number(row.winRate ?? 0.5),
    });
  }
  console.log(
    `[train-live-model] teams=${teamMap.size} | form=${formMap.size} | hero matchup pairs=${matchupRows.length}`,
  );

  console.log('[train-live-model] Joining live_snapshots × pro_matches × prematch_outcomes × match_drafts …');

  // Group B: LEFT JOIN match_drafts для hero_advantage фичи
  const rows = await db.execute(sql`
    SELECT
      ls.match_id                   AS "matchId",
      ls.game_time_sec              AS "gameTimeSec",
      ls.radiant_lead               AS "radiantLead",
      ls.radiant_score              AS "radiantScore",
      ls.dire_score                 AS "direScore",
      ls.building_state             AS "buildingState",
      pm.radiant_team_id            AS "radiantTeamId",
      pm.dire_team_id               AS "direTeamId",
      po.predicted_radiant_win_prob AS "storedPrematchProb",
      COALESCE(po.actual_radiant_win, pm.radiant_win) AS "actualRadiantWin",
      md.radiant_picks              AS "radiantPicks",
      md.dire_picks                 AS "direPicks"
    FROM live_snapshots ls
    INNER JOIN pro_matches pm ON pm.match_id = ls.match_id
    LEFT JOIN prematch_outcomes po ON po.match_id = ls.match_id
    LEFT JOIN match_drafts md ON md.match_id = ls.match_id
    WHERE pm.radiant_win IS NOT NULL
      AND ls.game_time_sec IS NOT NULL
      AND ls.game_time_sec >= 60
      AND ls.game_time_sec <= 7200
    ORDER BY ls.match_id, ls.game_time_sec
    LIMIT 200000
  `);

  console.log(`[train-live-model] Joined ${rows.rows.length} snapshot rows`);

  if (rows.rows.length < minSamples) {
    console.error(
      `[train-live-model] Not enough joined data (${rows.rows.length} < ${minSamples}).\n` +
      '  Это нормально на свежей системе — live-модель требует накопления снапшотов.',
    );
    process.exit(0);
  }

  const toNum = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  let storedPrematchCount = 0;
  let eloPrematchCount = 0;
  let unknownPrematchCount = 0;
  let heroAdvCount = 0;

  const seenBuckets = new Set<string>();
  const samples: Sample[] = [];

  for (const raw of rows.rows as unknown as Record<string, unknown>[]) {
    const matchId = toNum(raw['matchId']);
    const gameTimeSec = toNum(raw['gameTimeSec']);
    if (matchId == null || gameTimeSec == null) continue;

    // 1 снапшот на 3-минутный bucket
    const bucket = Math.floor(gameTimeSec / 180);
    const key = `${matchId}:${bucket}`;
    if (seenBuckets.has(key)) continue;
    seenBuckets.add(key);

    // Prematch probability
    let prematchProb: number;
    const storedProb = toNum(raw['storedPrematchProb']);
    if (storedProb != null && storedProb > 0 && storedProb < 1) {
      prematchProb = storedProb;
      storedPrematchCount++;
    } else {
      const rId = toNum(raw['radiantTeamId']);
      const dId = toNum(raw['direTeamId']);
      const rTeam = rId != null ? teamMap.get(rId) : undefined;
      const dTeam = dId != null ? teamMap.get(dId) : undefined;
      if (rTeam && dTeam) {
        prematchProb = eloPrematchProb(
          rTeam.rating, dTeam.rating,
          rTeam.wins, rTeam.losses,
          dTeam.wins, dTeam.losses,
          rId != null ? (formMap.get(rId) ?? null) : null,
          dId != null ? (formMap.get(dId) ?? null) : null,
        );
        eloPrematchCount++;
      } else {
        prematchProb = 0.52;
        unknownPrematchCount++;
      }
    }

    // Group A: split tower features (0 when building_state=null — no noise)
    const towers = towerCountsFromBuildingState(toNum(raw['buildingState']));
    const buildingStateNull = (raw['buildingState'] == null);
    // When null: r=11, d=11 → both ratios = 0 (no towers known lost)
    // When valid: r_lost = (11 - r_alive) / 11
    const rTowersLostRatio = buildingStateNull ? 0 : (11 - towers.r) / 11;
    const dTowersLostRatio = buildingStateNull ? 0 : (11 - towers.d) / 11;

    const radiantLead = toNum(raw['radiantLead']) ?? 0;
    const radiantScore = toNum(raw['radiantScore']) ?? 0;
    const direScore = toNum(raw['direScore']) ?? 0;
    const killDiff = radiantScore - direScore;

    // Group A: kill_pace_norm (time-normalized, replaces total_kills_norm)
    const killPaceNorm = gameTimeSec > 0
      ? ((radiantScore + direScore) / (gameTimeSec / 60)) / GLOBAL_KPM
      : 0;

    const gamePhase = Math.min(gameTimeSec / 3600, 1.0);
    const nwNorm = radiantLead / 10000;
    const killDiffNorm = killDiff / 15;
    const nwXPhase = nwNorm * gamePhase;
    const killXPhase = killDiffNorm * gamePhase;

    // Group B: hero_advantage от matchup-матрицы (0 когда драфт неизвестен)
    let heroAdvantage = 0;
    const rPicks = raw['radiantPicks'];
    const dPicks = raw['direPicks'];
    if (
      Array.isArray(rPicks) && Array.isArray(dPicks) &&
      rPicks.length === 5 && dPicks.length === 5 &&
      heroMatchups.size > 0
    ) {
      heroAdvantage = computeHeroAdvantage(
        rPicks as number[], dPicks as number[], heroMatchups,
      );
      heroAdvCount++;
    }

    samples.push({
      features: [
        1,                                        // bias
        (gameTimeSec - 1800) / 1800,              // game_time_norm
        nwNorm,                                   // nw_lead_norm
        killDiffNorm,                             // kill_diff_norm
        rTowersLostRatio,                         // r_towers_lost_ratio (Group A)
        dTowersLostRatio,                         // d_towers_lost_ratio (Group A)
        logit(prematchProb),                      // prematch_logit
        killPaceNorm,                             // kill_pace_norm (Group A)
        gamePhase,                                // game_phase
        nwXPhase,                                 // nw_x_phase
        killXPhase,                               // kill_diff_x_phase
        heroAdvantage,                            // hero_advantage (Group B)
      ],
      label: raw['actualRadiantWin'] ? 1 : 0,
      matchId,
      bucket,
    });
  }

  console.log(
    `[train-live-model] prematch_logit sources: stored=${storedPrematchCount} elo=${eloPrematchCount} neutral=${unknownPrematchCount}`,
  );
  console.log(
    `[train-live-model] hero_advantage: ${heroAdvCount}/${samples.length + (seenBuckets.size - samples.length)} samples have draft data`,
  );
  console.log(`[train-live-model] After bucket dedup (180s): ${samples.length} examples from ${seenBuckets.size} unique match-buckets`);

  if (samples.length < minSamples) {
    console.error(`[train-live-model] Not enough sampled data (${samples.length} < ${minSamples}).`);
    process.exit(0);
  }

  // Сплит ПО МАТЧАМ (не по снапшотам)
  const allMatches = Array.from(new Set(samples.map(s => s.matchId))).sort((a, b) => a - b);
  const trainEnd = Math.floor(allMatches.length * 0.8);
  const calibEnd = Math.floor(allMatches.length * 0.9);
  const trainMatches = new Set(allMatches.slice(0, trainEnd));
  const calibMatches = new Set(allMatches.slice(trainEnd, calibEnd));

  const trainSamples = samples.filter(s => trainMatches.has(s.matchId));
  const calibSamples = samples.filter(s => calibMatches.has(s.matchId));
  const testSamples  = samples.filter(s => !trainMatches.has(s.matchId) && !calibMatches.has(s.matchId));

  console.log(
    `[train-live-model] Match split train/calib/test: ${trainMatches.size}/${calibMatches.size}/${allMatches.length - calibEnd}`,
  );
  console.log(
    `[train-live-model] Sample split train/calib/test: ${trainSamples.length}/${calibSamples.length}/${testSamples.length}`,
  );

  const trainPos = trainSamples.filter(s => s.label === 1).length;
  const testPos  = testSamples.filter(s => s.label === 1).length;
  console.log(
    `[train-live-model] Label distribution: train radiant=${trainPos}/${trainSamples.length} (${(100 * trainPos / trainSamples.length).toFixed(1)}%)` +
    ` | test radiant=${testPos}/${testSamples.length} (${(100 * testPos / testSamples.length).toFixed(1)}%)`,
  );

  if (trainSamples.length < 30 || testSamples.length < 5) {
    console.error('[train-live-model] Too few samples after split.');
    process.exit(0);
  }

  // === LightGBM (Group C: class_weight='balanced') ===
  console.log('[train-live-model] Training LightGBM via ml-service (class_weight=balanced) …');
  const lgbm = await trainLgbm(trainSamples, calibSamples, testSamples);
  if (lgbm) {
    const liftPp = ((lgbm.testAcc - lgbm.baselineAcc) * 100).toFixed(2);
    const liftSign = lgbm.testAcc >= lgbm.baselineAcc ? '+' : '';
    console.log(`[train-live-model] [LGB] TRAIN acc=${(lgbm.trainAcc * 100).toFixed(2)}%`);
    console.log(`[train-live-model] [LGB] TEST  acc=${(lgbm.testAcc * 100).toFixed(2)}%  brier=${lgbm.brier.toFixed(4)}  baseline=${(lgbm.baselineAcc * 100).toFixed(2)}%  lift=${liftSign}${liftPp}pp`);
    const fi = lgbm.featureImportance;
    const sorted = Object.entries(fi).sort((a, b) => b[1] - a[1]);
    console.log('[train-live-model] [LGB] Feature importance:', sorted.map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' '));
  } else {
    console.warn('[train-live-model] LGB skipped — will only save LR fallback');
  }

  // === Logistic Regression (fallback) ===
  console.log('[train-live-model] Training logistic regression (fallback) …');
  const w = trainLogisticRegression([...trainSamples], FEATURE_DIM);
  const trainMetrics = evaluate(trainSamples, w);
  const testMetrics  = evaluate(testSamples, w);
  console.log(`[train-live-model] [LR]  TRAIN acc=${(trainMetrics.acc * 100).toFixed(2)}%  brier=${trainMetrics.brier.toFixed(4)}`);
  console.log(`[train-live-model] [LR]  TEST  acc=${(testMetrics.acc * 100).toFixed(2)}%  brier=${testMetrics.brier.toFixed(4)}`);

  // Baseline: только прематч-вероятность
  let baselineCorrect = 0, baselineBrier = 0;
  for (const s of testSamples) {
    const prematchLogit = s.features[6]!;  // x6 = logit(prematchProb)
    const prematchProb = sigmoid(prematchLogit);
    if ((prematchProb >= 0.5 ? 1 : 0) === s.label) baselineCorrect++;
    baselineBrier += (prematchProb - s.label) ** 2;
  }
  const baselineAcc = baselineCorrect / testSamples.length;
  const baselineBrierAvg = baselineBrier / testSamples.length;
  const lrLift = ((testMetrics.acc - baselineAcc) * 100).toFixed(2);
  const lrLiftSign = testMetrics.acc >= baselineAcc ? '+' : '';
  console.log(`[train-live-model] Baseline (только прематч): acc=${(baselineAcc * 100).toFixed(2)}%  brier=${baselineBrierAvg.toFixed(4)}`);
  console.log(`[train-live-model] [LR]  lift: Δacc=${lrLiftSign}${lrLift}pp  Δbrier=${(baselineBrierAvg - testMetrics.brier).toFixed(4)}`);

  console.log('[train-live-model] [LR]  Weights:',
    FEATURE_NAMES.map((n, i) => `${n}=${w[i]!.toFixed(3)}`).join(' '),
  );

  if (dryRun) {
    console.log('[train-live-model] DRY-RUN — не сохраняем.');
    process.exit(0);
  }

  const versionStem = `live-v${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  const commonMeta = {
    featureNames: FEATURE_NAMES,
    featuresVersion: FEATURES_VERSION,
    baselineAcc,
    baselineBrier: baselineBrierAvg,
    matchesTrain: trainMatches.size,
    matchesCalib: calibMatches.size,
    matchesTest: allMatches.length - calibEnd,
    totalMatches: allMatches.length,
    bucketingSeconds: 180,
    sinceUnix,
    lrLiftAcc: testMetrics.acc - baselineAcc,
    lgbmLiftAcc: lgbm ? lgbm.testAcc - lgbm.baselineAcc : null,
    heroAdvCount,
    heroMatchupPairs: matchupRows.length,
  };

  await db.transaction(async tx => {
    await tx
      .update(modelVersionsTable)
      .set({ isActive: false })
      .where(and(eq(modelVersionsTable.kind, 'live_winner'), eq(modelVersionsTable.isActive, true)));

    const toInsert: (typeof modelVersionsTable.$inferInsert)[] = [];

    // LR fallback — всегда сохраняем
    const weights: Record<string, number> = {};
    FEATURE_NAMES.forEach((n, i) => { weights[`w${i}`] = w[i]!; });
    toInsert.push({
      version: `lr-${versionStem}`,
      kind: 'live_winner',
      featuresVersion: FEATURES_VERSION,
      algorithm: 'logistic_regression_live',
      engine: 'logreg',
      features: FEATURE_NAMES,
      weights,
      trainAccuracy: trainMetrics.acc,
      testAccuracy: testMetrics.acc,
      brierScore: testMetrics.brier,
      trainSampleSize: trainSamples.length,
      testSampleSize: testSamples.length,
      metadata: {
        ...commonMeta,
        logLossTrain: trainMetrics.logLoss,
        logLossTest: testMetrics.logLoss,
        liftAcc: testMetrics.acc - baselineAcc,
        liftBrier: baselineBrierAvg - testMetrics.brier,
        epochs: EPOCHS,
        lrRate: LR_RATE,
        l2: L2,
      },
      isActive: true,
    });

    // LGB primary
    if (lgbm) {
      toInsert.push({
        version: `lgbm-${versionStem}`,
        kind: 'live_winner',
        featuresVersion: FEATURES_VERSION,
        algorithm: 'lightgbm_live',
        engine: 'lightgbm',
        features: FEATURE_NAMES,
        weights: {},
        binaryBlob: Buffer.from(lgbm.blobB64, 'base64'),
        trainAccuracy: lgbm.trainAcc,
        testAccuracy: lgbm.testAcc,
        brierScore: lgbm.brier,
        trainSampleSize: lgbm.trainN,
        testSampleSize: lgbm.testN,
        metadata: {
          ...commonMeta,
          liftAcc: lgbm.testAcc - lgbm.baselineAcc,
          featureImportance: lgbm.featureImportance,
          classWeight: 'balanced',
          numLeaves: 15,
          maxDepth: 4,
          nEstimators: 80,
          minChildSamples: 20,
          regAlpha: 0.5,
          regLambda: 1.0,
        },
        isActive: true,
      });
    }

    await tx.insert(modelVersionsTable).values(toInsert);
  });

  console.log(`[train-live-model] ✅ Saved: lr-${versionStem}${lgbm ? `, lgbm-${versionStem}` : ''}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[train-live-model] FATAL', err);
  process.exit(1);
});
