/** Bounded exact scalar statistics over an explicitly numeric-map-id-ordered
 * stream. Fixed batches are persisted through the ONE owned writer. Float64
 * radix selection computes linear empirical quantiles exactly in eight scans;
 * no approximate sketch, all-row sort, fitted state or new source authority.
 * This is a reusable reduction kernel, not the complete relational producer.
 */
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {instantNs} from './causalTime.mjs';
import {numericHistoryMapIdCompare} from './boundedRetainedHistory.mjs';
import {pinRetainedHistoryJson} from './retainedOpenDotaFacts.mjs';
import {snapshotPlainRecord} from './diagnosticResourceArena.mjs';

export const BOUNDED_EXACT_HISTORY_STATISTICS_CONTRACT='aegis.bounded-exact-history-statistics.v1';
export const BOUNDED_EXACT_HISTORY_LIMITS=Object.freeze({maxRows:100000,maxDescriptors:32,maxQuantiles:8,maxBatchRows:512,maxBatchBytes:1024*1024,maxBatches:256,maxScalarBytes:64*1024*1024,maxManifestBytes:256*1024});
const KIND='bounded-history-scalar-batch-v1',MANIFEST='bounded-history-statistics-v1',BATCH='aegis.bounded-history-scalar-batch.v1';
const MASK=(1n<<64n)-1n,SIGN=1n<<63n,handles=new WeakMap();
const floatScratch=Buffer.allocUnsafe(8);
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x),hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),finite=x=>typeof x==='number'&&Number.isFinite(x);
const bytes=x=>Buffer.byteLength(x,'utf8'),sha=x=>createHash('sha256').update(x).digest('hex');
const fail=reason=>{throw Error('bounded_history_statistics:'+reason);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const flags=Object.freeze({eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false});
async function proceed(fn){if(typeof fn!=='function'||await fn()!==true)fail('stopped');}
function port(store){if(store?.contract!=='aegis.persistent-artifact-writer.v1'||typeof store.commit!=='function'||typeof store.read!=='function')fail('owned_writer_required');return store;}
function plainArray(value,maximum,label){
 if(!Array.isArray(value)||types.isProxy(value)||value.length>maximum||Object.getOwnPropertySymbols(value).length||Object.keys(value).length!==value.length)fail(label);
 const out=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))fail(label);out.push(d.value);}return out;
}
function descriptorsOf(input){
 const values=plainArray(input,BOUNDED_EXACT_HISTORY_LIMITS.maxDescriptors,'descriptor_bound');if(!values.length)fail('descriptor_bound');
 const ids=new Set();return freeze(values.map(raw=>{
  const d=snapshotPlainRecord(raw,{maxKeys:7}),quantiles=plainArray(d.quantiles,BOUNDED_EXACT_HISTORY_LIMITS.maxQuantiles,'quantiles');if(Object.keys(d).sort().join(',')!=='formulaVersion,id,minimumSupport,population,quantiles,units'||typeof d.id!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(d.id)||ids.has(d.id)||typeof d.formulaVersion!=='string'||d.formulaVersion.length<1||d.formulaVersion.length>160||typeof d.units!=='string'||d.units.length<1||d.units.length>128||typeof d.population!=='string'||d.population.length<1||d.population.length>160||!Number.isSafeInteger(d.minimumSupport)||d.minimumSupport<1||d.minimumSupport>100000||quantiles.some(q=>!finite(q)||q<0||q>1)||new Set(quantiles).size!==quantiles.length)fail('descriptor');
  ids.add(d.id);return {...d,quantiles};
 }));
}
function scalarKey(value){floatScratch.writeDoubleBE(value===0?0:value);const v=floatScratch.readBigUInt64BE();return v&SIGN?(~v)&MASK:v^SIGN;}
function keyScalar(key){const bits=key&SIGN?key^SIGN:(~key)&MASK;floatScratch.writeBigUInt64BE(bits);return floatScratch.readDoubleBE();}
function rowOf(raw,count,cutoff){
 const row=snapshotPlainRecord(raw,{maxKeys:3});if(Object.keys(row).sort().join(',')!=='knownAt,matchId,values'||!id(row.matchId)||instantNs(row.knownAt)===null||instantNs(row.knownAt)>cutoff)fail('row');
 const values=plainArray(row.values,count,'scalar');if(values.length!==count||values.some(v=>v!==null&&!finite(v)))fail('scalar');
 return {matchId:row.matchId,knownAt:row.knownAt,values};
}
async function readBatch(store,ref,index,descriptors,cutoff,shouldContinue){
 await proceed(shouldContinue);if(!ref||Object.keys(ref).sort().join(',')!=='bytes,kind,sha256'||ref.kind!==KIND||!hash(ref.sha256)||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>BOUNDED_EXACT_HISTORY_LIMITS.maxBatchBytes)fail('batch_ref');
 const utf8=await store.read(ref);if(typeof utf8!=='string'||bytes(utf8)!==ref.bytes||sha(utf8)!==ref.sha256)fail('batch_integrity');
 let b;try{b=JSON.parse(utf8);}catch{fail('batch_json');}if(b?.contract!==BATCH||b.index!==index||!Array.isArray(b.rows)||b.rows.length<1||b.rows.length>BOUNDED_EXACT_HISTORY_LIMITS.maxBatchRows)fail('batch');
 return b.rows.map(r=>rowOf(r,descriptors.length,cutoff));
}
async function derive(store,refs,descriptors,historyCutoffAt,shouldContinue){
 const cutoff=instantNs(historyCutoffAt);if(cutoff===null||cutoff<=0n||!Array.isArray(refs)||refs.length>BOUNDED_EXACT_HISTORY_LIMITS.maxBatches)fail('cutoff_or_batches');
 const state=descriptors.map(()=>({count:0,sum:0,minimum:null,maximum:null,latestKnownAt:null}));let rowCount=0,totalBytes=0,previous=null;
 async function scan(visit){for(let i=0;i<refs.length;i++){const batch=await readBatch(store,refs[i],i,descriptors,cutoff,shouldContinue);for(const row of batch)visit(row);}}
 for(const ref of refs){if(!Number.isSafeInteger(ref?.bytes)||(totalBytes+=ref.bytes)>BOUNDED_EXACT_HISTORY_LIMITS.maxScalarBytes)fail('scalar_byte_bound');}
 await scan(row=>{
  if(++rowCount>BOUNDED_EXACT_HISTORY_LIMITS.maxRows||previous!==null&&numericHistoryMapIdCompare(previous,row.matchId)>=0)fail('numeric_map_order_or_duplicate');previous=row.matchId;
  row.values.forEach((v,i)=>{if(v===null)return;const s=state[i];s.count++;s.sum+=v;s.minimum=s.minimum===null?v:Math.min(s.minimum,v);s.maximum=s.maximum===null?v:Math.max(s.maximum,v);if(s.latestKnownAt===null||instantNs(row.knownAt)>instantNs(s.latestKnownAt))s.latestKnownAt=row.knownAt;});
 });
 const means=state.map(s=>s.count?s.sum/s.count:null),squared=state.map(()=>0);
 await scan(row=>row.values.forEach((v,i)=>{if(v!==null)squared[i]+=(v-means[i])**2;}));
 const ranks=state.map((s,i)=>{const unique=new Map();if(s.count)for(const q of descriptors[i].quantiles){const index=(s.count-1)*q;for(const rank of [Math.floor(index),Math.ceil(index)])if(!unique.has(rank))unique.set(rank,{rank,remainder:rank,prefix:0n});}return [...unique.values()];});
 for(let depth=0;depth<8&&ranks.some(xs=>xs.length);depth++){
  const shift=BigInt(56-depth*8),prefixShift=BigInt(64-depth*8),histograms=ranks.map(xs=>new Map(xs.map(x=>[x.prefix,new Uint32Array(256)])));
  await scan(row=>row.values.forEach((v,i)=>{if(v===null)return;const key=scalarKey(v),prefix=depth===0?0n:key>>prefixShift,counts=histograms[i].get(prefix);if(counts)counts[Number((key>>shift)&255n)]++;}));
  ranks.forEach((xs,i)=>xs.forEach(item=>{const counts=histograms[i].get(item.prefix);let selected=-1;for(let bucket=0;bucket<256;bucket++){if(item.remainder<counts[bucket]){selected=bucket;break;}item.remainder-=counts[bucket];}if(selected<0)fail('quantile_rank');item.prefix=(item.prefix<<8n)|BigInt(selected);}));
 }
 const statistics=state.map((s,i)=>{
  const sortedValues=new Map(ranks[i].map(r=>[r.rank,keyScalar(r.prefix)])),quantiles=Object.fromEntries(descriptors[i].quantiles.map(q=>{if(!s.count)return[String(q),null];const index=(s.count-1)*q,lo=Math.floor(index),hi=Math.ceil(index),a=sortedValues.get(lo),b=sortedValues.get(hi);return[String(q),a+(b-a)*(index-lo)];})),sampleSd=s.count<2?null:Math.sqrt(squared[i]/(s.count-1)),admitted=s.count>=descriptors[i].minimumSupport;
  const safe=v=>admitted&&finite(v)?v:null;
  return {descriptorId:descriptors[i].id,supportMaps:s.count,minimumSupport:descriptors[i].minimumSupport,reason:admitted?null:'below_minimum_support',latestHistoryAvailabilityAt:s.latestKnownAt,mean:safe(means[i]),sampleSd:safe(sampleSd),minimum:safe(s.minimum),maximum:safe(s.maximum),quantiles:Object.fromEntries(Object.entries(quantiles).map(([q,v])=>[q,safe(v)]))};
 });
 return freeze({rowCount,totalScalarBytes:totalBytes,statistics});
}
function bodyOf(descriptors,historyCutoffAt,batches,result){return {contract:BOUNDED_EXACT_HISTORY_STATISTICS_CONTRACT,historyCutoffAt,descriptorSha256:pinRetainedHistoryJson(descriptors).pin.sha256,descriptors,batches,...result,arithmetic:{dtype:'float64',order:'strict_numeric_map_id_ascending',mean:'sum(values)/n; left-to-right numeric map-id order',sampleSd:'sqrt(sum((value-mean)^2)/(n-1)); second pass in the same order',quantile:'exact numeric order-statistic radix selection; a[lo]+(a[hi]-a[lo])*fraction at index(n-1)*q',missingness:'null values excluded from their own descriptor support; no zero imputation',support:'one row per distinct map; all descriptors share the original scalar batch rows'},sourceAuthentication:false,completeRelationalProducerBridge:false,...flags};}
function mint(body,reference){const handle=Object.freeze({contract:BOUNDED_EXACT_HISTORY_STATISTICS_CONTRACT+'.handle'});handles.set(handle,freeze({reference,...body}));return handle;}
/** Caller supplies descriptor batches, so all required descriptors can run in
 * bounded groups without being pruned. Metadata is not a historical source proof.
 */
export async function createBoundedExactHistoryStatistics({artifactStore,records,descriptors,historyCutoffAt,shouldContinue=()=>true}={}){
 const store=port(artifactStore),ownedDescriptors=descriptorsOf(descriptors),cutoff=instantNs(historyCutoffAt);if(cutoff===null||cutoff<=0n||!records||typeof records[Symbol.iterator]!=='function'&&typeof records[Symbol.asyncIterator]!=='function')fail('input');
 const refs=[];let rows=[],scalarBytes=0,rowCount=0,previous=null;
 async function flush(){if(!rows.length)return;if(refs.length>=BOUNDED_EXACT_HISTORY_LIMITS.maxBatches)fail('batch_count');await proceed(shouldContinue);const utf8=JSON.stringify({contract:BATCH,index:refs.length,rows});if(bytes(utf8)>BOUNDED_EXACT_HISTORY_LIMITS.maxBatchBytes||(scalarBytes+=bytes(utf8))>BOUNDED_EXACT_HISTORY_LIMITS.maxScalarBytes)fail('scalar_byte_bound');const expected={kind:KIND,sha256:sha(utf8),bytes:bytes(utf8)},ref=await store.commit({kind:KIND,utf8,expectedSha256:expected.sha256});if(JSON.stringify(ref)!==JSON.stringify(expected))fail('writer_ref');refs.push(freeze({...ref}));rows=[];}
 for await(const raw of records){await proceed(shouldContinue);const row=rowOf(raw,ownedDescriptors.length,cutoff);if(++rowCount>BOUNDED_EXACT_HISTORY_LIMITS.maxRows||previous!==null&&numericHistoryMapIdCompare(previous,row.matchId)>=0)fail('numeric_map_order_or_duplicate');previous=row.matchId;rows.push(row);if(rows.length>=BOUNDED_EXACT_HISTORY_LIMITS.maxBatchRows)await flush();}
 await flush();const result=await derive(store,refs,ownedDescriptors,historyCutoffAt,shouldContinue),body=bodyOf(ownedDescriptors,historyCutoffAt,refs,result),utf8=JSON.stringify(body);if(bytes(utf8)>BOUNDED_EXACT_HISTORY_LIMITS.maxManifestBytes)fail('manifest_bound');await proceed(shouldContinue);const reference=await store.commit({kind:MANIFEST,utf8,expectedSha256:sha(utf8)});if(reference.kind!==MANIFEST||reference.bytes!==bytes(utf8)||reference.sha256!==sha(utf8))fail('writer_ref');return Object.freeze({handle:mint(body,freeze({...reference})),reference:freeze({...reference}),descriptor:body,...flags});
}
export async function restoreBoundedExactHistoryStatistics({artifactStore,reference,shouldContinue=()=>true}={}){
 const store=port(artifactStore);await proceed(shouldContinue);if(reference?.kind!==MANIFEST||!hash(reference.sha256)||!Number.isSafeInteger(reference.bytes)||reference.bytes<1||reference.bytes>BOUNDED_EXACT_HISTORY_LIMITS.maxManifestBytes)fail('manifest_ref');const utf8=await store.read(reference);if(typeof utf8!=='string'||bytes(utf8)!==reference.bytes||sha(utf8)!==reference.sha256)fail('manifest_integrity');let original;try{original=JSON.parse(utf8);}catch{fail('manifest_json');}
 const descriptors=descriptorsOf(original.descriptors),result=await derive(store,original.batches,descriptors,original.historyCutoffAt,shouldContinue),body=bodyOf(descriptors,original.historyCutoffAt,original.batches,result);if(JSON.stringify(body)!==utf8)fail('not_rederived');return Object.freeze({handle:mint(body,freeze({...reference})),reference:freeze({...reference}),descriptor:body,...flags});
}
export function readBoundedExactHistoryStatistics(handle,{expectedReductionSha256,expectedDescriptorSha256,historyCutoffAt}={}){const body=handles.get(handle);if(!body)fail('owned_handle_required');if(expectedReductionSha256!==body.reference.sha256||expectedDescriptorSha256!==body.descriptorSha256||instantNs(historyCutoffAt)!==instantNs(body.historyCutoffAt))fail('binding');return body;}
