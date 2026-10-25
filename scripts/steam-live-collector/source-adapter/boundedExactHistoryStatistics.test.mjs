import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createBoundedExactHistoryStatistics as create,restoreBoundedExactHistoryStatistics as restore,readBoundedExactHistoryStatistics as read} from './boundedExactHistoryStatistics.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),AT='2026-10-23T12:00:00Z';
const descriptor=(id='duration')=>({id,formulaVersion:'synthetic-exact-oracle.v1',units:'seconds',population:'synthetic_distinct_maps',minimumSupport:1,quantiles:[0,.25,.5,.75,1]});
function store(){const objects=new Map();return {contract:'aegis.persistent-artifact-writer.v1',objects,async commit({kind,utf8,expectedSha256}){assert.equal(sha(utf8),expectedSha256);const ref={kind,sha256:expectedSha256,bytes:Buffer.byteLength(utf8)};objects.set(kind+':'+ref.sha256,utf8);return ref;},async read(ref){return objects.get(ref.kind+':'+ref.sha256);}};}
const row=(i,values)=>({matchId:String(i),knownAt:AT,values});
const q=(values,p)=>{const a=[...values].sort((a,b)=>a-b),index=(a.length-1)*p,lo=Math.floor(index),hi=Math.ceil(index);return a[lo]+(a[hi]-a[lo])*(index-lo);};
function compare(stat,values){const mean=values.reduce((s,v)=>s+v,0)/values.length,sd=values.length<2?null:Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/(values.length-1));assert.equal(stat.supportMaps,values.length);assert.equal(stat.mean,mean);assert.equal(stat.sampleSd,sd);for(const p of [0,.25,.5,.75,1])assert.equal(stat.quantiles[String(p)],q(values,p));}
test('bounded exact kernel preserves numeric-id arithmetic and empirical quantiles',async()=>{
 const artifactStore=store(),values=[1e16,1,-1e16,5,2,100],records=[row(2,[values[0]]),row(10,[values[1]]),row(100,[values[2]]),row(101,[values[3]]),row(102,[values[4]]),row(103,[values[5]])],result=await create({artifactStore,records,descriptors:[descriptor()],historyCutoffAt:AT});
 compare(result.descriptor.statistics[0],values);assert.equal(result.descriptor.sourceAuthentication,false);assert.equal(result.descriptor.completeRelationalProducerBridge,false);
 const held=read(result.handle,{expectedReductionSha256:result.reference.sha256,expectedDescriptorSha256:result.descriptor.descriptorSha256,historyCutoffAt:AT});assert.equal(held.statistics[0].mean,result.descriptor.statistics[0].mean);
 assert.throws(()=>read(structuredClone(result.handle),{expectedReductionSha256:result.reference.sha256,expectedDescriptorSha256:result.descriptor.descriptorSha256,historyCutoffAt:AT}),/owned_handle_required/);
});
test('multiple persisted scalar batches share source rows and replay exact statistics',async()=>{
 const artifactStore=store(),a=Array.from({length:1100},(_,i)=>(i%7===0?-1:1)*(i*37%1009)+i/10000),b=a.filter((_,i)=>i%3!==0),records=a.map((v,i)=>row(i+1,[v,i%3===0?null:v*2]));
 const result=await create({artifactStore,records,descriptors:[descriptor('a'),descriptor('b')],historyCutoffAt:AT});assert.equal(result.descriptor.batches.length,3);compare(result.descriptor.statistics[0],a);compare(result.descriptor.statistics[1],b.map(v=>v*2));
 const restored=await restore({artifactStore,reference:result.reference});assert.deepEqual(restored.descriptor,result.descriptor);assert.notEqual(restored.handle,result.handle);
});
test('Float64 radix order-statistics remain exact for negatives, subnormals and repeated zero',async()=>{
 const values=[-1e100,-20,-Number.MIN_VALUE,-0,0,Number.MIN_VALUE,.1,.1+Number.EPSILON,Number.MAX_SAFE_INTEGER,1e100],result=await create({artifactStore:store(),records:values.map((v,i)=>row(i+1,[v])),descriptors:[descriptor()],historyCutoffAt:AT});compare(result.descriptor.statistics[0],values);
});
test('null support is explicit and does not invent zero means or quantiles',async()=>{
 const d={...descriptor(),minimumSupport:3},r=await create({artifactStore:store(),records:[row(1,[null]),row(2,[2])],descriptors:[d],historyCutoffAt:AT}),s=r.descriptor.statistics[0];assert.equal(s.supportMaps,1);assert.equal(s.mean,null);assert.equal(s.sampleSd,null);assert.equal(s.reason,'below_minimum_support');assert.ok(Object.values(s.quantiles).every(v=>v===null));
});
test('lexical ordering, duplicate map ids, future availability and scalar NaN fail closed',async()=>{
 for(const records of [[row(10,[1]),row(2,[2])],[row(2,[1]),row(2,[2])],[{...row(1,[1]),knownAt:'2026-10-24T12:00:00Z'}],[row(1,[NaN])]])await assert.rejects(create({artifactStore:store(),records,descriptors:[descriptor()],historyCutoffAt:AT}),/numeric_map_order_or_duplicate|row|scalar/);
});
test('rehashed manifest assertions and modified scalar bytes fail actual replay',async()=>{
 const artifactStore=store(),r=await create({artifactStore,records:[row(1,[2]),row(2,[3])],descriptors:[descriptor()],historyCutoffAt:AT}),bad=structuredClone(r.descriptor);bad.statistics[0].mean=123;const utf8=JSON.stringify(bad),ref=await artifactStore.commit({kind:r.reference.kind,utf8,expectedSha256:sha(utf8)});await assert.rejects(restore({artifactStore,reference:ref}),/not_rederived/);
 const batch=r.descriptor.batches[0];artifactStore.objects.set(batch.kind+':'+batch.sha256,'x'.repeat(batch.bytes));await assert.rejects(restore({artifactStore,reference:r.reference}),/batch_integrity/);
});
test('STOP and accessor descriptors cannot publish a reduction manifest',async()=>{
 const artifactStore=store();await assert.rejects(create({artifactStore,records:[row(1,[1])],descriptors:[descriptor()],historyCutoffAt:AT,shouldContinue:()=>false}),/stopped/);assert.equal([...artifactStore.objects.keys()].some(k=>k.startsWith('bounded-history-statistics-v1:')),false);
 let invoked=0;const d=descriptor();Object.defineProperty(d,'units',{get(){invoked++;return 'seconds';},enumerable:true});await assert.rejects(create({artifactStore,records:[],descriptors:[d],historyCutoffAt:AT}),/accessor/);assert.equal(invoked,0);
});
