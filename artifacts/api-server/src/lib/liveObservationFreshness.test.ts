import test from 'node:test';
import assert from 'node:assert/strict';
import {observeLivePacket} from './liveObservationContract';
import {annotateLiveState} from './liveStateFreshness';

const t = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
function packet(clock=300) {
  return {match_id:91234,team_id_radiant:12,team_id_dire:34,game_time:clock,radiant_score:0,dire_score:1,radiant_lead:0,
    players:Array.from({length:10},(_,i)=>({hero_id:i+1,account_id:100+i,team:i<5?0:1,team_slot:i%5}))};
}
const row = (rows: unknown[]) => rows[0] as Record<string, unknown>;
function observation(raw: Record<string, unknown>, time=t) {return observeLivePacket(raw,new Date(time),new Date(time));}

test('journal retains unverified packets without claiming measured latency or a live-ready state',()=>{
  const o=observation({...packet(),live_freshness:{eligibleForObservedStatePrediction:true,measuredEndToEndLatencySeconds:0}});
  assert.equal(o.availability.liveDataQuality.eligibleForObservedStatePrediction,false);
  assert.equal(o.availability.liveDataQuality.measuredEndToEndLatencySeconds,null);
  assert.equal(o.availability.liveDataQuality.eventLatencyVerified,false);
  assert.ok(o.qualityReasons.includes('live_freshness:live_state_freshness_unverified'));
  assert.equal(o.input.radiantLead,0);
});
test('journal preserves an eligible observed progression without inventing event time',()=>{
  const first=annotateLiveState([packet()],null,iso(t));
  const next=annotateLiveState([packet(330)],first,iso(t+30_000));
  const o=observation(row(next),t+30_000);
  assert.equal(o.availability.liveDataQuality.eligibleForObservedStatePrediction,true);
  assert.equal(o.availability.liveDataQuality.stateAgeSeconds,0);
  assert.equal(o.input.providerObservedAt,null);
  assert.equal(o.availability.liveDataQuality.meetsVerifiedLiveLatencyPolicy,false);
});
test('a fresh HTTP receipt cannot refresh unchanged journal state',()=>{
  let rows=annotateLiveState([packet()],null,iso(t));
  rows=annotateLiveState([packet(330)],rows,iso(t+30_000));
  rows=annotateLiveState([packet(330)],rows,iso(t+240_000));
  const o=observation(row(rows),t+240_000);
  assert.equal(o.availability.liveDataQuality.stateAgeSeconds,210);
  assert.equal(o.availability.liveDataQuality.reason,'upstream_state_not_progressing');
  assert.ok(o.qualityReasons.includes('live_freshness:upstream_state_not_progressing'));
});
test('quality evidence is separate from the raw model input hash',()=>{
  const raw=packet();
  const enriched=row(annotateLiveState([raw],null,iso(t)));
  const a=observation(raw),b=observation(enriched);
  assert.equal(a.inputHash,b.inputHash);
  assert.deepEqual(a.input,b.input);
  assert.notDeepEqual(a.availability.liveDataQuality,b.availability.liveDataQuality);
});
test('broadcast delay beyond policy is retained as declared and suppresses eligibility',()=>{
  const raw={...packet(-30),delay:900,last_update_time:t/1000};
  const o=observation(row(annotateLiveState([raw],null,iso(t))));
  assert.equal(o.phase,'post_draft');
  assert.equal(o.availability.draftComplete,true);
  assert.equal(o.availability.liveDataQuality.declaredBroadcastDelaySeconds,900);
  assert.equal(o.availability.liveDataQuality.reason,'declared_broadcast_delay_exceeds_limit');
  assert.equal(o.availability.liveDataQuality.measuredEndToEndLatencySeconds,null);
});
test('the first full draft with recent marker remains observable immediately',()=>{
  const raw={...packet(-30),last_update_time:t/1000};
  const o=observation(row(annotateLiveState([raw],null,iso(t))));
  assert.equal(o.phase,'post_draft');
  assert.equal(o.availability.liveDataQuality.eligibleForObservedStatePrediction,true);
  assert.equal(o.availability.liveDataQuality.recencyBasis,'provider_marker_only');
  assert.equal(o.availability.liveDataQuality.eventLatencyVerified,false);
});
