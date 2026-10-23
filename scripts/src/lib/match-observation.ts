/** Immutable, selected OpenDota responses for causal dataset reconstruction.
 * receivedAt is this collector's receipt time, never an inferred historical
 * availability time. A completed replay must not become a prematch feature.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = Record<string, unknown>;
const TOP_FIELDS = ['match_id', 'start_time', 'duration', 'patch', 'version',
  'game_mode', 'lobby_type', 'leagueid', 'radiant_team_id', 'dire_team_id',
  'radiant_win', 'radiant_score', 'dire_score', 'first_blood_time',
  'tower_status_radiant', 'tower_status_dire', 'barracks_status_radiant',
  'barracks_status_dire', 'radiant_gold_adv', 'radiant_xp_adv', 'picks_bans',
  'draft_timings', 'objectives', 'teamfights'] as const;
const PLAYER_FIELDS = ['account_id', 'player_slot', 'hero_id', 'hero_variant',
  'lane_role', 'is_roaming', 'kills', 'deaths', 'assists', 'level', 'xp_per_min',
  'gold_per_min', 'net_worth', 'total_gold', 'total_xp', 'last_hits', 'denies',
  'hero_damage', 'tower_damage', 'hero_healing', 'item_0', 'item_1', 'item_2',
  'item_3', 'item_4', 'item_5', 'backpack_0', 'backpack_1', 'backpack_2',
  'item_neutral', 'times', 'networth_t', 'gold_t', 'xp_t', 'lh_t', 'dn_t', 'kills_log',
  'buyback_log', 'purchase_log', 'obs_log', 'sen_log', 'obs_left_log',
  'sen_left_log', 'runes_log', 'connection_log', 'neutral_tokens_log',
  'neutral_item_history', 'ability_upgrades_arr'] as const;
const EXCLUDED = /^(?:chat|personaname|name|email|ip|ip_address|avatar(?:full|medium)?|profileurl|loccountrycode|realname|authorization|token|api_key|apiKey|password|__proto__|constructor|prototype)$/i;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

function clean(value: unknown, depth = 0): Json {
  if (depth > 20) throw new Error('Observation exceeds supported nesting');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
  const object = record(value);
  if (!object) throw new Error('Observation contains a non-JSON value');
  return Object.fromEntries(Object.keys(object).sort().filter(key => !EXCLUDED.test(key))
    .map(key => [key, clean(object[key], depth + 1)]));
}

function pick(value: RecordValue, fields: readonly string[]): Record<string, Json> {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key) && value[key] !== undefined)
    .sort().map(key => [key, clean(value[key])]));
}

export interface MatchObservation {
  schemaVersion: 1;
  source: 'opendota';
  endpoint: string;
  matchId: number;
  receivedAt: string;
  availabilityBasis: 'collector_response_receipt';
  payloadKind: 'selected_match_detail_v1';
  payloadSha256: string;
  payload: Record<string, Json>;
}

export function makeMatchObservation(detail: unknown, expectedMatchId: number,
  receivedAt: Date, nowMs = Date.now()): MatchObservation {
  const data = record(detail);
  if (!Number.isSafeInteger(expectedMatchId) || expectedMatchId <= 0 || data?.match_id !== expectedMatchId) {
    throw new Error('Observation match identity mismatch');
  }
  const receiptMs = receivedAt.getTime();
  if (!Number.isFinite(receiptMs) || receiptMs <= 0 || !Number.isFinite(nowMs) || receiptMs > nowMs + 30_000) {
    throw new Error('Observation receipt time is invalid or in the future');
  }
  const payload = pick(data, TOP_FIELDS);
  if (Object.hasOwn(data, 'players')) {
    if (!Array.isArray(data.players)) throw new Error('Observation players must be an array');
    payload.players = data.players.map(value => {
      const player = record(value);
      if (!player) throw new Error('Observation player must be an object');
      return pick(player, PLAYER_FIELDS);
    });
  }
  // Canonical ordering changes object keys only; player slots and all provider
  // time axes remain in their original array order. Numeric patch is untouched.
  const canonicalPayload = clean(payload) as Record<string, Json>;
  const payloadSha256 = createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
  return { schemaVersion: 1, source: 'opendota',
    endpoint: `https://api.opendota.com/api/matches/${expectedMatchId}`,
    matchId: expectedMatchId, receivedAt: receivedAt.toISOString(),
    availabilityBasis: 'collector_response_receipt', payloadKind: 'selected_match_detail_v1',
    payloadSha256, payload: canonicalPayload };
}

/** Write before database merge. Atomic publication, no replacement of existing
 * observations; identical retries are idempotent. Different receipts stay separate.
 */
function observationRoot(stateDirectory: string | undefined): string {
  if (!stateDirectory || !isAbsolute(stateDirectory)) throw new Error('An absolute AEGIS_STATE_DIR is required for observation storage');
  return resolve(stateDirectory);
}

function validateObservationPath(stateDirectory: string | undefined, filename: string, matchId: number): string {
  const root = join(observationRoot(stateDirectory), 'observations', 'opendota-match-details');
  const components = relative(root, resolve(filename)).split(/[\\/]/);
  const escapedId = String(matchId);
  if (components.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(components[0])
    || !(new RegExp(`^${escapedId}-(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\\.json\\.gz$`)).test(components[1])) {
    throw new Error('Observation file is outside its match journal');
  }
  return resolve(filename);
}

/** Persist this path in the attempt checkpoint BEFORE starting network I/O.
 * A restart can distinguish a published response from an interrupted fetch.
 */
export function planMatchObservationFile(stateDirectory: string | undefined, matchId: number, attemptedAt: Date): string {
  if (!Number.isSafeInteger(matchId) || matchId <= 0 || !Number.isFinite(attemptedAt.getTime())) throw new Error('Invalid observation attempt');
  return join(observationRoot(stateDirectory), 'observations', 'opendota-match-details',
    attemptedAt.toISOString().slice(0, 10), `${matchId}-${randomUUID()}.json.gz`);
}

export function readMatchObservation(stateDirectory: string | undefined, filename: string, matchId: number): MatchObservation | null {
  const target = validateObservationPath(stateDirectory, filename, matchId);
  if (!existsSync(target)) return null;
  const root = observationRoot(stateDirectory);
  for (const directory of [root, join(root, 'observations'), join(root, 'observations', 'opendota-match-details'), resolve(target, '..')]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Observation directory must be a regular directory');
  }
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Observation must be a regular file');
  const body = gunzipSync(readFileSync(target)).toString('utf8');
  const data = JSON.parse(body) as MatchObservation;
  const validated = makeMatchObservation(data.payload, matchId, new Date(data.receivedAt));
  if (JSON.stringify(validated) !== body) throw new Error('Observation metadata or content hash is invalid');
  return validated;
}

export function writeMatchObservation(stateDirectory: string | undefined, observation: MatchObservation, plannedFile?: string): string {
  // Check each directory we own; never follow an unexpected junction/symlink.
  const root = observationRoot(stateDirectory);
  const body = JSON.stringify(observation);
  const hash = createHash('sha256').update(body).digest('hex');
  const target = plannedFile ? validateObservationPath(stateDirectory, plannedFile, observation.matchId)
    : join(root, 'observations', 'opendota-match-details', observation.receivedAt.slice(0, 10), `${observation.matchId}-${hash}.json.gz`);
  const directories = [root, join(root, 'observations'), join(root, 'observations', 'opendota-match-details'),
    resolve(target, '..')];
  for (const directory of directories) {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Observation directory must be a regular directory');
  }
  const temporary = join(directories.at(-1)!, `.pending-${randomUUID()}`);
  const verifyExisting = () => {
    if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()
      || gunzipSync(readFileSync(target)).toString('utf8') !== body) {
      throw new Error('Existing observation does not match immutable content');
    }
  };
  if (existsSync(target)) { verifyExisting(); return target; }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, gzipSync(body));
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    try { linkSync(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      verifyExisting();
    }
    return target;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
