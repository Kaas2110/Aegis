/**
 * BackgroundPoller — единая точка фонового опроса внешних источников.
 *
 * Задача: убрать «client-pulled» обращения к PandaScore/OpenDota из горячего
 * пути мобильного клиента. Раньше каждый открытый экран приложения дёргал
 * `/api/matches/upcoming` → синхронный fetch на PandaScore (60с кэш). При
 * нескольких клиентах это сжигало квоту и давало 600-1500мс латенсии на
 * первом клиенте.
 *
 * Теперь:
 *   - Раз в `UPCOMING_INTERVAL_MS` (30 мин) ходим в PandaScore /upcoming,
 *     складываем результат в memory-cache.
 *   - Для каждого матча с известными командами (есть в `teams`) сразу же
 *     считаем ML-прогноз и кладём его рядом — клиент получает «matches +
 *     прогнозы» без дополнительного запроса.
 *   - `/api/matches/upcoming` читает из этого кэша мгновенно. Если кэш ещё
 *     не прогрет (первые 30с после старта) — fallback на прямой fetch.
 *
 * Управление через ENV:
 *   DISABLE_BACKGROUND_POLLER=true — выключить целиком.
 *   POLL_UPCOMING_MIN=30 — интервал опроса PandaScore upcoming (минут).
 *
 * Архитектурно: stateless модуль, без БД. Если процесс рестартует — кэш
 * прогревается заново на старте (см. `kickoffPollers()` в index.ts).
 */

import { logger } from '../lib/logger';
import { db, teamsTable } from '@workspace/db';
import { or, ilike, sql, desc } from 'drizzle-orm';
import { getApiKey } from './ApiKeysService';
import { predictMatchWinner } from './PredictionModel';
import { autoIngestTeamBackground } from './TeamAutoIngestor';

const PANDASCORE_BASE = 'https://api.pandascore.co';

// Интервалы опроса. Значения подобраны под ToS источников и реальную скорость
// изменения данных:
//   - Прематч-расписание PandaScore меняется раз в часы (новые турниры/реролы).
//     30 мин — золотая середина: свежо для пользователя, но щадит квоту (≈48
//     запросов в сутки против 86k раньше при 60с кэше + 10 RPS клиентов).
const UPCOMING_INTERVAL_MS = (() => {
  const env = Number(process.env['POLL_UPCOMING_MIN']);
  return Number.isFinite(env) && env >= 5 ? env * 60_000 : 30 * 60_000;
})();

// Фолбэк-задержка между ретраями при ошибке PandaScore.
const RETRY_AFTER_ERROR_MS = 5 * 60_000;

// ── State ────────────────────────────────────────────────────────────────

/** PandaScore upcoming match (упрощённая форма, нам достаточно полей для UI). */
export interface UpcomingMatchRaw {
  id: number;
  begin_at: string | null;
  number_of_games?: number;
  league?: { id?: number; name?: string };
  league_name?: string;
  serie?: { full_name?: string };
  tournament?: { name?: string };
  opponents?: Array<{ opponent?: { id?: number; name?: string; image_url?: string } }>;
  status?: string;
}

export interface PrematchPrediction {
  radiantTeamId: number;
  direTeamId: number;
  radiantTeamName: string;
  direTeamName: string;
  radiantWinProbability: number;
  modelVersion: string;
  featuresVersion: 1 | 2 | 3;
  computedAt: string;
}

interface UpcomingCacheEntry {
  matches: UpcomingMatchRaw[];
  // Прогнозы привязаны к pandascore match.id (не к OpenDota match_id).
  predictions: Map<number, PrematchPrediction>;
  fetchedAt: number;
  isMock: boolean;
  error?: string;
}

let upcomingCache: UpcomingCacheEntry | null = null;
let upcomingTimer: ReturnType<typeof setTimeout> | null = null;
let stopRequested = false;

// ── Public API (читается из routes) ──────────────────────────────────────

export interface UpcomingSnapshot {
  matches: UpcomingMatchRaw[];
  predictions: PrematchPrediction[];
  fetchedAt: string | null;
  ageSec: number | null;
  isMock: boolean;
  error?: string;
}

/**
 * Возвращает текущий снэпшот upcoming-матчей с прогнозами.
 * Если кэш ещё не прогрет — вернёт `{ matches: [], fetchedAt: null }`,
 * пусть роут сам решит делать fallback или нет.
 */
export function getUpcomingSnapshot(): UpcomingSnapshot {
  if (!upcomingCache) {
    return { matches: [], predictions: [], fetchedAt: null, ageSec: null, isMock: false };
  }
  const ageSec = Math.floor((Date.now() - upcomingCache.fetchedAt) / 1000);
  return {
    matches: upcomingCache.matches,
    predictions: Array.from(upcomingCache.predictions.values()),
    fetchedAt: new Date(upcomingCache.fetchedAt).toISOString(),
    ageSec,
    isMock: upcomingCache.isMock,
    ...(upcomingCache.error ? { error: upcomingCache.error } : {}),
  };
}

/** Прогноз по конкретному pandascore match.id, если уже посчитан. */
export function getPredictionForUpcoming(pandascoreMatchId: number): PrematchPrediction | null {
  return upcomingCache?.predictions.get(pandascoreMatchId) ?? null;
}

// ── Polling implementation ───────────────────────────────────────────────

async function fetchUpcomingFromPandascore(): Promise<UpcomingMatchRaw[]> {
  const token = getApiKey('PANDASCORE_API_KEY');
  if (!token) throw new Error('PANDASCORE_API_KEY not configured');

  const url = new URL(`${PANDASCORE_BASE}/dota2/matches/upcoming`);
  url.searchParams.set('token', token);
  url.searchParams.set('page[size]', '50');
  url.searchParams.set('sort', 'begin_at');
  url.searchParams.set('filter[status]', 'not_started');

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(url.toString(), { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`PandaScore HTTP ${resp.status}`);
    const data = (await resp.json()) as UpcomingMatchRaw[];
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Резолвит имя команды → teamId через локальную таблицу teams.
 * Возвращает null если команды нет (тогда прогноз не считаем — сначала
 * автоингест добьёт её через TeamAutoIngestor, и в следующем тике успеем).
 */
async function resolveTeamByName(name: string): Promise<{ teamId: number; name: string } | null> {
  const q = name.trim();
  if (q.length < 2) return null;

  // 1) Сначала пробуем точное (case-insensitive) совпадение по name или tag.
  //    Это критично, т.к. ilike '%Team Spirit%' схватит и «Team Spirit Academy»
  //    с близким рейтингом → прогноз пойдёт по чужой команде.
  const exact = await db
    .select({ teamId: teamsTable.teamId, name: teamsTable.name, rating: teamsTable.rating })
    .from(teamsTable)
    .where(or(
      sql`lower(${teamsTable.name}) = ${q.toLowerCase()}`,
      sql`lower(${teamsTable.tag}) = ${q.toLowerCase()}`,
    ))
    .orderBy(desc(teamsTable.rating))
    .limit(1);
  if (exact[0]) return { teamId: exact[0].teamId, name: exact[0].name ?? q };

  // 2) Fuzzy fallback (ilike). Используется только если точного совпадения нет.
  const fuzzy = await db
    .select({ teamId: teamsTable.teamId, name: teamsTable.name, rating: teamsTable.rating })
    .from(teamsTable)
    .where(or(ilike(teamsTable.name, `%${q}%`), ilike(teamsTable.tag, `%${q}%`)))
    .orderBy(desc(teamsTable.rating))
    .limit(1);
  const r = fuzzy[0];
  return r ? { teamId: r.teamId, name: r.name ?? q } : null;
}

// Период, после которого «застрявший» кэш считается протухшим и /upcoming
// должен фолбэкнуться на прямой fetch вместо отдачи устаревших матчей.
// Подобрано как 4× штатный интервал поллинга — это даёт несколько шансов
// на восстановление PandaScore до того, как мы покажем пользователю мусор.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 часа

/** Возвращает true, если фоновый кэш слишком стар чтобы ему доверять. */
export function isUpcomingSnapshotStale(): boolean {
  if (!upcomingCache) return true;
  return Date.now() - upcomingCache.fetchedAt > STALE_AFTER_MS;
}

/**
 * Считает ML-прогноз для одного upcoming-матча. Возвращает null если:
 *   - хотя бы одна команда не нашлась в БД (TeamAutoIngestor добьёт фоном);
 *   - модель не загружена / у команд недостаточно матчей (<5).
 */
async function computePredictionForMatch(
  m: UpcomingMatchRaw,
): Promise<PrematchPrediction | null> {
  const opps = m.opponents ?? [];
  const t1Name = (opps[0]?.opponent?.name ?? '').trim();
  const t2Name = (opps[1]?.opponent?.name ?? '').trim();
  if (!t1Name || !t2Name) return null;

  const [t1, t2] = await Promise.all([resolveTeamByName(t1Name), resolveTeamByName(t2Name)]);
  if (!t1 || !t2 || t1.teamId === t2.teamId) return null;

  // PandaScore не даёт нам сторону Radiant/Dire до старта матча. Считаем
  // прогноз как «t1 wins», условно отображая t1 = Radiant. На UI это
  // соответствует «П1» = первая команда из PandaScore.opponents.
  const result = await predictMatchWinner(t1.teamId, t2.teamId, null);
  if (!result) return null;

  return {
    radiantTeamId: t1.teamId,
    direTeamId: t2.teamId,
    radiantTeamName: t1.name,
    direTeamName: t2.name,
    radiantWinProbability: result.probRadiantWin,
    modelVersion: result.modelVersion,
    featuresVersion: result.featuresVersion,
    computedAt: new Date().toISOString(),
  };
}

async function pollUpcomingOnce(): Promise<void> {
  const start = Date.now();
  try {
    const matches = await fetchUpcomingFromPandascore();
    logger.info({ count: matches.length }, '[BackgroundPoller] fetched upcoming');

    // Триггерим фоновой автоингест незнакомых команд (fire-and-forget).
    // К следующему тику (через 30 мин) они уже будут в БД и попадут в прогноз.
    for (const m of matches) {
      const t1 = m.opponents?.[0]?.opponent?.name?.trim();
      const t2 = m.opponents?.[1]?.opponent?.name?.trim();
      if (t1) autoIngestTeamBackground(t1);
      if (t2) autoIngestTeamBackground(t2);
    }

    // Считаем прогнозы параллельно, но ограниченным concurrency=4 чтобы не
    // насиловать БД (каждый прогноз делает ~3 selects: teams + ratings).
    const predictions = new Map<number, PrematchPrediction>();
    const queue = [...matches];
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length > 0) {
        const m = queue.shift();
        if (!m) break;
        try {
          const p = await computePredictionForMatch(m);
          if (p) predictions.set(m.id, p);
        } catch (err) {
          logger.debug({ err, matchId: m.id }, '[BackgroundPoller] predict failed');
        }
      }
    });
    await Promise.all(workers);

    upcomingCache = {
      matches,
      predictions,
      fetchedAt: Date.now(),
      isMock: false,
    };
    logger.info({
      matches: matches.length,
      predicted: predictions.size,
      durationMs: Date.now() - start,
    }, '[BackgroundPoller] upcoming snapshot ready');
  } catch (err) {
    logger.warn({ err }, '[BackgroundPoller] upcoming poll failed');
    // Не затираем валидный кэш на ошибке — оставляем последний успешный снэпшот.
    if (!upcomingCache) {
      upcomingCache = {
        matches: [],
        predictions: new Map(),
        fetchedAt: Date.now(),
        isMock: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function scheduleNext(delayMs: number): void {
  if (stopRequested) return;
  upcomingTimer = setTimeout(async () => {
    await pollUpcomingOnce();
    scheduleNext(upcomingCache?.error ? RETRY_AFTER_ERROR_MS : UPCOMING_INTERVAL_MS);
  }, delayMs);
  // unref чтобы не держать процесс живым в тестах
  upcomingTimer.unref?.();
}

export function startBackgroundPoller(): void {
  if (process.env['DISABLE_BACKGROUND_POLLER'] === 'true') {
    logger.warn('[BackgroundPoller] disabled via DISABLE_BACKGROUND_POLLER=true');
    return;
  }
  if (!getApiKey('PANDASCORE_API_KEY')) {
    logger.warn('[BackgroundPoller] PANDASCORE_API_KEY not set — upcoming polling skipped');
    return;
  }
  logger.info({ intervalMin: UPCOMING_INTERVAL_MS / 60_000 }, '[BackgroundPoller] starting');
  // Первый тик через 5с, чтобы дать ApiKeys/модели прогреться.
  scheduleNext(5_000);
}

export function stopBackgroundPoller(): void {
  stopRequested = true;
  if (upcomingTimer) {
    clearTimeout(upcomingTimer);
    upcomingTimer = null;
  }
}
