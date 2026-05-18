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
  matchDraftsTable,
  teamsTable,
} from '@workspace/db';
import { sql, and, eq, inArray } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import {
  loadHeroBenchmarksMap, loadHeroItemPopularityMap,
  buildE1LiveTotalsFeatures, E1_LIVE_TOTALS_FEATURE_NAMES,
  type HeroBenchmarksMap, type HeroItemPopularityMap,
} from './lib/e1-features';

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

type LiveMarket = 'kills' | 'duration' | 'kills_with_draft' | 'duration_with_draft';
const ALL_MARKETS: LiveMarket[] = ['kills', 'duration', 'kills_with_draft', 'duration_with_draft'];
const VALID_MARKET_ARGS: ReadonlySet<string> = new Set<string>([
  'kills', 'duration', 'all', 'pure', 'with_draft',
  'kills_with_draft', 'duration_with_draft',
]);

const KIND_BY_MARKET: Record<LiveMarket, string> = {
  kills: 'live_total_kills',
  duration: 'live_total_duration',
  kills_with_draft: 'live_total_kills_with_draft',
  duration_with_draft: 'live_total_duration_with_draft',
};

function isWithDraft(m: LiveMarket): boolean {
  return m.endsWith('_with_draft');
}
function pureFamily(m: LiveMarket): 'kills' | 'duration' {
  return (isWithDraft(m) ? m.slice(0, -'_with_draft'.length) : m) as 'kills' | 'duration';
}

interface JoinRow {
  matchId: number;
  gameTimeSec: number;
  radiantScore: number | null;
  direScore: number | null;
  radiantLead: number | null;
  buildingState: number | null;
  finalKills: number;
  finalDurationSec: number;
  radiantTeamId: number | null;
  direTeamId: number | null;
}

interface DraftRow { radiantPicks: number[]; direPicks: number[]; }
interface TeamRating { rating: number; wins: number; losses: number; }

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
  if (!VALID_MARKET_ARGS.has(v)) {
    console.error(`[train-live-totals] unknown --market: ${v} (valid: ${[...VALID_MARKET_ARGS].join(', ')})`);
    process.exit(1);
  }
  if (v === 'all') return ALL_MARKETS;
  if (v === 'pure') return ['kills', 'duration'];
  if (v === 'with_draft') return ['kills_with_draft', 'duration_with_draft'];
  return [v as LiveMarket];
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
      radiantTeamId: proMatchesTable.radiantTeamId,
      direTeamId: proMatchesTable.direTeamId,
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
      radiantTeamId: r.radiantTeamId,
      direTeamId: r.direTeamId,
    });
  }
  return out;
}

async function loadDraftsForMatches(matchIds: number[]): Promise<Map<number, DraftRow>> {
  const out = new Map<number, DraftRow>();
  if (matchIds.length === 0) return out;
  const CHUNK = 5000;
  for (let i = 0; i < matchIds.length; i += CHUNK) {
    const chunk = matchIds.slice(i, i + CHUNK);
    const rows = await db.select({
      matchId: matchDraftsTable.matchId,
      radiantPicks: matchDraftsTable.radiantPicks,
      direPicks: matchDraftsTable.direPicks,
    }).from(matchDraftsTable).where(inArray(matchDraftsTable.matchId, chunk));
    for (const r of rows) {
      if (!Array.isArray(r.radiantPicks) || !Array.isArray(r.direPicks)) continue;
      if (r.radiantPicks.length !== 5 || r.direPicks.length !== 5) continue;
      if (new Set(r.radiantPicks).size !== 5 || new Set(r.direPicks).size !== 5) continue;
      out.set(r.matchId, { radiantPicks: r.radiantPicks, direPicks: r.direPicks });
    }
  }
  return out;
}

async function loadTeams(): Promise<Map<number, TeamRating>> {
  const rows = await db.select({
    teamId: teamsTable.teamId, rating: teamsTable.rating,
    wins: teamsTable.wins, losses: teamsTable.losses,
  }).from(teamsTable);
  const map = new Map<number, TeamRating>();
  for (const t of rows) {
    if (t.rating != null) {
      map.set(t.teamId, { rating: t.rating, wins: t.wins ?? 0, losses: t.losses ?? 0 });
    }
  }
  return map;
}

/**
 * team4 без bias: [elo_diff_norm, winrate_diff, experience_diff, is_high_tier].
 * Идентично логике в train-market-models.ts::buildTeamFeatures, но без 1-го bias-фитчи
 * (snapshot7 уже несёт bias).
 */
function buildTeamFeatures4(rId: number, dId: number, teams: Map<number, TeamRating>): number[] | null {
  const r = teams.get(rId); const d = teams.get(dId);
  if (!r || !d) return null;
  // ВАЖНО: формулы должны совпадать с MarketLgbm.buildTeamFeatures (минус
  // первый bias=1), иначе trainer/inference расходятся.
  const rG = r.wins + r.losses;
  const dG = d.wins + d.losses;
  if (rG < 5 || dG < 5) return null;
  const eloDiff = (r.rating - d.rating) / 200;
  const wrDiff = r.wins / rG - d.wins / dG;
  const expDiff = Math.log(rG + 1) - Math.log(dG + 1);
  return [eloDiff, wrDiff, expDiff, rG >= 50 && dG >= 50 ? 1 : 0];
}

const TEAM4_FEATURE_NAMES = [
  'elo_diff_norm', 'winrate_diff', 'experience_diff', 'is_high_tier',
] as const;

function featureNamesFor(market: LiveMarket): readonly string[] {
  if (!isWithDraft(market)) return FEATURE_NAMES;
  return [...FEATURE_NAMES, ...TEAM4_FEATURE_NAMES, ...E1_LIVE_TOTALS_FEATURE_NAMES];
}

interface BuildCtx {
  teams: Map<number, TeamRating>;
  drafts: Map<number, DraftRow>;
  benchmarks: HeroBenchmarksMap;
  itemPop: HeroItemPopularityMap;
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

function buildSamples(market: LiveMarket, rows: JoinRow[], ctx: BuildCtx): Array<Sample & { matchId: number }> {
  const out: Array<Sample & { matchId: number }> = [];
  const withDraft = isWithDraft(market);
  const fam = pureFamily(market);
  for (const r of rows) {
    const pure = buildLiveTotalsFeatures(r);
    let feats: number[];
    if (withDraft) {
      if (!r.radiantTeamId || !r.direTeamId) continue;
      const team4 = buildTeamFeatures4(r.radiantTeamId, r.direTeamId, ctx.teams);
      if (!team4) continue;
      const d = ctx.drafts.get(r.matchId);
      if (!d) continue;
      const e1 = buildE1LiveTotalsFeatures({
        radiantPicks: d.radiantPicks, direPicks: d.direPicks,
        benchmarks: ctx.benchmarks, itemPop: ctx.itemPop,
      });
      feats = [...pure, ...team4, ...e1];
    } else {
      feats = pure;
    }
    if (fam === 'kills') {
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
  const featureNames = featureNamesFor(market);
  console.log(`  [${label}] training task=regression n=${train.length}/calib=${calib.length}/test=${test.length} fdim=${featureNames.length}`);

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
        feature_names: featureNames,
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
        featureNames: featureNamesFor(market),
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

  // E1 + drafts + teams только если хоть один with_draft target есть.
  const needsDraft = targets.some(isWithDraft);
  let drafts = new Map<number, DraftRow>();
  let teams = new Map<number, TeamRating>();
  let benchmarks: HeroBenchmarksMap = new Map();
  let itemPop: HeroItemPopularityMap = new Map();
  if (needsDraft) {
    console.log('[train-live-totals] loading match_drafts + teams + E1 (benchmarks, itemPop)…');
    const matchIds = Array.from(new Set(sampled.map(r => r.matchId)));
    [drafts, teams, benchmarks, itemPop] = await Promise.all([
      loadDraftsForMatches(matchIds),
      loadTeams(),
      loadHeroBenchmarksMap(),
      loadHeroItemPopularityMap(),
    ]);
    console.log(`[train-live-totals] drafts=${drafts.size}/${matchIds.length} teams=${teams.size} benchmarks=${benchmarks.size} itemPop=${itemPop.size}`);
  }
  const ctx: BuildCtx = { teams, drafts, benchmarks, itemPop };

  let trained = 0;
  for (const market of targets) {
    console.log(`\n[train-live-totals] === ${market} ===`);
    const samples = buildSamples(market, sampled, ctx);
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
