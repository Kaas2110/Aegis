/**
 * Email/password auth для мобилки. Bearer-токен хранится в AsyncStorage
 * и автоматически прицепляется ко всем будущим fetch'ам через `getAuthToken()`
 * (используется в LiveDataService и других местах, см. AuthContext).
 *
 * При logout — токен стирается, требуется ввод email повторно.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const TOKEN_KEY = '@dea_auth_token_v1';
const USER_KEY = '@dea_auth_user_v1';

export interface AuthUser {
  id: number;
  email: string;
  createdAt: string;
  lastLoginAt?: string | null;
  /** Админ-режим (debug-экраны). Выдаётся только из админки, T004. */
  isAdmin?: boolean;
}

interface AuthResponse {
  token: string;
  expiresAt: number;
  user: AuthUser;
}

let cachedToken: string | null = null;

export function getAuthToken(): string | null {
  return cachedToken;
}

export async function loadStoredAuth(): Promise<{ token: string; user: AuthUser } | null> {
  try {
    const [t, u] = await Promise.all([
      AsyncStorage.getItem(TOKEN_KEY),
      AsyncStorage.getItem(USER_KEY),
    ]);
    if (!t || !u) return null;
    cachedToken = t;
    return { token: t, user: JSON.parse(u) as AuthUser };
  } catch {
    return null;
  }
}

async function persist(token: string, user: AuthUser): Promise<void> {
  cachedToken = token;
  await Promise.all([
    AsyncStorage.setItem(TOKEN_KEY, token),
    AsyncStorage.setItem(USER_KEY, JSON.stringify(user)),
  ]);
}

async function clearStored(): Promise<void> {
  cachedToken = null;
  await Promise.all([
    AsyncStorage.removeItem(TOKEN_KEY),
    AsyncStorage.removeItem(USER_KEY),
  ]);
}

function apiBase(): string {
  // На вебе — относительный путь (тот же origin), на нативе — абсолютный через
  // EXPO_PUBLIC_API_URL если задан, иначе тот же relative (в dev будет proxy).
  const fromEnv = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.['EXPO_PUBLIC_API_URL'];
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return '';
}

export async function register(email: string, password: string, promoCode?: string): Promise<AuthUser> {
  const res = await fetch(`${apiBase()}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(promoCode?.trim() ? { email, password, promoCode: promoCode.trim() } : { email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (body as { error?: string }).error ?? `http_${res.status}`;
    throw new Error(code);
  }
  const data = body as AuthResponse;
  await persist(data.token, data.user);
  return data.user;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${apiBase()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (body as { error?: string }).error ?? `http_${res.status}`;
    throw new Error(code);
  }
  const data = body as AuthResponse;
  await persist(data.token, data.user);
  return data.user;
}

export async function logout(): Promise<void> {
  const token = cachedToken;
  if (token) {
    fetch(`${apiBase()}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {}); // fire-and-forget
  }
  await clearStored();
}

export type FetchMeResult =
  | { kind: 'ok'; user: AuthUser }
  | { kind: 'invalid' }   // 401: токен реально протух — надо разлогинить
  | { kind: 'network' }   // сеть упала или сервер 5xx — оставить cached
  | { kind: 'no_token' };

/**
 * Re-validates token. Различает протухший токен (надо разлогинить) и
 * временную ошибку сети / 5xx (оставить cached юзера).
 */
export async function fetchMe(): Promise<FetchMeResult> {
  if (!cachedToken) return { kind: 'no_token' };
  try {
    const res = await fetch(`${apiBase()}/api/auth/me`, {
      headers: { Authorization: `Bearer ${cachedToken}` },
    });
    if (res.status === 401) {
      await clearStored();
      return { kind: 'invalid' };
    }
    if (!res.ok) return { kind: 'network' };
    const body = await res.json() as { user: AuthUser };
    return { kind: 'ok', user: body.user };
  } catch {
    return { kind: 'network' };
  }
}
