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
 * Создаёт только inactive/unvalidated кандидатов. Все действующие модели
 * и fallback сохраняются. Публикация требует отдельного validated manifest.
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
  heroSynergyTable,
  playerHeroStatsTable,
  playerRatingsTable,
  teamRecentFormTable,
  teamH2HTable,
  teamExtendedFeaturesTable,
} from '@workspace/db';
import { asc, gte, and, eq, inArray } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { assertCandidateOnlyArgs, saveLegacyCandidates } from './lib/training-candidates';
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
  type HeroSynergyMap,
  type PlayerHeroStatsMap,
  type RecentFormMap,
  type H2HMap,
  type PlayerGlickoMap,
} from './lib/hero-features';
import {
  EXTENDED_TEAM_FEATURE_NAMES,
  buildExtendedTeamFeatures,
  newRollingState,
  applyMatch,
  snapshotAt,
  type TeamRollingState,
  type TeamExtendedSnapshot,
} from './lib/team-extended';
import {
  loadTeamRostersMap,
  loadTeamHeroPoolMap,
  loadPlayerTotalsMap,
  loadPlayerCountsMap,
  loadPlayerWlProMap,
  buildE1PrematchFeatures,
  E1_PREMATCH_FEATURE_NAMES,
} from './lib/e1-features';

const TRAIN_WINDOW_DAYS = 365;
const MIN_SAMPLES_PER_BUCKET = 80;  // LightGBM нужно чуть больше чем LR

/** Возвращает Unix-timestamp начала тренировочного окна.
 *  Если передан --since-unix N — использует его; иначе вычисляет из TRAIN_WINDOW_DAYS. */
function parseSinceUnix(): number {
  const idx = process.argv.indexOf('--since-unix');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return Math.floor(Date.now() / 1000) - TRAIN_WINDOW_DAYS * 86_400;
}

/** Возвращает минимум сэмплов для обучения.
 *  Если передан --min-samples N — использует его; иначе MIN_SAMPLES_PER_BUCKET. */
function parseMinSamples(): number {
  const idx = process.argv.indexOf('--min-samples');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return MIN_SAMPLES_PER_BUCKET;
}
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

// Wave 6: удалили elo_diff_norm (командный рейтинг OD) — теперь сила команды
// задаётся player_glicko_diff (EXTRA_FEATURE_NAMES, только v3) + form + h2h.
// 11 base + 6 extended = 17.
const TEAM_FEATURE_NAMES = [
  'bias', 'winrate_diff', 'experience_diff', 'is_high_tier',
  'radiant_side_logit', 'recency_days_norm', 'series_type_norm', 'map_no_norm',
  'tier_t1', 'tier_t2', 'tier_t3',
  ...EXTENDED_TEAM_FEATURE_NAMES,
] as const;
const TEAM_FEATURE_DIM = TEAM_FEATURE_NAMES.length; // 17
const HARD_MATCH_THRESHOLD = 0.4;

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
  hard_test_metrics?: MlMetrics | null;
}

interface TeamMatchContext {
  startTime: number;
  seriesType: number | null;
  mapNo: number;
  tier: Tier | null;
  radiantSideLogit: number;
  nowUnix: number;
}

function buildTeamFeatures(
  rId: number, dId: number, teams: Map<number, TeamRating>, ctx: TeamMatchContext,
  rExt: TeamExtendedSnapshot | null, dExt: TeamExtendedSnapshot | null,
): number[] | null {
  const r = teams.get(rId); const d = teams.get(dId);
  if (!r || !d) return null;
  const rG = r.wins + r.losses; const dG = d.wins + d.losses;
  if (rG < 5 || dG < 5) return null;
  const seriesTypeNorm = ctx.seriesType === 0 ? 0.0 : ctx.seriesType === 2 ? 1.0 : 0.5;
  const mapNoNorm = Math.min(Math.max(ctx.mapNo - 1, 0), 4) / 4;
  const recencyDaysNorm = (ctx.startTime - ctx.nowUnix) / (365 * 86400);
  const ext = buildExtendedTeamFeatures(rExt, dExt);
  return [
    1,
    r.wins / rG - d.wins / dG,
    Math.log(rG + 1) - Math.log(dG + 1),
    rG >= 50 && dG >= 50 ? 1 : 0,
    ctx.radiantSideLogit, recencyDaysNorm, seriesTypeNorm, mapNoNorm,
    ctx.tier === 't1' ? 1 : 0, ctx.tier === 't2' ? 1 : 0, ctx.tier === 't3' ? 1 : 0,
    ...ext,
  ];
}

async function trainBucket(
  samples: Sample[],
  featureNames: string[],
  label: string,
): Promise<TrainResponse | null> {
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
      body: JSON.stringify({
        label, feature_names: featureNames, train, calib, test,
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
    if (data.hard_test_metrics && data.hard_test_metrics.n > 0) {
      const hm = data.hard_test_metrics;
      console.log(
        `  [${label}] HARD     acc=${(hm.accuracy * 100).toFixed(1)}% brier=${hm.brier.toFixed(4)} n=${hm.n} (|elo_diff_norm|<${HARD_MATCH_THRESHOLD})`,
      );
    }
    // T0 mini-fix v2 audit: распечатать top feature importances и
    // train↔test mean-shift по каждой фиче (data drift detector).
    const imp = Object.entries(data.feature_importance ?? {})
      .sort((a, b) => b[1] - a[1]);
    const top = imp.slice(0, 15)
      .map(([n, v]) => `${n}=${v.toFixed(0)}`).join(' ');
    console.log(`  [${label}] IMPORTANCE top15: ${top}`);
    const trainMean = featureNames.map((_, i) =>
      train.reduce((s, x) => s + x.features[i], 0) / train.length);
    const testMean = featureNames.map((_, i) =>
      test.reduce((s, x) => s + x.features[i], 0) / test.length);
    const drifts = featureNames.map((n, i) => {
      const tr = trainMean[i], te = testMean[i];
      const denom = Math.max(Math.abs(tr), 1e-3);
      return { name: n, trainMean: tr, testMean: te, rel: (te - tr) / denom };
    }).filter(d => Math.abs(d.rel) > 0.10)
      .sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel));
    if (drifts.length > 0) {
      const top = drifts.slice(0, 8);
      console.log(`  [${label}] DRIFT (|Δrel|>10%): ` + top.map(d =>
        `${d.name}: train=${d.trainMean.toFixed(3)} test=${d.testMean.toFixed(3)} (${(d.rel * 100).toFixed(0)}%)`).join(', '));
    }
    // D2 — drifts хранятся в data так, чтобы вызывающий код мог сохранить их в metadata.
    (data as TrainResponse & { drifts?: typeof drifts }).drifts = drifts;
    const trainPos = train.reduce((s, x) => s + x.label, 0) / train.length;
    const testPos = test.reduce((s, x) => s + x.label, 0) / test.length;
    console.log(`  [${label}] LABEL radiantWR train=${(trainPos * 100).toFixed(1)}% test=${(testPos * 100).toFixed(1)}%`);
    return data;
  } catch (e) {
    console.error(`  [${label}] training failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The legacy route joins current peer_synergy into historical snapshots below.
// No fit is permitted until this source is replaced by causal unified vectors
// and the complete feature-first gate has passed Astra review. No env bypass.
function assertLegacyTrainingRouteAdmitted(): void {
  throw new Error('legacy_lightgbm_training_blocked: current peer_synergy is not an as-of input; use reviewed unified vectors after feature-first admission');
}

async function main() {
  assertLegacyTrainingRouteAdmitted();
  assertCandidateOnlyArgs();
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

  const minStartTime = parseSinceUnix();
  const effectiveMinSamples = parseMinSamples();
  const matches = await db.select({
    matchId: proMatchesTable.matchId,
    radiantTeamId: proMatchesTable.radiantTeamId,
    direTeamId: proMatchesTable.direTeamId,
    radiantWin: proMatchesTable.radiantWin,
    startTime: proMatchesTable.startTime,
    seriesType: proMatchesTable.series_type,
    leagueId: proMatchesTable.leagueId,
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
    earlyGameScore: heroStatsTable.earlyGameScore,
    lateGameScore: heroStatsTable.lateGameScore,
  }).from(heroStatsTable);
  const heroStats: HeroStatsMap = new Map();
  for (const h of heroStatsRows) heroStats.set(h.heroId, {
    proWinRate: h.proWinRate,
    proPickRate: h.proPickRate,
    earlyGameScore: h.earlyGameScore,
    lateGameScore: h.lateGameScore,
  });

  // T0 mini-fix: hero_synergy загружаем для нового synergy_diff feature.
  const synergyRows = await db.select({
    heroId: heroSynergyTable.heroId,
    withHeroId: heroSynergyTable.withHeroId,
    games: heroSynergyTable.games,
    winRate: heroSynergyTable.winRate,
  }).from(heroSynergyTable);
  const heroSynergy: HeroSynergyMap = new Map();
  for (const s of synergyRows) {
    let inner = heroSynergy.get(s.heroId);
    if (!inner) { inner = new Map(); heroSynergy.set(s.heroId, inner); }
    inner.set(s.withHeroId, { games: s.games, winRate: s.winRate });
  }

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
  // T0 mini-fix v2: lastPlayed нужен для player_hero_recency_diff.
  for (const r of phsRows) {
    let inner = playerHeroStats.get(r.accountId);
    if (!inner) { inner = new Map(); playerHeroStats.set(r.accountId, inner); }
    inner.set(r.heroId, { games: r.games, wins: r.wins, lastPlayed: r.lastPlayed ?? null });
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

  // E1 OD-extension loaders (v4 prematch features). Все builders BC-нейтральны:
  // отсутствие данных в map → фичи=0, модель не ломается.
  console.log('[train-lightgbm] Loading E1 maps …');
  const e1Rosters = await loadTeamRostersMap();
  const e1Pool = await loadTeamHeroPoolMap();
  const e1Totals = await loadPlayerTotalsMap({
    fields: ['gold_per_min', 'xp_per_min', 'kills', 'assists', 'deaths'],
  });
  const e1Counts = await loadPlayerCountsMap();
  const e1WlPro = await loadPlayerWlProMap();
  console.log(
    `[train-lightgbm] drafts=${drafts.size} hero=${heroStats.size} matchups=${matchupsRows.length} synergy=${synergyRows.length} phs=${playerHeroStats.size} form=${recentForm.size} h2h=${h2h.size} glicko=${playerGlicko.size} ` +
    `e1.rosters=${e1Rosters.size} e1.pool=${e1Pool.size} e1.totals=${e1Totals.size} e1.counts=${e1Counts.size} e1.wlPro=${e1WlPro.size}`,
  );

  // ── Предвычисление контекста для расширенных командных фичей ───────────
  const nowUnix = Math.floor(Date.now() / 1000);
  const totalWithWin = matches.filter(m => m.radiantWin != null);
  const radiantWinsCount = totalWithWin.filter(m => m.radiantWin).length;
  const radiantWR = totalWithWin.length > 0 ? radiantWinsCount / totalWithWin.length : 0.52;
  const rWRClamped = Math.min(Math.max(radiantWR, 1e-4), 1 - 1e-4);
  const radiantSideLogit = Math.log(rWRClamped / (1 - rWRClamped));
  const seriesCounters = new Map<string, number>();
  const mapNoByMatch = new Map<number, number>();
  for (const m of matches) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const lo = Math.min(m.radiantTeamId, m.direTeamId);
    const hi = Math.max(m.radiantTeamId, m.direTeamId);
    const key = `${m.leagueId ?? 0}_${lo}_${hi}_${m.seriesType ?? 0}`;
    const cnt = (seriesCounters.get(key) ?? 0) + 1;
    seriesCounters.set(key, cnt);
    mapNoByMatch.set(m.matchId, cnt);
  }
  console.log(`[train-lightgbm] radiantWR=${(radiantWR * 100).toFixed(1)}% logit=${radiantSideLogit.toFixed(4)}`);

  // ── Wave 5: as-of pre-pass для расширенных team-фичей ─────────────────
  console.log('[train-lightgbm] Computing as-of team-extended snapshots …');
  const allMatchesForRoll = await db.select({
    matchId: proMatchesTable.matchId,
    startTime: proMatchesTable.startTime,
    duration: proMatchesTable.duration,
    radiantTeamId: proMatchesTable.radiantTeamId,
    direTeamId: proMatchesTable.direTeamId,
    radiantWin: proMatchesTable.radiantWin,
    firstBloodTime: proMatchesTable.firstBloodTime,
  }).from(proMatchesTable).orderBy(asc(proMatchesTable.startTime));
  const rollStates = new Map<number, TeamRollingState>();
  const getState = (id: number) => {
    let s = rollStates.get(id);
    if (!s) { s = newRollingState(); rollStates.set(id, s); }
    return s;
  };
  const extByMatch = new Map<number, { r: TeamExtendedSnapshot; d: TeamExtendedSnapshot }>();
  for (const m of allMatchesForRoll) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const rState = getState(m.radiantTeamId);
    const dState = getState(m.direTeamId);
    extByMatch.set(m.matchId, {
      r: snapshotAt(rState, m.startTime),
      d: snapshotAt(dState, m.startTime),
    });
    applyMatch(rState, dState, {
      matchId: m.matchId, startTime: m.startTime, duration: m.duration,
      radiantTeamId: m.radiantTeamId, direTeamId: m.direTeamId,
      radiantWin: m.radiantWin, firstBloodTime: m.firstBloodTime,
    });
  }
  // ⚠ ИЗВЕСТНЫЙ КОМПРОМИСС (leakage): подмешиваем CURRENT peer_synergy в каждый
  // as-of snapshot. Это технически утечка будущей информации о составах в
  // прошлые матчи. Альтернатива (as-of пересчёт peer-synergy на каждый матч)
  // требует chronological roster tracking + per-match player_peers lookup —
  // дорого и хрупко. Решение: для топ-команд ростер стабилен ~6 мес, эффект
  // утечки невелик, фича выигрывает важность top-3 (см. importance в логе).
  // TODO: если v3/fallback acc упадёт, переписать на bucketed (по месяцам/патчам).
  // Команды без peer_synergy = null → в buildExtendedTeamFeatures дают 0 (нейтрал).
  const peerRows = await db.select({
    teamId: teamExtendedFeaturesTable.teamId,
    peerSynergy: teamExtendedFeaturesTable.peerSynergy,
  }).from(teamExtendedFeaturesTable);
  const peerMap = new Map<number, number | null>();
  for (const r of peerRows) peerMap.set(r.teamId, r.peerSynergy);
  let patched = 0;
  for (const m of allMatchesForRoll) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const e = extByMatch.get(m.matchId);
    if (!e) continue;
    e.r.peerSynergy = peerMap.get(m.radiantTeamId) ?? null;
    e.d.peerSynergy = peerMap.get(m.direTeamId) ?? null;
    if (e.r.peerSynergy != null || e.d.peerSynergy != null) patched += 1;
  }
  console.log(`[train-lightgbm] as-of snapshots: ${extByMatch.size} matches, ${rollStates.size} teams, peer_synergy patched: ${patched}`);

  // Сборка бакетов
  const v1All: Sample[] = [];
  const v1Bucket: Record<Tier, Sample[]> = { t1: [], t2: [], t3: [] };
  const v2All: Sample[] = [];
  const v2Bucket: Record<Tier, Sample[]> = { t1: [], t2: [], t3: [] };
  const v3All: Sample[] = [];
  const v3Bucket: Record<Tier, Sample[]> = { t1: [], t2: [], t3: [] };
  // v4 = v3 + E1 OD-extension (roster/pool/baseline, +18 features).
  const v4All: Sample[] = [];
  const v4Bucket: Record<Tier, Sample[]> = { t1: [], t2: [], t3: [] };

  for (const m of matches) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const r = teams.get(m.radiantTeamId);
    const d = teams.get(m.direTeamId);
    if (!r || !d) continue;
    if ((r.rating + d.rating) / 2 < MIN_AVG_GLICKO) continue;
    const tier = classifyTier(r.rating, d.rating);
    const ext = extByMatch.get(m.matchId);
    const teamFeats = buildTeamFeatures(m.radiantTeamId, m.direTeamId, teams, {
      startTime: m.startTime,
      seriesType: m.seriesType ?? null,
      mapNo: mapNoByMatch.get(m.matchId) ?? 1,
      tier,
      radiantSideLogit,
      nowUnix,
    }, ext?.r ?? null, ext?.d ?? null);
    if (!teamFeats) continue;

    const label = m.radiantWin ? 1 : 0;
    const v1S: Sample = { features: teamFeats, label };
    v1All.push(v1S); if (tier) v1Bucket[tier].push(v1S);

    const draft = drafts.get(m.matchId);
    if (!draft) continue;
    const heroFeats = buildHeroFeatures(
      draft.radiantPicks, draft.direPicks, draft.radiantBans, draft.direBans,
      heroStats, matchups, heroSynergy,
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
      nowUnix: m.startTime, // T0 mini-fix v2: time-leakage guard для recency
    });
    const v3S: Sample = { features: [...teamFeats, ...heroFeats, ...extraFeats], label };
    v3All.push(v3S); if (tier) v3Bucket[tier].push(v3S);

    // v4: добавляем E1 фичи. Loaders нейтральны (нет данных → 0), поэтому
    // v4 покрывает то же множество матчей что v3 (account_ids известны).
    const e1Feats = buildE1PrematchFeatures({
      radiantTeamId: m.radiantTeamId,
      direTeamId: m.direTeamId,
      radiantPicks: draft.radiantPicks,
      direPicks: draft.direPicks,
      radiantAccountIds: draft.radiantAccountIds,
      direAccountIds: draft.direAccountIds,
      rosters: e1Rosters,
      pool: e1Pool,
      totals: e1Totals,
      counts: e1Counts,
      wlPro: e1WlPro,
    });
    const v4S: Sample = { features: [...teamFeats, ...heroFeats, ...extraFeats, ...e1Feats], label };
    v4All.push(v4S); if (tier) v4Bucket[tier].push(v4S);
  }

  console.log(
    `[train-lightgbm] v1=${v1All.length} (t1=${v1Bucket.t1.length}/t2=${v1Bucket.t2.length}/t3=${v1Bucket.t3.length}) ` +
    `v2=${v2All.length} (t1=${v2Bucket.t1.length}/t2=${v2Bucket.t2.length}/t3=${v2Bucket.t3.length}) ` +
    `v3=${v3All.length} (t1=${v3Bucket.t1.length}/t2=${v3Bucket.t2.length}/t3=${v3Bucket.t3.length}) ` +
    `v4=${v4All.length} (t1=${v4Bucket.t1.length}/t2=${v4Bucket.t2.length}/t3=${v4Bucket.t3.length})`,
  );

  const v1Names = [...TEAM_FEATURE_NAMES];
  const v2Names = [...TEAM_FEATURE_NAMES, ...HERO_FEATURE_NAMES];
  const v3Names = [...TEAM_FEATURE_NAMES, ...HERO_FEATURE_NAMES, ...EXTRA_FEATURE_NAMES];
  const v4Names = [...TEAM_FEATURE_NAMES, ...HERO_FEATURE_NAMES, ...EXTRA_FEATURE_NAMES, ...E1_PREMATCH_FEATURE_NAMES];

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
    fv: 1 | 2 | 3 | 4;
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
    { label: 'v4/fallback', fv: 4 as const, kind: 'prematch_winner' as const, tier: null, samples: v4All,       names: v4Names },
    { label: 'v4/t1',       fv: 4 as const, kind: tierKind('t1'),              tier: 't1' as const, samples: v4Bucket.t1, names: v4Names },
    { label: 'v4/t2',       fv: 4 as const, kind: tierKind('t2'),              tier: 't2' as const, samples: v4Bucket.t2, names: v4Names },
    { label: 'v4/t3',       fv: 4 as const, kind: tierKind('t3'),              tier: 't3' as const, samples: v4Bucket.t3, names: v4Names },
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
      hardMatchAccuracy: r.hard_test_metrics && r.hard_test_metrics.n > 0 ? r.hard_test_metrics.accuracy : null,
      hardMatchBrier: r.hard_test_metrics && r.hard_test_metrics.n > 0 ? r.hard_test_metrics.brier : null,
      hardMatchCount: r.hard_test_metrics ? r.hard_test_metrics.n : 0,
      metadata: {
        tier: j.tier,
        engine: 'lightgbm',
        lgbmHyperparams: { num_leaves: 31, learning_rate: 0.05, n_estimators: 200 },
        testRaw: r.test_metrics_raw,
        testCalibrated: r.test_metrics_calibrated,
        calibSampleSize: r.calib_metrics.n,
        baselineAcc: r.baseline_acc,
        featureImportance: r.feature_importance,
        // D2 — drift snapshot из trainBucket (train↔test mean shift по фичам, |Δrel|>10%).
        drifts: (r as TrainResponse & { drifts?: Array<{ name: string; trainMean: number; testMean: number; rel: number }> }).drifts ?? [],
        windowDays: TRAIN_WINDOW_DAYS,
        windowStartUnix: minStartTime,
        minAvgGlicko: MIN_AVG_GLICKO,
        trainSeconds: r.train_seconds,
        blobBytes: blob.length,
      },
      isActive: false,
    });
  }

  if (toInsert.length === 0) {
    console.error('\n[train-lightgbm] no models trained, aborting.');
    process.exit(1);
  }

  console.log(`\n[train-lightgbm] Saving ${toInsert.length} inactive candidates with stem ${versionStem} …`);
  await saveLegacyCandidates(db, toInsert, {
    trainer: 'train-lightgbm', seed: 42,
    limitations: ['current_aggregate_features_not_as_of', 'row_split_not_series_grouped', 'shared_early_stop_calibration_set'],
  });

  console.log('\n[train-lightgbm] Saved inactive, unvalidated candidates (active models unchanged):');
  for (const r of toInsert) {
    console.log(
      `   - ${r.version} kind=${r.kind} v${r.featuresVersion} test_acc=${(r.testAccuracy! * 100).toFixed(1)}% brier=${r.brierScore!.toFixed(4)} blob=${(r.binaryBlob as Buffer).length}b`,
    );
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
