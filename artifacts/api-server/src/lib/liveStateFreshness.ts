import {evidenceHash} from './predictionEvidence';
import {safeOpenDotaId} from './openDotaLiveIds';
import {observedLiveDraft} from './observedLiveDraft';

const KEY = '__aegis_live_state';
// v1 treated missingness/identity changes as progress. Do not restore that evidence.
const VERSION = 'observed-state-v4';
export const LIVE_STATE_MAX_AGE_MS = 180_000;
export const LIVE_EVENT_MAX_DELAY_SECONDS = 300;
type Packet = Record<string,unknown>;
const finite = (v:unknown): v is number => typeof v==='number' && Number.isFinite(v);
const numeric = (v:unknown) => finite(v) ? v : null;
const time = (v:unknown) => typeof v==='string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;

interface StateEvidence {
  version:typeof VERSION;
  stateHash:string;
  firstReceivedAt:string;
  lastStateChangeReceivedAt:string;
  lastReceivedAt:string;
  hasObservedProgress:boolean;
  highGameClock:number|null;
  highRadiantScore:number|null;
  highDireScore:number|null;
  lastKnownRadiantLead:number|null;
  lastKnownBuildingState:number|null;
  hasConfirmedCompleteDraft:boolean;
  lastChangeBasis:'initial'|'game_state'|'complete_draft';
  regressed:boolean;
}

/** Only actual state/identity changes count. New HTTP timestamps and array order do not. */
export function liveStateHash(row:Packet):string {
  const players=(Array.isArray(row.players)?row.players:[]).filter(p=>p && typeof p==='object')
    .map((p:Packet)=>({hero:numeric(p.hero_id),account:safeOpenDotaId(p.account_id)??null,
      team:p.team===0||p.team===1?p.team:null,slot:numeric(p.team_slot)}))
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
  return evidenceHash({match:safeOpenDotaId(row.match_id)??null,radiant:safeOpenDotaId(row.team_id_radiant)??null,
    dire:safeOpenDotaId(row.team_id_dire)??null,clock:numeric(row.game_time),r:numeric(row.radiant_score),
    d:numeric(row.dire_score),lead:numeric(row.radiant_lead),buildings:numeric(row.building_state),players});
}

function stateEvidence(row:Packet):StateEvidence|null {
  const v=row[KEY] as StateEvidence|undefined;
  if(!v || v.version!==VERSION || v.stateHash!==liveStateHash(row)
    || typeof v.hasObservedProgress!=='boolean' || typeof v.regressed!=='boolean'
    || typeof v.hasConfirmedCompleteDraft!=='boolean'
    || !['initial','game_state','complete_draft'].includes(v.lastChangeBasis)) return null;
  if([v.highGameClock,v.highRadiantScore,v.highDireScore,v.lastKnownRadiantLead,v.lastKnownBuildingState]
    .some(value=>value!==null&&!finite(value))) return null;
  const first=time(v.firstReceivedAt),changed=time(v.lastStateChangeReceivedAt),received=time(v.lastReceivedAt);
  if(first===null || changed===null || received===null || first>changed || changed>received) return null;
  return v;
}

function providerMarkerAge(row:Packet,now:number):number|null {
  const updated=numeric(row.last_update_time);
  // This coarse provider marker is not an authoritative game-event timestamp.
  return updated!==null && updated>=1_262_304_000 && updated*1000<=now+128_000
    ? (now-updated*1000)/1000:null;
}

/** Called only by the collector, before durable feed persistence. Incoming metadata is overwritten. */
export function annotateLiveState(rows:unknown[], previous:unknown[]|null, receivedAt:string):unknown[] {
  const received=time(receivedAt);
  if(received===null) throw new Error('invalid_live_receipt');
  const previousById=new Map((previous??[]).filter((r):r is Packet=>!!r&&typeof r==='object')
    .map(r=>[safeOpenDotaId(r.match_id),r]));
  return rows.map(raw=>{
    if(!raw || typeof raw!=='object') return raw;
    const row=raw as Packet,id=safeOpenDotaId(row.match_id);
    const old=id?previousById.get(id):undefined;
    const candidate=old?stateEvidence(old):null;
    const before=candidate && time(candidate.lastReceivedAt)!<=received ? candidate:null;
    const stateHash=liveStateHash(row);
    const clock=numeric(row.game_time),r=numeric(row.radiant_score),d=numeric(row.dire_score);
    const regressed=!!before && [[clock,before.highGameClock],[r,before.highRadiantScore],[d,before.highDireScore]]
      .some(([current,high])=>current!==null&&high!==null&&current<high);
    // Compare real values with their last known baseline, including across gaps.
    // A changed packet hash alone proves neither game progress nor fresh data.
    const lead=numeric(row.radiant_lead),buildings=numeric(row.building_state);
    const advanced=(current:number|null,prior:number|null)=>current!==null&&prior!==null&&current>prior;
    const different=(current:number|null,prior:number|null)=>current!==null&&prior!==null&&current!==prior;
    const changed=!!before && !regressed && (
      advanced(clock,before.highGameClock)||advanced(r,before.highRadiantScore)||advanced(d,before.highDireScore)
      ||different(lead,before.lastKnownRadiantLead)||different(buildings,before.lastKnownBuildingState));
    const completeDraft=observedLiveDraft(row,new Map(),receivedAt)!==null;
    const markerAge=providerMarkerAge(row,received);
    // The first verified 5+5 lineup is an explicit early-phase event. Remember it
    // durably: disappearing/reappearing heroes cannot repeatedly renew this grace.
    const confirmedDraft=completeDraft && !regressed
      && clock!==null && clock>=-3600 && clock<60
      && markerAge!==null && markerAge<=LIVE_STATE_MAX_AGE_MS/1000+128;
    const firstDraft=!!before && !before.hasConfirmedCompleteDraft && confirmedDraft;
    const high=(current:number|null,prior:number|null|undefined)=>current===null?prior??null:prior==null?current:Math.max(current,prior);
    const evidence:StateEvidence={version:VERSION,stateHash,firstReceivedAt:before?.firstReceivedAt??receivedAt,
      lastStateChangeReceivedAt:changed||firstDraft?receivedAt:before?.lastStateChangeReceivedAt??receivedAt,
      lastReceivedAt:receivedAt,hasObservedProgress:!!before?.hasObservedProgress||changed,
      hasConfirmedCompleteDraft:!!before?.hasConfirmedCompleteDraft||confirmedDraft,
      lastChangeBasis:changed?'game_state':firstDraft?'complete_draft':before?.lastChangeBasis??'initial',
      highGameClock:high(clock,before?.highGameClock),highRadiantScore:high(r,before?.highRadiantScore),
      highDireScore:high(d,before?.highDireScore),
      // Never let a regressed packet replace the trusted comparable baseline.
      lastKnownRadiantLead:regressed?before!.lastKnownRadiantLead:lead??before?.lastKnownRadiantLead??null,
      lastKnownBuildingState:regressed?before!.lastKnownBuildingState:buildings??before?.lastKnownBuildingState??null,
      regressed};
    return {...row,[KEY]:evidence};
  });
}

/** This measures local observed progression, not end-to-end event latency. */
export function liveStateFreshness(row:Packet, receivedAt:string|null, now=Date.now()) {
  const evidence=stateEvidence(row),received=time(receivedAt);
  const changed=evidence?time(evidence.lastStateChangeReceivedAt):null;
  const rawUpdated=numeric(row.last_update_time);
  const markerAge=providerMarkerAge(row,now);
  let reason:string|null=null;
  if(received===null || received>now+5_000 || now-received>=LIVE_STATE_MAX_AGE_MS) reason='live_receipt_stale_or_invalid';
  else if(!evidence || evidence.lastReceivedAt!==receivedAt) reason='live_state_freshness_unverified';
  else if(finite(row.deactivate_time) && row.deactivate_time>0 && row.deactivate_time*1000<=now) reason='provider_reported_inactive';
  else if(evidence.regressed) reason='live_state_regressed';
  else if(finite(row.delay) && row.delay>LIVE_EVENT_MAX_DELAY_SECONDS) reason='declared_broadcast_delay_exceeds_limit';
  else if(markerAge!==null && markerAge>LIVE_STATE_MAX_AGE_MS/1000+128) reason='provider_update_marker_old';
  else if(!evidence.hasObservedProgress && markerAge===null) reason='awaiting_observed_state_progress';
  else if(changed===null || now-changed>=LIVE_STATE_MAX_AGE_MS) reason='upstream_state_not_progressing';
  return {eligibleForObservedStatePrediction:reason===null,reason,
    recencyBasis:evidence?.lastChangeBasis==='complete_draft'?'observed_complete_draft_with_provider_marker'
      :evidence?.hasObservedProgress?'local_state_progress':markerAge!==null?'provider_marker_only':'unverified',
    receivedAt,lastStateChangeReceivedAt:evidence?.lastStateChangeReceivedAt??null,
    stateAgeSeconds:changed===null?null:Math.max(0,(now-changed)/1000),
    declaredBroadcastDelaySeconds:finite(row.delay)&&row.delay>=0?row.delay:null,
    providerLastUpdateRaw:rawUpdated,providerMarkerAgeSeconds:markerAge,
    measuredEndToEndLatencySeconds:null,
    eventLatencyVerified:false,
    meetsVerifiedLiveLatencyPolicy:false,
    policy:{maxEventToReceiptSeconds:LIVE_EVENT_MAX_DELAY_SECONDS,maxLocalStateAgeSeconds:LIVE_STATE_MAX_AGE_MS/1000},
    clockSemantics:'receipt and observed state progression; not authoritative event timestamps' as const};
}
