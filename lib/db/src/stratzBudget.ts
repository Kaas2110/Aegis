import type { Pool } from 'pg';

// Deployment limits, deliberately below the account's verified upstream quota.
export const STRATZ_LIMITS = { daily: 2000, hourly: 100, gapMs: 10_000 } as const;
export const STRATZ_ENDPOINT = 'https://api.stratz.com/graphql';
export const STRATZ_USER_AGENT = 'STRATZ_API';

export class StratzUnavailableError extends Error {
  readonly code = 'STRATZ_UNAVAILABLE';
  constructor(message: string, readonly reason = 'unavailable', readonly retryAt?: number) {
    super(message);
    this.name = 'StratzUnavailableError';
  }
}
function deferred(reason: string, retryAt?: number): StratzUnavailableError {
  return new StratzUnavailableError(`STRATZ request deferred: ${reason}`, reason, retryAt);
}
export interface StratzBudgetState {
  version: 1;
  day: { key: string; calls: number };
  hour: { key: string; calls: number };
  nextAllowedAt: number;
  blockedUntil: number;
  blockedReason: 'upstream_403' | 'upstream_429' | null;
}
export function emptyStratzState(): StratzBudgetState {
  return { version: 1, day: { key: '', calls: 0 }, hour: { key: '', calls: 0 }, nextAllowedAt: 0, blockedUntil: 0, blockedReason: null };
}
export function reserveStratzState(state: StratzBudgetState, now: number): void {
  if (state.blockedUntil > now) throw deferred(state.blockedReason ?? 'upstream_429', state.blockedUntil);
  const utc = new Date(now).toISOString();
  if (state.day.key !== utc.slice(0, 10)) state.day = { key: utc.slice(0, 10), calls: 0 };
  if (state.hour.key !== utc.slice(0, 13)) state.hour = { key: utc.slice(0, 13), calls: 0 };
  if (state.day.calls >= STRATZ_LIMITS.daily) throw deferred('daily_limit', Date.parse(`${state.day.key}T00:00:00Z`) + 86_400_000);
  if (state.hour.calls >= STRATZ_LIMITS.hourly) throw deferred('hourly_limit', Date.parse(`${state.hour.key}:00:00Z`) + 3_600_000);
  if (state.nextAllowedAt > now) throw deferred('pacing', state.nextAllowedAt);
  state.day.calls++;
  state.hour.calls++;
  state.nextAllowedAt = now + STRATZ_LIMITS.gapMs;
}
export function blockStratzState(state: StratzBudgetState, now: number, status: 403 | 429, header: string | null): StratzUnavailableError {
  const numeric = header === null ? NaN : Number(header);
  const parsed = header === null ? NaN : Number.isFinite(numeric) ? now + numeric * 1000 : Date.parse(header);
  // Access denial needs an explicit review; a new day/key must not silently
  // restart requests. The ledger contains no token or fingerprint to rotate.
  const until = status === 403 ? Number.MAX_SAFE_INTEGER : Number.isFinite(parsed) && parsed > now ? parsed : now + 65_000;
  if (until >= state.blockedUntil) {
    state.blockedUntil = until;
    state.blockedReason = status === 403 ? 'upstream_403' : 'upstream_429';
  }
  return deferred(state.blockedReason ?? 'upstream_429', state.blockedUntil);
}

export type StratzOperation = {
  signal: AbortSignal;
  block(status: 403 | 429, retryAfter: string | null): Promise<StratzUnavailableError>;
};
export interface StratzGate {
  run<T>(operation: (context: StratzOperation) => Promise<T>): Promise<T>;
}

/** Session lock spans the body read: only one in-flight call across processes.
 * Counts are committed BEFORE sending, even if this process then crashes.
 * PostgreSQL releases the session lock on disconnect, so no stale file lease.
 */
export function createPgStratzGate(pool: Pool, schema = 'public'): StratzGate {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Invalid STRATZ ledger schema');
  const table = `"${schema}"."stratz_request_budget"`;
  const lockName = `${schema}.stratz_request_budget.v1`;
  let initialized = false;
  return {
    async run(operation) {
      let client;
      let locked = false;
      let destroy = false;
      const connectionAbort = new AbortController();
      const connectionError = () => { destroy = true; connectionAbort.abort(); };
      try {
        client = await pool.connect();
        client.on('error', connectionError);
        await client.query("SET statement_timeout = '5s'");
        const acquired = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName]);
        locked = acquired.rows[0]?.locked === true;
        if (!locked) throw deferred('in_flight', Date.now() + STRATZ_LIMITS.gapMs);
        if (!initialized) {
          await client.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY CHECK (id = 1), state jsonb NOT NULL)`);
          await client.query(`INSERT INTO ${table} (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(emptyStratzState())]);
          initialized = true;
        }
        const result = await client.query(`SELECT state, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms FROM ${table} WHERE id = 1`);
        const state = result.rows[0]?.state as StratzBudgetState;
        if (state?.version !== 1 || !state.day || !state.hour
            || !Number.isInteger(state.day.calls) || state.day.calls < 0 || !Number.isInteger(state.hour.calls) || state.hour.calls < 0
            || typeof state.day.key !== 'string' || typeof state.hour.key !== 'string'
            || !Number.isFinite(state.nextAllowedAt) || !Number.isFinite(state.blockedUntil)) throw new Error('Invalid state');
        let now = Number(result.rows[0].now_ms);
        if (state.blockedUntil > now) throw deferred(state.blockedReason ?? 'upstream_429', state.blockedUntil);
        const waitMs = state.nextAllowedAt - now;
        if (waitMs > STRATZ_LIMITS.gapMs) throw deferred('pacing', state.nextAllowedAt);
        if (waitMs > 0) {
          await new Promise<void>(resolve => setTimeout(resolve, waitMs + 2));
          const clock = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
          now = Number(clock.rows[0].now_ms);
        }
        reserveStratzState(state, now);
        await client.query(`UPDATE ${table} SET state = $1::jsonb WHERE id = 1`, [JSON.stringify(state)]);
        const activeClient = client;
        return await operation({
          signal: connectionAbort.signal,
          async block(status, retryAfter) {
            const clock = await activeClient.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
            const error = blockStratzState(state, Number(clock.rows[0].now_ms), status, retryAfter);
            await activeClient.query(`UPDATE ${table} SET state = $1::jsonb WHERE id = 1`, [JSON.stringify(state)]);
            return error;
          },
        });
      } catch (error) {
        if (error instanceof StratzUnavailableError) throw error;
        throw deferred('ledger_unavailable', Date.now() + 60_000);
      } finally {
        if (client) {
          if (locked && !destroy) {
            try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]); }
            catch { destroy = true; }
          }
          client.removeListener('error', connectionError);
          client.release(destroy);
        }
      }
    },
  };
}

/** A single configured token; legacy comma-separated extras are never rotated. */
export function firstStratzToken(raw: string | undefined): string {
  return (raw ?? '').split(',')[0]!.trim();
}

export function createStratzClient(gate: StratzGate, fetchImpl: typeof fetch = globalThis.fetch) {
  return async function query<T>(rawToken: string | undefined, query: string, variables?: Record<string, unknown>): Promise<T> {
    const token = firstStratzToken(rawToken);
    if (!token || /[\r\n]/.test(token)) throw new StratzUnavailableError('STRATZ token is missing or invalid', 'missing_token');
    let body: string;
    try { body = JSON.stringify({ query, variables }); }
    catch { throw new StratzUnavailableError('STRATZ request cannot be encoded', 'invalid_request'); }
    return gate.run(async context => {
      let response;
      try {
        response = await fetchImpl(STRATZ_ENDPOINT, {
          method: 'POST', redirect: 'manual',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': STRATZ_USER_AGENT },
          body,
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
        });
      } catch {
        throw new StratzUnavailableError('STRATZ transport failed', 'transport_error');
      }
      if (response.status === 403 || response.status === 429) {
        await response.body?.cancel().catch(() => {});
        throw await context.block(response.status, response.headers.get('retry-after'));
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new StratzUnavailableError(`STRATZ HTTP ${response.status}`, 'http_error');
      }
      let parsed: { data?: T; errors?: unknown[] };
      try { parsed = await response.json() as typeof parsed; }
      catch { throw new StratzUnavailableError('STRATZ response was not readable JSON', 'invalid_response'); }
      if (!parsed || typeof parsed !== 'object') throw new StratzUnavailableError('STRATZ response has no data object', 'invalid_response');
      if (Array.isArray(parsed.errors) && parsed.errors.length) {
        // Upstream messages can echo authorization or user-controlled variables.
        throw new StratzUnavailableError(`STRATZ GraphQL returned ${parsed.errors.length} error(s)`, 'graphql_error');
      }
      if (parsed.data === null || parsed.data === undefined) throw new StratzUnavailableError('STRATZ response has no data object', 'invalid_response');
      return parsed.data;
    });
  };
}
