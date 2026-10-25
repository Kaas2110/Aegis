import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {digest,validateRegistry} from '../../feature-registry/registry-contract.mjs';
import {createFeatureProjectionCompiler} from './featureProjectionCompiler.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createCompactFeatureJournal as create} from './compactFeatureJournal.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function bundle(){
 const [index,familyDocument,targetDocument]=syntheticRegistry(),c=createFeatureProjectionCompiler({registry:validateRegistry(index,familyDocument,targetDocument),registryHash:digest({index,familyDocument,targetDocument}),sourceInventory:{history:{primarySha256:'a'.repeat(64),files:[{path:'synthetic.mjs',sha256:'a'.repeat(64)}]}},sourceProfiles:{history:'synthetic.prior'}});
 const names=['synthetic.zero','synthetic.negative_zero','synthetic.missing'],block=c.normalize({names,values:[0,-0,null],masks:[false,false,true],schemaHash:digest(names),definitions:names.map(name=>({name,familyId:'H01',formula:'synthetic fixture only',formulaVersion:'synthetic.v1',units:'fraction',inputScopes:['prior_maps']}))},'history');
 return{contract:'aegis.unified-diagnostic-feature-producer.v2',mode:'PRE',matchId:'90001',seriesId:null,decisionAt:'2026-10-24T12:00:00Z',historyCutoffAt:'2026-10-24T11:00:00Z',components:{},routes:[c.project([block],'PRE_MAP_WIN','PRE')],eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
}
async function fixture(t,{writerWrapper=x=>x}={}){
 const directory=await mkdtemp(join(tmpdir(),'aegis-compact-journal-r5-')),arena=createDiagnosticResourceArena({maxBytes:512*1024*1024});let locked=false;
 const provider=createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{if(locked)throw Error('synthetic_busy');locked=true;return{assertHeld:async()=>{if(!locked)throw Error('synthetic_lost');},release:async()=>{locked=false;}};}});
 const writer=await createPersistentArtifactWriter({directory,leaseProvider:provider}),journal=create({writer:writerWrapper(writer),resourceArena:arena,assetWorkingBytes:32*1024*1024,operationWorkingBytes:8*1024*1024,maxWireBytes:1024*1024});
 t.after(async()=>{await journal.close();await writer.close();await rm(directory,{recursive:true,force:true});});return{directory,arena,writer,journal};
}
test('compact journal preserves exact old semantic hashes and null/zero/negative-zero across restart',async t=>{
 const f=await fixture(t),input=bundle(),saved=await f.journal.appendBundle(input);assert.equal(saved.routes[0].schemaRef.sha256,input.routes[0].schemaRef.sha256);
 assert.equal(saved.routes[0].expandedVectorHash,digest({namesHash:input.routes[0].schemaRef.namesSha256,values:[0,-0,null],missing:[false,false,true]}));
 await f.journal.close();const reloaded=create({writer:f.writer,resourceArena:f.arena,assetWorkingBytes:32*1024*1024,operationWorkingBytes:8*1024*1024,maxWireBytes:1024*1024});
 try{const held=await reloaded.loadTrace(saved.reference);try{const page=held.readVectorPage({targetId:'PRE_MAP_WIN'});try{assert.deepEqual(page.values,[0,-0,null]);assert.deepEqual(page.missing,[false,false,true]);}finally{page.release();}}finally{held.release();}}finally{await reloaded.close();}
 assert.equal(f.arena.status().chargedBytes,0);
});
test('loaded traces keep assets charged after cache eviction and release all owners idempotently',async t=>{
 const f=await fixture(t),saved=await f.journal.appendBundle(bundle()),held=await f.journal.loadTrace(saved.reference);f.journal.clearCache();assert.ok(f.arena.status().chargedBytes>0);
 const page=held.readSchemaPage({targetId:'PRE_MAP_WIN'});assert.ok(page);assert.equal(held.release(),true);assert.equal(held.release(),false);assert.ok(f.arena.status().chargedBytes>0);page.release();assert.equal(f.arena.status().chargedBytes,0);assert.throws(()=>held.readVectorPage({targetId:'PRE_MAP_WIN'}),/released_trace/);
});
test('disk corruption is detected even when its compact asset is cached',async t=>{
 const f=await fixture(t),saved=await f.journal.appendBundle(bundle()),ref=saved.routes[0].vectorArtifact;await writeFile(join(f.directory,'objects',ref.sha256+'.blob'),'x'.repeat(ref.bytes));await assert.rejects(f.journal.loadTrace(saved.reference),/object_integrity/);f.journal.clearCache();assert.equal(f.arena.status().chargedBytes,0);
});
test('overload rejection precedes caller accessors and failed writes do not publish a trace',async t=>{
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const f=await fixture(t,{writerWrapper:w=>({...w,async commit(input){enter();await gate;throw Error('synthetic_write_failure');}})}),pending=f.journal.appendBundle(bundle());await entered;
 let reads=0;const bad={};Object.defineProperty(bad,'contract',{get(){reads++;throw Error('unexpected');},enumerable:true});await assert.rejects(f.journal.appendBundle(bad),/pending_limit/);assert.equal(reads,0);release();await assert.rejects(pending,/synthetic_write_failure/);assert.equal(f.arena.status().chargedBytes,0);assert.equal((await f.writer.listCommitted({kind:'compact-feature-trace-v2'})).length,0);
});
test('rehashing a vector mismatch does not satisfy an old expanded-vector binding',async t=>{
 const f=await fixture(t),saved=await f.journal.appendBundle(bundle()),text=await f.writer.read(saved.reference),body=JSON.parse(text);body.routes[0].expandedVectorHash='f'.repeat(64);const utf8=JSON.stringify(body),ref=await f.writer.commit({kind:'compact-feature-trace-v2',utf8,expectedSha256:sha(utf8)});await assert.rejects(f.journal.loadTrace(ref),/vector_route_binding/);
});
test('rehashing a changed target phase or a future input horizon is rejected',async t=>{
 const f=await fixture(t),saved=await f.journal.appendBundle(bundle()),original=JSON.parse(await f.writer.read(saved.reference));
 for(const change of [b=>{b.mode='LIVE';},b=>{b.routes[0].stateMode='POST';},b=>{b.historyCutoffAt='2026-10-24T13:00:00Z';}]){const body=structuredClone(original);change(body);const utf8=JSON.stringify(body),ref=await f.writer.commit({kind:'compact-feature-trace-v2',utf8,expectedSha256:sha(utf8)});await assert.rejects(f.journal.loadTrace(ref),/target_phase_binding|input_time_after_decision/);}
});
test('missing committed wire chunks fail even after their old parsed handle was cached',async t=>{
 const f=await fixture(t),saved=await f.journal.appendBundle(bundle()),manifest=JSON.parse(await f.writer.read(saved.routes[0].schemaArtifact));assert.equal(manifest.contract,'aegis.compact-feature-wire-manifest.v3');assert.ok(manifest.chunks.length);
 await writeFile(join(f.directory,'objects',manifest.chunks[0].sha256+'.blob'),'changed');await assert.rejects(f.journal.loadTrace(saved.reference),/object_integrity/);
});
test('a valid-looking substituted writer receipt never reports a successful append',async t=>{
 const f=await fixture(t,{writerWrapper:w=>({...w,async commit(input){const ref=await w.commit(input);return{...ref,sha256:'e'.repeat(64)};}})});await assert.rejects(f.journal.appendBundle(bundle()),/writer_receipt_mismatch/);assert.equal((await f.writer.listCommitted({kind:'compact-feature-trace-v2'})).length,0);assert.equal(f.arena.status().chargedBytes,0);
});
