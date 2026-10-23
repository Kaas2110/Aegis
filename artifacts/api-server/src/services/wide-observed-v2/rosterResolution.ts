/** File-only v2 projection. No provider, DB, model, or source-row rewriting.
 * Identity reuse is separate from current player-stat availability and quality.
 */
import { createHash } from 'node:crypto';
export const POLICY = 'wide.observed-history.600s.immutable-roster.v2';
export interface SourceRow {
  id: string; match_id: number; game_time_sec: number; input_hash: string;
  schema_hash: string; input: Record<string, unknown>; canonicalInputJson: string;
  received_at: string; recorded_at: string; phase?: string;
  availability?: Record<string, unknown>;
}
type Hash = (v: unknown) => string;
type Triple = [number, number, number];
const integer = (x: unknown, low = 0): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= low;
const digest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export function stamp(x: unknown): number {
  if (typeof x !== 'string' || x.length > 64 || !/(Z|[+-]\d\d:\d\d)$/.test(x)) throw Error('timestamp_invalid');
  if (/[1-9]/.test((x.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? '').slice(3))) throw Error('submillisecond_unsupported');
  const n = Date.parse(x); if (!Number.isFinite(n)) throw Error('timestamp_invalid'); return n;
}
export function verify(row: SourceRow, schema: string, hash: Hash) {
  if (!row || !digest(schema) || row.schema_hash !== schema || !digest(row.id) || !digest(row.input_hash)
    || !row.input || Array.isArray(row.input) || typeof row.input !== 'object') throw Error('source_hash_or_schema');
  const raw = row.canonicalInputJson;
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 65536) throw Error('canonical_input_bound');
  if (createHash('sha256').update(raw).digest('hex') !== row.input_hash
    || hash(row.input) !== row.input_hash || hash(JSON.parse(raw)) !== row.input_hash) throw Error('canonical_input_binding');
  const received = stamp(row.received_at), recorded = stamp(row.recorded_at);
  if (received > recorded || hash({contract:schema,inputHash:row.input_hash,receivedAt:new Date(received).toISOString()}) !== row.id)
    throw Error('observation_id_or_time');
  if (!integer(row.match_id,1) || row.input.matchId !== row.match_id || row.input.gameTimeSec !== row.game_time_sec)
    throw Error('denormalized_identity');
  for (const part of [row as unknown as Record<string,unknown>,row.input])
    if (part.synthetic === true || part.backfill === true || part.betweenMaps === true || ['synthetic','backfill'].includes(part.source as string))
      throw Error('nonactual_source');
  return {received,recorded};
}
function triples(p: Record<string, unknown>, full: boolean): Triple[] {
  if (!integer(p.radiantTeamId,1) || !integer(p.direTeamId,1) || p.radiantTeamId === p.direTeamId) throw Error('team_identity_missing_or_conflicting');
  if (!Array.isArray(p.players) || p.players.length < 1 || p.players.length > 10 || (full && p.players.length !== 10))
    throw Error('roster_count_invalid');
  const out: Triple[] = p.players.map(x => {
    if (!x || typeof x !== 'object' || !integer(x.team) || x.team > 1 || !integer(x.heroId,1) || x.heroId > 250
      || !integer(x.accountId,1) || x.accountId >= 4294967295) throw Error('player_identity_missing_or_unsupported');
    return [x.team,x.heroId,x.accountId];
  });
  const n = out.filter(x=>x[0]===0).length;
  if (n > 5 || out.length-n > 5 || (full && n !== 5) || new Set(out.map(x=>x[1])).size !== out.length
    || new Set(out.map(x=>x[2])).size !== out.length) throw Error('roster_duplicate_or_side_count');
  return out.sort((a,b)=>a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
}
export function source(row: SourceRow) { return {id:row.id,inputHash:row.input_hash,schemaHash:row.schema_hash,receivedAt:row.received_at,recordedAt:row.recorded_at}; }
export function verifyAnchor(anchor: SourceRow, schema: string, hash: Hash) {
  const times=verify(anchor,schema,hash), clock=anchor.game_time_sec, ids=triples(anchor.input,true);
  if (!integer(clock,-3600) || clock >= 60) throw Error('anchor_creation_clock_unsupported');
  if (anchor.phase !== (clock < 0 ? 'post_draft' : 'live')) throw Error('anchor_phase_invalid');
  if (anchor.availability?.outcomeKnownAtCapture !== false) throw Error('anchor_capture_outcome_not_false');
  return {times,ids,identity:[anchor.input.radiantTeamId,anchor.input.direTeamId,ids]};
}
/** Returned identities are metadata, never replacement raw player entries. */
export function resolveRoster(row: SourceRow, anchor: SourceRow, schema: string, hash: Hash) {
  const t=verify(row,schema,hash), a=verifyAnchor(anchor,schema,hash);
  if (row.match_id !== anchor.match_id) throw Error('anchor_map_mismatch');
  if (a.times.received > t.received || a.times.recorded > t.recorded) throw Error('identity_anchor_after_observation');
  const present=triples(row.input,false);
  if (row.input.radiantTeamId !== anchor.input.radiantTeamId || row.input.direTeamId !== anchor.input.direTeamId)
    throw Error('anchor_team_or_side_changed');
  const keys=new Set(a.ids.map(x=>JSON.stringify(x)));
  if (present.some(x=>!keys.has(JSON.stringify(x)))) throw Error('anchor_player_identity_contradiction');
  const have=new Set(present.map(x=>JSON.stringify(x)));
  return {policy:POLICY,identity:a.identity,anchorSource:source(anchor),observationSource:source(row),
    observedPlayerCount:present.length,observedSideCounts:[present.filter(x=>x[0]===0).length,present.filter(x=>x[0]===1).length],
    identityResolution:present.length===10?'complete_current_packet':'verified_subset_of_observed_anchor',
    missingIdentityTriples:a.ids.filter(x=>!have.has(JSON.stringify(x))),
    currentPlayerStatisticsReconstructed:false,rawInputPreserved:true,sourceDatabaseOriginVerified:false,
    servingEligibilityAssessed:false,coverage95Validated:false};
}
function state(row: SourceRow, pre=false) {
  const p=row.input;
  if (!integer(p.gameTimeSec,pre?-3600:0) || !integer(p.radiantScore) || !integer(p.direScore)) throw Error('clock_score_invalid');
  return {match_id:row.match_id,clock_seconds:p.gameTimeSec,radiant_kills:p.radiantScore,dire_kills:p.direScore,available_at:stamp(row.received_at)/1000};
}
type State=ReturnType<typeof state>;
const reg=(a:State,b:State)=>b.clock_seconds<a.clock_seconds || b.radiant_kills<a.radiant_kills || b.dire_kills<a.dire_kills;
/** No DISTINCT or lower-clock query filter may precede this selector.
 * Any post-anchor visible malformed roster refuses the projection, because
 * silently dropping its score/clock could remove a reset witness.
 */
export function selectWideHistoryV2(current:SourceRow,candidates:SourceRow[],anchor:SourceRow,schema:string,hash:Hash,queryTruncated:unknown) {
  if (queryTruncated !== false) throw Error('source_query_truncated_or_unknown');
  if (!Array.isArray(candidates) || candidates.length>1024) throw Error('history_count_bound');
  let bytes=0;
  for(const r of [anchor,current,...candidates]) {
    if(typeof r?.canonicalInputJson!=='string')throw Error('canonical_input_bound');
    bytes+=Buffer.byteLength(r.canonicalInputJson,'utf8');
    if(bytes>8*1024*1024)throw Error('history_total_source_bytes_bound');
  }
  const cutoff=verify(current,schema,hash), a=verifyAnchor(anchor,schema,hash), resolution=resolveRoster(current,anchor,schema,hash), c=state(current);
  const eligible:SourceRow[]=[],seen=new Set<string>(),excluded:{id:string;reason:string}[]=[];
  const resolutions:ReturnType<typeof resolveRoster>[]=[];
  for(const row of candidates) {
    const t=verify(row,schema,hash);
    let reason:string|null=null;
    if(row.match_id!==current.match_id)reason='different_map';
    else if(t.received>cutoff.received || t.recorded>cutoff.recorded)reason='after_current_cutoff';
    else if(row.id===current.id || seen.has(row.id))reason='duplicate_observation';
    else if(t.received<a.times.received || t.recorded<a.times.recorded)reason='before_identity_anchor';
    if(reason){excluded.push({id:row.id,reason});continue;}
    const rr=resolveRoster(row,anchor,schema,hash);state(row,true);
    seen.add(row.id);eligible.push(row);resolutions.push(rr);
  }
  eligible.sort((x,y)=>stamp(x.received_at)-stamp(y.received_at) || stamp(x.recorded_at)-stamp(y.recorded_at) || x.id.localeCompare(y.id,'en'));
  const lower=Math.max(0,c.clock_seconds-600);let previous:State|null=null;
  for(const row of eligible){const s=state(row,true);if(previous && reg(previous,s) && (previous.clock_seconds<lower || s.clock_seconds<lower))
    throw Error('history_regression_crosses_clock_window');previous=s;}
  const retained:SourceRow[]=[];let segment=new Map<number,SourceRow>(),resets=0;previous=null;
  for(const row of eligible){
    if(row.game_time_sec<lower){excluded.push({id:row.id,reason:'outside_clock_window'});continue;}
    const s=state(row);
    if(previous && reg(previous,s)){retained.push(...segment.values());segment=new Map();resets++;}
    const old=segment.get(s.clock_seconds);if(old)excluded.push({id:old.id,reason:'superseded_same_clock_within_forward_segment'});
    segment.set(s.clock_seconds,row);previous=s;
  }
  retained.push(...segment.values());
  if(retained.length>256 && resets)throw Error('history_regression_evidence_exceeds_capacity');
  const truncated=retained.length>256;
  if(truncated)for(const row of retained.splice(0,retained.length-256))excluded.push({id:row.id,reason:'history_capacity'});
  const byId=new Map(resolutions.map(x=>[x.observationSource.id,x]));
  return {status:'projected',reason:null,current:c,history:retained.map(x=>state(x)),sourceRows:retained.map(source),
    rosterResolution:{current:resolution,history:retained.map(x=>byId.get(x.id)),anchorSource:source(anchor)},
    diagnostics:{policy:POLICY,candidateCount:candidates.length,retainedCount:retained.length,lookbackGameSeconds:600,
      maxHistory:256,truncated,sourceIdentityConflict:false,regressionSegments:resets,servingEligibilityAssessed:false,
      coverage95Validated:false,currentPlayerStatisticsReconstructed:false,excluded}};
}
