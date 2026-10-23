import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLocalCapture,sha} from './steamLiveAdapter.mjs';
import {advanceSteamFeatureBundle} from './steamFeatureBundle.mjs';
import {loadSteamFeatureBundlePrefix} from './steamFeatureDbReader.mjs';
const profile='steam.GetLiveLeagueGames.v1.scoreboard';
function obs(clock=900,{map=999,phase=5,offset=0,partial=false,receiptClock=clock}={}){
 const players=side=>Array.from({length:partial&&side===0?4:5},(_,i)=>({account_id:side*5+i+1,hero_id:side*5+i+1,net_worth:3000+i*100+offset,gold_per_min:200+i*10+offset,xp_per_min:300+i*20,level:12,kills:i,death:1,assists:3}));
 const body=Buffer.from(JSON.stringify({result:{games:[{match_id:map,league_id:11,radiant_team:{team_id:1},dire_team:{team_id:2},game_state:phase,scoreboard:{duration:clock,roshan_respawn_timer:362,radiant:{score:10,players:players(0)},dire:{score:12,players:players(1)}}}]}}));
 const time=new Date(Date.parse('2026-10-23T00:00:00Z')+receiptClock*1000).toISOString(),h=sha(body);
 const capture=normalizeLocalCapture({body,httpStatus:200,endpoint:'GetLiveLeagueGames/v1',requestStartedAt:time,receivedAt:time,persistedAt:time,rawSha256:h,payloadRef:'journal:'+h,authenticatedAttempt:true});
 assert.equal(capture.observations.length,1);return capture.observations[0];
}
const get=(r,name)=>r.vector.values[r.vector.names.indexOf(name)];
test('combined vector is fixed, unique and does not impute history',()=>{
 const a=advanceSteamFeatureBundle(null,obs()),b=advanceSteamFeatureBundle(null,obs(960,{partial:true}));
 assert.deepEqual(a.vector.names,b.vector.names);assert.equal(new Set(a.vector.names).size,a.vector.featureCount);
 assert.equal(a.vector.values.length,a.vector.featureCount);assert.equal(a.economy.verifiedRoleCount,0);
 assert.equal(get(a,'native_economy.hero.1.native_gpm.context_heroForm'),null);
 assert.equal(get(a,'roshan.roshan_elapsed_since_confirmed_death'),null);
 assert.equal(b.economy.status,'unavailable');assert.equal(get(b,'native_economy.hero.1.native_nw.value'),null);
 assert.equal(get(b,'native_economy.hero.1.native_nw.value__missing'),1);
 assert.equal(a.eligibleForServing,false);assert.equal(a.eligibleForTraining,false);
});
test('archive projection and actual DB-port projection use identical prefix algebra',async()=>{
 const rows=[obs(840),obs(900,{offset:10})];let prior=null,direct;
 for(const o of rows){direct=advanceSteamFeatureBundle(prior,o);prior=direct.state;}
 const db={query:async(sql,args)=>{assert.ok(sql.includes('known_at<=$3'));assert.deepEqual(args,['999',profile,rows[1].source.capture.receivedAt,4097]);return{rows:[...rows].reverse().map(o=>({normalized_observation:JSON.stringify(o)}))};}};
 const cached=await loadSteamFeatureBundlePrefix(db,{matchId:'999',sourceProfile:profile,asOf:rows[1].source.capture.receivedAt});
 assert.equal(cached.observations,2);assert.deepEqual(cached.frame.vector,direct.vector);
 assert.equal(get(direct,'native_economy.hero.1.native_gpm.past_60s_change_per_minute'),10);
});
test('one nanosecond future original receipt is rejected even if SQL rounded it',async()=>{
 const o=obs();o.source.capture.receivedAt='2026-10-23T00:15:00.000000001Z';
 const db={query:async()=>({rows:[{normalized_observation:o}]})};
 await assert.rejects(loadSteamFeatureBundlePrefix(db,{matchId:'999',sourceProfile:profile,asOf:'2026-10-23T00:15:00.000000000Z'}),/identity_or_future/);
});
test('DB row from another map cannot enter same prefix',async()=>{
 const db={query:async()=>({rows:[{normalized_observation:obs(900,{map:1000})}]})};
 await assert.rejects(loadSteamFeatureBundlePrefix(db,{matchId:'999',sourceProfile:profile,asOf:'2026-10-23T00:15:00Z'}),/identity_or_future/);
});
test('source profile is explicit and never merged by brand',async()=>{
 await assert.rejects(loadSteamFeatureBundlePrefix({query:async()=>({rows:[]})},{matchId:'999',sourceProfile:'steam.GetRealtimeStats.v1',asOf:'2026-10-23T00:15:00Z'}),/reader_contract/);
});
test('map change clears previous economy and Roshan history',()=>{
 const a=advanceSteamFeatureBundle(null,obs(840)),b=advanceSteamFeatureBundle(a.state,obs(900,{map:1000,offset:10}));
 assert.equal(get(b,'native_economy.hero.1.native_gpm.past_60s_change_per_minute'),null);
 assert.equal(b.state.history.length,1);assert.ok(b.resetReasons.includes('map_profile_patch_or_rules_changed'));
});
test('positive PRE_GAME clock never becomes a live economy trajectory',()=>{
 const a=advanceSteamFeatureBundle(null,obs()),b=advanceSteamFeatureBundle(a.state,obs(960,{phase:4}));
 assert.equal(b.economy.status,'unavailable');assert.equal(b.state.history.length,0);
 assert.ok(b.resetReasons.includes('explicit_non_live_phase'));
});
test('terminal outcome without an explicit phase clears all trajectory state',()=>{
 const a=advanceSteamFeatureBundle(null,obs()),terminal=obs(960);
 terminal.dynamic.phase={value:null,rawValue:null,missing:true,status:'absent'};
 terminal.sourceQualityReasons.push('outcome_marker_present');
 const b=advanceSteamFeatureBundle(a.state,terminal);
 assert.equal(b.economy.status,'unavailable');assert.equal(b.state.history.length,0);
 assert.equal(get(b,'roshan.roshan_elapsed_since_confirmed_death'),null);
});
test('clock rewind discards the earlier run trajectory',()=>{
 const a=advanceSteamFeatureBundle(null,obs(900)),b=advanceSteamFeatureBundle(a.state,obs(840,{receiptClock:960}));
 assert.equal(get(b,'native_economy.hero.1.native_gpm.past_60s_change_per_minute'),null);
 assert.ok(b.resetReasons.includes('game_clock_regression'));
});
test('bounded reader reports empty source and does not invent a frame',async()=>{
 const r=await loadSteamFeatureBundlePrefix({query:async()=>({rows:[]})},{matchId:'999',sourceProfile:profile,asOf:'2026-10-23T00:15:00Z'});
 assert.equal(r.status,'no_observations');assert.equal(r.frame,null);
});
test('unsafe prefix truncation is rejected',async()=>{
 const db={query:async()=>({rows:[{normalized_observation:obs(840)},{normalized_observation:obs()}]})};
 await assert.rejects(loadSteamFeatureBundlePrefix(db,{matchId:'999',sourceProfile:profile,asOf:'2026-10-23T00:15:00Z',limit:1}),/prefix_bound/);
});
