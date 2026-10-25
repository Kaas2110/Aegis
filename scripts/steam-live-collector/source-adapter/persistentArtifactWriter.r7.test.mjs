import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';

const sha=utf8=>createHash('sha256').update(utf8).digest('hex');
const command=(utf8,kind='synthetic-r7')=>({kind,utf8,expectedSha256:sha(utf8)});
const expected=c=>({kind:c.kind,sha256:c.expectedSha256,bytes:Buffer.byteLength(c.utf8)});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

// Real bounded temporary files, synthetic lease/STOP infrastructure only. These
// tests do not establish Windows OS lease behavior, real source coverage or RSS.
async function fixture(t,{limits={},guard=async()=>true}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-writer-r7-'));
 let owner=null;
 const leaseProvider=createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{
  if(owner)throw Error('synthetic_lease_busy');const token={};owner=token;
  return {assertHeld:async()=>{if(owner!==token)throw Error('synthetic_lease_lost');},release:async()=>{if(owner===token)owner=null;}};
 }});
 const instances=[];
 const open=async()=>{const writer=await createPersistentArtifactWriter({directory,leaseProvider,limits,shouldContinue:()=>guard(directory)});instances.push(writer);return writer;};
 t.after(async()=>{for(const w of instances)await w.close();await fs.rm(directory,{recursive:true,force:true});});
 const writer=await open();return {directory,writer,open};
}

test('single read snapshots admitted reference and charges queued declared bytes',async t=>{
 let gate=null,entered=null;
 const f=await fixture(t,{limits:{maxObjectBytes:1024,maxPendingBytes:1500},guard:async()=>{if(gate){const wait=gate;gate=null;entered.resolve();await wait.promise;}return true;}});
 const a=await f.writer.commit(command('a'.repeat(700))),b=await f.writer.commit(command('b'.repeat(900)));
 gate=deferred();const release=gate;entered=deferred();const active=f.writer.read(a);await entered.promise;
 const callerRef={...a},queued=f.writer.read(callerRef);Object.assign(callerRef,b);
 await assert.rejects(f.writer.read(b),/pending_limit/);release.resolve();
 assert.equal(await active,'a'.repeat(700));assert.equal(await queued,'a'.repeat(700));
 assert.equal(await f.writer.read(b),'b'.repeat(900));
});

test('single read rejects accessor and symbol records without invoking getters',async t=>{
 const f=await fixture(t),r=await f.writer.commit(command('plain'));let touched=0;
 const bad={...r};Object.defineProperty(bad,'kind',{enumerable:true,get(){touched++;return r.kind;}});
 await assert.rejects(f.writer.read(bad),/read_plain_data_required/);assert.equal(touched,0);
 await assert.rejects(f.writer.read({...r,[Symbol('extra')]:1}),/read_plain_data_required/);
 const proxy=new Proxy({...r},{getPrototypeOf(){touched++;throw Error('proxy_trap');}});await assert.rejects(f.writer.read(proxy),/read_plain_data_required/);assert.equal(touched,0);
});

for(const entry of ['ROOT.json','ledger.jsonl'])test(`same-size ${entry} mutation poisons open writer before new IO`,async t=>{
 const f=await fixture(t),r=await f.writer.commit(command('first')),p=path.join(f.directory,entry),original=await fs.readFile(p,'utf8'),ledger=await fs.readFile(path.join(f.directory,'ledger.jsonl'),'utf8');
 const index=entry==='ROOT.json'?original.indexOf('"generation":"')+'"generation":"'.length:original.indexOf('"sha256":"')+'"sha256":"'.length;
 assert.ok(index>=0);const changed=original.slice(0,index)+(original[index]==='0'?'1':'0')+original.slice(index+1);assert.equal(Buffer.byteLength(changed),Buffer.byteLength(original));await fs.writeFile(p,changed);
 await assert.rejects(f.writer.commit(command('never-published')),entry==='ROOT.json'?/root_integrity/:/journal_integrity/);
 assert.equal(await fs.readFile(path.join(f.directory,'ledger.jsonl'),'utf8'),entry==='ROOT.json'?ledger:changed);
 await fs.writeFile(p,original);await assert.rejects(f.writer.read(r),/recovery_required/);
 await f.writer.close();const reopened=await f.open();assert.equal(await reopened.read(r),'first');assert.equal((await reopened.inspect()).committedArtifacts,1);
});

test('commitMany preserves ordered duplicates, byte dedupe, exact lookup and restart',async t=>{
 const f=await fixture(t),commands=[command('one'),command('два😇'),command('one'),command('one','synthetic-other')];
 const refs=await f.writer.commitMany(commands);assert.deepEqual(refs,commands.map(expected));assert.ok(Object.isFrozen(refs)&&refs.every(Object.isFrozen));
 assert.equal((await fs.readdir(path.join(f.directory,'objects'))).length,2);
 assert.equal((await f.writer.inspect()).reservedBytes,0);assert.deepEqual(await f.writer.readMany([refs[1],refs[0],refs[1]]),['два😇','one','два😇']);
 const row=await f.writer.findCommitted({kind:refs[0].kind,sha256:refs[0].sha256});assert.deepEqual(row.reference,refs[0]);assert.ok(row.commitSequence>0);assert.equal(await f.writer.findCommitted({kind:'synthetic-r7',sha256:'0'.repeat(64)}),null);
 await f.writer.close();const reopened=await f.open();assert.deepEqual(await reopened.findCommitted({kind:refs[0].kind,sha256:refs[0].sha256}),row);assert.deepEqual(await reopened.readMany(refs),commands.map(c=>c.utf8));
});

test('commitMany snapshots queued strings and rejects unsafe or oversized batches before writes',async t=>{
 let gate=null,entered=null;
 const f=await fixture(t,{limits:{maxObjectBytes:1024,maxPendingBytes:1500},guard:async()=>{if(gate){const wait=gate;gate=null;entered.resolve();await wait.promise;}return true;}});
 const first=command('first'),second=command('second');gate=deferred();const release=gate;entered=deferred();const active=f.writer.commit(first);await entered.promise;
 const caller={...second},list=[caller];const queued=f.writer.commitMany(list);caller.utf8='changed';caller.expectedSha256=sha('changed');list[0]=command('replaced');release.resolve();await active;assert.deepEqual(await queued,[expected(second)]);
 let touched=0;const accessor={...first};Object.defineProperty(accessor,'utf8',{get(){touched++;return first.utf8;}});
 await assert.rejects(f.writer.commitMany([accessor]),/commit_plain_data_required/);assert.equal(touched,0);
 await assert.rejects(f.writer.commitMany(Array(65).fill(first)),/commit_batch_bound/);
 await assert.rejects(f.writer.commitMany([command('x'.repeat(800)),command('y'.repeat(800))]),/commit_batch_bytes/);
 assert.equal((await f.writer.inspect()).committedArtifacts,2);assert.deepEqual(f.writer.commitBatchLimits,{maxCommands:64,maxBytes:1500});
});

test('midbatch count refusal returns exact acknowledged prefix without rollback',async t=>{
 const f=await fixture(t,{limits:{maxArtifacts:1}}),a=command('accepted'),b=command('refused');
 await assert.rejects(f.writer.commitMany([a,b]),error=>{
  assert.match(error.message,/reservation_count_or_identity/);assert.deepEqual(error.batchOutcome,{contract:'aegis.artifact-commit-batch-failure.v1',outcome:'committed-prefix',acknowledgedPrefix:[expected(a)],nextIndex:1});assert.ok(Object.isFrozen(error.batchOutcome)&&Object.isFrozen(error.batchOutcome.acknowledgedPrefix));return true;
 });
 assert.equal(await f.writer.read(expected(a)),a.utf8);assert.equal((await f.writer.inspect()).reservations,1);
});

test('STOP after durable ACK reports that prefix and preserves exact retry',async t=>{
 let stopAfterAck=false;
 const f=await fixture(t,{guard:async directory=>!stopAfterAck||!(await fs.readFile(path.join(directory,'ledger.jsonl'),'utf8')).includes('"type":"committed"')});
 const a=command('durable-before-stop'),b=command('not-started');stopAfterAck=true;
 await assert.rejects(f.writer.commitMany([a,b]),error=>{assert.match(error.message,/stopped/);assert.equal(error.batchOutcome.outcome,'committed-prefix');assert.deepEqual(error.batchOutcome.acknowledgedPrefix,[expected(a)]);return true;});
 stopAfterAck=false;assert.deepEqual(await f.writer.commitMany([a,b]),[expected(a),expected(b)]);assert.equal((await f.writer.inspect()).reservedBytes,0);
});

test('STOP after visible marker reports unknown outcome and full replay reconciles it',async t=>{
 let stopAtMarker=false;
 const f=await fixture(t,{guard:async directory=>!stopAtMarker||(await fs.readdir(path.join(directory,'commits'))).length===0});
 const a=command('marker-before-ack');stopAtMarker=true;
 await assert.rejects(f.writer.commitMany([a]),error=>{assert.match(error.message,/stopped/);assert.equal(error.batchOutcome.outcome,'unknown');assert.deepEqual(error.batchOutcome.acknowledgedPrefix,[]);return true;});
 stopAtMarker=false;await f.writer.close();const reopened=await f.open();assert.equal(await reopened.read(expected(a)),a.utf8);assert.equal((await reopened.inspect()).reservedBytes,0);
});

test('final boundary corruption rejects aggregate success while keeping acknowledged facts',async t=>{
 let corrupt=false,original=null;
 const f=await fixture(t,{guard:async directory=>{
  if(corrupt&&(await fs.readFile(path.join(directory,'ledger.jsonl'),'utf8')).includes('"type":"committed"')){
   corrupt=false;const p=path.join(directory,'ROOT.json');original=await fs.readFile(p,'utf8');const meta=JSON.parse(original);meta.generation='11111111-1111-1111-1111-111111111111';await fs.writeFile(p,JSON.stringify(meta));
  }return true;
 }});
 const a=command('first'),b=command('second');corrupt=true;
 await assert.rejects(f.writer.commitMany([a,b]),error=>{assert.match(error.message,/root_integrity/);assert.equal(error.batchOutcome.outcome,'unknown');assert.deepEqual(error.batchOutcome.acknowledgedPrefix,[expected(a),expected(b)]);return true;});
 assert.equal((await fs.readdir(path.join(f.directory,'commits'))).length,2);await assert.rejects(f.writer.read(expected(a)),/recovery_required/);
 await fs.writeFile(path.join(f.directory,'ROOT.json'),original);await f.writer.close();const reopened=await f.open();assert.deepEqual(await reopened.readMany([expected(a),expected(b)]),[a.utf8,b.utf8]);
});

test('readMany verifies each duplicate once within its epoch, never across epochs',async t=>{
 const f=await fixture(t),a=await f.writer.commit(command('abc')),b=await f.writer.commit(command('xyz')),before=await f.writer.inspect();
 assert.deepEqual(await f.writer.readMany([a,b,a]),['abc','xyz','abc']);const after=await f.writer.inspect();assert.equal(after.metrics.objectHashes-before.metrics.objectHashes,2);
 await fs.writeFile(path.join(f.directory,'objects',a.sha256+'.blob'),'bad');await assert.rejects(f.writer.readMany([a]),/object_integrity/);
});

test('exact committed lookup reads only requested object and rejects its corruption',async t=>{
 const f=await fixture(t),[a,b]=await f.writer.commitMany([command('first'),command('second')]),before=await f.writer.inspect();
 const row=await f.writer.findCommitted({kind:a.kind,sha256:a.sha256}),after=await f.writer.inspect();assert.deepEqual(row.reference,a);assert.equal(after.metrics.objectReads-before.metrics.objectReads,1);
 await fs.writeFile(path.join(f.directory,'objects',b.sha256+'.blob'),'x'.repeat(b.bytes));assert.deepEqual((await f.writer.findCommitted({kind:a.kind,sha256:a.sha256})).reference,a);await assert.rejects(f.writer.findCommitted({kind:b.kind,sha256:b.sha256}),/object_integrity/);
});

test('incremental batch accounting equals physical tree and full restart replay',async t=>{
 const f=await fixture(t),items=Array.from({length:12},(_,i)=>command('x'.repeat(20+i),i%2?'synthetic-odd':'synthetic-even'));
 await f.writer.commitMany(items);const before=await f.writer.inspect();let actual=0;
 for(const name of await fs.readdir(f.directory)){const p=path.join(f.directory,name),st=await fs.lstat(p);if(st.isFile())actual+=st.size;else for(const entry of await fs.readdir(p))actual+=(await fs.lstat(path.join(p,entry))).size;}
 assert.equal(before.physicalBytes,actual);assert.equal(before.reservedBytes,0);assert.equal(before.effectiveBytes,actual);
 await f.writer.close();const reopened=await f.open(),after=await reopened.inspect();assert.equal(after.committedArtifacts,before.committedArtifacts);assert.equal(after.reservedBytes,0);assert.ok(after.physicalBytes>before.physicalBytes);assert.deepEqual(await reopened.readMany(items.map(expected)),items.map(c=>c.utf8));
});

test('commitMany lower disk limit refuses before reservation and leaves reusable writer',async t=>{
 const f=await fixture(t,{limits:{maxStoredBytes:4096,maxObjectBytes:2048}}),before=await f.writer.inspect();await assert.rejects(f.writer.commitMany([command('x'.repeat(1024))]),/stored_byte_limit/);const after=await f.writer.inspect();assert.equal(after.reservations,0);assert.equal(after.physicalBytes,before.physicalBytes);
});

test('default aggregate 16MiB batch cap rejects before hashing or reservation',async t=>{
 const f=await fixture(t),before=await f.writer.inspect(),utf8='x'.repeat(8*1024*1024+1),input={kind:'synthetic-r7',utf8,expectedSha256:'0'.repeat(64)};
 await assert.rejects(f.writer.commitMany([input,input]),/commit_batch_bytes/);const after=await f.writer.inspect();
 assert.equal(after.reservations,0);assert.equal(after.physicalBytes,before.physicalBytes);assert.equal(after.metrics.payloadHashes-before.metrics.payloadHashes,0);assert.deepEqual(f.writer.commitBatchLimits,{maxCommands:64,maxBytes:16*1024*1024});
});

test('unexpected final file poisons batch without erasing committed prefix or outsider file',async t=>{
 let inject=false;
 const f=await fixture(t,{guard:async directory=>{if(inject&&(await fs.readFile(path.join(directory,'ledger.jsonl'),'utf8')).includes('"type":"committed"')){inject=false;await fs.writeFile(path.join(directory,'foreign.keep'),'unchanged');}return true;}});
 const a=command('durable');inject=true;
 await assert.rejects(f.writer.commitMany([a]),error=>{assert.match(error.message,/unknown_root_entry/);assert.equal(error.batchOutcome.outcome,'unknown');assert.deepEqual(error.batchOutcome.acknowledgedPrefix,[expected(a)]);return true;});
 assert.equal(await fs.readFile(path.join(f.directory,'foreign.keep'),'utf8'),'unchanged');assert.equal((await fs.readdir(path.join(f.directory,'commits'))).length,1);await assert.rejects(f.writer.inspect(),/recovery_required/);
});

test('separate pending reservations for shared bytes keep their own future owners',async t=>{
 let stopAtReserve=false;
 const f=await fixture(t,{guard:async directory=>!stopAtReserve||!(await fs.readFile(path.join(directory,'ledger.jsonl'),'utf8')).includes('"type":"reserve"')});
 const a=command('same bytes','synthetic-a'),b=command('same bytes','synthetic-b');stopAtReserve=true;
 await assert.rejects(f.writer.commit(a),/stopped/);stopAtReserve=false;
 await f.writer.commitMany([b]);const pending=await f.writer.inspect();assert.equal(pending.reservedArtifacts,1);assert.ok(pending.reservedBytes>0);
 await f.writer.commitMany([a]);const complete=await f.writer.inspect();assert.equal(complete.reservedArtifacts,0);assert.equal(complete.reservedBytes,0);assert.equal((await fs.readdir(path.join(f.directory,'objects'))).length,1);
 await f.writer.close();const reopened=await f.open();assert.deepEqual(await reopened.readMany([expected(a),expected(b)]),[a.utf8,b.utf8]);
});
