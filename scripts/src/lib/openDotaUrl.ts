/**
 * Helper для добавления OpenDota API key к URL.
 * Без ключа: 60 req/min, 3000 req/day.
 * Premium key: 3000 req/min (50 req/s), неограниченно/месяц,
 *   $0.0001/req (404/429/500 не тарифицируются).
 */
export function withOpenDotaKey(url: string): string {
  const key = process.env.OPENDOTA_API_KEY;
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(key)}`;
}
