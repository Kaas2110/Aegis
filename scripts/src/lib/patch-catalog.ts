import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const PATCH_CATALOG_SOURCE = 'https://api.opendota.com/api/constants/patch';
export const PATCH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PATCH_FAILURE_RETRY_MS = 60 * 60 * 1000;
export const PATCH_STATE_FILE = 'opendota-patch-catalog-state.json';
export const VALVE_PATCH_SOURCE = 'https://www.dota2.com/datafeed/patchnoteslist?language=english';
export const VALVE_PATCH_STATE_FILE = 'valve-patch-catalog-state.json';
export const PATCH_RETRAIN_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
export interface OfficialPatchObservation {
  name: string; releasedAt: string; knownAt: string; retrainingEligibilityAt: string;
  recommendationOnly: true; requiresDataAndQualityGate: true; trainingEnabled: false;
  policy: 'release_plus_7_days_not_before_observation';
}
type CatalogProvider = 'opendota' | 'valve';
const VALVE_PATCH_VERSION = /^[1-9][0-9]{0,2}\.[0-9]{2}[a-z]?$/;
const sources = {
  opendota: { source: PATCH_CATALOG_SOURCE, stateFile: PATCH_STATE_FILE, identity: 'opendota_patch_catalog', prefix: 'opendota' },
  valve: { source: VALVE_PATCH_SOURCE, stateFile: VALVE_PATCH_STATE_FILE, identity: 'valve_patch_catalog', prefix: 'valve' },
} as const;
export interface CatalogPatch { name: string; date: string; id?: number }
interface CatalogSnapshot {
  version: 1; source: string; receivedAt: string; hash: string;
  identity: 'opendota_patch_catalog' | 'valve_patch_catalog'; calendarOnly: true; observation?: OfficialPatchObservation;
  latest: CatalogPatch; catalog: CatalogPatch[];
}
interface SnapshotRef { file: string; hash: string; receivedAt: string; latest: CatalogPatch }
interface CatalogState {
  version: 1; source: string; lastAttemptAt: string; nextCheckAt: string;
  status: 'pending' | 'succeeded' | 'degraded'; reason: string;
  lastSuccessfulReceivedAt?: string; snapshot?: SnapshotRef; observation?: OfficialPatchObservation;
}
export interface PatchCheckResult {
  state: 'succeeded' | 'skipped' | 'degraded'; reason: string; attempted: boolean;
  nextCheckAt?: string; receivedAt?: string; hash?: string;
  latestPatch?: string; snapshotFile?: string; observation?: OfficialPatchObservation;
}
class CatalogError extends Error {
  constructor(readonly reason: string, readonly retryAt?: number) { super(reason); }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function iso(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw new CatalogError('invalid_catalog_date');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new CatalogError('invalid_catalog_date');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new CatalogError('invalid_catalog_date');
  return new Date(milliseconds).toISOString();
}
/** Dates describe the catalog; neither a release date nor an ID proves a match version. */
export function normalizePatchCatalog(value: unknown, receivedAt: number, compareNames = (a: string, b: string) => a.localeCompare(b, 'en')): { catalog: CatalogPatch[]; latest: CatalogPatch; hash: string } {
  if (!Number.isFinite(receivedAt)) throw new CatalogError('invalid_clock');
  const entries = Array.isArray(value) ? value : object(value) ? [value] : [];
  if (entries.length === 0 || entries.length > 5000) throw new CatalogError('invalid_catalog_schema');
  const names = new Set<string>(), ids = new Set<number>();
  const catalog = entries.map(entry => {
    const row = object(entry);
    if (!row || typeof row.name !== 'string' || !/^[0-9][0-9a-zA-Z._-]{0,31}$/.test(row.name) || names.has(row.name)) throw new CatalogError('invalid_catalog_schema');
    names.add(row.name);
    const patch: CatalogPatch = { name: row.name, date: iso(row.date) };
    if (row.id !== undefined) {
      if (!Number.isSafeInteger(row.id) || Number(row.id) < 0 || ids.has(Number(row.id))) throw new CatalogError('invalid_catalog_schema');
      patch.id = Number(row.id); ids.add(patch.id);
    }
    return patch;
  }).sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || compareNames(a.name, b.name));
  const latest = catalog.filter(patch => Date.parse(patch.date) <= receivedAt).at(-1);
  if (!latest) throw new CatalogError('no_released_patch');
  return { catalog, latest, hash: createHash('sha256').update(JSON.stringify(catalog)).digest('hex') };
}


/** Compare full Dota versions without collapsing letter patches into floats. */
export function compareDotaPatchVersions(left: string, right: string): number {
  if (!VALVE_PATCH_VERSION.test(left) || !VALVE_PATCH_VERSION.test(right)) throw new CatalogError('invalid_valve_patch_version');
  const parts = (version: string) => {
    const [major, tail] = version.split('.');
    return [Number(major), Number(tail.slice(0, 2)), tail.length === 3 ? tail.charCodeAt(2) - 96 : 0];
  };
  const a = parts(left), b = parts(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Valve's numeric/letter versions are authoritative calendar labels, never OpenDota IDs. */
export function normalizeValvePatchCatalog(value: unknown, receivedAt: number): ReturnType<typeof normalizePatchCatalog> {
  const body = object(value);
  if (!body || body.success !== true || !Array.isArray(body.patches) || body.patches.length === 0 || body.patches.length > 5000) {
    throw new CatalogError('invalid_valve_catalog_schema');
  }
  const catalog = body.patches.map(value => {
    const row = object(value);
    if (!row || typeof row.patch_number !== 'string' || !VALVE_PATCH_VERSION.test(row.patch_number)
      || row.patch_name !== row.patch_number || !Number.isSafeInteger(row.patch_timestamp)
      || Number(row.patch_timestamp) <= 0 || Number(row.patch_timestamp) >= 8.64e12) {
      throw new CatalogError('invalid_valve_catalog_schema');
    }
    return {name: row.patch_number, date: new Date(Number(row.patch_timestamp) * 1000).toISOString()};
  });
  return normalizePatchCatalog(catalog, receivedAt, compareDotaPatchVersions);
}

function officialObservation(latest: CatalogPatch, receivedAt: string, previous?: OfficialPatchObservation): OfficialPatchObservation {
  const knownAt = previous?.name === latest.name ? previous.knownAt : receivedAt;
  return {name: latest.name, releasedAt: latest.date, knownAt,
    retrainingEligibilityAt: new Date(Math.max(Date.parse(latest.date) + PATCH_RETRAIN_DELAY_MS, Date.parse(knownAt))).toISOString(),
    recommendationOnly: true, requiresDataAndQualityGate: true, trainingEnabled: false,
    policy: 'release_plus_7_days_not_before_observation'};
}

/** Missing/stale official observations must not silently fall back to coarse OD versions. */
export function comparePatchCatalogs(official: PatchCheckResult, secondary: PatchCheckResult) {
  const latestOfficial = official.latestPatch ?? null;
  const latestOpenDota = secondary.latestPatch ?? null;
  return { latestOfficial, latestOpenDota,
    catalogsDisagree: latestOfficial && latestOpenDota ? latestOfficial !== latestOpenDota : null,
    officialStatus: official.state, secondaryStatus: secondary.state,
    observation: official.observation ?? null, matchVersionsAssigned: false, trainingEnabled: false };
}

/** The collector is only called while the external runner owns its global lock. */
export function assertPatchPipelineGuard(stateDir: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const owner = JSON.parse(readFileSync(join(stateDir, 'pipeline.lock', 'owner.json'), 'utf8')) as {runId?: unknown; pid?: unknown};
    if (!env.AEGIS_PIPELINE_RUN_ID || owner.runId !== env.AEGIS_PIPELINE_RUN_ID
      || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0
      || String(owner.pid) !== env.AEGIS_PIPELINE_OWNER_PID) throw new Error();
    process.kill(Number(owner.pid), 0);
  } catch { throw new CatalogError('pipeline_guard_required'); }
}
function atomicJson(filename: string, value: unknown): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
  renameSync(temporary, filename);
}
function loadState(stateDir: string, provider: CatalogProvider): CatalogState | null {
  const spec = sources[provider];
  let state: CatalogState;
  try { state = JSON.parse(readFileSync(join(stateDir, spec.stateFile), 'utf8')) as CatalogState; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CatalogError('invalid_checkpoint');
  }
  try {
    if (state.version !== 1 || state.source !== spec.source || !['pending', 'succeeded', 'degraded'].includes(state.status)
      || typeof state.reason !== 'string' || iso(state.lastAttemptAt) !== state.lastAttemptAt || iso(state.nextCheckAt) !== state.nextCheckAt
      || Date.parse(state.nextCheckAt) < Date.parse(state.lastAttemptAt)) throw new Error();
    if (state.snapshot) {
      const ref = state.snapshot;
      if (!/^(opendota|valve)-patches-[\dTZ-]+-[a-f0-9]{64}-[a-f0-9-]{36}\.json$/.test(ref.file) || !ref.file.startsWith(spec.prefix + '-')) throw new Error();
      const saved = JSON.parse(readFileSync(join(stateDir, ref.file), 'utf8')) as CatalogSnapshot;
      const verified = normalizePatchCatalog(saved.catalog, Date.parse(saved.receivedAt), provider === 'valve' ? compareDotaPatchVersions : undefined);
      if (saved.version !== 1 || saved.source !== spec.source || saved.identity !== spec.identity
        || saved.calendarOnly !== true || iso(saved.receivedAt) !== ref.receivedAt || saved.hash !== ref.hash
        || verified.hash !== ref.hash || JSON.stringify(verified.latest) !== JSON.stringify(ref.latest)
        || JSON.stringify(saved.latest) !== JSON.stringify(ref.latest)) throw new Error();
      if (provider === 'valve') {
        const observation = state.observation;
        if (saved.catalog.some(patch => patch.id !== undefined || !VALVE_PATCH_VERSION.test(patch.name))
          || !observation || iso(observation.knownAt) !== observation.knownAt || observation.knownAt > ref.receivedAt
          || JSON.stringify(observation) !== JSON.stringify(officialObservation(ref.latest, observation.knownAt))
          || JSON.stringify(saved.observation) !== JSON.stringify(observation)) throw new Error();
      }
    } else if (state.status === 'succeeded') throw new Error();
    return state;
  } catch { throw new CatalogError('invalid_checkpoint'); }
}
function retryDeadline(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const parsed = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(parsed) && parsed >= now && parsed < 8.64e15 ? parsed : undefined;
}
function failure(error: unknown): { reason: string; retryAt?: number } {
  if (error instanceof CatalogError) return { reason: error.reason, retryAt: error.retryAt };
  if (object(error)?.code === 'OD_DEFERRED') {
    const retryAt = Number(object(error)?.retryAt);
    return { reason: 'shared_budget_deferred', retryAt: Number.isFinite(retryAt) && retryAt < 8.64e15 ? retryAt : undefined };
  }
  // Never persist or log an upstream message, response body, URL or credentials.
  return { reason: error instanceof SyntaxError ? 'invalid_json' : 'request_or_storage_failure' };
}
export async function checkPatchCatalog(options: {
  stateDir: string | undefined; fetchImpl: typeof fetch; now?: () => number;
  assertGuard?: () => void; provider?: CatalogProvider;
}): Promise<PatchCheckResult> {
  const now = options.now ?? Date.now;
  const provider = options.provider ?? 'opendota';
  const spec = sources[provider];
  const stateDir = options.stateDir;
  if (!stateDir || !isAbsolute(stateDir)) return { state: 'degraded', reason: 'absolute_state_dir_required', attempted: false };
  const guard = options.assertGuard ?? (() => assertPatchPipelineGuard(stateDir));
  let previous: CatalogState | null;
  try { guard(); previous = loadState(stateDir, provider); }
  catch (error) { return { state: 'degraded', reason: failure(error).reason, attempted: false }; }
  const startedAt = now();
  if (!Number.isFinite(startedAt) || Math.abs(startedAt) >= 8.64e15 - PATCH_CHECK_INTERVAL_MS) {
    return { state: 'degraded', reason: 'invalid_clock', attempted: false };
  }
  if (previous && startedAt < Date.parse(previous.lastAttemptAt)) {
    return { state: 'degraded', reason: 'clock_moved_backwards', attempted: false, nextCheckAt: previous.nextCheckAt };
  }
  if (previous && startedAt < Date.parse(previous.nextCheckAt)) {
    return { state: previous.status === 'succeeded' ? 'skipped' : 'degraded',
      reason: previous.status === 'succeeded' ? 'cooldown' : 'retry_cooldown', attempted: false,
      nextCheckAt: previous.nextCheckAt, hash: previous.snapshot?.hash, latestPatch: previous.snapshot?.latest.name,
      receivedAt: previous.lastSuccessfulReceivedAt, observation: previous.observation };
  }
  const pending: CatalogState = { ...previous, version: 1, source: spec.source,
    lastAttemptAt: new Date(startedAt).toISOString(), nextCheckAt: new Date(startedAt + PATCH_FAILURE_RETRY_MS).toISOString(), status: 'pending', reason: 'request_pending' };
  let attempted = false;
  try {
    guard(); mkdirSync(stateDir, { recursive: true });
    // Reserve an attempt before network I/O: a killed collector cannot retry hourly without a bound.
    atomicJson(join(stateDir, spec.stateFile), pending);
    attempted = true;
    const response = await options.fetchImpl(spec.source, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      const retryAt = retryDeadline(response.headers.get('retry-after'), now());
      await response.body?.cancel().catch(() => {});
      throw new CatalogError(`http_${response.status}`, retryAt);
    }
    const data: unknown = await response.json();
    const receivedAtMs = now();
    if (receivedAtMs < startedAt) throw new CatalogError('clock_moved_backwards');
    const receivedAt = new Date(receivedAtMs).toISOString();
    const normalized = provider === 'valve' ? normalizeValvePatchCatalog(data, receivedAtMs) : normalizePatchCatalog(data, receivedAtMs);
    if (provider === 'valve' && previous?.snapshot && compareDotaPatchVersions(normalized.latest.name, previous.snapshot.latest.name) < 0) {
      throw new CatalogError('official_catalog_regressed');
    }
    const observation = provider === 'valve' ? officialObservation(normalized.latest, receivedAt, previous?.observation) : undefined;
    const changed = previous?.snapshot?.hash !== normalized.hash
      || JSON.stringify(previous.snapshot.latest) !== JSON.stringify(normalized.latest);
    let snapshot = previous?.snapshot;
    guard();
    if (changed || !snapshot) {
      const file = `${spec.prefix}-patches-${receivedAt.replace(/[:.]/g, '-')}-${normalized.hash}-${randomUUID()}.json`;
      const revision: CatalogSnapshot = { version: 1, source: spec.source, receivedAt,
        identity: spec.identity, calendarOnly: true, ...normalized, ...(observation ? {observation} : {}) };
      atomicJson(join(stateDir, file), revision);
      snapshot = { file, hash: normalized.hash, receivedAt, latest: normalized.latest };
    }
    const reason = !previous?.snapshot ? 'initial_catalog' : !changed ? 'unchanged'
      : (provider === 'valve' ? compareDotaPatchVersions(normalized.latest.name, previous.snapshot.latest.name) > 0
        : Date.parse(normalized.latest.date) > Date.parse(previous.snapshot.latest.date)) ? 'new_patch' : 'catalog_changed';
    const complete: CatalogState = { ...pending, status: 'succeeded', reason, lastSuccessfulReceivedAt: receivedAt,
      nextCheckAt: new Date(receivedAtMs + PATCH_CHECK_INTERVAL_MS).toISOString(), snapshot, ...(observation ? {observation} : {}) };
    guard(); atomicJson(join(stateDir, spec.stateFile), complete);
    return { state: 'succeeded', reason, attempted, nextCheckAt: complete.nextCheckAt, receivedAt,
      hash: snapshot.hash, latestPatch: snapshot.latest.name, snapshotFile: snapshot.file, observation };
  } catch (error) {
    const problem = failure(error);
    const nextCheckAt = new Date(Math.max(startedAt + PATCH_FAILURE_RETRY_MS, Number.isFinite(now()) ? now() + PATCH_FAILURE_RETRY_MS : 0, problem.retryAt ?? 0)).toISOString();
    const failed: CatalogState = { ...pending, status: 'degraded', reason: problem.reason, nextCheckAt };
    try { guard(); atomicJson(join(stateDir, spec.stateFile), failed); }
    catch { return { state: 'degraded', reason: 'checkpoint_or_guard_failure', attempted }; }
    return { state: 'degraded', reason: problem.reason, attempted, nextCheckAt, hash: previous?.snapshot?.hash, latestPatch: previous?.snapshot?.latest.name,
      receivedAt: previous?.lastSuccessfulReceivedAt, observation: previous?.observation };
  }
}
