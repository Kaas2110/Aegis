import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {canonical} from '../../feature-registry/registry-contract.mjs';
import {pinRetainedHistoryJson as pin} from './retainedOpenDotaFacts.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createCompactHistoricalInputStore as create,readCompactHistoricalInputProof as readProof} from './compactHistoricalInputStore.mjs';
const AT='2026-10-25T12:00:00Z',clock=()=>AT,sha=x=>createHash('sha256').update(x).digest('hex');
function memoryWriter(){const objects=new Map(),commits=[];let readManyCalls=0;return {contract:'aegis.persistent-artifact-writer.v1',objects,commits,get readManyCalls(){return readManyCalls;},async commit({kind,utf8,expectedSha256}){assert.equal(sha(utf8),expectedSha256);const ref={kind,sha256:expectedSha256,bytes:Buffer.byteLength(utf8)};objects.set(kind+':'+ref.sha256,utf8);commits.push(ref);return ref;},async read(ref){return objects.get(ref.kind+':'+ref.sha256);},async readMany(refs){readManyCalls++;return refs.map(r=>objects.get(r.kind+':'+r.sha256));}};}
const factsInput=()=>pin({contract:'aegis.prior-map-facts.v1',maps:[]});
const targetInput=()=>pin({contract:'synthetic-target.v1',matchId:'123',knownAt:'2026-10-23T12:00:00Z'});
const args=(mode='PRE')=>({mode,factsInput:factsInput(),targetInput:targetInput(),...(mode==='PRE'?{}:{seriesInput:pin({contract:'synthetic-series.v1',seriesId:'s1'})})});
const options=a=>({mode:a.mode,historicalBindings:{factsSha256:a.factsInput.pin.sha256,targetSha256:a.targetInput.pin.sha256,historyCutoffAt:'2026-10-23T12:00:00Z',validFrom:'2026-10-23T12:10:00Z'},seriesReceiptPin:a.seriesInput?.pin??null,decisionAt:AT});
test('compact store commits source chunks before immutable header; verifies v1 pins/support',async()=>{
 const writer=memoryWriter(),store=create({writer,clock}),a=args(),result=await store.writeHistoricalInputs({...a,minSupport:7});
 assert.equal(writer.commits.at(-1).kind,'compact-historical-input-set-v2');assert.equal(result.header.contract,'aegis.static-historical-feature-inputs.v1');assert.equal(result.header.calculationOptions.minimumSupport,7);assert.equal(result.descriptor.inputs.facts.sha256,a.factsInput.pin.sha256);assert.equal(result.descriptor.sourceAvailabilityIndependentlyAttested,false);
 const proof=readProof(result.proof,{reference:result.reference,...options(a)});assert.equal(proof.calculationOptions.minimumSupport,7);assert.throws(()=>readProof(structuredClone(result.proof),{reference:result.reference,...options(a)}),/owned_active_proof/);
 assert.equal(result.release(),true);assert.equal(result.release(),false);assert.throws(()=>readProof(result.proof,{reference:result.reference,...options(a)}),/owned_active_proof/);assert.equal(store.status().resourceArena.chargedBytes,0);store.close();
});
test('CAS reference is stable across repeated writes and verification clocks',async()=>{
 const writer=memoryWriter();let at=AT;const store=create({writer,clock:()=>at}),a=args(),left=await store.writeHistoricalInputs(a);left.release();at='2026-10-26T12:00:00Z';const right=await store.writeHistoricalInputs(a);assert.deepEqual(right.reference,left.reference);right.release();store.close();
});
test('all three static modes roundtrip actual source bytes and explicit source leases',async()=>{
 for(const mode of ['PRE','SERIES_PRE','BETWEEN']){const writer=memoryWriter(),arena=createDiagnosticResourceArena(),store=create({writer,clock,resourceArena:arena}),a=args(mode),written=await store.writeHistoricalInputs(a);written.release();const loaded=await store.loadHistoricalInputs(written.reference,options(a));assert.equal(loaded.inputs.facts.utf8,a.factsInput.utf8);assert.equal(loaded.inputs.target.utf8,a.targetInput.utf8);if(a.seriesInput)assert.equal(loaded.inputs.series.utf8,a.seriesInput.utf8);assert.ok(arena.status().chargedBytes>a.factsInput.pin.bytes);loaded.release();assert.equal(arena.status().chargedBytes,0);assert.ok(writer.readManyCalls>0);store.close();}
});
test('UTF8 chunks respect codepoint boundaries and every readMany batch bound',async()=>{
 const writer=memoryWriter(),store=create({writer,clock,limits:{maxChunkBytes:37,maxReadBatchBytes:111,maxReadBatchRefs:3}}),a={...args(),factsInput:pin({text:'Ж漢🙂'.repeat(80)})},w=await store.writeHistoricalInputs(a);w.release();
 assert.ok(writer.commits.filter(r=>r.kind==='compact-historical-input-chunk-v2').every(r=>r.bytes<=37));const loaded=await store.loadHistoricalInputs(w.reference,options(a));assert.equal(loaded.inputs.facts.utf8,a.factsInput.utf8);loaded.release();store.close();
});
test('binding rejects swapped facts/target/series/mode and future target horizons',async()=>{
 const store=create({writer:memoryWriter(),clock}),a=args('BETWEEN'),w=await store.writeHistoricalInputs(a);w.release();const valid=options(a);
 for(const override of [{mode:'PRE'},{historicalBindings:{...valid.historicalBindings,factsSha256:'a'.repeat(64)}},{historicalBindings:{...valid.historicalBindings,targetSha256:'a'.repeat(64)}},{seriesReceiptPin:null},{seriesReceiptPin:{...a.seriesInput.pin,sha256:'a'.repeat(64)}},{decisionAt:'2026-10-23T12:01:00Z'}])await assert.rejects(store.verifyHistoricalInputs(w.reference,{...valid,...override}),/binding|horizon/);
 assert.equal(store.status().resourceArena.chargedBytes,0);store.close();
});
test('deferred IO cannot replace the caller binding snapshot',async()=>{
 const writer=memoryWriter(),store=create({writer,clock}),a=args(),w=await store.writeHistoricalInputs(a);w.release();const originalRead=writer.read;let resume,entered;const gate=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});let paused=true;
 writer.read=async ref=>{if(paused){paused=false;entered();await gate;}return originalRead(ref);};const bound=options(a),pending=store.verifyHistoricalInputs(w.reference,bound);await started;bound.mode='BETWEEN';bound.historicalBindings.factsSha256='a'.repeat(64);bound.decisionAt='2020-01-01T00:00:00Z';resume();const result=await pending;assert.equal(result.header.mode,'PRE');result.release();store.close();
});
test('close during the deferred final callback rejects verification/reload without minting or leaking',async()=>{
 for(const method of ['verifyHistoricalInputs','loadHistoricalInputs']){
  const writer=memoryWriter(),arena=createDiagnosticResourceArena();let armed=false,pauseNext=false,resume,entered;
  const gate=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const store=create({writer,clock,resourceArena:arena,shouldContinue:async()=>{if(armed&&pauseNext){armed=false;entered();await gate;}return true;}}),a=args(),written=await store.writeHistoricalInputs(a);written.release();
  const body=JSON.parse(await writer.read(written.reference)),lastTarget=body.blobs.target.chunks.at(-1).sha256,originalReadMany=writer.readMany;
  writer.readMany=async refs=>{const result=await originalReadMany(refs);if(armed&&refs.some(r=>r.sha256===lastTarget))pauseNext=true;return result;};
  armed=true;const pending=store[method](written.reference,options(a));await started;assert.equal(store.close(),true);resume();await assert.rejects(pending,/closed/);
  assert.equal(store.status().activeProofs,0);assert.equal(arena.status().chargedBytes,0);assert.equal(store.close(),false);
 }
});
test('actual missing/corrupted source chunks fail verification after a valid earlier proof',async()=>{
 const writer=memoryWriter(),store=create({writer,clock}),a=args(),w=await store.writeHistoricalInputs(a);w.release();const manifest=JSON.parse(await writer.read(w.reference)),ref=manifest.blobs.facts.chunks[0];writer.objects.set(ref.kind+':'+ref.sha256,'x'.repeat(ref.bytes));await assert.rejects(store.verifyHistoricalInputs(w.reference,options(a)),/chunk_bytes/);assert.equal(store.status().resourceArena.chargedBytes,0);store.close();
});
test('rehashed header cannot change claimed pins or support policy without dependency validation',async()=>{
 const writer=memoryWriter(),store=create({writer,clock}),a=args(),w=await store.writeHistoricalInputs(a);w.release();const body=JSON.parse(await writer.read(w.reference));body.header.inputs.facts.sha256='a'.repeat(64);const utf8=canonical(body),ref=await writer.commit({kind:w.reference.kind,utf8,expectedSha256:sha(utf8)});await assert.rejects(store.verifyHistoricalInputs({contract:w.reference.contract,...ref},options(a)),/source_blob/);
 body.header.inputs.facts.sha256=a.factsInput.pin.sha256;body.header.calculationOptions.minimumSupport=null;const bad=canonical(body),badRef=await writer.commit({kind:w.reference.kind,utf8:bad,expectedSha256:sha(bad)});await assert.rejects(store.verifyHistoricalInputs({contract:w.reference.contract,...badRef},options(a)),/minimum_support/);store.close();
});
test('memory admission precedes parse/write and active proofs have explicit finite ownership',async()=>{
 const writer=memoryWriter(),small=createDiagnosticResourceArena({maxBytes:1024}),denied=create({writer,clock,resourceArena:small});await assert.rejects(denied.writeHistoricalInputs(args()),/memory_reservation/);assert.equal(writer.commits.length,0);denied.close();
 const store=create({writer,clock,limits:{maxActiveProofs:1}}),a=await store.writeHistoricalInputs(args());await assert.rejects(store.verifyHistoricalInputs(a.reference,options(args())),/proof_count/);assert.equal(store.status().activeProofs,1);store.close();assert.equal(store.status().resourceArena.chargedBytes,0);assert.throws(()=>readProof(a.proof,{reference:a.reference,...options(args())}),/owned_active_proof/);
});
test('STOP never commits a header and foreign support aliases/accessors fail before writes',async()=>{
 const writer=memoryWriter(),store=create({writer,clock,shouldContinue:()=>false});await assert.rejects(store.writeHistoricalInputs(args()),/stopped/);assert.equal(writer.commits.length,0);store.close();
 const valid=create({writer,clock});await assert.rejects(valid.writeHistoricalInputs({...args(),minimumSupport:5,minSupport:7}),/minimum_support/);let invoked=0;const a=args();Object.defineProperty(a.factsInput.pin,'sha256',{enumerable:true,get(){invoked++;return 'a'.repeat(64);}});await assert.rejects(valid.writeHistoricalInputs(a),/accessor/);assert.equal(invoked,0);assert.equal(writer.commits.length,0);valid.close();
});
test('actual owned writer close/reopen revalidates every manifest and source dependency',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-compact-static-history-r6-'));let held=false,writer;
 const leaseProvider=createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{if(held)throw Error('synthetic_busy');held=true;return {assertHeld:async()=>{if(!held)throw Error('synthetic_lost');},release:async()=>{held=false;}};}});
 t.after(async()=>{await writer?.close();await fs.rm(directory,{recursive:true,force:true});});writer=await createPersistentArtifactWriter({directory,leaseProvider});const a=args('SERIES_PRE'),first=create({writer,clock}),w=await first.writeHistoricalInputs(a);w.release();first.close();await writer.close();writer=await createPersistentArtifactWriter({directory,leaseProvider});const second=create({writer,clock}),loaded=await second.loadHistoricalInputs(w.reference,options(a));assert.equal(loaded.inputs.facts.utf8,a.factsInput.utf8);assert.equal(loaded.inputs.series.utf8,a.seriesInput.utf8);loaded.release();second.close();
});

test('serial-only real writer wrapper preserves lowered pending-operation limit with multi-chunk history',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-r6-serial-history-'));let held=false;
 const leaseProvider=createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{if(held)throw Error('busy');held=true;return{assertHeld:async()=>{if(!held)throw Error('lost');},release:async()=>{held=false;}};}}),writer=await createPersistentArtifactWriter({directory,leaseProvider,limits:{maxPendingOperations:1}}),serial={...writer,readMany:undefined},arena=createDiagnosticResourceArena(),store=create({writer:serial,clock,resourceArena:arena,limits:{maxChunkBytes:300}});
 t.after(async()=>{store.close();await writer.close();await fs.rm(directory,{recursive:true,force:true});});
 const a={...args(),factsInput:pin({text:'x'.repeat(2500)})},written=await store.writeHistoricalInputs(a);written.release();
 const loaded=await store.loadHistoricalInputs(written.reference,options(a));assert.equal(loaded.inputs.facts.utf8,a.factsInput.utf8);loaded.release();const checked=await store.verifyHistoricalInputs(written.reference,options(a));checked.release();assert.equal(arena.status().chargedBytes,0);assert.equal((await writer.inspect()).limits.maxPendingOperations,1);
});
