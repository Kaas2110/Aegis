/**
 * Helper для добавления OpenDota API key к URL.
 * Без ключа: 60 req/min, 3000 req/day (Replit-IP регулярно ловит 429).
 * Premium key: 3000 req/min (50 req/s), неограниченно/месяц,
 *   $0.0001/req (404/429/500 не тарифицируются).
 *
 * Использование:
 *   const url = withOpenDotaKey(`${OPENDOTA_BASE}/matches/${id}`);
 *   const r = await fetch(url);
 *
 * Idempotent: если ключа в env нет — URL возвращается без изменений.
 *
 * Встроенный cost-tracker: каждый вызов withOpenDotaKey() регистрирует
 * 1 запрос. Статистику можно получить через getOdUsageStats().
 * Счётчики — in-memory (сбрасываются при рестарте, для точного учёта
 * смотри dashboard api.opendota.com). Стоимость: $0.0001/запрос при
 * наличии ключа.
 */

interface DayBucket {
  count: number;
  date: string; // YYYY-MM-DD
}

// До 30 суток rolling history
const HISTORY_DAYS = 30;
const dailyBuckets: Map<string, DayBucket> = new Map();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function recordOdCall(): void {
  const key = todayKey();
  const existing = dailyBuckets.get(key);
  if (existing) {
    existing.count++;
  } else {
    dailyBuckets.set(key, { count: 1, date: key });
    // Прунинг старых дней
    const keys = [...dailyBuckets.keys()].sort();
    while (keys.length > HISTORY_DAYS) {
      const oldest = keys.shift()!;
      dailyBuckets.delete(oldest);
    }
  }
}

export interface OdUsageStats {
  today: number;
  last7d: number;
  last30d: number;
  estimatedCostUsdToday: number;
  estimatedCostUsdLast30d: number;
  hasKey: boolean;
  history: Array<{ date: string; count: number; estimatedCostUsd: number }>;
  note: string;
}

const COST_PER_REQ = 0.0001; // $0.0001 за запрос

export function getOdUsageStats(): OdUsageStats {
  const today = todayKey();
  const todayCount = dailyBuckets.get(today)?.count ?? 0;

  const sortedDays = [...dailyBuckets.values()].sort((a, b) => a.date.localeCompare(b.date));

  const nowMs = Date.now();
  const last7dCutoff = new Date(nowMs - 7 * 86400_000).toISOString().slice(0, 10);
  const last7d = sortedDays.filter((d) => d.date >= last7dCutoff).reduce((s, d) => s + d.count, 0);
  const last30d = sortedDays.reduce((s, d) => s + d.count, 0);

  return {
    today: todayCount,
    last7d,
    last30d,
    estimatedCostUsdToday: +(todayCount * COST_PER_REQ).toFixed(4),
    estimatedCostUsdLast30d: +(last30d * COST_PER_REQ).toFixed(4),
    hasKey: hasOpenDotaKey(),
    history: sortedDays.map((d) => ({
      date: d.date,
      count: d.count,
      estimatedCostUsd: +(d.count * COST_PER_REQ).toFixed(4),
    })),
    note: 'In-memory only — сбрасывается при рестарте api-server. Точный счёт на api.opendota.com.',
  };
}

export function withOpenDotaKey(url: string): string {
  recordOdCall();
  const key = process.env.OPENDOTA_API_KEY;
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(key)}`;
}

export function hasOpenDotaKey(): boolean {
  return Boolean(process.env.OPENDOTA_API_KEY);
}
