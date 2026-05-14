/**
 * Простой in-memory TTL-кэш для ответов upstream-эндпоинтов
 * (OpenDota /api/live, PandaScore /upcoming, /heroes, /heroStats).
 *
 * Зачем:
 *   - Мобильный клиент опрашивает /api/matches/live каждые 60с при ~N клиентах
 *     → N запросов к OpenDota в минуту, упираемся в их rate-limit (60 req/min).
 *   - Подавляющее большинство клиентов получают одни и те же данные — кэшируем
 *     ответ на 30-60с и режем нагрузку до 1 upstream-запроса в минуту,
 *     независимо от числа клиентов.
 *   - Single-flight: пока первый запрос ждёт upstream, остальные идут в общую
 *     pending-promise и не плодят дубль-запросы.
 *
 * Это процессо-локальный кэш. Для multi-instance деплоя нужен Redis (TODO).
 *
 * Логирование: каждый вызов пишет hit / miss / coalesced + длительность
 * upstream-fetch'а — на проде это даёт точную картину «какой кэш работает,
 * какой постоянно протухает». См. tag `[cache]` в логах.
 */

import { logger } from './logger';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

// Жёсткий потолок на случай, если withCache когда-нибудь начнут вызывать
// с динамическими ключами (matches:${id} и т.п.). Сейчас ключей 3 — это просто
// страховка от утечки памяти.
const MAX_ENTRIES = 256;

/**
 * @param shouldCache опциональный предикат — вернуть `false`, чтобы не кэшировать
 *   результат (например, если ответ содержит ошибки upstream или noData=true).
 *   По умолчанию кэшируется любой успешный результат.
 */
export async function withCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  shouldCache: (value: T) => boolean = () => true,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) {
    logger.debug({ key, ageMs: ttlMs - (hit.expiresAt - now) }, '[cache] hit');
    return hit.value;
  }

  // Single-flight: если уже идёт такой же fetch — ждём его, не плодим upstream.
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) {
    logger.debug({ key }, '[cache] coalesced');
    return pending;
  }

  logger.info({ key, ttlMs }, '[cache] miss');
  const startedAt = Date.now();
  const p = (async () => {
    try {
      const value = await fetcher();
      const durationMs = Date.now() - startedAt;
      const ok = shouldCache(value);
      logger.info({ key, durationMs, cached: ok }, '[cache] filled');
      if (ok) {
        // FIFO-вытеснение при достижении потолка: дёшево и достаточно
        // для нашего use-case (не дорогущий LRU, не нужен).
        if (cache.size >= MAX_ENTRIES) {
          const firstKey = cache.keys().next().value;
          if (firstKey !== undefined) cache.delete(firstKey);
        }
        cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      logger.warn({ key, durationMs, err: err instanceof Error ? err.message : String(err) }, '[cache] fetch failed');
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Только для тестов / админа: сбросить весь кэш. */
export function clearResponseCache(): void {
  const sizeBefore = cache.size;
  cache.clear();
  inflight.clear();
  logger.info({ sizeBefore }, '[cache] cleared');
}
