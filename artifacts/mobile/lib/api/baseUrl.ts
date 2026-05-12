/**
 * Универсальный helper для построения URL до API-сервера.
 *
 * - В dev (Expo) `EXPO_PUBLIC_API_URL` обычно не задан и используется относительный
 *   путь — Expo packager + браузер проксируют запрос к локальному api-server.
 * - В production-сборке (.ipa / .apk) относительные URL работать НЕ будут, потому
 *   что приложение не имеет своего origin. В EAS-профиле обязательно нужно
 *   прокинуть `EXPO_PUBLIC_API_URL=https://<your-domain>` (см. `eas.json`).
 *
 * Пример: getApiUrl('/api/teams/tier1?limit=50')
 *   - dev: `/api/teams/tier1?limit=50` (proxy)
 *   - prod: `https://aegis.example.com/api/teams/tier1?limit=50`
 */

const RAW_BASE = process.env.EXPO_PUBLIC_API_URL ?? '';
const BASE = RAW_BASE.replace(/\/+$/, '');

export function getApiUrl(path: string): string {
  if (!path.startsWith('/')) path = '/' + path;
  return BASE + path;
}

export const API_BASE_URL = BASE;
