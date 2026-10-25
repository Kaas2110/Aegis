import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {validateRegistry,digest} from '../../feature-registry/registry-contract.mjs';
import {createFeatureProjectionCompiler} from './featureProjectionCompiler.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createCompactFeatureJournal} from './compactFeatureJournal.mjs';
import {createCompactDiagnosticHostJournal} from './compactDiagnosticHostJournal.mjs';
const AT='2026-10-25T12:00:00Z';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(t){
 const arena=createDiagnosticResourceArena({maxBytes:512*1024**2}),objects=new Map();
 const writer={contract:'aegis.persistent-artifact-writer.v1',async commit({kind,utf8,expectedSha256}){assert.equal(sha(utf8),expectedSha256);const ref={kind,sha256:expectedSha256,bytes:Buffer.byteLength(utf8)};objects.set(kind+':'+ref.sha256,utf8);return ref;},async read(ref){const text=objects.get(ref.kind+':'+ref.sha256);assert.equal(Buffer.byteLength(text),ref.bytes);return text;}};
 const [index,familyDocument,targetDocument]=syntheticRegistry();
 const compiler=createFeatureProjectionCompiler({registry:validateRegistry(index,familyDocument,targetDocument),registryHash:digest({index,familyDocument,targetDocument}),sourceInventory:{history:{primarySha256:'a'.repeat(64),files:[{path:'synthetic-history.mjs',sha256:'a'.repeat(64)}]}},sourceProfiles:{history:'synthetic.prior'},resourceArena:arena});
 const options={writer,resourceArena:arena,assetWorkingBytes:16*1024**2,operationWorkingBytes:4*1024**2,maxWireBytes:1024**2};
 const strict=createCompactFeatureJournal(options),compat=createCompactFeatureJournal({...options,allowLegacyByteOnlyStaticHistory:true}),routes=[];
 function bundle(mode,allTargets=false){
  const b=compiler.normalize({names:['synthetic.history'],definitions:[{name:'synthetic.history',familyId:'H01',formula:'synthetic exact authority test',formulaVersion:'r7',units:'fraction',inputScopes:['prior_maps'],minimumSupport:5}],values:[0.4],masks:[false],schemaHash:'b'.repeat(64)},'history');
  const target=mode==='PRE'?'PRE_MAP_WIN':mode==='BETWEEN'?'SERIES_BETWEEN':'SERIES_PRE',targets=allTargets&&mode==='PRE'?['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION']:[target],projected=targets.map(id=>compiler.project([b],id,id.startsWith('SERIES_')?id:mode));b.release();routes.push(...projected);
  return {contract:'aegis.unified-diagnostic-feature-producer.v2',mode,matchId:mode==='PRE'?'90001':null,seriesId:mode==='PRE'?null:'synthetic:r7',decisionAt:AT,components:{},routes:projected,eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
 }
 t.after(async()=>{await strict.close();await compat.close();for(const r of routes)r.release();compiler.close();assert.equal(arena.status().chargedBytes,0);});
 return {strict,compat,bundle,writer,objects,arena};
}
for(const mode of ['PRE','SERIES_PRE','BETWEEN'])test('strict '+mode+' rejects omitted/null authority on actual owned append and committed reload',async t=>{
 const f=fixture(t),input=f.bundle(mode);
 for(const historicalInputRef of [undefined,null])await assert.rejects(f.strict.appendBundle({...input,historicalInputRef}),/historical_input_reference_required/);
 const saved=await f.compat.appendBundle(input); // Explicit byte-only historical format remains readable only in that profile.
 const held=await f.compat.loadTrace(saved.reference);held.release();
 await assert.rejects(f.strict.loadTrace(saved.reference),/historical_input_reference_required/);
});

test('R7 compact read queue owns four descriptors, snapshots reference and serializes rich IO',async t=>{
 const f=fixture(t),saved=await f.compat.appendBundle(f.bundle('PRE'));let finish,entered,hold=true,reads=0;const gate=new Promise(r=>{finish=r;}),started=new Promise(r=>{entered=r;}),read=f.writer.read;
 f.writer.read=async ref=>{reads++;if(hold){hold=false;entered();await gate;}return read(ref);};
 const first=f.compat.loadTrace(saved.reference,{metadataOnly:true});await started;
 const ref={...saved.reference},second=f.compat.loadTrace(ref,{metadataOnly:true}),third=f.compat.loadTrace(saved.reference,{metadataOnly:true}),fourth=f.compat.loadTrace(saved.reference,{metadataOnly:true});ref.sha256='f'.repeat(64);
 assert.equal(f.compat.cacheStats().pendingOperations,4);assert.equal(reads,1);
 await assert.rejects(f.compat.loadTrace(saved.reference),/pending_limit/);finish();
 for(const held of await Promise.all([first,second,third,fourth])){assert.equal(held.assetVerification,'metadata_only');held.release();}
 assert.equal(f.compat.cacheStats().pendingOperations,0);
});

test('R7 summary and selected target avoid unrelated rich assets while complete read detects their corruption',async t=>{
 const f=fixture(t),saved=await f.compat.appendBundle(f.bundle('PRE',true));f.compat.clearCache();
 const unrelated=saved.routes.find(r=>r.targetId==='PRE_KILLS').vectorArtifact;
 f.objects.set(unrelated.kind+':'+unrelated.sha256,'x'.repeat(unrelated.bytes));
 const before=f.compat.cacheStats(),summary=await f.compat.loadTrace(saved.reference,{metadataOnly:true});assert.equal(summary.assetVerification,'metadata_only');summary.release();assert.equal(f.compat.cacheStats().assetLoads,before.assetLoads);
 const selected=await f.compat.loadTrace(saved.reference,{targetId:'PRE_MAP_WIN'});assert.equal(selected.assetVerification,'selected_target');const page=selected.readVectorPage({targetId:'PRE_MAP_WIN',limit:1});assert.equal(page.values[0],0.4);page.release();assert.throws(()=>selected.readVectorPage({targetId:'PRE_KILLS'}),/trace_target/);selected.release();
 await assert.rejects(f.compat.loadTrace(saved.reference),/artifact_integrity/);
});

test('R7 queued cancellation and caller deadline immediately release only bounded descriptors',async t=>{
 const f=fixture(t),saved=await f.compat.appendBundle(f.bundle('PRE'));let finish,entered,reads=0;const gate=new Promise(r=>finish=r),started=new Promise(r=>entered=r),read=f.writer.read;
 f.writer.read=async ref=>{reads++;if(reads===1){entered();await gate;}return read(ref);};
 const first=f.compat.loadTrace(saved.reference,{metadataOnly:true});await started;
 const aborted=new AbortController();aborted.abort();await assert.rejects(f.compat.loadTrace(saved.reference,{}, {signal:aborted.signal}),/request_cancelled/);assert.equal(reads,1);
 const controller=new AbortController(),cancelled=f.compat.loadTrace(saved.reference,{metadataOnly:true},{signal:controller.signal}),rejected=assert.rejects(cancelled,/request_cancelled/);assert.equal(f.compat.cacheStats().pendingOperations,2);controller.abort();await rejected;assert.equal(f.compat.cacheStats().pendingOperations,1);
 await assert.rejects(f.compat.loadTrace(saved.reference,{metadataOnly:true},{queueWaitMs:1}),/queue_expired/);assert.equal(f.compat.cacheStats().pendingOperations,1);assert.equal(reads,1);
 await assert.rejects(f.compat.loadTrace(saved.reference,{}, {queueWaitMs:2001}),/queue_controls/);finish();const held=await first;held.release();assert.equal(f.compat.cacheStats().pendingOperations,0);
});

test('R7 close cancels unstarted descriptors before the active IO finishes',async t=>{
 const f=fixture(t),saved=await f.compat.appendBundle(f.bundle('PRE'));let finish,entered;const gate=new Promise(r=>finish=r),started=new Promise(r=>entered=r),read=f.writer.read;let reads=0;
 f.writer.read=async ref=>{if(++reads===1){entered();await gate;}return read(ref);};const first=f.compat.loadTrace(saved.reference,{metadataOnly:true});await started;
 const queued=f.compat.loadTrace(saved.reference,{metadataOnly:true}),cancelled=assert.rejects(queued,/closed/),closing=f.compat.close();await cancelled;assert.equal(f.compat.cacheStats().pendingOperations,1);finish();const held=await first;held.release();await closing;assert.equal(f.compat.cacheStats().pendingOperations,0);
});

test('R7 append retains actual schema and vector authority before caller releases routes synchronously',async t=>{
 const f=fixture(t),input=f.bundle('PRE'),pending=f.compat.appendBundle(input);for(const route of input.routes)route.release();const saved=await pending,held=await f.compat.loadTrace(saved.reference);try{const page=held.readVectorPage({targetId:'PRE_MAP_WIN',limit:1});assert.equal(page.values[0],0.4);page.release();}finally{held.release();}
});

test('R7 host trace lookup is in the same FIFO as rich decoding',async t=>{
 const f=fixture(t);let inside=0,maximum=0,lookups=0;
 f.writer.listCommitted=async()=>[];f.writer.findCommitted=async({kind,sha256})=>{maximum=Math.max(maximum,++inside);lookups++;try{await new Promise(r=>setTimeout(r,2));const text=f.objects.get(kind+':'+sha256);return text?{reference:{kind,sha256,bytes:Buffer.byteLength(text)}}:null;}finally{inside--;}};
 const host=createCompactDiagnosticHostJournal({writer:f.writer,resourceArena:f.arena,journalOptions:{allowLegacyByteOnlyStaticHistory:true,assetWorkingBytes:16*1024**2,operationWorkingBytes:4*1024**2,maxWireBytes:1024**2}});
 try{const saved=await host.appendBundle(f.bundle('PRE'));const pending=Array.from({length:4},()=>host.loadTrace(saved.reference.sha256,{metadataOnly:true}));for(const held of await Promise.all(pending))held.release();assert.equal(maximum,1);assert.equal(lookups,4);}finally{await host.close();}
});
