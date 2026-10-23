import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeStratzLiveDetail,type ExpectedStratzPlayer} from './stratzLiveDetailContract';
function fixture(){
 const expected:ExpectedStratzPlayer[]=Array.from({length:10},(_,i)=>({accountId:100+i,heroId:1+i,side:i<5?'radiant':'dire'}));
 const players=expected.map((p,i)=>({steamAccountId:p.accountId,heroId:p.heroId,isRadiant:p.side==='radiant',playerSlot:i,
  level:12,numKills:0,numDeaths:0,numAssists:0,numLastHits:100,numDenies:5,gold:0,goldSpent:1000,networth:i<5?2000:1000,
  goldPerMinute:300,experiencePerMinute:400,heroDamage:0,towerDamage:0,respawnTimer:0,itemId0:0,itemId1:1,itemId2:0,itemId3:0,itemId4:0,itemId5:0}));
 return {raw:{matchId:999,gameTime:1200,gameMinute:20,isUpdating:true,completed:false,delay:120,modifiedDateTime:12345,players},context:{requestedMatchId:999,receivedAt:'2026-10-13T20:00:00Z',expectedPlayers:expected}};
}
test('complete known roster preserves zero item slots and never invents actual XP or verified timing',()=>{
 const {raw,context}=fixture();const x=normalizeStratzLiveDetail(raw,context);
 assert.equal(x.status,'complete');assert.ok(x.data);assert.equal(x.data.networthAdvantage,5000);assert.equal(x.data.xpAdvantage,null);
 assert.deepEqual(x.data.players[0].itemSlots,[0,1,0,0,0,0]);assert.equal(x.data.players[0].stats.respawnTimer,0);
 assert.equal(x.modelEligible,false);assert.equal(x.verifiedTimely,false);assert.equal(x.providerObservedAt,null);
});
test('unknown side stays unknown and suppresses team aggregation',()=>{
 const {raw,context}=fixture();delete (raw.players[0] as any).isRadiant;
 const x=normalizeStratzLiveDetail(raw,context);assert.equal(x.data!.players[0].side,null);assert.equal(x.data!.networthAdvantage,null);assert.ok(x.reasons.includes('unknown_player_side'));
});
test('null item differs from known empty slot',()=>{
 const {raw,context}=fixture();(raw.players[0] as any).itemId0=null;
 const x=normalizeStratzLiveDetail(raw,context);assert.equal(x.data!.players[0].itemSlots[0],null);assert.equal(x.data!.all10ItemsKnown,false);assert.equal(x.status,'partial');
});
test('one missing player networth is not zero or a full team advantage',()=>{
 const {raw,context}=fixture();(raw.players[9] as any).networth=null;
 const x=normalizeStratzLiveDetail(raw,context);assert.equal(x.data!.coverage.networth,9);assert.equal(x.data!.networthAdvantage,null);
});
test('mismatched match rejects all detail instead of assigning requested id',()=>{
 const {raw,context}=fixture();raw.matchId=998;const x=normalizeStratzLiveDetail(raw,context);assert.equal(x.data,null);assert.deepEqual(x.reasons,['match_id_mismatch']);
});
test('duplicate account/hero/slots and wrong roster cannot become complete',()=>{
 for(const field of ['steamAccountId','heroId','playerSlot'] as const){const {raw,context}=fixture();raw.players[1][field]=raw.players[0][field];const x=normalizeStratzLiveDetail(raw,context);assert.equal(x.status,'partial');assert.equal(x.data!.networthAdvantage,null);}
 const {raw,context}=fixture();context.expectedPlayers[0].heroId=120;const wrong=normalizeStratzLiveDetail(raw,context);assert.ok(wrong.reasons.includes('observed_roster_mismatch'));assert.equal(wrong.data!.networthAdvantage,null);
});
test('bool NaN infinity fractional and negative stats are missing, not numbers',()=>{
 for(const v of [true,NaN,Infinity,3.5,-1]){const {raw,context}=fixture();(raw.players[0] as any).goldPerMinute=v;const x=normalizeStratzLiveDetail(raw,context);assert.equal(x.data!.players[0].stats.goldPerMinute,null);assert.ok(x.reasons.includes('invalid_goldPerMinute'));}
});
test('missing clock does not substitute one minute or derive XP',()=>{
 const {raw,context}=fixture();delete (raw as any).gameTime;delete (raw as any).gameMinute;
 const x=normalizeStratzLiveDetail(raw,context);assert.equal(x.data!.meta.gameTimeSec,null);assert.equal(x.data!.meta.gameMinuteRaw,null);assert.equal(x.data!.xpAdvantage,null);
});
test('completed or not-updating state remains diagnostic partial',()=>{
 const {raw,context}=fixture();raw.completed=true;raw.isUpdating=false;const x=normalizeStratzLiveDetail(raw,context);assert.equal(x.status,'partial');assert.ok(x.reasons.includes('provider_completed'));
});
test('exact input immutable; returned array cannot mutate raw evidence',()=>{
 const {raw,context}=fixture();const before=JSON.stringify({raw,context});const x=normalizeStratzLiveDetail(raw,context);x.data!.players[0].itemSlots[0]=300;assert.equal(JSON.stringify({raw,context}),before);
});
test('absent match refuses and invalid context is an explicit local error',()=>{
 const {context}=fixture();assert.equal(normalizeStratzLiveDetail(null,context).data,null);assert.throws(()=>normalizeStratzLiveDetail(null,{...context,receivedAt:'bad'}),/invalid_stratz_detail_context/);
});
test('unknown reference roster is not silently verified',()=>{
 const {raw,context}=fixture();delete (context as any).expectedPlayers;const x=normalizeStratzLiveDetail(raw,context);assert.equal(x.data!.rosterVerified,false);assert.equal(x.status,'partial');assert.equal(x.data!.networthAdvantage,null);
});
