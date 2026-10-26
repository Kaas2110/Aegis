import test from 'node:test';import assert from 'node:assert/strict';
import {compileFeatureFunctionContract,readFeatureFunctionDefinition} from './featureFunctionContract.mjs';
import {hashFeatureAsset} from './featureProjectionOwnership.mjs';
function schema(team=100,{windowDays=30,units='fraction',missingPolicy='null_with_boolean_mask',sourceHash='a'.repeat(64),hero=1}={}){
 const parameters={windowDays,hero,selector:{teamId:team}},classification={contract:'aegis.feature-parameter-classification.v1',functionParameters:{windowDays,hero,selector:{kind:'current_identity_binding',field:'teamId',side:'radiant'}},rowParameters:{selector:{teamId:team}},classifiedKeys:Object.keys(parameters),unclassifiedKeys:[]};
 return{contract:'aegis.unified-feature-projection-schema.v1',registryHash:'b'.repeat(64),targetId:'LIVE_MAP_WIN',stateMode:'LIVE',sourceInventory:{history:{primarySha256:sourceHash}},semanticInputs:null,definitions:[{id:'history:team.form',name:'team.form',version:'1',familyId:'H02',formula:'wins divided by exact support under current selected team and window',formulaVersion:'1',units,dtype:'float64',missingPolicy,sourceProfile:'local_prior_completed_map_facts',inputScopes:['prior_maps'],formulaParameters:parameters,parameterClassification:classification,dependencyRefs:[{kind:'input',port:{normalizedField:'currentSelector.teamId',units:'nominal_team_id'}}],producer:{sourceSha256:sourceHash,symbol:'produceHistoricalRelationalFeatures'}}]};
}
test('different runtime teams share a declared function while row/legacy identities remain distinct',()=>{
 const a=schema(100),b=schema(200),x=compileFeatureFunctionContract(a),y=compileFeatureFunctionContract(b);assert.equal(x.generalized,true);assert.equal(x.sha256,y.sha256);assert.notEqual(x.rowParameterBindingsSha256,y.rowParameterBindingsSha256);assert.notEqual(hashFeatureAsset(a),hashFeatureAsset(b));assert.equal(readFeatureFunctionDefinition(a,0).formulaParameters.selector.kind,'current_identity_binding');assert.equal(a.definitions[0].formulaParameters.selector.teamId,100);
});
test('formula/unit/window/missing rules/fixed hero coordinates change function identity',()=>{
 const base=compileFeatureFunctionContract(schema()).sha256;
 for(const change of [{windowDays:7},{units:'seconds'},{missingPolicy:'strict_profile_required'},{hero:2}])assert.notEqual(compileFeatureFunctionContract(schema(100,change)).sha256,base);
 const formula=schema();formula.definitions[0].formula='different arithmetic';assert.notEqual(compileFeatureFunctionContract(formula).sha256,base);
 const dependency=schema();dependency.definitions[0].dependencyRefs[0].port.units='ordinal_strength';assert.notEqual(compileFeatureFunctionContract(dependency).sha256,base);
});
test('producer deployment compatibility is separate and still mandatory',()=>{
 const a=compileFeatureFunctionContract(schema()),b=compileFeatureFunctionContract(schema(100,{sourceHash:'c'.repeat(64)}));assert.equal(a.sha256,b.sha256);assert.notEqual(a.producerCompatibilitySha256,b.producerCompatibilitySha256);assert.equal(a.eligibleForTraining,false);assert.equal(a.eligibleForServing,false);
});
test('an added unclassified parameter is rejected and absent classification remains literal/unqualified',()=>{
 const x=schema();x.definitions[0].formulaParameters.unreviewedFuturePolicy='unknown';assert.throws(()=>compileFeatureFunctionContract(x),/parameter_classification/);
 const a=schema(100),b=schema(200);delete a.definitions[0].parameterClassification;delete b.definitions[0].parameterClassification;const p=compileFeatureFunctionContract(a),q=compileFeatureFunctionContract(b);assert.equal(p.generalized,false);assert.equal(p.unclassifiedDefinitionCount,1);assert.notEqual(p.sha256,q.sha256);
});
test('top-level row-field substitution cannot erase numerical/source dependencies',()=>{
 const x=schema();x.definitions[0].rowInstanceFieldNames=['units'];x.definitions[0].functionFieldSubstitutions={units:'removed'};assert.throws(()=>compileFeatureFunctionContract(x),/row_field_classification/);
 const y=schema();y.definitions[0].rowInstanceFieldNames=['runtimeSelector'];y.definitions[0].runtimeSelector={teamId:100};y.definitions[0].functionFieldSubstitutions={};assert.throws(()=>compileFeatureFunctionContract(y),/row_field_substitution/);
});
