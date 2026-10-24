import test from 'node:test';
import assert from 'node:assert/strict';
import {extractParsedPayload} from './parsed-payload';
import {planParsedWrite} from './parsed-write';

const receipt=new Date('2026-10-23T11:00:00Z'),later=new Date('2026-10-23T12:10:00Z'),now=new Date('2026-10-24T12:00:00Z');
const slots=[0,1,2,3,4,128,129,130,131,132];
function payload(netWorth?: number){return extractParsedPayload({version:1,players:slots.map((player_slot,i)=>({player_slot,hero_id:i+1,gold_per_min:400,...(i===0&&netWorth!==undefined?{net_worth:netWorth}:{})}))})!;}

test('older retained response cannot backdate a later-only merged field',()=>{
 const previous={...payload(15000),parsedAt:later},before=structuredClone(previous);
 const plan=planParsedWrite(previous,payload(),{receivedAt:receipt,materializedAt:now});
 assert.deepEqual(plan,{status:'skip_not_newer',values:null,parsedAt:null});assert.deepEqual(previous,before);
});

test('equal receipt is idempotent and cannot replace the first admitted projection',()=>{
 const plan=planParsedWrite({...payload(15000),parsedAt:later},payload(99999),{receivedAt:new Date(later),materializedAt:now});
 assert.equal(plan.status,'skip_not_newer');
});

test('newer merge keeps optional fields but assigns the newer availability',()=>{
 const previous={...payload(15000),parsedAt:receipt},incoming=payload(),copies=structuredClone({previous,incoming});
 const plan=planParsedWrite(previous,incoming,{receivedAt:later,materializedAt:now});
 assert.equal(plan.status,'write');if(plan.status!=='write')return;
 assert.equal(plan.values.players[0].net_worth,15000);assert.equal(plan.parsedAt.getTime(),later.getTime());
 assert.equal(plan.availabilityBasis,'incoming_receipt');assert.deepEqual({previous,incoming},copies);
});

test('unknown or invalid prior availability forces materialization time on the entire merged row',()=>{
 for(const parsedAt of [null,undefined,new Date(NaN),'not-a-date']){
  const plan=planParsedWrite({...payload(15000),parsedAt},payload(),{receivedAt:receipt,materializedAt:now});
  assert.equal(plan.status,'write');if(plan.status!=='write')continue;
  assert.equal(plan.values.players[0].net_worth,15000);assert.equal(plan.parsedAt.getTime(),now.getTime());
  assert.equal(plan.availabilityBasis,'unknown_prior_materialization');
 }
});

test('first insertion retains its actual immutable raw receipt without fabricating earlier data',()=>{
 const plan=planParsedWrite(null,payload(),{receivedAt:receipt,materializedAt:now});
 assert.equal(plan.status,'write');if(plan.status!=='write')return;
 assert.equal(plan.parsedAt.getTime(),receipt.getTime());assert.equal(plan.values.players[0].net_worth,null);
});

test('invalid or future receipt cannot produce a write',()=>{
 for(const timing of [{receivedAt:new Date(NaN),materializedAt:now},{receivedAt:now,materializedAt:receipt},{receivedAt:receipt,materializedAt:new Date(NaN)}]){
  assert.throws(()=>planParsedWrite(null,payload(),timing),/parsed_write_invalid_receipt_or_materialization/);
 }
});

test('ordered writer model keeps newest rich state regardless of receipt arrival order',()=>{
 const middle=new Date('2026-10-23T11:30:00Z');
 for(const order of [[receipt,later,middle],[later,receipt,middle],[middle,receipt,later]]){
  let row: (ReturnType<typeof payload> & {parsedAt:Date}) | null=null;
  for(const at of order){const plan=planParsedWrite(row,payload(at===later?15000:undefined),{receivedAt:at,materializedAt:now});if(plan.status==='write')row={...plan.values,parsedAt:plan.parsedAt};}
  assert.equal(row!.parsedAt.getTime(),later.getTime());assert.equal(row!.players[0].net_worth,15000);
 }
});
