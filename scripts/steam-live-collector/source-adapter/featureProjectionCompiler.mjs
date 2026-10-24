/** Compile immutable semantics once; project only row values on later frames.
 * Component schemas come from owned producers, never client supplied vectors.
 */
import {digest,FAMILY_IDS,validateProjection,projectionScopeRejection} from '../../feature-registry/registry-contract.mjs';
const SH=/^[a-f0-9]{64}$/,SCOPES=new Set(['prior_maps','current_identity','current_draft','current_live','series_context','previous_series_maps','candidate_axis']);
const fail=x=>{throw Error('unified_features:'+x);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
export function createFeatureProjectionCompiler({registry,registryHash,sourceInventory,sourceProfiles,maxSchemas=32,maxComponentSchemas=16}={}){
 if(!Number.isSafeInteger(maxSchemas)||maxSchemas<1||maxSchemas>64||!Number.isSafeInteger(maxComponentSchemas)||maxComponentSchemas<1||maxComponentSchemas>32)fail('compiler_bounds');
 const components=new Map(),plans=new Map(),immutableComponents=new WeakMap();let componentCompilations=0,projectionCompilations=0;
 function normalize(component,id){
  if(!sourceInventory[id]||!sourceProfiles[id])fail('component_source_inventory:'+id);
  const held=Object.isFrozen(component)?immutableComponents.get(component):null;if(held?.id===id)return held;
  const names=component.names??component.vector?.names,values=component.values??component.vector?.values,masks=component.masks??component.vector?.masks,rawDefs=component.definitions??component.vector?.definitions;
  if(!Array.isArray(names)||names.length>150000||values?.length!==names.length||masks?.length!==names.length||rawDefs?.length!==names.length)fail('component_shape:'+id);
  for(let i=0;i<names.length;i++)if(typeof names[i]!=='string'||rawDefs[i]?.name!==names[i]||values[i]!==null&&(typeof values[i]!=='number'||!Number.isFinite(values[i]))||![0,1,false,true].includes(masks[i])||Boolean(masks[i])!==(values[i]===null))fail('component_column:'+id);
  const namesHash=digest(names),declaredSchema=component.schemaHash??component.vector?.semanticSchemaHash??null;
  if(declaredSchema!==null&&!SH.test(declaredSchema))fail('component_schema_hash:'+id);
  const cacheKey=declaredSchema===null?null:id+'@'+declaredSchema+'@'+namesHash;
  let schema=cacheKey?components.get(cacheKey):null;
  if(!schema){
   if(new Set(names).size!==names.length)fail('component_name_collision:'+id);
   const definitions=rawDefs.map(d=>{
    const family=registry.families.get(d.familyId);if(!family)fail('component_family:'+d.familyId);
    const inputScopes=[...new Set(d.inputScopes.map(s=>s==='prior_completed_maps'?'prior_maps':s))];if(inputScopes.some(s=>!SCOPES.has(s)))fail('component_input_scope:'+id);
    const out={contract:'aegis.executable-feature-definition.v1',id:id+':'+d.name,name:d.name,version:d.version??'1',familyId:d.familyId,formula:d.formula,formulaVersion:d.formulaVersion,units:d.units,dtype:d.dtype??d.type??'float64',missingPolicy:d.missingPolicy??'null_with_boolean_mask',timePolicy:d.timePolicy??'source dependencies no later than immutable cutoff; current receipt <= decision',sourceProfile:sourceProfiles[id],learnedStatePolicy:'none',semanticStatus:'specified',inputScopes,allowedTargets:d.allowedTargets?d.allowedTargets.filter(t=>family.eligibleTargets.includes(t)):[...family.eligibleTargets],producer:{sourceSha256:sourceInventory[id].primarySha256,symbol:{history:'produceHistoricalRelationalFeatures',live:'advanceObservedDraftFeatureBundle',series:'produceSeriesContext',draft:'produceDraftIdentityFeatures',seriesHistory:'produceSeriesHistoricalRelationalFeatures'}[id]}};
    for(const k of ['coordinate','minimumSupport','historyWindowDays','orientation','dictionarySha256','inputFields','historyDefinitions','legacyCounterpart'])if(d[k]!==undefined)out[k]=d[k];
    return out;
   });
   schema=freeze({id,names:[...names],namesHash,definitions,componentSchemaHash:declaredSchema,semanticHash:digest(definitions),sourceInventory:sourceInventory[id]});
   if(cacheKey){if(components.size>=maxComponentSchemas)fail('component_schema_cache_bound');components.set(cacheKey,schema);}
   componentCompilations++;
  }
  const out={...schema,values,missing:masks.map(Boolean)};if(Object.isFrozen(component))immutableComponents.set(component,out);return out;
 }
 function project(blocks,targetId,stateMode,semanticInputs=null,rowVectorCache=new Map()){
  const key=digest({targetId,stateMode,registryHash,components:blocks.map(b=>({id:b.id,schema:b.semanticHash})),semanticInputs});
  let plan=plans.get(key);
  if(!plan){
   if(plans.size>=maxSchemas)fail('schema_cache_bound');
   const names=[],definitions=[],parts=[],excluded=[],familyCounts=new Map();
   for(const b of blocks){const indices=[];for(let i=0;i<b.names.length;i++){
    const d=b.definitions[i],policyReason=projectionScopeRejection(d,targetId,stateMode),reason=({feature_target_ineligible:'family_or_definition_target_not_in_current_registry',allowed_targets:'family_or_definition_target_not_in_current_registry',dynamic_in_nonlive_projection:'current_live_unavailable_in_phase',draft_in_undrafted_projection:'current_draft_unavailable_in_phase',previous_series_scope:'previous_series_map_namespace'})[policyReason]??policyReason;
    if(reason){excluded.push({component:b.id,name:d.name,familyId:d.familyId,reason});continue;}
    indices.push(i);names.push(d.name);definitions.push(d);familyCounts.set(d.familyId,(familyCounts.get(d.familyId)??0)+1);
   }parts.push({id:b.id,indices});}
   if(names.length>150000)fail('projected_feature_count_bound');
   if(new Set(names).size!==names.length)fail('qualified_name_collision');
   if(definitions.length)validateProjection({targetId,stateMode,definitions},registry);
   const schema=freeze({contract:'aegis.unified-feature-projection-schema.v1',registryHash,targetId,stateMode,definitions,sourceInventory,componentSchemas:blocks.map(b=>({id:b.id,sha256:b.componentSchemaHash})),semanticInputs});
   const hash=digest(schema),familyStatuses=FAMILY_IDS.map(familyId=>{const f=registry.families.get(familyId),n=familyCounts.get(familyId)??0;return{familyId,eligibleInCanonicalTarget:f.eligibleTargets.includes(targetId),generatedColumnCount:n,status:n?'implemented_subset_requires_full_family_review':f.eligibleTargets.includes(targetId)?'not_generated_or_unavailable_in_phase':'not_eligible_in_canonical_target'};});
   plan={schema,hash,names:freeze(names),namesHash:digest(names),parts,vectorSignature:digest(parts),familyStatuses:freeze(familyStatuses),excluded:freeze(excluded)};
   plans.set(key,plan);projectionCompilations++;
  }
  let vector=rowVectorCache.get(plan.vectorSignature);
  if(!vector){const values=[],missing=[],byId=new Map(blocks.map(b=>[b.id,b]));for(const p of plan.parts){const b=byId.get(p.id);for(const i of p.indices){values.push(b.values[i]);missing.push(b.missing[i]);}}vector=freeze({names:plan.names,values,missing});rowVectorCache.set(plan.vectorSignature,vector);}
  return{targetId,stateMode,schemaRef:{sha256:plan.hash,featureCount:plan.names.length,namesSha256:plan.namesHash},diagnosticVector:vector,inferenceVector:null,familyStatuses:plan.familyStatuses,excludedDefinitions:plan.excluded,completenessScope:'explicit_generated_diagnostic_components_not_all79_families',eligibleForTraining:false,eligibleForServing:false};
 }
 return Object.freeze({normalize,project,getSchema(hash){if(!SH.test(hash))fail('schema_hash');for(const p of plans.values())if(p.hash===hash)return p.schema;return null;},status(){return{componentSchemas:components.size,projectionSchemas:plans.size,componentCompilations,projectionCompilations,maxSchemas,maxComponentSchemas};}});
}
