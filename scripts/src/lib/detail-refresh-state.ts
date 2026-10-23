import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DETAIL_COOLDOWN_MS = 7 * 86400_000;
export interface DetailAttempt { at: number; outcome: 'pending' | 'parsed' | 'draft_only' | 'unavailable' | 'error' | 'persistence_retry'; observationFile?: string; payloadSchemaVersion?: number;
  matchStartTime?: number; retryCount?: number; errorRetryable?: boolean; retryAfterUntil?: number; retryAfterUnbounded?: boolean;
  retryOutcome?: 'parsed' | 'draft_only' | 'unavailable' | 'error' }
export interface DetailRefreshState { version: 1; attempts: Record<string, DetailAttempt> }
export interface DetailCandidate { matchId: number; startTime: number; missingDraft: boolean; missingParsed: boolean; schemaUpgrade?: boolean }
const outcomes = new Set(['pending', 'parsed', 'draft_only', 'unavailable', 'error', 'persistence_retry']);

export function detailLimit(value: unknown = 12, maximum = 30): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum || maximum<1 || maximum>1000) throw new Error(`limit must be 1..${maximum}`);
  return limit;
}

export function parseDetailRefreshState(value: unknown): DetailRefreshState {
  const state = value as DetailRefreshState | null;
  if (!state || state.version !== 1 || !state.attempts || typeof state.attempts !== 'object' || Array.isArray(state.attempts)) {
    throw new Error('Invalid detail refresh checkpoint');
  }
  for (const [id, attempt] of Object.entries(state.attempts)) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !attempt
      || !Number.isSafeInteger(attempt.at) || attempt.at < 0 || !outcomes.has(attempt.outcome) || (attempt.observationFile !== undefined && (typeof attempt.observationFile !== 'string' || !path.isAbsolute(attempt.observationFile)))
      || (attempt.payloadSchemaVersion !== undefined && (!Number.isSafeInteger(attempt.payloadSchemaVersion) || attempt.payloadSchemaVersion < 1))) {
      throw new Error('Invalid detail refresh checkpoint entry');
    }
    for (const key of ['matchStartTime', 'retryCount', 'retryAfterUntil'] as const) {
      if (attempt[key] !== undefined && (!Number.isSafeInteger(attempt[key]) || attempt[key]! < 0)) throw new Error('Invalid detail refresh checkpoint entry');
    }
    if (attempt.errorRetryable !== undefined && typeof attempt.errorRetryable !== 'boolean') throw new Error('Invalid detail refresh checkpoint entry');
    if (attempt.retryAfterUnbounded !== undefined && typeof attempt.retryAfterUnbounded !== 'boolean') throw new Error('Invalid detail refresh checkpoint entry');
    if (attempt.retryOutcome !== undefined && !['parsed', 'draft_only', 'unavailable', 'error'].includes(attempt.retryOutcome)) throw new Error('Invalid detail refresh checkpoint entry');
  }
  return state;
}

export function isPersistenceRetry(attempt: DetailAttempt | undefined): boolean {
  return !!attempt && (attempt.outcome === 'persistence_retry' || (attempt.outcome === 'pending' && !!attempt.observationFile));
}

export function coolingMatchIds(state: DetailRefreshState, now: number): number[] {
  return Object.entries(state.attempts).filter(([, attempt]) => !isPersistenceRetry(attempt) && now < detailRetryAt(attempt)).map(([id]) => Number(id));
}

/** Back off on repeated failures; an absent replay on a recent map is not a
 * permanent absence. Legacy network errors receive one bounded retry too.
 * Provider-wide 403/429 and monetary caps remain controlled by the shared ledger.
 */
export function detailRetryAt(attempt: DetailAttempt): number {
  if (attempt.retryAfterUnbounded) return Infinity; // Unrepresentable provider deadline: fail closed.
  const index = Math.min(3, Math.max(0, (attempt.retryCount ?? 1) - 1));
  let delay = DETAIL_COOLDOWN_MS;
  if (attempt.outcome === 'error' && attempt.errorRetryable !== false) delay = [30 * 60_000, 2 * 3600_000, 6 * 3600_000, 86400_000][index];
  if ((attempt.outcome === 'draft_only' || attempt.outcome === 'unavailable')
    && attempt.matchStartTime !== undefined && attempt.at - attempt.matchStartTime * 1000 <= DETAIL_COOLDOWN_MS) {
    delay = [3600_000, 6 * 3600_000, 86400_000, 86400_000][index];
  }
  return Math.max(attempt.at + delay, attempt.retryAfterUntil ?? 0);
}

export function completedDetailAttempt(previous: DetailAttempt | undefined, outcome: DetailAttempt['outcome'], at: number,
  matchStartTime: number, failure?: { retryable: boolean; retryAfterMs: number | null }): DetailAttempt {
  const incomplete = (value: DetailAttempt['outcome'] | undefined) => value === 'draft_only' || value === 'unavailable';
  const previousOutcome = isPersistenceRetry(previous) ? previous?.retryOutcome : previous?.outcome;
  const repeat = previousOutcome === outcome || (incomplete(previousOutcome) && incomplete(outcome));
  const retryCount = outcome === 'parsed' ? 0 : Math.min(1000, repeat ? (previous?.retryCount ?? 1) + 1 : 1);
  const deadline = failure?.retryAfterMs != null ? at + Math.ceil(failure.retryAfterMs) : null;
  const serverDeadline = deadline === null ? {} : Number.isSafeInteger(deadline) && deadline <= 8_640_000_000_000_000
    ? { retryAfterUntil: deadline } : { retryAfterUnbounded: true };
  return { at, outcome, matchStartTime, retryCount,
    ...(failure ? { errorRetryable: failure.retryable, ...serverDeadline } : {}) };
}

/** A successful old extraction must not delay a newly required payload schema.
 * SQL must additionally verify that the stored payload itself is still old.
 * Failed/unavailable attempts retain the usual provider cooldown.
 */
export function schemaUpgradeRetryIds(state: DetailRefreshState, targetSchemaVersion: number): number[] {
  return Object.entries(state.attempts).filter(([, attempt]) => attempt.outcome === 'parsed'
    && (attempt.payloadSchemaVersion ?? 0) < targetSchemaVersion).map(([id]) => Number(id));
}

export function selectDetailRefresh(candidates: DetailCandidate[], state: DetailRefreshState, now: number, limit: number, maximum = 30, targetSchemaVersion = 0): DetailCandidate[] {
  detailLimit(limit, maximum);
  const cooling = new Set(coolingMatchIds(state, now));
  const upgradeRetries = new Set(schemaUpgradeRetryIds(state, targetSchemaVersion));
  const schemaUpgrade = (row: DetailCandidate) => row.schemaUpgrade === true && upgradeRetries.has(row.matchId);
  const seen = new Set<number>();
  const priority = (row: DetailCandidate) => isPersistenceRetry(state.attempts[String(row.matchId)]) ? -1 : schemaUpgrade(row) || row.startTime * 1000 >= now - DETAIL_COOLDOWN_MS
    ? 0 : state.attempts[String(row.matchId)] ? 2 : 1;
  return candidates.filter(row => {
    if (!Number.isSafeInteger(row.matchId) || row.matchId <= 0 || !Number.isFinite(row.startTime)
      || !(row.missingDraft || row.missingParsed) || (cooling.has(row.matchId) && !schemaUpgrade(row)) || seen.has(row.matchId)) return false;
    seen.add(row.matchId);
    return true;
  }).sort((a, b) => priority(a) - priority(b) || b.startTime - a.startTime || b.matchId - a.matchId).slice(0, limit);
}

/** One local checkpoint writer at a time; a crashed process is recoverable. */
export function openDetailRefreshCheckpoint(stateDir: string | undefined) {
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('Absolute AEGIS_STATE_DIR required for detail refresh');
  mkdirSync(stateDir, { recursive: true });
  const filename = path.join(stateDir, 'opendota-detail-refresh.json');
  const lock = filename + '.lock';
  const acquire = () => openSync(lock, 'wx', 0o600);
  let descriptor: number;
  try { descriptor = acquire(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let pid: number;
    try { pid = JSON.parse(readFileSync(lock, 'utf8')).pid; }
    catch { throw new Error('Invalid detail refresh lock; cannot safely resume'); }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid detail refresh lock owner');
    try { process.kill(pid, 0); throw new Error('Detail refresh is already running'); }
    catch (ownerError) {
      if ((ownerError as NodeJS.ErrnoException).code !== 'ESRCH') throw ownerError;
    }
    unlinkSync(lock);
    descriptor = acquire();
  }
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid }), 'utf8');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    closeSync(descriptor);
    unlinkSync(lock);
  };
  try {
    let state: DetailRefreshState;
    try { state = parseDetailRefreshState(JSON.parse(readFileSync(filename, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = { version: 1, attempts: {} };
    }
    const save = () => {
      parseDetailRefreshState(state);
      const temporary = filename + `.partial-${process.pid}`;
      writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, filename);
    };
    return { state, save, release };
  } catch (error) { release(); throw error; }
}
