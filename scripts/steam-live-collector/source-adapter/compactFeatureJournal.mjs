/** Explicit opt-in v2 diagnostic persistence. The caller owns the persistent
 * writer/lease and the shared arena. Importing this module opens nothing.
 * Existing v1 compiler/journal/reader and runtime defaults remain unchanged. */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {snapshotPlainRecord,measureBoundedJsonBytes} from './diagnosticResourceArena.mjs';
import {PERSISTENT_ARTIFACT_WRITER_CONTRACT} from './persistentArtifactWriter.mjs';
import {retainVerifiedProjectionSchema,retainVerifiedProjectionVector} from './featureProjectionCompiler.mjs';
import {COMPACT_HISTORICAL_INPUT_STORE_CONTRACT,readCompactHistoricalInputProof} from './compactHistoricalInputStore.mjs';
import {createCompactFeatureSchema,createCompactFeatureVector,retainCompactFeatureAsset,releaseCompactFeatureAsset,describeCompactFeatureAsset,readCompactSchemaPage,readCompactVectorPage,writeCompactFeatureAssetChunks,loadCompactFeatureAsset} from './compactFeatureAssets.mjs';

export const COMPACT_FEATURE_JOURNAL_CONTRACT='aegis.compact-diagnostic-feature-journal.v2';
const TRACE='aegis.compact-diagnostic-feature-trace.v2',PRODUCER='aegis.unified-diagnostic-feature-producer.v2';
const SCHEMA='compact-feature-schema-v2',VECTOR='compact-feature-vector-v2',TRACE_KIND='compact-feature-trace-v2';
const SHA=/^[a-f0-9]{64}$/,MAX_OBJECT=16*1024*1024,MAX_WIRE=64*1024*1024,CHUNK_BYTES=1024*1024,ASSET_MANIFEST='aegis.compact-feature-wire-manifest.v3',LEGACY_ASSET_MANIFEST='aegis.compact-feature-wire-manifest.v2',CHUNK_KIND='compact-feature-wire-chunk-v2';
const TARGETS=new Set(['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','POST_MAP_WIN','POST_KILLS','POST_DURATION','LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_PRE','SERIES_BETWEEN','SERIES_LIVE']);
const FLAGS=Object.freeze({eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false});
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=x=>{throw Error('compact_feature_journal:'+x);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function record(value,maxKeys=64){return snapshotPlainRecord(value,{maxKeys});}
function data(value,key,fallback=null){const item=record(value);return Object.hasOwn(item,key)?item[key]:fallback;}
const key=ref=>ref.kind+':'+ref.sha256;
function* alignedWireChunks(buffer){
 // Canonical wire field boundaries align shared dictionaries/vectors even when
 // target headers have different byte lengths. All concatenated bytes stay exact.
 let begin=0,depth=0,quoted=false,escaped=false,fields=0;
 function* segment(end){while(begin<end){let stop=Math.min(end,begin+CHUNK_BYTES);while(stop<end&&(buffer[stop]&0xc0)===0x80)stop--;if(stop===begin)fail('chunk_codepoint');yield buffer.subarray(begin,stop).toString('utf8');begin=stop;}}
 for(let i=0;i<buffer.length;i++){
  const c=buffer[i];if(quoted){if(escaped)escaped=false;else if(c===92)escaped=true;else if(c===34)quoted=false;continue;}
  if(c===34)quoted=true;else if(c===123||c===91)depth++;else if(c===125||c===93)depth--;else if(c===44&&depth===1){if(++fields>32)fail('wire_field_bound');yield*segment(i+1);}
 }if(quoted||depth!==0)fail('wire_shape');yield*segment(buffer.length);
}
function reference(value,expectedKind,maxBytes){
 const r=record(value,3);if(Object.keys(r).sort().join(',')!=='bytes,kind,sha256'||r.kind!==expectedKind||!SHA.test(r.sha256??'')||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>maxBytes)fail('artifact_reference');return Object.freeze(r);
}
function projectedReference(value){
 const r=record(value,3);if(Object.keys(r).sort().join(',')!=='featureCount,namesSha256,sha256'||!SHA.test(r.sha256??'')||!SHA.test(r.namesSha256??'')||!Number.isSafeInteger(r.featureCount)||r.featureCount<0||r.featureCount>150000)fail('projection_reference');return Object.freeze(r);
}
function flags(value){if(value.eligibleForTraining!==false||value.eligibleForServing!==false||value.recordedPrediction!==false)fail('diagnostic_only');}
function modeBinding(mode,route){
 const sets={PRE:['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','SERIES_PRE'],POST:['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE'],LIVE:['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE'],BETWEEN:['SERIES_BETWEEN'],SERIES_PRE:['SERIES_PRE']};
 const expected=route.targetId==='SERIES_LIVE'?(mode==='LIVE'?'observed_live':'observed_postdraft'):route.targetId.startsWith('SERIES_')?route.targetId:mode;
 if(!sets[mode]?.includes(route.targetId)||route.stateMode!==expected)fail('target_phase_binding');
}
function headerTimes(body){
 const decision=instantNs(body.decisionAt);if(decision===null)fail('decision_time');
 for(const k of ['featureInputCutoffAt','availableAt','historyCutoffAt'])if(body[k]!==null&&body[k]!==undefined){const t=instantNs(body[k]);if(t===null||t>decision)fail('input_time_after_decision');}
}
function metadata(bundle){
 const fields=['matchId','seriesId','decisionAt','featureInputCutoffAt','availableAt','mode','timings','historyCutoffAt','historyContextHash','sourceSnapshotHash','semanticEvidence','targetBinding','sourceAdmission','inputSourceBindings','draftObservation','liveRejection','reconstruction','historicalBindings','historicalInputRef'];
 const body={contract:TRACE,producerContract:bundle.contract};for(const field of fields)body[field]=Object.hasOwn(bundle,field)?bundle[field]:null;
 body.featureInputCutoffAt??=body.decisionAt;const components=record(bundle.components??{},8),native=components.legacyNative?record(components.legacyNative):{},series=components.series?record(components.series):{};
 Object.assign(body,{nativeObservationId:native.observationId??null,nativeRawSha256:native.rawSha256??null,nativeKnownAt:native.knownAt??null,nativeGameClock:native.eventClockSeconds??null,seriesReceiptPin:series.sourcePin??null},FLAGS);return body;
}
/** Same expanded vector hash as v1 trace canonical({namesHash,values,missing}),
 * streamed from private Float64 storage without materializing a full vector. */
function expandedVectorHash(handle){
 const descriptor=describeCompactFeatureAsset(handle),hash=createHash('sha256');
 for(const [field,opening]of [['missing','{"missing":['],['values','],"namesHash":'+JSON.stringify(descriptor.namesHash)+',"values":[']]){
  hash.update(opening);let first=true;
  for(let offset=0;offset<descriptor.featureCount;offset+=200){const page=readCompactVectorPage(handle,{offset,limit:200});if(!page)fail('page_memory_reservation');try{for(const value of page[field]){if(!first)hash.update(',');first=false;hash.update(JSON.stringify(value));}}finally{page.release();}}
 }hash.update(']}');return hash.digest('hex');
}

export function createCompactFeatureJournal({writer,resourceArena,historicalInputStore=null,allowLegacyByteOnlyStaticHistory=false,assetWorkingBytes=512*1024*1024,operationWorkingBytes=128*1024*1024,maxWireBytes=MAX_WIRE,maxMetadataBytes=256*1024,maxCachedAssets=16,maxCachedAssetBytes=256*1024*1024}={}){
 if(writer?.contract!==PERSISTENT_ARTIFACT_WRITER_CONTRACT||typeof writer.commit!=='function'||typeof writer.read!=='function'||typeof resourceArena?.reserve!=='function'||typeof resourceArena?.status!=='function')fail('explicit_writer_and_arena');
 for(const [name,value,min,max]of [['asset_working',assetWorkingBytes,1024,2*1024**3],['operation_working',operationWorkingBytes,1024,2*1024**3],['wire_bound',maxWireBytes,1024,MAX_WIRE],['metadata_bound',maxMetadataBytes,1024,1024*1024],['cached_assets',maxCachedAssets,1,128],['cache_bytes',maxCachedAssetBytes,1024,1024**3]])if(!Number.isSafeInteger(value)||value<min||value>max)fail(name);
 if(maxMetadataBytes*8+65536>operationWorkingBytes)fail('metadata_working_bound');
 if(historicalInputStore!==null&&(historicalInputStore.contract!==COMPACT_HISTORICAL_INPUT_STORE_CONTRACT||typeof historicalInputStore.verifyHistoricalInputs!=='function'))fail('historical_input_store');
 if(typeof allowLegacyByteOnlyStaticHistory!=='boolean')fail('legacy_static_history_option');
 const arena=resourceArena,cache=new Map(),ownedSchemaArtifacts=new WeakMap();let cacheBytes=0,pending=0,closed=false,closing=false,active=Promise.resolve();
 const counters={appendedTraces:0,loadedTraces:0,assetCacheHits:0,assetLoads:0,assetWrites:0,cacheEvictions:0,verifiedSchemaReuses:0};
 function evict(cacheKey){const entry=cache.get(cacheKey);if(entry){cache.delete(cacheKey);cacheBytes-=entry.bytes;releaseCompactFeatureAsset(entry.handle);counters.cacheEvictions++;}}
 function clearCache(){for(const k of [...cache.keys()])evict(k);}
 function remember(ref,handle){
  const k=key(ref),descriptor=describeCompactFeatureAsset(handle),bytes=descriptor.chargedBytes+descriptor.dependencyChargedBytes;if(cache.has(k)){const old=cache.get(k);if(old.ref.bytes!==ref.bytes||old.schemaHash!==descriptor.expandedSchemaHash)fail('cache_identity_conflict');cache.delete(k);cache.set(k,old);return;}
  if(bytes>maxCachedAssetBytes)return;while(cache.size>=maxCachedAssets||cacheBytes+bytes>maxCachedAssetBytes)evict(cache.keys().next().value);
  const own=retainCompactFeatureAsset(handle);if(!own)return;cache.set(k,{ref,handle:own,bytes,schemaHash:descriptor.expandedSchemaHash});cacheBytes+=bytes;
 }
 function cached(ref,schemaHash){const k=key(ref),entry=cache.get(k);if(!entry)return null;if(entry.ref.bytes!==ref.bytes||entry.schemaHash!==schemaHash)fail('cache_identity_conflict');const held=retainCompactFeatureAsset(entry.handle);if(!held)fail('asset_memory_reservation');cache.delete(k);cache.set(k,entry);counters.assetCacheHits++;return held;}
 function operation(action){
  if(closed||closing)return Promise.reject(Error('compact_feature_journal:closed'));if(pending!==0)return Promise.reject(Error('compact_feature_journal:pending_limit'));
  const lease=arena.reserve(operationWorkingBytes);if(!lease)return Promise.reject(Error('compact_feature_journal:operation_memory_reservation'));pending++;
  const result=Promise.resolve().then(action).finally(()=>{pending--;lease.release();});active=result.catch(()=>{});return result;
 }
 function checkSchema(handle,route){
  const d=describeCompactFeatureAsset(handle),page=readCompactSchemaPage(handle,{limit:1});if(!page)fail('page_memory_reservation');
  try{if(d.expandedSchemaHash!==route.schemaRef.sha256||d.namesHash!==route.schemaRef.namesSha256||d.featureCount!==route.featureCount||page.header.targetId!==route.targetId||page.header.stateMode!==route.stateMode)fail('schema_route_binding');}finally{page.release();}
 }
 async function verifyHistorical(body){
  if(body.historicalInputRef===null||body.historicalInputRef===undefined)return null;
  if(historicalInputStore===null)fail('historical_input_bridge_required');
  const staticMode=['PRE','SERIES_PRE','BETWEEN'].includes(body.mode),strictStatic=staticMode&&!allowLegacyByteOnlyStaticHistory;
  if(strictStatic&&body.historicalBindings?.kind!==(body.mode==='PRE'?'map_prematch':'series_history'))fail('historical_target_kind');
  const options={mode:body.mode,historicalBindings:body.historicalBindings,seriesReceiptPin:body.seriesReceiptPin,decisionAt:body.decisionAt,...(strictStatic?{requireParsedTargetBinding:true,targetBinding:body.targetBinding,matchId:body.matchId,seriesId:body.seriesId}:{})};
  const held=await historicalInputStore.verifyHistoricalInputs(body.historicalInputRef,options);
  try{const descriptor=readCompactHistoricalInputProof(held.proof,{reference:body.historicalInputRef,...options});return{minimumSupport:descriptor.calculationOptions.minimumSupport,release:()=>held.release()};}catch(error){held?.release?.();throw error;}
 }
 function checkHistoricalSupport(handle,historical){
  if(!historical)return;const size=describeCompactFeatureAsset(handle).featureCount;
  for(let offset=0;offset<size;offset+=200){const page=readCompactSchemaPage(handle,{offset,limit:200});if(!page)fail('page_memory_reservation');try{for(const d of page.definitions)if(d.minimumSupport!==undefined&&d.minimumSupport!==historical.minimumSupport)fail('historical_support_policy');}finally{page.release();}}
 }
 async function commitExact(kind,utf8,maximum){
  const expectedSha256=sha(utf8),bytes=Buffer.byteLength(utf8);if(bytes>maximum)fail('commit_bytes_bound');
  const ref=reference(await writer.commit({kind,utf8,expectedSha256}),kind,maximum);if(ref.sha256!==expectedSha256||ref.bytes!==bytes)fail('writer_receipt_mismatch');return ref;
 }
 async function persistAsset(handle,kind){
  // The codec emits synchronously, so its bounded complete encoded text stays
  // reserved here. Persist bounded UTF8 chunks and publish their manifest LAST;
  // no individual artifact exceeds the existing writer's unchanged16MiB limit.
  const wireBound=Math.min(maxWireBytes,describeCompactFeatureAsset(handle).wireBytes);
  if(!Number.isSafeInteger(wireBound)||wireBound<1)fail('asset_wire_bound');
  const lease=arena.reserve(wireBound*10+65536);if(!lease)fail('sink_memory_reservation');let chunks=[],utf8=null,total=0;
  try{const receipt=writeCompactFeatureAssetChunks(handle,chunk=>{const n=Buffer.byteLength(chunk);if(n>wireBound-total)fail('compact_object_bound_unsupported');total+=n;chunks.push(chunk);},{workingBytes:16*1024*1024});if(!receipt)fail('encoding_memory_reservation');
   utf8=chunks.join('');chunks=null;if(total!==receipt.bytes)fail('encoding_length');const refs=[];
   // Buffer conversion stays inside the existing maxWireBytes*10 scratch lease.
   // Full-size UTF8 chunks and field alignment improve IO/deduplication without
   // changing logical bytes, content hashes or individual object ceilings.
   const buffer=Buffer.from(utf8,'utf8');for(const text of alignedWireChunks(buffer))refs.push(await commitExact(CHUNK_KIND,text,CHUNK_BYTES));
   const manifest=JSON.stringify({contract:ASSET_MANIFEST,kind,wireSha256:receipt.sha256,wireBytes:receipt.bytes,chunks:refs});if(Buffer.byteLength(manifest)>maxMetadataBytes)fail('asset_manifest_bound');
   const ref=await commitExact(kind,manifest,maxMetadataBytes);counters.assetWrites++;return ref;
  }finally{chunks=null;utf8=null;lease.release();}
 }
 async function readAssetWire(ref){
  const text=await writer.read(ref);if(Buffer.byteLength(text)!==ref.bytes||sha(text)!==ref.sha256)fail('artifact_integrity');const body=JSON.parse(text);
  const maximumChunks=body.contract===ASSET_MANIFEST?Math.ceil(maxWireBytes/CHUNK_BYTES)+33:Math.ceil(maxWireBytes/Math.floor(CHUNK_BYTES/3))+1;
  if(Object.keys(body).sort().join(',')!=='chunks,contract,kind,wireBytes,wireSha256'||![ASSET_MANIFEST,LEGACY_ASSET_MANIFEST].includes(body.contract)||body.kind!==ref.kind||!SHA.test(body.wireSha256??'')||!Number.isSafeInteger(body.wireBytes)||body.wireBytes<1||body.wireBytes>maxWireBytes||!Array.isArray(body.chunks)||body.chunks.length<1||body.chunks.length>maximumChunks)fail('asset_manifest');
  let lease=arena.reserve(body.wireBytes*10+65536);if(!lease)fail('source_wire_memory_reservation');let chunks=[],total=0;
  const declared=writer.readBatchLimits,batchReferences=Number.isSafeInteger(declared?.maxReferences)&&declared.maxReferences>0?Math.min(64,declared.maxReferences):1,batchMaximum=Number.isSafeInteger(declared?.maxBytes)&&declared.maxBytes>0?Math.min(MAX_OBJECT,declared.maxBytes):CHUNK_BYTES;
  try{for(let at=0;at<body.chunks.length;){const batch=[];let batchBytes=0;while(at<body.chunks.length&&batch.length<batchReferences){const chunk=reference(body.chunks[at],CHUNK_KIND,CHUNK_BYTES);if(batch.length&&batchBytes+chunk.bytes>batchMaximum)break;batch.push(chunk);batchBytes+=chunk.bytes;at++;}
   const values=typeof writer.readMany==='function'&&batchBytes<=batchMaximum?await writer.readMany(batch):await(async()=>{const out=[];for(const ref of batch)out.push(await writer.read(ref));return out;})();
   if(!Array.isArray(values)||values.length!==batch.length)fail('writer_batch_mismatch');for(let i=0;i<batch.length;i++){const value=values[i],chunk=batch[i];if(typeof value!=='string')fail('writer_batch_mismatch');const n=Buffer.byteLength(value);if(n!==chunk.bytes||sha(value)!==chunk.sha256||n>body.wireBytes-total)fail('asset_chunk_integrity');total+=n;chunks.push(value);}
  }
   const utf8=chunks.join('');chunks=null;if(total!==body.wireBytes||sha(utf8)!==body.wireSha256)fail('asset_wire_integrity');
   // Coalescing scratch is no longer owned. Replace its maximum-work reservation
   // synchronously with the measured retained UTF8/UTF16 text allowance before
   // a separately reserved decode starts. No await/user callback in this transfer.
   lease.release();lease=arena.reserve(total*4+65536);if(!lease)fail('retained_wire_memory_reservation');return{utf8,bytes:total,sha256:body.wireSha256,release:()=>lease.release()};
  }catch(error){lease?.release();throw error;}
 }
 async function asset(ref,schemaHash,schemaHandle=null){
  // A cache hit still verifies the current committed immutable bytes through
  // the writer; disk tampering cannot hide behind a parsed-handle cache.
  const wire=await readAssetWire(ref);try{const held=cached(ref,schemaHash);if(held)return held;
   // The decoder independently checks its exact structural working requirement
   // before expansion. Reserve a measured-wire candidate budget under the same
   // existing ceiling, instead of charging the maximum512MiB for every asset.
   const decodeWorking=Math.min(assetWorkingBytes,Math.max(64*1024*1024,wire.bytes*8+8*1024*1024));
   const handle=loadCompactFeatureAsset({utf8:wire.utf8,bytes:wire.bytes,sha256:wire.sha256},{arena,expectedSchemaHash:schemaHash,expectedArtifactSha256:wire.sha256,schemaHandle,workingBytes:decodeWorking,maxWireBytes});if(!handle)fail('asset_memory_reservation');
   counters.assetLoads++;try{remember(ref,handle);return handle;}catch(error){releaseCompactFeatureAsset(handle);throw error;}
  }finally{wire.release();}
 }
 function prepare(bundle){
  bundle=record(bundle);flags(bundle);if(bundle.contract!==PRODUCER||!['PRE','POST','LIVE','BETWEEN','SERIES_PRE'].includes(bundle.mode)||!Array.isArray(bundle.routes)||bundle.routes.length>12)fail('producer_bundle');
  const header=metadata(bundle);headerTimes(header);measureBoundedJsonBytes(header,{maxBytes:maxMetadataBytes,maxNodes:65536});const body=structuredClone(header),prepared=[],seen=new Set();
  try{for(let i=0;i<bundle.routes.length;i++){
   const slot=Object.getOwnPropertyDescriptor(bundle.routes,String(i));if(!slot||!('value'in slot))fail('route_data_property');const r=record(slot.value,24);if(!TARGETS.has(r.targetId)||seen.has(r.targetId)||typeof r.stateMode!=='string'||r.eligibleForTraining!==false||r.eligibleForServing!==false)fail('route_target_or_flags');modeBinding(bundle.mode,r);seen.add(r.targetId);
   const schemaRef=projectedReference(r.schemaRef);
   // Retain actual compiler-owned schemas AND rows before the first await. This
   // permits one-at-a-time compact factoring without trusting mutable caller
   // arrays or losing arena ownership when the caller releases its bundle.
   const schemaOwner=retainVerifiedProjectionSchema(r.diagnosticSchema,{expectedSchemaHash:schemaRef.sha256}),vectorOwner=retainVerifiedProjectionVector(r.diagnosticVector,{expectedNamesHash:schemaRef.namesSha256,featureCount:schemaRef.featureCount});
   if(schemaOwner&&vectorOwner){prepared.push({targetId:r.targetId,stateMode:r.stateMode,schemaRef,featureCount:schemaRef.featureCount,schema:null,vector:null,originalSchema:schemaOwner.schema,originalVector:vectorOwner.vector,schemaOwner,vectorOwner,deferred:true,reusedSchemaArtifact:null});continue;}
   schemaOwner?.release();vectorOwner?.release();let schema=null,reusedSchemaArtifact=null;
   const authority=retainVerifiedProjectionSchema(r.diagnosticSchema,{expectedSchemaHash:schemaRef.sha256});
   try{const ref=authority?ownedSchemaArtifacts.get(r.diagnosticSchema):null;if(ref){schema=cached(ref,schemaRef.sha256);if(schema){reusedSchemaArtifact=ref;counters.verifiedSchemaReuses++;}}}finally{authority?.release();}
   schema??=createCompactFeatureSchema(r.diagnosticSchema,{arena,expectedSchemaHash:schemaRef.sha256,workingBytes:assetWorkingBytes,maxWireBytes});if(!schema)fail('schema_memory_reservation');
   const route={targetId:r.targetId,stateMode:r.stateMode,schemaRef,featureCount:schemaRef.featureCount,schema,vector:null,reusedSchemaArtifact,originalSchema:r.diagnosticSchema};prepared.push(route);checkSchema(schema,route);
   const vector=record(r.diagnosticVector,3);route.vector=createCompactFeatureVector({schemaHandle:schema,names:vector.names,values:vector.values,missing:vector.missing},{arena,workingBytes:assetWorkingBytes,maxWireBytes});if(!route.vector)fail('vector_memory_reservation');route.expandedVectorHash=expandedVectorHash(route.vector);
  }return{body,prepared};}catch(error){for(const r of prepared){if(r.vector)releaseCompactFeatureAsset(r.vector);if(r.schema)releaseCompactFeatureAsset(r.schema);r.schemaOwner?.release();r.vectorOwner?.release();}throw error;}
 }
 function materializeRoute(r){
  if(!r.deferred)return;
  const ref=ownedSchemaArtifacts.get(r.originalSchema);if(ref){r.schema=cached(ref,r.schemaRef.sha256);if(r.schema){r.reusedSchemaArtifact=ref;counters.verifiedSchemaReuses++;}}
  r.schema??=createCompactFeatureSchema(r.originalSchema,{arena,expectedSchemaHash:r.schemaRef.sha256,workingBytes:assetWorkingBytes,maxWireBytes});if(!r.schema)fail('schema_memory_reservation');checkSchema(r.schema,r);
  r.vector=createCompactFeatureVector({schemaHandle:r.schema,names:r.originalVector.names,values:r.originalVector.values,missing:r.originalVector.missing},{arena,workingBytes:assetWorkingBytes,maxWireBytes});if(!r.vector)fail('vector_memory_reservation');r.expandedVectorHash=expandedVectorHash(r.vector);
 }
 function parsedTrace(body){
  if(body.contract!==TRACE||body.producerContract!==PRODUCER||!['PRE','POST','LIVE','BETWEEN','SERIES_PRE'].includes(body.mode)||!Array.isArray(body.routes)||body.routes.length>12)fail('trace_contract');flags(body);headerTimes(body);const seen=new Set();
  for(let i=0;i<body.routes.length;i++){const r=body.routes[i];if(!TARGETS.has(r.targetId)||seen.has(r.targetId)||typeof r.stateMode!=='string'||!SHA.test(r.expandedVectorHash??''))fail('trace_route');modeBinding(body.mode,r);seen.add(r.targetId);r.schemaRef=projectedReference(r.schemaRef);if(r.featureCount!==r.schemaRef.featureCount)fail('trace_feature_count');r.schemaArtifact=reference(r.schemaArtifact,SCHEMA,maxMetadataBytes);r.vectorArtifact=reference(r.vectorArtifact,VECTOR,maxMetadataBytes);}return body;
 }
 return Object.freeze({contract:COMPACT_FEATURE_JOURNAL_CONTRACT,
  appendBundle(bundle){return operation(async()=>{
   const {body,prepared}=prepare(bundle);let historical=null;try{historical=await verifyHistorical(body);const routes=[];for(const r of prepared){materializeRoute(r);checkHistoricalSupport(r.schema,historical);let schemaArtifact=r.reusedSchemaArtifact;
    if(schemaArtifact){const wire=await readAssetWire(schemaArtifact);wire.release();}else schemaArtifact=await persistAsset(r.schema,SCHEMA);
    remember(schemaArtifact,r.schema);const authority=retainVerifiedProjectionSchema(r.originalSchema,{expectedSchemaHash:r.schemaRef.sha256});try{if(authority)ownedSchemaArtifacts.set(r.originalSchema,schemaArtifact);}finally{authority?.release();}
    const vectorArtifact=await persistAsset(r.vector,VECTOR);remember(vectorArtifact,r.vector);routes.push({targetId:r.targetId,stateMode:r.stateMode,schemaRef:r.schemaRef,featureCount:r.featureCount,expandedVectorHash:r.expandedVectorHash,schemaArtifact,vectorArtifact});
    if(r.deferred){releaseCompactFeatureAsset(r.vector);releaseCompactFeatureAsset(r.schema);r.vector=null;r.schema=null;}}
    body.routes=routes;measureBoundedJsonBytes(body,{maxBytes:maxMetadataBytes,maxNodes:65536});const utf8=JSON.stringify(body),ref=await commitExact(TRACE_KIND,utf8,maxMetadataBytes);counters.appendedTraces++;return freeze({contract:COMPACT_FEATURE_JOURNAL_CONTRACT,reference:ref,routes:structuredClone(routes),...FLAGS});
   }finally{historical?.release();for(const r of prepared){if(r.vector)releaseCompactFeatureAsset(r.vector);if(r.schema)releaseCompactFeatureAsset(r.schema);r.schemaOwner?.release();r.vectorOwner?.release();}}
  });},
  loadTrace(input){return operation(async()=>{
   const ref=reference(input,TRACE_KIND,maxMetadataBytes),utf8=await writer.read(ref);if(Buffer.byteLength(utf8)!==ref.bytes||sha(utf8)!==ref.sha256)fail('trace_integrity');const body=parsedTrace(JSON.parse(utf8));measureBoundedJsonBytes(body,{maxBytes:maxMetadataBytes,maxNodes:65536});
   const ownership=arena.reserve(ref.bytes*8+65536);if(!ownership)fail('trace_memory_reservation');const held=[],byTarget=new Map();let transferred=false,historical=null;
   try{historical=await verifyHistorical(body);for(const route of body.routes){const schema=await asset(route.schemaArtifact,route.schemaRef.sha256);held.push(schema);checkSchema(schema,route);checkHistoricalSupport(schema,historical);const vector=await asset(route.vectorArtifact,route.schemaRef.sha256,schema);held.push(vector);const d=describeCompactFeatureAsset(vector);if(d.featureCount!==route.featureCount||d.namesHash!==route.schemaRef.namesSha256||expandedVectorHash(vector)!==route.expandedVectorHash)fail('vector_route_binding');byTarget.set(route.targetId,{schema,vector});}
    let released=false;freeze(body);const selected=options=>{if(released)fail('released_trace');const q=record(options??{},3),target=byTarget.get(q.targetId);if(!target)fail('trace_target');return{target,offset:q.offset??0,limit:q.limit??200};};
    const result=Object.freeze({contract:COMPACT_FEATURE_JOURNAL_CONTRACT,reference:ref,body,routes:body.routes,
     readSchemaPage(options){const q=selected(options);return readCompactSchemaPage(q.target.schema,{offset:q.offset,limit:q.limit});},
     readVectorPage(options){const q=selected(options);return readCompactVectorPage(q.target.vector,{offset:q.offset,limit:q.limit});},
     release(){if(released)return false;released=true;for(const h of held)releaseCompactFeatureAsset(h);held.length=0;byTarget.clear();ownership.release();return true;}});
    transferred=true;counters.loadedTraces++;return result;
   }finally{historical?.release();if(!transferred){for(const h of held)releaseCompactFeatureAsset(h);ownership.release();}}
  });},
  clearCache,
  cacheStats(){return{...counters,cachedAssets:cache.size,cachedAssetBytes:cacheBytes,maxCachedAssets,maxCachedAssetBytes,pendingOperations:pending,maxPendingOperations:1,closed,resourceArena:arena.status(),accounting:'conservative_explicit_estimates_not_measured_heap'};},
  async close(){if(closed)return;closing=true;await active;clearCache();closed=true;}
 });
}
