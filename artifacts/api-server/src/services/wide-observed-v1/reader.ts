/** Staged read-only bridge. No provider calls, inference, writes or promotion. */
import { createHash } from 'node:crypto';
import { selectWideHistory, type JournalRow } from './liveWideHistoryPolicy';

export const READER_POLICY = 'wide.committed-observation-reader.v1';
export const MAX_CANDIDATES = 1024;
type DbRow = Record<string, unknown>;
type Client = { query: (sql: string, values?: unknown[]) => Promise<{rows: DbRow[]}>; release: () => void };
type Pool = { connect: () => Promise<Client> };
type Evidence = { stableJson: (v: unknown) => string; evidenceHash: (v: unknown) => string };
export type BoundRow = JournalRow & {canonicalInputJson: string};

// Format timestamps in SQL, not via pg's Date parser, so nonzero microseconds
// cannot silently disappear before the independently reviewed selector sees them.
const columns = `j.id, j.match_id::text AS match_id, j.game_time_sec,
  j.input_hash, j.schema_hash, j.input,
  to_char(j.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at,
  to_char(j.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at`;
export const CURRENT_SQL = `SELECT ${columns}, j.phase, j.availability, j.quality_reasons,
  (EXISTS(SELECT 1 FROM pro_matches p WHERE p.match_id=j.match_id
    AND p.radiant_win IS NOT NULL AND p.duration>0)
   OR EXISTS(SELECT 1 FROM live_journal_outcomes o WHERE o.match_id=j.match_id)) AS outcome_known_at_read,
  to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at,
  pg_current_snapshot()::text AS snapshot_id
  FROM live_observation_journal j WHERE j.id=$1`;
// NO DISTINCT ON clock and NO lower game-clock bound: either could erase a
// reset witness. The extra row is a truncation sentinel, never silently dropped.
export const HISTORY_SQL = `SELECT ${columns} FROM live_observation_journal j
  WHERE j.match_id=$1 AND j.id<>$2 AND j.received_at<=$3::timestamptz AND j.recorded_at<=$4::timestamptz
  ORDER BY j.received_at DESC,j.recorded_at DESC,j.id DESC LIMIT 1025`;
const digest = (v: unknown): v is string => typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
function record(v: unknown): v is DbRow { return typeof v==='object' && v!==null && !Array.isArray(v); }
function matchId(v: unknown): number {
  if (typeof v==='string' && /^[1-9][0-9]{0,15}$/.test(v)) v=Number(v);
  if (typeof v!=='number' || !Number.isSafeInteger(v) || v<1) throw Error('wide_reader_match_id_invalid');
  return v;
}
function bind(row: DbRow, evidence: Evidence): BoundRow {
  if (!record(row) || !record(row.input) || !digest(row.id) || !digest(row.input_hash) || !digest(row.schema_hash)
    || typeof row.received_at!=='string' || typeof row.recorded_at!=='string'
    || !(row.game_time_sec===null || (typeof row.game_time_sec==='number' && Number.isSafeInteger(row.game_time_sec))))
    throw Error('wide_reader_row_shape_invalid');
  const canonicalInputJson=evidence.stableJson(row.input);
  if (Buffer.byteLength(canonicalInputJson,'utf8')>64*1024) throw Error('wide_reader_input_size_limit');
  if (createHash('sha256').update(canonicalInputJson).digest('hex')!==row.input_hash
    || evidence.evidenceHash(row.input)!==row.input_hash) throw Error('wide_reader_input_hash_mismatch');
  // Own the decoded JSON; callers cannot mutate the database client's input object
  // after it was checked. Exact TS bytes accompany it for Python verification.
  return {id:row.id,match_id:matchId(row.match_id),game_time_sec:row.game_time_sec as number|null,
    input_hash:row.input_hash,schema_hash:row.schema_hash,input:JSON.parse(canonicalInputJson),
    received_at:row.received_at,recorded_at:row.recorded_at,canonicalInputJson};
}

export async function readWideObservation(pool: Pool, observationId: string, schema: string, evidence: Evidence) {
  if (!digest(observationId) || !digest(schema)) throw Error('wide_reader_identity_invalid');
  const client=await pool.connect(); let transaction=false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction=true;
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const rows=(await client.query(CURRENT_SQL,[observationId])).rows;
    if (rows.length!==1) throw Error('wide_reader_committed_current_missing');
    const raw=rows[0], bound=bind(raw,evidence);
    if(typeof raw.phase!=='string' || raw.phase.length>64 || !record(raw.availability))
      throw Error('wide_reader_current_metadata_missing');
    // These are committed journal metadata, not fields authenticated by input_hash.
    const current={...bound,phase:raw.phase,availability:JSON.parse(evidence.stableJson(raw.availability))};
    if(current.id!==observationId)throw Error('wide_reader_current_identity_mismatch');
    // Check the current ID, denormalized fields and exact timestamp precision
    // even when its phase/identity later makes it unavailable to a live model.
    selectWideHistory(current,[],schema,evidence.evidenceHash);
    if (!record(raw.availability) || raw.availability.outcomeKnownAtCapture!==false)
      throw Error('wide_reader_capture_outcome_not_false');
    if (raw.outcome_known_at_read!==false) throw Error('wide_reader_outcome_known_or_unverified_at_read');
    if(typeof raw.read_at!=='string' || !Number.isFinite(Date.parse(raw.read_at))
      || Date.parse(current.recorded_at)>Date.parse(raw.read_at)
      || typeof raw.snapshot_id!=='string' || !/^[0-9]+:[0-9]+:[0-9,]*$/.test(raw.snapshot_id))
      throw Error('wide_reader_read_provenance_invalid');
    const history=(await client.query(HISTORY_SQL,[current.match_id,current.id,current.received_at,current.recorded_at])).rows;
    if(history.length>MAX_CANDIDATES)throw Error('wide_reader_history_query_truncated');
    const candidates=history.map(row=>bind(row,evidence));
    const selection=selectWideHistory(current,candidates,schema,evidence.evidenceHash);
    const result={current,candidates,selection,queryTruncated:false as const,captureOutcomeKnown:false as const,
      outcomeKnownAtRead:false as const,provenance:{policy:READER_POLICY,source:'local_committed_journal',
        readAt:raw.read_at,snapshotId:raw.snapshot_id,isolation:'repeatable_read_read_only',
        originalCommitTimeProven:false,servingEligibilityAssessed:false,maxCandidates:MAX_CANDIDATES,
        queryHash:createHash('sha256').update(CURRENT_SQL+'\n'+HISTORY_SQL).digest('hex'),
        sourceAvailability:JSON.parse(evidence.stableJson(raw.availability)),
        sourceQualityReasons:raw.quality_reasons===undefined?null:JSON.parse(evidence.stableJson(raw.quality_reasons))}};
    await client.query('COMMIT'); transaction=false; return result;
  } catch(error) {
    if(transaction) { try { await client.query('ROLLBACK'); } catch { /* retain first failure, never log raw DB text */ } }
    throw error;
  } finally { client.release(); }
}
