import {eligibleTotalsModel} from './TotalsModelPolicy';
import { parseMarketPredictionPayload } from './MarketPredictionPayload';
import {absentLiveTotalsModelReason,liveTotalsInputRefusal,type LiveTotalsRefusal,type LiveTotalsSnapshot} from './LiveTotalsDiagnostics';
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
 *   - 1500ms timeout (F9 Phase 9, поднят с 200ms из-за конфликта totals-ladder
 *     × LiveWorker). Локальный circuit-breaker (НЕ общий с PredictionModel) —
 *     trip только на сетевых/5xx/bad-payload, timeout retryable без trip'а.
 *   - Per-(rId,dId,market) кэш на 60s (одни и те же запросы внутри минуты
 *     повторяются часто — popular-markets + analytics route).
 *   - При ошибке возвращаем null: public serving показывает недоступность.
 */

import { db, modelVersionsTable, teamsTable } from '@workspace/db';
import { eq, and, inArray } from 'drizzle-orm';
import { logger } from '../lib/logger';
import {
  loadTeamRostersMap, loadTeamHeroPoolMap, loadHeroBenchmarksMap,
  loadHeroItemPopularityMap, loadPlayerTotalsMap, loadPlayerCountsMap,
  loadPlayerWlProMap,
  buildE1KillsFeatures, buildE1DurationFeatures,
  buildE1LiveTotalsFeatures,
  type TeamRostersMap, type TeamHeroPoolMap, type HeroBenchmarksMap,
  type HeroItemPopularityMap, type PlayerTotalsMap, type PlayerCountsMap,
  type PlayerWlProMap,
} from '../lib/e1-features';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? 'http://localhost:8090';
// F9 (Phase 9): timeout поднят с 200 → 1500ms. 200ms систематически не успевал,
// когда totals-ladder (5 parallel /predict) пересекался с тиком LiveWorker
// (~43 predict-вызовов/poll). Каждый AbortError раньше открывал circuit на 60s,
// что давало пользователю «модель не отвечает» в течение минуты подряд.
const ML_PREDICT_TIMEOUT_MS = Number(process.env.ML_PREDICT_TIMEOUT_MS ?? 1500);
const ML_TOKEN_FILE = '/tmp/aegis_ml_token';

const TEAM_CACHE_TTL_MS = 15 * 60 * 1000;
const E1_CACHE_TTL_MS = 15 * 60 * 1000;
const PREDICT_CACHE_TTL_MS = 60 * 1000;
const CIRCUIT_BACKOFF_MS = 60_000;

export type MarketKind =
  | 'market_first_blood'
  | 'market_total_kills'
  | 'market_total_duration'
  | 'market_total_duration_q25'
  | 'market_total_duration_q75'
  // 3-tier (pure → with_draft → live). Когда caller передаёт picks И
  // соответствующая _with_draft модель загружена, используем её; иначе fallback
  // на pure-вариант (team-only features). Tier'ы тренируются отдельно через
  // train-market-models --market <name>_with_draft.
  | 'market_first_blood_with_draft'
  | 'market_total_kills_with_draft'
  | 'market_total_duration_with_draft'
  | 'market_total_duration_q25_with_draft'
  | 'market_total_duration_q75_with_draft'
  // T3.5 — live regression: смотрят на текущий снапшот матча, предсказывают
  // финальный total_kills / duration_sec. Используют 7-фичей feature view
  // (см. buildLiveTotalsFeatures ниже + scripts/src/train-live-totals.ts).
  | 'live_total_kills'
  | 'live_total_duration'
  // Live + draft (фичи 13: snapshot7 + team4 + e1_live2). Активируется когда
  // picks известны (OpenDota /api/live раскрыл драфт) И модель загружена.
  | 'live_total_kills_with_draft'
  | 'live_total_duration_with_draft';

const ALL_MARKET_KINDS: MarketKind[] = [
  'market_first_blood',
  'market_total_kills',
  'market_total_duration',
  'market_total_duration_q25',
  'market_total_duration_q75',
  'market_first_blood_with_draft',
  'market_total_kills_with_draft',
  'market_total_duration_with_draft',
  'market_total_duration_q25_with_draft',
  'market_total_duration_q75_with_draft',
  'live_total_kills',
  'live_total_duration',
  'live_total_kills_with_draft',
  'live_total_duration_with_draft',
];

const WITH_DRAFT_KINDS: ReadonlySet<MarketKind> = new Set<MarketKind>([
  'market_first_blood_with_draft',
  'market_total_kills_with_draft',
  'market_total_duration_with_draft',
  'market_total_duration_q25_with_draft',
  'market_total_duration_q75_with_draft',
  'live_total_kills_with_draft',
  'live_total_duration_with_draft',
]);

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

import {evidenceHash, predictionEvidence, type PredictionEvidence} from '../lib/predictionEvidence';

interface LoadedMarket {
  artifactHash: string;
  featureNames: string[];
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
let registryEpoch=0;
let modelRefusals=new Map<MarketKind,LiveTotalsRefusal|null>(ALL_MARKET_KINDS.map(k=>[k,'totals_model_registry_not_loaded']));
export function getMarketModelRevision(): string {
  return [...cached.values()].map(m => `${m.kind}:${m.version}`).sort().join('|');
}
export function isActiveMarketVersion(version: string, market?: string): boolean {
  return [...cached.values()].some(m => m.version === version && (!market || m.kind === market || m.kind === market + '_with_draft'));
}
let teamRatings: Map<number, { rating: number; wins: number; losses: number }> = new Map();
let lastTeamLoad = 0;

// E1 maps — загружаются лениво ТОЛЬКО если есть хотя бы одна _with_draft модель.
// Иначе нет смысла тащить десятки тысяч строк в RAM.
interface E1Maps {
  rosters: TeamRostersMap;
  pool: TeamHeroPoolMap;
  benchmarks: HeroBenchmarksMap;
  itemPop: HeroItemPopularityMap;
  totals: PlayerTotalsMap;
  counts: PlayerCountsMap;
  wlPro: PlayerWlProMap;
}
let e1Maps: E1Maps | null = null;
let lastE1Load = 0;
let e1LoadInFlight: Promise<E1Maps> | null = null;

async function refreshE1Maps(): Promise<E1Maps | null> {
  // Нужны ли E1 фичи вообще?
  let hasWithDraft = false;
  for (const k of cached.keys()) {
    if (WITH_DRAFT_KINDS.has(k)) { hasWithDraft = true; break; }
  }
  if (!hasWithDraft) return null;

  if (e1Maps && Date.now() - lastE1Load < E1_CACHE_TTL_MS) return e1Maps;
  if (e1LoadInFlight) return e1LoadInFlight;

  e1LoadInFlight = (async () => {
    const [rosters, pool, benchmarks, itemPop, totals, counts, wlPro] = await Promise.all([
      loadTeamRostersMap(),
      loadTeamHeroPoolMap(),
      loadHeroBenchmarksMap(),
      loadHeroItemPopularityMap(),
      loadPlayerTotalsMap({ fields: ['gold_per_min', 'xp_per_min', 'kills', 'assists', 'deaths'] }),
      loadPlayerCountsMap(),
      loadPlayerWlProMap(),
    ]);
    e1Maps = { rosters, pool, benchmarks, itemPop, totals, counts, wlPro };
    lastE1Load = Date.now();
    logger.info({
      rosters: rosters.size, pool: pool.size, benchmarks: benchmarks.size,
      itemPop: itemPop.size, totals: totals.size, counts: counts.size, wlPro: wlPro.size,
    }, '[MarketLgbm] E1 maps refreshed');
    return e1Maps;
  })();
  try { return await e1LoadInFlight; }
  finally { e1LoadInFlight = null; }
}

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
  const epoch=++registryEpoch;
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
    const nextRefusals=new Map<MarketKind,LiveTotalsRefusal|null>(ALL_MARKET_KINDS.map(k=>[k,'totals_no_active_lightgbm_model']));
    for (const r of rows) {
      const kind = r.kind as MarketKind;
      if (!ALL_MARKET_KINDS.includes(kind)) continue;
      const blob = r.binaryBlob as Buffer | Uint8Array | null;
      if (!blob || blob.byteLength===0) {nextRefusals.set(kind,'totals_artifact_missing');continue;}
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      if (!eligibleTotalsModel(kind,meta)) {nextRefusals.set(kind,'totals_validation_gate_rejected');logger.warn({kind,version:r.version}, '[MarketLgbm] totals withheld pending validated distribution contract');continue;}
      // Поддерживаем оба ключа: канонический task_type и legacy taskType.
      const tt = meta['task_type'] ?? meta['taskType'];
      const taskType: TaskType =
        tt === 'regression' ? 'regression'
          : tt === 'quantile' ? 'quantile'
            : 'classification';
      next.set(kind, {
        kind,
        taskType,
        artifactHash: evidenceHash({blobB64: Buffer.from(r.binaryBlob!).toString('base64'), features:r.features}),
        featureNames: r.features,
        version: r.version,
        blobB64: Buffer.isBuffer(blob) ? blob.toString('base64') : Buffer.from(blob).toString('base64'),
        loadedAt: Date.now(),
      });
      nextRefusals.set(kind,null);
    }
    // A slower preceding reload must not resurrect a version withdrawn by the latest reload.
    if(epoch!==registryEpoch) return cached.size;
    cached = next;
    modelRefusals=nextRefusals;
    predictCache.clear();
    logger.info({ loaded: Array.from(next.keys()) }, '[MarketLgbm] active market models loaded');
    return next.size;
  } catch (err) {
    if(epoch!==registryEpoch) return cached.size;
    // Fail closed: neither the cache nor diagnostics may pretend a failed registry refresh succeeded.
    cached=new Map();
    modelRefusals=new Map(ALL_MARKET_KINDS.map(k=>[k,'totals_model_registry_unavailable']));
    predictCache.clear();
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
  // F9 (Phase 9): порог снижен с 5 до 3 игр. На <3 играх winrate-фича чистый шум,
  // но elo-разница и сама шкала log(g+1) остаются информативными. Это вытаскивает
  // tier-3 пары из вечного "unavailable" в UI без существенной потери качества
  // (модель обучалась на >=5 игр, но фичи graceful degrade).
  if (rG < 3 || dG < 3) return null;
  return [
    1,
    (r.rating - d.rating) / 200,
    r.wins / rG - d.wins / dG,
    Math.log(rG + 1) - Math.log(dG + 1),
    rG >= 50 && dG >= 50 ? 1 : 0,
  ];
}

/**
 * F9: диагностика, почему `predictMarketsFor` мог вернуть null —
 * для построения честного `unavailableReason` в API. Не вызывает refreshTeams,
 * читает из in-memory кеша (totals-ladder уже вызвал predictMarketsFor → кеш свежий).
 */
export function teamRatingDiag(rId: number, dId: number): {
  radiantRating: number | null;
  direRating: number | null;
  radiantGames: number;
  direGames: number;
  modelsLoaded: number;
} {
  const r = teamRatings.get(rId);
  const d = teamRatings.get(dId);
  return {
    radiantRating: r?.rating ?? null,
    direRating: d?.rating ?? null,
    radiantGames: r ? r.wins + r.losses : 0,
    direGames: d ? d.wins + d.losses : 0,
    modelsLoaded: cached.size,
  };
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
    // Missing residual dispersion disables this model, not every market's circuit.
    return parseMarketPredictionPayload(await res.json());
  } catch (e) {
    // F9 (Phase 9): timeout НЕ открывает circuit. Это retryable single-request
    // failure (часто ловится при пересечении totals-ladder с тиком LiveWorker),
    // а circuit — про устойчивую недоступность ml-service. Раньше один timeout
    // отрубал ВСЕ market predictions на 60s. Сетевые/connect ошибки по-прежнему trip.
    if ((e as Error).name === 'AbortError') {
      logger.debug({ timeoutMs: ML_PREDICT_TIMEOUT_MS }, '[MarketLgbm] /predict timeout (no trip)');
      return null;
    }
    tripCircuit((e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface CachedPrediction {
  ts: number;
  versions: {totalKills: string | null; totalDuration: string | null};
  firstBloodP: number | null;     // Disabled until first-blood labels are validated.
  totalKillsLogN: { mean: number; std: number } | null;
  totalDurationLogN: { mean: number; std: number } | null;
  // Квантильные оценки log(duration_sec) — α=0.25 / α=0.75. Используются
  // для непараметрического 50% interval (без допущения о log-нормали)
  // в totals-ladder. Если модели нет в БД — null.
  totalDurationLogQ25: number | null;
  totalDurationLogQ75: number | null;
  // Какой tier реально использовался для каждого маркета: 'with_draft' (E1)
  // или 'pure' (team-only). null если модель не сработала.
  tier: {
    firstBlood: 'pure' | 'with_draft' | null;
    totalKills: 'pure' | 'with_draft' | null;
    totalDuration: 'pure' | 'with_draft' | null;
    totalDurationQ25: 'pure' | 'with_draft' | null;
    totalDurationQ75: 'pure' | 'with_draft' | null;
  };
}
const predictCache: Map<string, CachedPrediction> = new Map();

function cacheKey(rId: number, dId: number, draftHint?: DraftHint): string {
  if (!draftHint) return `${rId}|${dId}|nodraft`;
  // Sort picks для стабильного fingerprint при том же составе.
  const r = [...draftHint.radiantPicks].sort((a, b) => a - b).join(',');
  const d = [...draftHint.direPicks].sort((a, b) => a - b).join(',');
  return `${rId}|${dId}|${r}|${d}`;
}

/** Draft hint, общий для prematch markets и live totals. */
export interface DraftHint {
  radiantPicks: number[];
  direPicks: number[];
}

function emptyTier(): CachedPrediction['tier'] {
  return {
    firstBlood: null,
    totalKills: null,
    totalDuration: null,
    totalDurationQ25: null,
    totalDurationQ75: null,
  };
}

/**
 * Каскад per-market: пробуем with_draft если есть picks И модель загружена,
 * иначе pure. Возвращает (response, kind, tier) или null.
 */
async function predictMarketCascade(
  pureKind: MarketKind,
  withDraftKind: MarketKind,
  pureFeatures: number[],
  withDraftFeatures: number[] | null,
): Promise<{ resp: PredictResp; tier: 'pure' | 'with_draft'; version: string } | null> {
  if (withDraftFeatures) {
    const wd = cached.get(withDraftKind);
    if (wd) {
      const r = await callMlPredict(wd.blobB64, withDraftFeatures);
      if (r) return { resp: r, tier: 'with_draft', version: wd.version };
    }
  }
  const pure = cached.get(pureKind);
  if (!pure) return null;
  const r = await callMlPredict(pure.blobB64, pureFeatures);
  if (!r) return null;
  return { resp: r, tier: 'pure', version: pure.version };
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
  draftHint?: DraftHint,
): Promise<CachedPrediction> {
  const empty: CachedPrediction = {
    ts: Date.now(),
    versions: {totalKills: null, totalDuration: null},
    firstBloodP: null,
    totalKillsLogN: null,
    totalDurationLogN: null,
    totalDurationLogQ25: null,
    totalDurationLogQ75: null,
    tier: emptyTier(),
  };
  if (cached.size === 0) return empty;

  // Валидируем picks: должно быть ровно 5+5 уникальных. Иначе draftHint не пригоден.
  const hasValidDraft = !!draftHint
    && draftHint.radiantPicks.length === 5 && draftHint.direPicks.length === 5
    && new Set(draftHint.radiantPicks).size === 5 && new Set(draftHint.direPicks).size === 5;
  const dh = hasValidDraft ? draftHint! : undefined;

  const key = cacheKey(radiantTeamId, direTeamId, dh);
  const hit = predictCache.get(key);
  if (hit && Date.now() - hit.ts < PREDICT_CACHE_TTL_MS) return hit;

  await refreshTeams();
  const teamFeats = buildTeamFeatures(radiantTeamId, direTeamId);
  if (!teamFeats) {
    predictCache.set(key, empty);
    return empty;
  }

  // E1 фичи для with_draft tier'а. Если e1Maps не нужны (нет _with_draft моделей)
  // или ни одного hero pick нет — wdFeats остаётся null и каскад уйдёт в pure.
  let wdKills: number[] | null = null;
  let wdDur: number[] | null = null;
  if (dh) {
    const e1 = await refreshE1Maps();
    if (e1) {
      const e1Kills = buildE1KillsFeatures({
        radiantPicks: dh.radiantPicks, direPicks: dh.direPicks, benchmarks: e1.benchmarks,
      });
      const e1Dur = buildE1DurationFeatures({
        radiantPicks: dh.radiantPicks, direPicks: dh.direPicks, itemPop: e1.itemPop,
      });
      wdKills = [...teamFeats, ...e1Kills];
      wdDur = [...teamFeats, ...e1Dur];
    }
  }

  // FB bundles remain loaded for comparison, but their invalid target is never called.
  const [tkR, tdR, tdQ25R, tdQ75R] = await Promise.all([
    predictMarketCascade('market_total_kills', 'market_total_kills_with_draft', teamFeats, wdKills),
    predictMarketCascade('market_total_duration', 'market_total_duration_with_draft', teamFeats, wdDur),
    predictMarketCascade('market_total_duration_q25', 'market_total_duration_q25_with_draft', teamFeats, wdDur),
    predictMarketCascade('market_total_duration_q75', 'market_total_duration_q75_with_draft', teamFeats, wdDur),
  ]);

  const out: CachedPrediction = {
    ts: Date.now(),
    versions: {totalKills: tkR?.version ?? null, totalDuration: tdR?.version ?? null},
    firstBloodP: null,
    totalKillsLogN: tkR && tkR.resp.task_type === 'regression'
      ? { mean: tkR.resp.mean, std: Math.max(1e-3, tkR.resp.std) }
      : null,
    totalDurationLogN: tdR && tdR.resp.task_type === 'regression'
      ? { mean: tdR.resp.mean, std: Math.max(1e-3, tdR.resp.std) }
      : null,
    totalDurationLogQ25: tdQ25R && tdQ25R.resp.task_type === 'quantile' ? tdQ25R.resp.mean : null,
    totalDurationLogQ75: tdQ75R && tdQ75R.resp.task_type === 'quantile' ? tdQ75R.resp.mean : null,
    tier: {
      firstBlood: null,
      totalKills: tkR?.tier ?? null,
      totalDuration: tdR?.tier ?? null,
      totalDurationQ25: tdQ25R?.tier ?? null,
      totalDurationQ75: tdQ75R?.tier ?? null,
    },
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
 * std для параметрической ladder/probability.
 *
 * Возвращает null'ы если модели не загружены или ml-service недоступен.
 * Cache не используется (снапшот меняется каждые 60s, key взрывается).
 */
export interface LiveTotalsPrediction {
  unavailableReasons: {kills:LiveTotalsRefusal|null;duration:LiveTotalsRefusal|null};
  evidence: {kills: PredictionEvidence | null; duration: PredictionEvidence | null};
  totalKillsLogN: { mean: number; std: number } | null;
  totalDurationLogN: { mean: number; std: number } | null;
  modelVersions: { kills: string | null; duration: string | null };
  tier: {
    kills: 'pure' | 'with_draft' | null;
    duration: 'pure' | 'with_draft' | null;
  };
}

/**
 * Live totals (T3.5 + 3-tier).
 *
 * Каскад:
 *   1. picks + teamIds переданы И live_total_*_with_draft модель загружена →
 *      13-фич view (snapshot7 + team4_no_bias + e1_live2).
 *   2. Иначе pure live (7-фич, только snapshot).
 *
 * При выборе with_draft modelVersion в ответе указывает на with_draft-блоб,
 * чтобы LiveWorker записал правильную версию в predictions.
 */
export async function predictLiveTotalsFor(
  snapshot: LiveTotalsSnapshot,
  draftHint?: DraftHint & { radiantTeamId: number; direTeamId: number },
): Promise<LiveTotalsPrediction> {
  const lk = cached.get('live_total_kills');
  const ld = cached.get('live_total_duration');
  const lkWd = cached.get('live_total_kills_with_draft');
  const ldWd = cached.get('live_total_duration_with_draft');

  const empty: LiveTotalsPrediction = {
    unavailableReasons: {
      kills:lk||lkWd?null:absentLiveTotalsModelReason([modelRefusals.get('live_total_kills'),modelRefusals.get('live_total_kills_with_draft')]),
      duration:ld||ldWd?null:absentLiveTotalsModelReason([modelRefusals.get('live_total_duration'),modelRefusals.get('live_total_duration_with_draft')]),
    },
    evidence: {kills:null,duration:null},
    totalKillsLogN: null,
    totalDurationLogN: null,
    modelVersions: { kills: null, duration: null },
    tier: { kills: null, duration: null },
  };
  const inputRefusal=liveTotalsInputRefusal(snapshot);
  if(inputRefusal) return {...empty,unavailableReasons:{kills:inputRefusal,duration:inputRefusal}};
  if (!lk && !ld && !lkWd && !ldWd) return empty;

  // Pure features (всегда вычисляем — fallback).
  const pureFeats = buildLiveTotalsFeatures({...snapshot,gameTimeSec:snapshot.gameTimeSec!});

  // With-draft features (если возможно).
  let wdFeats: number[] | null = null;
  const hasValidDraft = !!draftHint
    && draftHint.radiantPicks.length === 5 && draftHint.direPicks.length === 5
    && new Set(draftHint.radiantPicks).size === 5 && new Set(draftHint.direPicks).size === 5;
  if (hasValidDraft) {
    await refreshTeams();
    const tf = buildTeamFeatures(draftHint!.radiantTeamId, draftHint!.direTeamId);
    if (tf) {
      const e1 = await refreshE1Maps();
      if (e1) {
        const e1Live = buildE1LiveTotalsFeatures({
          radiantPicks: draftHint!.radiantPicks,
          direPicks: draftHint!.direPicks,
          benchmarks: e1.benchmarks,
          itemPop: e1.itemPop,
        });
        // team4 без bias (snapshot7 уже несёт его).
        const team4 = tf.slice(1);
        wdFeats = [...pureFeats, ...team4, ...e1Live];
      }
    }
  }

  const reasons={...empty.unavailableReasons};
  let [killsRes, durRes] = await Promise.all([
    (async () => {
      if (wdFeats && lkWd) {
        const r = await callMlPredict(lkWd.blobB64, wdFeats);
        if (r?.task_type==='regression') return { resp: r, kind: lkWd.kind, tier: 'with_draft' as const, version: lkWd.version, evidence: predictionEvidence(lkWd.artifactHash, lkWd.featureNames, wdFeats) };
        reasons.kills=r?'totals_output_contract_mismatch':'totals_inference_unavailable';
      }
      if (!lk) {reasons.kills??='totals_draft_context_unavailable';return null;}
      const r = await callMlPredict(lk.blobB64, pureFeats);
      if (!r || r.task_type!=='regression') {reasons.kills=r?'totals_output_contract_mismatch':'totals_inference_unavailable';return null;}
      return { resp: r, kind: lk.kind, tier: 'pure' as const, version: lk.version, evidence: predictionEvidence(lk.artifactHash, lk.featureNames, pureFeats) };
    })(),
    (async () => {
      if (wdFeats && ldWd) {
        const r = await callMlPredict(ldWd.blobB64, wdFeats);
        if (r?.task_type==='regression') return { resp: r, kind: ldWd.kind, tier: 'with_draft' as const, version: ldWd.version, evidence: predictionEvidence(ldWd.artifactHash, ldWd.featureNames, wdFeats) };
        reasons.duration=r?'totals_output_contract_mismatch':'totals_inference_unavailable';
      }
      if (!ld) {reasons.duration??='totals_draft_context_unavailable';return null;}
      const r = await callMlPredict(ld.blobB64, pureFeats);
      if (!r || r.task_type!=='regression') {reasons.duration=r?'totals_output_contract_mismatch':'totals_inference_unavailable';return null;}
      return { resp: r, kind: ld.kind, tier: 'pure' as const, version: ld.version, evidence: predictionEvidence(ld.artifactHash, ld.featureNames, pureFeats) };
    })(),
  ]);

  const stillLoaded=(value:NonNullable<typeof killsRes>)=>{
    const current=cached.get(value.kind);
    return !!current && current.version===value.version && current.artifactHash===value.evidence.modelHash
      && current.featureNames.length===value.evidence.featureNames.length
      && current.featureNames.every((name,index)=>name===value.evidence.featureNames[index]);
  };
  if(killsRes&&!stillLoaded(killsRes)) {killsRes=null;reasons.kills='totals_model_changed_during_inference';}
  if(durRes&&!stillLoaded(durRes)) {durRes=null;reasons.duration='totals_model_changed_during_inference';}

  return {
    unavailableReasons:{kills:killsRes?null:reasons.kills,duration:durRes?null:reasons.duration},
    totalKillsLogN: killsRes && killsRes.resp.task_type === 'regression'
      ? { mean: killsRes.resp.mean, std: Math.max(1e-3, killsRes.resp.std) } : null,
    totalDurationLogN: durRes && durRes.resp.task_type === 'regression'
      ? { mean: durRes.resp.mean, std: Math.max(1e-3, durRes.resp.std) } : null,
    modelVersions: {
      kills: killsRes?.version ?? null,
      duration: durRes?.version ?? null,
    },
    evidence: {kills:killsRes?.evidence ?? null,duration:durRes?.evidence ?? null},
    tier: {
      kills: killsRes?.tier ?? null,
      duration: durRes?.tier ?? null,
    },
  };
}
