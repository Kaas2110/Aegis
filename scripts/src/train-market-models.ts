/**
 * Wave 4 — обучение LightGBM-моделей для производных рынков:
 *   - market_first_blood    : classification (label = radiantWin прокси)
 *   - market_total_kills    : regression на log(radiant_score+dire_score)
 *   - market_total_duration : regression на log(duration_sec)
 *
 * v3 фичи (16 фич): team ELO, опыт, форма (avgKillsFor/avgDurationSec 30d),
 * expected_tempo_norm (per-matchup ожидаемый темп убийств, varies per match),
 * series_type + 5 draft-фич (aggression_r/d, scale_r/d, has_draft).
 *
 * Замена patch_kpm → expected_tempo_norm: patch_kpm был КОНСТАНТОЙ на весь
 * трейн-ран (одна глобальная scalar) → LGB importance=0 во всех моделях.
 * expected_tempo_norm = (avgKillsFor_R + avgKillsFor_D) / (2 * GLOBAL_AVG_KILLS)
 * варьируется per-matchup (разные команды → разный темп) и реально полезен.
 *
 * CLI:
 *   pnpm --filter @workspace/scripts run train:market-models
 *     [--market first_blood|total_kills|total_duration|all]
 */

import {
  db,
  proMatchesTable,
  teamsTable,
  teamRecentFormTable,
  modelVersionsTable,
  matchDraftsTable,
} from '@workspace/db';
import { gte, and, eq } from 'drizzle-orm';
import { asc } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { teamDraftScores } from './lib/heroDraftScores';

const TRAIN_WINDOW_DAYS = 365;
const MIN_SAMPLES = 60;
const FEATURES_VERSION = 3;

function parseSinceUnix(): number {
  const idx = process.argv.indexOf('--since-unix');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return Math.floor(Date.now() / 1000) - TRAIN_WINDOW_DAYS * 86_400;
}

function parseMinSamples(): number {
  const idx = process.argv.indexOf('--min-samples');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return MIN_SAMPLES;
}
const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';
const TRAIN_TIMEOUT_MS = 120_000;

const TEAM_FEATURE_NAMES = [
  'bias',
  'elo_diff_norm',
  'winrate_diff',
  'experience_diff',
  'is_high_tier',
  'avg_kills_r',
  'avg_kills_d',
  'avg_dur_h_r',
  'avg_dur_h_d',
  'expected_tempo_norm',   // per-matchup: (avgKillsR + avgKillsD) / (2 * GLOBAL_AVG_KILLS)
  'format_norm',
  'draft_aggression_r',
  'draft_aggression_d',
  'draft_scale_r',
  'draft_scale_d',
  'has_draft',
] as const;

interface MatchRow {
  matchId: number;
  startTime: number;
  duration: number;
  radiantScore: number | null;
  direScore: number | null;
  firstBloodTime: number | null;
  radiantWin: boolean;
  radiantTeamId: number | null;
  direTeamId: number | null;
  series_type: number | null;
  radiantPicks: number[] | null;
  direPicks: number[] | null;
}

interface TeamRating { rating: number; wins: number; losses: number; }
interface TeamForm { avgKillsFor: number; avgDurationSec: number; }

type MarketKey = 'first_blood' | 'total_kills' | 'total_duration';
const ALL_MARKETS: MarketKey[] = ['first_blood', 'total_kills', 'total_duration'];

const KIND_BY_MARKET: Record<MarketKey, string> = {
  first_blood: 'market_first_blood',
  total_kills: 'market_total_kills',
  total_duration: 'market_total_duration',
};

const TASK_BY_MARKET: Record<MarketKey, 'classification' | 'regression'> = {
  first_blood: 'classification',
  total_kills: 'regression',
  total_duration: 'regression',
};

interface MlMetrics { accuracy: number; log_loss: number; brier: number; n: number; }
interface TrainResponse {
  label: string;
  task_type: 'classification' | 'regression';
  blob_b64: string;
  feature_names: string[];
  train_metrics: MlMetrics;
  calib_metrics: MlMetrics;
  test_metrics_raw: MlMetrics;
  test_metrics_calibrated: MlMetrics;
  baseline_acc: number;
  feature_importance: Record<string, number>;
  train_seconds: number;
  residual_std: number | null;
}

interface Sample { features: number[]; label: number; }

function mlServiceToken(): string | null {
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) return env;
  try {
    const v = readFileSync(ML_TOKEN_FILE, 'utf8').trim();
    return v || null;
  } catch { return null; }
}

// Нормализационные константы (медиана про-сцены)
const GLOBAL_AVG_KILLS = 52;   // avg kills per map
const GLOBAL_AVG_DUR_SEC = 2200; // avg duration sec (~37 min)

function buildTeamFeatures(
  rId: number,
  dId: number,
  seriesType: number | null,
  teams: Map<number, TeamRating>,
  form: Map<number, TeamForm>,
  radiantPicks: number[] | null,
  direPicks: number[] | null,
): number[] | null {
  const r = teams.get(rId); const d = teams.get(dId);
  if (!r || !d) return null;
  const rG = r.wins + r.losses; const dG = d.wins + d.losses;
  if (rG < 5 || dG < 5) return null;

  const rf = form.get(rId);
  const df = form.get(dId);

  // format_norm: 0=BO1, 0.5=BO3, 1.0=BO5 (series_type: 0=BO1, 1=BO3, 2=BO5)
  const formatNorm = seriesType != null ? Math.min(1, seriesType / 2) : 0.5;

  // Draft features
  const hasDraft = radiantPicks && direPicks && radiantPicks.length > 0 && direPicks.length > 0 ? 1 : 0;
  const rDraft = teamDraftScores(radiantPicks ?? []);
  const dDraft = teamDraftScores(direPicks ?? []);

  // expected_tempo_norm: per-matchup expected kills rate (varies per matchup, unlike old patch_kpm).
  // Captures that some teams play fast kill-heavy games, others slow macro.
  const rAvgKills = rf?.avgKillsFor ?? GLOBAL_AVG_KILLS;
  const dAvgKills = df?.avgKillsFor ?? GLOBAL_AVG_KILLS;
  const expectedTempoNorm = (rAvgKills + dAvgKills) / (2 * GLOBAL_AVG_KILLS);

  return [
    1,                                                        // bias
    (r.rating - d.rating) / 200,                             // elo_diff_norm
    r.wins / rG - d.wins / dG,                               // winrate_diff
    Math.log(rG + 1) - Math.log(dG + 1),                    // experience_diff
    rG >= 50 && dG >= 50 ? 1 : 0,                           // is_high_tier
    rAvgKills / 60,                                          // avg_kills_r (normalized)
    dAvgKills / 60,                                          // avg_kills_d
    (rf?.avgDurationSec ?? GLOBAL_AVG_DUR_SEC) / 3600,       // avg_dur_h_r (in hours ~0.6)
    (df?.avgDurationSec ?? GLOBAL_AVG_DUR_SEC) / 3600,       // avg_dur_h_d
    expectedTempoNorm,                                        // expected_tempo_norm (per-matchup)
    formatNorm,                                               // format_norm
    rDraft.aggression,                                        // draft_aggression_r
    dDraft.aggression,                                        // draft_aggression_d
    rDraft.scale,                                             // draft_scale_r
    dDraft.scale,                                             // draft_scale_d
    hasDraft,                                                 // has_draft
  ];
}

async function loadData() {
  const sinceTs = parseSinceUnix();

  // Загружаем матчи с LEFT JOIN на драфты
  const rawMatches = await db
    .select({
      matchId: proMatchesTable.matchId,
      startTime: proMatchesTable.startTime,
      duration: proMatchesTable.duration,
      radiantScore: proMatchesTable.radiantScore,
      direScore: proMatchesTable.direScore,
      firstBloodTime: proMatchesTable.firstBloodTime,
      radiantWin: proMatchesTable.radiantWin,
      radiantTeamId: proMatchesTable.radiantTeamId,
      direTeamId: proMatchesTable.direTeamId,
      series_type: proMatchesTable.series_type,
      radiantPicks: matchDraftsTable.radiantPicks,
      direPicks: matchDraftsTable.direPicks,
    })
    .from(proMatchesTable)
    .leftJoin(matchDraftsTable, eq(proMatchesTable.matchId, matchDraftsTable.matchId))
    .where(gte(proMatchesTable.startTime, sinceTs))
    .orderBy(asc(proMatchesTable.startTime));

  const teamsRows = await db.select({
    teamId: teamsTable.teamId, rating: teamsTable.rating,
    wins: teamsTable.wins, losses: teamsTable.losses,
  }).from(teamsTable);
  const teams = new Map<number, TeamRating>();
  for (const t of teamsRows) {
    if (t.rating != null) teams.set(t.teamId, { rating: t.rating, wins: t.wins ?? 0, losses: t.losses ?? 0 });
  }

  // Форма команд (30-дневный снапшот)
  const formRows = await db.select({
    teamId: teamRecentFormTable.teamId,
    avgKillsFor: teamRecentFormTable.avgKillsFor,
    avgDurationSec: teamRecentFormTable.avgDurationSec,
  }).from(teamRecentFormTable).where(eq(teamRecentFormTable.periodDays, 30));

  const form = new Map<number, TeamForm>();
  for (const f of formRows) {
    form.set(f.teamId, {
      avgKillsFor: f.avgKillsFor ?? GLOBAL_AVG_KILLS,
      avgDurationSec: f.avgDurationSec ?? GLOBAL_AVG_DUR_SEC,
    });
  }

  const draftCount = rawMatches.filter(m => m.radiantPicks && (m.radiantPicks as number[]).length > 0).length;
  console.log(`[train-market-models] form loaded: ${form.size} teams | drafts=${draftCount}/${rawMatches.length}`);

  const matches = rawMatches.filter((r): r is MatchRow => r.duration != null);
  return { matches, teams, form };
}

function buildSamples(
  market: MarketKey,
  matches: MatchRow[],
  teams: Map<number, TeamRating>,
  form: Map<number, TeamForm>,
): Sample[] {
  const out: Sample[] = [];
  for (const m of matches) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const feats = buildTeamFeatures(
      m.radiantTeamId, m.direTeamId, m.series_type,
      teams, form,
      m.radiantPicks as number[] | null,
      m.direPicks as number[] | null,
    );
    if (!feats) continue;

    if (market === 'first_blood') {
      if (m.radiantWin == null) continue;
      out.push({ features: feats, label: m.radiantWin ? 1 : 0 });
    } else if (market === 'total_kills') {
      if (m.radiantScore == null || m.direScore == null) continue;
      const total = m.radiantScore + m.direScore;
      if (total <= 0) continue;
      out.push({ features: feats, label: Math.log(total) });
    } else {
      if (m.duration <= 0) continue;
      out.push({ features: feats, label: Math.log(m.duration) });
    }
  }
  return out;
}

async function trainMarket(market: MarketKey, samples: Sample[]): Promise<TrainResponse | null> {
  const label = `market/${market}`;
  const minSamples = parseMinSamples();
  if (samples.length < minSamples) {
    console.log(`  [${label}] SKIP: only ${samples.length} samples (need ${minSamples}+)`);
    return null;
  }
  const n = samples.length;
  const trainEnd = Math.floor(n * 0.8);
  const calibEnd = Math.floor(n * 0.9);
  const train = samples.slice(0, trainEnd);
  const calib = samples.slice(trainEnd, calibEnd);
  const test = samples.slice(calibEnd);
  const taskType = TASK_BY_MARKET[market];
  console.log(`  [${label}] training task=${taskType} n=${train.length}/calib=${calib.length}/test=${test.length} features=${TEAM_FEATURE_NAMES.length}`);

  const token = mlServiceToken();
  if (!token) {
    console.error(`  [${label}] no ML_SERVICE_TOKEN (env or ${ML_TOKEN_FILE}) — restart ml-service first`);
    return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAIN_TIMEOUT_MS);
  try {
    const res = await fetch(`${ML_SERVICE_URL}/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ml-token': token },
      body: JSON.stringify({
        label,
        feature_names: TEAM_FEATURE_NAMES,
        task_type: taskType,
        train, calib, test,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`  [${label}] ml-service ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as TrainResponse;
    const tm = data.test_metrics_calibrated;
    if (taskType === 'classification') {
      console.log(`  [${label}] TEST acc=${(tm.accuracy * 100).toFixed(1)}% brier=${tm.brier.toFixed(4)} (n=${tm.n})`);
    } else {
      console.log(`  [${label}] TEST r2=${tm.accuracy.toFixed(3)} rmse=${tm.brier.toFixed(4)} mae=${tm.log_loss.toFixed(4)} (n=${tm.n}, residual_std=${data.residual_std?.toFixed(4)})`);
      const fi = data.feature_importance;
      if (fi) {
        const sorted = Object.entries(fi).sort((a, b) => b[1] - a[1]).slice(0, 5);
        console.log(`  [${label}] top-5 features: ${sorted.map(([k, v]) => `${k}=${v.toFixed(3)}`).join(', ')}`);
      }
    }
    return data;
  } catch (e) {
    console.error(`  [${label}] training failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A10: Quantile training for total_duration (alpha = 0.25/0.5/0.75).
 *  Возвращает 3 модели для построения интервала прогноза:
 *  P(duration ∈ [q25, q75]) ≈ 50% — позволяет показывать «50%-интервал»
 *  на UI вместо точечного прогноза + рассчитывать вероятность over/under
 *  для конкретной линии без нормальностей-предположений на residual_std. */
async function trainQuantile(
  market: MarketKey,
  alpha: number,
  samples: Sample[],
): Promise<TrainResponse | null> {
  const label = `market/${market}_q${Math.round(alpha * 100)}`;
  const minSamples = parseMinSamples();
  if (samples.length < minSamples) {
    console.log(`  [${label}] SKIP: only ${samples.length} samples (need ${minSamples}+)`);
    return null;
  }
  const n = samples.length;
  const trainEnd = Math.floor(n * 0.8);
  const calibEnd = Math.floor(n * 0.9);
  const train = samples.slice(0, trainEnd);
  const calib = samples.slice(trainEnd, calibEnd);
  const test = samples.slice(calibEnd);
  console.log(`  [${label}] training task=quantile alpha=${alpha} n=${train.length}/calib=${calib.length}/test=${test.length}`);

  const token = mlServiceToken();
  if (!token) {
    console.error(`  [${label}] no ML_SERVICE_TOKEN — restart ml-service first`);
    return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAIN_TIMEOUT_MS);
  try {
    const res = await fetch(`${ML_SERVICE_URL}/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ml-token': token },
      body: JSON.stringify({
        label,
        feature_names: TEAM_FEATURE_NAMES,
        task_type: 'quantile',
        quantile_alpha: alpha,
        train, calib, test,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`  [${label}] ml-service ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as TrainResponse;
    const tm = data.test_metrics_calibrated;
    // Для quantile метрики из ml-service: accuracy = pinball loss (lower better),
    // brier = coverage rate (доля test-точек ниже квантиля; цель = alpha).
    console.log(`  [${label}] TEST pinball=${tm.accuracy.toFixed(4)} coverage=${tm.brier.toFixed(3)} (target=${alpha}, n=${tm.n})`);
    return data;
  } catch (e) {
    console.error(`  [${label}] training failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function activateQuantileModel(market: MarketKey, alpha: number, r: TrainResponse): Promise<void> {
  const baseKind = KIND_BY_MARKET[market];
  const kind = `${baseKind}_q${Math.round(alpha * 100)}`;
  const blob = Buffer.from(r.blob_b64, 'base64');
  const versionStem = `lgbm-${kind}-v3-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  await db.transaction(async (tx) => {
    await tx.update(modelVersionsTable)
      .set({ isActive: false })
      .where(and(eq(modelVersionsTable.kind, kind), eq(modelVersionsTable.isActive, true)));
    await tx.insert(modelVersionsTable).values({
      version: versionStem,
      kind,
      featuresVersion: FEATURES_VERSION,
      algorithm: 'lightgbm',
      engine: 'lightgbm',
      binaryBlob: blob,
      features: r.feature_names,
      weights: {},
      trainAccuracy: r.train_metrics.accuracy,
      testAccuracy: r.test_metrics_calibrated.accuracy,
      brierScore: r.test_metrics_calibrated.brier,
      trainSampleSize: r.train_metrics.n,
      testSampleSize: r.test_metrics_calibrated.n,
      metadata: {
        market,
        taskType: 'quantile',
        quantileAlpha: alpha,
        engine: 'lightgbm',
        featuresVersion: FEATURES_VERSION,
        featureNames: r.feature_names,
        testRaw: r.test_metrics_raw,
        testCalibrated: r.test_metrics_calibrated,
        baselineAcc: r.baseline_acc,
        featureImportance: r.feature_importance,
        windowDays: TRAIN_WINDOW_DAYS,
        trainSeconds: r.train_seconds,
        blobBytes: blob.length,
      },
      isActive: true,
    });
  });
  console.log(`  [${kind}] ✅ activated ${versionStem} (blob=${blob.length}b, alpha=${alpha})`);
}

async function activateMarketModel(market: MarketKey, r: TrainResponse): Promise<void> {
  const kind = KIND_BY_MARKET[market];
  const blob = Buffer.from(r.blob_b64, 'base64');
  const taskType = TASK_BY_MARKET[market];
  const versionStem = `lgbm-${kind}-v3-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;

  await db.transaction(async (tx) => {
    // Деактивируем ВСЕ активные модели этого kind (все версии, все engine)
    await tx
      .update(modelVersionsTable)
      .set({ isActive: false })
      .where(and(eq(modelVersionsTable.kind, kind), eq(modelVersionsTable.isActive, true)));
    await tx.insert(modelVersionsTable).values({
      version: versionStem,
      kind,
      featuresVersion: FEATURES_VERSION,
      algorithm: 'lightgbm',
      engine: 'lightgbm',
      binaryBlob: blob,
      features: r.feature_names,
      weights: {},
      trainAccuracy: r.train_metrics.accuracy,
      testAccuracy: r.test_metrics_calibrated.accuracy,
      brierScore: r.test_metrics_calibrated.brier,
      trainSampleSize: r.train_metrics.n,
      testSampleSize: r.test_metrics_calibrated.n,
      metadata: {
        market,
        taskType,
        engine: 'lightgbm',
        featuresVersion: FEATURES_VERSION,
        featureNames: r.feature_names,
        residualStd: r.residual_std,
        testRaw: r.test_metrics_raw,
        testCalibrated: r.test_metrics_calibrated,
        calibSampleSize: r.calib_metrics.n,
        baselineAcc: r.baseline_acc,
        featureImportance: r.feature_importance,
        windowDays: TRAIN_WINDOW_DAYS,
        trainSeconds: r.train_seconds,
        blobBytes: blob.length,
      },
      isActive: true,
    });
  });
  console.log(`  [market/${market}] ✅ activated ${versionStem} (blob=${blob.length}b, fv=${FEATURES_VERSION})`);
}

function parseMarketsFromArgs(): MarketKey[] {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | undefined;
    if (a === '--market' && argv[i + 1]) { v = argv[i + 1]; i++; }
    else if (a.startsWith('--market=')) v = a.slice('--market='.length);
    if (!v) continue;
    if (v === 'all') return ALL_MARKETS;
    if ((ALL_MARKETS as string[]).includes(v)) return [v as MarketKey];
    console.error(`[train-market-models] unknown --market: ${v} (valid: all, ${ALL_MARKETS.join(', ')})`);
    process.exit(1);
  }
  return ALL_MARKETS;
}

async function main(): Promise<void> {
  const targets = parseMarketsFromArgs();
  console.log(`[train-market-models] ml-service: ${ML_SERVICE_URL} markets=${targets.join(',')} features=${FEATURES_VERSION}`);

  try {
    const h = await fetch(`${ML_SERVICE_URL}/healthz`);
    if (!h.ok) throw new Error(`status ${h.status}`);
  } catch (e) {
    console.error(`[train-market-models] ml-service unreachable: ${(e as Error).message}`);
    process.exit(1);
  }

  const { matches, teams, form } = await loadData();
  console.log(`[train-market-models] matches=${matches.length} teams=${teams.size} form=${form.size}`);

  if (matches.length < parseMinSamples()) {
    console.log('[train-market-models] not enough matches — exiting cleanly');
    return;
  }

  let trained = 0;
  let quantilesTrained = 0;
  for (const market of targets) {
    console.log(`\n[train-market-models] === ${market} ===`);
    const samples = buildSamples(market, matches, teams, form);
    const r = await trainMarket(market, samples);
    if (r) {
      await activateMarketModel(market, r);
      trained++;
    }
    // A10: для total_duration дополнительно тренируем 3 quantile-модели
    // (q25/q50/q75) для построения интервалов и точных over/under.
    if (market === 'total_duration' && samples.length >= parseMinSamples()) {
      for (const alpha of [0.25, 0.5, 0.75]) {
        console.log(`\n[train-market-models] --- ${market} quantile α=${alpha} ---`);
        const qr = await trainQuantile(market, alpha, samples);
        if (qr) {
          await activateQuantileModel(market, alpha, qr);
          quantilesTrained++;
        }
      }
    }
  }

  console.log(`\n[train-market-models] done — trained ${trained}/${targets.length} regression + ${quantilesTrained} quantile`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[train-market-models] FATAL', err);
    process.exit(1);
  });
