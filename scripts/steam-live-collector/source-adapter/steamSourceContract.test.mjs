/** Synthetic source-contract tests. No provider, DB, task or model access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const base=process.env.SOURCE_CONTRACT_ROOT?pathToFileURL(join(process.env.SOURCE_CONTRACT_ROOT,'/')).href:new URL('./',import.meta.url).href;
const {normalizeLocalCapture,sha}=await import(new URL('steamLiveAdapter.mjs',base));
const {advanceSteamFeatureBundle}=await import(new URL('steamFeatureBundle.mjs',base));
const {projectPlayerHeroEconomy}=await import(new URL('playerHeroEconomyFeatures.mjs',base));
function input(clock=900,{offset=0,team=1,anonymous=false,heroChange=false,reversed=false,missingGpm=false}={}){
 const players=side=>Array.from({length:5},(_,i)=>({account_id:anonymous&&side===0&&i===0?0:side*5+i+1,
  hero_id:heroChange&&side===0&&i===0?11:side*5+i+1,level:10,
  net_worth:5000+side*300+i*100+(side===0?offset:0),gold_per_min:300+i*10+(side===0?offset:0),xp_per_min:450,
  gold:0,net_gold:42,item0:0,item1:0,item2:0,item3:0,item4:0,item5:-1,kills:i,death:1,assists:2}));
 const r=players(0),d=players(1);if(reversed){r.reverse();d.reverse();}if(missingGpm)delete r[0].gold_per_min;
 const body=Buffer.from(JSON.stringify({result:{games:[{match_id:999,game_state:5,radiant_team:{team_id:team},dire_team:{team_id:2},
  scoreboard:{duration:clock,roshan_respawn_timer:0,radiant:{score:10,players:r},dire:{score:12,players:d}}}]}}));
 const received=new Date(Date.parse('2026-10-23T00:00:00Z')+clock*1000).toISOString(),h=sha(body);
 return{body,httpStatus:200,endpoint:'GetLiveLeagueGames/v1',requestStartedAt:received,receivedAt:received,persistedAt:received,rawSha256:h,payloadRef:'journal:'+h,authenticatedAttempt:true};
}
function observation(clock,options){const out=normalizeLocalCapture(input(clock,options));assert.equal(out.observations.length,1);return out.observations[0];}
const get=(r,name)=>r.vector.values[r.vector.names.indexOf(name)];

test('capture order rejects receipt one ns before request',()=>{
 const i=input();i.requestStartedAt='2026-10-23T00:15:00.000000001Z';i.receivedAt='2026-10-23T00:15:00.000000000Z';
 assert.throws(()=>normalizeLocalCapture(i),/capture_time_order/);
});
test('capture order rejects persisted one ns before receipt',()=>{
 const i=input();i.requestStartedAt='2026-10-23T00:15:00.000000000Z';i.receivedAt='2026-10-23T00:15:00.000000001Z';i.persistedAt=i.requestStartedAt;
 assert.throws(()=>normalizeLocalCapture(i),/capture_time_order/);
});
test('invalid calendar dates are rejected rather than normalized by Date.parse',()=>{
 const i=input();i.requestStartedAt=i.receivedAt=i.persistedAt='2026-02-30T00:00:00Z';
 assert.throws(()=>normalizeLocalCapture(i),/invalid_request_started_at/);
});
test('native NW GPM and gold retain different units and exact field provenance',()=>{
 const o=observation(),p=o.sides.radiant.players[0];
 assert.equal(p.netWorth.units,'gold_value');assert.equal(p.goldPerMinute.units,'gold_per_minute');
 assert.equal(p.gold.units,'provider_gold_units_unverified');
 for(const [name,key]of [['netWorth','net_worth'],['goldPerMinute','gold_per_min'],['experiencePerMinute','xp_per_min'],['level','level']]){
  const v=p[name];assert.equal(v.sourceField,key);assert.equal(v.sourceFieldPath,`result.games[0].scoreboard.radiant.players[0].${key}`);
  assert.equal(v.knownAt,o.source.capture.receivedAt);assert.equal(v.rawSha256,o.source.capture.rawSha256);
  assert.equal(v.fieldEvidenceContract,'aegis.steam-native-field-evidence.v1');
 }
 assert.notEqual(p.netWorth.value/(o.providerGameClockSeconds.value/60),p.goldPerMinute.value);
});
test('missing GPM is not derived from NW; zero gold and item sentinel remain distinct',()=>{
 const o=observation(900,{missingGpm:true}),p=o.sides.radiant.players[0];
 assert.equal(p.goldPerMinute.status,'absent');assert.equal(p.goldPerMinute.value,null);assert.equal(p.goldPerMinute.missing,true);
 assert.equal(p.gold.status,'observed');assert.equal(p.gold.value,0);assert.equal(p.gold.missing,false);
 assert.equal(p.observedItemFields[0].value,0);assert.equal(p.observedItemFields[5].value,null);
 assert.equal(p.observedItemFields[5].rawValue,-1);assert.equal(p.observedItemFields[5].status,'negative_source_sentinel');
 assert.equal(p.goldPerMinute.knownAt,o.source.capture.receivedAt);
});
test('absent null invalid and observed zero are distinct native metric statuses',()=>{
 for(const [rawValue,expected]of [[null,'null'],[-1,'invalid'],['not-a-number','invalid'],[0,'observed']]){
  const i=input(),raw=JSON.parse(i.body);raw.result.games[0].scoreboard.radiant.players[0].gold_per_min=rawValue;
  i.body=Buffer.from(JSON.stringify(raw));i.rawSha256=sha(i.body);i.payloadRef='journal:'+i.rawSha256;
  const p=normalizeLocalCapture(i).observations[0].sides.radiant.players[0];
  assert.equal(p.goldPerMinute.status,expected);assert.equal(p.goldPerMinute.missing,expected!=='observed');
  assert.equal(p.goldPerMinute.value,expected==='observed'?0:null);
 }
});
test('team identity change clears economy trajectory without inventing a cross-team delta',()=>{
 const a=advanceSteamFeatureBundle(null,observation(840)),b=advanceSteamFeatureBundle(a.state,observation(900,{team:9,offset:10}));
 assert.equal(get(b,'native_economy.hero.1.native_gpm.past_60s_change_per_minute'),null);
 assert.equal(get(b,'roshan.nw_sum_diff_change_per_game_minute'),null);
 assert.ok(b.resetReasons.includes('player_side_team_identity_changed'));
});
test('direct offline projection also refuses a trajectory from a different team identity',()=>{
 const a=observation(840),b=observation(900,{team:9,offset:10});
 const f=projectPlayerHeroEconomy(b,{history:[a]});
 assert.equal(f.values[f.featureNames.indexOf('native_economy.hero.1.native_gpm.past_60s_change_per_minute')],null);
});
test('offline identity A-B-A history has the same reset barrier as online replay',()=>{
 const a=observation(840),b=observation(860,{team:9,offset:5}),c=observation(900,{offset:10});
 const direct=projectPlayerHeroEconomy(c,{history:[a,b]});
 let state=null,online;for(const o of [a,b,c]){online=advanceSteamFeatureBundle(state,o);state=online.state;}
 const name='native_economy.hero.1.native_gpm.past_60s_change_per_minute';
 assert.equal(direct.values[direct.featureNames.indexOf(name)],null);assert.equal(get(online,name),null);
});
test('an intervening endpoint profile is a reset barrier for direct offline projection',()=>{
 const a=observation(840),b=observation(860,{offset:5}),c=observation(900,{offset:10});
 b.dynamic.sourceProfile='steam.GetRealtimeStats.v1';
 const direct=projectPlayerHeroEconomy(c,{history:[a,b]});
 assert.equal(direct.values[direct.featureNames.indexOf('native_economy.hero.1.native_gpm.past_60s_change_per_minute')],null);
});
test('late account disclosure does not backfill an earlier coherent identity window',()=>{
 const a=advanceSteamFeatureBundle(null,observation(840,{anonymous:true})),b=advanceSteamFeatureBundle(a.state,observation(900,{offset:10}));
 assert.equal(get(b,'roshan.nw_sum_diff_change_per_game_minute'),null);
 assert.ok(b.resetReasons.includes('player_side_team_identity_changed'));
});
test('hero change clears all team trajectory windows rather than keeping an unmatched roster',()=>{
 const a=advanceSteamFeatureBundle(null,observation(840)),b=advanceSteamFeatureBundle(a.state,observation(900,{heroChange:true,offset:10}));
 assert.equal(get(b,'native_economy.hero.2.native_gpm.past_60s_change_per_minute'),null);
});
test('contradictory explicit side and player team identities are rejected',()=>{
 const o=observation();o.sides.radiant.players[0].identity.teamId='9';
 assert.throws(()=>projectPlayerHeroEconomy(o),/complete_coherent_economy_snapshot_required/);
});
test('identity-window reset preserves confirmed map-level Roshan event evidence',()=>{
 const o=observation(840),event={id:'synthetic-death',kind:'roshan_death',matchId:o.matchId,sourceProfile:o.dynamic.sourceProfile,
  confirmed:true,evidenceRef:'synthetic-event-proof',gameTimeSeconds:800,knownAt:o.source.capture.receivedAt};
 const a=advanceSteamFeatureBundle(null,o,{events:[event]}),b=advanceSteamFeatureBundle(a.state,observation(900,{team:9}));
 assert.ok(b.resetReasons.includes('player_side_team_identity_changed'));
 assert.equal(get(b,'roshan.roshan_elapsed_since_confirmed_death'),100);
 assert.equal(b.state.roshanState.death.id,event.id);
});
test('player-array reordering alone preserves the identity and trajectory',()=>{
 const a=advanceSteamFeatureBundle(null,observation(840)),b=advanceSteamFeatureBundle(a.state,observation(900,{reversed:true,offset:10}));
 assert.equal(get(b,'native_economy.hero.1.native_gpm.past_60s_change_per_minute'),10);
 assert.ok(!b.resetReasons.includes('player_side_team_identity_changed'));
 assert.equal(b.vector.featureCount,38482);
});
test('zero Roshan timer remains unknown without attested semantics',()=>{
 const r=advanceSteamFeatureBundle(null,observation());
 assert.equal(get(r,'roshan.roshan_timer_raw'),0);assert.equal(r.roshan.state,'unknown');
 assert.equal(get(r,'roshan.roshan_alive'),null);assert.equal(r.roshan.timerSemanticsAccepted,false);
 assert.equal(r.eligibleForServing,false);assert.equal(r.eligibleForTraining,false);
});
