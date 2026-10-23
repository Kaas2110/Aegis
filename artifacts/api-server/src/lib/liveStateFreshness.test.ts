import test from 'node:test';
import assert from 'node:assert/strict';
import {annotateLiveState,liveStateFreshness} from './liveStateFreshness';
import {createBackgroundFeed,type FeedSnapshot} from './backgroundFeed';

const t=Date.parse('2026-10-04T11:00:00Z');
const iso=(n:number)=>new Date(n).toISOString();
const packet=(clock=600)=>({match_id:901,team_id_radiant:1,team_id_dire:2,game_time:clock,
  radiant_score:4,dire_score:3,radiant_lead:0,players:[],delay:300});
function step(clock:number,previous:unknown[]|null,at:number) {return annotateLiveState([packet(clock)],previous,iso(at));}
const row=(a:unknown[])=>a[0] as Record<string,unknown>;

test('HTTP success does not renew the age of unchanged state',()=>{
  let a=step(600,null,t);
  assert.equal(liveStateFreshness(row(a),iso(t),t).reason,'awaiting_observed_state_progress');
  a=step(720,a,t+120_000);
  assert.equal(liveStateFreshness(row(a),iso(t+120_000),t+120_000).eligibleForObservedStatePrediction,true);
  a=step(720,a,t+360_000);
  assert.equal(liveStateFreshness(row(a),iso(t+360_000),t+360_000).reason,'upstream_state_not_progressing');
  assert.equal(liveStateFreshness(row(a),iso(t+360_000),t+360_000).stateAgeSeconds,240);
});

test('losing and restoring game fields cannot refresh a frozen state across polls or restart',()=>{
  const base={...packet(600),radiant_lead:100,building_state:63,last_update_time:t/1000};
  let state=annotateLiveState([base],null,iso(t));
  for(let i=1;i<=4;i++) {
    const at=t+i*120_000;
    // A fresh receipt/provider marker and alternating completeness are not progress.
    const current={...base,last_update_time:at/1000,
      radiant_lead:i%2?null:100,building_state:i%2?null:63,
      game_time:i%2?null:600,radiant_score:i%2?null:4,dire_score:i%2?null:3};
    state=annotateLiveState([current],structuredClone(state),iso(at));
    const quality=liveStateFreshness(row(state),iso(at),at);
    assert.equal(quality.lastStateChangeReceivedAt,iso(t));
    assert.equal(quality.stateAgeSeconds,i*120);
    assert.equal(quality.recencyBasis,'provider_marker_only');
    if(i>=2) assert.equal(quality.eligibleForObservedStatePrediction,false);
  }
});

test('first appearance of a statistic or identity change alone cannot prove game progress',()=>{
  const base={...packet(600),radiant_lead:null,building_state:null};
  let state=annotateLiveState([base],null,iso(t));
  state=annotateLiveState([{...base,radiant_lead:100,building_state:63,team_id_radiant:10,
    players:[{hero_id:1,account_id:7,team:0,team_slot:0}]}],state,iso(t+120_000));
  const quality=liveStateFreshness(row(state),iso(t+120_000),t+120_000);
  assert.equal(quality.reason,'awaiting_observed_state_progress');
  assert.equal(quality.lastStateChangeReceivedAt,iso(t));
});

test('valid changed values after a gap still prove progress against the saved baseline',()=>{
  const base={...packet(600),radiant_lead:100,building_state:63};
  for(const change of [{game_time:720},{radiant_score:5},{dire_score:4},{radiant_lead:-200},{building_state:62}]) {
    let state=annotateLiveState([base],null,iso(t));
    state=annotateLiveState([{...base,game_time:null,radiant_score:null,dire_score:null,
      radiant_lead:null,building_state:null}],state,iso(t+120_000));
    state=annotateLiveState([{...base,...change}],state,iso(t+240_000));
    const quality=liveStateFreshness(row(state),iso(t+240_000),t+240_000);
    assert.equal(quality.reason,null);
    assert.equal(quality.recencyBasis,'local_state_progress');
    assert.equal(quality.lastStateChangeReceivedAt,iso(t+240_000));
  }
});

test('regressed packets cannot replace valid economy baselines',()=>{
  const base={...packet(600),radiant_lead:100};
  let state=annotateLiveState([base],null,iso(t));
  state=annotateLiveState([{...base,game_time:500,radiant_lead:200}],state,iso(t+120_000));
  state=annotateLiveState([base],state,iso(t+240_000));
  assert.equal(liveStateFreshness(row(state),iso(t+240_000),t+240_000).reason,'awaiting_observed_state_progress');
});

test('legacy evidence cannot carry missingness-based progress through a deployment',()=>{
  let state=step(600,null,t);state=step(720,state,t+120_000);
  const old=row(state);
  const legacy={...old,__aegis_live_state:{...(old.__aegis_live_state as object),version:'observed-state-v1'}};
  const fresh=annotateLiveState([packet(720)],[legacy],iso(t+240_000));
  assert.equal(liveStateFreshness(row(fresh),iso(t+240_000),t+240_000).reason,'awaiting_observed_state_progress');
});

const fullDraft=()=>Array.from({length:10},(_,i)=>({hero_id:i+1,account_id:i+100,team:i<5?0:1,team_slot:i%5}));

test('first verified full draft after a long wait is immediately eligible at an unchanged early clock',()=>{
  const base={...packet(-90),last_update_time:t/1000};
  let state=annotateLiveState([base],null,iso(t));
  state=annotateLiveState([{...base,players:fullDraft(),last_update_time:(t+240_000)/1000}],state,iso(t+240_000));
  const quality=liveStateFreshness(row(state),iso(t+240_000),t+240_000);
  assert.equal(quality.reason,null);
  assert.equal(quality.lastStateChangeReceivedAt,iso(t+240_000));
  assert.equal(quality.recencyBasis,'observed_complete_draft_with_provider_marker');
  assert.equal(quality.eventLatencyVerified,false);
});

test('full draft loss and restoration cannot renew the one-time draft grace after restart',()=>{
  const base={...packet(-90),last_update_time:t/1000};
  let state=annotateLiveState([base],null,iso(t));
  for(const [offset,players] of [[240_000,fullDraft()],[360_000,[]],[480_000,fullDraft()]] as const) {
    state=annotateLiveState([{...base,players,last_update_time:(t+offset)/1000}],structuredClone(state),iso(t+offset));
  }
  const quality=liveStateFreshness(row(state),iso(t+480_000),t+480_000);
  assert.equal(quality.reason,'upstream_state_not_progressing');
  assert.equal(quality.lastStateChangeReceivedAt,iso(t+240_000));
});

test('late, malformed or unverified draft arrivals do not renew the state clock',()=>{
  for(const variant of [
    {clock:600,players:fullDraft(),marker:(t+240_000)/1000},
    {clock:-90,players:fullDraft(),marker:null},
    {clock:-90,players:fullDraft(),marker:(t-600_000)/1000},
    {clock:-90,players:fullDraft().map(p=>({...p,hero_id:1})),marker:(t+240_000)/1000},
  ]) {
    const base=packet(variant.clock);
    let state=annotateLiveState([base],null,iso(t));
    state=annotateLiveState([{...base,players:variant.players,last_update_time:variant.marker}],state,iso(t+240_000));
    const quality=liveStateFreshness(row(state),iso(t+240_000),t+240_000);
    assert.equal(quality.eligibleForObservedStatePrediction,false);
    assert.equal(quality.lastStateChangeReceivedAt,iso(t));
  }
});

test('a rejected full draft does not consume the one-time admission of a later verified packet',()=>{
  for(const badMarker of [null,(t-600_000)/1000]) {
    const base=packet(-90);
    let state=annotateLiveState([base],null,iso(t));
    state=annotateLiveState([{...base,players:fullDraft(),last_update_time:badMarker}],state,iso(t+240_000));
    assert.equal(liveStateFreshness(row(state),iso(t+240_000),t+240_000).eligibleForObservedStatePrediction,false);
    state=annotateLiveState([{...base,players:fullDraft(),last_update_time:(t+360_000)/1000}],structuredClone(state),iso(t+360_000));
    const admitted=liveStateFreshness(row(state),iso(t+360_000),t+360_000);
    assert.equal(admitted.reason,null);
    assert.equal(admitted.recencyBasis,'observed_complete_draft_with_provider_marker');
    state=annotateLiveState([{...base,last_update_time:(t+480_000)/1000}],structuredClone(state),iso(t+480_000));
    state=annotateLiveState([{...base,players:fullDraft(),last_update_time:(t+600_000)/1000}],structuredClone(state),iso(t+600_000));
    assert.equal(liveStateFreshness(row(state),iso(t+600_000),t+600_000).reason,'upstream_state_not_progressing');
  }
});
test('clock rollback cannot refresh state or lower high-water marks',()=>{
  let a=step(600,null,t);a=step(720,a,t+120_000);a=step(650,a,t+240_000);
  assert.equal(liveStateFreshness(row(a),iso(t+240_000),t+240_000).reason,'live_state_regressed');
  a=step(700,a,t+360_000);
  assert.equal(liveStateFreshness(row(a),iso(t+360_000),t+360_000).reason,'live_state_regressed');
  a=step(840,a,t+480_000);
  assert.equal(liveStateFreshness(row(a),iso(t+480_000),t+480_000).reason,null);
});
test('declared delay is never treated as measured event latency',()=>{
  let a=step(600,null,t);a=step(720,a,t+120_000);
  const f=liveStateFreshness(row(a),iso(t+120_000),t+120_000);
  assert.equal(f.declaredBroadcastDelaySeconds,300);
  assert.equal(f.measuredEndToEndLatencySeconds,null);
  assert.equal(f.meetsVerifiedLiveLatencyPolicy,false);
  assert.equal(liveStateFreshness({...row(a),delay:900},iso(t+120_000),t+120_000).reason,'declared_broadcast_delay_exceeds_limit');
  const oldMarker={...row(a),last_update_time:(t-600_000)/1000};
  assert.equal(liveStateFreshness(oldMarker,iso(t+120_000),t+120_000).reason,'provider_update_marker_old');
});
test('new feed metadata, source array order and a mismatched receipt cannot fake progress',()=>{
  const p={...packet(),players:[{hero_id:1,team:0},{hero_id:2,team:1}]};
  const a=annotateLiveState([p],null,iso(t));
  const b=annotateLiveState([{...p,players:[...p.players].reverse(),last_update_time:(t+120_000)/1000}],a,iso(t+120_000));
  const quality=liveStateFreshness(row(b),iso(t+120_000),t+120_000);
  assert.equal(quality.recencyBasis,'provider_marker_only');
  assert.equal(quality.lastStateChangeReceivedAt,iso(t));
  assert.equal(quality.measuredEndToEndLatencySeconds,null);
  assert.equal(liveStateFreshness(row(b),iso(t+120_001),t+120_001).reason,'live_state_freshness_unverified');
});
test('recent provider marker allows first draft packet without asserting event latency',()=>{
  const a=annotateLiveState([{...packet(-30),last_update_time:t/1000}],null,iso(t));
  const f=liveStateFreshness(row(a),iso(t),t);
  assert.equal(f.eligibleForObservedStatePrediction,true);
  assert.equal(f.recencyBasis,'provider_marker_only');
  assert.equal(f.eventLatencyVerified,false);
});
test('restart restores last state-change timestamp from durable feed',async()=>{
  let at=t,clock=600,stored:FeedSnapshot<unknown[]>|null=null,calls=0;
  const store={load:async()=>structuredClone(stored),save:async(v:FeedSnapshot<unknown[]>)=>{stored=structuredClone(v);}};
  const collect=async()=>{calls++;return [packet(clock)];};
  const transform=(data:unknown[],prior:unknown[]|null,receivedAt:string)=>annotateLiveState(data,prior,receivedAt);
  const first=createBackgroundFeed(store,collect,()=>at,transform);
  await first.refresh();at+=120_000;clock=720;await first.refresh();
  const restart=createBackgroundFeed(store,collect,()=>at,transform);
  at+=360_000;await restart.refresh();const read=await restart.read();
  assert.equal(liveStateFreshness(row(read.data!),read.receivedAt,at).reason,'upstream_state_not_progressing');
  await restart.read();assert.equal(calls,3);
});
