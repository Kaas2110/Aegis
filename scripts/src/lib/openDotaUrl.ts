/**
 * Helper для добавления OpenDota API key к URL.
 *
 * FREE MODE (текущий режим): ключ НЕ добавляется, лимиты free tier —
 *   60 req/min, 3000 req/day. Все скрипты должны использовать odThrottleMs()
 *   чтобы автоматически замедляться.
 *
 * Premium вернуть: выставить OPENDOTA_USE_PREMIUM=true (ключ уже в
 * OPENDOTA_API_KEY). Premium: 3000 req/min (50 req/s), $0.0001/req.
 */
export function isOpenDotaPremium(): boolean {
  return process.env.OPENDOTA_USE_PREMIUM === 'true' && !!process.env.OPENDOTA_API_KEY;
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
