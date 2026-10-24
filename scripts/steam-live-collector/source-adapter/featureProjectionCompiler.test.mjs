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
test('failed new schemas do not accumulate and existing compiled schemas remain usable',()=>{
 const c=createFeatureProjectionCompiler({...args(),maxSchemas:2});
 for(const version of ['1','2'])c.project([c.normalize(component(1,version),'history')],'PRE_MAP_WIN','PRE');
 for(const version of ['3','4','5'])assert.throws(()=>c.project([c.normalize(component(1,version),'history')],'PRE_MAP_WIN','PRE'),/schema_cache_bound/);
 assert.equal(c.status().projectionSchemas,2);assert.equal(c.project([c.normalize(component(8,'1'),'history')],'PRE_MAP_WIN','PRE').diagnosticVector.values[0],8);
});
test('draft-only values never enter PRE; compiled plans retain explicit exclusion',()=>{
 const c=createFeatureProjectionCompiler(args()),p=c.project([c.normalize(component(7,'1','current_draft'),'history')],'PRE_MAP_WIN','PRE');
 assert.equal(p.diagnosticVector.values.length,0);assert.equal(p.excludedDefinitions[0].reason,'current_draft_unavailable_in_phase');
 assert.throws(()=>c.normalize({...component(),masks:[false],values:[null]},'history'),/component_column/);
});
