/**
 * Helper для добавления OpenDota API key к URL.
 * Без ключа: 60 req/min, 2000 req/day.
 * С ключом ($10/мес): 3000 req/min, без дневного лимита.
 */
export function withOpenDotaKey(url: string): string {
  const key = process.env.OPENDOTA_API_KEY;
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(key)}`;
}
