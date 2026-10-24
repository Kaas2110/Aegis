import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {runRetainedDiagnosticHost,HOST_CONTRACT} from './retainedDiagnosticHost.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'aegis-finite-host-'));try{
 const archive=join(root,'archive'),facts=join(root,'facts'),state=join(root,'state');await mkdir(archive);await mkdir(join(archive,'observations'));await mkdir(join(archive,'raw'));await mkdir(facts);
 const config={contract:HOST_CONTRACT,enabled:true,archive,stateDirectory:state,historyFactDirectory:facts,historyProfileSha256:'a'.repeat(64),stopFiles:[join(root,'STOP')],limits:{maxReceipts:20,maxRunMs:30000}};
 const committed=new Set(),log=[],writes=[];
 const factory=({onTraceIntent})=>({pipeline:{async consumeCapture(input,options){
  const r=JSON.parse(input.receiptInput.utf8);log.push({requestId:r.requestId,raw:input.rawInput.utf8,options});
  if(r.status==='http_error'||input.rawInput.utf8==='{}')return{status:'processed_diagnostic',results:[]};
  const existing=options.restoreTracesByMap['90001'];if(existing)return{status:'processed_diagnostic',results:[{matchId:'90001',status:'restored_diagnostic_state',traceSha256:existing}]};
  if(options.replayOnly)return{status:'processed_diagnostic',results:[]};
  const hash=sha(input.rawInput.utf8+input.receiptInput.utf8);await onTraceIntent({matchId:'90001',traceSha256:hash});committed.add(hash);writes.push(hash);
  return{status:'processed_diagnostic',results:[{matchId:'90001',status:'recorded_diagnostic',traceCommitted:true,traceSha256:hash}]};
 },breakSourceContinuity(){log.push({continuityBreak:true});},status(){return{syntheticPort:true};}},hasCommittedTrace:async hash=>committed.has(hash)});
 async function capture(index,received,raw='{"live":true}',status='captured_diagnostic'){
  const requestId=String(1792750000000+index)+'-00000000-0000-0000-0000-'+String(index).padStart(12,'0'),hash=sha(raw),receipt={requestId,receivedAt:received,rawSha256:hash,rawFile:'raw/'+hash+'.body',status};
  await writeFile(join(archive,'raw',hash+'.body'),raw);await writeFile(join(archive,'observations',requestId+'.json'),JSON.stringify(receipt));return{requestId,hash};
 }
 await fn({root,config,committed,log,writes,factory,capture});
}finally{await rm(root,{recursive:true,force:true});}}

test('disabled host performs no filesystem operation or factory call',async()=>{let called=false;const r=await runRetainedDiagnosticHost({enabled:false},{pipelineFactory:()=>{called=true;}});assert.equal(r.status,'disabled');assert.equal(called,false);});
test('finite host sorts actual receipts and feeds failed/non-JSON and missing-map barriers',()=>fixture(async({config,capture,factory,log})=>{
 const a=await capture(2,'2026-10-23T12:00:00Z','{"live":1}'),b=await capture(1,'2026-10-23T12:01:00Z','<http failure>','http_error'),c=await capture(3,'2026-10-23T12:02:00Z','{}');
 const r=await runRetainedDiagnosticHost(config,{pipelineFactory:factory});assert.equal(r.status,'completed');assert.equal(r.consumed,3);assert.deepEqual(log.map(x=>x.requestId),[a.requestId,b.requestId,c.requestId]);assert.equal(log[1].raw,'<http failure>');
}));
test('restart reconstructs full original prefix through verified trace references without duplicate writes',()=>fixture(async({config,capture,factory,log,writes})=>{
 await capture(1,'2026-10-23T12:00:00Z','{"live":1}');await capture(2,'2026-10-23T12:01:00Z','{"live":2}');
 assert.equal((await runRetainedDiagnosticHost(config,{pipelineFactory:factory})).consumed,2);assert.equal(writes.length,2);
 await capture(3,'2026-10-23T12:02:00Z','{"live":3}');const r=await runRetainedDiagnosticHost(config,{pipelineFactory:factory});
 assert.equal(r.replayed,2);assert.equal(r.consumed,1);assert.equal(writes.length,3);assert.equal(log[2].options.replayOnly,true);assert.equal(log[3].options.replayOnly,true);assert.equal(log[4].continuityBreak,true);assert.equal(log[5].options.replayOnly,false);assert.equal(r.restartContinuityBroken,true);
}));
test('pending intent alone never counts as a trace, and pending restore precedes the new-capture restart barrier',()=>fixture(async({config,capture,factory,writes,log})=>{
 await capture(1,'2026-10-23T12:00:00Z');let failed=true;
 const interrupted=options=>{const ports=factory(options),consume=ports.pipeline.consumeCapture;ports.pipeline.consumeCapture=async(...args)=>{const r=await consume(...args);if(failed){failed=false;throw Error('crash after committed trace');}return r;};return ports;};
 assert.equal((await runRetainedDiagnosticHost(config,{pipelineFactory:interrupted})).status,'failed');const before=JSON.parse(await readFile(join(config.stateDirectory,'HOST-PROGRESS.json'),'utf8'));assert.equal(before.processed.length,0);assert.equal(Object.keys(before.pending.traceIntentsByMap).length,1);
 await capture(2,'2026-10-23T12:01:00Z','{"live":2}');
 const r=await runRetainedDiagnosticHost(config,{pipelineFactory:factory});assert.equal(r.status,'completed');assert.equal(writes.length,2);assert.equal(r.successfulMapTraceReferences,2);
 assert.ok(log[1].options.restoreTracesByMap['90001']);assert.equal(log[2].continuityBreak,true);assert.equal(log[3].options.replayOnly,false);
}));
test('an interrupted append with no committed trace regenerates and preserves the watermark',()=>fixture(async({config,capture,factory})=>{
 await capture(1,'2026-10-23T12:00:00Z');
 const failing=options=>({pipeline:{async consumeCapture(){await options.onTraceIntent({matchId:'90001',traceSha256:'b'.repeat(64)});throw Error('write failed');}},hasCommittedTrace:async()=>false});
 assert.equal((await runRetainedDiagnosticHost(config,{pipelineFactory:failing})).status,'failed');
 const r=await runRetainedDiagnosticHost(config,{pipelineFactory:factory});assert.equal(r.status,'completed');assert.equal(r.consumed,1);
}));
test('manual STOP, abort and deadline never start or advance host work',()=>fixture(async({config,factory,capture})=>{
 await capture(1,'2026-10-23T12:00:00Z');await writeFile(config.stopFiles[0],'manual test stop');assert.equal((await runRetainedDiagnosticHost(config,{pipelineFactory:factory})).status,'blocked');
 await rm(config.stopFiles[0]);const control=new AbortController();control.abort();assert.equal((await runRetainedDiagnosticHost(config,{pipelineFactory:factory,signal:control.signal})).status,'blocked');
 let tick=0;assert.equal((await runRetainedDiagnosticHost(config,{pipelineFactory:factory,monotonicNow:()=>tick+=31000})).status,'blocked');
}));
test('foreign lock and changed/reordered prefix fail closed without deleting evidence',()=>fixture(async({config,capture,factory})=>{
 await mkdir(config.stateDirectory);await writeFile(join(config.stateDirectory,'HOST.lock'),'foreign');assert.equal((await runRetainedDiagnosticHost(config,{pipelineFactory:factory})).reason,'owned_host_lock_exists');assert.equal(await readFile(join(config.stateDirectory,'HOST.lock'),'utf8'),'foreign');await rm(join(config.stateDirectory,'HOST.lock'));
 await capture(2,'2026-10-23T12:01:00Z');assert.equal((await runRetainedDiagnosticHost(config,{pipelineFactory:factory})).status,'completed');await capture(1,'2026-10-23T12:00:00Z');assert.equal((await runRetainedDiagnosticHost(config,{pipelineFactory:factory})).reason,'retained_prefix_changed_or_reordered');
}));
test('missing raw evidence and resource overflow halt without skipping forward',()=>fixture(async({config,capture,factory,log})=>{
 const a=await capture(1,'2026-10-23T12:00:00Z');await capture(2,'2026-10-23T12:01:00Z','{"next":true}');await rm(join(config.archive,'raw',a.hash+'.body'));
 assert.equal((await runRetainedDiagnosticHost(config,{pipelineFactory:factory})).status,'failed');assert.equal(log.length,0);
 await writeFile(join(config.archive,'raw',a.hash+'.body'),'{"live":true}');
 const limited={...config,limits:{...config.limits,maxReceipts:1}};assert.equal((await runRetainedDiagnosticHost(limited,{pipelineFactory:factory})).reason,'receipt_inventory_bound_or_unexpected_entry');assert.equal(log.length,0);
}));
