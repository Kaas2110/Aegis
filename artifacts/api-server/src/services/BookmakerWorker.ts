/**
 * BookmakerWorker — адаптивный фоновый поллер букмекерских источников.
 *
 * Три режима, выбираются динамически на каждом tick'е:
 *   - **live**           : есть хотя бы 1 live pro-матч → tick через 3 минуты
 *   - **wake_for_start** : live=0, но ближайший upcoming стартует в течение 60 мин →
 *                         tick на (start + 30s буфер на индексацию live API)
 *   - **idle**           : live=0 и нет upcoming в обозримом окне → tick через 60 минут
 *
 * Воркер **полностью автономен** — не зависит от трафика мобильного клиента.
 * Чтобы определить live count и ближайший upcoming, делает loopback HTTP-запрос
 * к собственному серверу (`/api/matches/live`, `/api/matches/upcoming`). Эти
 * эндпоинты идут через withCache, так что воркер сам прогревает общий кэш —
 * следующие запросы клиентов получают данные мгновенно.
 *
 * Воркер пишет результаты в общий per-source кэш `routes/bookmakers.ts` (TTL
 * 65 мин), эндпоинты `/api/bookmakers/*` читают из этого кэша. Per-source
 * ошибки скипаются silently — берём то что собрали.
 *
 * Disable: `DISABLE_BOOKMAKER_WORKER=true`. Также не стартует если
 * `BOOKMAKERS_ENABLED=false`.
 */
import { logger } from '../lib/logger';
import { fetchSource, getAllSourceIds, isBookmakersEnabled } from '../routes/bookmakers';

const POLL_INTERVAL_LIVE_MS = 3 * 60_000;
const POLL_INTERVAL_IDLE_MS = 60 * 60_000;
const MIN_DELAY_MS = 60_000;
// Если loopback fetch к /matches/live или /matches/upcoming упал (внутренний 5xx,
// timeout, IPv4/v6 mismatch и т.п.), не уходим в idle на час — возвращаемся
// через 3 минуты. Иначе транзиентный сбой создаёт «слепое окно» в 60 мин.
const POLL_INTERVAL_LOOPBACK_FAIL_MS = 3 * 60_000;
const WAKE_BUFFER_MS = 30_000; // ждём 30s после begin_at — даём live API проиндексировать матч
// Первый tick задержан, чтобы Express успел поднять listen и роуты были доступны.
const STARTUP_DELAY_MS = 5_000;
const LOOPBACK_TIMEOUT_MS = 10_000;
// Loopback hosts перебираем по очереди — IPv4 (127.0.0.1) → "localhost" (v4 или v6
// в зависимости от ОС) → IPv6 ([::1]). Удачный кешируется до следующего сбоя.
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const;
let cachedLoopbackHost: string | null = null;

type WorkerMode = 'live' | 'wake_for_start' | 'idle';
type SourceStat = { source: string; events: number; error: string | null; durationMs: number };
type WorkerStats = {
  startedAt: string | null;
  lastTickAt: string | null;
  lastMode: WorkerMode | null;
  lastIntervalMs: number | null;
  lastDurationMs: number | null;
  lastSources: SourceStat[];
  lastLiveCount: number | null;
  lastNextStartAt: string | null;
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
  lastLiveCount: null,
  lastNextStartAt: null,
  ticks: 0,
  errors: 0,
};

let timer: NodeJS.Timeout | null = null;
let stopped = false;

/**
 * Loopback fetch с автоматическим перебором IPv4/v6 хостов. Возвращает
 * `{ data: T }` при успехе или `{ error: string }` при сбое — caller'у важно
 * различать «всё ок, данных нет» и «loopback сломался» (для адаптивного backoff).
 */
async function loopbackFetch<T>(path: string): Promise<{ data: T } | { error: string }> {
  const port = process.env['PORT'] ?? '8080';
  const hosts = cachedLoopbackHost
    ? [cachedLoopbackHost, ...LOOPBACK_HOSTS.filter((h) => h !== cachedLoopbackHost)]
    : [...LOOPBACK_HOSTS];
  let lastErr = 'unknown';
  for (const host of hosts) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), LOOPBACK_TIMEOUT_MS);
    try {
      const resp = await fetch(`http://${host}:${port}${path}`, { signal: ctrl.signal });
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}`;
        continue;
      }
      cachedLoopbackHost = host;
      return { data: (await resp.json()) as T };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(to);
    }
  }
  logger.warn({ path, lastErr, tag: 'bookmaker-worker' }, '[bookmaker-worker] loopback fetch failed on all hosts');
  return { error: lastErr };
}

/**
 * Считает количество live pro-матчей через loopback к /matches/live (withCache 30s).
 * Возвращает `null` при сбое loopback — caller использует это для короткого backoff.
 *
 * Форма /matches/live: { sources: [{source,data:[]|null,error?}], pandascoreRunning, noData }.
 * Берём максимум среди источников — не суммируем (один и тот же матч есть и в
 * opendota, и в pandascore).
 */
async function fetchLiveCount(): Promise<number | null> {
  const r = await loopbackFetch<{
    sources?: Array<{ source: string; data: unknown }>;
    pandascoreRunning?: number;
  }>('/api/matches/live');
  if ('error' in r) return null;
  const payload = r.data;
  let maxN = 0;
  for (const s of payload.sources ?? []) {
    if (Array.isArray(s.data) && s.data.length > maxN) maxN = s.data.length;
  }
  if (typeof payload.pandascoreRunning === 'number' && payload.pandascoreRunning > maxN) {
    maxN = payload.pandascoreRunning;
  }
  return maxN;
}

/**
 * Находит ближайший upcoming матч с begin_at > now через loopback (withCache 60s).
 * Возвращает `{ ms: number | null }` если loopback ок (ms=null если матчей нет),
 * либо `{ error: string }` если loopback сломался — caller использует для backoff.
 */
async function fetchNextUpcomingStartMs(): Promise<{ ms: number | null } | { error: string }> {
  const r = await loopbackFetch<{
    noData?: boolean;
    data?: Array<{ begin_at?: string | null; scheduled_at?: string | null }>;
  }>('/api/matches/upcoming');
  if ('error' in r) return { error: r.error };
  const payload = r.data;
  if (payload.noData) return { ms: null };
  const items = Array.isArray(payload.data) ? payload.data : [];
  const now = Date.now();
  let nearest: number | null = null;
  for (const m of items) {
    const iso = m.begin_at ?? m.scheduled_at;
    if (!iso) continue;
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t <= now) continue;
    if (nearest === null || t < nearest) nearest = t;
  }
  return { ms: nearest };
}

/**
 * Вычисляет задержку до следующего tick'а.
 *
 * Семантика clamp'а:
 *   live           → ровно POLL_INTERVAL_LIVE_MS (3 мин).
 *   wake_for_start → max(MIN_DELAY_MS=60s, min(POLL_INTERVAL_IDLE_MS=60min, start+30s)).
 *                    Если start уже произошёл / в ближайшие <30s, поднимаем минимум
 *                    до 60s чтобы не флудить апстрим. Верхний клемп 60min нужен
 *                    как страховка (caller выбирает wake_for_start только если
 *                    msToStart<60min, так что обычно не сработает).
 *   idle           → POLL_INTERVAL_IDLE_MS (60 мин).
 */
function computeNextDelay(mode: WorkerMode, nextStartMs: number | null): number {
  if (mode === 'live') return POLL_INTERVAL_LIVE_MS;
  if (mode === 'wake_for_start' && nextStartMs !== null) {
    const delay = nextStartMs - Date.now() + WAKE_BUFFER_MS;
    return Math.max(MIN_DELAY_MS, Math.min(POLL_INTERVAL_IDLE_MS, delay));
  }
  return POLL_INTERVAL_IDLE_MS;
}

async function tick(): Promise<void> {
  if (stopped) return;
  const t0 = Date.now();

  // 1. Определяем режим: сначала live count, при необходимости — upcoming.
  // Если loopback fetch упал — выходим в специальный backoff (3 мин), не зависая
  // на 60-минутном idle при транзиентных сбоях /matches/* эндпоинтов.
  const liveN = await fetchLiveCount();
  let mode: WorkerMode;
  let nextStartMs: number | null = null;
  let loopbackFailed = false;

  if (liveN === null) {
    loopbackFailed = true;
    mode = 'idle';
  } else if (liveN > 0) {
    mode = 'live';
  } else {
    const upcomingResult = await fetchNextUpcomingStartMs();
    if ('error' in upcomingResult) {
      loopbackFailed = true;
      mode = 'idle';
    } else {
      nextStartMs = upcomingResult.ms;
      if (nextStartMs !== null && nextStartMs - Date.now() < POLL_INTERVAL_IDLE_MS) {
        mode = 'wake_for_start';
      } else {
        mode = 'idle';
      }
    }
  }

  // 2. Опрашиваем все источники букмекеров параллельно.
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
        const msg = err instanceof Error ? err.message : String(err);
        return { source: s, events: 0, error: msg, durationMs: Date.now() - ts } as SourceStat;
      }
    }),
  );

  const totalEvents = results.reduce((a, r) => a + r.events, 0);
  const failed = results.filter((r) => r.error).length;
  const durationMs = Date.now() - t0;
  const interval = loopbackFailed
    ? POLL_INTERVAL_LOOPBACK_FAIL_MS
    : computeNextDelay(mode, nextStartMs);

  stats.lastTickAt = new Date().toISOString();
  stats.lastMode = mode;
  stats.lastIntervalMs = interval;
  stats.lastDurationMs = durationMs;
  stats.lastSources = results;
  stats.lastLiveCount = liveN;
  stats.lastNextStartAt = nextStartMs !== null ? new Date(nextStartMs).toISOString() : null;
  stats.ticks += 1;
  if (failed > 0) stats.errors += failed;

  logger.info(
    {
      tag: 'bookmaker-worker',
      mode,
      loopbackFailed,
      liveMatches: liveN,
      nextStartAt: stats.lastNextStartAt,
      msToNextStart: nextStartMs !== null ? nextStartMs - Date.now() : null,
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
      logger.error({ err, tag: 'bookmaker-worker' }, '[bookmaker-worker] tick error');
      // Даже при ошибке планируем следующий tick (idle interval, чтобы не флудить).
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
      wakeBufferMs: WAKE_BUFFER_MS,
      startupDelayMs: STARTUP_DELAY_MS,
    },
    '[bookmaker-worker] starting',
  );
  // Первый tick через STARTUP_DELAY_MS — даём Express подняться и принимать loopback.
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
