/**
 * Этап B — тренировка ASYMMETRIC prematch-winner модели.
 *
 * Зачем: основная v3 модель (train-lightgbm) требует от обеих команд минимум
 * 5 матчей в `team_recent_form`/teams.wins+losses. Для tier-3 / новых команд
 * это условие не выполняется → v3 возвращает null → UI показывает «нет
 * прогноза». Эта модель закрывает gap: тренируется ТОЛЬКО на матчах, где
 * у одной/обеих команд games_in_prior_180d<5 И есть account_ids драфта.
 *
 * Контракт фичей (PREMATCH_ASYM v1, dim=22):
 *   [0]  bias
 *   [1]  radiant_side_logit            (глобальный radiantWR-prior из обучающего окна)
 *   [2]  recency_days_norm             (для time-decay прогноза)
 *   [3]  series_type_norm              (BO1/BO3/BO5)
 *   [4]  map_no_norm                   (карта 1..5 в серии)
 *   [5]  team_games_180d_R             log(g+1) — насколько свежая «новая» команда
 *   [6]  team_games_180d_D
 *   [7]  team_rating_diff              (teams.rating_R − teams.rating_D)/200; 0 если хотя бы один null
 *   [8]  player_glicko_avg_diff        (avg(glicko_R) − avg(glicko_D))/200
 *   [9]  player_glicko_avg_R           (avg(glicko_R) − 1500)/200
 *   [10] player_glicko_avg_D
 *   [11] player_glicko_spread_R        std(glicko_R)/200 — насколько разношёрстный ростер
 *   [12] player_glicko_spread_D
 *   [13] wl_pro_180d_diff              (avg(wl_pro.winrate_R) − D)
 *   [14] wl_pro_180d_R                 (avg − 0.5)
 *   [15] wl_pro_180d_D
 *   [16] pro_exp_avg_diff              log1p(avg(games_R)) − log1p(avg(games_D))
 *   [17] peer_synergy_diff             (team_extended_features.peerSynergy R − D), 0 если null
 *   [18] roster_known_radiant          из E1 buildE1PrematchFeatures (для asym полезно)
 *   [19] roster_known_dire
 *   [20] team_pool_winrate_diff        (E1.poolR.wr − E1.poolD.wr)
 *   [21] hero_draft_strength_diff      sum(globalWR(pick_R)) − sum(globalWR(pick_D))  (упрощённо)
 *
 * fv=1, kind='prematch_winner_asym', engine='lightgbm', единый bucket (без тиров).
 * Сохранение — только inactive/unvalidated кандидат; активные строки не меняются.
 *
 * Запуск:
 *   pnpm --filter @workspace/scripts run train:asym-prematch
 *   --since-unix N        переопределить начало окна (по умолчанию now-365d)
 *   --min-samples N       минимум сэмплов (по умолчанию 80)
 *
 * Зависимости: ml-service /train (тот же endpoint что у train-lightgbm),
 * ML_SERVICE_TOKEN (env или /tmp/aegis_ml_token).
 *
 * ВАЖНО: rating_growth_R/D_30d НЕ включены в v1 — team_rating_snapshots ещё
 * почти пуст (Этап A backfill идёт). В v2 (после 30d накопления) добавить
 * 4 фичи rating_growth_{7d,30d}×{R,D} и bump PREMATCH_ASYM до 2.
 */

import {
  db,
  proMatchesTable,
  teamsTable,
  modelVersionsTable,
  matchDraftsTable,
  heroStatsTable,
  playerRatingsTable,
  playerTotalsTable,
  playerWlProTable,
  teamExtendedFeaturesTable,
  teamRostersTable,
  teamHeroPoolTable,
} from '@workspace/db';
import { asc, gte, and, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { assertCandidateOnlyArgs, saveLegacyCandidates } from './lib/training-candidates';

const TRAIN_WINDOW_DAYS = 365;
const MIN_SAMPLES = 80;
const TEAM_GAMES_THRESHOLD = 5;  // если у обеих команд games_180d>=5 → не asym (территория v3)
const ASYM_PRIOR_DAYS = 180;
const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';
const TRAIN_TIMEOUT_MS = 120_000;

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

function mlServiceToken(): string | null {
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) return env;
  try {
    const v = readFileSync(ML_TOKEN_FILE, 'utf8').trim();
    return v || null;
  } catch { return null; }
}

export const ASYM_FEATURE_NAMES = [
  'bias',
  'radiant_side_logit', 'recency_days_norm', 'series_type_norm', 'map_no_norm',
  'team_games_180d_R', 'team_games_180d_D',
  'team_rating_diff',
  'player_glicko_avg_diff', 'player_glicko_avg_R', 'player_glicko_avg_D',
  'player_glicko_spread_R', 'player_glicko_spread_D',
  'wl_pro_180d_diff', 'wl_pro_180d_R', 'wl_pro_180d_D',
  'pro_exp_avg_diff',
  'peer_synergy_diff',
  'roster_known_radiant', 'roster_known_dire',
  'team_pool_winrate_diff',
  'hero_draft_strength_diff',
] as const;
export const ASYM_FEATURE_DIM = ASYM_FEATURE_NAMES.length; // 22

interface Sample { features: number[]; label: number; }
interface MlMetrics { accuracy: number; log_loss: number; brier: number; n: number; }
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

function teamAvg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, x) => s + x, 0) / values.length;
}
function teamStd(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = teamAvg(values);
  const ss = values.reduce((s, x) => s + (x - mean) * (x - mean), 0);
  return Math.sqrt(ss / values.length);
}

async function trainBucket(samples: Sample[], featureNames: string[], label: string): Promise<TrainResponse | null> {
  const min = parseMinSamples();
  if (samples.length < min) {
    console.log(`  [${label}] SKIP: only ${samples.length} samples (need ${min}+)`);
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
    if (!token) { console.error(`  [${label}] no ML_SERVICE_TOKEN`); return null; }
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
    console.log(`  [${label}] TRAIN acc=${(data.train_metrics.accuracy * 100).toFixed(1)}% brier=${data.train_metrics.brier.toFixed(4)}`);
    console.log(`  [${label}] TEST raw acc=${(tr.accuracy * 100).toFixed(1)}% brier=${tr.brier.toFixed(4)}`);
    console.log(`  [${label}] TEST cal acc=${(tm.accuracy * 100).toFixed(1)}% brier=${tm.brier.toFixed(4)} (baseline=${(data.baseline_acc * 100).toFixed(1)}%) — ${data.train_seconds.toFixed(1)}s`);
    const imp = Object.entries(data.feature_importance ?? {}).sort((a, b) => b[1] - a[1]);
    console.log(`  [${label}] IMPORTANCE top15: ${imp.slice(0, 15).map(([n, v]) => `${n}=${v.toFixed(0)}`).join(' ')}`);
    const trainMean = featureNames.map((_, i) => train.reduce((s, x) => s + x.features[i], 0) / train.length);
    const testMean = featureNames.map((_, i) => test.reduce((s, x) => s + x.features[i], 0) / test.length);
    const drifts = featureNames.map((n, i) => {
      const trM = trainMean[i], teM = testMean[i];
      return { name: n, trainMean: trM, testMean: teM, rel: (teM - trM) / Math.max(Math.abs(trM), 1e-3) };
    }).filter(d => Math.abs(d.rel) > 0.10).sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel));
    if (drifts.length > 0) {
      console.log(`  [${label}] DRIFT (|Δrel|>10%): ` + drifts.slice(0, 8).map(d =>
        `${d.name}: train=${d.trainMean.toFixed(3)} test=${d.testMean.toFixed(3)} (${(d.rel * 100).toFixed(0)}%)`).join(', '));
    }
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

async function main() {
  assertCandidateOnlyArgs();
  console.log(`[train-asym-prematch] ml-service: ${ML_SERVICE_URL}`);
  try {
    const h = await fetch(`${ML_SERVICE_URL}/healthz`);
    if (!h.ok) throw new Error(`status ${h.status}`);
    console.log('[train-asym-prematch] ml-service healthy');
  } catch (e) {
    console.error(`[train-asym-prematch] ml-service unreachable: ${(e as Error).message}`);
    process.exit(1);
  }

  // ── Загрузка справочников ─────────────────────────────────────────────
  const teamsRows = await db.select({
    teamId: teamsTable.teamId, rating: teamsTable.rating,
  }).from(teamsTable);
  const teamRating = new Map<number, number>();
  for (const t of teamsRows) if (t.rating != null) teamRating.set(t.teamId, t.rating);

  const minStartTime = parseSinceUnix();
  // Окно тренировки.
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
  console.log(`[train-asym-prematch] matches in window=${matches.length}`);

  // Все матчи (для as-of подсчёта games_180d) — нужен полный history до minStartTime.
  const allMatches = await db.select({
    matchId: proMatchesTable.matchId,
    radiantTeamId: proMatchesTable.radiantTeamId,
    direTeamId: proMatchesTable.direTeamId,
    startTime: proMatchesTable.startTime,
  }).from(proMatchesTable).orderBy(asc(proMatchesTable.startTime));

  const draftsRows = await db.select({
    matchId: matchDraftsTable.matchId,
    radiantPicks: matchDraftsTable.radiantPicks,
    direPicks: matchDraftsTable.direPicks,
    radiantAccountIds: matchDraftsTable.radiantAccountIds,
    direAccountIds: matchDraftsTable.direAccountIds,
  }).from(matchDraftsTable);
  const drafts = new Map<number, typeof draftsRows[number]>();
  for (const d of draftsRows) drafts.set(d.matchId, d);

  const heroStatsRows = await db.select({
    heroId: heroStatsTable.heroId, proWinRate: heroStatsTable.proWinRate,
  }).from(heroStatsTable);
  const heroWR = new Map<number, number>();
  for (const h of heroStatsRows) heroWR.set(h.heroId, h.proWinRate ?? 0.5);

  const prRows = await db.select({
    accountId: playerRatingsTable.accountId, rating: playerRatingsTable.rating,
  }).from(playerRatingsTable);
  const playerGlicko = new Map<number, number>();
  for (const r of prRows) playerGlicko.set(r.accountId, r.rating);

  const wlProRows = await db.select({
    accountId: playerWlProTable.accountId,
    win: playerWlProTable.win, lose: playerWlProTable.lose,
  }).from(playerWlProTable);
  const wlPro = new Map<number, number>();
  for (const r of wlProRows) {
    const total = (r.win ?? 0) + (r.lose ?? 0);
    if (total >= 5) wlPro.set(r.accountId, (r.win ?? 0) / total);
  }

  // pro_exp: считаем `games` поле из player_totals для любого field-stat'а
  // (берём любой существующий, например 'kills' — n = число pro-игр).
  const totalsRows = await db.select({
    accountId: playerTotalsTable.accountId,
    field: playerTotalsTable.field,
    n: playerTotalsTable.n,
  }).from(playerTotalsTable).where(eq(playerTotalsTable.field, 'kills'));
  const proGamesByAcc = new Map<number, number>();
  for (const r of totalsRows) proGamesByAcc.set(r.accountId, r.n ?? 0);

  const peerRows = await db.select({
    teamId: teamExtendedFeaturesTable.teamId,
    peerSynergy: teamExtendedFeaturesTable.peerSynergy,
  }).from(teamExtendedFeaturesTable);
  const peerByTeam = new Map<number, number | null>();
  for (const r of peerRows) peerByTeam.set(r.teamId, r.peerSynergy);

  // E1: rosters + hero pool для roster_known/team_pool_winrate.
  const rosterRows = await db.select({
    teamId: teamRostersTable.teamId,
    accountId: teamRostersTable.accountId,
  }).from(teamRostersTable);
  const rosters = new Map<number, Set<number>>();
  for (const r of rosterRows) {
    let s = rosters.get(r.teamId);
    if (!s) { s = new Set(); rosters.set(r.teamId, s); }
    s.add(r.accountId);
  }
  const poolRows = await db.select({
    teamId: teamHeroPoolTable.teamId,
    heroId: teamHeroPoolTable.heroId,
    games: teamHeroPoolTable.gamesPlayed,
    wins: teamHeroPoolTable.wins,
  }).from(teamHeroPoolTable);
  const pool = new Map<number, Map<number, { games: number; wins: number }>>();
  for (const r of poolRows) {
    let inner = pool.get(r.teamId);
    if (!inner) { inner = new Map(); pool.set(r.teamId, inner); }
    inner.set(r.heroId, { games: r.games ?? 0, wins: r.wins ?? 0 });
  }

  console.log(`[train-asym-prematch] teams=${teamRating.size} drafts=${drafts.size} hero=${heroWR.size} glicko=${playerGlicko.size} wlPro=${wlPro.size} proGames=${proGamesByAcc.size} peer=${peerByTeam.size} rosters=${rosters.size} pool=${pool.size}`);

  // ── As-of pre-pass: games_in_prior_180d для каждой команды на каждом матче.
  // Используем sliding window по chronologically-sorted allMatches.
  // По каждой команде поддерживаем deque стартовых time'ов; на каждом новом
  // матче выбрасываем те, что старше t - 180d, и записываем размер deque.
  console.log('[train-asym-prematch] computing as-of games_180d …');
  const recentByTeam = new Map<number, number[]>(); // teamId → asc list of past startTime
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
  console.log(`[train-asym-prematch] as-of games_180d computed for ${games180dByMatch.size} matches`);

  // ── Global radiant side prior (на тех же матчах что и v3).
  const totalWithWin = matches.filter(m => m.radiantWin != null);
  const radiantWR = totalWithWin.length > 0
    ? totalWithWin.filter(m => m.radiantWin).length / totalWithWin.length
    : 0.52;
  const rWRClamp = Math.min(Math.max(radiantWR, 1e-4), 1 - 1e-4);
  const radiantSideLogit = Math.log(rWRClamp / (1 - rWRClamp));

  // Map number для серии.
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
  const nowUnix = Math.floor(Date.now() / 1000);

  // ── Сборка sample'ов: только asym матчи (games_180d<5 у хотя бы одной + есть account_ids).
  const samples: Sample[] = [];
  let skippedNoAsym = 0, skippedNoAccounts = 0, skippedNoDraft = 0, skippedNoWin = 0;
  for (const m of matches) {
    if (!m.radiantTeamId || !m.direTeamId) continue;
    if (m.radiantWin == null) { skippedNoWin++; continue; }
    const g = games180dByMatch.get(m.matchId);
    if (!g) continue;
    if (g.r >= TEAM_GAMES_THRESHOLD && g.d >= TEAM_GAMES_THRESHOLD) { skippedNoAsym++; continue; }
    const d = drafts.get(m.matchId);
    if (!d) { skippedNoDraft++; continue; }
    const rAcc = (d.radiantAccountIds as number[] | null) ?? null;
    const dAcc = (d.direAccountIds as number[] | null) ?? null;
    if (!rAcc && !dAcc) { skippedNoAccounts++; continue; }

    // Player glicko per ростер.
    const rGlickos: number[] = []; const dGlickos: number[] = [];
    for (const a of rAcc ?? []) { if (a > 0) rGlickos.push(playerGlicko.get(a) ?? 1500); }
    for (const a of dAcc ?? []) { if (a > 0) dGlickos.push(playerGlicko.get(a) ?? 1500); }
    const rGlickoAvg = teamAvg(rGlickos.length ? rGlickos : [1500]);
    const dGlickoAvg = teamAvg(dGlickos.length ? dGlickos : [1500]);
    const rGlickoStd = teamStd(rGlickos);
    const dGlickoStd = teamStd(dGlickos);

    // wl_pro avg.
    const rWlVals: number[] = []; const dWlVals: number[] = [];
    for (const a of rAcc ?? []) { const v = wlPro.get(a); if (v != null) rWlVals.push(v); }
    for (const a of dAcc ?? []) { const v = wlPro.get(a); if (v != null) dWlVals.push(v); }
    const rWl = rWlVals.length ? teamAvg(rWlVals) : 0.5;
    const dWl = dWlVals.length ? teamAvg(dWlVals) : 0.5;

    // pro experience.
    const rExp: number[] = []; const dExp: number[] = [];
    for (const a of rAcc ?? []) { rExp.push(proGamesByAcc.get(a) ?? 0); }
    for (const a of dAcc ?? []) { dExp.push(proGamesByAcc.get(a) ?? 0); }
    const rExpAvg = rExp.length ? teamAvg(rExp) : 0;
    const dExpAvg = dExp.length ? teamAvg(dExp) : 0;

    // team rating diff (может быть нулём если obed не в teams).
    const rRating = teamRating.get(m.radiantTeamId);
    const dRating = teamRating.get(m.direTeamId);
    const teamRatingDiff = (rRating != null && dRating != null) ? (rRating - dRating) / 200 : 0;

    // peer synergy.
    const rPeer = peerByTeam.get(m.radiantTeamId);
    const dPeer = peerByTeam.get(m.direTeamId);
    const peerDiff = (rPeer ?? 0) - (dPeer ?? 0);

    // roster known + pool winrate.
    const rRoster = rosters.get(m.radiantTeamId);
    const dRoster = rosters.get(m.direTeamId);
    const rosterKnownR = rAcc && rRoster ? rAcc.filter(a => a > 0 && rRoster.has(a)).length / Math.max(1, rAcc.length) : 0;
    const rosterKnownD = dAcc && dRoster ? dAcc.filter(a => a > 0 && dRoster.has(a)).length / Math.max(1, dAcc.length) : 0;

    const rPool = pool.get(m.radiantTeamId);
    const dPool = pool.get(m.direTeamId);
    const poolStats = (picks: number[], p: Map<number, { games: number; wins: number }> | undefined): number => {
      if (!p || p.size === 0) return 0.5;
      let wSum = 0, wWinSum = 0;
      for (const h of picks) {
        const e = p.get(h);
        if (!e || e.games <= 0) continue;
        const w = Math.log(e.games + 1);
        wSum += w; wWinSum += (e.wins / e.games) * w;
      }
      return wSum > 0 ? wWinSum / wSum : 0.5;
    };
    const poolWrR = poolStats(d.radiantPicks ?? [], rPool);
    const poolWrD = poolStats(d.direPicks ?? [], dPool);

    // Hero draft strength — sum global proWR над picks.
    const draftStrR = (d.radiantPicks ?? []).reduce((s, h) => s + (heroWR.get(h) ?? 0.5), 0);
    const draftStrD = (d.direPicks ?? []).reduce((s, h) => s + (heroWR.get(h) ?? 0.5), 0);

    const recencyDaysNorm = (m.startTime - nowUnix) / (365 * 86400);
    const seriesTypeNorm = m.seriesType === 0 ? 0.0 : m.seriesType === 2 ? 1.0 : 0.5;
    const mapNoNorm = Math.min(Math.max((mapNoByMatch.get(m.matchId) ?? 1) - 1, 0), 4) / 4;

    const feats: number[] = [
      1,
      radiantSideLogit, recencyDaysNorm, seriesTypeNorm, mapNoNorm,
      Math.log(g.r + 1), Math.log(g.d + 1),
      teamRatingDiff,
      (rGlickoAvg - dGlickoAvg) / 200,
      (rGlickoAvg - 1500) / 200,
      (dGlickoAvg - 1500) / 200,
      rGlickoStd / 200,
      dGlickoStd / 200,
      rWl - dWl,
      rWl - 0.5,
      dWl - 0.5,
      Math.log1p(rExpAvg) - Math.log1p(dExpAvg),
      peerDiff,
      rosterKnownR,
      rosterKnownD,
      poolWrR - poolWrD,
      draftStrR - draftStrD,
    ];
    if (feats.length !== ASYM_FEATURE_DIM) {
      throw new Error(`feature dim mismatch: built ${feats.length}, expected ${ASYM_FEATURE_DIM}`);
    }
    samples.push({ features: feats, label: m.radiantWin ? 1 : 0 });
  }
  console.log(`[train-asym-prematch] samples=${samples.length}  (skip: no_asym=${skippedNoAsym} no_draft=${skippedNoDraft} no_accounts=${skippedNoAccounts} no_win=${skippedNoWin})  radiantWR_prior=${(radiantWR * 100).toFixed(1)}%`);
  // Подсчитываем roster_known coverage — главный sanity check для asym dataset.
  const rosterKnownNonZero = samples.filter(s => s.features[18] > 0 || s.features[19] > 0).length;
  console.log(`[train-asym-prematch] roster-known coverage: ${rosterKnownNonZero}/${samples.length} (${(rosterKnownNonZero / Math.max(1, samples.length) * 100).toFixed(0)}%)`);

  const r = await trainBucket(samples, [...ASYM_FEATURE_NAMES], 'asym-prematch');
  if (!r) {
    console.error('[train-asym-prematch] no model trained, aborting.');
    process.exit(1);
  }
  const blob = Buffer.from(r.blob_b64, 'base64');
  const version = `lgbm-asym-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-v1-prematch_winner_asym`;

  console.log(`\n[train-asym-prematch] Saving model ${version} …`);
  await saveLegacyCandidates(db, [{
      version,
      kind: 'prematch_winner_asym',
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
      hardMatchAccuracy: null,
      hardMatchBrier: null,
      hardMatchCount: 0,
      metadata: {
        tier: null,
        engine: 'lightgbm',
        variant: 'asymmetric',
        lgbmHyperparams: { num_leaves: 31, learning_rate: 0.05, n_estimators: 200 },
        testRaw: r.test_metrics_raw,
        testCalibrated: r.test_metrics_calibrated,
        calibSampleSize: r.calib_metrics.n,
        baselineAcc: r.baseline_acc,
        featureImportance: r.feature_importance,
        drifts: (r as TrainResponse & { drifts?: Array<{ name: string; trainMean: number; testMean: number; rel: number }> }).drifts ?? [],
        windowDays: TRAIN_WINDOW_DAYS,
        windowStartUnix: minStartTime,
        asymThreshold: TEAM_GAMES_THRESHOLD,
        asymPriorDays: ASYM_PRIOR_DAYS,
        trainSeconds: r.train_seconds,
        blobBytes: blob.length,
      },
      isActive: false,
    }], {
    trainer: 'train-asym-prematch', seed: 42,
    limitations: ['current_player_team_roster_aggregates_not_as_of', 'row_split_not_series_grouped', 'shared_early_stop_calibration_set'],
  });
  console.log(`\n[train-asym-prematch] Saved inactive, unvalidated candidate ${version}; active models unchanged`);
  process.exit(0);
}

main().catch(err => { console.error('[train-asym-prematch] FATAL', err); process.exit(1); });
