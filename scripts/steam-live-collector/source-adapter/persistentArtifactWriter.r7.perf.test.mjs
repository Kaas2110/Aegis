import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';

// Root runs ONE selected prefix under its owned resource guard. This is a
// synthetic writer-only measurement, not corpus/view/proof or live acceptance.
// No providers, padded source originals, native compiler or fitted model.
async function sample(t,count,batched){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-r7-writer-prefix-'));let held=false;
 const leaseProvider=createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{if(held)throw Error('busy');held=true;return {assertHeld:async()=>{if(!held)throw Error('lost');},release:async()=>{held=false;}};}});
 const writer=await createPersistentArtifactWriter({directory,leaseProvider});
 t.after(async()=>{await writer.close();await fs.rm(directory,{recursive:true,force:true});});
 const inputs=Array.from({length:count},(_,i)=>{const utf8=JSON.stringify({contract:'synthetic-writer-prefix.v1',version:i,value:'x'.repeat(4096)});return {kind:'synthetic-writer-prefix',utf8,expectedSha256:createHash('sha256').update(utf8).digest('hex')};});
 const before=await writer.inspect(),start=process.hrtime.bigint(),refs=[];
 if(batched){for(let i=0;i<inputs.length;i+=64)refs.push(...await writer.commitMany(inputs.slice(i,i+64)));}
 else for(const input of inputs)refs.push(await writer.commit(input));
 const wallMs=Number(process.hrtime.bigint()-start)/1e6,after=await writer.inspect(),delta=Object.fromEntries(Object.keys(after.metrics).map(k=>[k,after.metrics[k]-before.metrics[k]]));
 const readStart=process.hrtime.bigint();for(let i=0;i<refs.length;i+=64)assert.deepEqual(await writer.readMany(refs.slice(i,i+64)),inputs.slice(i,i+64).map(x=>x.utf8));const readMs=Number(process.hrtime.bigint()-readStart)/1e6;
 assert.equal(after.committedArtifacts,count);assert.equal(after.reservedBytes,0);assert.equal(delta.objectHashes,count);assert.equal(delta.journalWrites,count*2);
 return {mode:batched?'commitMany':'single',count,wallMs,readMs,metrics:delta,physicalBytes:after.physicalBytes,reservedBytes:after.reservedBytes,refs};
}

for(const count of [64,128])test(`writer prefix profile ${count}`,{timeout:150000},async t=>{
 const single=await sample(t,count,false),batch=await sample(t,count,true);
 assert.deepEqual(batch.refs,single.refs);assert.ok(batch.metrics.inventoryScans<single.metrics.inventoryScans);assert.equal(batch.metrics.fileFlushes,single.metrics.fileFlushes);assert.equal(batch.metrics.objectHashes,single.metrics.objectHashes);
 t.diagnostic(JSON.stringify({contract:'aegis.writer-prefix-profile.v1',synthetic:true,count,single:{...single,refs:undefined},batch:{...batch,refs:undefined},measuredSpeedup:single.wallMs/batch.wallMs}));
});
