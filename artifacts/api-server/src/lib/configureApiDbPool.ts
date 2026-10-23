import type { pool as sharedPool } from '@workspace/db';

/** Public pg-pool options are read when idle clients are released/evicted.
 * Retain two existing API connections to avoid Windows backend startup on every
 * cold request. This creates no connections, queries or timers, and never raises max.
 * Call only from the API entry point; CLI/hourly jobs keep their default min=0. */
export function configureApiDbPool(pool: Pick<typeof sharedPool, 'options'>): void {
  pool.options.min = Math.min(pool.options.max, Math.max(pool.options.min ?? 0, 2));
}
