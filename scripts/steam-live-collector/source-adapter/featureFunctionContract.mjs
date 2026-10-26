/** Versioned function identity. This is a content contract, not source/row
 * authority. Legacy schema SHA retains its complete instance-bearing meaning.
 * Only a factory's exact classification can replace parameters with selector
 * grammar; unknown keys are retained literally and block generalization. */
import {createHash} from 'node:crypto';
import {hashFeatureAsset,freezeFeatureAsset} from './featureProjectionOwnership.mjs';
export const FEATURE_FUNCTION_CONTRACT='aegis.feature-function-contract.v1';
export const PARAMETER_CLASSIFICATION_CONTRACT='aegis.feature-parameter-classification.v1';
const fail=x=>{throw Error('feature_function_contract:'+x);};
const sameKeys=(a,b)=>Array.isArray(a)&&a.every(x=>typeof x==='string')&&new Set(a).size===a.length&&[...a].sort().join('\0')===Object.keys(b).sort().join('\0');
function transformDefinition(d){
 if(!d||typeof d!=='object'||typeof d.id!=='string'||typeof d.formula!=='string'||typeof d.formulaVersion!=='string')fail('definition');
 const classification=d.parameterClassification,parameters=d.formulaParameters??{},out={...d};let generalized=true,rowParameters=null;
 delete out.parameterClassification;
 if(classification!==undefined){
  if(classification?.contract!==PARAMETER_CLASSIFICATION_CONTRACT||!sameKeys(classification.classifiedKeys,parameters)||!classification.functionParameters||typeof classification.functionParameters!=='object'||Array.isArray(classification.functionParameters)||!classification.rowParameters||typeof classification.rowParameters!=='object'||Array.isArray(classification.rowParameters)||!Array.isArray(classification.unclassifiedKeys)||classification.unclassifiedKeys.length)fail('parameter_classification');
  out.formulaParameters=classification.functionParameters;rowParameters=classification.rowParameters;
 }else if(Object.keys(parameters).length){
  // Exact-literal fallback preserves semantics but makes no claim that actual
  // IDs have been separated. A later metadata key must never disappear silently.
  generalized=false;
 }
 if(d.rowInstanceFieldNames!==undefined){
  if(!Array.isArray(d.rowInstanceFieldNames)||d.rowInstanceFieldNames.length>32||new Set(d.rowInstanceFieldNames).size!==d.rowInstanceFieldNames.length||d.rowInstanceFieldNames.some(k=>typeof k!=='string'||!Object.hasOwn(d,k)||['id','name','formula','formulaVersion','units','dtype','missingPolicy','sourceProfile','inputScopes','allowedTargets','inputBindings','dependencyRefs'].includes(k)))fail('row_field_classification');
  const substitutions=d.functionFieldSubstitutions??{};if(!sameKeys(d.rowInstanceFieldNames,substitutions))fail('row_field_substitution');
  for(const key of d.rowInstanceFieldNames)out[key]=substitutions[key];
  delete out.rowInstanceFieldNames;delete out.functionFieldSubstitutions;
 }
 // Code deployment identity is mandatory but a separate compatibility field.
 // This exact known producer field is not a formula constant or a current ID.
 if(d.producer&&typeof d.producer==='object'){out.producer={...d.producer};delete out.producer.sourceSha256;}
 return{definition:out,generalized,rowParameters};
}
/** Bounded-memory descriptor: hashes ordered complete semantic definitions one
 * at a time. Definition pages are obtained through readFeatureFunctionDefinition,
 * so the summary never duplicates a 150K-column metadata graph. */
export function compileFeatureFunctionContract(schema){
 if(!schema||!Array.isArray(schema.definitions)||schema.definitions.length>300000)fail('schema');
 const semantics=createHash('sha256'),ids=createHash('sha256'),rows=createHash('sha256');let unclassifiedDefinitionCount=0;
 semantics.update('[');ids.update('[');rows.update('[');
 for(let i=0;i<schema.definitions.length;i++){
  const d=schema.definitions[i],x=transformDefinition(d);if(i){semantics.update(',');ids.update(',');rows.update(',');}
  semantics.update(JSON.stringify(hashFeatureAsset(x.definition)));ids.update(JSON.stringify(d.id));rows.update(JSON.stringify(hashFeatureAsset(x.rowParameters)));if(!x.generalized)unclassifiedDefinitionCount++;
 }
 semantics.update(']');ids.update(']');rows.update(']');
 const header={contract:FEATURE_FUNCTION_CONTRACT,definitionEncoding:'ordered exact semantic-definition SHA256 leaves; canonical feature-asset hash v1',parameterClassificationContract:PARAMETER_CLASSIFICATION_CONTRACT,targetId:schema.targetId,stateMode:schema.stateMode,registrySha256:schema.registryHash,featureCount:schema.definitions.length,orderedDefinitionIdsSha256:ids.digest('hex'),orderedSemanticsSha256:semantics.digest('hex'),projectionPolicy:'canonical registry target/phase scope v1',semanticInputs:schema.semanticInputs??null};
 return freezeFeatureAsset({...header,sha256:hashFeatureAsset(header),producerCompatibilitySha256:hashFeatureAsset(schema.sourceInventory),rowParameterBindingsSha256:rows.digest('hex'),generalized:unclassifiedDefinitionCount===0,unclassifiedDefinitionCount,legacyDiagnosticSchemaMeaningUnchanged:true,eligibleForTraining:false,eligibleForServing:false});
}
export function readFeatureFunctionDefinition(schema,index){
 if(!Number.isSafeInteger(index)||index<0||index>=schema?.definitions?.length)fail('definition_index');
 return freezeFeatureAsset(transformDefinition(schema.definitions[index]).definition);
}
