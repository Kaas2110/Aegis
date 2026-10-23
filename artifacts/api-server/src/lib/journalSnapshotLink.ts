import { sql } from 'drizzle-orm';
import { observeLivePacket, LIVE_OBSERVATION_SCHEMA_HASH } from './liveObservationContract';
import { evidenceHash, stableJson } from './predictionEvidence';

type Observation = {
  id: string; matchId: number; snapshotId?: number|null; receivedAt: Date; recordedAt?: Date;
  gameTimeSec?: number|null; phase: string; inputHash: string; schemaHash: string;
  input: Record<string, unknown>;
};
type Snapshot = {
  id: number; matchId: number; source: string|null; capturedAt: Date;
  gameTimeSec: number|null; rawPayload: Record<string, unknown>|null;
};
export type SnapshotLinkProof = Readonly<{
  observationId: string; matchId: number; snapshotId: number; receivedAtIso: string;
  gameTimeSec: number|null; phase: string; inputHash: string; schemaHash: string;
  inputJson: string; rawJson: string;
}>;
const positive = (v: unknown): v is number => typeof v==='number' && Number.isSafeInteger(v) && v>0;
const validDate = (v: unknown): v is Date => v instanceof Date && Number.isFinite(v.getTime());

/** Attest the actual legacy snapshot, not a caller's arbitrary snapshot number.
 * Quality/availability and original timestamps are deliberately NOT regenerated.
 * Older schema versions remain unlinked until a matching versioned verifier exists.
 */
export function verifyJournalSnapshotLink(o: Observation, s: Snapshot|undefined): SnapshotLinkProof|null {
  if (!s || !positive(o.snapshotId) || o.snapshotId!==s.id || !positive(o.matchId)
    || o.matchId!==s.matchId || s.source!=='live' || !validDate(o.receivedAt)
    || !validDate(o.recordedAt) || !validDate(s.capturedAt)
    || s.capturedAt.getTime()!==o.receivedAt.getTime() || o.recordedAt<o.receivedAt
    || !s.rawPayload || typeof s.rawPayload!=='object' || Array.isArray(s.rawPayload)
    || o.schemaHash!==LIVE_OBSERVATION_SCHEMA_HASH) return null;
  const raw=s.rawPayload;
  if (raw.synthetic===true || raw.backfill===true || raw.betweenMaps===true
    || raw.source==='synthetic' || raw.source==='backfill') return null;
  try {
    const actual=observeLivePacket(raw,s.capturedAt,o.recordedAt);
    const inputJson=stableJson(o.input);
    if (actual.matchId!==o.matchId || actual.gameTimeSec!==s.gameTimeSec
      || actual.gameTimeSec!==o.gameTimeSec || actual.phase!==o.phase
      || actual.id!==o.id || actual.inputHash!==o.inputHash
      || actual.schemaHash!==o.schemaHash || evidenceHash(o.input)!==o.inputHash
      || stableJson(actual.input)!==inputJson) return null;
    return Object.freeze({observationId:o.id,matchId:o.matchId,snapshotId:s.id,
      receivedAtIso:o.receivedAt.toISOString(),gameTimeSec:actual.gameTimeSec,phase:o.phase,
      inputHash:o.inputHash,schemaHash:o.schemaHash,inputJson,rawJson:stableJson(raw)});
  } catch { return null; }
}

/** Execute inside the SAME legacy flush transaction after insert-on-conflict.
 * Re-check the stored immutable row and snapshot bytes in SQL. Concurrent source
 * changes or a nonnull link cause a no-op; only snapshot_id can be updated.
 */
export function journalSnapshotLinkSql(p: SnapshotLinkProof) {
  return sql`UPDATE live_observation_journal AS j
    SET snapshot_id=s.id
    FROM live_snapshots AS s
    WHERE j.id=${p.observationId} AND j.match_id=${p.matchId}
      AND j.snapshot_id IS NULL AND j.input_hash=${p.inputHash} AND j.schema_hash=${p.schemaHash}
      AND j.input=${p.inputJson}::jsonb AND j.phase=${p.phase}
      AND j.game_time_sec IS NOT DISTINCT FROM ${p.gameTimeSec}::integer
      AND j.received_at=${p.receivedAtIso}::timestamptz
      AND s.id=${p.snapshotId} AND s.match_id=j.match_id AND s.source='live'
      AND s.captured_at=j.received_at
      AND s.game_time_sec IS NOT DISTINCT FROM j.game_time_sec
      AND s.raw_payload=${p.rawJson}::jsonb`;
}
