import { buildApiUrl } from './apiConfig';

// A native bundle must name its server explicitly, including local USB builds.
// This value is public configuration, never an API key or admin credential.
export function apiUrl(path: string): string {
  return buildApiUrl(path, process.env.EXPO_PUBLIC_API_URL, 'native');
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}
