/**
 * Клиент админ-эндпоинтов API.
 * Токен (X-Admin-Token) хранится локально в AsyncStorage и редактируется из
 * админ-экрана. Без токена все запросы возвращают 401 — UI покажет форму ввода.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const API_BASE = '/api';
const TOKEN_KEY = 'admin_token_v1';

let cached: string | null = null;

export async function getAdminToken(): Promise<string | null> {
  if (cached !== null) return cached || null;
  const v = await AsyncStorage.getItem(TOKEN_KEY);
  cached = v ?? '';
  return v;
}

export async function setAdminToken(token: string): Promise<void> {
  cached = token;
  if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAdminToken();
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Admin-Token': token } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

export interface AdminSettings {
  id: number;
  useBookmakerOdds: boolean;
  liveSnapshotPruneDays: number;
  notes: string | null;
  updatedAt: string;
}

export interface AdminSettingsResponse {
  settings: AdminSettings;
  oddsApiKeyConfigured: boolean;
}

export async function fetchAdminSettings(): Promise<AdminSettingsResponse> {
  const r = await adminFetch('/admin/settings');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function updateAdminSettings(
  patch: Partial<Pick<AdminSettings, 'useBookmakerOdds' | 'liveSnapshotPruneDays'>>,
): Promise<AdminSettingsResponse> {
  const r = await adminFetch('/admin/settings', {
    method: 'POST',
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return { settings: data.settings, oddsApiKeyConfigured: false };
}

export interface ModelMetrics {
  totalPredictions: number;
  resolved: number;
  pending: number;
  accuracy: number | null;
  brierScore: number | null;
  byModel: Array<{ modelVersion: string; resolved: number; accuracy: number; brierScore: number }>;
  recent: Array<{
    matchId: number;
    modelVersion: string;
    predictedRadiantWinProb: number;
    actualRadiantWin: boolean | null;
    radiantName: string | null;
    direName: string | null;
    resolvedAt: string | null;
  }>;
}

export async function fetchAdminMetrics(): Promise<ModelMetrics> {
  const r = await adminFetch('/admin/metrics');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function triggerRetrain(): Promise<{ started: boolean; reason: string }> {
  const r = await adminFetch('/admin/retrain', { method: 'POST' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function pruneSnapshots(days?: number): Promise<{ days: number; deleted: number }> {
  const r = await adminFetch('/admin/prune-snapshots', {
    method: 'POST',
    body: JSON.stringify({ days }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Популярные рынки для матча (режим без букмекера). */
export interface PopularMarket {
  betType: string;
  labelRu: string;
  recommendation: string;
  probability: number;
  fairOdds: number;
  confidence: number;
  rationale: string;
  liveProjection?: {
    currentMinute: number;
    currentKills: number;
    projectedFinalKills: number;
    projectedDurationMin: number;
  };
}

export async function fetchPopularMarkets(params: {
  radiantTeamId: number;
  direTeamId: number;
  team1Name: string;
  team2Name: string;
  format?: 'BO1' | 'BO3' | 'BO5';
}): Promise<{ markets: PopularMarket[] }> {
  const q = new URLSearchParams({
    radiantTeamId: String(params.radiantTeamId),
    direTeamId: String(params.direTeamId),
    team1Name: params.team1Name,
    team2Name: params.team2Name,
    format: params.format ?? 'BO3',
  });
  const r = await fetch(`${API_BASE}/analytics/popular-markets?${q}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
