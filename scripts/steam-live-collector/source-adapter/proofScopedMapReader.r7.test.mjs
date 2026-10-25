import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createProofScopedMapReader,PROOF_SCOPED_MAP_CACHE_MAX_UTF8_BYTES} from './proofScopedMapReader.mjs';

const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const epoch=()=>({sourceSnapshotHash:'a'.repeat(64),generation:'actual-generation',epoch:'actual-writer-epoch',journalBytes:100,committedArtifacts:3,reservedArtifacts:0,reservations:3,effectiveBytes:10000});
function fixture({maxBytes=64*1024*1024}={}){
 const arena=createDiagnosticResourceArena({maxBytes});let scans=0,currentEpoch=epoch(),currentRows=freeze([{matchId:'10',values:[0.1,0.2,0.3],missing:[false,false,false]},{matchId:'2',values:[1e16,1,-1e16],missing:[false,false,false]}]);
 return {arena,get scans(){return scans;},set rows(value){currentRows=value;},set epoch(value){currentEpoch=value;},ports:{resourceArena:arena,async *iterate(){scans++;yield*currentRows;},async readEpoch(){return currentEpoch;}}};
}
async function collect(reader){const result=[];for await(const row of reader.iterate())result.push(row);return result;}

test('one proof caches actual immutable rows in exact source order, then rereads all dependencies before finalizing',async()=>{
 const f=fixture(),reader=await createProofScopedMapReader(f.ports);
 try{
  const first=await collect(reader),second=await collect(reader);assert.deepEqual(first.map(r=>r.matchId),['10','2']);assert.equal(first[0],second[0]);assert.equal(f.scans,1);assert.ok(reader.status().chargedBytes>8*1024*1024);assert.equal(reader.status().cachedRowReads,4);
  assert.equal(first[1].values.reduce((a,b)=>a+b,0),0,'the reader never changes binary64 reduction order');
  const receipt=await reader.verifyFinal();assert.equal(f.scans,2);assert.equal(receipt.verifiedEpoch,true);assert.equal(receipt.cached,true);assert.equal(receipt.count,2);assert.equal(reader.status().finalized,true);await assert.rejects(collect(reader),/epoch_finalized/);
 }finally{reader.release();assert.equal(reader.release(),false);assert.equal(f.arena.status().chargedBytes,0);}
 await assert.rejects(collect(reader),/released/);
});

test('a second invocation does not reuse an earlier proof cache or verification receipt',async()=>{
 const f=fixture();for(let i=0;i<2;i++){const reader=await createProofScopedMapReader(f.ports);try{await collect(reader);await reader.verifyFinal();}finally{reader.release();}}assert.equal(f.scans,4);assert.equal(f.arena.status().chargedBytes,0);
});

test('cache wire ceiling falls back to the original streaming path without dropping rows',async()=>{
 const f=fixture(),reader=await createProofScopedMapReader({...f.ports,maxCachedUtf8Bytes:1});try{assert.equal(reader.status().cached,false);assert.equal(reader.status().fallbackReason,'cache_wire_bound');assert.equal((await collect(reader)).length,2);assert.equal((await collect(reader)).length,2);const receipt=await reader.verifyFinal();assert.equal(receipt.cached,false);assert.equal(f.scans,4);}finally{reader.release();assert.equal(f.arena.status().chargedBytes,0);}
 await assert.rejects(createProofScopedMapReader({...f.ports,maxCachedUtf8Bytes:PROOF_SCOPED_MAP_CACHE_MAX_UTF8_BYTES+1}),/ports_or_cache_bound/);
});

test('cache admission failure discards retained rows while preserving bounded uncached correctness',async()=>{
 const f=fixture({maxBytes:8*1024*1024+65536}),reader=await createProofScopedMapReader(f.ports);try{assert.equal(reader.status().cached,false);assert.equal(reader.status().fallbackReason,'cache_memory_admission');assert.equal(reader.status().cachedRows,0);assert.equal((await collect(reader)).length,2);await reader.verifyFinal();}finally{reader.release();assert.equal(f.arena.status().chargedBytes,0);}
});

test('incomplete synthetic writer epochs cannot authorize cache reuse',async()=>{
 const f=fixture();f.epoch={sourceSnapshotHash:'a'.repeat(64)};const reader=await createProofScopedMapReader(f.ports);try{assert.equal(reader.status().fallbackReason,'epoch_evidence_unavailable');await collect(reader);await collect(reader);assert.equal((await reader.verifyFinal()).verifiedEpoch,false);assert.equal(f.scans,4);}finally{reader.release();assert.equal(f.arena.status().chargedBytes,0);}
});

test('shallow freeze, mutable nested arrays, accessors and proxy rows do not become trusted cache ownership',async()=>{
 for(const bad of [Object.freeze({matchId:'1',values:[1]}),Object.freeze({get value(){throw Error('getter must not execute');}}),new Proxy(Object.freeze({matchId:'1'}),{})]){
  const f=fixture();f.rows=[bad];await assert.rejects(createProofScopedMapReader(f.ports),/immutable_plain_row_required|row_accessor/);assert.equal(f.arena.status().chargedBytes,0);
 }
});

test('changed source contents fail final verification and release all cache ownership',async()=>{
 const f=fixture(),reader=await createProofScopedMapReader(f.ports);f.rows=freeze([{matchId:'10',values:[9],missing:[false]}]);await assert.rejects(reader.verifyFinal(),/source_changed/);assert.equal(reader.status().active,false);assert.equal(f.arena.status().chargedBytes,0);
});

test('generation, fencing epoch, source reference or ledger/accounting change invalidates the calculation',async()=>{
 for(const [key,value]of [['generation','other-generation'],['epoch','other-epoch'],['sourceSnapshotHash','b'.repeat(64)],['journalBytes',101],['committedArtifacts',4],['reservedArtifacts',1],['reservations',4],['effectiveBytes',10001]]){
  const f=fixture(),reader=await createProofScopedMapReader(f.ports);f.epoch={...epoch(),[key]:value};await assert.rejects(reader.verifyFinal(),/epoch_changed/,key);assert.equal(f.arena.status().chargedBytes,0);
 }
});

test('epoch change during initial load and actual writer read errors fail closed before any result',async()=>{
 const f=fixture();let epochs=0;await assert.rejects(createProofScopedMapReader({...f.ports,readEpoch:async()=>({...epoch(),journalBytes:++epochs})}),/epoch_changed/);assert.equal(f.arena.status().chargedBytes,0);
 const g=fixture();let scans=0;const reader=await createProofScopedMapReader({...g.ports,async *iterate(){if(++scans===2)throw Error('persistent_artifact_writer:object_integrity');yield freeze({matchId:'1',values:[1]});}});await assert.rejects(reader.verifyFinal(),/object_integrity/);assert.equal(g.arena.status().chargedBytes,0);
});

test('STOP during cached reading and before final verification never finalizes a receipt',async()=>{
 const f=fixture();let running=true;const reader=await createProofScopedMapReader({...f.ports,shouldContinue:()=>running});try{const iterator=reader.iterate();await iterator.next();running=false;await assert.rejects(iterator.next(),/stopped/);await assert.rejects(reader.verifyFinal(),/stopped/);assert.equal(reader.status().finalized,false);}finally{reader.release();assert.equal(f.arena.status().chargedBytes,0);}
});

test('oversized individual rows fail before canonical allocation and release early reservations',async()=>{
 const f=fixture();f.rows=freeze([{matchId:'1',payload:'x'.repeat(1024*1024+8192)}]);await assert.rejects(createProofScopedMapReader(f.ports),/diagnostic_size:byte_bound/);assert.equal(f.arena.status().chargedBytes,0);
});
