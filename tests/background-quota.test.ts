import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyOdState,reserveOdState,createOdFetch,OD_LIMITS,type OdLedger} from '../lib/db/src/opendotaBudget';
const now=Date.parse('2026-10-03T00:00:00Z');

test('history job cannot starve a full hour of live polls',()=>{
 const state=emptyOdState();
 for(let i=0;i<32;i++) assert.equal(reserveOdState(state,now,1,'background'),null);
 assert.equal(reserveOdState(state,now,1,'background')?.reason,'background_hour_limit');
 for(let i=0;i<30;i++) assert.equal(reserveOdState(state,now+i*120_000,1,'live'),null);
 assert.equal(state.backgroundHour.units,62);assert.equal(state.backgroundHour.liveUnits,30);
 assert.equal(reserveOdState(state,now+3_599_999,1,'live')?.reason,'background_hour_limit');
 assert.equal(reserveOdState(state,now+3_600_000,1,'background'),null);
 assert.equal(state.backgroundHour.liveUnits,undefined);
});
test('concurrent history and live reservations remain within shared budgets',async()=>{
 const state=emptyOdState();
 const first=await Promise.all(Array.from({length:100},(_,i)=>Promise.resolve().then(()=>reserveOdState(state,now,1,i%2?'live':'background'))));
 assert.equal(first.filter(v=>v===null).length,60);assert.ok(state.backgroundHour.units<=62);
 assert.ok(state.backgroundHour.units-(state.backgroundHour.liveUnits??0)<=32);
 // Minute capacity reopens; hourly capacity still caps the combination at 62.
 await Promise.all(Array.from({length:20},()=>Promise.resolve().then(()=>reserveOdState(state,now+61_000,1,'live'))));
 assert.equal(state.backgroundHour.units,62);assert.equal(state.days['2026-10-03'].units,62);
});
test('idle polls and explicit retry attempts consume quota without unlocking history reserve',async()=>{
 const state=emptyOdState();let at=now,sends=0;
 const ledger:OdLedger={reserve:async(units,kind)=>{const e=reserveOdState(state,at,units,kind);if(e)throw e;},block:async()=>{throw new Error('unused');},snapshot:async()=>({state,now:at})};
 const fetcher=createOdFetch(ledger,'live',async()=>{sends++;return new Response('[]');});
 for(let i=0;i<6;i++){at=now+i*600_000;await fetcher('https://api.opendota.com/api/live');}
 // Explicit retry is another attempt, even for an identical packet.
 await fetcher('https://api.opendota.com/api/live');assert.equal(sends,7);assert.equal(state.backgroundHour.liveUnits,7);
 for(let i=0;i<32;i++)assert.equal(reserveOdState(state,at,1,'background'),null);
 assert.equal(reserveOdState(state,at,1,'background')?.reason,'background_hour_limit');
 assert.equal(state.days['2026-10-03'].calls,39);
});
test('24 hours at both caps stays below free daily cap; a restored exhausted day blocks all channels',()=>{
 const state=emptyOdState();
 for(let hour=0;hour<24;hour++){
  const start=now+hour*3_600_000;
  for(let i=0;i<32;i++)assert.equal(reserveOdState(state,start,1,'background'),null);
  for(let i=0;i<30;i++)assert.equal(reserveOdState(state,start+i*120_000,1,'live'),null);
 }
 assert.equal(state.days['2026-10-03'].units,1488);
 for(let i=0;i<12;i++)assert.equal(reserveOdState(state,now+86_399_000,1,'user'),null);
 assert.equal(OD_LIMITS.daily,3000);assert.equal(OD_LIMITS.minute,60);
 // The paid-to-free policy raised the free daily allowance; keep the stricter hourly reserve.
 assert.equal(reserveOdState(state,now+86_399_000,1,'live')?.reason,'background_hour_limit');
 state.days['2026-10-03'].units=OD_LIMITS.daily;
 for(const kind of ['live','background','user'] as const)
   assert.equal(reserveOdState(state,now+86_399_000,1,kind)?.reason,'daily_limit');
});
test('legacy hour state without liveUnits remains conservatively bounded after restart',()=>{
 const state=emptyOdState();state.backgroundHour={key:'2026-10-03T00',units:32};
 assert.equal(reserveOdState(state,now,1,'background')?.reason,'background_hour_limit');
 assert.equal(reserveOdState(state,now,1,'live'),null);assert.equal(state.backgroundHour.liveUnits,1);
});
