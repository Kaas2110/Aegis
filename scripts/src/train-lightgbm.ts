/**
 * Wave 4: тренировка LightGBM-моделей через ml-service.
 *
 * Делает то же что `train-model.ts`, но:
 *   - формирует только тиры/бакеты с уже готовыми Sample[],
 *   - POST'ит каждый бакет в ml-service `POST /train`,
 *   - получает обратно blob (base64) + метрики + feature importance,
 *   - пишет в `model_versions` строку с `engine='lightgbm'`, `binaryBlob = bytes`,
 *     `weights = {}` (jsonb NOT NULL — кладём пустой объект как маркер).
 *
 * НЕ трогает строки с `engine='logreg'` — они остаются активными как fallback.
 * Активный для PredictionModel становится самый свежий (`createdAt DESC`),
 * с приоритетом lightgbm.
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run train:lightgbm
 *
 * Env:
 *   ML_SERVICE_URL — base URL ml-service, по умолчанию http://localhost:8090
 *   LIGHTGBM_KINDS — comma-separated подмножество (по умолчанию все 12)
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
import { readFileSync } from 'node:fs';
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
const MIN_SAMPLES_PER_BUCKET = 80;  // LightGBM нужно чуть больше чем LR
const MIN_AVG_GLICKO = 1200;
const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';

function mlServiceToken(): string | null {
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) return env;
  try {
    const v = readFileSync(ML_TOKEN_FILE, 'utf8').trim();
    return v || null;
  } catch { return null; }
}
const TRAIN_TIMEOUT_MS = 120_000;  // тренировка может быть долгой

const TEAM_FEATURE_NAMES = ['bias', 'elo_diff_norm', 'winrate_diff', 'experience_diff', 'is_high_tier'] as const;
const TEAM_FEATURE_DIM = TEAM_FEATURE_NAMES.length;

interface Sample { features: number[]; label: number; }
interface TeamRating { rating: number; wins: number; losses: number; }

interface MlMetrics {
  accuracy: number;
  log_loss: number;
  brier: number;
  n: number;
}
interface TrainResponse {
  label: string;
  blob_b64: string;
  feature_names: string[];
  train_metrics: MlMetrics;
  calib_metrics: MlMetrics;
  test_metrics_raw: MlMetrics;
  test_metrics_calibrated: MlMetrics;
  baseline_acc: number;
  feature_importance: Record<string, number>;
  train_seconds: number;
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

async function trainBucket(
  samples: Sample[],
  featureNames: string[],
  label: string,
): Promise<TrainResponse | null> {
  if (samples.length < MIN_SAMPLES_PER_BUCKET) {
    console.log(`  [${label}] SKIP: only ${samples.length} samples (need ${MIN_SAMPLES_PER_BUCKET}+)`);
    return null;
  }
  const n = samples.length;
  const trainEnd = Math.floor(n * 0.8);
  const calibEnd = Math.floor(n * 0.9);
  const train = samples.slice(0, trainEnd);
  const calib = samples.slice(trainEnd, calibEnd);
  const test = samples.slice(calibEnd);
  console.log(`  [${label}] training n=${train.length}/calib=${calib.length}/test=${test.length} dim=${featureNames.length}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAIN_TIMEOUT_MS);
  try {
    const token = mlServiceToken();
    if (!token) {
      console.error(`  [${label}] no ML_SERVICE_TOKEN (env or ${ML_TOKEN_FILE}) — restart ml-service first`);
      return null;
    }
    const res = await fetch(`${ML_SERVICE_URL}/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ml-token': token },
      body: JSON.stringify({ label, feature_names: featureNames, train, calib, test }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`  [${label}] ml-service ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as TrainResponse;
    const tm = data.test_metrics_calibrated;
    const tr = data.test_metrics_raw;
    console.log(
      `  [${label}] TRAIN acc=${(data.train_metrics.accuracy * 100).toFixed(1)}% brier=${data.train_metrics.brier.toFixed(4)}`,
    );
    console.log(
      `  [${label}] TEST raw  acc=${(tr.accuracy * 100).toFixed(1)}% brier=${tr.brier.toFixed(4)} logloss=${tr.log_loss.toFixed(4)}`,
    );
    console.log(
      `  [${label}] TEST cal  acc=${(tm.accuracy * 100).toFixed(1)}% brier=${tm.brier.toFixed(4)} logloss=${tm.log_loss.toFixed(4)} (baseline=${(data.baseline_acc * 100).toFixed(1)}%) — ${data.train_seconds.toFixed(1)}s`,
    );
    return data;
  } catch (e) {
    console.error(`  [${label}] training failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`[train-lightgbm] ml-service: ${ML_SERVICE_URL}`);
  // Ping
  try {
    const h = await fetch(`${ML_SERVICE_URL}/healthz`);
    if (!h.ok) throw new Error(`status ${h.status}`);
    console.log(`[train-lightgbm] ml-service healthy`);
  } catch (e) {
    console.error(`[train-lightgbm] ml-service unreachable: ${(e as Error).message}`);
    process.exit(1);
  }

  console.log('[train-lightgbm] Loading teams …');
  const teamsRows = await db.select({
    teamId: teamsTable.teamId, rating: teamsTable.rating,
    wins: teamsTable.wins, losses: teamsTable.losses,
  }).from(teamsTable);
  const teams = new Map<number, TeamRating>();
  for (const t of teamsRows) {
    if (t.rating != null) teams.set(t.teamId, { rating: t.rating, wins: t.wins ?? 0, losses: t.losses ?? 0 });
  }
  console.log(`[train-lightgbm] teams=${teams.size}`);

  const minStartTime = Math.floor(Date.now() / 1000) - TRAIN_WINDOW_DAYS * 86_400;
  const matches = await db.select({
    matchId: proMatchesTable.matchId,
    radiantTeamId: proMatchesTable.radiantTeamId,
    direTeamId: proMatchesTable.direTeamId,
    radiantWin: proMatchesTable.radiantWin,
    startTime: proMatchesTable.startTime,
  })
    .from(proMatchesTable)
    .where(gte(proMatchesTable.startTime, minStartTime))
    .orderBy(asc(proMatchesTable.startTime));
  console.log(`[train-lightgbm] matches in window=${matches.length}`);

  const draftsRows = await db.select({
    matchId: matchDraftsTable.matchId,
    radiantPicks: matchDraftsTable.radiantPicks,
    direPicks: matchDraftsTable.direPicks,
    radiantBans: matchDraftsTable.radiantBans,
    direBans: matchDraftsTable.direBans,
    radiantAccountIds: matchDraftsTable.radiantAccountIds,
    direAccountIds: matchDraftsTable.direAccountIds,
  }).from(matchDraftsTable);
  const drafts = new Map<number, typeof draftsRows[number]>();
  for (const d of draftsRows) drafts.set(d.matchId, d);

  const heroStatsRows = await db.select({
    heroId: heroStatsTable.heroId,
    proWinRate: heroStatsTable.proWinRate,
    proPickRate: heroStatsTable.proPickRate,
  }).from(heroStatsTable);
  const heroStats: HeroStatsMap = new Map();
  for (const h of heroStatsRows) heroStats.set(h.heroId, { proWinRate: h.proWinRate, proPickRate: h.proPickRate });

  const matchupsRows = await db.select({
    heroId: heroMatchupsTable.heroId, vsHeroId: heroMatchupsTable.vsHeroId,
    games: heroMatchupsTable.games, winRate: heroMatchupsTable.winRate,
  }).from(heroMatchupsTable);
  const matchups: HeroMatchupsMap = new Map();
  for (const m of matchupsRows) {
    let inner = matchups.get(m.heroId);
    if (!inner) { inner = new Map(); matchups.set(m.heroId, inner); }
    inner.set(m.vsHeroId, { games: m.games, winRate: m.winRate });
  }

  const phsRows = await db.select().from(playerHeroStatsTable);
  const playerHeroStats: PlayerHeroStatsMap = new Map();
  for (const r of phsRows) {
    let inner = playerHeroStats.get(r.accountId);
    if (!inner) { inner = new Map(); playerHeroStats.set(r.accountId, inner); }
    inner.set(r.heroId, { games: r.games, wins: r.wins });
  }
  const formRows = await db.select().from(teamRecentFormTable).where(eq(teamRecentFormTable.periodDays, 30));
  const recentForm: RecentFormMap = new Map();
  for (const r of formRows) recentForm.set(r.teamId, { winRate: r.winRate, games: r.games });
  const h2hRows = await db.select().from(teamH2HTable).where(eq(teamH2HTable.periodDays, 365));
  const h2h: H2HMap = new Map();
  for (const r of h2hRows) h2h.set(`${r.teamLowId}_${r.teamHighId}`, { games: r.games, winsLow: r.winsLow });

  const prRows = await db.select({
    accountId: playerRatingsTable.accountId,
    rating: playerRatingsTable.rating,
    rd: playerRatingsTable.rd,
  }).from(playerRatingsTable);
  const playerGlicko: PlayerGlickoMap = new Map();
  for (const r of prRows) playerGlicko.set(r.accountId, { rating: r.rating, rd: r.rd });

  console.log(
    `[train-lightgbm] drafts=${drafts.size} hero=${heroStats.size} matchups=${matchupsRows.length} phs=${playerHeroStats.size} form=${recentForm.size} h2h=${h2h.size} glicko=${playerGlicko.size}`,
  );

  // Сборка бакетов
  const v1All: Sample[] = [];
  const v1Bucket: Record<Tier, Sample[]> = { t1: [], t2: [], t3: [] };
  const v2All: Sample[] = [];
  const v2Bucket: Record<Tier, Sample[]> = { t1: [], t2: [], t3: [] };
  const v3All: Sample[] = [];
  const v3Bucket: Record<Tier, Sample[]> = { t1: [], t2: [], t3: [] };

  for (const m of matches) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const r = teams.get(m.radiantTeamId);
    const d = teams.get(m.direTeamId);
    if (!r || !d) continue;
    if ((r.rating + d.rating) / 2 < MIN_AVG_GLICKO) continue;
    const teamFeats = buildTeamFeatures(m.radiantTeamId, m.direTeamId, teams);
    if (!teamFeats) continue;

    const label = m.radiantWin ? 1 : 0;
    const tier = classifyTier(r.rating, d.rating);
    const v1S: Sample = { features: teamFeats, label };
    v1All.push(v1S); if (tier) v1Bucket[tier].push(v1S);

    const draft = drafts.get(m.matchId);
    if (!draft) continue;
    const heroFeats = buildHeroFeatures(
      draft.radiantPicks, draft.direPicks, draft.radiantBans, draft.direBans,
      heroStats, matchups,
    );
    if (!heroFeats) continue;
    const v2S: Sample = { features: [...teamFeats, ...heroFeats], label };
    v2All.push(v2S); if (tier) v2Bucket[tier].push(v2S);

    if (!draft.radiantAccountIds && !draft.direAccountIds) continue;
    const extraFeats = buildExtraFeatures({
      radiantTeamId: m.radiantTeamId, direTeamId: m.direTeamId,
      radiantPicks: draft.radiantPicks, direPicks: draft.direPicks,
      radiantAccountIds: draft.radiantAccountIds, direAccountIds: draft.direAccountIds,
      playerHeroStats, heroStats, recentForm, h2h, playerGlicko,
    });
    const v3S: Sample = { features: [...teamFeats, ...heroFeats, ...extraFeats], label };
    v3All.push(v3S); if (tier) v3Bucket[tier].push(v3S);
  }

  console.log(
    `[train-lightgbm] v1=${v1All.length} (t1=${v1Bucket.t1.length}/t2=${v1Bucket.t2.length}/t3=${v1Bucket.t3.length}) ` +
    `v2=${v2All.length} (t1=${v2Bucket.t1.length}/t2=${v2Bucket.t2.length}/t3=${v2Bucket.t3.length}) ` +
    `v3=${v3All.length} (t1=${v3Bucket.t1.length}/t2=${v3Bucket.t2.length}/t3=${v3Bucket.t3.length})`,
  );

  const v1Names = [...TEAM_FEATURE_NAMES];
  const v2Names = [...TEAM_FEATURE_NAMES, ...HERO_FEATURE_NAMES];
  const v3Names = [...TEAM_FEATURE_NAMES, ...HERO_FEATURE_NAMES, ...EXTRA_FEATURE_NAMES];

  // Фильтрация по меткам бакетов: env LIGHTGBM_KINDS (comma-separated)
  // и/или CLI `--label v3/t1` (можно повторять). Whitelist валидируется
  // против полного списка меток ниже (см. jobs[].label).
  const allowed = new Set<string>();
  for (const v of (process.env.LIGHTGBM_KINDS ?? '').split(',').map(s => s.trim())) {
    if (v) allowed.add(v);
  }
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label' && argv[i + 1]) { allowed.add(argv[i + 1]); i++; }
    else if (a.startsWith('--label=')) allowed.add(a.slice('--label='.length));
  }
  const include = (label: string) => allowed.size === 0 || allowed.has(label);
  if (allowed.size > 0) {
    console.log(`[train-lightgbm] filter: ${[...allowed].join(', ')}`);
  }

  type Job = {
    label: string;
    fv: 1 | 2 | 3;
    kind: typeof ALL_PREMATCH_KINDS[number];
    tier: Tier | null;
    samples: Sample[];
    names: string[];
  };

  const jobs: Job[] = ([
    { label: 'v1/fallback', fv: 1 as const, kind: 'prematch_winner' as const, tier: null, samples: v1All,       names: v1Names },
    { label: 'v1/t1',       fv: 1 as const, kind: tierKind('t1'),              tier: 't1' as const, samples: v1Bucket.t1, names: v1Names },
    { label: 'v1/t2',       fv: 1 as const, kind: tierKind('t2'),              tier: 't2' as const, samples: v1Bucket.t2, names: v1Names },
    { label: 'v1/t3',       fv: 1 as const, kind: tierKind('t3'),              tier: 't3' as const, samples: v1Bucket.t3, names: v1Names },
    { label: 'v2/fallback', fv: 2 as const, kind: 'prematch_winner' as const, tier: null, samples: v2All,       names: v2Names },
    { label: 'v2/t1',       fv: 2 as const, kind: tierKind('t1'),              tier: 't1' as const, samples: v2Bucket.t1, names: v2Names },
    { label: 'v2/t2',       fv: 2 as const, kind: tierKind('t2'),              tier: 't2' as const, samples: v2Bucket.t2, names: v2Names },
    { label: 'v2/t3',       fv: 2 as const, kind: tierKind('t3'),              tier: 't3' as const, samples: v2Bucket.t3, names: v2Names },
    { label: 'v3/fallback', fv: 3 as const, kind: 'prematch_winner' as const, tier: null, samples: v3All,       names: v3Names },
    { label: 'v3/t1',       fv: 3 as const, kind: tierKind('t1'),              tier: 't1' as const, samples: v3Bucket.t1, names: v3Names },
    { label: 'v3/t2',       fv: 3 as const, kind: tierKind('t2'),              tier: 't2' as const, samples: v3Bucket.t2, names: v3Names },
    { label: 'v3/t3',       fv: 3 as const, kind: tierKind('t3'),              tier: 't3' as const, samples: v3Bucket.t3, names: v3Names },
  ] as Job[]).filter(j => include(j.label));

  const versionStem = `lgbm-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  const toInsert: (typeof modelVersionsTable.$inferInsert)[] = [];

  for (const j of jobs) {
    console.log(`\n[train-lightgbm] === ${j.label} (${j.kind}, fv=${j.fv}) ===`);
    const r = await trainBucket(j.samples, j.names, j.label);
    if (!r) continue;
    const blob = Buffer.from(r.blob_b64, 'base64');
    toInsert.push({
      version: `${versionStem}-v${j.fv}-${j.kind}`,
      kind: j.kind,
      featuresVersion: j.fv,
      algorithm: 'lightgbm',
      engine: 'lightgbm',
      binaryBlob: blob,
      features: r.feature_names,
      // jsonb NOT NULL — кладём пустой объект; реальные веса в blob.
      weights: {},
      trainAccuracy: r.train_metrics.accuracy,
      testAccuracy: r.test_metrics_calibrated.accuracy,
      brierScore: r.test_metrics_calibrated.brier,
      trainSampleSize: r.train_metrics.n,
      testSampleSize: r.test_metrics_calibrated.n,
      metadata: {
        tier: j.tier,
        engine: 'lightgbm',
        lgbmHyperparams: { num_leaves: 31, learning_rate: 0.05, n_estimators: 200 },
        testRaw: r.test_metrics_raw,
        testCalibrated: r.test_metrics_calibrated,
        calibSampleSize: r.calib_metrics.n,
        baselineAcc: r.baseline_acc,
        featureImportance: r.feature_importance,
        windowDays: TRAIN_WINDOW_DAYS,
        windowStartUnix: minStartTime,
        minAvgGlicko: MIN_AVG_GLICKO,
        trainSeconds: r.train_seconds,
        blobBytes: blob.length,
      },
      isActive: true,
    });
  }

  if (toInsert.length === 0) {
    console.error('\n[train-lightgbm] no models trained, aborting.');
    process.exit(1);
  }

  // Атомарный swap: деактивируем ТОЛЬКО старые lightgbm-модели; logreg
  // оставляем активными как fallback при сбое ml-service. Партиальный
  // unique index `(kind, fv, engine) WHERE active` гарантирует консистентность.
  console.log(`\n[train-lightgbm] Saving ${toInsert.length} models with stem ${versionStem} …`);
  await db.transaction(async tx => {
    await tx.update(modelVersionsTable)
      .set({ isActive: false })
      .where(and(
        inArray(modelVersionsTable.kind, [...ALL_PREMATCH_KINDS]),
        eq(modelVersionsTable.isActive, true),
        eq(modelVersionsTable.engine, 'lightgbm'),
      ));
    await tx.insert(modelVersionsTable).values(toInsert);
  });

  console.log('\n[train-lightgbm] ✅ Saved:');
  for (const r of toInsert) {
    console.log(
      `   - ${r.version} kind=${r.kind} v${r.featuresVersion} test_acc=${(r.testAccuracy! * 100).toFixed(1)}% brier=${r.brierScore!.toFixed(4)} blob=${(r.binaryBlob as Buffer).length}b`,
    );
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
