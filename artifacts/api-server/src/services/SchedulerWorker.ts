/**
 * Шедулер автоматического обновления данных и переобучения модели.
 *
 * Логика:
 *  - Раз в 24 часа проверяет текущий патч Dota 2 (OpenDota /api/constants/patch).
 *  - При обнаружении нового патча: планирует переобучение через 7 дней
 *    (даём pro-сцене сыграть достаточное количество матчей на новом патче).
 *  - Иначе: переобучение раз в 30 дней от последней успешной тренировки.
 *  - При наступлении срока: запускает ingest:teams → ingest:matches → train:model
 *    (через child_process), результат логирует в scheduler_state.
 *
 * Состояние хранится в таблице scheduler_state (single-row, id=1).
 *
 * Управление: ENV-переменная DISABLE_SCHEDULER=true отключает воркер.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { db, schedulerStateTable, proMatchesTable } from '@workspace/db';
import { eq, lt, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { loadActiveModel } from './PredictionModel';
import { loadActiveLiveModel } from './LiveWinnerModel';
import { pruneLiveSnapshots } from './OutcomeTracker';
import { getAppSettings } from './AppSettings';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 часа
const PATCH_DELAY_DAYS = 7;                     // ждать 7 дней после нового патча
const REGULAR_RETRAIN_DAYS = 30;                // плановое переобучение раз в месяц
const TRAIN_WINDOW_DAYS = 180;                  // скользящее окно: храним и тренируем на матчах за 6 мес.
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
    const resp = await fetch(PATCH_API, { headers: { 'User-Agent': 'DotaEdgeAnalyzer/1.0' } });
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
 * Запускает pnpm-команду в корне workspace и резолвится при завершении.
 */
function runPnpmScript(scriptName: string, args: string[] = []): Promise<{ code: number; tail: string }> {
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

    child.on('close', (code) => {
      resolve({ code: code ?? -1, tail: buffer.slice(-15).join('\n') });
    });
    child.on('error', (err) => {
      resolve({ code: -1, tail: `spawn error: ${String(err)}` });
    });
  });
}

async function runRetrainPipeline(reason: string): Promise<boolean> {
  if (runInFlight) {
    logger.warn('[Scheduler] retrain already in flight, skipping');
    return false;
  }
  runInFlight = true;
  stats.totalRetrainAttempts++;
  const startedAt = new Date();
  logger.info({ reason }, '[Scheduler] starting retrain pipeline');

  try {
    // 1. Обновляем рейтинги команд (быстрый, ~5с)
    const teamsRun = await runPnpmScript('ingest:teams');
    logger.info({ code: teamsRun.code }, '[Scheduler] ingest:teams done');
    if (teamsRun.code !== 0) {
      throw new Error(`ingest:teams failed: ${teamsRun.tail}`);
    }
    await updateState({ lastIngestAt: new Date() });

    // 2. Подтягиваем свежие матчи (15 страниц = ~1500 матчей, ~17с)
    const matchesRun = await runPnpmScript('ingest:matches', ['15']);
    logger.info({ code: matchesRun.code }, '[Scheduler] ingest:matches done');
    if (matchesRun.code !== 0) {
      throw new Error(`ingest:matches failed: ${matchesRun.tail}`);
    }

    // 2.5. Сдвигаем скользящее окно: удаляем матчи старше TRAIN_WINDOW_DAYS.
    //      Это и есть обещанное «убираем самые старые 30 дней каждый цикл»:
    //      между двумя успешными переобучениями (раз в 30 дней) граница окна
    //      продвигается ровно на 30 дней вперёд.
    const cutoffSec = Math.floor(Date.now() / 1000) - TRAIN_WINDOW_DAYS * 24 * 60 * 60;
    const deleted = await db
      .delete(proMatchesTable)
      .where(lt(proMatchesTable.startTime, cutoffSec))
      .returning({ matchId: proMatchesTable.matchId });
    logger.info(
      { deleted: deleted.length, cutoff: new Date(cutoffSec * 1000).toISOString() },
      '[Scheduler] sliding window prune',
    );

    // 3. Обучаем модель
    const trainRun = await runPnpmScript('train:model');
    logger.info({ code: trainRun.code, tail: trainRun.tail }, '[Scheduler] train:model done');
    if (trainRun.code !== 0) {
      throw new Error(`train:model failed: ${trainRun.tail}`);
    }

    // 4. Перезагружаем прематч-модель в память сервера (без рестарта)
    await loadActiveModel();

    // 5. Тренируем live-модель (на собранных live_snapshots × prematch_outcomes).
    //    Падение этого шага НЕ блокирует пайплайн — у молодой системы
    //    может ещё не быть достаточно резолвленных снапшотов.
    try {
      const liveTrainRun = await runPnpmScript('train:live-model');
      logger.info({ code: liveTrainRun.code, tail: liveTrainRun.tail }, '[Scheduler] train:live-model done');
      if (liveTrainRun.code === 0) {
        await loadActiveLiveModel();
      } else {
        logger.warn({ tail: liveTrainRun.tail }, '[Scheduler] train:live-model returned non-zero, skipping reload');
      }
    } catch (err) {
      logger.warn({ err: String(err) }, '[Scheduler] train:live-model failed (non-fatal)');
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
        trainTail: trainRun.tail,
        prunedOldMatches: deleted.length,
        windowDays: TRAIN_WINDOW_DAYS,
      },
    });

    logger.info({ reason, durationMs: Date.now() - startedAt.getTime() }, '[Scheduler] retrain success');
    return true;
  } catch (err) {
    stats.totalRetrainFailed++;
    stats.lastRetrainResult = `error: ${String(err)}`;
    stats.lastError = String(err);
    await updateState({ lastError: String(err) });
    logger.error({ err }, '[Scheduler] retrain failed');
    return false;
  } finally {
    runInFlight = false;
  }
}

/**
 * Решает, нужно ли запускать переобучение прямо сейчас.
 */
function shouldRetrainNow(state: typeof schedulerStateTable.$inferSelect | null): {
  retrain: boolean;
  reason: string;
} {
  if (!state) return { retrain: false, reason: 'no state row yet' };
  const now = Date.now();

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
  const decision = shouldRetrainNow(state);
  if (decision.retrain) {
    // Не блокируем тикер — запускаем фоном
    void runRetrainPipeline(decision.reason);
  } else {
    logger.debug({ reason: decision.reason }, '[Scheduler] retrain not needed');
  }
}

async function scheduleNextTick(delayMs: number): Promise<void> {
  if (stopRequested) return;
  timeoutId = setTimeout(async () => {
    if (stopRequested) return;
    try {
      await tickOnce();
    } catch (err) {
      logger.error({ err }, '[Scheduler] tick error');
      stats.lastError = String(err);
    } finally {
      void scheduleNextTick(CHECK_INTERVAL_MS);
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
 * Возвращает полное состояние шедулера из БД для эндпоинта статуса.
 */
export async function getSchedulerState() {
  return loadState();
}
