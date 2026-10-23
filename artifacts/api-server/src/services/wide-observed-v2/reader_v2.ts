/** Additive trusted-reader seam; no endpoint, provider, model, or DB writes.
 * storedAnchor must come from Python load_anchor_binding(actual AnchorStore).
 * This function verifies transport consistency, NOT caller authentication.
 * Python reloads its actual store and checks binding equality before projection.
 */
import {createHash} from 'node:crypto';
import {CURRENT_SQL,HISTORY_SQL,MAX_CANDIDATES} from './queries_v1';
import {selectWideHistoryV2,verify,verifyAnchor,type SourceRow} from './rosterResolution';
export {CURRENT_SQL,HISTORY_SQL};
export const READER_POLICY='wide.committed-observation-reader.immutable-roster.v2';
export const ANCHOR_BINDING='wide.verified-stored-anchor-binding.v1';
export const FORMULA_BUNDLE='6cb12f4ced0eac6a162f0ae8c099e25344944a34bfebf716d4382d34fe7a6e32';
type DbRow=Record<string,unknown>;
type Evidence={stableJson:(v:unknown)=>string;evidenceHash:(v:unknown)=>string};
type Pool={connect:()=>Promise<{query:(sql:string,values?:unknown[])=>Promise<{rows:DbRow[]}>;release:()=>void}>};
export interface StoredAnchorBinding {
 contract:string;anchorSha256:string;matchId:number;anchorObservation:SourceRow;
 featureAsOf:string;priorComputedAt:string;builderBundleSha256:string;priorFeatureNamesSha256:string;
 anchorStoreValidated:true;trustedCallerRequired:true;eligibleForServing:false;
}
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const record=(v:unknown):v is DbRow=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const BINDING_KEYS=['contract','anchorSha256','matchId','anchorObservation','featureAsOf','priorComputedAt',
 'builderBundleSha256','priorFeatureNamesSha256','anchorStoreValidated','trustedCallerRequired','eligibleForServing'];
// Preserve nonzero microseconds of wall-clock priorComputedAt/readAt. Journal
// observation timestamps are independently subject to the reviewed ms-only rule.
export function micros(v:unknown):bigint {
 if(typeof v!=='string'||v.length>64||!/(Z|[+-]\d\d:\d\d)$/.test(v))throw Error('wide_reader_precise_time_invalid');
 const ms=Date.parse(v),fraction=v.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1]??'';
 if(!Number.isSafeInteger(ms)||/[1-9]/.test(fraction.slice(6)))throw Error('wide_reader_precise_time_invalid');
 return BigInt(ms)*1000n+BigInt(fraction.slice(3,6).padEnd(3,'0'));
}
function anchorBinding(value:unknown,schema:string,evidence:Evidence):StoredAnchorBinding {
 if(!record(value)||Object.keys(value).sort().join('|')!==[...BINDING_KEYS].sort().join('|')||value.contract!==ANCHOR_BINDING
  ||value.anchorStoreValidated!==true||value.trustedCallerRequired!==true||value.eligibleForServing!==false
  ||!digest(value.anchorSha256)||value.builderBundleSha256!==FORMULA_BUNDLE||!digest(value.priorFeatureNamesSha256))
  throw Error('wide_reader_verified_stored_anchor_required');
 const a=JSON.parse(evidence.stableJson(value)) as StoredAnchorBinding;
 verifyAnchor(a.anchorObservation,schema,evidence.evidenceHash);
 if(a.matchId!==a.anchorObservation.match_id||a.featureAsOf!==a.anchorObservation.received_at
   ||micros(a.priorComputedAt)<micros(a.featureAsOf))throw Error('wide_reader_anchor_binding_invalid');
 return a;
}
function matchId(v:unknown):number {
 if(typeof v==='string'&&/^[1-9][0-9]{0,15}$/.test(v))v=Number(v);
 if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1)throw Error('wide_reader_match_id_invalid');return v;
}
function bind(r:DbRow,evidence:Evidence):SourceRow {
 if(!record(r)||!record(r.input)||!digest(r.id)||!digest(r.input_hash)||!digest(r.schema_hash)
  ||typeof r.received_at!=='string'||typeof r.recorded_at!=='string'||!(r.game_time_sec===null||
   (typeof r.game_time_sec==='number'&&Number.isSafeInteger(r.game_time_sec))))throw Error('wide_reader_row_shape_invalid');
 const raw=evidence.stableJson(r.input);
 if(Buffer.byteLength(raw,'utf8')>65536)throw Error('wide_reader_input_size_limit');
 if(createHash('sha256').update(raw).digest('hex')!==r.input_hash||evidence.evidenceHash(r.input)!==r.input_hash)
  throw Error('wide_reader_input_hash_mismatch');
 return {id:r.id,match_id:matchId(r.match_id),game_time_sec:r.game_time_sec as number,input_hash:r.input_hash,
  schema_hash:r.schema_hash,input:JSON.parse(raw),canonicalInputJson:raw,received_at:r.received_at,recorded_at:r.recorded_at};
}
export async function readWideObservationV2(pool:Pool,observationId:string,schema:string,evidence:Evidence,storedAnchor:unknown) {
 if(!digest(observationId)||!digest(schema))throw Error('wide_reader_identity_invalid');
 // A missing historical anchor refuses before any query; no draft recovery here.
 const anchor=anchorBinding(storedAnchor,schema,evidence);
 const client=await pool.connect();let transaction=false;
 try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
  await client.query("SET LOCAL statement_timeout = '3000ms'");
  const rows=(await client.query(CURRENT_SQL,[observationId])).rows;
  if(rows.length!==1)throw Error('wide_reader_committed_current_missing');
  const raw=rows[0],bound=bind(raw,evidence);
  if(typeof raw.phase!=='string'||raw.phase.length>64||!record(raw.availability))throw Error('wide_reader_current_metadata_missing');
  const current={...bound,phase:raw.phase,availability:JSON.parse(evidence.stableJson(raw.availability))};
  if(current.id!==observationId)throw Error('wide_reader_current_identity_mismatch');
  verify(current,schema,evidence.evidenceHash);
  if(raw.availability.outcomeKnownAtCapture!==false)throw Error('wide_reader_capture_outcome_not_false');
  if(raw.outcome_known_at_read!==false)throw Error('wide_reader_outcome_known_or_unverified_at_read');
  if(typeof raw.read_at!=='string'||micros(current.recorded_at)>micros(raw.read_at)
   ||typeof raw.snapshot_id!=='string'||raw.snapshot_id.length>512||!/^[0-9]+:[0-9]+:[0-9,]*$/.test(raw.snapshot_id))
   throw Error('wide_reader_read_provenance_invalid');
  if(anchor.matchId!==current.match_id||micros(anchor.priorComputedAt)>micros(current.received_at))
   throw Error('wide_reader_stored_anchor_not_available_before_current');
  // Resolve current before spending another query; no player-array substitution.
  selectWideHistoryV2(current,[],anchor.anchorObservation,schema,evidence.evidenceHash,false);
  const history=(await client.query(HISTORY_SQL,[current.match_id,current.id,current.received_at,current.recorded_at])).rows;
  if(history.length>MAX_CANDIDATES)throw Error('wide_reader_history_query_truncated');
  const candidates=history.map(r=>bind(r,evidence));
  const selection=selectWideHistoryV2(current,candidates,anchor.anchorObservation,schema,evidence.evidenceHash,false);
  const result={current,candidates,selection,storedAnchor:anchor,queryTruncated:false,captureOutcomeKnown:false,
   outcomeKnownAtRead:false,provenance:{policy:READER_POLICY,source:'local_committed_journal',readAt:raw.read_at,
    snapshotId:raw.snapshot_id,isolation:'repeatable_read_read_only',originalCommitTimeProven:false,
    servingEligibilityAssessed:false,maxCandidates:MAX_CANDIDATES,
    queryHash:createHash('sha256').update(CURRENT_SQL+'\n'+HISTORY_SQL).digest('hex'),
    sourceAvailability:JSON.parse(evidence.stableJson(raw.availability)),
    sourceQualityReasons:raw.quality_reasons===undefined?null:JSON.parse(evidence.stableJson(raw.quality_reasons))}};
  await client.query('COMMIT');transaction=false;return result;
 }catch(error){if(transaction){try{await client.query('ROLLBACK');}catch{}}throw error;}
 finally{client.release();}
}
