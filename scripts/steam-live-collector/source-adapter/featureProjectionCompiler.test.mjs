import test from 'node:test';import assert from 'node:assert/strict';
import {createFeatureProjectionCompiler,retainVerifiedProjectionSchema,retainVerifiedProjectionVector} from './featureProjectionCompiler.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {freezeFeatureAsset,hashFeatureAsset} from './featureProjectionOwnership.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {digest,validateRegistry} from '../../feature-registry/registry-contract.mjs';
import {createDiagnosticResourceConfiguration,RICH_DIAGNOSTIC_RESOURCE_PROFILE} from './diagnosticResourceConfiguration.mjs';
const args=()=>{const [index,familyDocument,targetDocument]=syntheticRegistry();return{registry:validateRegistry(index,familyDocument,targetDocument),registryHash:digest(index),sourceInventory:{history:{primarySha256:'a'.repeat(64),files:[{path:'synthetic-history',sha256:'a'.repeat(64)}]}},sourceProfiles:{history:'synthetic-prior'}};};
const component=(value=1,version='1',scope='current_identity')=>({names:['synthetic.hist'],values:[value],masks:[Number(value===null)],schemaHash:digest({version,scope}),definitions:[{name:'synthetic.hist',familyId:'H02',formula:'synthetic source-backed constant',formulaVersion:version,units:'fraction',inputScopes:['prior_completed_maps',scope]}]});
test('shared immutable operands and whole mutable graph snapshots have identical expanded schemas and independent ownership',()=>{
 const source=component(),bindings=[{normalizedField:'priorMaps.durationSeconds',rawField:'retained.durationSeconds',sourceProfile:'synthetic-prior',sourceKind:'prior_map',units:'seconds',availabilityPolicy:'before cutoff'}],operand={minimumSupport:5,source:{bindings}};
 source.names.push('synthetic.hist2');source.values.push(2);source.masks.push(0);source.definitions.push({...source.definitions[0],name:'synthetic.hist2'});for(const d of source.definitions)Object.assign(d,{inputBindings:bindings,formulaParameters:operand});
 const frozen=structuredClone(source);freezeFeatureAsset(frozen.names);freezeFeatureAsset(frozen.definitions);const a=createFeatureProjectionCompiler(args()),b=createFeatureProjectionCompiler(args());let ma,mb,ra,rb;
 try{ma=a.normalize(source,'history');mb=b.normalize(frozen,'history');ra=a.project([ma],'PRE_MAP_WIN','PRE');rb=b.project([mb],'PRE_MAP_WIN','PRE');const da=ra.diagnosticSchema.definitions,db=rb.diagnosticSchema.definitions;
  assert.equal(ra.schemaRef.sha256,rb.schemaRef.sha256);assert.equal(hashFeatureAsset(ra.diagnosticSchema),rb.schemaRef.sha256);assert.deepEqual(ra.diagnosticSchema,rb.diagnosticSchema);assert.equal(da[0].inputBindings,da[1].inputBindings);assert.notEqual(da[0].inputBindings,bindings);assert.equal(db[0].inputBindings,frozen.definitions[0].inputBindings);assert.equal(db[0].formulaParameters,db[1].formulaParameters);
  bindings[0].units='changed caller value';operand.minimumSupport=500;assert.equal(da[0].inputBindings[0].units,'seconds');assert.equal(da[0].formulaParameters.minimumSupport,5);a.close();b.close();assert.ok(a.status().resources.chargedBytes>0);assert.equal(da[0].inputBindings[0].units,db[0].inputBindings[0].units);
 }finally{ra?.release();rb?.release();ma?.release();mb?.release();a.close();b.close();assert.equal(a.status().resources.chargedBytes,0);assert.equal(b.status().resources.chargedBytes,0);}
});
test('repeated frames reuse compiled semantics but project their own current row values',()=>{
 const c=createFeatureProjectionCompiler(args()),a=c.project([c.normalize(component(1),'history')],'PRE_MAP_WIN','PRE'),b=c.project([c.normalize(component(2),'history')],'PRE_MAP_WIN','PRE');
 assert.equal(a.schemaRef.sha256,b.schemaRef.sha256);assert.equal(a.diagnosticVector.values[0],1);assert.equal(b.diagnosticVector.values[0],2);assert.equal(c.status().componentCompilations,1);assert.equal(c.status().projectionCompilations,1);assert.throws(()=>c.getSchema(a.schemaRef.sha256).definitions.push({}));
});
test('bounded component and plan LRUs reload the same exact schema/vector after churn',()=>{
 const c=createFeatureProjectionCompiler({...args(),maxSchemas:2,maxComponentSchemas:1}),project=version=>c.project([c.normalize(component(8,version),'history')],'PRE_MAP_WIN','PRE'),a=project('1'),b=project('2');
 assert.ok(c.getSchema(a.schemaRef.sha256));project('3');assert.equal(c.getSchema(b.schemaRef.sha256),null);assert.equal(c.status().projectionSchemas,2);assert.equal(c.status().componentSchemas,1);assert.ok(c.status().componentEvictions>=2);assert.ok(c.status().projectionEvictions>=1);
 const reload=project('2');assert.equal(reload.schemaRef.sha256,b.schemaRef.sha256);assert.deepEqual(reload.diagnosticVector,b.diagnosticVector);assert.deepEqual(reload.diagnosticSchema,b.diagnosticSchema);assert.equal(Object.isFrozen(a.diagnosticSchema),true);assert.equal(digest(a.diagnosticSchema),a.schemaRef.sha256);
 for(let n=4;n<20;n++){project(String(n));assert.ok(c.status().projectionSchemas<=2);assert.ok(c.status().componentSchemas<=1);}
});
test('draft-only values never enter PRE; compiled plans retain explicit exclusion',()=>{
 const c=createFeatureProjectionCompiler(args()),p=c.project([c.normalize(component(7,'1','current_draft'),'history')],'PRE_MAP_WIN','PRE');
 assert.equal(p.diagnosticVector.values.length,0);assert.equal(p.excludedDefinitions[0].reason,'current_draft_unavailable_in_phase');
 assert.throws(()=>c.normalize({...component(),masks:[false],values:[null]},'history'),/component_column/);
});
test('route-owned immutable schema survives eviction during multi-target generation',()=>{
 const c=createFeatureProjectionCompiler({...args(),maxSchemas:1}),blocks=[c.normalize(component(9),'history')],first=c.project(blocks,'PRE_MAP_WIN','PRE');c.project(blocks,'PRE_KILLS','PRE');assert.equal(c.getSchema(first.schemaRef.sha256),null);assert.equal(first.diagnosticSchema.targetId,'PRE_MAP_WIN');assert.equal(digest(first.diagnosticSchema),first.schemaRef.sha256);assert.throws(()=>{first.diagnosticSchema.definitions[0].formula='mutated';});assert.deepEqual(first.diagnosticVector.values,[9]);
});
test('source descriptor time/support/population/role/patch policies survive projection and affect its hash',()=>{
 const policies={supportUnit:'distinct_prior_maps',eventTimePolicy:'prior_end_before_t0',availabilityTimePolicy:'known_before_t0',populationPolicy:'provided_retained_scope',rolePolicy:'unknown_without_role_evidence',patchPolicy:'exact_observed_revision_only'};
 const x=component();Object.assign(x.definitions[0],policies);x.schemaHash=digest({base:x.schemaHash,policies});const c=createFeatureProjectionCompiler(args()),a=c.project([c.normalize(x,'history')],'PRE_MAP_WIN','PRE');for(const[k,v]of Object.entries(policies))assert.equal(a.diagnosticSchema.definitions[0][k],v);
 const changed=structuredClone(x);changed.definitions[0].supportUnit='distinct_series';changed.schemaHash=digest({base:x.schemaHash,changed:'supportUnit'});const b=c.project([c.normalize(changed,'history')],'PRE_MAP_WIN','PRE');assert.notEqual(a.schemaRef.sha256,b.schemaRef.sha256);assert.equal(b.diagnosticSchema.definitions[0].supportUnit,'distinct_series');
});
test('R7 additive formula operands and future semantic policies survive compiler identity and mutate schema hash',()=>{
 const c=createFeatureProjectionCompiler(args()),x=component();Object.assign(x.definitions[0],{inputBindings:[{normalizedField:'a',rawField:'b'}],formulaParameters:{K:24},futurePolicy:{cohort:'pinned'},knownAt:'diagnostic-only'});const a=c.normalize(x,'history'),p=c.project([a],'PRE_MAP_WIN','PRE');assert.deepEqual(p.diagnosticSchema.definitions[0].formulaParameters,{K:24});assert.deepEqual(p.diagnosticSchema.definitions[0].futurePolicy,{cohort:'pinned'});assert.equal(p.diagnosticSchema.definitions[0].knownAt,undefined);
 x.definitions[0].futurePolicy.cohort='different';const b=c.normalize(x,'history'),q=c.project([b],'PRE_MAP_WIN','PRE');assert.notEqual(p.schemaRef.sha256,q.schemaRef.sha256);assert.equal(p.familyStatuses.find(f=>f.familyId==='H03').status,'not_generated');assert.equal(p.familyStatuses.find(f=>f.familyId==='H03').sourceAvailabilityAttested,false);p.release();q.release();a.release();b.release();c.close();
});

test('declared schema hash never hides altered formulas or source policies',()=>{
 const c=createFeatureProjectionCompiler(args()),x=component(),a=c.normalize(x,'history'),p=c.project([a],'PRE_MAP_WIN','PRE');
 x.definitions[0].formula='a distinct formula under the same untrusted declaration';x.definitions[0].supportPolicy={unit:'distinct_series'};
 const b=c.normalize(x,'history'),q=c.project([b],'PRE_MAP_WIN','PRE');assert.notEqual(p.schemaRef.sha256,q.schemaRef.sha256);assert.equal(q.diagnosticSchema.definitions[0].formula,x.definitions[0].formula);assert.equal(p.diagnosticSchema.definitions[0].supportPolicy,undefined);
 p.release();q.release();a.release();b.release();c.close();assert.equal(c.status().resources.chargedBytes,0);
});
test('shallow frozen wrapper cannot authorize mutable metadata or stale values',()=>{
 const c=createFeatureProjectionCompiler(args()),x=Object.freeze(component()),a=c.normalize(x,'history');x.values[0]=2;x.definitions[0].units='kills';const b=c.normalize(x,'history');
 const p=c.project([a],'PRE_MAP_WIN','PRE'),q=c.project([b],'PRE_MAP_WIN','PRE');assert.deepEqual(p.diagnosticVector.values,[1]);assert.deepEqual(q.diagnosticVector.values,[2]);assert.notEqual(p.schemaRef.sha256,q.schemaRef.sha256);assert.equal(c.status().metadataIdentityHits,0);
 p.release();q.release();a.release();b.release();c.close();assert.equal(c.status().resources.chargedBytes,0);
});
test('deep immutable metadata is reused by identity while each row is snapshotted',()=>{
 const c=createFeatureProjectionCompiler(args()),x=component();freezeFeatureAsset(x.names);freezeFeatureAsset(x.definitions);const a=c.normalize(x,'history');x.values[0]=9;const b=c.normalize(x,'history');
 assert.equal(c.status().metadataIdentityHits,1);assert.equal(c.status().componentCompilations,1);assert.deepEqual(a.values,[1]);assert.deepEqual(b.values,[9]);assert.throws(()=>a.values.push(4));a.release();b.release();c.close();assert.equal(c.status().resources.chargedBytes,0);
});
test('byte-owned active schema survives cache eviction and compiler close',()=>{
 const arena=createDiagnosticResourceArena(),c=createFeatureProjectionCompiler({...args(),resourceArena:arena,maxSchemas:1,maxComponentSchemas:1}),a=c.normalize(component(3),'history'),p=c.project([a],'PRE_MAP_WIN','PRE'),held=retainVerifiedProjectionSchema(p.diagnosticSchema,{expectedSchemaHash:p.schemaRef.sha256});
 const q=c.project([a],'PRE_KILLS','PRE');assert.equal(c.getSchema(p.schemaRef.sha256),null);assert.ok(held);assert.equal(Object.keys(held).includes('release'),false);assert.equal(retainVerifiedProjectionSchema(freezeFeatureAsset(structuredClone(p.diagnosticSchema)),{expectedSchemaHash:p.schemaRef.sha256}),null);
 assert.equal(retainVerifiedProjectionSchema(p.diagnosticSchema,{expectedSchemaHash:'b'.repeat(64)}),null);c.close();a.release();p.release();q.release();assert.ok(arena.status().chargedBytes>0);assert.equal(digest(held.schema),held.descriptor.sha256);held.release();assert.equal(arena.status().chargedBytes,0);assert.equal(held.release(),false);assert.equal(retainVerifiedProjectionSchema(p.diagnosticSchema,{expectedSchemaHash:p.schemaRef.sha256}),null);
});
test('shared row cache binds actual normalized row identity and rejects injected vectors',()=>{
 const c=createFeatureProjectionCompiler(args()),cache=new Map(),a=c.normalize(component(1),'history'),p=c.project([a],'PRE_MAP_WIN','PRE',null,cache),b=c.normalize(component(2),'history'),q=c.project([b],'PRE_MAP_WIN','PRE',null,cache);
 assert.deepEqual(p.diagnosticVector.values,[1]);assert.deepEqual(q.diagnosticVector.values,[2]);const key=[...cache.keys()].at(-1);cache.set(key,{names:['forged'],values:[100],missing:[false]});const r=c.project([b],'PRE_KILLS','PRE',null,cache);assert.deepEqual(r.diagnosticVector.values,[2]);p.release();q.release();r.release();a.release();b.release();c.close();assert.equal(c.status().resources.chargedBytes,0);
});
test('resource refusal precedes admission and releases every transient reservation',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:1024});assert.throws(()=>createFeatureProjectionCompiler({...args(),resourceArena:arena}),/compiler_resource_admission/);assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);
 const scanArena=createDiagnosticResourceArena({maxBytes:1024*1024});assert.throws(()=>createFeatureProjectionCompiler({...args(),resourceArena:scanArena,workingBytes:1024}),/asset_scan_working_bound/);assert.equal(scanArena.status().chargedBytes,0);assert.equal(scanArena.status().leases,0);
});
test('row accessors and proxies cannot run during value admission',()=>{
 const c=createFeatureProjectionCompiler(args()),x=component();let calls=0;Object.defineProperty(x.values,'0',{get(){calls++;return 99;}});assert.throws(()=>c.normalize(x,'history'),/component_column/);assert.equal(calls,0);
 const y=component();y.values=new Proxy(y.values,{get(){calls++;throw Error('should not run');}});assert.throws(()=>c.normalize(y,'history'),/component_shape/);assert.equal(calls,0);c.close();assert.equal(c.status().resources.chargedBytes,0);
});
test('bounded streaming canonical hash preserves existing registry hash bytes',()=>{
 for(const value of [null,-0,{z:['escaped\\\"','юникод',1e30],a:{missing:null,n:1.5}},Array.from({length:10000},(_,i)=>({i,value:'shared'}))])assert.equal(hashFeatureAsset(value),digest(value));
});
test('private vector lease survives shared-head release, cache eviction and compiler close',()=>{
 const arena=createDiagnosticResourceArena(),c=createFeatureProjectionCompiler({...args(),resourceArena:arena,maxSchemas:1,maxComponentSchemas:1}),block=c.normalize(component(-0),'history'),rows=new Map(),a=c.project([block],'PRE_MAP_WIN','PRE',null,rows),b=c.project([block],'PRE_KILLS','PRE',null,rows);
 assert.equal(a.diagnosticVector,b.diagnosticVector);const vector=a.diagnosticVector,held=retainVerifiedProjectionVector(vector,{expectedNamesHash:a.schemaRef.namesSha256,featureCount:a.schemaRef.featureCount});assert.ok(held);assert.equal(held.vector,vector);assert.equal(Object.keys(held).includes('release'),false);assert.equal(held.descriptor.namesSha256,a.schemaRef.namesSha256);assert.equal(held.descriptor.featureCount,1);
 block.release();a.release();b.release();c.close();assert.ok(arena.status().chargedBytes>0);assert.equal(Object.is(held.vector.values[0],-0),true);assert.equal(digest(held.vector.names),held.descriptor.namesSha256);assert.equal(held.release(),true);assert.equal(held.release(),false);assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);assert.equal(retainVerifiedProjectionVector(vector,{expectedNamesHash:held.descriptor.namesSha256,featureCount:1}),null);
});
test('private vector lease rejects JSON, frozen copies, wrong names/count and values without minted ownership',()=>{
 const c=createFeatureProjectionCompiler(args()),block=c.normalize(component(7),'history'),route=c.project([block],'PRE_MAP_WIN','PRE'),vector=route.diagnosticVector,options={expectedNamesHash:route.schemaRef.namesSha256,featureCount:route.schemaRef.featureCount};
 assert.equal(retainVerifiedProjectionVector(JSON.parse(JSON.stringify(vector)),options),null);assert.equal(retainVerifiedProjectionVector(freezeFeatureAsset(structuredClone(vector)),options),null);assert.equal(retainVerifiedProjectionVector(Object.freeze({names:vector.names,values:vector.values,missing:vector.missing}),options),null);assert.equal(retainVerifiedProjectionVector(vector,{...options,expectedNamesHash:'e'.repeat(64)}),null);assert.equal(retainVerifiedProjectionVector(vector,{...options,featureCount:2}),null);
 const held=retainVerifiedProjectionVector(vector,options);assert.ok(held);held.release();route.release();block.release();c.close();assert.equal(c.status().resources.chargedBytes,0);assert.equal(retainVerifiedProjectionVector(vector,options),null);
});
test('private rich resource profile reaches compiler scans; legacy and smaller limits stay bounded',()=>{
 const rich=createDiagnosticResourceConfiguration({profile:RICH_DIAGNOSTIC_RESOURCE_PROFILE}),c=createFeatureProjectionCompiler({...args(),resourceConfiguration:rich});try{assert.equal(c.status().workingBytes,256*1024**2);assert.throws(()=>createFeatureProjectionCompiler({...args(),workingBytes:256*1024**2}),/compiler_bounds/);assert.throws(()=>createFeatureProjectionCompiler({...args(),resourceConfiguration:rich,workingBytes:257*1024**2}),/compiler_bounds/);assert.throws(()=>createFeatureProjectionCompiler({...args(),resourceConfiguration:{...rich}}),/private_configuration_required/);}finally{c.close();assert.equal(rich.resourceArena.status().chargedBytes,0);}
 const smaller=createDiagnosticResourceConfiguration({profile:RICH_DIAGNOSTIC_RESOURCE_PROFILE,resourceArena:createDiagnosticResourceArena({maxBytes:512*1024**2}),journalOptions:{assetWorkingBytes:16*1024**2}}),small=createFeatureProjectionCompiler({...args(),resourceConfiguration:smaller});try{assert.equal(small.status().workingBytes,16*1024**2);}finally{small.close();assert.equal(smaller.resourceArena.status().chargedBytes,0);}
});
test('asset scans bind the explicitly selected existing logical profile independently of working memory',()=>{
 const legacy=createFeatureProjectionCompiler(args()),rich=createDiagnosticResourceConfiguration({profile:RICH_DIAGNOSTIC_RESOURCE_PROFILE}),full=createFeatureProjectionCompiler({...args(),capacityProfile:'R7_FULL300K',resourceConfiguration:rich});
 try{assert.equal(legacy.status().capacityProfile,'LEGACY_150K');assert.equal(legacy.status().scanMaxBytes,256*1024**2);assert.equal(legacy.status().scanMaxNodes,16000000);assert.equal(legacy.status().workingBytes,128*1024**2);assert.equal(full.status().capacityProfile,'R7_FULL300K');assert.equal(full.status().scanMaxBytes,4*1024**3);assert.equal(full.status().scanMaxNodes,128000000);assert.equal(full.status().workingBytes,256*1024**2);assert.throws(()=>createFeatureProjectionCompiler({...args(),capacityProfile:'unknown_full'}),/unknown_profile/);}
 finally{legacy.close();full.close();assert.equal(legacy.status().resources.chargedBytes,0);assert.equal(rich.resourceArena.status().chargedBytes,0);}
});
