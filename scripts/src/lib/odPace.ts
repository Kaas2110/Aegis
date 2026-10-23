/** All OpenDota attempts, including other processes, share the PostgreSQL ledger. */
import { openDotaBackgroundFetch } from '@workspace/db/opendota';
export { OdQuotaExhaustedError } from '@workspace/db/opendota';
export const OD_BASE = 'https://api.opendota.com/api';
export const DELAY_MS = 1100;
export const TIMEOUT_MS = 15_000;
export async function ensureOdModeLoaded(): Promise<void> {}
export function isOdCircuitOpen(): boolean { return false; } // shared transport is authoritative
export async function sleep(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)); }
export async function fetchOdJson<T = unknown>(path: string, timeoutMs = TIMEOUT_MS): Promise<T | null> {
  const response = await openDotaBackgroundFetch(`${OD_BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`OpenDota HTTP ${response.status}`); }
  return await response.json() as T;
}