import type { Pool } from 'pg';

export const OD_LIMITS = Object.freeze({
  daily: 3000,
  minute: 60,
  backgroundHour: 62,
  historyHour: 32
});
export type OdKind = 'user' | 'background' | 'live' | 'archive';
export const OD_PAID_CEILING = Object.freeze({
  minute: 3000,
  monthlyUnits: 200_000,
  archiveUnits: 200_000,
  usdPerUnit: 0.0001
});
export interface OdPaidState {
  enabled: boolean;
  minute: number;
  monthlyLimitUnits: number;
  archiveLimitUnits: number;
  archiveUnits: number;
  months: Record<string, { units: number; archiveUnits: number }>;
  days: Record<string, number>;
  nextArchiveAt: number;
  configuredAt: number;
}
export interface OdReservation {
  profile: 'free' | 'paid';
}
export interface OdPaidConfiguration {
  enabled: boolean;
  minute: number;
  monthlyLimitUnits: number;
  archiveLimitUnits: number;
}
export const nextUtcMonth = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
function validPaid(p: OdPaidState): boolean {
  return (
    typeof p.enabled === 'boolean' &&
    Number.isInteger(p.minute) &&
    p.minute >= 10 &&
    p.minute <= OD_PAID_CEILING.minute &&
    [p.monthlyLimitUnits, p.archiveLimitUnits].every(
      (v) => Number.isInteger(v) && v >= 1 && v <= 200_000
    ) &&
    Number.isInteger(p.archiveUnits) &&
    p.archiveUnits >= 0 &&
    Number.isFinite(p.nextArchiveAt) &&
    Number.isFinite(p.configuredAt) &&
    !!p.months && !Array.isArray(p.months) &&
    Object.entries(p.months).every(
      ([key, v]) =>
        /^\d{4}-\d{2}$/.test(key) &&
        Number.isInteger(v.units) &&
        v.units >= 0 &&
        Number.isInteger(v.archiveUnits) &&
        v.archiveUnits >= 0 &&
        v.archiveUnits <= v.units
    ) &&
    !!p.days && !Array.isArray(p.days) &&
    Object.entries(p.days).every(
      ([key, v]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isInteger(v) && v >= 0
    )
  );
}
/** Reconfiguration never clears spend, including after restart or disabling paid mode. */
export function configureOdPaidState(
  state: OdBudgetState,
  now: number,
  cfg: OdPaidConfiguration
): void {
  const previous = state.paid;
  const candidate: OdPaidState = {
    ...cfg,
    archiveUnits: previous?.archiveUnits ?? 0,
    months: previous?.months ?? {},
    days: previous?.days ?? {},
    nextArchiveAt: previous?.nextArchiveAt ?? 0,
    configuredAt: now
  };
  if (!validPaid(candidate)) throw new Error('Invalid paid OpenDota configuration');
  state.paid = candidate;
}

export type OdDeferReason =
  | 'daily_limit'
  | 'minute_limit'
  | 'background_hour_limit'
  | 'upstream_429'
  | 'upstream_403'
  | 'ledger_unavailable'
  | 'paid_mode_disabled'
  | 'paid_key_missing'
  | 'paid_month_limit'
  | 'paid_archive_limit'
  | 'paid_live_reserve'
  | 'archive_pacing';
export class OdQuotaExhaustedError extends Error {
  readonly code = 'OD_DEFERRED';
  constructor(
    readonly reason: OdDeferReason,
    readonly retryAt: number
  ) {
    super(`OpenDota deferred: ${reason}; retryAt=${new Date(retryAt).toISOString()}`);
    this.name = 'OdQuotaExhaustedError';
  }
}

interface DayUsage {
  calls: number;
  units: number;
}
export interface OdBudgetState {
  version: 1;
  days: Record<string, DayUsage>;
  recent: Array<{ at: number; units: number; profile?: 'free' | 'paid' }>;
  backgroundHour: { key: string; units: number; liveUnits?: number };
  blockedUntil: number;
  blockedReason: 'upstream_429' | 'upstream_403' | null;
  paid?: OdPaidState;
}
export function emptyOdState(): OdBudgetState {
  return {
    version: 1,
    days: {},
    recent: [],
    backgroundHour: { key: '', units: 0 },
    blockedUntil: 0,
    blockedReason: null
  };
}
export const nextUtcDay = (now: number): number =>
  Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;
const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
const utcHour = (now: number): string => new Date(now).toISOString().slice(0, 13);

function prune(state: OdBudgetState, now: number): void {
  state.recent = state.recent.filter((item) => item.at > now - 60_000);
  const oldest = utcDay(now - 29 * 86_400_000);
  for (const day of Object.keys(state.days)) if (day < oldest) delete state.days[day];
  if (state.backgroundHour.key !== utcHour(now))
    state.backgroundHour = { key: utcHour(now), units: 0 };
}

/** Paid budget exhaustion changes authentication only; provider blocks never do. */
export function effectiveOdProfile(
  state: OdBudgetState,
  now: number,
  units = 1,
  kind: OdKind = 'user'
): 'paid' | 'free' {
  const p = state.paid;
  if (!p?.enabled) return 'free';
  if (!validPaid(p)) throw new Error('Invalid paid state');
  const month = p.months[new Date(now).toISOString().slice(0, 7)]?.units ?? 0;
  if (month + units > p.monthlyLimitUnits) return 'free';
  if (kind === 'archive') {
    if (p.archiveUnits + units > p.archiveLimitUnits) return 'free';
    const ongoingReserve = Math.ceil((nextUtcMonth(now) - now) / 120_000) + 1000;
    if (month + units > Math.max(0, p.monthlyLimitUnits - ongoingReserve)) return 'free';
  }
  return 'paid';
}

/** Pure policy under the PG transaction lock. Each attempted send reserves again. */
export function reserveOdState(
  state: OdBudgetState,
  now: number,
  units: number,
  kind: OdKind,
  paidKeyAvailable = false
): OdQuotaExhaustedError | null {
  if (!Number.isInteger(units) || units < 1 || units > 60)
    throw new Error('Invalid OpenDota reservation units');
  prune(state, now);
  if (state.blockedUntil > now)
    return new OdQuotaExhaustedError(state.blockedReason ?? 'upstream_429', state.blockedUntil);
  const profile = effectiveOdProfile(state, now, units, kind);
  const paid = profile === 'paid' ? state.paid! : null;
  if (kind === 'archive' && !state.paid?.enabled)
    return new OdQuotaExhaustedError('paid_mode_disabled', nextUtcDay(now));
  if (paid && !paidKeyAvailable) return new OdQuotaExhaustedError('paid_key_missing', now + 60_000);
  const day = state.days[utcDay(now)] ?? { calls: 0, units: 0 };
  if (!paid && day.units + units > OD_LIMITS.daily)
    return new OdQuotaExhaustedError('daily_limit', nextUtcDay(now));
  // Rolling total also keeps the transition to free conservative for one minute.
  const minuteLimit = paid ? paid.minute - (kind === 'live' ? 0 : 2) : OD_LIMITS.minute;
  let minuteUnits = state.recent.reduce((sum, item) => sum + item.units, 0);
  if (minuteUnits + units > minuteLimit) {
    for (const item of state.recent) {
      minuteUnits -= item.units;
      if (minuteUnits + units <= minuteLimit)
        return new OdQuotaExhaustedError('minute_limit', item.at + 60_000);
    }
  }
  const background = kind === 'background' || kind === 'live' || kind === 'archive';
  if (!paid && background) {
    const historical = state.backgroundHour.units - (state.backgroundHour.liveUnits ?? 0);
    if (
      state.backgroundHour.units + units > OD_LIMITS.backgroundHour ||
      (kind !== 'live' && historical + units > OD_LIMITS.historyHour)
    ) {
      return new OdQuotaExhaustedError(
        'background_hour_limit',
        Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000
      );
    }
  }
  if (paid) {
    if (kind === 'archive' && paid.nextArchiveAt > now)
      return new OdQuotaExhaustedError('archive_pacing', paid.nextArchiveAt);
    const key = new Date(now).toISOString().slice(0, 7);
    const month = paid.months[key] ?? { units: 0, archiveUnits: 0 };
    month.units += units;
    if (kind === 'archive') {
      paid.nextArchiveAt = now + Math.ceil(60_000 / (paid.minute - 2));
      paid.archiveUnits += units;
      month.archiveUnits += units;
    }
    paid.months[key] = month;
    paid.days[utcDay(now)] = (paid.days[utcDay(now)] ?? 0) + units;
  } else {
    state.days[utcDay(now)] = { calls: day.calls + 1, units: day.units + units };
    if (background) state.backgroundHour.units += units;
    if (kind === 'live')
      state.backgroundHour.liveUnits = (state.backgroundHour.liveUnits ?? 0) + units;
  }
  state.recent.push({ at: now, units, profile });
  return null;
}

export function retryAfterDeadline(header: string | null, now: number): number {
  const seconds = header?.trim() && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN;
  const value = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header ?? '');
  // Missing, past or zero Retry-After must not cause an immediate retry storm.
  return Number.isFinite(value) && value > now ? value : now + 65_000;
}
export function blockOdState(
  state: OdBudgetState,
  now: number,
  status: 403 | 429,
  retryAfter: string | null
): OdQuotaExhaustedError {
  const until =
    status === 403
      ? Math.max(nextUtcDay(now), retryAfterDeadline(retryAfter, now))
      : retryAfterDeadline(retryAfter, now);
  if (until >= state.blockedUntil) {
    state.blockedUntil = until;
    state.blockedReason = status === 403 ? 'upstream_403' : 'upstream_429';
  }
  return new OdQuotaExhaustedError(state.blockedReason ?? 'upstream_429', state.blockedUntil);
}

export interface OdLedger {
  reserve(units: number, kind: OdKind, paidKeyAvailable?: boolean): Promise<OdReservation | void>;
  configurePaid?(cfg: OdPaidConfiguration): Promise<void>;
  block(status: 403 | 429, retryAfter: string | null): Promise<OdQuotaExhaustedError>;
  snapshot(): Promise<{ state: OdBudgetState; now: number }>;
}

/** A single PostgreSQL row is shared by API, CLI jobs and all their processes. */
export function createPgOdLedger(pool: Pool, schema = 'public'): OdLedger {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Invalid OpenDota ledger schema');
  const table = `"${schema}"."opendota_request_budget"`;
  const lockName = `${schema}.opendota_request_budget.v1`;
  let initialized = false;
  async function transaction<T>(apply: (state: OdBudgetState, now: number) => T): Promise<T> {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockName]);
      if (!initialized) {
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY CHECK (id = 1), state jsonb NOT NULL)`
        );
        await client.query(
          `INSERT INTO ${table} (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
          [JSON.stringify(emptyOdState())]
        );
      }
      const result = await client.query(
        `SELECT state, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms FROM ${table} WHERE id = 1 FOR UPDATE`
      );
      const state = result.rows[0]?.state as OdBudgetState;
      if (
        state?.version !== 1 ||
        !state.days || Array.isArray(state.days) ||
        !Array.isArray(state.recent) ||
        !Number.isFinite(state.blockedUntil) ||
        !state.backgroundHour ||
        !Number.isInteger(state.backgroundHour.units) ||
        (state.backgroundHour.liveUnits !== undefined &&
          (!Number.isInteger(state.backgroundHour.liveUnits) ||
            state.backgroundHour.liveUnits < 0 ||
            state.backgroundHour.liveUnits > state.backgroundHour.units)) ||
        Object.values(state.days).some(
          (day) =>
            !Number.isInteger(day.calls) ||
            day.calls < 0 ||
            !Number.isInteger(day.units) ||
            day.units < 0
        ) ||
        state.recent.some(
          (item) => !Number.isFinite(item.at) || !Number.isInteger(item.units) || item.units < 1
        ) ||
        (state.paid !== undefined && !validPaid(state.paid))
      )
        throw new Error('Invalid ledger state');
      const now = Number(result.rows[0].now_ms);
      const value = apply(state, now);
      await client.query(`UPDATE ${table} SET state = $1::jsonb WHERE id = 1`, [
        JSON.stringify(state)
      ]);
      await client.query('COMMIT');
      initialized = true;
      return value;
    } catch {
      await client?.query('ROLLBACK').catch(() => {});
      // A DB outage must fail closed; neither SQL nor connection secrets escape.
      throw new OdQuotaExhaustedError('ledger_unavailable', Date.now() + 60_000);
    } finally {
      client?.release();
    }
  }
  return {
    async reserve(units, kind, paidKeyAvailable = false) {
      const result = await transaction((state, now) => {
        const profile = effectiveOdProfile(state, now, units, kind);
        return { denied: reserveOdState(state, now, units, kind, paidKeyAvailable), profile };
      });
      if (result.denied) throw result.denied;
      return { profile: result.profile };
    },
    configurePaid: (cfg) => transaction((state, now) => configureOdPaidState(state, now, cfg)),
    block: (status, retryAfter) =>
      transaction((state, now) => blockOdState(state, now, status, retryAfter)),
    snapshot: () =>
      transaction((state, now) => {
        prune(state, now);
        return { state, now };
      })
  };
}

const SAFE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
]);
function sanitizedNetworkError(error: unknown): Error & { code?: string } {
  let current = error;
  for (let i = 0; i < 5 && current && typeof current === 'object'; i++) {
    const item = current as { name?: string; code?: string; cause?: unknown };
    if (item.name === 'TimeoutError' || item.name === 'AbortError') {
      const safe = new Error(
        `OpenDota request ${item.name === 'TimeoutError' ? 'timed out' : 'aborted'}`
      );
      safe.name = item.name;
      return safe;
    }
    if (item.code && SAFE_NETWORK_CODES.has(item.code))
      return Object.assign(new Error(`OpenDota transport failed: ${item.code}`), {
        code: item.code
      });
    current = item.cause;
  }
  return new Error('OpenDota transport failed');
}

/** No implicit retry. Each caller retry must enter this function again. */
export function createOdFetch(
  ledger: OdLedger,
  kind: OdKind,
  fetchImpl: typeof fetch = globalThis.fetch,
  getPaidKey: () => string = () => ''
): typeof fetch {
  return async (input, init) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(raw);
    if (url.hostname !== 'api.opendota.com') return fetchImpl(input, init);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.searchParams.has('api_key')
    ) {
      throw new OdQuotaExhaustedError('paid_mode_disabled', nextUtcDay(Date.now()));
    }
    const base = input instanceof Request ? input : undefined;
    const method = (init?.method ?? base?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? base?.headers);
    if (headers.has('authorization') || headers.has('x-api-key'))
      throw new OdQuotaExhaustedError('paid_mode_disabled', nextUtcDay(Date.now()));
    const signal = init?.signal ?? base?.signal;
    signal?.throwIfAborted();
    const units = method === 'POST' && /^\/api\/request\//.test(url.pathname) ? 10 : 1;
    const key = getPaidKey().trim();
    const reservation = await ledger.reserve(units, kind, key.length > 0);
    if (reservation?.profile === 'paid') {
      if (!key) throw new OdQuotaExhaustedError('paid_key_missing', Date.now() + 60_000);
      url.searchParams.set('api_key', key);
    }
    const outbound = base ? new Request(url, base) : url;
    // Redirects would otherwise create unreserved network requests automatically.
    let response: Response;
    try {
      response = await fetchImpl(outbound, {
        ...init,
        redirect: 'manual',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw sanitizedNetworkError(error);
    }
    if (response.status === 429 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw await ledger.block(response.status, response.headers.get('retry-after'));
    }
    if (!response.ok) await response.body?.cancel().catch(() => {});
    return response;
  };
}
