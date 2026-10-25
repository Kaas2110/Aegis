import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPersistedSeriesRouteContextStore} from './persistedSeriesRouteContext.mjs';
import {createSeriesRouteContextStore,SERIES_ROUTE_POINTER_KIND as PTR} from './seriesRouteContextStore.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';
const AT='2026-10-24T13:00:00Z',sha=x=>createHash('sha256').update(x).digest('hex');
function receipt(seriesId='series:7'){const utf8=JSON.stringify({contract:'aegis.series-map-receipts.v1',seriesId,team1Id:'100',team2Id:'200',bestOf:3,availableAt:'2026-10-24T12:00:00Z',completeThroughMapNumber:0,previousMaps:[]});return{utf8,pin:{path:'synthetic-series',sha256:sha(utf8),bytes:Buffer.byteLength(utf8)}};}
function storage(){const objects=new Map(),entries=[];let sequence=0,mutateList=x=>x;return{objects,entries,mutateList(fn){mutateList=fn;},async commit({kind,utf8,expectedSha256}){assert.equal(sha(utf8),expectedSha256);const key=kind+':'+expectedSha256,reference=Object.freeze({kind,sha256:expectedSha256,bytes:Buffer.byteLength(utf8)});if(!objects.has(key)){objects.set(key,utf8);entries.push({reference,commitSequence:++sequence,generation:'00000000-0000-4000-8000-000000000001'});}return reference;},async read(ref){return objects.get(ref.kind+':'+ref.sha256);},async listCommitted({kind}){return mutateList(entries.filter(e=>e.reference.kind===kind).map(value=>structuredClone(value)));}};}
async function seed(port){const store=createSeriesRouteContextStore({storage:port,now:()=>AT});await store.commitContext({seriesInput:receipt(),phase:'SERIES_PRE'});await store.commitContext({seriesInput:receipt(),phase:'PRE',currentMap:{mapId:'101',mapNumber:1}});return store;}

test('owned committed journal discovers exact latest heads and restores without a caller-chosen pointer',async()=>{
 const port=storage();await seed(port);const restored=await createPersistedSeriesRouteContextStore({storage:port,now:()=>AT});assert.equal(restored.recovery.pointerRecords,2);assert.equal(restored.recovery.series,1);assert.equal(restored.recovery.heads[0].ordinal,2);assert.equal(restored.contextStore.resolve({seriesId:'series:7'}).currentMap.mapId,'101');assert.equal(restored.recovery.discoveryBasis,'owned_committed_writer_journal');
 const empty=await createPersistedSeriesRouteContextStore({storage:storage(),now:()=>AT});assert.equal(empty.recovery.series,0);assert.equal(empty.contextStore.resolve({seriesId:'series:7'}),null);
});

test('recovery rejects truncated, reordered, excessive or forked committed pointer inventories',async()=>{
 for(const variant of ['truncated','reordered','oversized','fork','generation']){const port=storage();await seed(port);let limits={};
  if(variant==='truncated')port.mutateList(list=>list.slice(1));if(variant==='reordered')port.mutateList(list=>list.reverse());if(variant==='oversized')limits={maxPointers:1};if(variant==='generation')port.mutateList(list=>list.map((row,i)=>i?{...row,generation:'00000000-0000-4000-8000-000000000002'}:row));
  if(variant==='fork'){const latest=port.entries.filter(e=>e.reference.kind===PTR).at(-1),body=JSON.parse(await port.read(latest.reference));body.previousPointer=null;body.ordinal=1;const utf8=JSON.stringify(body);await port.commit({kind:PTR,utf8,expectedSha256:sha(utf8)});}
  await assert.rejects(createPersistedSeriesRouteContextStore({storage:port,now:()=>AT,recoveryLimits:limits}),/committed_pointer_fork_or_gap|commit_order_or_duplicate|pointer_inventory_bound|mixed_writer_generations/);
 }
});

test('pointer byte corruption or STOP prevents any partially recovered store from escaping',async()=>{
 const port=storage();await seed(port);const pointer=port.entries.find(e=>e.reference.kind===PTR).reference;port.objects.set(PTR+':'+pointer.sha256,'corrupted');await assert.rejects(createPersistedSeriesRouteContextStore({storage:port,now:()=>AT}),/pointer_bytes/);
 const stopped=storage();await seed(stopped);let allowed=true;const original=stopped.listCommitted;stopped.listCommitted=async input=>{const list=await original(input);allowed=false;return list;};await assert.rejects(createPersistedSeriesRouteContextStore({storage:stopped,now:()=>AT,shouldContinue:()=>allowed}),/manual_stop_or_abort/);
});

test('a concurrent committed series revision during recovery cannot expose the older discovered head',async()=>{
 const port=storage(),owner=createSeriesRouteContextStore({storage:port,now:()=>AT});await owner.commitContext({seriesInput:receipt(),phase:'SERIES_PRE'});const original=port.read;let changed=false;
 port.read=async ref=>{if(!changed){changed=true;await owner.commitContext({seriesInput:receipt(),phase:'PRE',currentMap:{mapId:'101',mapNumber:1}});}return original(ref);};
 await assert.rejects(createPersistedSeriesRouteContextStore({storage:port,now:()=>AT}),/pointer_inventory_changed_during_recovery/);
});

test('real filesystem writer restart discovers and verifies series heads using a synthetic owned lease',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aegis-series-writer-r5-'));let held=false,writer=null;
 const leaseProvider=createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{if(held)throw Error('synthetic_busy');held=true;let active=true;return{assertHeld:async()=>{if(!active||!held)throw Error('synthetic_lost');},release:async()=>{if(active){active=false;held=false;}}};}});
 try{writer=await createPersistentArtifactWriter({directory,leaseProvider});await seed(writer);await writer.close();writer=await createPersistentArtifactWriter({directory,leaseProvider});const restored=await createPersistedSeriesRouteContextStore({storage:writer,now:()=>AT});assert.equal(restored.recovery.pointerRecords,2);assert.equal(restored.recovery.heads[0].verifiedRevisions,2);assert.equal(restored.contextStore.resolve({seriesId:'series:7'}).phase,'PRE');assert.equal(restored.recovery.recordedPrediction,false);
 }finally{if(writer)await writer.close();await rm(directory,{recursive:true,force:true});}
});
