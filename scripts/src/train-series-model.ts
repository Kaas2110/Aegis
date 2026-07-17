/**
 * T003 (Layer B) — обучаемая mid-series модель: P(команда A берёт серию | серия идёт).
 *
 * Датасет: bo3_series (finished) — для каждой завершённой серии и каждого
 * промежуточного состояния «после карты k» (серия ещё не решена) — один сэмпл.
 *
 * Фичи (12, контракт SERIES_MID_FEATURE_NAMES — синхронизирован с
 * api-server/src/services/SeriesMidModel.ts):
 *   1  bias
 *   2  rating_diff_norm     (ratingA - ratingB)/200 из teams
 *   3  winrate_diff         wrA - wrB
 *   4  need_a               карт до победы A (после счёта)
 *   5  need_b               карт до победы B
 *   6  prev_won_by_a        1 если предыдущую карту взяла A
 *   7  prev_duration_norm   duration_sec/2400 предыдущей карты
 *   8  prev_kill_diff_norm  (killsA-killsB)/20 предыдущей карты
 *   9  drop_rate_a          историческая P(A отдаёт карту после выигранной) — сглаженная
 *   10 drop_rate_b
 *   11 pick_strangeness_a   «странность пика» A на предыдущей карте:
 *                           mean(1 - min(1, games_on_hero/20)) по 5 игрокам
 *                           (match_drafts.account_ids × player_hero_stats); 0.5 если нет данных
 *   12 pick_strangeness_b
 *
 * Label: A выигрывает серию. Обучение через ml-service POST /train
 * (classification + isotonic calibration), атомарный swap kind='series_mid'.
 *
 * Анти-leakage: drop-rate считается по ВСЕМ сериям минус вклад текущей серии.
 *
 * CLI: pnpm --filter @workspace/scripts run train:series-model [--min-samples N]
 */

import {
  db,
  bo3SeriesTable,
  proMatchesTable,
  teamsTable,
  matchDraftsTable,
  playerHeroStatsTable,
  modelVersionsTable,
} from '@workspace/db';
import { eq, and, inArray } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';
const TRAIN_TIMEOUT_MS = 120_000;
const KIND = 'series_mid';
const MIN_SAMPLES_DEFAULT = 300;
const DROP_SMOOTH_K = 5;

export const SERIES_MID_FEATURE_NAMES = [
  'bias', 'rating_diff_norm', 'winrate_diff', 'need_a', 'need_b',
  'prev_won_by_a', 'prev_duration_norm', 'prev_kill_diff_norm',
  'drop_rate_a', 'drop_rate_b', 'pick_strangeness_a', 'pick_strangeness_b',
] as const;

interface MapEntry {
  matchId: number;
  mapNumber: number;
  finished: boolean;
  winnerSide: 'radiant' | 'dire';
  radiantTeamId: number;
  direTeamId: number;
}

interface SeriesRow {
  seriesId: number;
  teamAId: number | null;
  teamBId: number | null;
  format: number; // 1=BO3? формат compute-bo3-series: сколько побед нужно (series_type)
  maps: MapEntry[];
  winsA: number;
  winsB: number;
}

function mlServiceToken(): string | null {
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) return env;
  try {
    const v = readFileSync(ML_TOKEN_FILE, 'utf8').trim();
    return v || null;
  } catch { return null; }
}

/** Сколько побед нужно для взятия серии по колонке format (series_type OpenDota: 0=BO1,1=BO3,2=BO5). */
function needToWin(format: number): number {
  if (format === 0) return 1;
  if (format === 2) return 3;
  return 2;
}

function mapWinnerTeamId(m: MapEntry): number {
  return m.winnerSide === 'radiant' ? m.radiantTeamId : m.direTeamId;
}

async function main(): Promise<void> {
  const minIdx = process.argv.indexOf('--min-samples');
  const minSamples = minIdx !== -1 && process.argv[minIdx + 1]
    ? parseInt(process.argv[minIdx + 1], 10) : MIN_SAMPLES_DEFAULT;

  console.log('[train-series-model] loading bo3_series...');
  const rows = await db
    .select({
      seriesId: bo3SeriesTable.seriesId,
      teamAId: bo3SeriesTable.teamAId,
      teamBId: bo3SeriesTable.teamBId,
      format: bo3SeriesTable.format,
      maps: bo3SeriesTable.maps,
      winsA: bo3SeriesTable.winsA,
      winsB: bo3SeriesTable.winsB,
    })
    .from(bo3SeriesTable)
    .where(eq(bo3SeriesTable.finished, true));

  const series: SeriesRow[] = rows
    .filter(r => r.teamAId && r.teamBId && Array.isArray(r.maps) && (r.maps as MapEntry[]).length >= 2)
    .map(r => ({
      seriesId: Number(r.seriesId),
      teamAId: Number(r.teamAId),
      teamBId: Number(r.teamBId),
      format: r.format,
      maps: ((r.maps as MapEntry[]) ?? [])
        .filter(m => m.finished && m.matchId && m.radiantTeamId && m.direTeamId)
        .sort((a, b) => a.mapNumber - b.mapNumber),
      winsA: r.winsA,
      winsB: r.winsB,
    }))
    .filter(r => r.maps.length >= 2 && r.winsA !== r.winsB);
  console.log(`  series usable: ${series.length}`);

  // ── drop-rate: per-team (opportunities, drops) — глобально + вклад по сериям
  const dropGlobal = new Map<number, { opps: number; drops: number }>();
  const dropBySeries = new Map<number, Map<number, { opps: number; drops: number }>>();
  let globOpps = 0; let globDrops = 0;
  for (const s of series) {
    const local = new Map<number, { opps: number; drops: number }>();
    for (let i = 0; i + 1 < s.maps.length; i++) {
      const w = mapWinnerTeamId(s.maps[i]);
      const nextW = mapWinnerTeamId(s.maps[i + 1]);
      const dropped = nextW !== w ? 1 : 0;
      const g = dropGlobal.get(w) ?? { opps: 0, drops: 0 };
      g.opps += 1; g.drops += dropped; dropGlobal.set(w, g);
      const l = local.get(w) ?? { opps: 0, drops: 0 };
      l.opps += 1; l.drops += dropped; local.set(w, l);
      globOpps += 1; globDrops += dropped;
    }
    dropBySeries.set(s.seriesId, local);
  }
  const globalDropRate = globOpps > 0 ? globDrops / globOpps : 0.35;
  console.log(`  global drop-rate: ${(globalDropRate * 100).toFixed(1)}% (${globDrops}/${globOpps})`);

  function dropRateFor(teamId: number, excludeSeriesId: number): number {
    const g = dropGlobal.get(teamId) ?? { opps: 0, drops: 0 };
    const ex = dropBySeries.get(excludeSeriesId)?.get(teamId) ?? { opps: 0, drops: 0 };
    const opps = g.opps - ex.opps;
    const drops = g.drops - ex.drops;
    return (drops + DROP_SMOOTH_K * globalDropRate) / (opps + DROP_SMOOTH_K);
  }

  // ── team ratings
  const teamRows = await db.select({
    teamId: teamsTable.teamId, rating: teamsTable.rating,
    wins: teamsTable.wins, losses: teamsTable.losses,
  }).from(teamsTable);
  const teams = new Map<number, { rating: number; wr: number }>();
  for (const t of teamRows) {
    const g = (t.wins ?? 0) + (t.losses ?? 0);
    if (t.rating != null && g >= 5) teams.set(Number(t.teamId), { rating: t.rating, wr: (t.wins ?? 0) / g });
  }

  // ── prev-map stats: pro_matches по всем matchId из серий
  const allMatchIds = series.flatMap(s => s.maps.map(m => m.matchId));
  const matchStats = new Map<number, { duration: number; rScore: number; dScore: number }>();
  const CHUNK = 5000;
  for (let i = 0; i < allMatchIds.length; i += CHUNK) {
    const chunk = allMatchIds.slice(i, i + CHUNK);
    const ms = await db.select({
      matchId: proMatchesTable.matchId,
      duration: proMatchesTable.duration,
      rScore: proMatchesTable.radiantScore,
      dScore: proMatchesTable.direScore,
    }).from(proMatchesTable).where(inArray(proMatchesTable.matchId, chunk));
    for (const m of ms) {
      matchStats.set(Number(m.matchId), {
        duration: m.duration, rScore: m.rScore ?? 0, dScore: m.dScore ?? 0,
      });
    }
  }
  console.log(`  match stats: ${matchStats.size}/${allMatchIds.length}`);

  // ── pick strangeness: drafts + player_hero_stats
  const drafts = new Map<number, {
    rPicks: number[]; dPicks: number[]; rAcc: number[] | null; dAcc: number[] | null;
  }>();
  for (let i = 0; i < allMatchIds.length; i += CHUNK) {
    const chunk = allMatchIds.slice(i, i + CHUNK);
    const ds = await db.select({
      matchId: matchDraftsTable.matchId,
      rPicks: matchDraftsTable.radiantPicks,
      dPicks: matchDraftsTable.direPicks,
      rAcc: matchDraftsTable.radiantAccountIds,
      dAcc: matchDraftsTable.direAccountIds,
    }).from(matchDraftsTable).where(inArray(matchDraftsTable.matchId, chunk));
    for (const d of ds) {
      if (!Array.isArray(d.rPicks) || !Array.isArray(d.dPicks)) continue;
      drafts.set(Number(d.matchId), {
        rPicks: d.rPicks as number[], dPicks: d.dPicks as number[],
        rAcc: Array.isArray(d.rAcc) ? d.rAcc as number[] : null,
        dAcc: Array.isArray(d.dAcc) ? d.dAcc as number[] : null,
      });
    }
  }
  console.log(`  drafts: ${drafts.size}/${allMatchIds.length}`);

  // player_hero_stats только для нужных аккаунтов
  const accountIds = new Set<number>();
  for (const d of drafts.values()) {
    for (const a of d.rAcc ?? []) accountIds.add(a);
    for (const a of d.dAcc ?? []) accountIds.add(a);
  }
  const phGames = new Map<string, number>(); // `${acc}:${hero}` → games
  const accArr = [...accountIds];
  for (let i = 0; i < accArr.length; i += 1000) {
    const chunk = accArr.slice(i, i + 1000);
    const ps = await db.select({
      accountId: playerHeroStatsTable.accountId,
      heroId: playerHeroStatsTable.heroId,
      games: playerHeroStatsTable.games,
    }).from(playerHeroStatsTable).where(inArray(playerHeroStatsTable.accountId, chunk));
    for (const p of ps) phGames.set(`${p.accountId}:${p.heroId}`, p.games);
  }
  console.log(`  player-hero pairs loaded: ${phGames.size} (accounts=${accountIds.size})`);

  /** Странность пика стороны: mean(1 - min(1, games/20)); null если нет соответствий. */
  function strangeness(picks: number[], accs: number[] | null): number | null {
    if (!accs || accs.length === 0 || picks.length === 0) return null;
    // account_ids и picks не сопоставлены по позициям надёжно → берём для
    // каждого героя МИНИМАЛЬНУЮ странность среди аккаунтов команды (кто-то из
    // ростера играет героя часто → пик не странный).
    const vals: number[] = [];
    for (const hero of picks) {
      let best = 1;
      for (const a of accs) {
        const g = phGames.get(`${a}:${hero}`) ?? 0;
        best = Math.min(best, 1 - Math.min(1, g / 20));
      }
      vals.push(best);
    }
    return vals.reduce((x, y) => x + y, 0) / vals.length;
  }

  // ── сэмплы
  interface Sample { features: number[]; label: number; }
  const samples: Sample[] = [];
  for (const s of series) {
    const need = needToWin(s.format);
    const aWinsSeries = s.winsA > s.winsB ? 1 : 0;
    const tA = teams.get(s.teamAId!);
    const tB = teams.get(s.teamBId!);
    if (!tA || !tB) continue;
    let sa = 0; let sb = 0;
    for (let k = 0; k < s.maps.length - 1; k++) {
      const map = s.maps[k];
      const wTeam = mapWinnerTeamId(map);
      if (wTeam === s.teamAId) sa += 1; else if (wTeam === s.teamBId) sb += 1; else continue;
      if (sa >= need || sb >= need) break; // серия решена
      const st = matchStats.get(map.matchId);
      if (!st) continue;
      const aIsRadiant = map.radiantTeamId === s.teamAId;
      const killsA = aIsRadiant ? st.rScore : st.dScore;
      const killsB = aIsRadiant ? st.dScore : st.rScore;
      const d = drafts.get(map.matchId);
      const strA = d ? strangeness(aIsRadiant ? d.rPicks : d.dPicks, aIsRadiant ? d.rAcc : d.dAcc) : null;
      const strB = d ? strangeness(aIsRadiant ? d.dPicks : d.rPicks, aIsRadiant ? d.dAcc : d.rAcc) : null;
      samples.push({
        features: [
          1,
          (tA.rating - tB.rating) / 200,
          tA.wr - tB.wr,
          need - sa,
          need - sb,
          wTeam === s.teamAId ? 1 : 0,
          st.duration / 2400,
          (killsA - killsB) / 20,
          dropRateFor(s.teamAId!, s.seriesId),
          dropRateFor(s.teamBId!, s.seriesId),
          strA ?? 0.5,
          strB ?? 0.5,
        ],
        label: aWinsSeries,
      });
    }
  }
  console.log(`  samples: ${samples.length}`);
  if (samples.length < minSamples) {
    console.log(`[train-series-model] SKIP: ${samples.length} < ${minSamples} — остаёмся на Layer A`);
    process.exit(0);
  }

  const n = samples.length;
  const train = samples.slice(0, Math.floor(n * 0.8));
  const calib = samples.slice(Math.floor(n * 0.8), Math.floor(n * 0.9));
  const test = samples.slice(Math.floor(n * 0.9));

  const token = mlServiceToken();
  if (!token) {
    console.error(`[train-series-model] нет ML_SERVICE_TOKEN (env или ${ML_TOKEN_FILE}) — запустите ml-service`);
    process.exit(1);
  }

  console.log(`[train-series-model] training n=${train.length}/calib=${calib.length}/test=${test.length} fdim=${SERIES_MID_FEATURE_NAMES.length}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAIN_TIMEOUT_MS);
  let data: {
    blob_b64: string; feature_names: string[];
    train_metrics: { accuracy: number; brier: number; n: number };
    calib_metrics: { n: number };
    test_metrics_raw: unknown; baseline_acc: number;
    test_metrics_calibrated: { accuracy: number; brier: number; log_loss: number; n: number };
    feature_importance: Record<string, number>;
    train_seconds: number;
  };
  try {
    const res = await fetch(`${ML_SERVICE_URL}/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ml-token': token },
      body: JSON.stringify({
        label: KIND,
        feature_names: SERIES_MID_FEATURE_NAMES,
        task_type: 'classification',
        alpha: 0.5,
        train, calib, test,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[train-series-model] ml-service ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      process.exit(1);
    }
    data = (await res.json()) as typeof data;
  } finally {
    clearTimeout(timer);
  }

  const tm = data.test_metrics_calibrated;
  console.log(`[train-series-model] TEST acc=${(tm.accuracy * 100).toFixed(1)}% brier=${tm.brier.toFixed(4)} baseline=${(data.baseline_acc * 100).toFixed(1)}% (n=${tm.n})`);
  const imp = Object.entries(data.feature_importance ?? {}).sort((a, b) => b[1] - a[1]);
  console.log(`  IMPORTANCE: ${imp.map(([k, v]) => `${k}=${v.toFixed(0)}`).join(' ')}`);

  const blob = Buffer.from(data.blob_b64, 'base64');
  const version = `lgbm-${KIND}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  await db.transaction(async (tx) => {
    await tx.update(modelVersionsTable).set({ isActive: false })
      .where(and(eq(modelVersionsTable.kind, KIND), eq(modelVersionsTable.isActive, true)));
    await tx.insert(modelVersionsTable).values({
      version,
      kind: KIND,
      featuresVersion: 1,
      algorithm: 'lightgbm',
      engine: 'lightgbm',
      binaryBlob: blob,
      features: data.feature_names,
      weights: {},
      trainAccuracy: data.train_metrics.accuracy,
      testAccuracy: tm.accuracy,
      brierScore: tm.brier,
      trainSampleSize: data.train_metrics.n,
      testSampleSize: tm.n,
      metadata: {
        market: KIND,
        task_type: 'classification',
        engine: 'lightgbm',
        baselineAcc: data.baseline_acc,
        featureImportance: data.feature_importance,
        calibSampleSize: data.calib_metrics.n,
        trainSeconds: data.train_seconds,
        blobBytes: blob.length,
        globalDropRate,
      },
      isActive: true,
    });
  });
  console.log(`[train-series-model] ✅ activated ${version} (blob=${blob.length}b)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[train-series-model] fatal:', err);
  process.exit(1);
});
