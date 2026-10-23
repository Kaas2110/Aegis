import { buildApiUrl } from './apiConfig';

// Web/default module. Metro selects api.native.ts for Android/iOS.
// Keep direct dot notation: Expo substitutes EXPO_PUBLIC_* at bundle time.
export function apiUrl(path: string): string {
  return buildApiUrl(path, process.env.EXPO_PUBLIC_API_URL, 'web');
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}
