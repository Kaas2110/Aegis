import pg from 'pg';
import { createPgStratzGate, createStratzClient } from './stratzBudget';
export { StratzUnavailableError, STRATZ_LIMITS, firstStratzToken } from './stratzBudget';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
pool.on('error', () => {});
export const stratzGate = createPgStratzGate(pool);
export const stratzQuery = createStratzClient(stratzGate);
