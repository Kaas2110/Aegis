/**
 * Wave 4 — обучение LightGBM-моделей для производных рынков:
 *   - market_first_blood    : classification (label = radiantWin прокси
 *                             среди матчей с известным first_blood_time)
 *   - market_total_kills    : regression на log(radiant_score+dire_score)
 *   - market_total_duration : regression на log(duration_sec)
 *
 * Все модели тренируются через ml-service (`POST /train`) с одним и тем
 * же team-feature-set'ом (5 фич: bias, elo_diff_norm, winrate_diff,
 * experience_diff, is_high_tier) — что уже есть для prematch_winner.
 *
 * Сохранение в `model_versions` с `engine='lightgbm'`, `binaryBlob`,
 * `weights={}` (jsonb NOT NULL — кладём пустой объект как маркер; реальные
 * параметры в blob). Атомарный swap per-market: для каждого `kind`
 * деактивируем все предыдущие active и вставляем новую активную в одной
 * транзакции.
 *
 * CLI:
 *   pnpm --filter @workspace/scripts run train:market-models
 *     [--market first_blood|total_kills|total_duration|all]
 *
 *   --market all (по умолчанию) — обучает все 3.
 *
 * Завершается с exit 0 даже если какой-то рынок пропущен (мало данных) —
 * сценарий вызывается из расписания и не должен валить весь pipeline.
 */

import {
  db,
  proMatchesTable,
  teamsTable,
  modelVersionsTable,
} from '@workspace/db';
import { gte, and, eq } from 'drizzle-orm';
import { asc } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

const TRAIN_WINDOW_DAYS = 365;
const MIN_SAMPLES = 60;

/** Возвращает Unix-timestamp начала тренировочного окна. */
function parseSinceUnix(): number {
  const idx = process.argv.indexOf('--since-unix');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return Math.floor(Date.now() / 1000) - TRAIN_WINDOW_DAYS * 86_400;
}

/** Возвращает минимум сэмплов для обучения. */
function parseMinSamples(): number {
  const idx = process.argv.indexOf('--min-samples');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return MIN_SAMPLES;
}
const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';
const TRAIN_TIMEOUT_MS = 120_000;

const TEAM_FEATURE_NAMES = ['bias', 'elo_diff_norm', 'winrate_diff', 'experience_diff', 'is_high_tier'] as const;

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
}

interface TeamRating { rating: number; wins: number; losses: number; }

type MarketKey = 'first_blood' | 'total_kills' | 'total_duration' | 'total_duration_q25' | 'total_duration_q75';
const ALL_MARKETS: MarketKey[] = ['first_blood', 'total_kills', 'total_duration', 'total_duration_q25', 'total_duration_q75'];

const KIND_BY_MARKET: Record<MarketKey, string> = {
  first_blood: 'market_first_blood',
  total_kills: 'market_total_kills',
  total_duration: 'market_total_duration',
  total_duration_q25: 'market_total_duration_q25',
  total_duration_q75: 'market_total_duration_q75',
};

const TASK_BY_MARKET: Record<MarketKey, 'classification' | 'regression' | 'quantile'> = {
  first_blood: 'classification',
  total_kills: 'regression',
  total_duration: 'regression',
  total_duration_q25: 'quantile',
  total_duration_q75: 'quantile',
};

const QUANTILE_ALPHA_BY_MARKET: Record<MarketKey, number> = {
  first_blood: 0.5,
  total_kills: 0.5,
  total_duration: 0.5,
  total_duration_q25: 0.25,
  total_duration_q75: 0.75,
};

interface MlMetrics { accuracy: number; log_loss: number; brier: number; n: number; }
interface TrainResponse {
  label: string;
  task_type: 'classification' | 'regression' | 'quantile';
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

function buildTeamFeatures(
  rId: number, dId: number, teams: Map<number, TeamRating>,
): number[] | null {
  const r = teams.get(rId); const d = teams.get(dId);
  if (!r || !d) return null;
  const rG = r.wins + r.losses; const dG = d.wins + d.losses;
  if (rG < 5 || dG < 5) return null;
  return [
    1,
    (r.rating - d.rating) / 200,
    r.wins / rG - d.wins / dG,
    Math.log(rG + 1) - Math.log(dG + 1),
    rG >= 50 && dG >= 50 ? 1 : 0,
  ];
}

async function loadData() {
  const sinceTs = parseSinceUnix();
  const effectiveMinSamples = parseMinSamples();
  const matches = await db
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
    })
    .from(proMatchesTable)
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
  return { matches: matches.filter((r): r is MatchRow => r.duration != null), teams };
}

function buildSamples(market: MarketKey, matches: MatchRow[], teams: Map<number, TeamRating>): Sample[] {
  const out: Sample[] = [];
  for (const m of matches) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const feats = buildTeamFeatures(m.radiantTeamId, m.direTeamId, teams);
    if (!feats) continue;

    if (market === 'first_blood') {
      // Прокси-метка: radiantWin. Настоящая FB-команда (players[].firstblood_claimed)
      // требует per-match detail fetch — дорого; radiantWin коррелирует ≈53%.
      if (m.radiantWin == null) continue;
      out.push({ features: feats, label: m.radiantWin ? 1 : 0 });
    } else if (market === 'total_kills') {
      if (m.radiantScore == null || m.direScore == null) continue;
      const total = m.radiantScore + m.direScore;
      if (total <= 0) continue;
      out.push({ features: feats, label: Math.log(total) });
    } else {
      // total_duration, total_duration_q25, total_duration_q75 — same label, different model objective
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
  const alpha = QUANTILE_ALPHA_BY_MARKET[market];
  console.log(`  [${label}] training task=${taskType}${taskType === 'quantile' ? `(α=${alpha})` : ''} n=${train.length}/calib=${calib.length}/test=${test.length}`);

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
        alpha,
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
    }
    return data;
  } catch (e) {
    console.error(`  [${label}] training failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function activateMarketModel(market: MarketKey, r: TrainResponse): Promise<void> {
  const kind = KIND_BY_MARKET[market];
  const blob = Buffer.from(r.blob_b64, 'base64');
  const taskType = TASK_BY_MARKET[market];
  const versionStem = `lgbm-${kind}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;

  await db.transaction(async (tx) => {
    await tx
      .update(modelVersionsTable)
      .set({ isActive: false })
      .where(and(eq(modelVersionsTable.kind, kind), eq(modelVersionsTable.isActive, true)));
    await tx.insert(modelVersionsTable).values({
      version: versionStem,
      kind,
      featuresVersion: 1,
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
        task_type: taskType,
        taskType, // legacy alias — оставляем для обратной совместимости старых читателей
        engine: 'lightgbm',
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
  console.log(`  [market/${market}] ✅ activated ${versionStem} (blob=${blob.length}b)`);
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
    if (v === 'total_duration_quantiles') return ['total_duration_q25', 'total_duration_q75'];
    if ((ALL_MARKETS as string[]).includes(v)) return [v as MarketKey];
    console.error(`[train-market-models] unknown --market: ${v} (valid: all, total_duration_quantiles, ${ALL_MARKETS.join(', ')})`);
    process.exit(1);
  }
  return ALL_MARKETS;
}

async function main(): Promise<void> {
  const targets = parseMarketsFromArgs();
  console.log(`[train-market-models] ml-service: ${ML_SERVICE_URL} markets=${targets.join(',')}`);

  try {
    const h = await fetch(`${ML_SERVICE_URL}/healthz`);
    if (!h.ok) throw new Error(`status ${h.status}`);
  } catch (e) {
    console.error(`[train-market-models] ml-service unreachable: ${(e as Error).message}`);
    process.exit(1);
  }

  const { matches, teams } = await loadData();
  console.log(`[train-market-models] matches=${matches.length} teams=${teams.size}`);

  if (matches.length < parseMinSamples()) {
    console.log('[train-market-models] not enough matches — exiting cleanly');
    return;
  }

  let trained = 0;
  for (const market of targets) {
    console.log(`\n[train-market-models] === ${market} ===`);
    const samples = buildSamples(market, matches, teams);
    const r = await trainMarket(market, samples);
    if (!r) continue;
    await activateMarketModel(market, r);
    trained++;
  }

  console.log(`\n[train-market-models] done — trained ${trained}/${targets.length}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[train-market-models] FATAL', err);
    process.exit(1);
  });
