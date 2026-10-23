/** Future-only full decoded provider JSON sidecar. No request URL/key inputs.
 * Separate from the immutable selected receipt and schema3 parsed projection.
 * This is a post-match detail source, never an actual-live observation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Job = 'refresh_match_details' | 'ingest_parsed';
export const RAW_MATCH_JSON_CONTRACT = 'opendota_full_decoded_match_json.v1';
export const RAW_MATCH_JSON_MAX_BYTES = 16 * 1024 * 1024;
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const SECRET_KEY = /^(?:authorization|proxy-authorization|x-api-key|x-webapi-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|request[_-]?url|request[_-]?uri|request[_-]?headers|headers|__proto__|constructor|prototype)$/i;
const KEYED_URL = /[?&](?:key|api[_-]?key|access[_-]?token|token|password|secret)=/i;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const stamp = (value: Date) => { const t = value.getTime(); if (!Number.isFinite(t) || t <= 0) throw Error('raw_capture_time'); return t; };

function cleanFullJson(input: unknown): { payload: Json; body: string; redactedFields: number; redactedUrlValues: number } {
  let bytes = 0, nodes = 0, redactedFields = 0, redactedUrlValues = 0;
  const charge = (n: number) => { bytes += n; if (bytes > RAW_MATCH_JSON_MAX_BYTES) throw Error('raw_json_byte_bound'); };
  function visit(value: unknown, depth = 0): Json {
    if (++nodes > 1_000_000 || depth > 100) throw Error('raw_json_structure_bound');
    if (value === null || typeof value === 'boolean') { charge(5); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { charge(32); return value; }
    if (typeof value === 'string') {
      const text = KEYED_URL.test(value) ? (redactedUrlValues++, '[redacted credential-bearing URL]') : value;
      charge(Buffer.byteLength(JSON.stringify(text))); return text;
    }
    if (Array.isArray(value)) { charge(value.length + 2); return value.map(v => visit(v, depth + 1)); }
    if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('raw_json_value');
    const output: Record<string, Json> = Object.create(null); charge(2);
    for (const key of Object.keys(value).sort()) {
      if (SECRET_KEY.test(key)) { redactedFields++; continue; }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw Error('raw_json_accessor');
      charge(Buffer.byteLength(JSON.stringify(key)) + 2); output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  }
  const payload = visit(input), body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > RAW_MATCH_JSON_MAX_BYTES) throw Error('raw_json_byte_bound');
  return { payload, body, redactedFields, redactedUrlValues };
}

function storageRoot(stateDirectory: string | undefined): string {
  if (!stateDirectory || !isAbsolute(stateDirectory)) throw Error('raw_absolute_state_required');
  return join(resolve(stateDirectory), 'observations', 'opendota-full-match-json');
}
function safeDirectories(directory: string, create: boolean) {
  const chain: string[] = []; let current = resolve(directory);
  for (;;) { chain.push(current); const parent = dirname(current); if (parent === current) break; current = parent; }
  for (const part of chain.reverse()) {
    if (!existsSync(part)) { if (!create) throw Error('raw_directory_missing'); mkdirSync(part); }
    const info = lstatSync(part); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('raw_directory_type');
  }
}
function regularBytes(filename: string, limit: number): Buffer {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw Error('raw_file_type_or_bound');
  const body = readFileSync(filename); if (body.length > limit) throw Error('raw_file_byte_bound'); return body;
}
function putImmutable(filename: string, body: Buffer, verify: (existing: Buffer) => void) {
  if (existsSync(filename)) { verify(regularBytes(filename, RAW_MATCH_JSON_MAX_BYTES + 65536)); return; }
  const temporary = join(dirname(filename), '.pending-' + randomUUID()); let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, body); fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temporary, filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; verify(regularBytes(filename, RAW_MATCH_JSON_MAX_BYTES + 65536)); }
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
}
function receiptFile(stateDirectory: string | undefined, matchId: number, requestedAt: Date, observationFile?: string): string {
  const root = storageRoot(stateDirectory); let date = requestedAt.toISOString().slice(0, 10), nonce: string = randomUUID();
  if (observationFile) {
    const selectedRoot = join(resolve(stateDirectory!), 'observations', 'opendota-match-details');
    const parts = relative(selectedRoot, resolve(observationFile)).split(/[\\/]/);
    const match = parts[1]?.match(new RegExp(`^${matchId}-([a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\\.json\\.gz$`));
    if (parts.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0]) || !match) throw Error('raw_selected_receipt_path');
    date = parts[0]; nonce = match[1];
  }
  return join(root, 'receipts', date, `${matchId}-${nonce}.json`);
}

export interface FullMatchJsonReceipt {
  contract: typeof RAW_MATCH_JSON_CONTRACT; source: 'opendota'; sourceEndpoint: 'GET_matches_by_id'; job: Job; matchId: number;
  evidenceCohort: 'post_match'; actualLive: false; terminalStateIndependentlyVerified: false;
  requestStartedAt: string; requestTimeMeaning: 'bounded_get_operation_start_including_policy_waits_and_retries';
  receivedAt: string; receiptTimeMeaning: 'collector_json_decode_completed'; payloadPersistedAt: string;
  payloadRepresentation: 'full_decoded_json_with_explicit_secret_redaction'; providerWireBytesRetained: false; originalWireSha256: null;
  payloadSha256: string; payloadBytes: number; payloadFile: string; redactedFields: number; redactedUrlValues: number;
  originalHistoricalAvailabilityProven: false; selectedObservationFilename: string | null;
}
export type RawRetentionResult = { status: 'retained'; receiptFile: string; receipt: FullMatchJsonReceipt }
  | { status: 'not_retained'; reason: 'raw_json_bound_or_invalid' | 'raw_storage_or_identity_failure' };

/** Recovery for a future attempt whose full JSON was published before the old
 * selected receipt. No GET is needed; the original receipt time is retained.
 * Old selected receipts without this new companion are left unchanged.
 */
function readRawMatchResponseUnchecked(stateDirectory: string | undefined, observationFile: string, matchId: number): { payload: unknown; receipt: FullMatchJsonReceipt } | null {
  if (!positiveId(matchId)) throw Error('raw_match_identity');
  const target = receiptFile(stateDirectory, matchId, new Date(1), observationFile);
  if (!existsSync(target)) return null;
  safeDirectories(dirname(target), false);
  const receipt = JSON.parse(regularBytes(target, 65536).toString('utf8')) as FullMatchJsonReceipt;
  if (receipt.contract !== RAW_MATCH_JSON_CONTRACT || receipt.matchId !== matchId || receipt.source !== 'opendota'
    || receipt.sourceEndpoint !== 'GET_matches_by_id' || receipt.evidenceCohort !== 'post_match' || receipt.actualLive !== false
    || receipt.providerWireBytesRetained !== false || receipt.originalWireSha256 !== null || receipt.job !== 'refresh_match_details'
    || receipt.terminalStateIndependentlyVerified !== false || receipt.originalHistoricalAvailabilityProven !== false
    || receipt.payloadRepresentation !== 'full_decoded_json_with_explicit_secret_redaction'
    || receipt.requestTimeMeaning !== 'bounded_get_operation_start_including_policy_waits_and_retries' || receipt.receiptTimeMeaning !== 'collector_json_decode_completed'
    || !Number.isSafeInteger(receipt.redactedFields) || receipt.redactedFields < 0 || !Number.isSafeInteger(receipt.redactedUrlValues) || receipt.redactedUrlValues < 0
    || receipt.selectedObservationFilename !== basename(observationFile)
    || !/^[a-f0-9]{64}$/.test(receipt.payloadSha256) || receipt.payloadFile !== `payloads/${receipt.payloadSha256}.json.gz`
    || !Number.isSafeInteger(receipt.payloadBytes) || receipt.payloadBytes <= 0 || receipt.payloadBytes > RAW_MATCH_JSON_MAX_BYTES) throw Error('raw_receipt_contract');
  const times = [receipt.requestStartedAt, receipt.receivedAt, receipt.payloadPersistedAt].map(v => stamp(new Date(v)));
  if (!(times[0] <= times[1] && times[1] <= times[2])) throw Error('raw_receipt_time_order');
  const file = join(storageRoot(stateDirectory), 'payloads', `${receipt.payloadSha256}.json.gz`);
  safeDirectories(dirname(file), false);
  const payloadBody = gunzipSync(regularBytes(file, RAW_MATCH_JSON_MAX_BYTES + 65536), { maxOutputLength: RAW_MATCH_JSON_MAX_BYTES });
  if (payloadBody.length !== receipt.payloadBytes || sha(payloadBody) !== receipt.payloadSha256) throw Error('raw_payload_pin');
  const payload: unknown = JSON.parse(payloadBody.toString('utf8'));
  if (!record(payload) || payload.match_id !== matchId) throw Error('raw_payload_identity');
  return { payload, receipt };
}

export function readRawMatchResponse(stateDirectory: string | undefined, observationFile: string, matchId: number): { payload: unknown; receipt: FullMatchJsonReceipt } | null {
  try { return readRawMatchResponseUnchecked(stateDirectory, observationFile, matchId); }
  catch { throw Error('raw_response_recovery_invalid'); } // parser errors may echo payload fragments
}

/** Best-effort additive retention does not change provider quotas/retries or DB
 * projection. A safe reason is returned; no raw error/URL/body is logged here.
 */
export function retainRawMatchResponse(stateDirectory: string | undefined, detail: unknown, options: {
  matchId: number; job: Job; requestStartedAt: Date; receivedAt: Date; observationFile?: string; now?: () => Date;
}): RawRetentionResult {
  try {
    if (!positiveId(options.matchId) || !record(detail) || detail.match_id !== options.matchId || !['refresh_match_details', 'ingest_parsed'].includes(options.job)) throw Error('raw_capture_identity');
    if (stamp(options.requestStartedAt) > stamp(options.receivedAt)) throw Error('raw_capture_time_order');
    const cleaned = cleanFullJson(detail), hash = sha(cleaned.body), root = storageRoot(stateDirectory);
    const target = receiptFile(stateDirectory, options.matchId, options.requestStartedAt, options.observationFile);
    if (options.observationFile && existsSync(target)) {
      const saved = readRawMatchResponse(stateDirectory, options.observationFile, options.matchId)!;
      if (saved.receipt.payloadSha256 !== hash || saved.receipt.requestStartedAt !== options.requestStartedAt.toISOString() || saved.receipt.receivedAt !== options.receivedAt.toISOString()) throw Error('raw_immutable_receipt_conflict');
      return { status: 'retained', receiptFile: target, receipt: saved.receipt };
    }
    safeDirectories(join(root, 'payloads'), true); safeDirectories(dirname(target), true);
    const disk = statfsSync(root); if (disk.bavail * disk.bsize < MIN_FREE_BYTES + RAW_MATCH_JSON_MAX_BYTES + 65536) throw Error('raw_disk_floor');
    const payloadFile = join(root, 'payloads', hash + '.json.gz'), payload = Buffer.from(cleaned.body);
    putImmutable(payloadFile, gzipSync(payload), existing => { if (!gunzipSync(existing, { maxOutputLength: RAW_MATCH_JSON_MAX_BYTES }).equals(payload)) throw Error('raw_immutable_payload_conflict'); });
    const persistedAt = (options.now ?? (() => new Date()))();
    if (stamp(persistedAt) < stamp(options.receivedAt)) throw Error('raw_persist_before_receipt');
    const receipt: FullMatchJsonReceipt = { contract: RAW_MATCH_JSON_CONTRACT, source: 'opendota', sourceEndpoint: 'GET_matches_by_id', job: options.job, matchId: options.matchId,
      evidenceCohort: 'post_match', actualLive: false, terminalStateIndependentlyVerified: false,
      requestStartedAt: options.requestStartedAt.toISOString(), requestTimeMeaning: 'bounded_get_operation_start_including_policy_waits_and_retries',
      receivedAt: options.receivedAt.toISOString(), receiptTimeMeaning: 'collector_json_decode_completed', payloadPersistedAt: persistedAt.toISOString(),
      payloadRepresentation: 'full_decoded_json_with_explicit_secret_redaction', providerWireBytesRetained: false, originalWireSha256: null,
      payloadSha256: hash, payloadBytes: payload.length, payloadFile: `payloads/${hash}.json.gz`, redactedFields: cleaned.redactedFields, redactedUrlValues: cleaned.redactedUrlValues,
      originalHistoricalAvailabilityProven: false, selectedObservationFilename: options.observationFile ? basename(options.observationFile) : null };
    const bytes = Buffer.from(JSON.stringify(receipt)); putImmutable(target, bytes, existing => { if (!existing.equals(bytes)) throw Error('raw_immutable_receipt_conflict'); });
    return { status: 'retained', receiptFile: target, receipt };
  } catch (error) {
    return { status: 'not_retained', reason: error instanceof Error && /^raw_json_/.test(error.message) ? 'raw_json_bound_or_invalid' : 'raw_storage_or_identity_failure' };
  }
}
