import {observeLivePacket} from '../lib/liveObservationContract';
import {liveStateFreshness,LIVE_STATE_MAX_AGE_MS} from '../lib/liveStateFreshness';
import {captureLiveStateSource,LIVE_STATE_SOURCE_CONTRACT,LIVE_STATE_SOURCE_MAX_BYTES} from '../lib/liveStateSource';
import {stableJson} from '../lib/predictionEvidence';

export const WIDE_FRESHNESS_POLICY_VERSION='wide-existing-observed-state-gate.v1';
export const WIDE_FRESHNESS_EVIDENCE_CONTRACT=LIVE_STATE_SOURCE_CONTRACT;
export const WIDE_FRESHNESS_REASONS=new Set(['wide_source_quality_evidence_missing','wide_source_quality_binding',
 'wide_source_quality_ineligible','wide_source_quality_expired','wide_source_quality_expired_at_finish','wide_source_quality_gate_missing']);
type RecordValue=Record<string,any>;
export type WideSourceFreshness=Readonly<{policy:typeof WIDE_FRESHNESS_POLICY_VERSION;
 observationId:string;matchId:number;sourceInputHash:string}>;
const owned=new WeakMap<WideSourceFreshness,{packet:RecordValue;receivedAt:string}>();
const record=(v:unknown):v is RecordValue=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>stableJson(a)===stableJson(b);
const reject=(code:string):never=>{throw Error(code);};
function time(value:unknown):Date {
 if(typeof value!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(value)
  ||/[1-9]/.test((value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1]??'').slice(3)))return reject('wide_source_quality_binding');
 const d=new Date(value);if(!Number.isFinite(d.getTime()))return reject('wide_source_quality_binding');return d;
}
/** Called ONLY with a committed reader result. Never an endpoint accepting source claims.
 * Existing reader/authentication remains responsible for database origin. This verifies
 * exact binding and independently recomputes the already existing quality calculation.
 */
export function bindWideSourceFreshness(reader:unknown,now:Date):WideSourceFreshness {
 if(!record(reader)||!record(reader.current)||!record(reader.provenance))return reject('wide_source_quality_binding');
 const c=reader.current,a=c.availability,p=reader.provenance;
 if(!record(a)||!record(a.liveStateSource))return reject('wide_source_quality_evidence_missing');
 const source=a.liveStateSource;
 if(!record(source.rawPacket)||source.contract!==LIVE_STATE_SOURCE_CONTRACT
  ||Buffer.byteLength(stableJson(source))>LIVE_STATE_SOURCE_MAX_BYTES)return reject('wide_source_quality_binding');
 let expected:ReturnType<typeof observeLivePacket>;
 try{
  if(!same(captureLiveStateSource(source.rawPacket),source))return reject('wide_source_quality_binding');
  expected=observeLivePacket(source.rawPacket,time(c.received_at),time(c.recorded_at));
 }catch{return reject('wide_source_quality_binding');}
 if(p.source!=='local_committed_journal'||p.isolation!=='repeatable_read_read_only'
  ||a.outcomeKnownAtCapture!==false||reader.captureOutcomeKnown!==false||reader.outcomeKnownAtRead!==false
  ||!same(p.sourceAvailability,a)||!same(p.sourceQualityReasons,expected.qualityReasons)
  ||c.id!==expected.id||c.match_id!==expected.matchId||c.input_hash!==expected.inputHash
  ||c.schema_hash!==expected.schemaHash||c.game_time_sec!==expected.gameTimeSec||c.phase!==expected.phase
  ||c.canonicalInputJson!==stableJson(expected.input)||!same(c.input,expected.input)
  ||!same(a,{...expected.availability,outcomeKnownAtCapture:false}))return reject('wide_source_quality_binding');
 if(expected.availability.liveDataQuality.eligibleForObservedStatePrediction!==true)return reject('wide_source_quality_ineligible');
 if(reader.storedAnchor!==undefined){
  // A new gated cohort must not silently reuse an old anchor whose quality source
  // was never retained. Validate historical capture eligibility at its own time,
  // not whether that immutable prior is still a fresh live state now.
  const anchor=reader.storedAnchor?.anchorObservation;
  if(!record(anchor)||!record(anchor.availability?.liveStateSource))return reject('wide_source_quality_evidence_missing');
  let recomputed:ReturnType<typeof observeLivePacket>;
  try{
   const s=anchor.availability.liveStateSource;
   if(!same(captureLiveStateSource(s.rawPacket),s))return reject('wide_source_quality_binding');
   recomputed=observeLivePacket(s.rawPacket,time(anchor.received_at),time(anchor.recorded_at));
  }catch{return reject('wide_source_quality_binding');}
  if(anchor.id!==recomputed.id||anchor.match_id!==recomputed.matchId||anchor.input_hash!==recomputed.inputHash
    ||anchor.schema_hash!==recomputed.schemaHash||anchor.game_time_sec!==recomputed.gameTimeSec||anchor.phase!==recomputed.phase
    ||anchor.canonicalInputJson!==stableJson(recomputed.input)||!same(anchor.input,recomputed.input)
    ||!same(anchor.availability,{...recomputed.availability,outcomeKnownAtCapture:false}))return reject('wide_source_quality_binding');
  if(recomputed.availability.liveDataQuality.eligibleForObservedStatePrediction!==true)return reject('wide_source_quality_ineligible');
  const computed=reader.storedAnchor.priorComputedAt;
  if(typeof computed!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(computed)||!Number.isFinite(Date.parse(computed)))
   return reject('wide_source_quality_binding');
  // Preserve the strict boundary when Python's completion includes microseconds:
  // conservatively round any sub-millisecond remainder UP for the policy check.
  const fraction=computed.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1]??'';
  if(/[1-9]/.test(fraction.slice(6)))return reject('wide_source_quality_binding');
  const computedMs=Date.parse(computed)+(/[1-9]/.test(fraction.slice(3))?1:0);
  if(computedMs<recomputed.recordedAt.getTime()||!liveStateFreshness(anchor.availability.liveStateSource.rawPacket,
    recomputed.receivedAt.toISOString(),computedMs).eligibleForObservedStatePrediction)return reject('wide_source_quality_ineligible');
 }
 const token=Object.freeze({policy:WIDE_FRESHNESS_POLICY_VERSION,observationId:c.id,matchId:c.match_id,sourceInputHash:c.input_hash});
 owned.set(token,{packet:JSON.parse(JSON.stringify(source.rawPacket)),receivedAt:expected.receivedAt.toISOString()});
 assertWideSourceFreshness(token,now);return token;
}
/** Rechecked before HTTP and after inference; no network, database or provider call. */
export function assertWideSourceFreshness(token:WideSourceFreshness,now:Date):void {
 const source=owned.get(token);
 if(!source||token.policy!==WIDE_FRESHNESS_POLICY_VERSION)return reject('wide_source_quality_gate_missing');
 if(!(now instanceof Date)||!Number.isFinite(now.getTime())
  ||!liveStateFreshness(source.packet,source.receivedAt,now.getTime()).eligibleForObservedStatePrediction)
  return reject('wide_source_quality_expired');
}

/** Local policy validity deadlines, never claimed event timestamps. Only a factory-
 * owned source token can produce them. SQL must apply strict and inclusive bounds
 * separately because the existing marker rule permits equality at 308 seconds.
 */
export function wideSourceCompletionWindow(token:WideSourceFreshness):{validBefore:string;validThrough:string|null} {
 const source=owned.get(token);if(!source)return reject('wide_source_quality_gate_missing');
 const packet=source.packet,state=packet.__aegis_live_state;
 const receipt=Date.parse(source.receivedAt),changed=Date.parse(state.lastStateChangeReceivedAt);
 const inactive=typeof packet.deactivate_time==='number'&&Number.isFinite(packet.deactivate_time)&&packet.deactivate_time>0
   ?packet.deactivate_time*1000:Infinity;
 const before=Math.min(receipt+LIVE_STATE_MAX_AGE_MS,changed+LIVE_STATE_MAX_AGE_MS,inactive);
 const updated=packet.last_update_time;
 // 128s is the existing coarse-provider-marker allowance in liveStateFreshness;
 // that source file is pinned in this patch's installation dependency inventory.
 const marker=typeof updated==='number'&&Number.isFinite(updated)&&updated>=1262304000
   &&Number.isFinite(updated*1000+LIVE_STATE_MAX_AGE_MS+128000)?updated*1000+LIVE_STATE_MAX_AGE_MS+128000:null;
 if(!Number.isFinite(before))return reject('wide_source_quality_binding');
 // Date truncation is conservative for fractional provider clocks (<=1ms earlier).
 return {validBefore:new Date(Math.floor(before)).toISOString(),
  validThrough:marker===null||marker>=before?null:new Date(Math.floor(marker)).toISOString()};
}
