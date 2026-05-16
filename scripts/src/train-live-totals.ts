/**
 * T3.5 — обучение LightGBM live-regression моделей для тоталов в реальном
 * времени. В отличие от prematch `market_total_kills` / `market_total_duration`
 * (которые видят только команды до начала матча), эти модели видят live-снапшот
 * и предсказывают **финальный** total_kills / duration_sec на основе текущего
 * состояния игры.
 *
 *   live_total_kills    : regression на log(final_kills + 1)
 *   live_total_duration : regression на log(final_duration_sec)
 *
 * Источник обучающих данных — JOIN `live_snapshots × pro_matches` где у
 * pro_matches есть финальный счёт и duration (т.е. матч закончен и tracked).
 *
 * Фичи (v1, 7 шт., только OpenDota-сторона; Stratz xpAdvantage/nwAdvantage
 * добавятся в v2 когда наполнится `live_snapshots` после T0.5a):
 *
 *   [bias, game_min, kills_so_far, kill_rate_per_min, kill_diff_abs,
 *    nw_lead_kgold, building_state_norm]
 *
 * Sub-sampling: для каждого матча берём максимум 5 снапшотов из временных
 * окон [3, 8, 15, 25, 40] минут (ближайший к центру окна). Это снижает
 * autocorrelation и выравнивает покрытие game_time'ов в обучающей выборке.
 *
 * Output: `model_versions` row с `kind` ∈ {live_total_kills, live_total_duration},
 * `engine='lightgbm'`, `featuresVersion=1`, атомарный swap per-market.
 *
 * CLI:
 *   pnpm --filter @workspace/scripts run train:live-totals
 *     [--market kills|duration|all]   (default: all)
 *     [--since-days N]                (default: 180)
 *     [--min-samples N]               (default: 200)
 */

import {
  db,
  liveSnapshotsTable,
  proMatchesTable,
  modelVersionsTable,
} from '@workspace/db';
import { sql, and, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';
const TRAIN_TIMEOUT_MS = 120_000;

const DEFAULT_SINCE_DAYS = 180;
const DEFAULT_MIN_SAMPLES = 200;
const BUCKET_CENTERS_MIN = [3, 8, 15, 25, 40] as const;

const FEATURE_NAMES = [
  'bias',
  'game_min',
  'kills_so_far',
  'kill_rate_per_min',
  'kill_diff_abs',
  'nw_lead_kgold',
  'building_state_norm',
] as const;

type LiveMarket = 'kills' | 'duration';
const ALL_MARKETS: LiveMarket[] = ['kills', 'duration'];

const KIND_BY_MARKET: Record<LiveMarket, string> = {
  kills: 'live_total_kills',
  duration: 'live_total_duration',
};

interface JoinRow {
  matchId: number;
  gameTimeSec: number;
  radiantScore: number | null;
  direScore: number | null;
  radiantLead: number | null;
  buildingState: number | null;
  finalKills: number;
  finalDurationSec: number;
}

interface Sample { features: number[]; label: number; }

interface MlMetrics { accuracy: number; log_loss: number; brier: number; n: number; }
interface TrainResponse {
  label: string;
  task_type: 'regression';
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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

function parseMarkets(): LiveMarket[] {
  const v = arg('market') ?? 'all';
  if (v === 'all') return ALL_MARKETS;
  if (v === 'kills' || v === 'duration') return [v];
  console.error(`[train-live-totals] unknown --market: ${v}`);
  process.exit(1);
}

function mlServiceToken(): string | null {
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) return env;
  try {
    const v = readFileSync(ML_TOKEN_FILE, 'utf8').trim();
    return v || null;
  } catch { return null; }
}

/**
 * Собирает feature-вектор из live-снапшота. ВАЖНО: эта функция должна быть
 * побайтово идентична `buildLiveTotalsFeatures` в
 * `artifacts/api-server/src/services/MarketLgbm.ts` (порядок и формулы) —
 * иначе serialized blob будет инферить на «другой» feature view.
 */
export function buildLiveTotalsFeatures(s: {
  gameTimeSec: number;
  radiantScore: number | null;
  direScore: number | null;
  radiantLead: number | null;
  buildingState: number | null;
}): number[] {
  const gameMin = Math.max(0.5, s.gameTimeSec / 60);
  const kills = (s.radiantScore ?? 0) + (s.direScore ?? 0);
  const killRate = kills / gameMin;
  const killDiffAbs = Math.abs((s.radiantScore ?? 0) - (s.direScore ?? 0));
  const nwLeadKgold = (s.radiantLead ?? 0) / 1000;
  // building_state — 22-битный bitmask towers/barracks; нормализуем к [0,1].
  // 4_194_304 = 2^22. LightGBM сам найдёт пороги.
  const buildingNorm = (s.buildingState ?? 4_194_303) / 4_194_304;
  return [1, gameMin, kills, killRate, killDiffAbs, nwLeadKgold, buildingNorm];
}

async function loadJoinedRows(sinceUnixMs: number): Promise<JoinRow[]> {
  const rows = await db
    .select({
      matchId: liveSnapshotsTable.matchId,
      gameTimeSec: liveSnapshotsTable.gameTimeSec,
      radiantScore: liveSnapshotsTable.radiantScore,
      direScore: liveSnapshotsTable.direScore,
      radiantLead: liveSnapshotsTable.radiantLead,
      buildingState: liveSnapshotsTable.buildingState,
      finalRScore: proMatchesTable.radiantScore,
      finalDScore: proMatchesTable.direScore,
      finalDuration: proMatchesTable.duration,
    })
    .from(liveSnapshotsTable)
    .innerJoin(proMatchesTable, eq(proMatchesTable.matchId, liveSnapshotsTable.matchId))
    .where(sql`${liveSnapshotsTable.capturedAt} > to_timestamp(${Math.floor(sinceUnixMs / 1000)})
      AND ${liveSnapshotsTable.gameTimeSec} IS NOT NULL
      AND ${liveSnapshotsTable.gameTimeSec} >= 60
      AND ${proMatchesTable.duration} IS NOT NULL
      AND ${proMatchesTable.duration} > 0
      AND ${liveSnapshotsTable.gameTimeSec} < ${proMatchesTable.duration}
      AND ${proMatchesTable.radiantScore} IS NOT NULL
      AND ${proMatchesTable.direScore} IS NOT NULL`);

  const out: JoinRow[] = [];
  for (const r of rows) {
    if (r.gameTimeSec == null || r.finalDuration == null) continue;
    if (r.finalRScore == null || r.finalDScore == null) continue;
    out.push({
      matchId: r.matchId,
      gameTimeSec: r.gameTimeSec,
      radiantScore: r.radiantScore,
      direScore: r.direScore,
      radiantLead: r.radiantLead,
      buildingState: r.buildingState,
      finalKills: r.finalRScore + r.finalDScore,
      finalDurationSec: r.finalDuration,
    });
  }
  return out;
}

/**
 * Sub-sample: для каждого матча оставляем ≤5 снапшотов, ближайших к
 * BUCKET_CENTERS_MIN. Снижает временную автокорреляцию (соседние снапшоты
 * 60s apart почти идентичны) и выравнивает покрытие фаз матча.
 */
function subsampleByBuckets(rows: JoinRow[]): JoinRow[] {
  const byMatch = new Map<number, JoinRow[]>();
  for (const r of rows) {
    const list = byMatch.get(r.matchId) ?? [];
    list.push(r);
    byMatch.set(r.matchId, list);
  }
  const out: JoinRow[] = [];
  for (const list of byMatch.values()) {
    for (const centerMin of BUCKET_CENTERS_MIN) {
      const centerSec = centerMin * 60;
      let best: JoinRow | null = null;
      let bestDist = Infinity;
      for (const r of list) {
        const d = Math.abs(r.gameTimeSec - centerSec);
        if (d < bestDist) { bestDist = d; best = r; }
      }
      // не далее ±3 мин от центра bucket'а
      if (best && bestDist <= 3 * 60) out.push(best);
    }
  }
  // chronological order — критично для time-based train/test split
  out.sort((a, b) => a.matchId - b.matchId || a.gameTimeSec - b.gameTimeSec);
  return out;
}

function buildSamples(market: LiveMarket, rows: JoinRow[]): Array<Sample & { matchId: number }> {
  const out: Array<Sample & { matchId: number }> = [];
  for (const r of rows) {
    const feats = buildLiveTotalsFeatures(r);
    if (market === 'kills') {
      if (r.finalKills < 0) continue;
      out.push({ features: feats, label: Math.log(r.finalKills + 1), matchId: r.matchId });
    } else {
      if (r.finalDurationSec <= 0) continue;
      out.push({ features: feats, label: Math.log(r.finalDurationSec), matchId: r.matchId });
    }
  }
  return out;
}

/**
 * Group-by-match split: 80% / 10% / 10% по уникальным `matchId`, не по rows.
 * Иначе разные снапшоты одного матча попадают в train+test и инфлейтят
 * test-метрики (architect-feedback). matchId здесь стабильно растёт во
 * времени (Dota match_id монотонен), так что split одновременно time-aware.
 */
function splitByMatch<T extends { features: number[]; label: number; matchId: number }>(samples: T[]): { train: Sample[]; calib: Sample[]; test: Sample[] } {
  const matchIds = Array.from(new Set(samples.map(s => s.matchId))).sort((a, b) => a - b);
  const n = matchIds.length;
  const trainEnd = Math.floor(n * 0.8);
  const calibEnd = Math.floor(n * 0.9);
  const trainSet = new Set(matchIds.slice(0, trainEnd));
  const calibSet = new Set(matchIds.slice(trainEnd, calibEnd));
  const train: Sample[] = [];
  const calib: Sample[] = [];
  const test: Sample[] = [];
  for (const s of samples) {
    const plain = { features: s.features, label: s.label };
    if (trainSet.has(s.matchId)) train.push(plain);
    else if (calibSet.has(s.matchId)) calib.push(plain);
    else test.push(plain);
  }
  return { train, calib, test };
}

async function trainMarket(market: LiveMarket, samples: Array<Sample & { matchId: number }>, minSamples: number): Promise<TrainResponse | null> {
  const label = `live/${market}`;
  if (samples.length < minSamples) {
    console.log(`  [${label}] SKIP: only ${samples.length} samples (need ${minSamples}+)`);
    return null;
  }
  const { train, calib, test } = splitByMatch(samples);
  console.log(`  [${label}] training task=regression n=${train.length}/calib=${calib.length}/test=${test.length}`);

  const token = mlServiceToken();
  if (!token) {
    console.error(`  [${label}] no ML_SERVICE_TOKEN (env or ${ML_TOKEN_FILE})`);
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
        feature_names: FEATURE_NAMES,
        task_type: 'regression',
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
    console.log(`  [${label}] TEST r2=${tm.accuracy.toFixed(3)} rmse=${tm.brier.toFixed(4)} mae=${tm.log_loss.toFixed(4)} (n=${tm.n}, residual_std=${data.residual_std?.toFixed(4)})`);
    const importances = Object.entries(data.feature_importance)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(', ');
    console.log(`  [${label}] IMPORTANCE ${importances}`);
    return data;
  } catch (e) {
    console.error(`  [${label}] training failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function activate(market: LiveMarket, r: TrainResponse, sinceDays: number): Promise<void> {
  const kind = KIND_BY_MARKET[market];
  const blob = Buffer.from(r.blob_b64, 'base64');
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
        market: `live_${market}`,
        task_type: 'regression',
        taskType: 'regression',
        engine: 'lightgbm',
        residualStd: r.residual_std,
        testRaw: r.test_metrics_raw,
        testCalibrated: r.test_metrics_calibrated,
        calibSampleSize: r.calib_metrics.n,
        baselineAcc: r.baseline_acc,
        featureImportance: r.feature_importance,
        windowDays: sinceDays,
        trainSeconds: r.train_seconds,
        blobBytes: blob.length,
        featureNames: FEATURE_NAMES,
      },
      isActive: true,
    });
  });
  console.log(`  [live/${market}] ✅ activated ${versionStem} (blob=${blob.length}b)`);
}

async function main(): Promise<void> {
  const targets = parseMarkets();
  const sinceDays = parseInt(arg('since-days') ?? String(DEFAULT_SINCE_DAYS), 10);
  const minSamples = parseInt(arg('min-samples') ?? String(DEFAULT_MIN_SAMPLES), 10);
  const sinceUnixMs = Date.now() - sinceDays * 86_400_000;
  console.log(`[train-live-totals] ml-service: ${ML_SERVICE_URL} markets=${targets.join(',')} since=${sinceDays}d minSamples=${minSamples}`);

  try {
    const h = await fetch(`${ML_SERVICE_URL}/healthz`);
    if (!h.ok) throw new Error(`status ${h.status}`);
  } catch (e) {
    console.error(`[train-live-totals] ml-service unreachable: ${(e as Error).message}`);
    process.exit(1);
  }

  const raw = await loadJoinedRows(sinceUnixMs);
  const sampled = subsampleByBuckets(raw);
  const matchCount = new Set(sampled.map(r => r.matchId)).size;
  console.log(`[train-live-totals] joined rows=${raw.length} → subsampled=${sampled.length} (matches=${matchCount})`);

  let trained = 0;
  for (const market of targets) {
    console.log(`\n[train-live-totals] === ${market} ===`);
    const samples = buildSamples(market, sampled);
    const r = await trainMarket(market, samples, minSamples);
    if (!r) continue;
    await activate(market, r, sinceDays);
    trained++;
  }
  console.log(`\n[train-live-totals] done — trained ${trained}/${targets.length}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[train-live-totals] FATAL', err);
    process.exit(1);
  });
