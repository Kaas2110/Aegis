/** Exact small codec goldens through the actual old projection compiler. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {digest,validateRegistry} from '../../feature-registry/registry-contract.mjs';
import {createFeatureProjectionCompiler} from './featureProjectionCompiler.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createCompactFeatureSchema,createCompactFeatureVector,retainCompactFeatureAsset,releaseCompactFeatureAsset,describeCompactFeatureAsset,readCompactSchemaPage as readLeasedSchemaPage,readCompactVectorPage as readLeasedVectorPage,writeCompactFeatureAssetChunks,loadCompactFeatureAsset} from './compactFeatureAssets.mjs';
const SHA=x=>createHash('sha256').update(x).digest('hex'),WORK=8*1024*1024;
// Test-owned snapshots release their decode lease immediately after copying.
function readCompactSchemaPage(handle,options){const page=readLeasedSchemaPage(handle,options);assert.ok(page);try{return structuredClone(page);}finally{page.release();}}
function readCompactVectorPage(handle,options){const page=readLeasedVectorPage(handle,options);assert.ok(page);try{return structuredClone(page);}finally{page.release();}}
function fixture(n=3){
 const [index,familyDocument,targetDocument]=syntheticRegistry(),compiler=createFeatureProjectionCompiler({registry:validateRegistry(index,familyDocument,targetDocument),registryHash:digest(index),sourceInventory:{history:{primarySha256:'a'.repeat(64),files:[{path:'synthetic-compact-history.mjs',sha256:'a'.repeat(64)}]}},sourceProfiles:{history:'synthetic-prior'}});
 const names=Array.from({length:n},(_,i)=>'synthetic.hist.'+i),component={names,values:names.map((_,i)=>i%3===2?null:i===1?-0:i),masks:names.map((_,i)=>Number(i%3===2)),schemaHash:digest({fixture:n}),definitions:names.map((name,i)=>({name,familyId:'H02',formula:'synthetic exact formula shared across coordinates',formulaVersion:'synthetic-v1',units:'fraction',inputScopes:['prior_completed_maps','current_identity'],coordinate:{hero:i+1,kind:'shared-axis',signedZero:-0}}))};
 const route=compiler.project([compiler.normalize(component,'history')],'POST_MAP_WIN','POST');return{schema:route.diagnosticSchema,hash:route.schemaRef.sha256,vector:route.diagnosticVector};
}
function build(f=fixture(),arena=createDiagnosticResourceArena({maxBytes:64*1024*1024})){
 const schema=createCompactFeatureSchema(f.schema,{arena,expectedSchemaHash:f.hash,workingBytes:WORK});assert.ok(schema);return{f,arena,schema};
}
function encode(handle){const chunks=[],receipt=writeCompactFeatureAssetChunks(handle,c=>chunks.push(c),{workingBytes:WORK});assert.ok(receipt);const utf8=chunks.join('');assert.equal(receipt.sha256,SHA(utf8));assert.equal(receipt.bytes,Buffer.byteLength(utf8));return{...receipt,utf8};}
function repin(wire){const utf8=JSON.stringify(wire);return{utf8,bytes:Buffer.byteLength(utf8),sha256:SHA(utf8)};}

test('factored schema exactly decodes actual old compiler definitions/header and semantic hash',()=>{
 const {f,arena,schema}=build(),page=readCompactSchemaPage(schema);assert.deepEqual(page.definitions,f.schema.definitions);const {definitions,...header}=f.schema;assert.deepEqual(page.header,header);assert.equal(digest({...page.header,definitions:page.definitions}),f.hash);assert.equal(describeCompactFeatureAsset(schema).expandedSchemaHash,f.hash);
 const encoded=encode(schema),wire=JSON.parse(encoded.utf8);assert.equal(wire.contract,'aegis.compact-feature-schema.v2');assert.equal(wire.featureCount,definitions.length);assert.ok(wire.shapes.length<wire.nodes.length);assert.ok(wire.strings.filter(s=>s==='synthetic exact formula shared across coordinates').length===1);releaseCompactFeatureAsset(schema);assert.equal(arena.status().chargedBytes,0);
});
test('Float64 and missing bitmap preserve ordered null/zero/negative-zero without exposed buffers',()=>{
 const {f,arena,schema}=build(),vector=createCompactFeatureVector({schemaHandle:schema,...f.vector},{arena,workingBytes:WORK});assert.ok(vector);const page=readCompactVectorPage(vector);assert.deepEqual(page.names,f.vector.names);assert.deepEqual(page.values,f.vector.values);assert.deepEqual(page.missing,f.vector.missing);assert.equal(Object.is(page.values[1],-0),true);assert.equal(page.values[0],0);assert.equal(page.values[2],null);
 assert.equal(Object.values(vector).some(v=>v instanceof ArrayBuffer||ArrayBuffer.isView(v)),false);page.values[0]=99;page.names[0]='changed';assert.equal(readCompactVectorPage(vector).values[0],0);releaseCompactFeatureAsset(vector);releaseCompactFeatureAsset(schema);assert.equal(arena.status().chargedBytes,0);
});
test('caller mutation cannot change an owned compact schema or numeric vector',()=>{
 const f=fixture(),mutable=structuredClone(f.schema),arena=createDiagnosticResourceArena({maxBytes:64*1024*1024}),schema=createCompactFeatureSchema(mutable,{arena,expectedSchemaHash:f.hash,workingBytes:WORK}),input={schemaHandle:schema,names:[...f.vector.names],values:[...f.vector.values],missing:[...f.vector.missing]},vector=createCompactFeatureVector(input,{arena,workingBytes:WORK});
 mutable.definitions[0].formula='changed';input.values[0]=100;input.missing[2]=false;assert.equal(readCompactSchemaPage(schema).definitions[0].formula,f.schema.definitions[0].formula);assert.deepEqual(readCompactVectorPage(vector).values,f.vector.values);releaseCompactFeatureAsset(vector);releaseCompactFeatureAsset(schema);assert.equal(arena.status().chargedBytes,0);
});
test('reading a 200-definition page decodes only that page after verified construction',()=>{
 const {schema,arena}=build(fixture(1000)),before=describeCompactFeatureAsset(schema).decodedPageDefinitions,page=readCompactSchemaPage(schema,{offset:400,limit:200}),after=describeCompactFeatureAsset(schema).decodedPageDefinitions;assert.equal(page.definitions.length,200);assert.equal(page.definitions[0].name,'synthetic.hist.400');assert.equal(page.nextOffset,600);assert.equal(after-before,200);assert.throws(()=>readCompactSchemaPage(schema,{limit:1001}),/page_bound/);releaseCompactFeatureAsset(schema);assert.equal(arena.status().chargedBytes,0);
});
test('new schema/vector wire reload verifies both external artifact and expanded semantics',()=>{
 const {f,arena,schema}=build(),vector=createCompactFeatureVector({schemaHandle:schema,...f.vector},{arena,workingBytes:WORK}),encodedSchema=encode(schema),encodedVector=encode(vector),freshSchema=loadCompactFeatureAsset(encodedSchema,{arena,expectedSchemaHash:f.hash,expectedArtifactSha256:encodedSchema.sha256,workingBytes:WORK}),freshVector=loadCompactFeatureAsset(encodedVector,{arena,expectedSchemaHash:f.hash,expectedArtifactSha256:encodedVector.sha256,schemaHandle:freshSchema,workingBytes:WORK});
 assert.deepEqual(readCompactSchemaPage(freshSchema).definitions,f.schema.definitions);assert.deepEqual(readCompactVectorPage(freshVector).values,f.vector.values);for(const h of [schema,vector,freshSchema,freshVector])releaseCompactFeatureAsset(h);assert.equal(arena.status().chargedBytes,0);
});
test('tampering wire bytes or rehashing changed semantics does not satisfy old authority',()=>{
 const {f,arena,schema}=build(),encoded=encode(schema);assert.throws(()=>loadCompactFeatureAsset({...encoded,utf8:encoded.utf8+' '},{arena,expectedSchemaHash:f.hash,expectedArtifactSha256:encoded.sha256,workingBytes:WORK}),/wire_hash/);
 const wire=JSON.parse(encoded.utf8),slot=wire.strings.indexOf('synthetic exact formula shared across coordinates');wire.strings[slot]='altered formula';const changed=repin(wire);
 assert.throws(()=>loadCompactFeatureAsset(changed,{arena,expectedSchemaHash:f.hash,expectedArtifactSha256:encoded.sha256,workingBytes:WORK}),/wire_hash/);
 assert.throws(()=>loadCompactFeatureAsset(changed,{arena,expectedSchemaHash:f.hash,expectedArtifactSha256:changed.sha256,workingBytes:WORK}),/expanded_schema_hash/);releaseCompactFeatureAsset(schema);assert.equal(arena.status().chargedBytes,0);
});
test('vector wire rejects nonfinite payloads and nonzero bitmap padding',()=>{
 const {f,arena,schema}=build(),vector=createCompactFeatureVector({schemaHandle:schema,...f.vector},{arena,workingBytes:WORK}),encoded=encode(vector),base=JSON.parse(encoded.utf8);
 for(const wire of [{...base,valuesFloat64LEHex:'000000000000f87f'+base.valuesFloat64LEHex.slice(16)},{...base,missingBitmapHex:'80'}]){const changed=repin(wire);assert.throws(()=>loadCompactFeatureAsset(changed,{arena,expectedSchemaHash:f.hash,expectedArtifactSha256:changed.sha256,schemaHandle:schema,workingBytes:WORK}),/vector_wire_value|bitmap_padding/);}
 releaseCompactFeatureAsset(vector);releaseCompactFeatureAsset(schema);assert.equal(arena.status().chargedBytes,0);
});
test('retained owners stay charged after cache release and vectors retain their schema dependency',()=>{
 const {f,arena,schema}=build(),firstBytes=arena.status().chargedBytes,held=retainCompactFeatureAsset(schema);assert.ok(held);assert.equal(arena.status().chargedBytes,firstBytes);assert.equal(releaseCompactFeatureAsset(schema),true);assert.equal(releaseCompactFeatureAsset(schema),false);assert.throws(()=>readCompactSchemaPage(schema),/owned_active_handle/);
 const vector=createCompactFeatureVector({schemaHandle:held,...f.vector},{arena,workingBytes:WORK});releaseCompactFeatureAsset(held);assert.equal(arena.status().heldAssets,2);assert.deepEqual(readCompactVectorPage(vector).values,f.vector.values);releaseCompactFeatureAsset(vector);assert.equal(arena.status().heldAssets,0);assert.equal(arena.status().leases,0);assert.equal(arena.status().chargedBytes,0);
});
test('budget denial performs no schema traversal and validation failures release working reservations',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:1024}),occupied=arena.reserve(1024);let reads=0;const bad={};Object.defineProperty(bad,'contract',{get(){reads++;throw Error('must_not_read');}});
 assert.equal(createCompactFeatureSchema(bad,{arena,expectedSchemaHash:'a'.repeat(64),workingBytes:1024}),null);assert.equal(reads,0);occupied.release();assert.throws(()=>createCompactFeatureSchema(bad,{arena,expectedSchemaHash:'a'.repeat(64),workingBytes:1024}),/owned_data_property/);assert.equal(reads,0);assert.equal(arena.status().chargedBytes,0);
});
test('wrong order or missingness and zero-copy ownership claims are rejected without leaked holds',()=>{
 const {f,arena,schema}=build(),before=arena.status().chargedBytes;
 for(const variant of [{...f.vector,names:[...f.vector.names].reverse()},{...f.vector,missing:[false,false,false]},{...f.vector,values:[Infinity,-0,null]}])assert.throws(()=>createCompactFeatureVector({schemaHandle:schema,...variant},{arena,workingBytes:WORK}),/vector_order_or_shape|vector_value_or_missing/);
 assert.equal(arena.status().chargedBytes,before);releaseCompactFeatureAsset(schema);assert.equal(arena.status().chargedBytes,0);
});
test('stream chunks survive original owner release, preserve Unicode, and release pins on sink failure',()=>{
 const f=fixture(),copy=structuredClone(f.schema);copy.definitions[0].formula='😀'.repeat(300);const modified={...f,schema:copy,hash:digest(copy)},a=build(modified),chunks=[];let released=false;
 const receipt=writeCompactFeatureAssetChunks(a.schema,c=>{chunks.push(c);if(!released){released=true;releaseCompactFeatureAsset(a.schema);}},{chunkCodeUnits:128,workingBytes:WORK});assert.ok(receipt);assert.equal(receipt.sha256,SHA(chunks.join('')));assert.ok(chunks.every(c=>c.length<=128));assert.equal(a.arena.status().chargedBytes,0);
 const b=build(),before=b.arena.status().chargedBytes;assert.throws(()=>writeCompactFeatureAssetChunks(b.schema,()=>{throw Error('sink_failure');},{workingBytes:WORK}),/sink_failure/);assert.equal(b.arena.status().chargedBytes,before);releaseCompactFeatureAsset(b.schema);assert.equal(b.arena.status().chargedBytes,0);
});
test('backward DAG doubling fails saturated expansion preflight before recursive decode or semantic hashing',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:64*1024*1024}),nodes=[[3,2],[0]];let previous=1;
 for(let i=0;i<40;i++){nodes.push([4,[previous,previous]]);previous=nodes.length-1;}nodes.push([5,0,[0,previous]]);
 const wire={contract:'aegis.compact-feature-schema.v2',expandedSchemaHash:'a'.repeat(64),namesHash:'b'.repeat(64),featureCount:1,header:{contract:'aegis.unified-feature-projection-schema.v1'},strings:['name','payload','x'],shapes:[[0,1]],nodes,definitionRefs:[nodes.length-1]},receipt=repin(wire);
 // This fixture is tiny; the asserted error is the preflight bound. The module
 // computes costs over encoded nodes, never materializing the exponential tree.
 assert.throws(()=>loadCompactFeatureAsset(receipt,{arena,expectedSchemaHash:wire.expandedSchemaHash,expectedArtifactSha256:receipt.sha256,workingBytes:WORK}),/expanded_definition_bound/);assert.equal(arena.status().chargedBytes,0);
});
test('shared source-object DAG is memoized and bounded before original-schema hash traversal',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:64*1024*1024});let shared=null;for(let i=0;i<40;i++)shared=[shared,shared];
 const schema={contract:'aegis.unified-feature-projection-schema.v1',definitions:[{name:'x',payload:shared}]};
 assert.throws(()=>createCompactFeatureSchema(schema,{arena,expectedSchemaHash:'a'.repeat(64),workingBytes:WORK}),/expanded_definition_bound/);assert.equal(arena.status().chargedBytes,0);
});
test('page decode reserves aggregate work before decoding and keeps its lease until explicitly released',()=>{
 const {schema,arena}=build(),before=arena.status().chargedBytes,blocked=arena.reserve(arena.status().maxBytes-before),decoded=describeCompactFeatureAsset(schema).decodedPageDefinitions;
 assert.equal(readLeasedSchemaPage(schema),null);assert.equal(describeCompactFeatureAsset(schema).decodedPageDefinitions,decoded);blocked.release();
 const page=readLeasedSchemaPage(schema);assert.ok(page);assert.ok(arena.status().chargedBytes>before);releaseCompactFeatureAsset(schema);assert.ok(arena.status().chargedBytes>0);assert.equal(page.release(),true);assert.equal(page.release(),false);assert.equal(arena.status().chargedBytes,0);
});
test('raw wire cheap size bound precedes hashing and parsing',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:64*1024*1024}),receipt={utf8:'x'.repeat(2048),bytes:2048,sha256:'a'.repeat(64)};
 assert.throws(()=>loadCompactFeatureAsset(receipt,{arena,expectedSchemaHash:'a'.repeat(64),expectedArtifactSha256:'a'.repeat(64),workingBytes:WORK,maxWireBytes:1024}),/wire_hash_or_bound/);assert.equal(arena.status().chargedBytes,0);
});

test('allowed logical expansion still must fit reserved decoded working memory before decode',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:64*1024*1024}),nodes=[[3,2],[0]];let previous=1;
 for(let i=0;i<14;i++){nodes.push([4,[previous,previous]]);previous=nodes.length-1;}nodes.push([5,0,[0,previous]]);
 const wire={contract:'aegis.compact-feature-schema.v2',expandedSchemaHash:'a'.repeat(64),namesHash:'b'.repeat(64),featureCount:1,header:{contract:'aegis.unified-feature-projection-schema.v1'},strings:['name','payload','x'],shapes:[[0,1]],nodes,definitionRefs:[nodes.length-1]},receipt=repin(wire);
 // Within the per-definition logical bound, but not the chosen 128KiB work
 // lease. This must fail before a tree or a hash of expanded content is built.
 assert.throws(()=>loadCompactFeatureAsset(receipt,{arena,expectedSchemaHash:wire.expandedSchemaHash,expectedArtifactSha256:receipt.sha256,workingBytes:128*1024}),/expanded_working_reservation_too_small/);assert.equal(arena.status().chargedBytes,0);
});

test('encoder rejects undersized vector and complete string-token work before invoking the sink',()=>{
 const f=fixture(),copy=structuredClone(f.schema);copy.definitions[0].formula='\0'.repeat(20000);const {schema,arena}=build({...f,schema:copy,hash:digest(copy)}),vector=createCompactFeatureVector({schemaHandle:schema,...f.vector},{arena,workingBytes:WORK}),before=arena.status().chargedBytes;let emitted=0;
 for(const [handle,options]of [[vector,{workingBytes:1024}],[schema,{workingBytes:128*1024,chunkCodeUnits:128}]])assert.throws(()=>writeCompactFeatureAssetChunks(handle,()=>{emitted++;},options),/encoding_working_reservation_too_small/);
 assert.equal(emitted,0);assert.equal(arena.status().chargedBytes,before);releaseCompactFeatureAsset(vector);releaseCompactFeatureAsset(schema);assert.equal(arena.status().chargedBytes,0);
});

test('default encoder work admits all 150000 Float64 columns without collecting full wire output',()=>{
 // A repeated small synthetic definition exercises only the codec count/byte
 // boundary. It is not a compiler-valid unique-name projection or rich runtime.
 const n=150000,definition={name:'synthetic.codec.bound'},expanded={contract:'aegis.unified-feature-projection-schema.v1',definitions:Array(n).fill(definition)},arena=createDiagnosticResourceArena({maxBytes:64*1024*1024}),schema=createCompactFeatureSchema(expanded,{arena,expectedSchemaHash:digest(expanded),workingBytes:32*1024*1024});assert.ok(schema);
 const vector=createCompactFeatureVector({schemaHandle:schema,names:Array(n).fill(definition.name),values:Array(n).fill(-0),missing:Array(n).fill(false)},{arena,workingBytes:32*1024*1024});assert.ok(vector);const before=arena.status().chargedBytes;let bytes=0,chunks=0;
 const receipt=writeCompactFeatureAssetChunks(vector,chunk=>{assert.ok(chunk.length<=32768);bytes+=Buffer.byteLength(chunk);chunks++;});assert.ok(receipt);assert.equal(receipt.bytes,bytes);assert.ok(chunks>1);assert.equal(arena.status().chargedBytes,before);releaseCompactFeatureAsset(vector);releaseCompactFeatureAsset(schema);assert.equal(arena.status().chargedBytes,0);
});

test('factoring admits large reference containers before touching source elements or header arrays',()=>{
 for(const workingBytes of [1024,128*1024,512*1024])for(const location of ['definition','header']){
  const arena=createDiagnosticResourceArena({maxBytes:64*1024*1024}),payload=Array(150000).fill(null);let reads=0;
  Object.defineProperty(payload,'0',{enumerable:true,get(){reads++;throw Error('must_not_visit_unfunded_reference');}});
  const schema={contract:'aegis.unified-feature-projection-schema.v1',definitions:[{name:'synthetic.budget',...(location==='definition'?{payload}:{})}],...(location==='header'?{payload}:{})};
  assert.throws(()=>createCompactFeatureSchema(schema,{arena,expectedSchemaHash:'a'.repeat(64),workingBytes}),/factoring_working_reservation_too_small/);assert.equal(reads,0);assert.equal(arena.status().chargedBytes,0);
 }
});

test('factoring memoizes a large shared source object instead of charging repeated expanded dictionaries',()=>{
 const shared={name:'synthetic.shared.factor',formula:'shared source object'},expanded={contract:'aegis.unified-feature-projection-schema.v1',definitions:Array(10000).fill(shared)},arena=createDiagnosticResourceArena({maxBytes:16*1024*1024}),schema=createCompactFeatureSchema(expanded,{arena,expectedSchemaHash:digest(expanded),workingBytes:2*1024*1024});assert.ok(schema);assert.equal(describeCompactFeatureAsset(schema).featureCount,10000);releaseCompactFeatureAsset(schema);assert.equal(arena.status().chargedBytes,0);
});
