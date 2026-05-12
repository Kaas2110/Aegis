/**
 * Обучение прематч-моделей.
 *
 *   Волна 1: тиры (T1/T2/T3 + fallback) + изотоническая калибровка.
 *   Волна 2: вторая «версия фичей» v2 = team(5) + hero/draft(7) = 12 фичей.
 *
 * Архитектура:
 *   1. Загружаем команды, матчи (последние 180 дней, avg Glicko ≥ MIN_AVG_GLICKO).
 *   2. Загружаем драфты, hero_stats, matchups (для v2).
 *   3. Бакетируем матчи по тиру: T1 (avg ≥1400), T2 (1200..1400), T3 (<1200).
 *      Параллельно собираем общую "all" выборку для fallback.
 *   4. Для каждой featuresVersion (v1 = team only, v2 = team+hero):
 *        - 4 бакета (3 тира + fallback)
 *        - 80/10/10 split (хронологический, без leakage)
 *        - тренируем logistic regression
 *        - фитим изотоническую калибровку на 10% holdout
 *   5. В одной транзакции деактивируем ВСЕ старые активные прематч-модели
 *      (по всем (kind, featuresVersion)) и вставляем все новые.
 *
 * Если у бакета < MIN_SAMPLES_PER_TIER train samples — модель не тренируется,
 * lookup на инференсе упадёт в fallback того же featuresVersion. Если v2
 * вообще не удалось тренировать (нет drafts/hero_stats) — продолжаем с v1.
 */

import {
  db,
  proMatchesTable,
  teamsTable,
  modelVersionsTable,
  matchDraftsTable,
  heroStatsTable,
  heroMatchupsTable,
  playerHeroStatsTable,
  playerRatingsTable,
  teamRecentFormTable,
  teamH2HTable,
} from '@workspace/db';
import { asc, gte, and, eq, inArray } from 'drizzle-orm';
import { fitIsotonic, applyCalibration, type CalibrationModel } from './lib/isotonic';
import { classifyTier, tierKind, ALL_PREMATCH_KINDS, type Tier } from './lib/tier';
import {
  buildHeroFeatures,
  buildExtraFeatures,
  HERO_FEATURE_NAMES,
  HERO_FEATURE_DIM,
  EXTRA_FEATURE_NAMES,
  EXTRA_FEATURE_DIM,
  type HeroStatsMap,
  type HeroMatchupsMap,
  type PlayerHeroStatsMap,
  type RecentFormMap,
  type H2HMap,
  type PlayerGlickoMap,
} from './lib/hero-features';

const TRAIN_WINDOW_DAYS = 365;
const EPOCHS = 200;

/** Возвращает Unix-timestamp начала тренировочного окна. */
function parseSinceUnix(): number {
  const idx = process.argv.indexOf('--since-unix');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return Math.floor(Date.now() / 1000) - TRAIN_WINDOW_DAYS * 24 * 60 * 60;
}

/** Возвращает минимум сэмплов на тир для обучения. */
function parseMinSamplesTier(): number {
  const idx = process.argv.indexOf('--min-samples');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return MIN_SAMPLES_PER_TIER;
}
const LR = 0.05;
const L2 = 0.001;
const MIN_SAMPLES_PER_TIER = 50;
const MIN_AVG_GLICKO = 1200;  // отсекаем T3 — рейтинги шумные

/** CLI: --min-glicko N — переопределяет MIN_AVG_GLICKO для экспериментов. */
function parseMinGlicko(): number {
  const idx = process.argv.indexOf('--min-glicko');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return MIN_AVG_GLICKO;
}

const TEAM_FEATURE_NAMES = ['bias', 'elo_diff_norm', 'winrate_diff', 'experience_diff', 'is_high_tier'] as const;
const TEAM_FEATURE_DIM = TEAM_FEATURE_NAMES.length;

interface Sample {
  features: number[];
  label: number;
}

interface TeamRating {
  rating: number;
  wins: number;
  losses: number;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function dot(w: number[], x: number[]): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

function buildTeamFeatures(
  radiantId: number,
  direId: number,
  teams: Map<number, TeamRating>,
): number[] | null {
  const r = teams.get(radiantId);
  const d = teams.get(direId);
  if (!r || !d || r.rating == null || d.rating == null) return null;

  const rGames = r.wins + r.losses;
  const dGames = d.wins + d.losses;
  if (rGames < 5 || dGames < 5) return null;

  const eloDiff = (r.rating - d.rating) / 200;
  const rWR = r.wins / rGames;
  const dWR = d.wins / dGames;
  const wrDiff = rWR - dWR;
  const expDiff = Math.log(rGames + 1) - Math.log(dGames + 1);
  const isHighTier = rGames >= 50 && dGames >= 50 ? 1 : 0;

  return [1, eloDiff, wrDiff, expDiff, isHighTier];
}

function trainLogisticRegression(samples: Sample[], dim: number, label: string): number[] {
  const w = new Array<number>(dim).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    let totalLoss = 0;
    for (let i = samples.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [samples[i], samples[j]] = [samples[j], samples[i]];
    }
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
    if ((epoch + 1) % 50 === 0) {
      console.log(`    [${label}] epoch ${epoch + 1}/${EPOCHS} loss=${(totalLoss / samples.length).toFixed(4)}`);
    }
  }
  return w;
}

interface Metrics {
  acc: number;
  logLoss: number;
  brier: number;
}

function evaluate(samples: Sample[], w: number[], calib: CalibrationModel | null): Metrics {
  if (samples.length === 0) return { acc: 0, logLoss: 0, brier: 0 };
  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  for (const s of samples) {
    const raw = sigmoid(dot(w, s.features));
    const p = calib ? applyCalibration(raw, calib) : raw;
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === s.label) correct++;
    const eps = 1e-9;
    logLoss += -(s.label * Math.log(p + eps) + (1 - s.label) * Math.log(1 - p + eps));
    brier += (p - s.label) ** 2;
  }
  return {
    acc: correct / samples.length,
    logLoss: logLoss / samples.length,
    brier: brier / samples.length,
  };
}

interface BucketResult {
  kind: typeof ALL_PREMATCH_KINDS[number];
  featuresVersion: 1 | 2 | 3;
  tier: Tier | null;
  weights: number[];
  calibration: CalibrationModel;
  trainSize: number;
  calibSize: number;
  testSize: number;
  trainMetrics: Metrics;
  testMetricsRaw: Metrics;
  testMetricsCalibrated: Metrics;
  baselineAcc: number;
  brierImprovement: number;
}

function trainBucket(
  samples: Sample[],
  kind: typeof ALL_PREMATCH_KINDS[number],
  featuresVersion: 1 | 2 | 3,
  tier: Tier | null,
  dim: number,
): BucketResult | null {
  if (samples.length < parseMinSamplesTier()) {
    console.log(`  [v${featuresVersion}/${kind}] SKIP: only ${samples.length} samples (need ${parseMinSamplesTier()}+)`);
    return null;
  }

  const n = samples.length;
  const trainEnd = Math.floor(n * 0.8);
  const calibEnd = Math.floor(n * 0.9);
  const train = samples.slice(0, trainEnd);
  const calib = samples.slice(trainEnd, calibEnd);
  const test = samples.slice(calibEnd);
  const label = `v${featuresVersion}/${kind}`;

  console.log(`  [${label}] training on ${train.length} / calib ${calib.length} / test ${test.length} (dim=${dim})`);
  const w = trainLogisticRegression([...train], dim, label);

  const calibSamples = calib.map(s => ({
    prob: sigmoid(dot(w, s.features)),
    label: s.label,
  }));
  const calibration = fitIsotonic(calibSamples);

  const trainMetrics = evaluate(train, w, null);
  const testMetricsRaw = evaluate(test, w, null);
  const testMetricsCalibrated = evaluate(test, w, calibration);
  const baselineAcc = test.length > 0 ? test.filter(s => s.label === 1).length / test.length : 0;

  console.log(`  [${label}] TRAIN  acc=${(trainMetrics.acc * 100).toFixed(1)}% brier=${trainMetrics.brier.toFixed(4)}`);
  console.log(`  [${label}] TEST raw  acc=${(testMetricsRaw.acc * 100).toFixed(1)}% brier=${testMetricsRaw.brier.toFixed(4)} logloss=${testMetricsRaw.logLoss.toFixed(4)}`);
  console.log(`  [${label}] TEST cal  acc=${(testMetricsCalibrated.acc * 100).toFixed(1)}% brier=${testMetricsCalibrated.brier.toFixed(4)} logloss=${testMetricsCalibrated.logLoss.toFixed(4)}`);
  console.log(`  [${label}] baseline always-radiant=${(baselineAcc * 100).toFixed(1)}% calib bins=${calibration.bins.length}`);

  return {
    kind,
    featuresVersion,
    tier,
    weights: w,
    calibration,
    trainSize: train.length,
    calibSize: calib.length,
    testSize: test.length,
    trainMetrics,
    testMetricsRaw,
    testMetricsCalibrated,
    baselineAcc,
    brierImprovement: testMetricsRaw.brier - testMetricsCalibrated.brier,
  };
}

async function main() {
  // ── Загрузка команд ────────────────────────────────────────────────────
  console.log('[train-model] Loading teams …');
  const teamsRows = await db
    .select({
      teamId: teamsTable.teamId,
      rating: teamsTable.rating,
      wins: teamsTable.wins,
      losses: teamsTable.losses,
    })
    .from(teamsTable);
  const teams = new Map<number, TeamRating>();
  for (const t of teamsRows) {
    if (t.rating != null) {
      teams.set(t.teamId, { rating: t.rating, wins: t.wins ?? 0, losses: t.losses ?? 0 });
    }
  }
  console.log(`[train-model] Loaded ${teams.size} teams with ratings`);

  // ── Загрузка матчей ────────────────────────────────────────────────────
  const minStartTime = parseSinceUnix();
  const effectiveMinSamplesTier = parseMinSamplesTier();
  const effectiveMinGlicko = parseMinGlicko();
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('[train-model] DRY-RUN mode — DB not modified');
  console.log(`[train-model] minGlicko=${effectiveMinGlicko} since=${new Date(minStartTime * 1000).toISOString().slice(0, 10)}`);
  const matches = await db
    .select({
      matchId: proMatchesTable.matchId,
      radiantTeamId: proMatchesTable.radiantTeamId,
      direTeamId: proMatchesTable.direTeamId,
      radiantWin: proMatchesTable.radiantWin,
      startTime: proMatchesTable.startTime,
    })
    .from(proMatchesTable)
    .where(gte(proMatchesTable.startTime, minStartTime))
    .orderBy(asc(proMatchesTable.startTime));
  console.log(`[train-model] Loaded ${matches.length} matches in window`);

  // ── Загрузка драфтов и hero stats для v2 ──────────────────────────────
  console.log('[train-model] Loading drafts/hero_stats/matchups for v2 …');
  const draftsRows = await db
    .select({
      matchId: matchDraftsTable.matchId,
      radiantPicks: matchDraftsTable.radiantPicks,
      direPicks: matchDraftsTable.direPicks,
      radiantBans: matchDraftsTable.radiantBans,
      direBans: matchDraftsTable.direBans,
    })
    .from(matchDraftsTable);
  const drafts = new Map<number, {
    radiantPicks: number[]; direPicks: number[];
    radiantBans: number[]; direBans: number[];
  }>();
  for (const d of draftsRows) drafts.set(d.matchId, d);

  const heroStatsRows = await db
    .select({
      heroId: heroStatsTable.heroId,
      proWinRate: heroStatsTable.proWinRate,
      proPickRate: heroStatsTable.proPickRate,
    })
    .from(heroStatsTable);
  const heroStats: HeroStatsMap = new Map();
  for (const h of heroStatsRows) {
    heroStats.set(h.heroId, { proWinRate: h.proWinRate, proPickRate: h.proPickRate });
  }

  const matchupsRows = await db
    .select({
      heroId: heroMatchupsTable.heroId,
      vsHeroId: heroMatchupsTable.vsHeroId,
      games: heroMatchupsTable.games,
      winRate: heroMatchupsTable.winRate,
    })
    .from(heroMatchupsTable);
  const matchups: HeroMatchupsMap = new Map();
  for (const m of matchupsRows) {
    let inner = matchups.get(m.heroId);
    if (!inner) {
      inner = new Map();
      matchups.set(m.heroId, inner);
    }
    inner.set(m.vsHeroId, { games: m.games, winRate: m.winRate });
  }
  console.log(
    `[train-model] drafts=${drafts.size}, heroStats=${heroStats.size}, matchupPairs=${matchupsRows.length}`,
  );

  // ── Wave 3: player-hero stats, recent form, h2h ───────────────────────
  console.log('[train-model] Loading player_hero_stats / recent_form / h2h for v3 …');
  const phsRows = await db.select().from(playerHeroStatsTable);
  const playerHeroStats: PlayerHeroStatsMap = new Map();
  for (const r of phsRows) {
    let inner = playerHeroStats.get(r.accountId);
    if (!inner) { inner = new Map(); playerHeroStats.set(r.accountId, inner); }
    inner.set(r.heroId, { games: r.games, wins: r.wins });
  }
  const formRows = await db
    .select()
    .from(teamRecentFormTable)
    .where(eq(teamRecentFormTable.periodDays, 30));
  const recentForm: RecentFormMap = new Map();
  for (const r of formRows) recentForm.set(r.teamId, { winRate: r.winRate, games: r.games });

  const h2hRows = await db
    .select()
    .from(teamH2HTable)
    .where(eq(teamH2HTable.periodDays, 365));
  const h2h: H2HMap = new Map();
  for (const r of h2hRows) {
    h2h.set(`${r.teamLowId}_${r.teamHighId}`, { games: r.games, winsLow: r.winsLow });
  }
  console.log(
    `[train-model] playerHeroAccounts=${playerHeroStats.size}, recentForm=${recentForm.size}, h2hPairs=${h2h.size}`,
  );

  // Wave 3 v3-extra: per-player Glicko-1 ratings.
  const prRows = await db.select({
    accountId: playerRatingsTable.accountId,
    rating: playerRatingsTable.rating,
    rd: playerRatingsTable.rd,
  }).from(playerRatingsTable);
  const playerGlicko: PlayerGlickoMap = new Map();
  for (const r of prRows) playerGlicko.set(r.accountId, { rating: r.rating, rd: r.rd });
  console.log(`[train-model] playerGlickoRatings=${playerGlicko.size}`);

  // Wave 3 матч-уровневые account_ids читаем из match_drafts (отдельно — основная
  // загрузка drafts уже была сделана через select без account_ids).
  const accRows = await db.select({
    matchId: matchDraftsTable.matchId,
    radiantAccountIds: matchDraftsTable.radiantAccountIds,
    direAccountIds: matchDraftsTable.direAccountIds,
  }).from(matchDraftsTable);
  const accIds = new Map<number, { r: number[] | null; d: number[] | null }>();
  for (const a of accRows) {
    accIds.set(a.matchId, { r: a.radiantAccountIds, d: a.direAccountIds });
  }

  // ── Сборка фичей за один проход ────────────────────────────────────────
  const v1All: Sample[] = [];
  const v1Bucket: Record<Tier, Sample[]> = { t1: [], t2: [], t3: [] };
  const v2All: Sample[] = [];
  const v2Bucket: Record<Tier, Sample[]> = { t1: [], t2: [], t3: [] };
  const v3All: Sample[] = [];
  const v3Bucket: Record<Tier, Sample[]> = { t1: [], t2: [], t3: [] };
  let droppedByMmr = 0;
  let v2DroppedNoDraft = 0;
  let v2DroppedUnknownHero = 0;
  let v3DroppedNoAccounts = 0;

  for (const m of matches) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const r = teams.get(m.radiantTeamId);
    const d = teams.get(m.direTeamId);
    if (!r || !d) continue;
    const avgGlicko = (r.rating + d.rating) / 2;
    if (avgGlicko < effectiveMinGlicko) {
      droppedByMmr++;
      continue;
    }
    const teamFeats = buildTeamFeatures(m.radiantTeamId, m.direTeamId, teams);
    if (!teamFeats) continue;

    const label = m.radiantWin ? 1 : 0;
    const tier = classifyTier(r.rating, d.rating);

    const v1Sample: Sample = { features: teamFeats, label };
    v1All.push(v1Sample);
    if (tier) v1Bucket[tier].push(v1Sample);

    // v2: требует драфт + все 10 героев в hero_stats
    const draft = drafts.get(m.matchId);
    if (!draft) {
      v2DroppedNoDraft++;
      continue;
    }
    const heroFeats = buildHeroFeatures(
      draft.radiantPicks,
      draft.direPicks,
      draft.radiantBans,
      draft.direBans,
      heroStats,
      matchups,
    );
    if (!heroFeats) {
      v2DroppedUnknownHero++;
      continue;
    }
    const v2Sample: Sample = {
      features: [...teamFeats, ...heroFeats],
      label,
    };
    v2All.push(v2Sample);
    if (tier) v2Bucket[tier].push(v2Sample);

    // v3: требует account_ids (хотя бы для одной стороны полезны) + recentForm + h2h любые.
    // Нет жёсткого требования что player_hero_stats есть для всех 10 — фича просто
    // станет 0 для тех у кого нет данных. Но если account_ids вовсе null — модель
    // не получит сигнала, поэтому таких в v3 не берём (иначе фича всегда 0 и модель
    // выучит её игнор + не отличает «нет данных» от «средний игрок»).
    const acc = accIds.get(m.matchId);
    if (!acc || (!acc.r && !acc.d)) {
      v3DroppedNoAccounts++;
      continue;
    }
    const extraFeats = buildExtraFeatures({
      radiantTeamId: m.radiantTeamId,
      direTeamId: m.direTeamId,
      radiantPicks: draft.radiantPicks,
      direPicks: draft.direPicks,
      radiantAccountIds: acc.r,
      direAccountIds: acc.d,
      playerHeroStats,
      heroStats,
      recentForm,
      h2h,
      playerGlicko,
    });
    const v3Sample: Sample = {
      features: [...teamFeats, ...heroFeats, ...extraFeats],
      label,
    };
    v3All.push(v3Sample);
    if (tier) v3Bucket[tier].push(v3Sample);
  }

  console.log(
    `[train-model] v1: ${v1All.length} samples (t1=${v1Bucket.t1.length}, t2=${v1Bucket.t2.length}, t3=${v1Bucket.t3.length}), droppedByMmr=${droppedByMmr}`,
  );
  console.log(
    `[train-model] v2: ${v2All.length} samples (t1=${v2Bucket.t1.length}, t2=${v2Bucket.t2.length}, t3=${v2Bucket.t3.length}), noDraft=${v2DroppedNoDraft}, unknownHero=${v2DroppedUnknownHero}`,
  );
  console.log(
    `[train-model] v3: ${v3All.length} samples (t1=${v3Bucket.t1.length}, t2=${v3Bucket.t2.length}, t3=${v3Bucket.t3.length}), noAccounts=${v3DroppedNoAccounts}`,
  );

  if (v1All.length < 100) {
    console.error('[train-model] Not enough v1 training data (need 100+).');
    process.exit(1);
  }

  // ── Тренировка v1 ──────────────────────────────────────────────────────
  console.log('\n[train-model] === TRAINING v1 (team features only, dim=5) ===');
  const v1Fallback = trainBucket(v1All, 'prematch_winner', 1, null, TEAM_FEATURE_DIM);
  const v1Tiers: Record<Tier, BucketResult | null> = {
    t1: trainBucket(v1Bucket.t1, tierKind('t1'), 1, 't1', TEAM_FEATURE_DIM),
    t2: trainBucket(v1Bucket.t2, tierKind('t2'), 1, 't2', TEAM_FEATURE_DIM),
    t3: trainBucket(v1Bucket.t3, tierKind('t3'), 1, 't3', TEAM_FEATURE_DIM),
  };

  if (!v1Fallback) {
    console.error('[train-model] FATAL: v1 fallback model could not be trained.');
    process.exit(1);
  }

  // ── Тренировка v2 (если данных достаточно) ─────────────────────────────
  const v2Dim = TEAM_FEATURE_DIM + HERO_FEATURE_DIM;
  let v2Fallback: BucketResult | null = null;
  const v2Tiers: Record<Tier, BucketResult | null> = { t1: null, t2: null, t3: null };
  if (v2All.length >= parseMinSamplesTier()) {
    console.log(`\n[train-model] === TRAINING v2 (team+hero features, dim=${v2Dim}) ===`);
    v2Fallback = trainBucket(v2All, 'prematch_winner', 2, null, v2Dim);
    v2Tiers.t1 = trainBucket(v2Bucket.t1, tierKind('t1'), 2, 't1', v2Dim);
    v2Tiers.t2 = trainBucket(v2Bucket.t2, tierKind('t2'), 2, 't2', v2Dim);
    v2Tiers.t3 = trainBucket(v2Bucket.t3, tierKind('t3'), 2, 't3', v2Dim);
  } else {
    console.log(
      `\n[train-model] Skipping v2: only ${v2All.length} samples with drafts (need ${parseMinSamplesTier()}+). ` +
      `Run ingest:drafts and ingest:hero-stats first.`,
    );
  }

  // ── Тренировка v3 (если данных достаточно) ─────────────────────────────
  const v3Dim = TEAM_FEATURE_DIM + HERO_FEATURE_DIM + EXTRA_FEATURE_DIM;
  let v3Fallback: BucketResult | null = null;
  const v3Tiers: Record<Tier, BucketResult | null> = { t1: null, t2: null, t3: null };
  if (v3All.length >= parseMinSamplesTier()) {
    console.log(`\n[train-model] === TRAINING v3 (team+hero+extras, dim=${v3Dim}) ===`);
    v3Fallback = trainBucket(v3All, 'prematch_winner', 3, null, v3Dim);
    v3Tiers.t1 = trainBucket(v3Bucket.t1, tierKind('t1'), 3, 't1', v3Dim);
    v3Tiers.t2 = trainBucket(v3Bucket.t2, tierKind('t2'), 3, 't2', v3Dim);
    v3Tiers.t3 = trainBucket(v3Bucket.t3, tierKind('t3'), 3, 't3', v3Dim);
  } else {
    console.log(
      `\n[train-model] Skipping v3: only ${v3All.length} samples with accounts (need ${parseMinSamplesTier()}+). ` +
      `Run ingest:drafts --backfill-accounts + ingest:players-heroes + compute:recent-form + compute:h2h.`,
    );
  }

  // ── Сборка строк для INSERT ────────────────────────────────────────────
  const versionStem = `lr-v${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  console.log(`\n[train-model] Saving models with stem ${versionStem} …`);

  const v1Results: BucketResult[] = [v1Fallback, v1Tiers.t1, v1Tiers.t2, v1Tiers.t3]
    .filter((r): r is BucketResult => r !== null);
  const v2Results: BucketResult[] = [v2Fallback, v2Tiers.t1, v2Tiers.t2, v2Tiers.t3]
    .filter((r): r is BucketResult => r !== null);
  const v3Results: BucketResult[] = [v3Fallback, v3Tiers.t1, v3Tiers.t2, v3Tiers.t3]
    .filter((r): r is BucketResult => r !== null);

  function bucketRowToInsert(r: BucketResult) {
    const featureNames = r.featuresVersion === 1
      ? [...TEAM_FEATURE_NAMES]
      : r.featuresVersion === 2
        ? [...TEAM_FEATURE_NAMES, ...HERO_FEATURE_NAMES]
        : [...TEAM_FEATURE_NAMES, ...HERO_FEATURE_NAMES, ...EXTRA_FEATURE_NAMES];
    const weights: Record<string, number> = {};
    for (let i = 0; i < r.weights.length; i++) weights[`w${i}`] = r.weights[i];
    return {
      version: `${versionStem}-v${r.featuresVersion}-${r.kind}`,
      kind: r.kind,
      featuresVersion: r.featuresVersion,
      algorithm: 'logistic_regression',
      features: featureNames,
      weights,
      trainAccuracy: r.trainMetrics.acc,
      testAccuracy: r.testMetricsCalibrated.acc,
      brierScore: r.testMetricsCalibrated.brier,
      trainSampleSize: r.trainSize,
      testSampleSize: r.testSize,
      metadata: {
        tier: r.tier,
        calibration: r.calibration,
        calibSampleSize: r.calibSize,
        testRaw: r.testMetricsRaw,
        testCalibrated: r.testMetricsCalibrated,
        brierImprovement: r.brierImprovement,
        baselineAcc: r.baselineAcc,
        epochs: EPOCHS,
        learningRate: LR,
        l2: L2,
        windowDays: TRAIN_WINDOW_DAYS,
        windowStartUnix: minStartTime,
        minAvgGlicko: effectiveMinGlicko,
      },
      isActive: true,
    };
  }

  const toInsert = [...v1Results, ...v2Results, ...v3Results].map(bucketRowToInsert);

  // ── Атомарный swap ────────────────────────────────────────────────────
  // Деактивируем ВСЕ активные прематч-модели всех версий (v1 и v2). Затем
  // вставляем новые. Constraint (kind, features_version WHERE active)
  // защищает от race condition.
  if (dryRun) {
    console.log('\n[train-model] DRY-RUN results (not saved):');
    for (const r of toInsert) {
      console.log(
        `   ${r.kind} v${r.featuresVersion} ${r.engine ?? 'logreg'} ` +
        `test_acc=${(r.testAccuracy * 100).toFixed(2)}% brier=${r.brierScore.toFixed(4)} train=${r.trainSampleSize}`,
      );
    }
    process.exit(0);
  }
  await db.transaction(async tx => {
    await tx
      .update(modelVersionsTable)
      .set({ isActive: false })
      .where(
        and(
          inArray(modelVersionsTable.kind, [...ALL_PREMATCH_KINDS]),
          eq(modelVersionsTable.isActive, true),
        ),
      );
    if (toInsert.length > 0) {
      await tx.insert(modelVersionsTable).values(toInsert);
    }
  });

  console.log('\n[train-model] ✅ Saved models:');
  for (const r of toInsert) {
    console.log(
      `   - ${r.version} kind=${r.kind} v${r.featuresVersion} ` +
      `acc=${(r.testAccuracy * 100).toFixed(1)}% brier=${r.brierScore.toFixed(3)} train=${r.trainSampleSize}`,
    );
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[train-model] FATAL', err);
  process.exit(1);
});
