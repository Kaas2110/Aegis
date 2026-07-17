/**
 * Helper для добавления OpenDota API key к URL.
 *
 * Режим (free/premium):
 *   1. env OPENDOTA_USE_PREMIUM (если задан — приоритет, .env на ноуте);
 *   2. app_settings.opendota_premium (тогл на дашборде админки) — подхватывается
 *      через setOdDbPremium(), см. odPace.ts::ensureOdModeLoaded();
 *   3. дефолт — free.
 * Premium дополнительно требует OPENDOTA_API_KEY в env.
 *
 * FREE: ключ НЕ добавляется, лимиты 60 req/min, 3000 req/day. Все скрипты
 * должны использовать odThrottleMs() чтобы автоматически замедляться.
 * Premium: 3000 req/min (50 req/s), $0.0001/req.
 */
let dbPremiumOverride: boolean | null = null;

/** Пуш значения app_settings.opendota_premium (null = нет override). */
export function setOdDbPremium(v: boolean | null): void {
  dbPremiumOverride = v;
}

/** true если env OPENDOTA_USE_PREMIUM задан — тогда БД-тогл игнорируется. */
export function odEnvModeSet(): boolean {
  const env = process.env.OPENDOTA_USE_PREMIUM;
  return env !== undefined && env !== '';
}

export function isOpenDotaPremium(): boolean {
  const hasKey = !!process.env.OPENDOTA_API_KEY;
  if (odEnvModeSet()) return process.env.OPENDOTA_USE_PREMIUM === 'true' && hasKey;
  if (dbPremiumOverride !== null) return dbPremiumOverride && hasKey;
  return false;
}

export function withOpenDotaKey(url: string): string {
  if (!isOpenDotaPremium()) return url;
  const key = process.env.OPENDOTA_API_KEY!;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(key)}`;
}

/**
 * Возвращает интервал между запросами (ms) в зависимости от режима.
 * Free tier: 60 req/min → безопасно 1100ms (≈54 req/min с запасом).
 */
export function odThrottleMs(premiumMs: number): number {
  return isOpenDotaPremium() ? premiumMs : Math.max(premiumMs, 1100);
}
