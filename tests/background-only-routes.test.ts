import test from 'node:test';
import assert from 'node:assert/strict';
import express from '../artifacts/api-server/node_modules/express';
import matches from '../artifacts/api-server/src/routes/matches';
import odds, {transformOddsApiEvent} from '../artifacts/api-server/src/routes/odds';
import bookmakers, {fetchSource, readSource, clearBookmakerCache, usableBookmakerEvents, bookmakerEventExpiresAt} from '../artifacts/api-server/src/routes/bookmakers';
import {setFeedFixture} from './fixtures/background-feed-provider';
import {clearResponseCache} from '../artifacts/api-server/src/lib/responseCache';

test('legacy odds never fabricate a missing side and identify series scope',()=>{
 const raw={id:'1',sport_key:'esports_dota2',sport_title:'Dota 2',commence_time:'2026-10-04T08:00:00Z',home_team:'Alpha',away_team:'Beta',bookmakers:[{
  key:'fixture',title:'Fixture',last_update:'2026-10-04T07:00:00Z',markets:[{key:'h2h',last_update:'2026-10-04T07:00:00Z',outcomes:[{name:'Alpha',price:1.8}]}],
 }]};
 assert.deepEqual(transformOddsApiEvent(raw).bookmakers,[]);
 raw.bookmakers[0].markets[0].outcomes.push({name:'Beta',price:2.05});
 assert.equal(transformOddsApiEvent(raw).bookmakers[0].scope,'series');
 assert.equal(transformOddsApiEvent(raw).bookmakers[0].team2Odds,2.05);
});

test('live quote grace is bounded at 195s and source errors override it immediately',()=>{
 const originalNow=Date.now,base=Date.parse('2026-10-03T20:00:00Z');
 const event={source:'bovada',eventId:'1',team1:'A',team2:'B',startsAt:'2026-10-03T19:00:00Z',status:'live' as const,markets:{winner:{team1:1.8,team2:2}},receivedAt:new Date(base).toISOString(),updatedAt:new Date(base).toISOString()};
 const source={source:'bovada',noData:false,events:[event],fetchedAt:event.receivedAt};
 try{
  Date.now=()=>base+194999;
  assert.equal(usableBookmakerEvents(source).length,1);
  assert.equal(bookmakerEventExpiresAt(event),new Date(base+195000).toISOString());
  assert.equal(usableBookmakerEvents({...source,error:'provider unavailable'}).length,0);
  Date.now=()=>base+195000;assert.equal(usableBookmakerEvents(source).length,0);
  const prematch={...event,status:'upcoming' as const,startsAt:new Date(base+30*60000).toISOString()};
  Date.now=()=>base;assert.equal(bookmakerEventExpiresAt(prematch),prematch.startsAt);
 }finally{Date.now=originalNow;}
});

test('actual public routes never call providers at cold start, after TTL expiry or repeated reads', async()=>{
 const app=express();app.use((req:any,_res,next)=>{req.log={info(){},warn(){},error(){}};next();});app.use('/api/matches',matches);app.use('/api/bookmakers',bookmakers);app.use('/api/odds',odds);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const address=server.address() as {port:number};const base='http://127.0.0.1:'+address.port+'/api';
 const originalFetch=globalThis.fetch;const originalNow=Date.now;let upstream=0;
 globalThis.fetch=async(input,options)=>{const url=new URL(String(input));if(!['127.0.0.1','localhost'].includes(url.hostname) || url.port!==String(address.port)){upstream++;throw new Error('Unexpected external fetch');}return originalFetch(input,options);};
 process.env.PORT=String(address.port);
 const paths=['/odds/dota2','/odds/sports','/matches/live','/matches/upcoming','/matches/heroes','/matches/hero-stats','/matches/series-drafts?team1Id=1&team2Id=2','/bookmakers/bovada/dota2','/bookmakers/all/dota2','/bookmakers/merged/dota2','/bookmakers/matched/dota2','/bookmakers/status','/bookmakers/for-match?team1=Alpha&team2=Beta'];
 try {
  clearBookmakerCache();clearResponseCache();setFeedFixture({data:null,receivedAt:null,attemptedAt:null,error:'background_feed_not_ready'});
  for(const path of paths){const response=await fetch(base+path);assert.ok([200,503].includes(response.status),path);const body=await response.json();if(path==='/matches/live')assert.equal(body.unavailable,true);}
  const receipt='2026-01-01T00:00:00.000Z';setFeedFixture({data:[],receivedAt:receipt,attemptedAt:receipt,error:null});clearResponseCache();
  for(let round=0;round<3;round++){
   Date.now=()=>originalNow()+round*2*3600_000;
   for(const path of paths){const response=await fetch(base+path);assert.equal(response.status,path.startsWith('/odds/') ? 503 : 200,path);const body=await response.json();if(path==='/matches/upcoming'){assert.equal(body.fetchedAt,receipt);assert.equal(body.stale,true);}}
  }
  assert.equal(upstream,0);
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow;await new Promise<void>(r=>server.close(()=>r()));}
});
test('bookmaker refresh succeeds in worker only; failure retains prior event receipt', async()=>{
 const originalFetch=globalThis.fetch,originalNow=Date.now;let time=originalNow()-120*60_000,calls=0;
 Date.now=()=>time;clearBookmakerCache();
 // Bovada expects grouped displayGroups; [] is a valid confirmed empty source.
 globalThis.fetch=async()=>{calls++;return new Response('[]',{status:200,headers:{'content-type':'application/json'}});};
 try{
  const ok=await fetchSource('bovada',{force:true});assert.equal(ok.error,undefined);assert.equal(calls,1);assert.ok(ok.fetchedAt);
  time+=66*60_000;const stale=await readSource('bovada');assert.equal(stale.stale,true);assert.equal(stale.fetchedAt,ok.fetchedAt);assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;return new Response('forbidden',{status:403});};
  const failed=await fetchSource('bovada',{force:true});assert.ok(failed.error);assert.equal(failed.fetchedAt,ok.fetchedAt);assert.equal(failed.stale,true);
  for(let i=0;i<10;i++) await readSource('bovada');assert.equal(calls,2);
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow;clearBookmakerCache();}
});

test('stale bookmaker prices remain diagnostic only and cannot enter match odds',async()=>{
 const app=express();app.use((req:any,_res,next)=>{req.log={info(){},warn(){},error(){}};next();});app.use('/api/bookmakers',bookmakers);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const address=server.address() as {port:number};const base='http://127.0.0.1:'+address.port;
 const originalFetch=globalThis.fetch,originalNow=Date.now;let calls=0;
 const start=originalNow()+60_000;
 const fixture=[{path:[{link:'/esports/dota-2'}],events:[{id:'fixture-event',status:'U',live:false,startTime:start,competitors:[{name:'Alpha'},{name:'Beta'}],displayGroups:[{markets:[{status:'O',description:'Moneyline',period:{description:'Game'},outcomes:[{status:'O',description:'Alpha',price:{decimal:1.8}},{status:'O',description:'Beta',price:{decimal:2.1}}]}]}]}]}];
 globalThis.fetch=async(input,options)=>{if(String(input).startsWith(base))return originalFetch(input,options);calls++;return new Response(JSON.stringify(fixture),{status:200,headers:{'content-type':'application/json'}});};
 const path='/api/bookmakers/for-match?team1=Alpha&team2=Beta&startsAt='+encodeURIComponent(new Date(start).toISOString());
 try{
  clearBookmakerCache();const fresh=await fetchSource('bovada',{force:true});assert.equal(fresh.events.length,1);
  const found=await (await fetch(base+path)).json();assert.equal(found.found,true);assert.equal(found.sources[0].markets.winner.team1,1.8);
  Date.now=()=>originalNow()+66*60_000;
  const expired=await (await fetch(base+path)).json();assert.equal(expired.found,false);assert.deepEqual(expired.sources,[]);
  const diagnostic=await (await fetch(base+'/api/bookmakers/all/dota2')).json();
  assert.equal(diagnostic.sources[0].events.length,1);assert.equal(diagnostic.sources[0].stale,true);assert.equal(diagnostic.sources[0].fetchedAt,fresh.fetchedAt);
  const merged=await (await fetch(base+'/api/bookmakers/merged/dota2')).json();assert.deepEqual(merged.events,[]);assert.equal(calls,1);
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow;clearBookmakerCache();await new Promise<void>(r=>server.close(()=>r()));}
});
