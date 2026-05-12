/**
 * Market models inference (Wave 4 — LightGBM via ml-service).
 *
 * v2 фичи (11): bias, elo_diff_norm, winrate_diff, experience_diff,
 * is_high_tier, avg_kills_r, avg_kills_d, avg_dur_h_r, avg_dur_h_d,
 * patch_kpm, format_norm.
 *
 * Форма команд (avgKillsFor / avgDurationSec 30d) + patch_kpm кэшируются
 * с 1h TTL. При отсутствии данных — глобальные медианы.
 *
 * Inference:
 *   - 200ms timeout, свой circuit-breaker (не трогает prematch_winner).
 *   - Per-(rId, dId, market) кэш на 60s.
 *   - При любой ошибке → null, caller использует эвристический fallback.
 */

import { db, modelVersionsTable, teamsTable, teamRecentFormTable, proMatchesTable } from '@workspace/db';
import { eq, and, inArray, gte } from 'drizzle-orm';
import { logger } from '../lib/logger';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_PREDICT_TIMEOUT_MS = Number(process.env.ML_PREDICT_TIMEOUT_MS ?? 200);
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';

const TEAM_CACHE_TTL_MS = 15 * 60 * 1000;   // 15 min
const FORM_CACHE_TTL_MS = 60 * 60 * 1000;   // 1h
const PREDICT_CACHE_TTL_MS = 60 * 1000;      // 1 min
const CIRCUIT_BACKOFF_MS = 60_000;

// Нормализационные константы
const GLOBAL_AVG_KILLS = 52;
const GLOBAL_AVG_DUR_SEC = 2200;
const GLOBAL_KPM = 1.1;

export type MarketKind =
  | 'market_first_blood'
  | 'market_total_kills'
  | 'market_total_duration';

const ALL_MARKET_KINDS: MarketKind[] = [
  'market_first_blood',
  'market_total_kills',
  'market_total_duration',
];

interface LoadedMarket {
  kind: MarketKind;
  taskType: 'classification' | 'regression';
  blobB64: string;
  loadedAt: number;
}

interface ClassificationResp {
  task_type: 'classification';
  raw_prob: number;
  calibrated_prob: number;
}
interface RegressionResp {
  task_type: 'regression';
  mean: number;
  std: number;
}
type PredictResp = ClassificationResp | RegressionResp;

let cached: Map<MarketKind, LoadedMarket> = new Map();
let teamRatings: Map<number, { rating: number; wins: number; losses: number }> = new Map();
let lastTeamLoad = 0;

// Форма команд (30d snapshot)
interface TeamForm { avgKillsFor: number; avgDurationSec: number; }
let teamForm: Map<number, TeamForm> = new Map();
let lastFormLoad = 0;

// Patch KPM (глобальный темп убийств за 30 дней)
let patchKpm = GLOBAL_KPM;
let lastKpmLoad = 0;

let circuitOpen = false;
let circuitOpenUntil = 0;

let _cachedToken: string | null = null;
function mlServiceToken(): string | null {
  if (_cachedToken) return _cachedToken;
  const env = (process.env.ML_SERVICE_TOKEN ?? '').trim();
  if (env) { _cachedToken = env; return env; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const v = fs.readFileSync(ML_TOKEN_FILE, 'utf8').trim();
    if (v) { _cachedToken = v; return v; }
  } catch { /* not yet written */ }
  return null;
}

function circuitAvailable(): boolean {
  if (!circuitOpen) return true;
  if (Date.now() >= circuitOpenUntil) {
    circuitOpen = false;
    return true;
  }
  return false;
}

function tripCircuit(reason: string): void {
  if (!circuitOpen) {
    logger.warn({ reason }, '[MarketLgbm] tripping market circuit-breaker');
  }
  circuitOpen = true;
  circuitOpenUntil = Date.now() + CIRCUIT_BACKOFF_MS;
}

/** Загрузить активные market-модели в кеш. */
export async function loadActiveMarketModels(): Promise<number> {
  try {
    const rows = await db
      .select()
      .from(modelVersionsTable)
      .where(
        and(
          inArray(modelVersionsTable.kind, ALL_MARKET_KINDS),
          eq(modelVersionsTable.engine, 'lightgbm'),
          eq(modelVersionsTable.isActive, true),
        ),
      );
    const next = new Map<MarketKind, LoadedMarket>();
    for (const r of rows) {
      const kind = r.kind as MarketKind;
      if (!ALL_MARKET_KINDS.includes(kind)) continue;
      const blob = r.binaryBlob as Buffer | Uint8Array | null;
      if (!blob) continue;
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const tt = meta['task_type'] ?? meta['taskType'];
      const taskType: 'classification' | 'regression' =
        tt === 'regression' ? 'regression' : 'classification';
      next.set(kind, {
        kind,
        taskType,
        blobB64: Buffer.isBuffer(blob) ? blob.toString('base64') : Buffer.from(blob).toString('base64'),
        loadedAt: Date.now(),
      });
    }
    cached = next;
    predictCache.clear();
    logger.info({ loaded: Array.from(next.keys()) }, '[MarketLgbm] active market models loaded');
    return next.size;
  } catch (err) {
    logger.error({ err }, '[MarketLgbm] failed to load active market models');
    return 0;
  }
}

async function refreshTeams(): Promise<void> {
  if (Date.now() - lastTeamLoad < TEAM_CACHE_TTL_MS && teamRatings.size > 0) return;
  try {
    const rows = await db
      .select({
        teamId: teamsTable.teamId,
        rating: teamsTable.rating,
        wins: teamsTable.wins,
        losses: teamsTable.losses,
      })
      .from(teamsTable);
    const next = new Map<number, { rating: number; wins: number; losses: number }>();
    for (const t of rows) {
      if (t.rating != null) {
        next.set(t.teamId, { rating: t.rating, wins: t.wins ?? 0, losses: t.losses ?? 0 });
      }
    }
    teamRatings = next;
    lastTeamLoad = Date.now();
  } catch (err) {
    logger.error({ err }, '[MarketLgbm] failed to load team ratings');
  }
}

async function refreshForm(): Promise<void> {
  if (Date.now() - lastFormLoad < FORM_CACHE_TTL_MS && teamForm.size > 0) return;
  try {
    const rows = await db
      .select({
        teamId: teamRecentFormTable.teamId,
        avgKillsFor: teamRecentFormTable.avgKillsFor,
        avgDurationSec: teamRecentFormTable.avgDurationSec,
      })
      .from(teamRecentFormTable)
      .where(eq(teamRecentFormTable.periodDays, 30));

    const next = new Map<number, TeamForm>();
    for (const r of rows) {
      next.set(r.teamId, {
        avgKillsFor: r.avgKillsFor ?? GLOBAL_AVG_KILLS,
        avgDurationSec: r.avgDurationSec ?? GLOBAL_AVG_DUR_SEC,
      });
    }
    teamForm = next;
    lastFormLoad = Date.now();
    logger.debug({ count: next.size }, '[MarketLgbm] team form refreshed');
  } catch (err) {
    logger.error({ err }, '[MarketLgbm] failed to load team form');
  }
}

async function refreshPatchKpm(): Promise<void> {
  if (Date.now() - lastKpmLoad < FORM_CACHE_TTL_MS) return;
  try {
    const since = Math.floor(Date.now() / 1000) - 30 * 86_400;
    const rows = await db
      .select({
        radiantScore: proMatchesTable.radiantScore,
        direScore: proMatchesTable.direScore,
        duration: proMatchesTable.duration,
      })
      .from(proMatchesTable)
      .where(gte(proMatchesTable.startTime, since));

    let totalKills = 0; let totalMin = 0;
    for (const r of rows) {
      const kills = (r.radiantScore ?? 0) + (r.direScore ?? 0);
      const dur = r.duration ?? 0;
      if (kills > 0 && dur > 0) { totalKills += kills; totalMin += dur / 60; }
    }
    if (totalMin > 0 && rows.length >= 10) {
      patchKpm = totalKills / totalMin;
    }
    lastKpmLoad = Date.now();
    logger.debug({ patchKpm, n: rows.length }, '[MarketLgbm] patch KPM refreshed');
  } catch (err) {
    logger.error({ err }, '[MarketLgbm] failed to compute patch KPM');
  }
}

/**
 * Строит вектор из 11 фич для market-моделей v2.
 * formatNorm: 0.0=BO1, 0.5=BO3, 1.0=BO5 (по умолчанию 0.5).
 */
function buildTeamFeatures(rId: number, dId: number, formatNorm = 0.5): number[] | null {
  const r = teamRatings.get(rId);
  const d = teamRatings.get(dId);
  if (!r || !d) return null;
  const rG = r.wins + r.losses;
  const dG = d.wins + d.losses;
  if (rG < 5 || dG < 5) return null;

  const rf = teamForm.get(rId);
  const df = teamForm.get(dId);

  return [
    1,                                                          // bias
    (r.rating - d.rating) / 200,                               // elo_diff_norm
    r.wins / rG - d.wins / dG,                                 // winrate_diff
    Math.log(rG + 1) - Math.log(dG + 1),                      // experience_diff
    rG >= 50 && dG >= 50 ? 1 : 0,                             // is_high_tier
    (rf?.avgKillsFor ?? GLOBAL_AVG_KILLS) / 60,                // avg_kills_r
    (df?.avgKillsFor ?? GLOBAL_AVG_KILLS) / 60,                // avg_kills_d
    (rf?.avgDurationSec ?? GLOBAL_AVG_DUR_SEC) / 3600,         // avg_dur_h_r
    (df?.avgDurationSec ?? GLOBAL_AVG_DUR_SEC) / 3600,         // avg_dur_h_d
    patchKpm,                                                   // patch_kpm
    formatNorm,                                                 // format_norm
  ];
}

async function callMlPredict(blobB64: string, features: number[]): Promise<PredictResp | null> {
  if (!circuitAvailable()) return null;
  const token = mlServiceToken();
  if (!token) {
    tripCircuit('no ML_SERVICE_TOKEN');
    return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ML_PREDICT_TIMEOUT_MS);
  try {
    const res = await fetch(`${ML_SERVICE_URL}/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ml-token': token },
      body: JSON.stringify({ blob_b64: blobB64, features }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      tripCircuit(`ml-service ${res.status}: ${body.slice(0, 120)}`);
      return null;
    }
    const data = (await res.json()) as {
      task_type?: string;
      raw_prob?: number;
      calibrated_prob?: number;
      mean?: number;
      std?: number;
    };
    if (data.task_type === 'regression') {
      if (typeof data.mean !== 'number' || typeof data.std !== 'number') {
        tripCircuit('ml-service bad regression payload'); return null;
      }
      return { task_type: 'regression', mean: data.mean, std: data.std };
    }
    if (typeof data.calibrated_prob !== 'number') {
      tripCircuit('ml-service bad classification payload'); return null;
    }
    return {
      task_type: 'classification',
      raw_prob: typeof data.raw_prob === 'number' ? data.raw_prob : data.calibrated_prob,
      calibrated_prob: data.calibrated_prob,
    };
  } catch (e) {
    const reason = (e as Error).name === 'AbortError'
      ? `timeout ${ML_PREDICT_TIMEOUT_MS}ms`
      : (e as Error).message;
    tripCircuit(reason);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface CachedPrediction {
  ts: number;
  firstBloodP: number | null;
  totalKillsLogN: { mean: number; std: number } | null;
  totalDurationLogN: { mean: number; std: number } | null;
}
const predictCache: Map<string, CachedPrediction> = new Map();

function cacheKey(rId: number, dId: number, fmt: number): string {
  return `${rId}|${dId}|${fmt.toFixed(2)}`;
}

/**
 * Возвращает все 3 market-предсказания для пары команд.
 * formatNorm: 0=BO1, 0.5=BO3, 1.0=BO5 (по умолчанию 0.5 = BO3).
 * Никогда не бросает.
 */
export async function predictMarketsFor(
  radiantTeamId: number,
  direTeamId: number,
  formatNorm = 0.5,
): Promise<CachedPrediction> {
  const empty: CachedPrediction = {
    ts: Date.now(),
    firstBloodP: null,
    totalKillsLogN: null,
    totalDurationLogN: null,
  };
  if (cached.size === 0) return empty;

  const key = cacheKey(radiantTeamId, direTeamId, formatNorm);
  const hit = predictCache.get(key);
  if (hit && Date.now() - hit.ts < PREDICT_CACHE_TTL_MS) return hit;

  // Обновляем кэши параллельно
  await Promise.all([refreshTeams(), refreshForm(), refreshPatchKpm()]);

  const features = buildTeamFeatures(radiantTeamId, direTeamId, formatNorm);
  if (!features) {
    predictCache.set(key, empty);
    return empty;
  }

  const fb = cached.get('market_first_blood');
  const tk = cached.get('market_total_kills');
  const td = cached.get('market_total_duration');

  const [fbR, tkR, tdR] = await Promise.all([
    fb ? callMlPredict(fb.blobB64, features) : Promise.resolve(null),
    tk ? callMlPredict(tk.blobB64, features) : Promise.resolve(null),
    td ? callMlPredict(td.blobB64, features) : Promise.resolve(null),
  ]);

  const out: CachedPrediction = {
    ts: Date.now(),
    firstBloodP: fbR && fbR.task_type === 'classification' ? fbR.calibrated_prob : null,
    totalKillsLogN: tkR && tkR.task_type === 'regression'
      ? { mean: tkR.mean, std: Math.max(1e-3, tkR.std) }
      : null,
    totalDurationLogN: tdR && tdR.task_type === 'regression'
      ? { mean: tdR.mean, std: Math.max(1e-3, tdR.std) }
      : null,
  };
  predictCache.set(key, out);
  return out;
}

/**
 * Стандартное normal-CDF приближение (Abramowitz & Stegun 7.1.26).
 * P(value > line) для log-нормали: Φ((log(line) − mean) / std).
 */
function normCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  const erf = sign * y;
  return 0.5 * (1 + erf);
}

export function probLogNormalOver(line: number, logMean: number, logStd: number): number {
  if (line <= 0) return 1;
  const z = (Math.log(line) - logMean) / logStd;
  return 1 - normCdf(z);
}

/** Инвалидировать predict-кэш (после ретрейна). */
export function invalidatePredictCache(): void {
  predictCache.clear();
  teamForm.clear();
  lastFormLoad = 0;
  lastKpmLoad = 0;
  _cachedToken = null;
}
