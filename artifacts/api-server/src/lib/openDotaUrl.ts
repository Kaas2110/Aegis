/**
 * Helper для добавления OpenDota API key к URL.
 * Без ключа: 60 req/min, 2000 req/day (Replit-IP регулярно ловит 429).
 * С ключом ($10/мес): 3000 req/min, без дневного лимита.
 *
 * Использование:
 *   const url = withOpenDotaKey(`${OPENDOTA_BASE}/matches/${id}`);
 *   const r = await fetch(url);
 *
 * Idempotent: если ключа в env нет — URL возвращается без изменений.
 */
export function withOpenDotaKey(url: string): string {
  const key = process.env.OPENDOTA_API_KEY;
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(key)}`;
}

export function hasOpenDotaKey(): boolean {
  return Boolean(process.env.OPENDOTA_API_KEY);
}
