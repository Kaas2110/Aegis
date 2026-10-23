import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveFeedCache} from '../artifacts/api-server/src/lib/liveFeedCache';
import {observedLiveDraft} from '../artifacts/api-server/src/lib/observedLiveDraft';
import {normalizeOpenDotaLiveIds, safeOpenDotaId} from '../artifacts/api-server/src/lib/openDotaLiveIds';

test('UI and worker share one in-flight request and preserve provider receipt time', async () => {
  let now=1000, calls=0;
  let resolve!: (data: unknown)=>void;
  const cache=createLiveFeedCache(()=>{calls++;return new Promise(done=>{resolve=done;});},()=>now);
  const worker=cache(), ui=cache();
  assert.equal(calls,1);
  now=2000;resolve([{match_id:42}]);
  const [a,b]=await Promise.all([worker,ui]);
  assert.strictEqual(a,b);
  now=119000;
  assert.equal((await cache()).fetchedAt.getTime(),2000);
  assert.equal(calls,1);
});

test('empty live is cached and expiry fetches again', async () => {
  let now=0,calls=0;
  const cache=createLiveFeedCache(async()=>{calls++;return [];},()=>now);
  await cache();now=119999;await cache();assert.equal(calls,1);
  now=120000;await cache();assert.equal(calls,2);
});

test('upstream failure does not stamp old state as fresh or trigger a request storm', async () => {
  let now=0,calls=0;
  const cache=createLiveFeedCache(async()=>{calls++;if(calls>1)throw new Error('private upstream detail');return [{match_id:42}];},()=>now);
  const first=await cache();now=120000;
  await assert.rejects(cache(),/temporarily unavailable/);
  await assert.rejects(cache(),/temporarily unavailable/);
  assert.equal(calls,2);assert.equal(first.fetchedAt.getTime(),0);
  now=150000;await assert.rejects(cache(),/temporarily unavailable/);assert.equal(calls,3);
});

test('non-array upstream payload cannot become a successful empty feed', async () => {
  const cache=createLiveFeedCache(async()=>({error:'failure'}));
  await assert.rejects(cache(),/temporarily unavailable/);
});

test('observed heroes do not fabricate bans or draft chronology',()=>{
  const players=Array.from({length:10},(_,i)=>({hero_id:i+1,team:i<5?0:1}));
  const draft=observedLiveDraft({players},new Map(),'2026-10-03T00:00:00Z');
  assert.equal(draft?.picks.length,10);assert.equal(draft?.bansKnown,false);
  assert.equal(draft?.orderKnown,false);assert.deepEqual(draft?.bans,[]);
  assert.ok(draft?.picks.every(p=>p.order===null));
  assert.equal(observedLiveDraft({players:players.slice(1)},new Map(),''),null);
  assert.equal(observedLiveDraft({players:[...players.slice(0,9),players[0]]},new Map(),''),null);
  assert.equal(observedLiveDraft({players,between_maps:true},new Map(),''),null);
});

test('provider numeric string IDs remain exact across the shared worker/UI boundary',()=>{
  const row=normalizeOpenDotaLiveIds({match_id:'9027674421',team_id_radiant:'123',team_id_dire:456,league_id:'789',lobby_id:'18446744073709551615'});
  assert.equal(row.match_id,9027674421);assert.equal(row.team_id_radiant,123);
  assert.equal(row.team_id_dire,456);assert.equal(row.lobby_id,'18446744073709551615');
  for(const id of [0,-1,'0','1e3',' 42','0042','9027674421x','9007199254740993',true,null]) assert.equal(safeOpenDotaId(id),undefined);
});
