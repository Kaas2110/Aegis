import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';
import {createPersistentArtifactWriter as create} from './persistentArtifactWriter.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const input=(utf8='{"synthetic":true}',kind='series-context-revision-v1')=>({kind,utf8,expectedSha256:sha(utf8)});
const ref=x=>({kind:x.kind,sha256:x.expectedSha256,bytes:Buffer.byteLength(x.utf8)});

// Real temporary filesystem, deliberately SYNTHETIC callable lease port. These
// tests prove transactional/store semantics, never Windows OS lock behavior.
function syntheticLease(){let owner=null,lost=false;return {provider:createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{
 if(owner)throw Error('synthetic_lease_busy');const token={};owner=token;return {assertHeld:async()=>{if(lost||owner!==token)throw Error('synthetic_lease_lost');},release:async()=>{if(owner===token)owner=null;}};
 }}),lose(){lost=true;},restore(){lost=false;}};}
async function fixture(t,options={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-artifact-writer-r5-')),lease=syntheticLease(),instances=[];
 t.after(async()=>{for(const writer of instances)await writer.close();await fs.rm(directory,{recursive:true,force:true});});
 const open=async(extra={})=>{const writer=await create({directory,leaseProvider:lease.provider,...options,...extra});instances.push(writer);return writer;};
 return {directory,lease,open};
}

test('owned opaque lease required; a second writer cannot acquire the same held root',async t=>{
 const f=await fixture(t);await assert.rejects(create({directory:f.directory,leaseProvider:{held:true,exclusive:true}}),/unowned_provider/);
 const a=await f.open();await assert.rejects(f.open(),/synthetic_lease_busy/);await a.close();const b=await f.open();assert.equal((await b.inspect()).committedArtifacts,0);
});

test('commit marker exposes exact immutable bytes; dedupe and both series kinds preserve references',async t=>{
 const f=await fixture(t),w=await f.open(),x=input(),a=await w.commit(x),before=await w.inspect();
 assert.deepEqual(a,ref(x));assert.equal(Object.isFrozen(a),true);assert.equal(await w.read(a),x.utf8);assert.deepEqual(await w.commit(x),a);
 const after=await w.inspect();assert.equal(after.reservations,before.reservations);assert.equal(after.journalBytes,before.journalBytes);
 const pointer=await w.commit(input(x.utf8,'series-context-pointer-v1'));assert.equal(pointer.sha256,a.sha256);assert.equal((await fs.readdir(path.join(f.directory,'objects'))).length,1);
 assert.equal((await w.inspect()).committedArtifacts,2);assert.deepEqual(await fs.readdir(path.join(f.directory,'temporary')),[]);
 await w.close();const next=await f.open();assert.equal(await next.read(a),x.utf8);assert.equal((await next.inspect()).reservedBytes,0);
});

test('concurrent commits serialize and duplicate content cannot exceed count budget',async t=>{
 const f=await fixture(t,{limits:{maxArtifacts:2}}),w=await f.open();const result=await Promise.all([w.commit(input('one')),w.commit(input('one')),w.commit(input('two'))]);
 assert.deepEqual(result[0],result[1]);assert.equal((await w.inspect()).committedArtifacts,2);await assert.rejects(w.commit(input('three')),/reservation_count_or_identity/);
});

test('admission accounts for payload, both temporary copies, metadata and outstanding ack reservation',async t=>{
 const f=await fixture(t,{limits:{maxStoredBytes:4096,maxObjectBytes:2048}}),w=await f.open(),before=await w.inspect();
 await assert.rejects(w.commit(input('x'.repeat(1024))),/stored_byte_limit/);const after=await w.inspect();assert.equal(after.reservations,0);assert.equal(after.physicalBytes,before.physicalBytes);
 await assert.rejects(w.commit(input('x'.repeat(2049))),/commit_input/);await assert.rejects(w.commit({...input(),expectedSha256:'f'.repeat(64)}),/commit_bytes/);
});

test('STOP after durable reservation exposes no object and preserves exact retry across a new fence',async t=>{
 let stop=false;const f=await fixture(t),guard=async()=>{if(!stop)return true;return !(await fs.readFile(path.join(f.directory,'ledger.jsonl'),'utf8')).includes('"type":"reserve"');};
 const w=await f.open({shouldContinue:guard}),x=input();stop=true;await assert.rejects(w.commit(x),/stopped/);stop=false;
 const before=await w.inspect();assert.equal(before.committedArtifacts,0);assert.equal(before.reservedArtifacts,1);assert.ok(before.reservedBytes>Buffer.byteLength(x.utf8));await assert.rejects(w.read(ref(x)),/uncommitted_reference/);
 await w.close();const next=await f.open(),recovered=await next.inspect();assert.equal(recovered.generation,before.generation);assert.notEqual(recovered.epoch,before.epoch);assert.equal(recovered.reservations,1);
 const committed=await next.commit(x);assert.equal(await next.read(committed),x.utf8);assert.equal((await next.inspect()).reservations,1);
});

test('STOP after marker publication is reconciled from verified own bytes on reopen',async t=>{
 let stop=false;const f=await fixture(t),guard=async()=>!stop||(await fs.readdir(path.join(f.directory,'commits'))).length===0;
 const w=await f.open({shouldContinue:guard}),x=input();stop=true;await assert.rejects(w.commit(x),/stopped/);await w.close();
 const next=await f.open();assert.equal(await next.read(ref(x)),x.utf8);const s=await next.inspect();assert.equal(s.committedArtifacts,1);assert.equal(s.reservedBytes,0);
 // Own leftovers remain physically accounted; no automatic unrelated cleanup.
 assert.ok(s.physicalBytes>=Buffer.byteLength(x.utf8));
});

test('same-instance exact retry acknowledges a published marker before committed discovery',async t=>{
 let stop=false;const f=await fixture(t),guard=async()=>!stop||(await fs.readdir(path.join(f.directory,'commits'))).length===0;
 const w=await f.open({shouldContinue:guard}),x=input('same-instance-retry','series-context-pointer-v1');stop=true;await assert.rejects(w.commit(x),/stopped/);stop=false;
 assert.equal((await w.listCommitted({kind:x.kind})).length,0);
 const committed=await w.commit(x),discovered=await w.listCommitted({kind:x.kind});assert.deepEqual(committed,ref(x));assert.equal(await w.read(committed),x.utf8);assert.equal(discovered.length,1);assert.deepEqual(discovered[0].reference,committed);assert.ok(discovered[0].commitSequence>0);
 const state=await w.inspect();assert.equal(state.reservations,1);assert.equal(state.reservedBytes,0);assert.deepEqual(await fs.readdir(path.join(f.directory,'temporary')),[]);
 const acknowledged=(await fs.readFile(path.join(f.directory,'ledger.jsonl'),'utf8')).split('\n').filter(line=>line&&JSON.parse(line).type==='committed');assert.equal(acknowledged.length,1);
 await w.commit(x);assert.deepEqual(await w.listCommitted({kind:x.kind}),discovered);await w.close();const reopened=await f.open();assert.deepEqual(await reopened.listCommitted({kind:x.kind}),discovered);
});

test('unknown files and interrupted journal are blocked without guessed recovery or cleanup',async t=>{
 const f=await fixture(t),w=await f.open();await w.commit(input());await w.close();const ledger=await fs.readFile(path.join(f.directory,'ledger.jsonl'),'utf8');
 await fs.writeFile(path.join(f.directory,'foreign.keep'),'untouched');await assert.rejects(f.open(),/unknown_root_entry/);assert.equal(await fs.readFile(path.join(f.directory,'ledger.jsonl'),'utf8'),ledger);assert.equal(await fs.readFile(path.join(f.directory,'foreign.keep'),'utf8'),'untouched');
 await fs.unlink(path.join(f.directory,'foreign.keep'));await fs.appendFile(path.join(f.directory,'ledger.jsonl'),'{"interrupted":');await assert.rejects(f.open(),/partial_journal/);
});

test('object or marker tampering is never accepted by a reference or recovered ownership claim',async t=>{
 const f=await fixture(t),w=await f.open(),x=input(),r=await w.commit(x);
 await fs.writeFile(path.join(f.directory,'objects',r.sha256+'.blob'),'x'.repeat(r.bytes));await assert.rejects(w.read(r),/object_integrity/);await assert.rejects(w.commit(x),/object_integrity/);await w.close();await assert.rejects(f.open(),/object_integrity/);
});

test('pending temporary bytes are charged and corruption prevents restart adoption',async t=>{
 let stop=false;const f=await fixture(t),guard=async()=>!stop||(await fs.readdir(path.join(f.directory,'temporary'))).length===0;
 const w=await f.open({shouldContinue:guard}),x=input();stop=true;await assert.rejects(w.commit(x),/stopped/);stop=false;const s=await w.inspect();assert.equal(s.reservedArtifacts,1);assert.ok(s.effectiveBytes>s.physicalBytes);
 await w.close();const temp=(await fs.readdir(path.join(f.directory,'temporary')))[0];await fs.writeFile(path.join(f.directory,'temporary',temp),'corrupt');await assert.rejects(f.open(),/temporary_integrity/);
});

test('lease loss rejects further mutations and reads, preserving recorded root files',async t=>{
 const f=await fixture(t),w=await f.open(),x=input(),r=await w.commit(x),before=await fs.readFile(path.join(f.directory,'ledger.jsonl'),'utf8');f.lease.lose();
 await assert.rejects(w.commit(input('new')),/synthetic_lease_lost/);await assert.rejects(w.read(r),/synthetic_lease_lost/);assert.equal(await fs.readFile(path.join(f.directory,'ledger.jsonl'),'utf8'),before);
});

test('queued payload retention is bounded before serialized work begins',async t=>{
 const f=await fixture(t,{limits:{maxPendingOperations:1}}),w=await f.open(),first=w.commit(input('first'));
 const forbidden={};Object.defineProperty(forbidden,'utf8',{get(){throw Error('getter_must_not_run_after_admission_full');}});
 await assert.rejects(w.commit(forbidden),/pending_limit/);await assert.rejects(w.commit(input('second')),/pending_limit/);await first;assert.equal((await w.inspect()).committedArtifacts,1);
 await assert.rejects(w.commit(forbidden),/commit_plain_data_required/);
});

test('root generation and committed marker acknowledgements are independently bound',async t=>{
 const f=await fixture(t),w=await f.open(),x=input(),r=await w.commit(x);await w.close();
 const markerPath=path.join(f.directory,'commits',`${r.kind}--${r.sha256}.json`),original=await fs.readFile(markerPath,'utf8'),marker=JSON.parse(original);
 marker.generation='11111111-1111-1111-1111-111111111111';await fs.writeFile(markerPath,JSON.stringify(marker));await assert.rejects(f.open(),/marker_integrity/);
 await fs.writeFile(markerPath,original);const rootPath=path.join(f.directory,'ROOT.json'),meta=JSON.parse(await fs.readFile(rootPath,'utf8'));meta.generation='11111111-1111-1111-1111-111111111111';await fs.writeFile(rootPath,JSON.stringify(meta));await assert.rejects(f.open(),/journal_chain/);
});

test('bounded discovery returns owned root generation and verified commit order across reopen',async t=>{
 const f=await fixture(t),w=await f.open(),a=await w.commit(input('first','series-context-pointer-v1')),b=await w.commit(input('second','series-context-pointer-v1'));await w.commit(input('revision'));const before=await w.listCommitted({kind:'series-context-pointer-v1'});
 assert.equal(before.length,2);assert.deepEqual(before.map(x=>x.reference),[a,b]);assert.ok(before[0].commitSequence<before[1].commitSequence);assert.equal(before[0].generation,before[1].generation);assert.ok(Object.isFrozen(before)&&Object.isFrozen(before[0]));
 await w.close();const next=await f.open();assert.deepEqual(await next.listCommitted({kind:'series-context-pointer-v1'}),before);
 await fs.writeFile(path.join(f.directory,'objects',b.sha256+'.blob'),'x'.repeat(b.bytes));await assert.rejects(next.listCommitted({kind:'series-context-pointer-v1'}),/object_integrity/);
});

test('STOP detected after an operation read prevents successful exposure',async t=>{
 const f=await fixture(t);let calls=0,remaining=Infinity;const w=await f.open({shouldContinue:()=>{calls++;return --remaining>=0;}}),r=await w.commit(input());
 // A read has its admission check and a final check after marker/object IO.
 const before=calls;remaining=1;await assert.rejects(w.read(r),/stopped/);assert.equal(calls-before,2);
 remaining=Infinity;assert.equal(await w.read(r),input().utf8);
});
