/** Tiny real codec factoring refusals. The lower-only caller limit avoids a
 * million-node stress allocation; no production cap/profile/wire is enlarged. */
import test from 'node:test';import assert from 'node:assert/strict';
import {digest} from '../../feature-registry/registry-contract.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {LEGACY_FEATURE_CAPACITY_PROFILE as LEGACY,FULL_FEATURE_CAPACITY_PROFILE as FULL} from './featureCapacityProfiles.mjs';
import {createCompactFeatureSchema,releaseCompactFeatureAsset,writeCompactFeatureAssetChunks} from './compactFeatureAssets.mjs';
const WORK=8*1024**2;
function schema(profile){return{contract:profile.schemaContract,...(profile===FULL?{capacityProfile:profile.id}:{}),definitions:Array.from({length:20},(_,i)=>({name:'synthetic.codec-structure.'+i,payload:{coordinate:i,selector:'fixed_'+i},units:'count'}))};}
for(const profile of [LEGACY,FULL])test(profile.id+' reports bounded DISTINCT structure refusal and releases all working memory',()=>{
 const input=schema(profile),arena=createDiagnosticResourceArena({maxBytes:64*1024**2});
 assert.throws(()=>createCompactFeatureSchema(input,{arena,expectedSchemaHash:digest(input),capacityProfile:profile.id,workingBytes:WORK,maxDistinctFactoringNodes:8}),error=>{
  assert.equal(error.message,'compact_feature_asset:node_bound');const d=error.diagnostics;assert.equal(d.contract,'aegis.compact-factoring-structure-refusal.v1');assert.equal(d.capacityProfile,profile.id);assert.equal(d.allocation,'distinct_encoded_dag_nodes');assert.equal(d.stage,'encode_definitions');assert.equal(d.limit,8);assert.equal(d.counts.nodes,8);assert.ok(d.definitionIndex>=0&&d.definitionIndex<20);assert.ok(d.heldBytes<=WORK);assert.equal(d.workingBytes,WORK);assert.equal(d.maxDistinctFactoringNodes,8);assert.equal(d.maxDictionaryEntries,1000000);assert.equal(d.maxEncodedJsonTraversalNodes,16000000);assert.equal(d.maxLogicalExpandedNodes,profile.maxExpandedNodes);assert.equal(d.callerLowerLimitApplied,true);assert.equal(d.limitsUnchanged,true);assert.equal(Object.values(d.nodesByTag).reduce((n,x)=>n+x,0),8);assert.ok(Object.isFrozen(d)&&Object.isFrozen(d.counts)&&Object.isFrozen(d.nodesByTag));assert.ok(JSON.stringify(d).length<4096);return true;
 });assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);
});
test('lower-only construction admission cannot raise the existing million-node bound or touch caller data first',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:64*1024**2});let reads=0;const input={};Object.defineProperty(input,'contract',{get(){reads++;throw Error('unexpected traversal');}});
 for(const maxDistinctFactoringNodes of [0,-1,1000001,Infinity,NaN,1.5])assert.throws(()=>createCompactFeatureSchema(input,{arena,expectedSchemaHash:'a'.repeat(64),workingBytes:WORK,maxDistinctFactoringNodes}),/factoring_node_limit/);
 assert.equal(reads,0);assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);
});
test('default and explicit unchanged maximum emit identical exact codec bytes',()=>{
 const input=schema(FULL),arena=createDiagnosticResourceArena({maxBytes:64*1024**2}),handles=[];
 const encode=h=>{const chunks=[],receipt=writeCompactFeatureAssetChunks(h,c=>chunks.push(c),{workingBytes:WORK});assert.ok(receipt);return{receipt,utf8:chunks.join('')};};
 try{for(const extra of [{},{maxDistinctFactoringNodes:1000000}]){const h=createCompactFeatureSchema(input,{arena,expectedSchemaHash:digest(input),capacityProfile:FULL.id,workingBytes:WORK,...extra});assert.ok(h);handles.push(h);}assert.deepEqual(encode(handles[0]),encode(handles[1]));}finally{for(const h of handles)releaseCompactFeatureAsset(h);assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);}
});
