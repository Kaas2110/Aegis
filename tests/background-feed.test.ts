import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundFeed, feedIsStale, type FeedSnapshot} from '../artifacts/api-server/src/lib/backgroundFeed';

test('cold, repeated and expired reads never collect; only explicit refresh does', async () => {
  let now=1_000, calls=0, stored: FeedSnapshot<number[]> | null=null;
  const feed=createBackgroundFeed({load:async()=>stored,save:async v=>{stored=structuredClone(v);}},async()=>{calls++;return [42];},()=>now);
  assert.equal((await feed.read()).error,'background_feed_not_ready');
  for(let i=0;i<20;i++) await feed.read();
  assert.equal(calls,0);
  const first=await feed.refresh(); assert.equal(calls,1);
  now+=600_000;
  for(let i=0;i<20;i++) assert.deepEqual(await feed.read(), first);
  assert.equal(calls,1);assert.equal(feedIsStale(first,120_000,now),true);
  await feed.refresh();assert.equal(calls,2);
});
test('collector failure preserves original data and receipt; no empty success or secret error',async()=>{
  let now=1_000, calls=0, stored: FeedSnapshot<number[]> | null=null;
  const feed=createBackgroundFeed({load:async()=>stored,save:async v=>{stored=structuredClone(v);}},async()=>{if(++calls>1)throw new Error('TOKEN-SHOULD-NOT-LEAK');return [42];},()=>now);
  const ok=await feed.refresh();now=500_000;
  const failure=await feed.refresh();
  assert.deepEqual(failure.data,[42]);assert.equal(failure.receivedAt,ok.receivedAt);
  assert.equal(failure.attemptedAt,new Date(now).toISOString());assert.equal(failure.error,'upstream_temporarily_unavailable');
  assert.ok(!JSON.stringify(failure).includes('TOKEN'));assert.equal(feedIsStale(failure,1e9,now),true);
});
test('confirmed empty response is distinct from never collected or unavailable',async()=>{
  let fail=true;
  const feed=createBackgroundFeed<unknown[]>({load:async()=>null,save:async()=>{}},async()=>{if(fail)throw new Error('failure');return [];});
  const coldFailure=await feed.refresh();assert.equal(coldFailure.data,null);assert.equal(coldFailure.receivedAt,null);
  fail=false;const empty=await feed.refresh();assert.deepEqual(empty.data,[]);assert.equal(empty.error,null);assert.ok(empty.receivedAt);
});
test('concurrent worker refresh is coalesced and user mutation cannot poison stored data',async()=>{
  let calls=0;let resolve!: (v:number[])=>void;
  const feed=createBackgroundFeed<number[]>({load:async()=>null,save:async()=>{}},()=>{calls++;return new Promise(r=>{resolve=r;});});
  const a=feed.refresh(),b=feed.refresh();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
  resolve([42]);await Promise.all([a,b]);const reader=await feed.read();reader.data!.push(99);assert.deepEqual((await feed.read()).data,[42]);
});
test('restart restores durable receipt; store failure prevents provider requests',async()=>{
  const old={data:[42],receivedAt:'2026-09-01T00:00:00.000Z',attemptedAt:'2026-09-01T00:00:00.000Z',error:null};
  let calls=0;const restored=createBackgroundFeed({load:async()=>old,save:async()=>{}},async()=>{calls++;return [];});
  assert.deepEqual(await restored.read(),old);assert.equal(calls,0);
  const broken=createBackgroundFeed({load:async()=>{throw new Error('DB down');},save:async()=>{}},async()=>{calls++;return [];});
  await assert.rejects(broken.refresh(),/DB down/);assert.equal(calls,0);
});


test('readers never await an in-flight collector or snapshot persistence, even after expiry',async()=>{
 const old={data:[42],receivedAt:'2026-09-01T00:00:00.000Z',attemptedAt:'2026-09-01T00:00:00.000Z',error:null};
 let finishCollect!:(value:number[])=>void,finishSave!:()=>void;
 let collectStarted!:()=>void,saveStarted!:()=>void;
 const collected=new Promise<void>(resolve=>{collectStarted=resolve;});
 const saving=new Promise<void>(resolve=>{saveStarted=resolve;});
 let calls=0;
 const feed=createBackgroundFeed<number[]>({load:async()=>old,save:()=>{saveStarted();return new Promise<void>(resolve=>{finishSave=resolve;});}},()=>{calls++;collectStarted();return new Promise<number[]>(resolve=>{finishCollect=resolve;});});
 const work=feed.refresh();await collected;
 async function assertImmediateRead(){
  let completed=false;const read=feed.read().then(value=>{assert.deepEqual(value,old);completed=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(completed,true,'read awaited background work');await read;
 }
 await assertImmediateRead();finishCollect([99]);await saving;
 await assertImmediateRead();assert.equal(calls,1);
 finishSave();await work;assert.deepEqual((await feed.read()).data,[99]);
});
