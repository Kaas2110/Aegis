import pg from 'pg';
import { createOdFetch, createPgOdLedger } from './opendotaBudget';
export { OdQuotaExhaustedError, OD_LIMITS, OD_PAID_CEILING, effectiveOdProfile } from './opendotaBudget';

const quotaPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
quotaPool.on('error', () => {}); // request paths fail closed with a sanitized ledger error
export const openDotaLedger = createPgOdLedger(quotaPool);
const key = () => process.env.OPENDOTA_API_KEY ?? '';
export const openDotaFetch = createOdFetch(openDotaLedger, 'user',globalThis.fetch,key);
export const openDotaBackgroundFetch = createOdFetch(openDotaLedger, 'background',globalThis.fetch,key);

// Priority is assigned by the background LiveWorker, never by a user request.
export const openDotaLiveFetch = createOdFetch(openDotaLedger, 'live',globalThis.fetch,key);
export const openDotaArchiveFetch = createOdFetch(openDotaLedger,'archive',globalThis.fetch,key);
