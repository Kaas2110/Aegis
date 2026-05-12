/**
 * Обучение LIVE-модели победителя матча.
 *
 * Модель работает ВО ВРЕМЯ матча: текущий снапшот (NW lead, kills,
 * tower ratios, game_time, phase) + прематч-вероятность + hero advantage → P(Radiant).
 *
 * Фичи (11 + bias = 12):
 *   x0  = 1                                         bias
 *   x1  = (gameTimeSec - 1800) / 1800               нормализованное время
 *   x2  = radiantLead / 10000                       net worth преимущество
 *   x3  = (radiantScore - direScore) / 15           разница убийств
 *   x4  = (11 - r_towers_alive) / 11                доля ПОТЕРЯННЫХ башен Radiant (0=нет данных)
 *   x5  = (11 - d_towers_alive) / 11                доля ПОТЕРЯННЫХ башен Dire   (0=нет данных)
 *   x6  = logit(prematchProb)                       прематч как сильный приор
 *   x7  = kills_per_min / 1.1                       темп убийств (time-нормирован)
 *   x8  = clip(gameTimeSec / 3600, 0, 1)            фаза игры 0→1
 *   x9  = (radiantLead / 10000) × game_phase        взаимодействие: NW важнее в лейте
 *   x10 = killDiff / 15 × game_phase                убийства важнее в лейте
 *   x11 = hero_advantage (от matchup-матрицы, 0 если драфт неизвестен)
 *
 * Два движка:
 *   - LightGBM (primary)  — обучается через ml-service, blob в DB
 *   - LogReg   (fallback) — pure-JS, работает без ml-service
 *
 * CLI:
 *   --dry-run        не сохранять, только вывести метрики
 *   --since-unix N   ограничить снапшоты по времени создания (unix)
 *   --min-samples N  минимум сэмплов (default: 50 для обоих)
 */

import {
  db,
  modelVersionsTable,
  teamsTable,
  teamRecentFormTable,
  heroMatchupsTable,
} from '@workspace/db';
import { sql, and, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

const EPOCHS = 300;
const LR_RATE = 0.03;
const L2 = 0.01;

// Версия фич: 8 (20 фич — fv7 + is_real_live + tower_diff_norm + has_draft + recency_days_norm)
const FEATURES_VERSION = 8;

const FEATURE_NAMES = [
  'bias',
  'game_time_norm',
  'nw_lead_norm',
  'kill_diff_norm',
  'prematch_logit',
  'kill_pace_norm',
  'game_phase',
  'nw_x_phase',
  'kill_diff_x_phase',
  'hero_advantage',
  'nw_lead_per_min',
  'kill_ratio',
  'elo_diff_norm',
  'form_diff',
  'power_spike_delta',
  'spike_x_nw',
  'is_real_live',        // x16 НОВАЯ: 1 если ls.source='live', 0 если backfill
  'tower_diff_norm',     // x17 НОВАЯ: (r_towers_alive - d_towers_alive)/11; 0 если нет building_state
  'has_draft',           // x18 НОВАЯ: 1 если 5+5 пиков известны, 0 иначе
  'recency_days_norm',   // x19 НОВАЯ: (now-startTime)/365 ∈ [0,1]; прокси для patch_age
];
const FEATURE_DIM = FEATURE_NAMES.length;
const TRAIN_WINDOW_DAYS = 365;
// Зазор между train и test по времени (избежать leakage между матчами одной серии).
const TEST_GAP_DAYS = 1;

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';
const TRAIN_TIMEOUT_MS = 90_000;
const GLOBAL_KPM = 1.1;

type HeroMatchupsMap = Map<number, Map<number, { games: number; winRate: number }>>;

function mlServiceToken(): string | null {
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) return env;
  try { return readFileSync(ML_TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
}

function isDryRun(): boolean { return process.argv.includes('--dry-run'); }

function parseSinceUnix(): number | null {
  const idx = process.argv.indexOf('--since-unix');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return null;
}

function parseMinSamples(def: number): number {
  const idx = process.argv.indexOf('--min-samples');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return def;
}

interface Sample { features: number[]; label: number; matchId: number; bucket: number; startTime: number; }

/** Bitmap popcount (Brian Kernighan), для bits >= 32 — безопасно через BigInt. */
function popcountBig(n: bigint): number {
  let count = 0;
  let x = n;
  while (x > 0n) { x &= x - 1n; count++; }
  return count;
}
const RADIANT_TOWER_MASK = (1n << 11n) - 1n;          // bits 0..10
const DIRE_TOWER_MASK = ((1n << 22n) - 1n) ^ RADIANT_TOWER_MASK; // bits 11..21

function logit(p: number): number {
  const eps = 1e-4;
  const q = Math.min(Math.max(p, eps), 1 - eps);
  return Math.log(q / (1 - q));
}

function sigmoid(z: number): number {
  if (z >= 0) { const ez = Math.exp(-z); return 1 / (1 + ez); }
  const ez = Math.exp(z); return ez / (1 + ez);
}

function dot(w: number[], x: number[]): number {
  let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * x[i]; return s;
}

/**
 * Вычисляет hero matchup advantage для Radiant относительно Dire.
 * Результат: взвешенное среднее (winRate - 0.5) × log(games+1) для всех 25 пар,
 * делённое на общий вес → диапазон примерно [-0.2, +0.2], 0 если нет данных.
 * Identical formula to inference side in LiveWinnerModel.ts.
 */
function computeHeroAdvantage(
  radiantPicks: number[],
  direPicks: number[],
  matchups: HeroMatchupsMap,
): number {
  let totalAdv = 0;
  let totalWeight = 0;
  for (const r of radiantPicks) {
    const outerMap = matchups.get(r);
    for (const d of direPicks) {
      const direct = outerMap?.get(d);
      if (direct && direct.games >= 5) {
        const w = Math.log(direct.games + 1);
        totalAdv += (direct.winRate - 0.5) * w;
        totalWeight += w;
        continue;
      }
      const inverse = matchups.get(d)?.get(r);
      if (inverse && inverse.games >= 5) {
        const w = Math.log(inverse.games + 1);
        totalAdv += (0.5 - inverse.winRate) * w;
        totalWeight += w;
      }
    }
  }
  return totalWeight > 0 ? totalAdv / totalWeight : 0;
}

function trainLogisticRegression(samples: Sample[], dim: number): number[] {
  const w = new Array(dim).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    for (let i = samples.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [samples[i], samples[j]] = [samples[j], samples[i]];
    }
    for (const s of samples) {
      const p = sigmoid(dot(w, s.features));
      const err = p - s.label;
      for (let i = 0; i < dim; i++) {
        w[i] -= LR_RATE * (err * s.features[i] + (i === 0 ? 0 : L2 * w[i]));
      }
    }
  }
  return w;
}

function evaluate(samples: Sample[], w: number[]): { acc: number; logLoss: number; brier: number } {
  let correct = 0, logLoss = 0, brier = 0;
  for (const s of samples) {
    const p = sigmoid(dot(w, s.features));
    if ((p >= 0.5 ? 1 : 0) === s.label) correct++;
    const eps = 1e-9;
    logLoss += -(s.label * Math.log(p + eps) + (1 - s.label) * Math.log(1 - p + eps));
    brier += (p - s.label) ** 2;
  }
  return { acc: correct / samples.length, logLoss: logLoss / samples.length, brier: brier / samples.length };
}

interface LgbmResult {
  blobB64: string;
  trainAcc: number;
  testAcc: number;
  brier: number;
  trainN: number;
  testN: number;
  baselineAcc: number;
  featureImportance: Record<string, number>;
}

async function trainLgbm(train: Sample[], calib: Sample[], test: Sample[]): Promise<LgbmResult | null> {
  const token = mlServiceToken();
  if (!token) { console.warn('[train-live-model] no ml-service token — skipping LGB'); return null; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAIN_TIMEOUT_MS);
  try {
    const h = await fetch(`${ML_SERVICE_URL}/healthz`, { signal: ctrl.signal });
    if (!h.ok) throw new Error(`ml-service unhealthy: ${h.status}`);

    const res = await fetch(`${ML_SERVICE_URL}/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ml-token': token },
      body: JSON.stringify({
        label: 'live_winner',
        feature_names: FEATURE_NAMES,
        train: train.map(s => ({ features: s.features, label: s.label })),
        calib: calib.map(s => ({ features: s.features, label: s.label })),
        test: test.map(s => ({ features: s.features, label: s.label })),
        task_type: 'classification',
        // Group C: balanced class weights — компенсирует временной сдвиг
        // (test: radiant 64%, train 52%). LGB перевзвешивает minority class.
        class_weight: 'balanced',
        // Сильная регуляризация: малый датасет (~300-2000 снапшотов)
        num_leaves: 15,
        max_depth: 4,
        learning_rate: 0.05,
        n_estimators: 80,
        min_child_samples: 20,
        reg_alpha: 0.5,
        reg_lambda: 1.0,
        feature_fraction: 0.8,
        bagging_fraction: 0.8,
        bagging_freq: 5,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[train-live-model] ml-service ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as {
      blob_b64: string;
      train_metrics: { accuracy: number; n: number };
      test_metrics_calibrated: { accuracy: number; brier: number; n: number };
      baseline_acc: number;
      feature_importance: Record<string, number>;
    };
    return {
      blobB64: data.blob_b64,
      trainAcc: data.train_metrics.accuracy,
      testAcc: data.test_metrics_calibrated.accuracy,
      brier: data.test_metrics_calibrated.brier,
      trainN: data.train_metrics.n,
      testN: data.test_metrics_calibrated.n,
      baselineAcc: data.baseline_acc,
      featureImportance: data.feature_importance,
    };
  } catch (e) {
    console.error(`[train-live-model] LGB training failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ELO-based prematch probability.
 */
function eloPrematchProb(
  rRating: number, dRating: number,
  rWins: number, rLosses: number,
  dWins: number, dLosses: number,
  rWinrate30: number | null, dWinrate30: number | null,
): number {
  const eloDiff = (rRating - dRating) / 200;
  const rWr = rWins / Math.max(rWins + rLosses, 1);
  const dWr = dWins / Math.max(dWins + dLosses, 1);
  const wrDiff = (rWinrate30 ?? rWr) - (dWinrate30 ?? dWr);
  const combined = eloDiff * 0.7 + wrDiff * 0.3;
  return sigmoid(combined);
}

async function main() {
  const dryRun = isDryRun();
  const sinceUnix = parseSinceUnix();
  const minSamples = parseMinSamples(50);

  if (dryRun) console.log('[train-live-model] DRY-RUN mode');
  if (sinceUnix) console.log(`[train-live-model] since_unix=${sinceUnix} (${new Date(sinceUnix * 1000).toISOString().slice(0, 10)})`);

  console.log('[train-live-model] Loading team ratings, form, hero matchups & power timings …');
  const [teamsRows, formRows, matchupRows, powerTimingResult] = await Promise.all([
    db.select({
      teamId: teamsTable.teamId,
      rating: teamsTable.rating,
      wins: teamsTable.wins,
      losses: teamsTable.losses,
    }).from(teamsTable),
    db.select({
      teamId: teamRecentFormTable.teamId,
      winRate: teamRecentFormTable.winRate,
    }).from(teamRecentFormTable).where(eq(teamRecentFormTable.periodDays, 30)),
    db.select({
      heroId: heroMatchupsTable.heroId,
      vsHeroId: heroMatchupsTable.vsHeroId,
      games: heroMatchupsTable.games,
      winRate: heroMatchupsTable.winRate,
    }).from(heroMatchupsTable),
    // hero power timing: avg winning game duration per hero (proxy for power peak minute)
    db.execute(sql`
      WITH wins AS (
        SELECT (jsonb_array_elements(md.radiant_picks))::int AS hero_id, pm.duration
        FROM match_drafts md JOIN pro_matches pm ON pm.match_id = md.match_id
        WHERE pm.radiant_win = true
        UNION ALL
        SELECT (jsonb_array_elements(md.dire_picks))::int AS hero_id, pm.duration
        FROM match_drafts md JOIN pro_matches pm ON pm.match_id = md.match_id
        WHERE pm.radiant_win = false
      )
      SELECT hero_id::int AS "heroId", AVG(duration)::float / 60.0 AS "avgWinMin"
      FROM wins
      GROUP BY hero_id HAVING COUNT(*) >= 5
    `),
  ]);

  const teamMap = new Map<number, { rating: number; wins: number; losses: number }>();
  for (const t of teamsRows) {
    if (t.rating != null) teamMap.set(t.teamId, { rating: t.rating, wins: t.wins ?? 0, losses: t.losses ?? 0 });
  }
  const formMap = new Map<number, number>();
  for (const f of formRows) {
    if (f.winRate != null) formMap.set(f.teamId, f.winRate);
  }

  // Hero power timing map: heroId → avg winning game duration in minutes
  const heroPowerTiming = new Map<number, number>();
  let totalWinMin = 0;
  let totalWinCount = 0;
  for (const row of (powerTimingResult.rows as { heroId: number; avgWinMin: number }[])) {
    const min = Number(row.avgWinMin);
    if (Number.isFinite(min) && min > 0) {
      heroPowerTiming.set(Number(row.heroId), min);
      totalWinMin += min;
      totalWinCount++;
    }
  }
  const globalAvgWinMin = totalWinCount > 0 ? totalWinMin / totalWinCount : 39;
  console.log(
    `[train-live-model] power timing: ${heroPowerTiming.size} heroes (global avg ${globalAvgWinMin.toFixed(1)} min)`,
  );

  // Build hero matchups cache: heroId → vsHeroId → { games, winRate }
  const heroMatchups: HeroMatchupsMap = new Map();
  for (const row of matchupRows) {
    if (!heroMatchups.has(row.heroId)) heroMatchups.set(row.heroId, new Map());
    heroMatchups.get(row.heroId)!.set(row.vsHeroId, {
      games: row.games ?? 0,
      winRate: typeof row.winRate === 'number' ? row.winRate : Number(row.winRate ?? 0.5),
    });
  }
  console.log(
    `[train-live-model] teams=${teamMap.size} | form=${formMap.size} | hero matchup pairs=${matchupRows.length}`,
  );

  console.log('[train-live-model] Joining live_snapshots × pro_matches × prematch_outcomes × match_drafts …');

  // Group B: LEFT JOIN match_drafts для hero_advantage/power_spike фич.
  // Двойной fallback для пиков: 1) match_drafts (авторитетный, picks+bans+accounts),
  // 2) raw_payload->players (присутствует в ~22% снапшотов, team=0/1).
  // После ingest:drafts match_drafts закроет большинство случаев,
  // raw_payload добавляет покрытие для снапшотов у которых драфт ещё не доинджестен.
  const rows = await db.execute(sql`
    SELECT
      ls.match_id                   AS "matchId",
      ls.game_time_sec              AS "gameTimeSec",
      ls.radiant_lead               AS "radiantLead",
      ls.radiant_score              AS "radiantScore",
      ls.dire_score                 AS "direScore",
      ls.source                     AS "lsSource",
      ls.building_state             AS "buildingState",
      pm.start_time                 AS "startTime",
      pm.radiant_team_id            AS "radiantTeamId",
      pm.dire_team_id               AS "direTeamId",
      po.predicted_radiant_win_prob AS "storedPrematchProb",
      COALESCE(po.actual_radiant_win, pm.radiant_win) AS "actualRadiantWin",
      COALESCE(
        md.radiant_picks,
        (SELECT jsonb_agg((p->>'hero_id')::int)
         FROM jsonb_array_elements(ls.raw_payload->'players') p
         WHERE (p->>'hero_id') IS NOT NULL AND (p->>'hero_id')::int > 0
           AND p->>'team' = '0'
         HAVING COUNT(*) = 5)
      ) AS "radiantPicks",
      COALESCE(
        md.dire_picks,
        (SELECT jsonb_agg((p->>'hero_id')::int)
         FROM jsonb_array_elements(ls.raw_payload->'players') p
         WHERE (p->>'hero_id') IS NOT NULL AND (p->>'hero_id')::int > 0
           AND p->>'team' = '1'
         HAVING COUNT(*) = 5)
      ) AS "direPicks"
    FROM live_snapshots ls
    INNER JOIN pro_matches pm ON pm.match_id = ls.match_id
    LEFT JOIN prematch_outcomes po ON po.match_id = ls.match_id
    LEFT JOIN match_drafts md ON md.match_id = ls.match_id
    WHERE pm.radiant_win IS NOT NULL
      AND ls.game_time_sec IS NOT NULL
      AND ls.game_time_sec >= 60
      AND ls.game_time_sec <= 7200
    ORDER BY ls.match_id, ls.game_time_sec
    LIMIT 200000
  `);

  console.log(`[train-live-model] Joined ${rows.rows.length} snapshot rows`);

  if (rows.rows.length < minSamples) {
    console.error(
      `[train-live-model] Not enough joined data (${rows.rows.length} < ${minSamples}).\n` +
      '  Это нормально на свежей системе — live-модель требует накопления снапшотов.',
    );
    process.exit(0);
  }

  const toNum = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  let storedPrematchCount = 0;
  let eloPrematchCount = 0;
  let unknownPrematchCount = 0;
  let heroAdvCount = 0;
  let isRealLiveCount = 0;
  let towerDataCount = 0;
  let hasDraftCount = 0;
  const nowSec = Math.floor(Date.now() / 1000);

  const seenBuckets = new Set<string>();
  const samples: Sample[] = [];

  for (const raw of rows.rows as unknown as Record<string, unknown>[]) {
    const matchId = toNum(raw['matchId']);
    const gameTimeSec = toNum(raw['gameTimeSec']);
    if (matchId == null || gameTimeSec == null) continue;

    // 1 снапшот на 3-минутный bucket
    const bucket = Math.floor(gameTimeSec / 180);
    const key = `${matchId}:${bucket}`;
    if (seenBuckets.has(key)) continue;
    seenBuckets.add(key);

    // Prematch probability
    let prematchProb: number;
    const storedProb = toNum(raw['storedPrematchProb']);
    if (storedProb != null && storedProb > 0 && storedProb < 1) {
      prematchProb = storedProb;
      storedPrematchCount++;
    } else {
      const rId = toNum(raw['radiantTeamId']);
      const dId = toNum(raw['direTeamId']);
      const rTeam = rId != null ? teamMap.get(rId) : undefined;
      const dTeam = dId != null ? teamMap.get(dId) : undefined;
      if (rTeam && dTeam) {
        prematchProb = eloPrematchProb(
          rTeam.rating, dTeam.rating,
          rTeam.wins, rTeam.losses,
          dTeam.wins, dTeam.losses,
          rId != null ? (formMap.get(rId) ?? null) : null,
          dId != null ? (formMap.get(dId) ?? null) : null,
        );
        eloPrematchCount++;
      } else {
        prematchProb = 0.52;
        unknownPrematchCount++;
      }
    }

    const radiantLead = toNum(raw['radiantLead']) ?? 0;
    const radiantScore = toNum(raw['radiantScore']) ?? 0;
    const direScore = toNum(raw['direScore']) ?? 0;
    const killDiff = radiantScore - direScore;
    const totalKills = radiantScore + direScore;

    const gameTimeMins = gameTimeSec / 60;
    const killPaceNorm = gameTimeSec > 0
      ? (totalKills / gameTimeMins) / GLOBAL_KPM
      : 0;

    const gamePhase = Math.min(gameTimeSec / 3600, 1.0);
    const nwNorm = radiantLead / 10000;
    const killDiffNorm = killDiff / 15;
    const nwXPhase = nwNorm * gamePhase;
    const killXPhase = killDiffNorm * gamePhase;

    // Новые фичи
    const nwLeadPerMin = gameTimeMins > 1 ? (radiantLead / gameTimeMins) / 1000 : 0;
    const killRatio = totalKills > 0 ? radiantScore / totalKills : 0.5;

    // Командные контекстные фичи (elo + form)
    const rId = toNum(raw['radiantTeamId']);
    const dId = toNum(raw['direTeamId']);
    const rTeam = rId != null ? teamMap.get(rId) : undefined;
    const dTeam = dId != null ? teamMap.get(dId) : undefined;
    const eloDiffNorm = (rTeam && dTeam) ? (rTeam.rating - dTeam.rating) / 200 : 0;
    const formDiff = (rId != null && dId != null)
      ? (formMap.get(rId) ?? 0.5) - (formMap.get(dId) ?? 0.5)
      : 0;

    // Group B: hero_advantage от matchup-матрицы (0 когда драфт неизвестен)
    let heroAdvantage = 0;
    let powerSpikeDelta = 0;
    let spikeXNw = 0;
    const rPicks = raw['radiantPicks'];
    const dPicks = raw['direPicks'];
    const hasDraft = (
      Array.isArray(rPicks) && Array.isArray(dPicks) &&
      rPicks.length === 5 && dPicks.length === 5
    );
    if (hasDraft && heroMatchups.size > 0) {
      heroAdvantage = computeHeroAdvantage(
        rPicks as number[], dPicks as number[], heroMatchups,
      );
      heroAdvCount++;
    }
    if (hasDraft && heroPowerTiming.size > 0) {
      const SIGMA = 8; // minutes
      const spike = (heroIds: number[]) =>
        heroIds.reduce((sum, h) => {
          const peak = heroPowerTiming.get(h) ?? globalAvgWinMin;
          const d = gameTimeMins - peak;
          return sum + Math.exp(-0.5 * (d / SIGMA) ** 2);
        }, 0) / heroIds.length;
      const rSpike = spike(rPicks as number[]);
      const dSpike = spike(dPicks as number[]);
      powerSpikeDelta = rSpike - dSpike;
      spikeXNw = powerSpikeDelta * nwNorm;
    }

    // НОВЫЕ ФИЧИ (fv8)
    const lsSource = String(raw['lsSource'] ?? '');
    const isRealLive = lsSource === 'live' ? 1 : 0;
    if (isRealLive) isRealLiveCount++;

    let towerDiffNorm = 0;
    const buildingStateRaw = raw['buildingState'];
    if (buildingStateRaw != null) {
      try {
        const bs = typeof buildingStateRaw === 'bigint'
          ? buildingStateRaw
          : BigInt(String(buildingStateRaw));
        if (bs > 0n) {
          const rAlive = popcountBig(bs & RADIANT_TOWER_MASK);
          const dAlive = popcountBig(bs & DIRE_TOWER_MASK);
          towerDiffNorm = (rAlive - dAlive) / 11;
          towerDataCount++;
        }
      } catch { /* invalid bigint — skip */ }
    }

    const hasDraftFeat = hasDraft ? 1 : 0;
    if (hasDraftFeat) hasDraftCount++;

    const startTime = toNum(raw['startTime']) ?? nowSec;
    const ageDays = Math.max(0, (nowSec - startTime) / 86_400);
    const recencyDaysNorm = Math.min(1, ageDays / TRAIN_WINDOW_DAYS);

    samples.push({
      features: [
        1,                                        // x0  bias
        (gameTimeSec - 1800) / 1800,              // x1  game_time_norm
        nwNorm,                                   // x2  nw_lead_norm
        killDiffNorm,                             // x3  kill_diff_norm
        logit(prematchProb),                      // x4  prematch_logit
        killPaceNorm,                             // x5  kill_pace_norm
        gamePhase,                                // x6  game_phase
        nwXPhase,                                 // x7  nw_x_phase
        killXPhase,                               // x8  kill_diff_x_phase
        heroAdvantage,                            // x9  hero_advantage
        nwLeadPerMin,                             // x10 nw_lead_per_min
        killRatio,                                // x11 kill_ratio
        eloDiffNorm,                              // x12 elo_diff_norm
        formDiff,                                 // x13 form_diff
        powerSpikeDelta,                          // x14 power_spike_delta
        spikeXNw,                                 // x15 spike_x_nw
        isRealLive,                               // x16 is_real_live
        towerDiffNorm,                            // x17 tower_diff_norm
        hasDraftFeat,                             // x18 has_draft
        recencyDaysNorm,                          // x19 recency_days_norm
      ],
      label: raw['actualRadiantWin'] ? 1 : 0,
      matchId,
      bucket,
      startTime,
    });
  }
  console.log(
    `[train-live-model] new fv8 fields: is_real_live=${isRealLiveCount}/${samples.length} | tower_data=${towerDataCount}/${samples.length} | has_draft=${hasDraftCount}/${samples.length}`,
  );

  console.log(
    `[train-live-model] prematch_logit sources: stored=${storedPrematchCount} elo=${eloPrematchCount} neutral=${unknownPrematchCount}`,
  );
  console.log(
    `[train-live-model] hero_advantage: ${heroAdvCount}/${samples.length + (seenBuckets.size - samples.length)} samples have draft data`,
  );
  console.log(`[train-live-model] After bucket dedup (180s): ${samples.length} examples from ${seenBuckets.size} unique match-buckets`);

  if (samples.length < minSamples) {
    console.error(`[train-live-model] Not enough sampled data (${samples.length} < ${minSamples}).`);
    process.exit(0);
  }

  // B6: Сплит ПО МАТЧАМ, упорядоченным по start_time (chronological), с зазором между train и test.
  // Это закрывает leakage между матчами одной серии (разные карты BO3 идут в одну сторону split'а
  // только если их start_time разделены на TEST_GAP_DAYS).
  const matchTimes = new Map<number, number>();
  for (const s of samples) {
    const cur = matchTimes.get(s.matchId);
    if (cur == null || s.startTime < cur) matchTimes.set(s.matchId, s.startTime);
  }
  const allMatches = Array.from(matchTimes.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
  const trainEnd = Math.floor(allMatches.length * 0.8);
  const calibEnd = Math.floor(allMatches.length * 0.9);
  const trainMatches = new Set(allMatches.slice(0, trainEnd));
  const calibMatches = new Set(allMatches.slice(trainEnd, calibEnd));
  const testMatchesArr = allMatches.slice(calibEnd);

  // Зазор: убрать из train матчи, чьё время в пределах TEST_GAP_DAYS до начала test-периода.
  const testStartTime = testMatchesArr.length > 0 ? matchTimes.get(testMatchesArr[0]!)! : nowSec;
  const gapCutoff = testStartTime - TEST_GAP_DAYS * 86_400;
  let droppedByGap = 0;
  for (const id of Array.from(trainMatches)) {
    const t = matchTimes.get(id)!;
    if (t > gapCutoff) { trainMatches.delete(id); droppedByGap++; }
  }
  for (const id of Array.from(calibMatches)) {
    const t = matchTimes.get(id)!;
    if (t > gapCutoff) { calibMatches.delete(id); droppedByGap++; }
  }
  console.log(
    `[train-live-model] B6 chronological split: gap=${TEST_GAP_DAYS}d, dropped ${droppedByGap} matches near boundary`,
  );

  const rawTrainSamples = samples.filter(s => trainMatches.has(s.matchId));
  const calibSamples    = samples.filter(s => calibMatches.has(s.matchId));
  const testSamples     = samples.filter(s => !trainMatches.has(s.matchId) && !calibMatches.has(s.matchId)
    && !(matchTimes.get(s.matchId)! > gapCutoff && matchTimes.get(s.matchId)! < testStartTime));

  // Балансировка 50/50 в тренировочной выборке (undersample мажоритарного класса)
  // Тест НЕ балансируем — отражает реальное распределение.
  function shuffleArr<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
  const trainPos50 = rawTrainSamples.filter(s => s.label === 1);
  const trainNeg50 = rawTrainSamples.filter(s => s.label === 0);
  const minClass   = Math.min(trainPos50.length, trainNeg50.length);
  const trainSamples = shuffleArr([
    ...shuffleArr(trainPos50).slice(0, minClass),
    ...shuffleArr(trainNeg50).slice(0, minClass),
  ]);

  console.log(
    `[train-live-model] Match split train/calib/test: ${trainMatches.size}/${calibMatches.size}/${allMatches.length - calibEnd}`,
  );
  console.log(
    `[train-live-model] Raw train samples: ${rawTrainSamples.length} → balanced 50/50: ${trainSamples.length} (${minClass} per class, dropped ${rawTrainSamples.length - trainSamples.length})`,
  );
  console.log(
    `[train-live-model] Sample split train(balanced)/calib/test: ${trainSamples.length}/${calibSamples.length}/${testSamples.length}`,
  );

  const testPos  = testSamples.filter(s => s.label === 1).length;
  console.log(
    `[train-live-model] Label distribution: train radiant=50.0% (balanced) | test radiant=${testPos}/${testSamples.length} (${(100 * testPos / testSamples.length).toFixed(1)}%)`,
  );

  if (trainSamples.length < 30 || testSamples.length < 5) {
    console.error('[train-live-model] Too few samples after split.');
    process.exit(0);
  }

  // === LightGBM (Group C: class_weight='balanced') ===
  console.log('[train-live-model] Training LightGBM via ml-service (class_weight=balanced) …');
  const lgbm = await trainLgbm(trainSamples, calibSamples, testSamples);
  if (lgbm) {
    const liftPp = ((lgbm.testAcc - lgbm.baselineAcc) * 100).toFixed(2);
    const liftSign = lgbm.testAcc >= lgbm.baselineAcc ? '+' : '';
    console.log(`[train-live-model] [LGB] TRAIN acc=${(lgbm.trainAcc * 100).toFixed(2)}%`);
    console.log(`[train-live-model] [LGB] TEST  acc=${(lgbm.testAcc * 100).toFixed(2)}%  brier=${lgbm.brier.toFixed(4)}  baseline=${(lgbm.baselineAcc * 100).toFixed(2)}%  lift=${liftSign}${liftPp}pp`);
    const fi = lgbm.featureImportance;
    const sorted = Object.entries(fi).sort((a, b) => b[1] - a[1]);
    console.log('[train-live-model] [LGB] Feature importance:', sorted.map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' '));
  } else {
    console.warn('[train-live-model] LGB skipped — will only save LR fallback');
  }

  // === Logistic Regression (fallback) ===
  console.log('[train-live-model] Training logistic regression (fallback) …');
  const w = trainLogisticRegression([...trainSamples], FEATURE_DIM);
  const trainMetrics = evaluate(trainSamples, w);
  const testMetrics  = evaluate(testSamples, w);
  console.log(`[train-live-model] [LR]  TRAIN acc=${(trainMetrics.acc * 100).toFixed(2)}%  brier=${trainMetrics.brier.toFixed(4)}`);
  console.log(`[train-live-model] [LR]  TEST  acc=${(testMetrics.acc * 100).toFixed(2)}%  brier=${testMetrics.brier.toFixed(4)}`);

  // Baseline: только прематч-вероятность
  let baselineCorrect = 0, baselineBrier = 0;
  for (const s of testSamples) {
    const prematchLogit = s.features[4]!;  // x4 = logit(prematchProb)
    const prematchProb = sigmoid(prematchLogit);
    if ((prematchProb >= 0.5 ? 1 : 0) === s.label) baselineCorrect++;
    baselineBrier += (prematchProb - s.label) ** 2;
  }
  const baselineAcc = baselineCorrect / testSamples.length;
  const baselineBrierAvg = baselineBrier / testSamples.length;
  const lrLift = ((testMetrics.acc - baselineAcc) * 100).toFixed(2);
  const lrLiftSign = testMetrics.acc >= baselineAcc ? '+' : '';
  console.log(`[train-live-model] Baseline (только прематч): acc=${(baselineAcc * 100).toFixed(2)}%  brier=${baselineBrierAvg.toFixed(4)}`);
  console.log(`[train-live-model] [LR]  lift: Δacc=${lrLiftSign}${lrLift}pp  Δbrier=${(baselineBrierAvg - testMetrics.brier).toFixed(4)}`);

  console.log('[train-live-model] [LR]  Weights:',
    FEATURE_NAMES.map((n, i) => `${n}=${w[i]!.toFixed(3)}`).join(' '),
  );

  if (dryRun) {
    console.log('[train-live-model] DRY-RUN — не сохраняем.');
    process.exit(0);
  }

  const versionStem = `live-v${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  const commonMeta = {
    featureNames: FEATURE_NAMES,
    featuresVersion: FEATURES_VERSION,
    baselineAcc,
    baselineBrier: baselineBrierAvg,
    matchesTrain: trainMatches.size,
    matchesCalib: calibMatches.size,
    matchesTest: allMatches.length - calibEnd,
    totalMatches: allMatches.length,
    bucketingSeconds: 180,
    sinceUnix,
    lrLiftAcc: testMetrics.acc - baselineAcc,
    lgbmLiftAcc: lgbm ? lgbm.testAcc - lgbm.baselineAcc : null,
    heroAdvCount,
    heroMatchupPairs: matchupRows.length,
  };

  await db.transaction(async tx => {
    await tx
      .update(modelVersionsTable)
      .set({ isActive: false })
      .where(and(eq(modelVersionsTable.kind, 'live_winner'), eq(modelVersionsTable.isActive, true)));

    const toInsert: (typeof modelVersionsTable.$inferInsert)[] = [];

    // LR fallback — всегда сохраняем
    const weights: Record<string, number> = {};
    FEATURE_NAMES.forEach((n, i) => { weights[`w${i}`] = w[i]!; });
    toInsert.push({
      version: `lr-${versionStem}`,
      kind: 'live_winner',
      featuresVersion: FEATURES_VERSION,
      algorithm: 'logistic_regression_live',
      engine: 'logreg',
      features: FEATURE_NAMES,
      weights,
      trainAccuracy: trainMetrics.acc,
      testAccuracy: testMetrics.acc,
      brierScore: testMetrics.brier,
      trainSampleSize: trainSamples.length,
      testSampleSize: testSamples.length,
      metadata: {
        ...commonMeta,
        logLossTrain: trainMetrics.logLoss,
        logLossTest: testMetrics.logLoss,
        liftAcc: testMetrics.acc - baselineAcc,
        liftBrier: baselineBrierAvg - testMetrics.brier,
        epochs: EPOCHS,
        lrRate: LR_RATE,
        l2: L2,
      },
      isActive: true,
    });

    // LGB primary
    if (lgbm) {
      toInsert.push({
        version: `lgbm-${versionStem}`,
        kind: 'live_winner',
        featuresVersion: FEATURES_VERSION,
        algorithm: 'lightgbm_live',
        engine: 'lightgbm',
        features: FEATURE_NAMES,
        weights: {},
        binaryBlob: Buffer.from(lgbm.blobB64, 'base64'),
        trainAccuracy: lgbm.trainAcc,
        testAccuracy: lgbm.testAcc,
        brierScore: lgbm.brier,
        trainSampleSize: lgbm.trainN,
        testSampleSize: lgbm.testN,
        metadata: {
          ...commonMeta,
          liftAcc: lgbm.testAcc - lgbm.baselineAcc,
          featureImportance: lgbm.featureImportance,
          classWeight: 'balanced',
          numLeaves: 15,
          maxDepth: 4,
          nEstimators: 80,
          minChildSamples: 20,
          regAlpha: 0.5,
          regLambda: 1.0,
        },
        isActive: true,
      });
    }

    await tx.insert(modelVersionsTable).values(toInsert);
  });

  console.log(`[train-live-model] ✅ Saved: lr-${versionStem}${lgbm ? `, lgbm-${versionStem}` : ''}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[train-live-model] FATAL', err);
  process.exit(1);
});
