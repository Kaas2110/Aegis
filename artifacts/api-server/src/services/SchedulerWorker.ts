/**
 * Шедулер автоматического обновления данных и переобучения модели.
 *
 * Поведение для production-deploy «поставил → работает»:
 *  - Каждые 24h: tick — проверка патча, daily refresh (lightweight ingest+compute),
 *    sliding window prune, прюнинг live_snapshots, decision retrain.
 *  - Cold start (БД пустая → нет pro_matches): немедленный full retrain pipeline.
 *  - Новый патч: планирует full retrain через 7 дней (даём мете устаканиться).
 *  - Иначе: full retrain раз в 30 дней.
 *  - Full retrain pipeline: 14 шагов (teams, matches, drafts, hero-stats,
 *    hero-matchups, players-heroes, leagues, recent-form, h2h, bo3-series,
 *    player-glicko, train:model[CRITICAL], train:lightgbm, train:market-models,
 *    train:live-model). Все шаги кроме train:model — non-fatal (ошибка
 *    логируется, pipeline продолжается).
 *
 * Состояние: scheduler_state (single-row, id=1). Управление:
 *  - DISABLE_SCHEDULER=true — отключить весь воркер.
 *  - DISABLE_AUTO_RETRAIN=true — отключить только тренировку (ingest+compute идут).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { db, schedulerStateTable, proMatchesTable } from '@workspace/db';
import { recordHeartbeat } from './workerHeartbeats';
import { eq, lt, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { loadActiveModel } from './PredictionModel';
import { loadActiveMarketModels } from './MarketLgbm';
import { loadActiveLiveModel } from './LiveWinnerModel';
import { pruneLiveSnapshots } from './OutcomeTracker';
import { getAppSettings } from './AppSettings';
import { withOpenDotaKey } from '../lib/openDotaUrl';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 часа
const PATCH_DELAY_DAYS = 7;                     // ждать 7 дней после нового патча
const REGULAR_RETRAIN_DAYS = 30;                // плановое переобучение раз в месяц
const TRAIN_WINDOW_DAYS = 365;                  // скользящее окно: храним и тренируем на матчах за 12 мес.
const PATCH_API = 'https://api.opendota.com/api/constants/patch';

// Путь к корню workspace, где лежит package.json со scripts.
// __dirname в собранном бандле = artifacts/api-server/dist, поднимаемся на 3 уровня.
const WORKSPACE_ROOT = path.resolve(process.cwd(), '../..');

interface OpenDotaPatch {
  name: string;       // напр. "7.36c"
  date: string;       // ISO date
  id?: number;
}

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let stopRequested = false;
let runInFlight = false;

let stats = {
  totalChecks: 0,
  totalRetrainAttempts: 0,
  totalRetrainSuccess: 0,
  totalRetrainFailed: 0,
  lastCheckAt: null as Date | null,
  lastRetrainAt: null as Date | null,
  lastRetrainResult: null as string | null,
  lastError: null as string | null,
};

async function loadState() {
  const rows = await db
    .select()
    .from(schedulerStateTable)
    .where(eq(schedulerStateTable.id, 1))
    .limit(1);
  if (rows.length === 0) {
    await db.insert(schedulerStateTable).values({ id: 1 }).onConflictDoNothing();
    return null;
  }
  return rows[0];
}

async function updateState(patch: Partial<typeof schedulerStateTable.$inferInsert>) {
  await db
    .update(schedulerStateTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schedulerStateTable.id, 1));
}

async function fetchCurrentPatch(): Promise<OpenDotaPatch | null> {
  try {
    const resp = await fetch(withOpenDotaKey(PATCH_API), { headers: { 'User-Agent': 'DotaEdgeAnalyzer/1.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as OpenDotaPatch[] | OpenDotaPatch;
    // OpenDota возвращает массив, последний — самый свежий.
    if (Array.isArray(data)) {
      if (data.length === 0) return null;
      // Сортируем по дате на всякий случай
      return [...data].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
    }
    return data;
  } catch (err) {
    logger.warn({ err: String(err) }, '[Scheduler] failed to fetch current patch');
    return null;
  }
}

/**
 * Вычисляет Unix-timestamp начала тренировочного окна как
 * max(windowCutoff, patchCutoff) — более строгое из двух ограничений.
 * Если запрос патчей не удался — возвращает только windowCutoff.
 */
async function computeTrainSinceUnix(windowDays: number, maxPatches: number): Promise<number> {
  const windowCutoff = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  try {
    const resp = await fetch(withOpenDotaKey(PATCH_API), { headers: { 'User-Agent': 'DotaEdgeAnalyzer/1.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = (await resp.json()) as OpenDotaPatch[] | OpenDotaPatch;
    const patches: OpenDotaPatch[] = Array.isArray(raw) ? raw : [raw];
    if (patches.length === 0) return windowCutoff;
    const sorted = [...patches].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const idx = Math.max(0, sorted.length - maxPatches);
    const patchCutoffMs = Date.parse(sorted[idx].date);
    if (!Number.isFinite(patchCutoffMs)) return windowCutoff;
    const patchCutoff = Math.floor(patchCutoffMs / 1000);
    const effective = Math.max(windowCutoff, patchCutoff);
    logger.info(
      { windowDays, maxPatches, windowCutoff, patchCutoff, effective, patchName: sorted[idx].name },
      '[Scheduler] computeTrainSinceUnix',
    );
    return effective;
  } catch (err) {
    logger.warn({ err: String(err) }, '[Scheduler] computeTrainSinceUnix patch fetch failed, using window only');
    return windowCutoff;
  }
}

/**
 * Запускает pnpm-команду в корне workspace и резолвится при завершении.
 */
function runPnpmScript(
  scriptName: string,
  args: string[] = [],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; tail: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(
      'pnpm',
      ['--filter', '@workspace/scripts', 'run', scriptName, ...args],
      {
        cwd: WORKSPACE_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const buffer: string[] = [];
    const collect = (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n');
      for (const l of lines) {
        if (!l.trim()) continue;
        buffer.push(l);
        if (buffer.length > 50) buffer.shift();
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let timedOut = false;
    const timeoutMs = opts.timeoutMs ?? SCRIPT_DEFAULT_TIMEOUT_MS;
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5_000);
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, tail: buffer.slice(-15).join('\n'), timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ code: -1, tail: `spawn error: ${String(err)}`, timedOut });
    });
  });
}

/**
 * Запускает скрипт и НИКОГДА не выбрасывает — все ошибки логируются.
 * Используется для non-fatal шагов pipeline'а (ingest/compute/non-critical train).
 * Возвращает true при успехе.
 */
async function runScriptSafe(
  scriptName: string,
  label: string,
  args: string[] = [],
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const r = await runPnpmScript(scriptName, args, opts);
    const durationMs = Date.now() - startedAt;
    if (r.code === 0) {
      logger.info({ step: label, durationMs }, '[Scheduler] step done');
      return true;
    }
    logger.warn(
      { step: label, code: r.code, timedOut: r.timedOut, durationMs, tail: r.tail },
      '[Scheduler] step failed (non-fatal, continuing)',
    );
    return false;
  } catch (err) {
    logger.warn({ step: label, err: String(err) }, '[Scheduler] step exception (non-fatal)');
    return false;
  }
}

const SCRIPT_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 минут — крупный потолок
const SCRIPT_FAST_TIMEOUT_MS = 10 * 60 * 1000;    // 10 минут — для быстрых compute

/**
 * P5 — auto-retrain safety gate.
 * Возвращает строку-причину пропуска или null если можно тренировать.
 *
 *  - `DISABLE_AUTO_RETRAIN=true` — killswitch (priority).
 *  - `AUTO_RETRAIN_CRON_HOUR_UTC=<0..23>` — если задан, разрешает обучение
 *    только в этот час UTC. Если не задан — открыто всегда (но килла нет).
 *
 * Замысел: на Replit оставить `DISABLE_AUTO_RETRAIN=true` (другие cron-
 * workflow'ы наполняют БД и не должны конкурировать с обучением). На ноуте
 * — `DISABLE_AUTO_RETRAIN` снят, `AUTO_RETRAIN_CRON_HOUR_UTC=4` (~7 утра МСК).
 */
function checkAutoRetrainGate(): string | null {
  if (process.env['DISABLE_AUTO_RETRAIN'] === 'true') return 'DISABLE_AUTO_RETRAIN';
  const hourRaw = process.env['AUTO_RETRAIN_CRON_HOUR_UTC'];
  if (hourRaw != null && hourRaw !== '') {
    const hour = Number(hourRaw);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      logger.warn({ hourRaw }, '[Scheduler] AUTO_RETRAIN_CRON_HOUR_UTC некорректен (ожидается 0..23) — пропускаю обучение');
      return 'AUTO_RETRAIN_CRON_HOUR_UTC_INVALID';
    }
    const now = new Date();
    if (now.getUTCHours() !== hour) {
      return `AUTO_RETRAIN_CRON_HOUR_UTC=${hour} (now=${now.getUTCHours()}h UTC)`;
    }
  }
  return null;
}

export { checkAutoRetrainGate };

/**
 * Считает delay до ближайшего наступления указанного часа UTC (wall-clock).
 * Используется когда задан `AUTO_RETRAIN_CRON_HOUR_UTC`, чтобы tick не дрейфовал
 * от tick'а из-за длительности скриптов и не «промазывал» 1-часовое окно
 * (см. architect-review P5 #5: за неделю 24h-setTimeout сдвигается на часы).
 */
function delayToNextUtcHour(targetHour: number): number {
  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetHour, 0, 0, 0,
  ));
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return Math.max(1_000, target.getTime() - now.getTime());
}

/** Возвращает CHECK_INTERVAL_MS или wall-clock delay до cron-окна. */
function nextTickDelay(): number {
  const hourRaw = process.env['AUTO_RETRAIN_CRON_HOUR_UTC'];
  if (hourRaw != null && hourRaw !== '') {
    const hour = Number(hourRaw);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
      return delayToNextUtcHour(hour);
    }
  }
  return CHECK_INTERVAL_MS;
}

async function runRetrainPipeline(reason: string): Promise<boolean> {
  if (runInFlight) {
    logger.warn('[Scheduler] retrain already in flight, skipping');
    return false;
  }
  // Mutual exclusion с daily refresh: если идёт лёгкий цикл данных,
  // ждём его завершения (до 15 минут), чтобы не плодить дубли spawn'ов
  // ingest:teams/matches.
  const waitStart = Date.now();
  while (dailyRefreshInFlight && Date.now() - waitStart < 15 * 60 * 1000) {
    logger.info('[Scheduler] retrain ждёт завершения daily refresh');
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (dailyRefreshInFlight) {
    logger.warn('[Scheduler] daily refresh не завершился за 15 мин — пропускаю retrain');
    return false;
  }
  runInFlight = true;
  stats.totalRetrainAttempts++;
  const startedAt = new Date();
  logger.info({ reason }, '[Scheduler] starting full retrain pipeline');

  const stepResults: Record<string, boolean> = {};
  let trainTail = '';

  try {
    // ── Phase 1: ingest (свежие данные из OpenDota) ──────────────────────
    // teams и matches — критичные. Если упали — без них тренировка
    // бессмысленна. Остальное — non-fatal.
    const teamsRun = await runPnpmScript('ingest:teams', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    stepResults['ingest:teams'] = teamsRun.code === 0;
    logger.info({ code: teamsRun.code }, '[Scheduler] ingest:teams done');
    if (teamsRun.code !== 0) throw new Error(`ingest:teams failed: ${teamsRun.tail}`);
    await updateState({ lastIngestAt: new Date() });

    // ingest:matches — non-fatal: при 429 от OD pipeline продолжает работать
    // с уже накопленными данными в БД. Критичность убрана, чтобы 429 не блокировал
    // весь ретрейн-цикл (исторически убивал pipeline с 2026-05-14).
    stepResults['ingest:matches'] = await runScriptSafe('ingest:matches', 'ingest:matches', ['200']);
    logger.info({ ok: stepResults['ingest:matches'] }, '[Scheduler] ingest:matches done (non-fatal)');

    // Non-fatal обогащение: drafts, hero-stats, hero-matchups, players-heroes, leagues
    stepResults['ingest:drafts'] = await runScriptSafe('ingest:drafts', 'ingest:drafts');
    stepResults['ingest:hero-stats'] = await runScriptSafe('ingest:hero-stats', 'ingest:hero-stats', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    stepResults['ingest:hero-matchups'] = await runScriptSafe('ingest:hero-matchups', 'ingest:hero-matchups');
    stepResults['ingest:players-heroes'] = await runScriptSafe('ingest:players-heroes', 'ingest:players-heroes');
    stepResults['ingest:leagues'] = await runScriptSafe('ingest:leagues', 'ingest:leagues', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });

    // ── Phase 2: sliding window prune ────────────────────────────────────
    const pipelineSettings = await getAppSettings();
    const trainWindowDaysCfg = pipelineSettings.trainWindowDays ?? TRAIN_WINDOW_DAYS;
    const cutoffSec = Math.floor(Date.now() / 1000) - trainWindowDaysCfg * 24 * 60 * 60;
    const deleted = await db
      .delete(proMatchesTable)
      .where(lt(proMatchesTable.startTime, cutoffSec))
      .returning({ matchId: proMatchesTable.matchId });
    logger.info(
      { deleted: deleted.length, cutoff: new Date(cutoffSec * 1000).toISOString() },
      '[Scheduler] sliding window prune',
    );

    // ── Phase 3: compute (производные таблицы) — все non-fatal ───────────
    stepResults['compute:recent-form'] = await runScriptSafe('compute:recent-form', 'compute:recent-form', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    stepResults['compute:h2h'] = await runScriptSafe('compute:h2h', 'compute:h2h', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    stepResults['compute:bo3-series'] = await runScriptSafe('compute:bo3-series', 'compute:bo3-series', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    stepResults['compute:player-glicko'] = await runScriptSafe('compute:player-glicko', 'compute:player-glicko', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });

    // P5 — safety gates перед фазой тренировки.
    //
    // 1. DISABLE_AUTO_RETRAIN=true — жёсткий killswitch (без обновления lastTrainAt).
    // 2. AUTO_RETRAIN_CRON_HOUR_UTC=<0..23> — обучение разрешено ТОЛЬКО в этот
    //    час UTC (на ноуте ставим, например, 4 — 7-9 утра МСК, когда live-poll
    //    тихий). Если не задан → ведём себя как раньше (обучаем если killswitch
    //    снят). На Replit оставляем DISABLE_AUTO_RETRAIN=true чтобы не мешать
    //    параллельным cron-workflow'ам наполнения БД.
    const skipTrainingReason = checkAutoRetrainGate();
    if (skipTrainingReason) {
      logger.warn({ skipTrainingReason }, '[Scheduler] retrain phase skipped (safety gate)');
      stats.lastRetrainResult = `data-only (training skipped: ${skipTrainingReason})`;
      // НЕ обновляем lastTrainAt и nextTrainDueAt: иначе после снятия флага
      // следующее переобучение отложится на 30 дней и пропуски моделей замаскируются.
      await updateState({
        lastIngestAt: new Date(),
        notes: { reason, completedAt: new Date().toISOString(), stepResults, prunedOldMatches: deleted.length, dataOnly: true, trainingSkipped: skipTrainingReason },
      });
      return true;
    }

    // ── Phase 3.5: effective training window (patch-aware) ───────────────
    const effectiveSinceUnix = await computeTrainSinceUnix(
      trainWindowDaysCfg,
      pipelineSettings.trainMaxPatches ?? 4,
    );
    const effectiveMinSamples = pipelineSettings.trainMinSamples ?? 1000;
    const trainArgs = ['--since-unix', String(effectiveSinceUnix), '--min-samples', String(effectiveMinSamples)];
    logger.info({ effectiveSinceUnix, effectiveMinSamples, trainWindowDaysCfg }, '[Scheduler] train dataset window computed');

    // ── Phase 4: train — train:model критичен, остальные non-fatal ───────
    const trainRun = await runPnpmScript('train:model', trainArgs);
    stepResults['train:model'] = trainRun.code === 0;
    trainTail = trainRun.tail;
    logger.info({ code: trainRun.code, tail: trainRun.tail }, '[Scheduler] train:model done');
    if (trainRun.code !== 0) throw new Error(`train:model failed: ${trainRun.tail}`);

    await loadActiveModel();

    // train:lightgbm — non-fatal. Зависит от ml-service: при сбое останется LR.
    stepResults['train:lightgbm'] = await runScriptSafe('train:lightgbm', 'train:lightgbm', trainArgs);
    if (stepResults['train:lightgbm']) {
      try { await loadActiveModel(); } catch (err) {
        logger.warn({ err: String(err) }, '[Scheduler] reload after train:lightgbm failed');
      }
    }

    // train:market-models — non-fatal
    stepResults['train:market-models'] = await runScriptSafe('train:market-models', 'train:market-models', trainArgs, { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    if (stepResults['train:market-models']) {
      try { await loadActiveMarketModels(); } catch (err) {
        logger.warn({ err: String(err) }, '[Scheduler] reload after train:market-models failed');
      }
    }

    // ── Phase 4.5: авто-обогащение live-снапшотов если данных мало ─────────
    // Считаем distinct match_ids с известным исходом в live_snapshots.
    // Если < MIN_LIVE_MATCH_PAIRS — запускаем backfill из OpenDota истории
    // (равномерная выборка по trainWindow, до 300 матчей за раз, ~6 мин).
    const MIN_LIVE_MATCH_PAIRS = 100;
    try {
      const liveRes = await db.execute(sql`
        SELECT COUNT(DISTINCT ls.match_id) AS cnt
        FROM live_snapshots ls
        JOIN pro_matches pm ON pm.match_id = ls.match_id
        WHERE pm.radiant_win IS NOT NULL AND ls.game_time_sec >= 60
      `);
      const liveMatchPairs = Number((liveRes.rows[0] as Record<string, unknown>)?.cnt ?? 0);
      logger.info({ liveMatchPairs, MIN_LIVE_MATCH_PAIRS }, '[Scheduler] live snapshot-outcome pairs');
      if (liveMatchPairs < MIN_LIVE_MATCH_PAIRS) {
        logger.info('[Scheduler] running backfill:live-snapshots for auto-enrichment');
        stepResults['backfill:live-snapshots'] = await runScriptSafe(
          'backfill:live-snapshots', 'backfill:live-snapshots',
          ['--since-unix', String(effectiveSinceUnix), '--min-pairs', String(MIN_LIVE_MATCH_PAIRS), '--limit', '300'],
          { timeoutMs: 30 * 60 * 1000 },
        );
      } else {
        stepResults['backfill:live-snapshots'] = true; // достаточно данных, пропускаем
      }
    } catch (err) {
      logger.warn({ err: String(err) }, '[Scheduler] backfill:live-snapshots check failed');
    }

    // train:live-model — non-fatal (нужны накопленные снапшоты)
    stepResults['train:live-model'] = await runScriptSafe('train:live-model', 'train:live-model', trainArgs, { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    if (stepResults['train:live-model']) {
      try { await loadActiveLiveModel(); } catch (err) {
        logger.warn({ err: String(err) }, '[Scheduler] reload after train:live-model failed');
      }
    }

    // train:live-totals — non-fatal (live regression: total_kills + total_duration)
    stepResults['train:live-totals'] = await runScriptSafe('train:live-totals', 'train:live-totals', trainArgs, { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    if (stepResults['train:live-totals']) {
      try { await loadActiveLiveModel(); } catch (err) {
        logger.warn({ err: String(err) }, '[Scheduler] reload after train:live-totals failed');
      }
    }

    stats.totalRetrainSuccess++;
    stats.lastRetrainAt = startedAt;
    stats.lastRetrainResult = 'success';

    await updateState({
      lastTrainAt: startedAt,
      nextTrainDueAt: null,
      lastError: null,
      notes: {
        reason,
        completedAt: new Date().toISOString(),
        trainTail,
        stepResults,
        prunedOldMatches: deleted.length,
        windowDays: TRAIN_WINDOW_DAYS,
      },
    });

    logger.info(
      { reason, durationMs: Date.now() - startedAt.getTime(), stepResults },
      '[Scheduler] full retrain pipeline success',
    );
    return true;
  } catch (err) {
    stats.totalRetrainFailed++;
    stats.lastRetrainResult = `error: ${String(err)}`;
    stats.lastError = String(err);
    await updateState({
      lastError: String(err),
      notes: { reason, failedAt: new Date().toISOString(), stepResults },
    });
    logger.error({ err, stepResults }, '[Scheduler] retrain pipeline failed');
    return false;
  } finally {
    runInFlight = false;
  }
}

/**
 * Daily refresh — лёгкий цикл данных без полной тренировки.
 * Запускается раз в сутки между full-retrain'ами, чтобы предсказания
 * (form/h2h/glicko/players-heroes) не «черствели».
 * Все шаги non-fatal.
 */
let dailyRefreshInFlight = false;
async function runDailyRefresh(): Promise<void> {
  if (dailyRefreshInFlight || runInFlight) return;
  dailyRefreshInFlight = true;
  // Двойная проверка после установки флага: если retrain успел стартовать
  // в этом же тике — тут же откатываемся.
  if (runInFlight) { dailyRefreshInFlight = false; return; }
  const startedAt = Date.now();
  logger.info('[Scheduler] daily refresh: starting');
  try {
    await runScriptSafe('ingest:teams', 'daily/ingest:teams', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    await runScriptSafe('ingest:matches', 'daily/ingest:matches', ['20']);
    await runScriptSafe('ingest:drafts', 'daily/ingest:drafts');
    await runScriptSafe('ingest:players-heroes', 'daily/ingest:players-heroes');
    await runScriptSafe('compute:recent-form', 'daily/compute:recent-form', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    await runScriptSafe('compute:h2h', 'daily/compute:h2h', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    await runScriptSafe('compute:player-glicko', 'daily/compute:player-glicko', [], { timeoutMs: SCRIPT_FAST_TIMEOUT_MS });
    logger.info({ durationMs: Date.now() - startedAt }, '[Scheduler] daily refresh: done');
  } finally {
    dailyRefreshInFlight = false;
  }
}

/**
 * Решает, нужно ли запускать переобучение прямо сейчас.
 */
async function shouldRetrainNow(state: typeof schedulerStateTable.$inferSelect | null): Promise<{
  retrain: boolean;
  reason: string;
}> {
  if (!state) return { retrain: false, reason: 'no state row yet' };
  const now = Date.now();

  // 0) Cold start: пустая БД → запускаем full pipeline сразу,
  //    не дожидаясь патча или 30-дневного цикла. Это критично для self-deploy:
  //    свежеразвёрнутый сервер должен стать рабочим без ручного вмешательства.
  if (!state.lastTrainAt) {
    try {
      const cnt = await db.select({ c: sql<number>`count(*)::int` }).from(proMatchesTable);
      const matchCount = cnt[0]?.c ?? 0;
      if (matchCount < 100) {
        return { retrain: true, reason: `cold start (pro_matches=${matchCount}, никогда не тренировались)` };
      }
    } catch (err) {
      logger.warn({ err: String(err) }, '[Scheduler] cold-start check failed');
    }
  }

  // 1) Запланировано после нового патча — ждём срока
  if (state.nextTrainDueAt && state.nextTrainDueAt.getTime() <= now) {
    return { retrain: true, reason: `scheduled after patch ${state.lastPatchSeen ?? 'unknown'}` };
  }

  // 2) Плановое переобучение раз в 30 дней
  if (!state.lastTrainAt) {
    return { retrain: false, reason: 'never trained yet — waiting for first patch check or manual trigger' };
  }
  const ageMs = now - state.lastTrainAt.getTime();
  if (ageMs > REGULAR_RETRAIN_DAYS * 24 * 60 * 60 * 1000) {
    return {
      retrain: true,
      reason: `regular ${REGULAR_RETRAIN_DAYS}-day refresh (last train was ${Math.floor(ageMs / 86_400_000)}d ago)`,
    };
  }

  return { retrain: false, reason: 'within window' };
}

async function tickOnce(): Promise<void> {
  stats.totalChecks++;
  stats.lastCheckAt = new Date();

  // 1. Получаем текущий патч
  const patch = await fetchCurrentPatch();
  let state = await loadState();
  if (!state) state = await loadState();

  await updateState({ lastCheckAt: new Date() });

  // 2. Если патч новый — планируем переобучение на patch.date + 7 дней.
  //    Это корректно как для свежевыпущенных, так и для давно выпущенных
  //    патчей (которые мы увидели впервые на старте сервера) — для последних
  //    срок будет в прошлом и тренировка запустится прямо сейчас.
  if (patch && state && patch.name !== state.lastPatchSeen) {
    const patchDateMs = Date.parse(patch.date);
    const baseMs = Number.isFinite(patchDateMs) ? patchDateMs : Date.now();
    const dueAt = new Date(baseMs + PATCH_DELAY_DAYS * 24 * 60 * 60 * 1000);
    logger.info(
      {
        newPatch: patch.name,
        prevPatch: state.lastPatchSeen,
        patchDate: patch.date,
        retrainDueAt: dueAt,
        immediate: dueAt.getTime() <= Date.now(),
      },
      '[Scheduler] new patch detected → retrain scheduled',
    );
    await updateState({
      lastPatchSeen: patch.name,
      lastPatchDetectedAt: new Date(patch.date),
      nextTrainDueAt: dueAt,
    });
    state = await loadState();
  } else if (state) {
    logger.info(
      {
        patch: state.lastPatchSeen,
        nextTrainDueAt: state.nextTrainDueAt,
        lastTrainAt: state.lastTrainAt,
      },
      '[Scheduler] daily check (no new patch)',
    );
  }

  // 2.5. Раз в сутки чистим live_snapshots по настройке prune_days из app_settings.
  //      Эта таблица растёт быстро (~1 строка/мин/матч), а исторические данные
  //      о результатах хранятся отдельно в prematch_outcomes (никогда не чистится).
  try {
    const settings = await getAppSettings();
    const pruned = await pruneLiveSnapshots(settings.liveSnapshotPruneDays);
    if (pruned > 0) {
      logger.info({ pruned, days: settings.liveSnapshotPruneDays }, '[Scheduler] daily live_snapshots prune');
    }
  } catch (err) {
    logger.warn({ err: String(err) }, '[Scheduler] live_snapshots prune failed');
  }

  // 3. Проверяем — пора ли переобучать
  const decision = await shouldRetrainNow(state);
  if (decision.retrain) {
    // Не блокируем тикер — запускаем фоном
    void runRetrainPipeline(decision.reason);
  } else {
    logger.debug({ reason: decision.reason }, '[Scheduler] retrain not needed');
    // 4. Daily refresh: лёгкий цикл данных без full retrain.
    //    Не запускаем если pipeline уже идёт или БД пустая (cold-start
    //    решит retrain → ingest всё равно будет).
    void runDailyRefresh();
  }
}

async function scheduleNextTick(delayMs: number): Promise<void> {
  if (stopRequested) return;
  timeoutId = setTimeout(async () => {
    if (stopRequested) return;
    const startedAt = Date.now();
    let tickOk = true;
    let tickErr: string | null = null;
    try {
      await tickOnce();
    } catch (err) {
      tickOk = false;
      tickErr = err instanceof Error ? err.message : String(err);
      logger.error({ err }, '[Scheduler] tick error');
      stats.lastError = tickErr;
    } finally {
      recordHeartbeat('scheduler', { ok: tickOk, durationMs: Date.now() - startedAt, error: tickErr });
      // P5 — при заданном AUTO_RETRAIN_CRON_HOUR_UTC выравниваемся на wall-clock,
      // чтобы 24h-дрейф не «проглатывал» 1-часовое retrain-окно (architect-review #5).
      void scheduleNextTick(nextTickDelay());
    }
  }, delayMs);
}

export function startScheduler(): void {
  if (timeoutId || stopRequested) return;
  logger.info(
    { intervalH: 24, patchDelayDays: PATCH_DELAY_DAYS, regularRetrainDays: REGULAR_RETRAIN_DAYS },
    '[Scheduler] starting',
  );

  // Гарантируем, что строка состояния существует
  void loadState();

  // Первый прогон через 30 секунд после старта (даём серверу подняться, БД быть готовой)
  void scheduleNextTick(30_000);

  const shutdown = () => {
    logger.info('[Scheduler] shutdown signal received');
    stopScheduler();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export function stopScheduler(): void {
  stopRequested = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
    logger.info('[Scheduler] stopped');
  }
}

export function getSchedulerStats() {
  return {
    ...stats,
    runInFlight,
    config: {
      checkIntervalHours: 24,
      retrainDelayAfterPatchDays: PATCH_DELAY_DAYS,
      regularRetrainIntervalDays: REGULAR_RETRAIN_DAYS,
      trainWindowDays: TRAIN_WINDOW_DAYS,
    },
  };
}

/**
 * Ручной триггер переобучения (для админки / отладки).
 * Вызывается из роута, например POST /api/analytics/retrain.
 */
export async function triggerManualRetrain(): Promise<{ started: boolean; reason: string }> {
  if (runInFlight) return { started: false, reason: 'already running' };
  void runRetrainPipeline('manual trigger');
  return { started: true, reason: 'manual trigger' };
}

/**
 * Whitelist скриптов и допустимых аргументов для per-model ручного
 * переобучения из админки. Любой запрос с скриптом/аргументом вне
 * whitelist отклоняется на уровне роута (см. POST /admin/models/retrain).
 */
export const TRAIN_SCRIPT_WHITELIST: Record<string, { args: readonly string[] }> = {
  'train:model':         { args: ['--since-unix', '--min-samples'] },
  'train:lightgbm':      { args: ['--label', '--since-unix', '--min-samples'] },
  'train:market-models': { args: ['--market', '--since-unix', '--min-samples'] },
  'train:live-model':    { args: ['--since-unix', '--min-samples'] },
  'train:live-totals':   { args: ['--market', '--since-unix', '--min-samples'] },
};
export type TrainScriptName = 'train:model' | 'train:lightgbm' | 'train:market-models' | 'train:live-model' | 'train:live-totals';

/**
 * Запускает один тренировочный скрипт в фоне с whitelist'ом аргументов.
 * Использует тот же `runInFlight` mutex, что и full retrain pipeline:
 * во время full retrain перепереобучить отдельную модель нельзя.
 *
 * Args передаются как массив пар [flag, value]; flag должен быть в
 * `TRAIN_SCRIPT_WHITELIST[script].args`. value валидируется регэкспом
 * (только [a-zA-Z0-9_/-]). Это защита от shell-инъекции — pnpm/spawn
 * без shell, но extra layer не помешает.
 */
export async function runTrainScriptManual(
  script: TrainScriptName,
  args: Array<{ flag: string; value: string }>,
): Promise<{ started: boolean; reason: string }> {
  const meta = TRAIN_SCRIPT_WHITELIST[script];
  if (!meta) return { started: false, reason: `unknown script: ${script}` };

  const flatArgs: string[] = [];
  for (const { flag, value } of args) {
    if (!meta.args.includes(flag)) {
      return { started: false, reason: `flag ${flag} not allowed for ${script}` };
    }
    if (!/^[a-zA-Z0-9_/-]+$/.test(value)) {
      return { started: false, reason: `invalid value for ${flag}: must match [a-zA-Z0-9_/-]+` };
    }
    flatArgs.push(flag, value);
  }

  if (runInFlight) return { started: false, reason: 'another retrain is in flight' };

  runInFlight = true;
  const reason = `manual ${script}${flatArgs.length ? ' ' + flatArgs.join(' ') : ''}`;
  logger.info({ script, flatArgs }, `[Scheduler] ${reason}`);

  // fire-and-forget; release mutex when done; hot-reload models on success.
  void (async () => {
    try {
      const r = await runPnpmScript(script, flatArgs, { timeoutMs: 30 * 60 * 1000 });
      if (r.code === 0) {
        logger.info({ script, flatArgs }, `[Scheduler] ${reason} OK`);
        // Hot-reload зависит от скрипта; гоняем оба — getActiveModel идемпотентен.
        try {
          if (script === 'train:model' || script === 'train:lightgbm') {
            await loadActiveModel();
          }
          if (script === 'train:market-models') {
            await loadActiveMarketModels();
          }
          if (script === 'train:live-model') {
            await loadActiveLiveModel();
          }
        } catch (e) {
          logger.warn({ err: String(e) }, `[Scheduler] hot-reload after ${script} failed`);
        }
      } else {
        logger.error({ script, code: r.code, tail: r.tail.slice(-2000) }, `[Scheduler] ${reason} FAILED`);
      }
    } finally {
      runInFlight = false;
    }
  })();

  return { started: true, reason };
}

/**
 * Возвращает полное состояние шедулера из БД для эндпоинта статуса.
 */
export async function getSchedulerState() {
  return loadState();
}
