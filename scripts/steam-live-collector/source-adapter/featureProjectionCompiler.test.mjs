import test from 'node:test';import assert from 'node:assert/strict';
import {createFeatureProjectionCompiler} from './featureProjectionCompiler.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {digest,validateRegistry} from '../../feature-registry/registry-contract.mjs';
const args=()=>{const [index,familyDocument,targetDocument]=syntheticRegistry();return{registry:validateRegistry(index,familyDocument,targetDocument),registryHash:digest(index),sourceInventory:{history:{primarySha256:'a'.repeat(64),files:[{path:'synthetic-history',sha256:'a'.repeat(64)}]}},sourceProfiles:{history:'synthetic-prior'}};};
const component=(value=1,version='1',scope='current_identity')=>({names:['synthetic.hist'],values:[value],masks:[Number(value===null)],schemaHash:digest({version,scope}),definitions:[{name:'synthetic.hist',familyId:'H02',formula:'synthetic source-backed constant',formulaVersion:version,units:'fraction',inputScopes:['prior_completed_maps',scope]}]});
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
