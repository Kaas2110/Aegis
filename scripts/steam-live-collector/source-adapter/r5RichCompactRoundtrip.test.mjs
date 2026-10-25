import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {performance} from 'node:perf_hooks';
import {syntheticRichProducerFixture} from './r5RichProducer.fixtures.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createWindowsArtifactWriterLeaseProvider} from './artifactWriterLeaseWindows.mjs';
import {createCompactFeatureJournal} from './compactFeatureJournal.mjs';

// Actual canonical rich generation + real temporary CAS + Windows lease + new
// compact decoder. Pinned synthetic match inputs, no model-quality evidence.
test('actual rich bundle roundtrips every ordered feature through compact journal and restart',{skip:process.env.AEGIS_R5_RICH_ACCEPTANCE!=='1'},async()=>{
 assert.equal(process.platform,'win32');assert.ok(process.env.AEGIS_TEST_PYTHON);
 const directory=await mkdtemp(join(tmpdir(),'aegis-r5-rich-compact-')),arena=createDiagnosticResourceArena({maxBytes:2*1024**3}),leaseProvider=createWindowsArtifactWriterLeaseProvider({pythonExecutable:process.env.AEGIS_TEST_PYTHON});let writer,journal,loaded;
 const times={},begin=performance.now();
 try{
  const f=syntheticRichProducerFixture(),bundle=f.generate(30);times.generateMs=performance.now()-begin;
  console.log(JSON.stringify({phase:'actual_rich_generated',columns:bundle.routes.map(r=>r.schemaRef.featureCount),elapsedMs:times.generateMs}));
  writer=await createPersistentArtifactWriter({directory,leaseProvider});journal=createCompactFeatureJournal({writer,resourceArena:arena});
  const before=performance.now(),saved=await journal.appendBundle(bundle);times.writeMs=performance.now()-before;
  console.log(JSON.stringify({phase:'compact_manifest_committed',elapsedMs:times.writeMs,arena:arena.status()}));
  assert.equal(saved.eligibleForServing,false);assert.equal(saved.eligibleForTraining,false);
  await journal.close();journal=null;await writer.close();writer=null;assert.equal(arena.status().chargedBytes,0);
  writer=await createPersistentArtifactWriter({directory,leaseProvider});journal=createCompactFeatureJournal({writer,resourceArena:arena});
  const loadAt=performance.now();loaded=await journal.loadTrace(saved.reference);times.reloadMs=performance.now()-loadAt;
  console.log(JSON.stringify({phase:'compact_trace_reloaded',elapsedMs:times.reloadMs,arena:arena.status()}));
  for(const original of bundle.routes){
   let offset=0;while(offset<original.schemaRef.featureCount){
    const page=loaded.readVectorPage({targetId:original.targetId,offset,limit:200});assert.ok(page,'page reservation rejected inside declared test budget');
    try{for(let i=0;i<page.values.length;i++){assert.equal(page.names[i],original.diagnosticVector.names[offset+i]);assert.equal(Object.is(page.values[i],original.diagnosticVector.values[offset+i]),true);assert.equal(page.missing[i],original.diagnosticVector.missing[offset+i]);}offset+=page.values.length;}finally{page.release();}
   }
   const head=loaded.readSchemaPage({targetId:original.targetId,offset:0,limit:3});assert.ok(head);try{assert.deepEqual(head.definitions,original.diagnosticSchema.definitions.slice(0,3));}finally{head.release();}
  }
  await journal.clearCache();assert.ok(arena.status().chargedBytes>0,'in-flight loaded trace must remain charged after LRU eviction');loaded.release();loaded=null;
  assert.equal(arena.status().chargedBytes,0);
  console.log(JSON.stringify({contract:'aegis.r5-rich-compact-roundtrip.v1',syntheticInputs:true,actualCanonicalProducer:true,routes:bundle.routes.map(r=>({targetId:r.targetId,columns:r.schemaRef.featureCount})),times,writer:await writer.inspect(),arena:arena.status(),rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed,trained:false}));
 }finally{loaded?.release();await journal?.close();await writer?.close();await rm(directory,{recursive:true,force:true});}
});
