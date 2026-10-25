/** Versioned codec capacity. Synthetic codec boundaries, not compiler-valid rich
 * features, provider evidence, measured heap admission, or model-quality tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {hashFeatureAsset} from './featureProjectionOwnership.mjs';
import {LEGACY_FEATURE_CAPACITY_PROFILE as LEGACY,FULL_FEATURE_CAPACITY_PROFILE as FULL} from './featureCapacityProfiles.mjs';
import {createCompactFeatureSchema,createCompactFeatureVector,describeCompactFeatureAsset,releaseCompactFeatureAsset,readCompactSchemaPage,readCompactVectorPage,writeCompactFeatureAssetChunks,loadCompactFeatureAsset} from './compactFeatureAssets.mjs';

const MiB=1024*1024,WORK=16*MiB,SHA=x=>createHash('sha256').update(x).digest('hex');
const arena=()=>createDiagnosticResourceArena({maxBytes:256*MiB});
function schema(definitions,{legacy=false}={}){return legacy?{contract:LEGACY.schemaContract,definitions}:{contract:FULL.schemaContract,capacityProfile:FULL.id,definitions};}
function fixture({legacy=false}={}){
 const expanded=schema([{name:'a',formula:'same exact semantics',coordinate:{signedZero:-0}},{name:'b',formula:'same exact semantics',coordinate:{signedZero:-0}},{name:'c',formula:'same exact semantics',coordinate:{signedZero:-0}}],{legacy});
 return{expanded,hash:hashFeatureAsset(expanded),names:['a','b','c'],values:[0,-0,null],missing:[false,false,true]};
}
function encode(handle){const chunks=[],receipt=writeCompactFeatureAssetChunks(handle,c=>chunks.push(c));assert.ok(receipt);const utf8=chunks.join('');assert.equal(receipt.bytes,Buffer.byteLength(utf8));assert.equal(receipt.sha256,SHA(utf8));return{...receipt,utf8};}
function repin(wire){const utf8=JSON.stringify(wire);return{utf8,bytes:Buffer.byteLength(utf8),sha256:SHA(utf8)};}
function load(receipt,f,owner,extra={}){return loadCompactFeatureAsset(receipt,{arena:owner,expectedSchemaHash:f.hash,expectedArtifactSha256:receipt.sha256,workingBytes:WORK,capacityProfile:FULL.id,...extra});}
function ownSchema(f,owner,extra={}){const handle=createCompactFeatureSchema(f.expanded,{arena:owner,expectedSchemaHash:f.hash,workingBytes:WORK,...extra});assert.ok(handle);return handle;}
function clean(owner,...handles){for(const handle of handles)if(handle)releaseCompactFeatureAsset(handle);assert.equal(owner.status().chargedBytes,0);assert.equal(owner.status().leases,0);}

test('full codec v3 binds schema/profile and roundtrips exact paged semantics and Float64 values',()=>{
 const f=fixture(),owner=arena(),handle=ownSchema(f,owner),descriptor=describeCompactFeatureAsset(handle),vector=createCompactFeatureVector({schemaHandle:handle,names:f.names,values:f.values,missing:f.missing},{arena:owner,workingBytes:WORK});
 let restoredSchema,restoredVector;
 try{
  assert.equal(descriptor.contract,'aegis.compact-feature-schema.v3');assert.equal(descriptor.capacityProfile,FULL.id);assert.equal(descriptor.expandedSchemaHash,f.hash);assert.ok(descriptor.logicalExpandedNodes>0);assert.ok(descriptor.logicalExpandedBytesUpper>0);assert.ok(vector);
  const encodedSchema=encode(handle),encodedVector=encode(vector),wire=JSON.parse(encodedSchema.utf8);
  assert.equal(encodedSchema.capacityProfile,FULL.id);assert.equal(encodedVector.contract,'aegis.compact-feature-vector.v3');assert.equal(wire.capacityProfile,FULL.id);assert.equal(wire.header.contract,FULL.schemaContract);assert.equal(wire.header.capacityProfile,FULL.id);
  restoredSchema=load(encodedSchema,f,owner);assert.ok(restoredSchema);restoredVector=load(encodedVector,f,owner,{schemaHandle:restoredSchema});assert.ok(restoredVector);
  const definitions=readCompactSchemaPage(restoredSchema),values=readCompactVectorPage(restoredVector);
  try{assert.equal(definitions.capacityProfile,FULL.id);assert.deepEqual(definitions.definitions,f.expanded.definitions);assert.equal(hashFeatureAsset({...definitions.header,definitions:definitions.definitions}),f.hash);assert.equal(values.capacityProfile,FULL.id);assert.deepEqual(values.names,f.names);assert.deepEqual(values.values,f.values);assert.deepEqual(values.missing,f.missing);assert.equal(Object.is(values.values[1],-0),true);}finally{definitions?.release();values?.release();}
 }finally{clean(owner,restoredVector,restoredSchema,vector,handle);}
});

test('legacy v2 wire stays unmarked and cannot be reclassified by caller options or relabelled receipts',()=>{
 const legacy=fixture({legacy:true}),current=fixture(),owner=arena(),old=ownSchema(legacy,owner),modern=ownSchema(current,owner);let restored;
 try{
  const oldReceipt=encode(old),newReceipt=encode(modern),oldWire=JSON.parse(oldReceipt.utf8);
  assert.equal(oldReceipt.contract,'aegis.compact-feature-schema.v2');assert.equal(Object.hasOwn(oldReceipt,'capacityProfile'),false);assert.equal(Object.hasOwn(oldWire,'capacityProfile'),false);assert.equal(Object.hasOwn(describeCompactFeatureAsset(old),'logicalExpandedNodes'),false);
  restored=loadCompactFeatureAsset(oldReceipt,{arena:owner,expectedSchemaHash:legacy.hash,expectedArtifactSha256:oldReceipt.sha256,workingBytes:WORK});assert.ok(restored);
  assert.throws(()=>load(oldReceipt,legacy,owner),/wire_contract_or_capacity_profile/);
  assert.throws(()=>loadCompactFeatureAsset(newReceipt,{arena:owner,expectedSchemaHash:current.hash,expectedArtifactSha256:newReceipt.sha256,workingBytes:WORK}),/wire_contract_or_capacity_profile/);
  assert.throws(()=>ownSchema(current,owner,{capacityProfile:LEGACY.id}),/capacity_profile_mismatch/);
  assert.throws(()=>ownSchema(legacy,owner,{capacityProfile:FULL.id}),/capacity_profile_mismatch/);
  for(const changed of [{...oldWire,capacityProfile:FULL.id},{...oldWire,contract:'aegis.compact-feature-schema.v3',capacityProfile:FULL.id}]){
   const receipt=repin(changed);assert.throws(()=>load(receipt,legacy,owner),/wire_contract_or_capacity_profile|schema_wire/);
  }
 }finally{clean(owner,restored,modern,old);}
});

test('full profile/header and vector dependencies reject mismatches without ownership leaks',()=>{
 const f=fixture(),owner=arena(),handle=ownSchema(f,owner),old=ownSchema(fixture({legacy:true}),owner),before=owner.status().chargedBytes;
 try{
  for(const changed of [{...f.expanded,capacityProfile:undefined},{...f.expanded,capacityProfile:'future'},{contract:FULL.schemaContract,definitions:f.expanded.definitions},{contract:LEGACY.schemaContract,capacityProfile:LEGACY.id,definitions:f.expanded.definitions}])assert.throws(()=>createCompactFeatureSchema(changed,{arena:owner,expectedSchemaHash:'a'.repeat(64),workingBytes:WORK}),/schema_contract_or_capacity_profile/);
  assert.throws(()=>createCompactFeatureVector({schemaHandle:handle,names:f.names,values:f.values,missing:f.missing},{arena:owner,workingBytes:WORK,capacityProfile:LEGACY.id}),/capacity_profile_mismatch/);
  assert.throws(()=>createCompactFeatureVector({schemaHandle:JSON.parse(JSON.stringify(handle)),names:f.names,values:f.values,missing:f.missing},{arena:owner,workingBytes:WORK}),/owned_active_handle/);
  const vector=createCompactFeatureVector({schemaHandle:handle,names:f.names,values:f.values,missing:f.missing},{arena:owner,workingBytes:WORK});assert.ok(vector);
  try{const receipt=encode(vector);assert.throws(()=>load(receipt,f,owner,{schemaHandle:old}),/vector_wire/);}finally{releaseCompactFeatureAsset(vector);}
  assert.equal(owner.status().chargedBytes,before);
 }finally{clean(owner,old,handle);}
});

test('all supported codec wire caps are256MiB and cheap configured preflight precedes parsing',()=>{
 const owner=arena();let reads=0;const untouched={};Object.defineProperty(untouched,'contract',{get(){reads++;throw Error('unfunded_visit');}});
 assert.equal(FULL.maxEncodedBytes,256*MiB);assert.equal(LEGACY.maxEncodedBytes,256*MiB);
 for(const profile of [FULL,LEGACY])assert.throws(()=>createCompactFeatureSchema(untouched,{arena:owner,expectedSchemaHash:'a'.repeat(64),workingBytes:WORK,capacityProfile:profile.id,maxWireBytes:256*MiB+1}),/configuration/);assert.equal(reads,0);
 const f=fixture(),handle=ownSchema(f,owner,{maxWireBytes:256*MiB});try{const encoded=encode(handle),loaded=load(encoded,f,owner,{maxWireBytes:256*MiB});assert.ok(loaded);releaseCompactFeatureAsset(loaded);}finally{releaseCompactFeatureAsset(handle);}
 const old=fixture({legacy:true}),oldHandle=ownSchema(old,owner,{maxWireBytes:256*MiB});releaseCompactFeatureAsset(oldHandle);
 assert.throws(()=>loadCompactFeatureAsset({utf8:'x'.repeat(2048),bytes:2048,sha256:'a'.repeat(64)},{arena:owner,expectedSchemaHash:'a'.repeat(64),expectedArtifactSha256:'a'.repeat(64),workingBytes:WORK,capacityProfile:FULL.id,maxWireBytes:1024}),/wire_hash_or_bound/);
 assert.throws(()=>createCompactFeatureSchema({}, {arena:owner,expectedSchemaHash:'a'.repeat(64),workingBytes:WORK,capacityProfile:'future'}),/capacity_profile/);
 clean(owner);
});

test('legacy count cap remains150000 while full count cap is explicitly300000',()=>{
 const owner=arena(),definition={name:'synthetic.codec.count-only'};
 for(const [legacy,count]of [[true,150001],[false,300001]])assert.throws(()=>createCompactFeatureSchema(schema(Array(count).fill(definition),{legacy}),{arena:owner,expectedSchemaHash:'a'.repeat(64),workingBytes:WORK}),/definition_bound/);
 clean(owner);
});

test('full codec admits300000 Float64 columns using bounded wire chunks and its admitted32MiB encoder default',()=>{
 // Repeated names deliberately isolate the codec boundary. This is not a
 // compiler-valid unique vocabulary or an acceptance claim for rich production.
 const n=300000,definition={name:'synthetic.codec.upper-count'},expanded=schema(Array(n).fill(definition)),owner=arena(),hash=hashFeatureAsset(expanded),handle=createCompactFeatureSchema(expanded,{arena:owner,expectedSchemaHash:hash,workingBytes:64*MiB});let vector;
 try{
  assert.ok(handle);assert.equal(describeCompactFeatureAsset(handle).featureCount,n);
  vector=createCompactFeatureVector({schemaHandle:handle,names:Array(n).fill(definition.name),values:Array(n).fill(-0),missing:Array(n).fill(false)},{arena:owner,workingBytes:64*MiB});assert.ok(vector);
  const before=owner.status().chargedBytes;let bytes=0,chunks=0;
  const receipt=writeCompactFeatureAssetChunks(vector,chunk=>{assert.ok(chunk.length<=32768);bytes+=Buffer.byteLength(chunk);chunks++;});
  assert.ok(receipt);assert.equal(receipt.capacityProfile,FULL.id);assert.equal(receipt.bytes,bytes);assert.ok(bytes<64*MiB);assert.ok(chunks>1);assert.equal(owner.status().chargedBytes,before);
  // Independent ordinary canonical oracle for this bounded encoded vector,
  // including the4.8M-character field that must not use a generic scalar bypass.
  assert.equal(receipt.sha256,hashFeatureAsset({contract:'aegis.compact-feature-vector.v3',capacityProfile:FULL.id,expandedSchemaHash:hash,namesHash:hashFeatureAsset(Array(n).fill(definition.name)),featureCount:n,valuesFloat64LEHex:'0000000000000080'.repeat(n),missingBitmapHex:'00'.repeat(Math.ceil(n/8))}));
  const page=readCompactVectorPage(vector,{offset:n-1,limit:1});try{assert.equal(page.total,n);assert.equal(page.nextOffset,null);assert.equal(Object.is(page.values[0],-0),true);}finally{page?.release();}
 }finally{clean(owner,vector,handle);}
});

test('full logical bounds saturate before hashing oversized repeated DAGs or allocating expanded arrays',()=>{
 const owner=arena(),payload='x'.repeat(1000000),bytesSchema=schema(Array(5000).fill({name:'byte-bound',payload}));let tree=null;for(let i=0;i<14;i++)tree=[tree,tree];const nodeSchema=schema(Array(4000).fill({name:'node-bound',tree}));
 for(const [expanded,bound]of [[bytesSchema,'maxExpandedBytes'],[nodeSchema,'maxExpandedNodes']]){
  assert.throws(()=>createCompactFeatureSchema(expanded,{arena:owner,expectedSchemaHash:'a'.repeat(64),workingBytes:WORK}),error=>{assert.match(error.message,/expanded_schema_bound/);assert.equal(error.diagnostics.capacityProfile,FULL.id);assert.equal(error.diagnostics[bound],FULL[bound==='maxExpandedBytes'?'maxExpandedSchemaBytes':'maxExpandedNodes']);return true;});
  assert.equal(owner.status().chargedBytes,0);
 }
 clean(owner);
});

test('full profile keeps old per-definition and page expansion limits',()=>{
 const owner=arena();assert.throws(()=>createCompactFeatureSchema(schema([{name:'too-big-definition',payload:'x'.repeat(MiB)}]),{arena:owner,expectedSchemaHash:'a'.repeat(64),workingBytes:WORK}),/expanded_definition_bound/);
 let tree=null;for(let i=0;i<16;i++)tree=[tree,tree];assert.throws(()=>createCompactFeatureSchema(schema([{name:'too-many-definition-nodes',tree}]),{arena:owner,expectedSchemaHash:'a'.repeat(64),workingBytes:WORK}),/expanded_definition_bound/);
 for(const expanded of [schema(Array(10).fill({name:'page-bytes',payload:'x'.repeat(900000)})),(()=>{let branch=null;for(let i=0;i<12;i++)branch=[branch,branch];return schema(Array(33).fill({name:'page-nodes',branch}));})()]){
  const handle=createCompactFeatureSchema(expanded,{arena:owner,expectedSchemaHash:hashFeatureAsset(expanded),workingBytes:32*MiB});assert.ok(handle);
  try{const before=owner.status().chargedBytes,decoded=describeCompactFeatureAsset(handle).decodedPageDefinitions;assert.throws(()=>readCompactSchemaPage(handle,{limit:expanded.definitions.length}),/page_expansion_bound/);assert.equal(describeCompactFeatureAsset(handle).decodedPageDefinitions,decoded);assert.equal(owner.status().chargedBytes,before);const page=readCompactSchemaPage(handle,{limit:1});assert.ok(page);page.release();}finally{releaseCompactFeatureAsset(handle);}
 }
 clean(owner);
});

test('full profile denied reservation and accessor failures release every working owner',()=>{
 const owner=createDiagnosticResourceArena({maxBytes:1024}),occupied=owner.reserve(1024);let reads=0;const expanded={};Object.defineProperty(expanded,'contract',{get(){reads++;throw Error('do_not_execute');}});
 assert.equal(createCompactFeatureSchema(expanded,{arena:owner,expectedSchemaHash:'a'.repeat(64),capacityProfile:FULL.id,workingBytes:1024}),null);assert.equal(reads,0);occupied.release();
 assert.throws(()=>createCompactFeatureSchema(expanded,{arena:owner,expectedSchemaHash:'a'.repeat(64),capacityProfile:FULL.id,workingBytes:1024}),/owned_data_property/);assert.equal(reads,0);clean(owner);
});

test('factoring refusal reports bounded actual construction counters and releases its work lease',()=>{
 const owner=arena(),workingBytes=128*1024,expanded=schema(Array.from({length:500},(_,i)=>({name:'counted.'+i,payload:'unique operand '+i,formula:'same formula'})));
 assert.throws(()=>createCompactFeatureSchema(expanded,{arena:owner,expectedSchemaHash:'a'.repeat(64),workingBytes}),error=>{
  assert.match(error.message,/factoring_working_reservation_too_small/);const d=error.diagnostics;
  assert.equal(d.contract,'aegis.compact-factoring-working-refusal.v1');assert.equal(d.capacityProfile,FULL.id);assert.equal(d.stage,'encode_definitions');assert.equal(typeof d.allocation,'string');assert.ok(d.definitionIndex>=0&&d.definitionIndex<500);assert.equal(d.workingBytes,workingBytes);assert.ok(d.heldBytes+d.requestedBytes>workingBytes);assert.ok(d.peakHeldBytes>=d.heldBytes);assert.ok(d.counts.nodes>0);assert.ok(d.counts.strings>0);assert.ok(d.counts.nodeMapKeyCodeUnits>0);assert.ok(d.counts.nodeMapKeyEstimatedBytes>0);assert.ok(d.counts.sourceMemoEntries<=d.counts.sourceObjectAllocations);assert.equal(Object.values(d.nodesByTag).reduce((n,x)=>n+x,0),d.counts.nodes);assert.ok(Object.isFrozen(d)&&Object.isFrozen(d.counts)&&Object.isFrozen(d.nodesByTag));assert.equal(d.limitsUnchanged,true);return true;
 });clean(owner);
});

test('full streamed logical stress crosses old256MiB and16M-node guards without materializing the whole schema',{skip:process.env.AEGIS_R7_CODEC_LOGICAL_STRESS!=='1'},()=>{
 // One definition stays below1MiB/65536 nodes. The encoded dictionary is tiny;
 // only the canonical hash visits the repeated logical content. Parent runs
 // this separately under the owned6GiB job, never as a claimed rich-host test.
 let tree=null;for(let i=0;i<14;i++)tree=[tree,tree];const definition={name:'streamed-logical-stress',payload:'x'.repeat(400000),tree},expanded=schema(Array(600).fill(definition)),owner=arena(),hash=hashFeatureAsset(expanded);let handle,reloaded;
 try{
  handle=createCompactFeatureSchema(expanded,{arena:owner,expectedSchemaHash:hash,workingBytes:WORK});assert.ok(handle);const descriptor=describeCompactFeatureAsset(handle);assert.ok(descriptor.logicalExpandedNodes>LEGACY.maxExpandedNodes);assert.ok(descriptor.logicalExpandedNodes<=FULL.maxExpandedNodes);assert.ok(descriptor.logicalExpandedBytesUpper>LEGACY.maxExpandedSchemaBytes);assert.ok(descriptor.logicalExpandedBytesUpper<=FULL.maxExpandedSchemaBytes);assert.ok(descriptor.wireBytes<MiB);
  const encoded=encode(handle);reloaded=load(encoded,{hash},owner);assert.ok(reloaded);assert.equal(describeCompactFeatureAsset(reloaded).expandedSchemaHash,hash);
  const page=readCompactSchemaPage(reloaded,{offset:599,limit:1});try{assert.deepEqual(page.definitions[0],definition);}finally{page?.release();}
 }finally{clean(owner,reloaded,handle);}
});
