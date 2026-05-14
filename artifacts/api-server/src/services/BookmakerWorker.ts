/**
 * BookmakerWorker — адаптивный фоновый поллер букмекерских источников.
 *
 * Интервал зависит от наличия live-матчей:
 *   - есть live (хотя бы 1 в /api/matches/live) → 3 минуты
 *   - нет live                                  → 60 минут
 *
 * Воркер пишет результаты в общий кэш `routes/bookmakers.ts` (TTL 65 мин),
 * эндпоинты `/api/bookmakers/*` читают из этого кэша. Per-source ошибки
 * скипаются silently — берём то что собрали.
 *
 * Disable: `DISABLE_BOOKMAKER_WORKER=true`. Также не стартует если
 * `BOOKMAKERS_ENABLED=false`.
 */
import { logger } from '../lib/logger';
import { fetchSource, getAllSourceIds, isBookmakersEnabled } from '../routes/bookmakers';
import { peekCache } from '../lib/responseCache';

const POLL_INTERVAL_LIVE_MS = 3 * 60_000;
const POLL_INTERVAL_IDLE_MS = 60 * 60_000;
// Первый tick задержан, чтобы кэш `matches:live` успел прогреться (мобилка
// или админка обычно стучатся в первые 5-10s после старта). Иначе peekCache
// вернёт undefined → mode всегда idle на cold start.
const STARTUP_DELAY_MS = 30_000;

type SourceStat = { source: string; events: number; error: string | null; durationMs: number };
type WorkerStats = {
  startedAt: string | null;
  lastTickAt: string | null;
  lastMode: 'live' | 'idle' | null;
  lastIntervalMs: number | null;
  lastDurationMs: number | null;
  lastSources: SourceStat[];
  ticks: number;
  errors: number;
};

const stats: WorkerStats = {
  startedAt: null,
  lastTickAt: null,
  lastMode: null,
  lastIntervalMs: null,
  lastDurationMs: null,
  lastSources: [],
  ticks: 0,
  errors: 0,
};

let timer: NodeJS.Timeout | null = null;
let stopped = false;

function liveMatchCount(): number {
  // Peek-only: НЕ дёргаем апстрим и НЕ заполняем кэш. Если кэш ещё пустой
  // (никто не запрашивал /matches/live), считаем что live=0 → idle режим;
  // следующий tick подтянет когда кэш прогреется.
  // Реальная форма /matches/live: { sources: [{source,data:[]|null,error?}], pandascoreRunning: number, noData: bool }.
  // Берём максимум среди источников — не суммируем (один и тот же матч есть и в opendota, и в pandascore).
  const payload = peekCache<{
    sources?: Array<{ source: string; data: unknown }>;
    pandascoreRunning?: number;
  }>('matches:live');
  if (!payload) return 0;
  let maxN = 0;
  for (const s of payload.sources ?? []) {
    if (Array.isArray(s.data) && s.data.length > maxN) maxN = s.data.length;
  }
  if (typeof payload.pandascoreRunning === 'number' && payload.pandascoreRunning > maxN) {
    maxN = payload.pandascoreRunning;
  }
  return maxN;
}

async function tick(): Promise<void> {
  if (stopped) return;
  const t0 = Date.now();
  const liveN = liveMatchCount();
  const mode: 'live' | 'idle' = liveN > 0 ? 'live' : 'idle';
  const interval = mode === 'live' ? POLL_INTERVAL_LIVE_MS : POLL_INTERVAL_IDLE_MS;

  const sources = getAllSourceIds();
  const results = await Promise.all(
    sources.map(async (s) => {
      const ts = Date.now();
      try {
        const r = await fetchSource(s, { force: true });
        return {
          source: s,
          events: r.events.length,
          error: r.error ?? null,
          durationMs: Date.now() - ts,
        } as SourceStat;
      } catch (err) {
        // fetchSource уже не должен бросать (заворачивает в SourceResponse), но на всякий
        const msg = err instanceof Error ? err.message : String(err);
        return { source: s, events: 0, error: msg, durationMs: Date.now() - ts } as SourceStat;
      }
    }),
  );

  const totalEvents = results.reduce((a, r) => a + r.events, 0);
  const failed = results.filter((r) => r.error).length;
  const durationMs = Date.now() - t0;

  stats.lastTickAt = new Date().toISOString();
  stats.lastMode = mode;
  stats.lastIntervalMs = interval;
  stats.lastDurationMs = durationMs;
  stats.lastSources = results;
  stats.ticks += 1;
  if (failed > 0) stats.errors += failed;

  logger.info(
    {
      tag: 'bookmaker-worker',
      mode,
      liveMatches: liveN,
      intervalMs: interval,
      durationMs,
      totalEvents,
      sourcesOk: results.length - failed,
      sourcesFailed: failed,
      sources: results,
    },
    '[bookmaker-worker] tick complete',
  );

  scheduleNext(interval);
}

function scheduleNext(ms: number): void {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    tick().catch((err) => {
      stats.errors += 1;
      logger.error({ err }, '[bookmaker-worker] tick error');
      // даже при ошибке планируем следующий tick (idle interval, чтобы не долбить)
      scheduleNext(POLL_INTERVAL_IDLE_MS);
    });
  }, ms);
}

export function startBookmakerWorker(): void {
  if (process.env['DISABLE_BOOKMAKER_WORKER'] === 'true') {
    logger.warn('[bookmaker-worker] disabled via DISABLE_BOOKMAKER_WORKER=true');
    return;
  }
  if (!isBookmakersEnabled()) {
    logger.info('[bookmaker-worker] not started: BOOKMAKERS_ENABLED=false');
    return;
  }
  stopped = false;
  stats.startedAt = new Date().toISOString();
  logger.info(
    {
      liveIntervalMs: POLL_INTERVAL_LIVE_MS,
      idleIntervalMs: POLL_INTERVAL_IDLE_MS,
      startupDelayMs: STARTUP_DELAY_MS,
    },
    '[bookmaker-worker] starting',
  );
  // Первый tick через STARTUP_DELAY_MS — даём кэшу matches:live прогреться.
  scheduleNext(STARTUP_DELAY_MS);
}

export function stopBookmakerWorker(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function getBookmakerWorkerStats(): WorkerStats {
  return { ...stats, lastSources: [...stats.lastSources] };
}
