import { apiFetch } from '../lib/api';

export interface AccountExport {
  formatVersion: 1;
  scope: 'server_account';
  account: { id: number; email: string; createdAt: string; lastLoginAt: string | null; tariff: string; referralCode: string | null };
  limitations: string[];
}

export class AccountRequestError extends Error {
  constructor(public readonly code: string, public readonly retryAfterSeconds: number | null = null) { super(code); }
}

type ApiRequest = (path: string, init?: RequestInit) => Promise<Response>;
async function failure(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  const retry = Number(response.headers.get('Retry-After'));
  throw new AccountRequestError(body.error ?? `http_${response.status}`, retry > 0 && Number.isFinite(retry) ? retry : null);
}

/** No storage side effects: local data must survive any unconfirmed deletion. */
export function createAccountDataClient(request: ApiRequest = apiFetch) {
  function authorization(token: string | null): Record<string, string> {
    if (!token) throw new AccountRequestError('unauthorized');
    return { Authorization: `Bearer ${token}` };
  }
  return {
    async exportData(token: string | null): Promise<AccountExport> {
      const response = await request('/api/auth/me/export', { headers: authorization(token), cache: 'no-store' });
      if (!response.ok) return failure(response);
      const data = await response.json() as AccountExport;
      if (data.formatVersion !== 1 || data.scope !== 'server_account' || !data.account || !Array.isArray(data.limitations)) throw new AccountRequestError('invalid_export');
      return data;
    },
    async deleteAccount(token: string | null, password: string): Promise<void> {
      const headers = authorization(token);
      if (password.length < 6 || password.length > 200) throw new AccountRequestError('invalid_password');
      const response = await request('/api/auth/me', { method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (response.status !== 204) return failure(response);
    },
  };
}

// Explicit allowlist: credentials, admin tokens and pending upload batches are never exported.
export const LOCAL_EXPORT_KEYS = [
  '@dea_settings', '@dea_filters', '@dea_onboarded', '@dea_age_confirmed',
  '@dea_alerts_v2', '@dea_alert_settings_v1', '@dea_anon_id',
  '@dea_product_events', '@dea_tech_logs', '@dea_audit_logs',
] as const;

export function selectLocalExport(entries: readonly (readonly [string, string | null])[]): Record<string, unknown> {
  const allowed = new Set<string>(LOCAL_EXPORT_KEYS);
  return Object.fromEntries(entries.filter(([key, value]) => allowed.has(key) && value !== null).map(([key, value]) => {
    let parsed: unknown = value;
    try { parsed = JSON.parse(value!); } catch { /* Keep non-JSON identifiers as strings. */ }
    return [key, parsed];
  }));
}
