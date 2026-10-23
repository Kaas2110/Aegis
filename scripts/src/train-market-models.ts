/**
 * Wave 4 — обучение LightGBM-моделей для производных рынков:
 *   - market_first_blood    : classification по подтверждённому FIRSTBLOOD
 *                             objective + kills_log; неизвестные метки исключаются
 *   - market_total_kills    : regression на log(radiant_score+dire_score)
 *   - market_total_duration : regression на log(duration_sec)
 *
 * Все модели тренируются через ml-service (`POST /train`) с одним и тем
 * же team-feature-set'ом (5 фич: bias, elo_diff_norm, winrate_diff,
 * experience_diff, is_high_tier) — что уже есть для prematch_winner.
 *
 * Сохранение в `model_versions` с `engine='lightgbm'`, `binaryBlob`,
 * `weights={}` (jsonb NOT NULL — кладём пустой объект как маркер; реальные
 * параметры в blob). Только неактивные кандидаты: публикация требует
 * отдельного проверенного manifest и не выполняется этим скриптом.
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
  matchDraftsTable,
  matchParsedTable,
} from '@workspace/db';
import { gte, and, eq, inArray } from 'drizzle-orm';
import { asc } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { assertCandidateOnlyArgs, saveLegacyCandidates } from './lib/training-candidates';
import { firstBloodRadiantLabel } from './lib/first-blood-label';
import {
  loadTeamRostersMap, loadTeamHeroPoolMap, loadHeroBenchmarksMap,
  loadHeroItemPopularityMap, loadPlayerTotalsMap, loadPlayerCountsMap,
  loadPlayerWlProMap,
  buildE1KillsFeatures, buildE1DurationFeatures, buildE1FbFeatures,
  E1_MARKET_KILLS_FEATURE_NAMES, E1_MARKET_DURATION_FEATURE_NAMES,
  E1_MARKET_FB_FEATURE_NAMES,
  type HeroBenchmarksMap, type HeroItemPopularityMap,
} from './lib/e1-features';

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

type MarketKey =
  | 'first_blood' | 'total_kills' | 'total_duration' | 'total_duration_q25' | 'total_duration_q75'
  | 'first_blood_with_draft' | 'total_kills_with_draft' | 'total_duration_with_draft'
  | 'total_duration_q25_with_draft' | 'total_duration_q75_with_draft';

const PURE_MARKETS: MarketKey[] = [
  'first_blood', 'total_kills', 'total_duration', 'total_duration_q25', 'total_duration_q75',
];
const WITH_DRAFT_MARKETS: MarketKey[] = [
  'first_blood_with_draft', 'total_kills_with_draft', 'total_duration_with_draft',
  'total_duration_q25_with_draft', 'total_duration_q75_with_draft',
];
const ALL_MARKETS: MarketKey[] = [...PURE_MARKETS, ...WITH_DRAFT_MARKETS];

const KIND_BY_MARKET: Record<MarketKey, string> = {
  first_blood: 'market_first_blood',
  total_kills: 'market_total_kills',
  total_duration: 'market_total_duration',
  total_duration_q25: 'market_total_duration_q25',
  total_duration_q75: 'market_total_duration_q75',
  first_blood_with_draft: 'market_first_blood_with_draft',
  total_kills_with_draft: 'market_total_kills_with_draft',
  total_duration_with_draft: 'market_total_duration_with_draft',
  total_duration_q25_with_draft: 'market_total_duration_q25_with_draft',
  total_duration_q75_with_draft: 'market_total_duration_q75_with_draft',
};

function isWithDraft(m: MarketKey): boolean {
  return m.endsWith('_with_draft');
}
function pureFamily(m: MarketKey): 'first_blood' | 'total_kills' | 'total_duration' | 'total_duration_q25' | 'total_duration_q75' {
  return (isWithDraft(m) ? m.slice(0, -'_with_draft'.length) : m) as ReturnType<typeof pureFamily>;
}

const TASK_BY_FAMILY: Record<ReturnType<typeof pureFamily>, 'classification' | 'regression' | 'quantile'> = {
  first_blood: 'classification',
  total_kills: 'regression',
  total_duration: 'regression',
  total_duration_q25: 'quantile',
  total_duration_q75: 'quantile',
};

const QUANTILE_ALPHA_BY_FAMILY: Record<ReturnType<typeof pureFamily>, number> = {
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

interface DraftRow {
  radiantPicks: number[];
  direPicks: number[];
}

async function loadData() {
  const sinceTs = parseSinceUnix();
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

async function loadFirstBloodLabels(matchIds: number[]): Promise<Map<number, 0 | 1>> {
  const labels = new Map<number, 0 | 1>();
  // Keep parsed payload memory bounded; never infer a missing event from map winner.
  for (let i = 0; i < matchIds.length; i += 500) {
    const rows = await db.select({
      matchId: matchParsedTable.matchId,
      objectives: matchParsedTable.objectives,
      players: matchParsedTable.players,
    }).from(matchParsedTable).where(inArray(matchParsedTable.matchId, matchIds.slice(i, i + 500)));
    for (const row of rows) {
      const label = firstBloodRadiantLabel(row.objectives, row.players);
      if (label != null) labels.set(row.matchId, label);
    }
  }
  console.log(`[train-market-models] first-blood confirmed=${labels.size}, missing/ambiguous=${matchIds.length - labels.size}`);
  return labels;
}

interface BuildContext {
  teams: Map<number, TeamRating>;
  drafts: Map<number, DraftRow>;
  benchmarks: HeroBenchmarksMap;
  itemPop: HeroItemPopularityMap;
  firstBloodLabels: Map<number, 0 | 1>;
}

function buildSamples(market: MarketKey, matches: MatchRow[], ctx: BuildContext): Sample[] {
  const out: Sample[] = [];
  const withDraft = isWithDraft(market);
  const fam = pureFamily(market);
  for (const m of matches) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const teamFeats = buildTeamFeatures(m.radiantTeamId, m.direTeamId, ctx.teams);
    if (!teamFeats) continue;

    let feats: number[];
    if (withDraft) {
      const d = ctx.drafts.get(m.matchId);
      if (!d) continue; // sample только если есть полный draft
      let e1: number[];
      if (fam === 'first_blood') {
        e1 = buildE1FbFeatures({
          radiantPicks: d.radiantPicks, direPicks: d.direPicks,
          benchmarks: ctx.benchmarks, itemPop: ctx.itemPop,
        });
      } else if (fam === 'total_kills') {
        e1 = buildE1KillsFeatures({
          radiantPicks: d.radiantPicks, direPicks: d.direPicks, benchmarks: ctx.benchmarks,
        });
      } else {
        // total_duration + quantiles
        e1 = buildE1DurationFeatures({
          radiantPicks: d.radiantPicks, direPicks: d.direPicks, itemPop: ctx.itemPop,
        });
      }
      feats = [...teamFeats, ...e1];
    } else {
      feats = teamFeats;
    }

    if (fam === 'first_blood') {
      const label = ctx.firstBloodLabels.get(m.matchId);
      if (label == null) continue;
      out.push({ features: feats, label });
    } else if (fam === 'total_kills') {
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

function featureNamesFor(market: MarketKey): readonly string[] {
  if (!isWithDraft(market)) return TEAM_FEATURE_NAMES;
  const fam = pureFamily(market);
  if (fam === 'first_blood') return [...TEAM_FEATURE_NAMES, ...E1_MARKET_FB_FEATURE_NAMES];
  if (fam === 'total_kills') return [...TEAM_FEATURE_NAMES, ...E1_MARKET_KILLS_FEATURE_NAMES];
  return [...TEAM_FEATURE_NAMES, ...E1_MARKET_DURATION_FEATURE_NAMES];
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
  const taskType = TASK_BY_FAMILY[pureFamily(market)];
  const alpha = QUANTILE_ALPHA_BY_FAMILY[pureFamily(market)];
  const featureNames = featureNamesFor(market);
  // Контракт: pure=3 (TEAM_FEATURE_NAMES), fb_with_draft=3+4=7, kills_with_draft=3+4=7, duration*=3+6=9
  const fam = pureFamily(market);
  const expectedDim = !isWithDraft(market) ? TEAM_FEATURE_NAMES.length
    : (fam === 'first_blood' ? TEAM_FEATURE_NAMES.length + E1_MARKET_FB_FEATURE_NAMES.length
      : fam === 'total_kills' ? TEAM_FEATURE_NAMES.length + E1_MARKET_KILLS_FEATURE_NAMES.length
      : TEAM_FEATURE_NAMES.length + E1_MARKET_DURATION_FEATURE_NAMES.length);
  if (featureNames.length !== expectedDim) {
    throw new Error(`[${label}] feature-name dim mismatch: got ${featureNames.length} expected ${expectedDim}`);
  }
  if (samples[0].features.length !== expectedDim) {
    throw new Error(`[${label}] sample features dim mismatch: got ${samples[0].features.length} expected ${expectedDim}`);
  }
  console.log(`  [${label}] training task=${taskType}${taskType === 'quantile' ? `(α=${alpha})` : ''} n=${train.length}/calib=${calib.length}/test=${test.length} fdim=${featureNames.length}`);

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
        feature_names: featureNames,
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

async function saveMarketCandidate(market: MarketKey, r: TrainResponse): Promise<void> {
  const kind = KIND_BY_MARKET[market];
  const blob = Buffer.from(r.blob_b64, 'base64');
  const taskType = TASK_BY_FAMILY[pureFamily(market)];
  const versionStem = `lgbm-${kind}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;

  await saveLegacyCandidates(db, [{
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
        targetDefinition: pureFamily(market) === 'first_blood'
          ? 'radiant_first_blood_objective_corroborated_kill_log_v1'
          : pureFamily(market) === 'total_kills' ? 'log_final_total_kills' : 'log_final_duration_seconds',
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
      isActive: false,
    }], {
    trainer: 'train-market-models', seed: 42,
    limitations: ['current_team_hero_aggregates_not_as_of', 'row_split_not_series_grouped', 'independent_probability_interval_validation_required'],
  });
  console.log(`  [market/${market}] Saved inactive, unvalidated candidate ${versionStem}; active models unchanged`);
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
  assertCandidateOnlyArgs();
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

  // E1 + drafts только если хоть один with_draft target есть.
  const needsDraft = targets.some(isWithDraft);
  let drafts = new Map<number, DraftRow>();
  let benchmarks: HeroBenchmarksMap = new Map();
  let itemPop: HeroItemPopularityMap = new Map();
  if (needsDraft) {
    console.log('[train-market-models] loading match_drafts + E1 (benchmarks, itemPop)…');
    const matchIds = matches.map(m => m.matchId);
    [drafts, benchmarks, itemPop] = await Promise.all([
      loadDraftsForMatches(matchIds),
      loadHeroBenchmarksMap(),
      loadHeroItemPopularityMap(),
    ]);
    console.log(`[train-market-models] drafts=${drafts.size}/${matchIds.length} benchmarks=${benchmarks.size} itemPop=${itemPop.size}`);
  }
  const firstBloodLabels = targets.some(market => pureFamily(market) === 'first_blood')
    ? await loadFirstBloodLabels(matches.map(match => match.matchId))
    : new Map<number, 0 | 1>();
  const ctx: BuildContext = { teams, drafts, benchmarks, itemPop, firstBloodLabels };

  let trained = 0;
  for (const market of targets) {
    console.log(`\n[train-market-models] === ${market} ===`);
    const samples = buildSamples(market, matches, ctx);
    const r = await trainMarket(market, samples);
    if (!r) continue;
    await saveMarketCandidate(market, r);
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
