/**
 * Общий helper для OD-ingest скриптов E1.
 * Throttle 50ms = 20 req/s — безопасно ниже premium лимита 50 req/s.
 * Таймауты, авторизация и подсчёт ошибок — здесь.
 */
import { withOpenDotaKey, odThrottleMs } from './openDotaUrl.js';

export const OD_BASE = 'https://api.opendota.com/api';
export const DELAY_MS = odThrottleMs(50);
export const TIMEOUT_MS = 15_000;

export async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Возвращает JSON или null если 404 (т.е. OD не знает такой ID).
 * Кидает Error на остальные не-200.
 */
export async function fetchOdJson<T = unknown>(path: string, timeoutMs = TIMEOUT_MS): Promise<T | null> {
  const url = withOpenDotaKey(`${OD_BASE}${path}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return (await res.json()) as T;
}
