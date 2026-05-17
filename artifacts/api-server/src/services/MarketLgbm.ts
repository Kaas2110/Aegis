/**
 * Market models inference (Wave 4 — LightGBM via ml-service).
 *
 * Загружает 3 активные модели из `model_versions` (kind ∈
 * market_first_blood | market_total_kills | market_total_duration,
 * engine='lightgbm', is_active=true) и экспонирует async-предикторы.
 *
 * Фичи — те же 5 team-features, что в `scripts/src/train-market-models.ts`
 * (`buildTeamFeatures`):
 *   [bias, elo_diff_norm, winrate_diff, experience_diff, is_high_tier]
 *
 * Для regression моделей ml-service возвращает {mean, std} в log-пространстве
 * (label = log(value)). На выходе делаем exp(mean) и std сохраняем как-есть
 * (это σ log-нормали).
 *
 * Inference:
 *   - 200ms timeout, общий circuit-breaker делит с PredictionModel через
 *     `lightgbmAvailable`/`tripLightgbm` нет — здесь свой локальный, чтобы
 *     не валить prematch при недоступности market-моделей.
 *   - Per-(rId,dId,market) кэш на 60s (одни и те же запросы внутри минуты
 *     повторяются часто — popular-markets + analytics route).
 *   - При любой ошибке возвращаем null → caller использует свой эвристический
 *     fallback.
 */

import { db, modelVersionsTable, teamsTable } from '@workspace/db';
import { eq, and, inArray } from 'drizzle-orm';
import { logger } from '../lib/logger';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
const ML_PREDICT_TIMEOUT_MS = Number(process.env.ML_PREDICT_TIMEOUT_MS ?? 200);
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';

const TEAM_CACHE_TTL_MS = 15 * 60 * 1000;
const PREDICT_CACHE_TTL_MS = 60 * 1000;
const CIRCUIT_BACKOFF_MS = 60_000;

export type MarketKind =
  | 'market_first_blood'
  | 'market_total_kills'
  | 'market_total_duration'
  | 'market_total_duration_q25'
  | 'market_total_duration_q75'
  // T3.5 — live regression: смотрят на текущий снапшот матча, предсказывают
  // финальный total_kills / duration_sec. Используют 7-фичей feature view
  // (см. buildLiveTotalsFeatures ниже + scripts/src/train-live-totals.ts).
  | 'live_total_kills'
  | 'live_total_duration';

const ALL_MARKET_KINDS: MarketKind[] = [
  'market_first_blood',
  'market_total_kills',
  'market_total_duration',
  'market_total_duration_q25',
  'market_total_duration_q75',
  'live_total_kills',
  'live_total_duration',
];

/**
 * T3.5 live totals feature view (v1, 7 фич, OD-only). ОБЯЗАТЕЛЬНО должна
 * быть побайтово идентична `buildLiveTotalsFeatures` в
 * `scripts/src/train-live-totals.ts` — иначе serialized blob будет инферить
 * на «другом» feature view.
 *
 * v2 (DORMANT — Stratz live upstream пуст с 2026-05-16): добавить xpAdvantage_kxp,
 * networthAdvantage_kgold (из live_snapshots.xp_advantage / networth_advantage);
 * сменить kind на live_total_kills_v2 и сделать параллельный retrain без поломки v1.
 * КАК ВКЛЮЧИТЬ: восстановить Stratz enrichment в LiveWorker.ts → накопить ≥7d данных
 * → обновить buildLiveTotalsFeatures здесь И в train-live-totals.ts (обязательно синхронно!).
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
  const buildingNorm = (s.buildingState ?? 4_194_303) / 4_194_304;
  return [1, gameMin, kills, killRate, killDiffAbs, nwLeadKgold, buildingNorm];
}

type TaskType = 'classification' | 'regression' | 'quantile';

interface LoadedMarket {
  kind: MarketKind;
  taskType: TaskType;
  blobB64: string;
  /** Версия модели (modelVersionsTable.version) — пишется в predictions.model_version
   * детерминированно, без отдельного lazy fetch (фикс race из architect-review). */
  version: string;
  loadedAt: number;
}

interface ClassificationResp {
  task_type: 'classification';
  raw_prob: number;
  calibrated_prob: number;
}
interface RegressionResp {
  task_type: 'regression' | 'quantile';
  mean: number;
  std: number;
}
type PredictResp = ClassificationResp | RegressionResp;

let cached: Map<MarketKind, LoadedMarket> = new Map();
let teamRatings: Map<number, { rating: number; wins: number; losses: number }> = new Map();
let lastTeamLoad = 0;

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

/** Загрузить активные market-модели в кеш. Вызывать при старте api-server и после ретрейна. */
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
      // Поддерживаем оба ключа: канонический task_type и legacy taskType.
      const tt = meta['task_type'] ?? meta['taskType'];
      const taskType: TaskType =
        tt === 'regression' ? 'regression'
          : tt === 'quantile' ? 'quantile'
            : 'classification';
      next.set(kind, {
        kind,
        taskType,
        version: r.version,
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

function buildTeamFeatures(rId: number, dId: number): number[] | null {
  const r = teamRatings.get(rId);
  const d = teamRatings.get(dId);
  if (!r || !d) return null;
  const rG = r.wins + r.losses;
  const dG = d.wins + d.losses;
  if (rG < 5 || dG < 5) return null;
  return [
    1,
    (r.rating - d.rating) / 200,
    r.wins / rG - d.wins / dG,
    Math.log(rG + 1) - Math.log(dG + 1),
    rG >= 50 && dG >= 50 ? 1 : 0,
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
    if (data.task_type === 'regression' || data.task_type === 'quantile') {
      if (typeof data.mean !== 'number' || typeof data.std !== 'number') {
        tripCircuit('ml-service bad regression/quantile payload'); return null;
      }
      return { task_type: data.task_type, mean: data.mean, std: data.std };
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
  firstBloodP: number | null;     // P(radiant wins fb-proxy)
  totalKillsLogN: { mean: number; std: number } | null;
  totalDurationLogN: { mean: number; std: number } | null;
  // Квантильные оценки log(duration_sec) — α=0.25 / α=0.75. Используются
  // для непараметрического 50% interval (без допущения о log-нормали)
  // в totals-ladder. Если модели нет в БД — null.
  totalDurationLogQ25: number | null;
  totalDurationLogQ75: number | null;
}
const predictCache: Map<string, CachedPrediction> = new Map();

function cacheKey(rId: number, dId: number): string {
  return `${rId}|${dId}`;
}

/**
 * Возвращает все 3 market-предсказания для пары команд (или null'ы для
 * каждого, если соответствующая модель недоступна или входные фичи
 * недостаточны).
 *
 * Никогда не бросает — fallback'и считают вызывающие.
 */
export async function predictMarketsFor(
  radiantTeamId: number,
  direTeamId: number,
): Promise<CachedPrediction> {
  const empty: CachedPrediction = {
    ts: Date.now(),
    firstBloodP: null,
    totalKillsLogN: null,
    totalDurationLogN: null,
    totalDurationLogQ25: null,
    totalDurationLogQ75: null,
  };
  if (cached.size === 0) return empty;

  const key = cacheKey(radiantTeamId, direTeamId);
  const hit = predictCache.get(key);
  if (hit && Date.now() - hit.ts < PREDICT_CACHE_TTL_MS) return hit;

  await refreshTeams();
  const features = buildTeamFeatures(radiantTeamId, direTeamId);
  if (!features) {
    predictCache.set(key, empty);
    return empty;
  }

  const fb = cached.get('market_first_blood');
  const tk = cached.get('market_total_kills');
  const td = cached.get('market_total_duration');
  const tdQ25 = cached.get('market_total_duration_q25');
  const tdQ75 = cached.get('market_total_duration_q75');

  const [fbR, tkR, tdR, tdQ25R, tdQ75R] = await Promise.all([
    fb ? callMlPredict(fb.blobB64, features) : Promise.resolve(null),
    tk ? callMlPredict(tk.blobB64, features) : Promise.resolve(null),
    td ? callMlPredict(td.blobB64, features) : Promise.resolve(null),
    tdQ25 ? callMlPredict(tdQ25.blobB64, features) : Promise.resolve(null),
    tdQ75 ? callMlPredict(tdQ75.blobB64, features) : Promise.resolve(null),
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
    totalDurationLogQ25: tdQ25R && tdQ25R.task_type === 'quantile' ? tdQ25R.mean : null,
    totalDurationLogQ75: tdQ75R && tdQ75R.task_type === 'quantile' ? tdQ75R.mean : null,
  };
  predictCache.set(key, out);
  return out;
}

/**
 * Стандартное normal-CDF приближение через erf (Abramowitz & Stegun 7.1.26).
 * Используется для конвертации (mean, std) log-нормали в P(value > line)
 * через Φ((log(line) − mean) / std).
 */
function normCdf(z: number): number {
  // erf approximation
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  const erf = sign * y;
  return 0.5 * (1 + erf);
}

/** P(exp(N(mean,std)) > line). std — sigma в log-пространстве. */
export function probLogNormalOver(line: number, logMean: number, logStd: number): number {
  if (line <= 0) return 1;
  const z = (Math.log(line) - logMean) / Math.max(1e-3, logStd);
  return 1 - normCdf(z);
}

/** Diagnostics — для admin /models endpoint. */
export function getActiveMarketModelInfo(): Array<{ kind: MarketKind; taskType: string; loadedAt: number }> {
  return Array.from(cached.values()).map(m => ({
    kind: m.kind,
    taskType: m.taskType,
    loadedAt: m.loadedAt,
  }));
}

/**
 * T3.5 — live totals inference. Принимает текущий снапшот матча и возвращает
 * (mean, std) в log-пространстве для финального total_kills и duration_sec.
 * Caller должен делать exp(mean) чтобы получить point estimate, и использовать
 * std для непараметрической ladder/probability.
 *
 * Возвращает null'ы если модели не загружены или ml-service недоступен.
 * Cache не используется (снапшот меняется каждые 60s, key взрывается).
 */
export interface LiveTotalsPrediction {
  totalKillsLogN: { mean: number; std: number } | null;
  totalDurationLogN: { mean: number; std: number } | null;
  modelVersions: { kills: string | null; duration: string | null };
}

export async function predictLiveTotalsFor(snapshot: {
  gameTimeSec: number;
  radiantScore: number | null;
  direScore: number | null;
  radiantLead: number | null;
  buildingState: number | null;
}): Promise<LiveTotalsPrediction> {
  const lk = cached.get('live_total_kills');
  const ld = cached.get('live_total_duration');
  const modelVersions = {
    kills: lk?.version ?? null,
    duration: ld?.version ?? null,
  };
  const empty: LiveTotalsPrediction = {
    totalKillsLogN: null,
    totalDurationLogN: null,
    modelVersions,
  };
  if (cached.size === 0) return empty;
  if (snapshot.gameTimeSec < 60) return empty; // pre-laning, фичи бессмысленны
  if (!lk && !ld) return empty;

  const features = buildLiveTotalsFeatures(snapshot);
  const [lkR, ldR] = await Promise.all([
    lk ? callMlPredict(lk.blobB64, features) : Promise.resolve(null),
    ld ? callMlPredict(ld.blobB64, features) : Promise.resolve(null),
  ]);

  return {
    totalKillsLogN: lkR && lkR.task_type === 'regression'
      ? { mean: lkR.mean, std: Math.max(1e-3, lkR.std) } : null,
    totalDurationLogN: ldR && ldR.task_type === 'regression'
      ? { mean: ldR.mean, std: Math.max(1e-3, ldR.std) } : null,
    modelVersions,
  };
}
