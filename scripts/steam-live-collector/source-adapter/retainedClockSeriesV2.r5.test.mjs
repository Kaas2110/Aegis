import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pinRetainedHistoryJson as pin,deriveHistoricalFactVersion as v1,deriveHistoricalFactVersionV2 as v2,verifyHistoricalFactVersion as verify,selectHistoricalClockSeriesV2 as select,RETAINED_FACT_VERSION_CONTRACT,RETAINED_FACT_VERSION_CONTRACT_V2} from './retainedOpenDotaFacts.mjs';
const T0='2026-10-20T12:00:00Z',T1='2026-10-20T12:01:00Z',T2='2026-10-20T12:02:00Z',T3='2026-10-20T12:03:00Z';
function source({at=T0,heroId=1,accountId=11,series={times:[-60,0,60],gold_t:[0,600,1000],networth_t:[0,600,900]},matchId=101}={}){
 const payload=JSON.parse(pin({match_id:matchId,start_time:1792494000,duration:1800,radiant_win:true,players:[{player_slot:0,hero_id:heroId,account_id:accountId,...series}]}).utf8);
 return {selectedInput:pin({schemaVersion:1,source:'opendota',endpoint:'https://api.opendota.com/api/matches/'+matchId,matchId,receivedAt:at,availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),payload})};
}
const version=options=>v2(source(options)).versionInput;
const view=(versions,at=T3)=>select({versionInputs:versions,targetMapId:'90001',historyCutoffAt:at});
const blockOf=x=>x.version.fields.find(f=>f.path.endsWith('/clock_series'));

test('v1 remains default and byte-reverifiable; v2 explicitly records coherent metric statuses',()=>{
 const a=v1(source()),b=v2(source({series:{times:[-60,0,60],gold_t:[0,600,1000],networth_t:null,xp_t:[1],lh_t:[]}}));
 assert.equal(a.version.contract,RETAINED_FACT_VERSION_CONTRACT);assert.equal(verify(a.versionInput).versionInput.utf8,a.versionInput.utf8);
 assert.equal(b.version.contract,RETAINED_FACT_VERSION_CONTRACT_V2);assert.equal(verify(b.versionInput).versionInput.utf8,b.versionInput.utf8);
 const clock=blockOf(b);assert.equal(clock.status,'observed');assert.deepEqual(clock.value.times,[-60,0,60]);
 assert.equal(clock.value.metrics.gold_t.status,'observed');assert.equal(clock.value.metrics.networth_t.status,'explicit_null');assert.equal(clock.value.metrics.xp_t.status,'invalid');assert.equal(clock.value.metrics.dn_t.status,'absent');
 assert.throws(()=>view([a.versionInput,b.versionInput]),/clock_v2_requires_v2_versions/);
});

test('explicit null, invalid clock and values without clock retract the old series',()=>{
 const first=version();
 for(const series of [{times:null},{times:'invalid'},{times:[0,0],gold_t:[1,2]},{gold_t:[1,2]}]){
  const next=version({at:T1,series}),r=view([first,next]);assert.equal(r.blocks.length,0);assert.equal(r.rejected.length,1);assert.match(r.rejected[0].reason,/clock_block_(explicit_null|invalid)/);
  assert.equal(view([next,first],T0).blocks[0].block.times.length,3);
 }
});

test('empty clock is an observed empty replacement, and absent whole block preserves prior evidence',()=>{
 const first=version(),empty=view([first,version({at:T1,series:{times:[],gold_t:[]}})]);
 assert.equal(empty.blocks.length,1);assert.equal(empty.blocks[0].block.times.length,0);assert.equal(empty.blocks[0].block.metrics.gold_t.status,'observed');assert.equal(empty.blocks[0].block.metrics.networth_t.status,'absent');
 const omitted=view([first,version({at:T1,series:{}})]);assert.equal(omitted.blocks[0].knownAt,T0);assert.equal(omitted.blocks[0].block.times.length,3);
});

test('new clock block never fills missing or malformed metrics from an old axis',()=>{
 const r=view([version(),version({at:T1,series:{times:[0,60],gold_t:[600,1200],networth_t:[900]}})]);
 assert.equal(r.blocks[0].block.times.length,2);assert.equal(r.blocks[0].block.metrics.networth_t.status,'invalid');assert.equal(r.blocks[0].block.metrics.networth_t.values,null);assert.equal(r.blocks[0].block.metrics.xp_t.status,'absent');
});

test('equal receipt conflict cannot be resolved by input order or hash order',()=>{
 const a=version({at:T1,series:{times:[0,60],gold_t:[600,1000]}}),b=version({at:T1,series:{times:[0,60],gold_t:[600,2000]}});
 for(const list of [[a,b],[b,a]]){const r=view(list);assert.equal(r.blocks.length,0);assert.equal(r.rejected[0].reason,'clock_block_conflicting_receipt');}
});

test('hero epoch A-to-B-to-A cannot resurrect an older trajectory',()=>{
 const a=version(),b=version({at:T1,heroId:2,series:{}}),aAgain=version({at:T2,series:{}});
 const r=view([a,b,aAgain]);assert.equal(r.blocks.length,0);assert.equal(r.rejected[0].reason,'clock_block_hero_epoch_unavailable');
 assert.equal(view([a,b,aAgain],T0).blocks[0].heroId,1);
 const repaired=view([a,b,aAgain,version({at:T3})]);assert.equal(repaired.blocks.length,1);assert.equal(repaired.blocks[0].knownAt,T3);
});

test('late account disclosure and account A-to-B-to-A never reattribute an old hero trajectory',()=>{
 const anonymous=version({accountId:null}),known=version({at:T1,series:{}}),a=view([anonymous,known]);
 assert.equal(a.blocks.length,1);assert.equal(a.blocks[0].heroHistoryEligible,true);assert.equal(a.blocks[0].playerHistoryEligible,false);assert.equal(a.blocks[0].accountId,null);
 const first=version(),b=version({at:T1,accountId:22,series:{}}),again=version({at:T2,series:{}}),r=view([first,b,again]);
 assert.equal(r.blocks.length,1);assert.equal(r.blocks[0].heroHistoryEligible,true);assert.equal(r.blocks[0].playerHistoryEligible,false);
 assert.equal(view([first,b,again,version({at:T3})]).blocks[0].playerHistoryEligible,true);
});

test('target map and future receipts are excluded while source content must still verify',()=>{
 const current=version({matchId:90001}),future=version({at:T3}),r=view([current,future],T0);assert.equal(r.blocks.length,0);
 const corrupt=JSON.parse(future.utf8);corrupt.fields.find(f=>f.path.endsWith('/clock_series')).value.times=[0,2];
 assert.throws(()=>view([pin(corrupt)],T0),/version_not_rederived_from_source/);
});

