/**
 * Общий helper для OD-ingest скриптов E1.
 * Throttle 50ms = 20 req/s — безопасно ниже premium лимита 50 req/s.
 * Таймауты, авторизация и подсчёт ошибок — здесь.
 *
 * Circuit-breaker (аудит 2026-07-17): при исчерпании OD-квоты (free tier
 * 3000 req/day) скрипты раньше продолжали жечь квоту тысячами 429-запросов,
 * добивая и user-facing live-путь api-server'а. Теперь:
 *   - 1-й и 2-й 429 подряд → пауза 65s (возможен минутный лимит 60 req/min,
 *     в т.ч. от конкуренции с api-server на том же IP), запрос помечается failed;
 *   - 3-й 429 подряд → дневная квота исчерпана: circuit открывается на 30 мин,
 *     бросается OdQuotaExhaustedError, все последующие вызовы фейлятся сразу
 *     БЕЗ сетевых запросов. Скрипты должны ловить эту ошибку и прерывать цикл.
 */
import { withOpenDotaKey, odThrottleMs } from './openDotaUrl.js';

export const OD_BASE = 'https://api.opendota.com/api';
export const DELAY_MS = odThrottleMs(50);
export const TIMEOUT_MS = 15_000;

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30 * 60_000;
const MINUTE_WINDOW_PAUSE_MS = 65_000;

let consecutive429 = 0;
let circuitOpenUntil = 0;

/** Квота OpenDota исчерпана — вызывающий скрипт должен прервать свой цикл. */
export class OdQuotaExhaustedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'OdQuotaExhaustedError';
  }
}

export function isOdCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Возвращает JSON или null если 404 (т.е. OD не знает такой ID).
 * Кидает OdQuotaExhaustedError когда квота исчерпана (см. шапку файла).
 * Кидает Error на остальные не-200.
 */
export async function fetchOdJson<T = unknown>(path: string, timeoutMs = TIMEOUT_MS): Promise<T | null> {
  if (isOdCircuitOpen()) {
    const minLeft = Math.ceil((circuitOpenUntil - Date.now()) / 60_000);
    throw new OdQuotaExhaustedError(`OD-квота исчерпана — circuit open ещё ~${minLeft} мин`);
  }
  const url = withOpenDotaKey(`${OD_BASE}${path}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 429) {
    consecutive429++;
    if (consecutive429 >= BREAKER_THRESHOLD) {
      circuitOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      throw new OdQuotaExhaustedError(
        `HTTP 429 ×${consecutive429} подряд — OD-квота исчерпана, circuit open ${BREAKER_COOLDOWN_MS / 60_000} мин`,
      );
    }
    console.warn(`[odPace] HTTP 429 (${consecutive429}/${BREAKER_THRESHOLD}) — пауза ${MINUTE_WINDOW_PAUSE_MS / 1000}s (минутное окно)`);
    await sleep(MINUTE_WINDOW_PAUSE_MS);
    throw new Error(`HTTP 429 ${path}`);
  }
  if (res.status === 404) {
    consecutive429 = 0;
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  consecutive429 = 0;
  return (await res.json()) as T;
}
