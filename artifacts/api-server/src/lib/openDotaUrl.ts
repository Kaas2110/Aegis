/**
 * Helper для добавления OpenDota API key к URL + бюджетный guard free-режима.
 *
 * Режим (free/premium) управляется:
 *   1. env OPENDOTA_USE_PREMIUM (если задан — приоритет, как на ноуте из .env);
 *   2. app_settings.opendota_premium (тогл на дашборде админки, hot-reload ≤30s);
 *   3. дефолт — free.
 * Premium дополнительно требует OPENDOTA_API_KEY в env.
 *
 * Free tier: 60 req/min, 3000 req/day на IP (429 не тарифицируются).
 * Premium: 3000 req/min (50 req/s), $0.0001/req.
 *
 * Бюджетный guard (только free-режим):
 *   - минутное окно: максимум 55 req/min (запас от лимита 60);
 *   - дневной cap: app_settings.od_daily_limit (дефолт 3000);
 *   - фоновые вызовы ('background': OutcomeTracker, SchedulerWorker)
 *     дополнительно ограничены часовым бюджетом dailyLimit/24, чтобы квота
 *     размазывалась на весь день и user-facing путь ('user': live-роуты,
 *     LiveWorker) не оставался без квоты к вечеру.
 *
 * Использование:
 *   if (!tryAcquireOd('user')) { ...skip/фолбэк... }
 *   const r = await fetch(withOpenDotaKey(`${OPENDOTA_BASE}/matches/${id}`));
 *
 * Счётчики in-memory (сбрасываются при рестарте) — для точного учёта
 * см. dashboard api.opendota.com.
 */

interface DayBucket {
  count: number;
  date: string; // YYYY-MM-DD
}

// До 30 суток rolling history
const HISTORY_DAYS = 30;
const dailyBuckets: Map<string, DayBucket> = new Map();

// Минутное скользящее окно (timestamps последних вызовов)
const MINUTE_LIMIT_FREE = 55;
let minuteWindow: number[] = [];

// Часовой бакет для фоновых вызовов (free-режим)
let hourKey = '';
let hourCount = 0;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentHourKey(): string {
  return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

function pruneMinuteWindow(now: number): void {
  const cutoff = now - 60_000;
  if (minuteWindow.length && minuteWindow[0]! < cutoff) {
    minuteWindow = minuteWindow.filter((t) => t >= cutoff);
  }
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
  const now = Date.now();
  pruneMinuteWindow(now);
  minuteWindow.push(now);
  const hk = currentHourKey();
  if (hk !== hourKey) {
    hourKey = hk;
    hourCount = 0;
  }
  hourCount++;
}

// ── Runtime-конфиг из app_settings (пушится AppSettings-сервисом) ─────────
let dbPremium: boolean | null = null;
let dbDailyLimit = 3000;

export function setOdRuntimeConfig(cfg: { premium: boolean | null; dailyLimit: number }): void {
  dbPremium = cfg.premium;
  if (Number.isFinite(cfg.dailyLimit) && cfg.dailyLimit > 0) dbDailyLimit = cfg.dailyLimit;
}

export type OdPremiumSource = 'env' | 'db' | 'default';

function premiumDecision(): { premium: boolean; source: OdPremiumSource } {
  const hasKey = !!process.env.OPENDOTA_API_KEY;
  const env = process.env.OPENDOTA_USE_PREMIUM;
  if (env !== undefined && env !== '') {
    return { premium: env === 'true' && hasKey, source: 'env' };
  }
  if (dbPremium !== null) {
    return { premium: dbPremium && hasKey, source: 'db' };
  }
  return { premium: false, source: 'default' };
}

export function isOpenDotaPremium(): boolean {
  return premiumDecision().premium;
}

// ── Бюджетный guard ────────────────────────────────────────────────────────
export type OdCallKind = 'user' | 'background';

function hourlyBudget(): number {
  return Math.max(25, Math.floor(dbDailyLimit / 24));
}

/**
 * Проверяет, можно ли сейчас сделать OD-запрос (free-режим).
 * НЕ потребляет бюджет — учёт делает withOpenDotaKey() при реальном вызове.
 * Premium — всегда true.
 */
export function tryAcquireOd(kind: OdCallKind): boolean {
  if (isOpenDotaPremium()) return true;
  const now = Date.now();
  pruneMinuteWindow(now);
  if (minuteWindow.length >= MINUTE_LIMIT_FREE) return false;
  const todayCount = dailyBuckets.get(todayKey())?.count ?? 0;
  if (todayCount >= dbDailyLimit) return false;
  if (kind === 'background') {
    const hk = currentHourKey();
    const used = hk === hourKey ? hourCount : 0;
    if (used >= hourlyBudget()) return false;
  }
  return true;
}

export interface OdUsageStats {
  today: number;
  last7d: number;
  last30d: number;
  estimatedCostUsdToday: number;
  estimatedCostUsdLast30d: number;
  hasKey: boolean;
  premium: boolean;
  premiumSource: OdPremiumSource;
  freeBudget: {
    dailyLimit: number;
    usedToday: number;
    minuteUsed: number;
    minuteLimit: number;
    hourUsed: number;
    hourBudget: number;
  };
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

  pruneMinuteWindow(nowMs);
  const decision = premiumDecision();

  return {
    today: todayCount,
    last7d,
    last30d,
    estimatedCostUsdToday: +(todayCount * COST_PER_REQ).toFixed(4),
    estimatedCostUsdLast30d: +(last30d * COST_PER_REQ).toFixed(4),
    hasKey: decision.premium,
    premium: decision.premium,
    premiumSource: decision.source,
    freeBudget: {
      dailyLimit: dbDailyLimit,
      usedToday: todayCount,
      minuteUsed: minuteWindow.length,
      minuteLimit: MINUTE_LIMIT_FREE,
      hourUsed: currentHourKey() === hourKey ? hourCount : 0,
      hourBudget: hourlyBudget(),
    },
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
  if (!isOpenDotaPremium()) return url;
  const key = process.env.OPENDOTA_API_KEY!;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(key)}`;
}

export function hasOpenDotaKey(): boolean {
  return isOpenDotaPremium();
}
