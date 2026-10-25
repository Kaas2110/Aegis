/** Compile actual immutable semantics once; project current values per frame.
 * Declared hashes and shallow Object.freeze wrappers never mint ownership. */
import {digest,FAMILY_IDS,validateDefinition,projectionScopeRejection} from '../../feature-registry/registry-contract.mjs';
import {types} from 'node:util';
import {createDiagnosticResourceArena,snapshotPlainRecord} from './diagnosticResourceArena.mjs';
import {FEATURE_ASSET_WORKING_BYTES,inspectFeatureAsset,freezeFeatureAsset as freeze,hashFeatureAsset as hash,featureAssetRecord,retainFeatureAsset,withFeatureRelease} from './featureProjectionOwnership.mjs';
const SH=/^[a-f0-9]{64}$/,SCOPES=new Set(['prior_maps','current_identity','current_draft','current_live','series_context','previous_series_maps','candidate_axis']);
const verifiedSchemas=new WeakMap(),verifiedVectors=new WeakMap();
const fail=x=>{throw Error('unified_features:'+x);};
/** Only the actual-byte schema identity minted here is accepted. Lookalikes,
 * frozen JSON copies and a caller's declared hash cannot bypass verification. */
export function retainVerifiedProjectionSchema(schema,{expectedSchemaHash}={}){
 const verified=verifiedSchemas.get(schema);if(!verified||verified.record.value===null||expectedSchemaHash!==verified.descriptor.sha256)return null;
 const lease=retainFeatureAsset(verified.arena,verified.record);return lease?Object.freeze(withFeatureRelease({schema,descriptor:verified.descriptor},()=>lease.release())):null;
}
/** A row can be shared across target heads with the same ordered names. Its
 * private owner must survive async journal IO independently of route ownership;
 * target/source authority remains the separate verified schema lease. */
export function retainVerifiedProjectionVector(vector,{expectedNamesHash,featureCount}={}){
 const verified=verifiedVectors.get(vector);if(!verified||verified.record.value===null||expectedNamesHash!==verified.descriptor.namesSha256||featureCount!==verified.descriptor.featureCount)return null;
 const lease=retainFeatureAsset(verified.arena,verified.record);return lease?Object.freeze(withFeatureRelease({vector,descriptor:verified.descriptor},()=>lease.release())):null;
}
export function createFeatureProjectionCompiler({registry,registryHash,sourceInventory,sourceProfiles,maxSchemas=32,maxComponentSchemas=16,resourceArena=null,workingBytes=FEATURE_ASSET_WORKING_BYTES}={}){
 if(!Number.isSafeInteger(maxSchemas)||maxSchemas<1||maxSchemas>64||!Number.isSafeInteger(maxComponentSchemas)||maxComponentSchemas<1||maxComponentSchemas>32||!Number.isSafeInteger(workingBytes)||workingBytes<1024||workingBytes>FEATURE_ASSET_WORKING_BYTES)fail('compiler_bounds');
 const arena=resourceArena??createDiagnosticResourceArena();if(typeof arena?.reserve!=='function'||typeof arena?.retainAsset!=='function')fail('compiler_arena');
 const components=new Map(),plans=new Map(),metadataMemo=new WeakMap(),normalized=new WeakMap(),vectors=new WeakMap(),validatedDefinitions=new WeakSet();
 let closed=false,componentCompilations=0,projectionCompilations=0,componentEvictions=0,projectionEvictions=0,metadataIdentityHits=0,activeBlocks=0,activeRoutes=0,nextRow=0;
 const reserve=bytes=>{const r=arena.reserve(bytes);if(!r)fail('compiler_resource_admission');return r;};
 const hold=record=>{const r=retainFeatureAsset(arena,record);if(!r)fail('compiler_resource_admission');return r;};
 const ensure=()=>{if(closed)fail('compiler_closed');};
 const touch=(map,key,entry)=>{map.delete(key);map.set(key,entry);return entry;};
 function evict(map,component){const key=map.keys().next().value;if(key===undefined)return false;const e=map.get(key);map.delete(key);e.lease.release();if(component)componentEvictions++;else projectionEvictions++;return true;}
 // Capture configuration: external registry/inventory mutation must not change
 // the meaning of an admitted plan or definition.
 let owned,localRegistry,configuration;const setup=reserve(workingBytes);
 try{
  const input={sourceInventory,sourceProfiles,families:[...registry.families.values()],targets:[...registry.targets.values()]};
  const size=inspectFeatureAsset(input,{workingBytes});const creation=reserve(size.bytes*2+65536);
  try{owned=freeze(structuredClone(input));localRegistry={families:new Map(owned.families.map(f=>[f.id,f])),targets:new Map(owned.targets.map(t=>[t.id,t]))};configuration=featureAssetRecord(owned,size.bytes+owned.families.length*64+owned.targets.length*64);configuration.lease=hold(configuration);}finally{creation.release();}
 }finally{setup.release();}
 function cache(map,key,record,maximum,component){while(map.size>=maximum)evict(map,component);const lease=hold(record);map.set(key,{record,lease});}
 function normalize(component,id){
  ensure();if(!owned.sourceInventory[id]||!owned.sourceProfiles[id])fail('component_source_inventory:'+id);
  const wrapper=snapshotPlainRecord(component,{maxKeys:128}),vector=wrapper.vector?snapshotPlainRecord(wrapper.vector,{maxKeys:32}):null;
  const names=wrapper.names??vector?.names,values=wrapper.values??vector?.values,masks=wrapper.masks??vector?.masks,rawDefs=wrapper.definitions??vector?.definitions;
  if([names,values,masks,rawDefs].some(v=>types.isProxy(v))||!Array.isArray(names)||names.length>150000||!Array.isArray(values)||!Array.isArray(masks)||values.length!==names.length||masks.length!==names.length||!Array.isArray(rawDefs)||rawDefs.length!==names.length)fail('component_shape:'+id);
  const declaredSchema=wrapper.schemaHash??vector?.semanticSchemaHash??null;if(declaredSchema!==null&&!SH.test(declaredSchema))fail('component_schema_hash:'+id);
  const transient=reserve(workingBytes);let rowLease=null;
  try{
   let schemaRecord=null;const memo=metadataMemo.get(rawDefs);
   if(memo?.id===id&&memo.names===names&&memo.declaredSchema===declaredSchema&&memo.record.value!==null){schemaRecord=memo.record;metadataIdentityHits++;if(components.has(memo.cacheKey))touch(components,memo.cacheKey,components.get(memo.cacheKey));}
   if(!schemaRecord){
    const metadataSize=inspectFeatureAsset(rawDefs,{workingBytes}),namesSize=inspectFeatureAsset(names,{workingBytes}),immutable=Object.isFrozen(names)&&metadataSize.deeplyFrozen;
    if(new Set(names).size!==names.length)fail('component_name_collision:'+id);
    const creation=reserve(metadataSize.bytes*2+namesSize.bytes+names.length*2048+65536);
    try{
     const definitions=rawDefs.map((d,i)=>{
      if(typeof names[i]!=='string'||d?.name!==names[i])fail('component_column:'+id);
      const family=localRegistry.families.get(d.familyId);if(!family)fail('component_family:'+d.familyId);
      if(!Array.isArray(d.inputScopes)||d.inputScopes.some(s=>typeof s!=='string'))fail('component_input_scope:'+id);
      const inputScopes=[...new Set(d.inputScopes.map(s=>s==='prior_completed_maps'?'prior_maps':s))];if(inputScopes.some(s=>!SCOPES.has(s)))fail('component_input_scope:'+id);
      const out={contract:'aegis.executable-feature-definition.v1',id:id+':'+d.name,name:d.name,version:d.version??'1',familyId:d.familyId,formula:d.formula,formulaVersion:d.formulaVersion,units:d.units,dtype:d.dtype??d.type??'float64',missingPolicy:d.missingPolicy??'null_with_boolean_mask',timePolicy:d.timePolicy??'source dependencies no later than immutable cutoff; current receipt <= decision',sourceProfile:owned.sourceProfiles[id],learnedStatePolicy:'none',semanticStatus:'specified',inputScopes,allowedTargets:d.allowedTargets?d.allowedTargets.filter(t=>family.eligibleTargets.includes(t)):[...family.eligibleTargets],producer:{sourceSha256:owned.sourceInventory[id].primarySha256,symbol:{history:'produceHistoricalRelationalFeatures',live:'advanceObservedDraftFeatureBundle',series:'produceSeriesContext',draft:'produceDraftIdentityFeatures',seriesHistory:'produceSeriesHistoricalRelationalFeatures'}[id]}};
      for(const k of ['coordinate','minimumSupport','historyWindowDays','orientation','dictionarySha256','inputFields','historyDefinitions','legacyCounterpart','supportUnit','eventTimePolicy','availabilityTimePolicy','populationPolicy','rolePolicy','patchPolicy','gameClockPolicy','supportPolicy','phasePolicy','missingReasonPolicy'])if(d[k]!==undefined)out[k]=structuredClone(d[k]);return out;
     });
     const namesHash=hash(names),semanticHash=hash(definitions),cacheKey=digest({id,declaredSchema,namesHash,semanticHash});schemaRecord=components.get(cacheKey)?.record??null;
     if(schemaRecord)touch(components,cacheKey,components.get(cacheKey));
     else{const data=freeze({id,names:[...names],namesHash,definitions,componentSchemaHash:declaredSchema,semanticHash,sourceInventory:owned.sourceInventory[id]}),size=inspectFeatureAsset(data,{workingBytes});schemaRecord=featureAssetRecord(data,size.bytes,[configuration]);cache(components,cacheKey,schemaRecord,maxComponentSchemas,true);componentCompilations++;}
     if(immutable)metadataMemo.set(rawDefs,{id,names,declaredSchema,cacheKey,record:schemaRecord});
    }finally{creation.release();}
   }
   const schema=schemaRecord.value,rowBytes=65536+names.length*32,creation=reserve(rowBytes);let rowRecord;
   try{
    const rowValues=[],missing=[];
    for(let i=0;i<names.length;i++){
     // Metadata identity never authorizes reusing current values. Read plain
     // data descriptors so array accessors cannot run during row admission.
     const vd=Object.getOwnPropertyDescriptor(values,String(i)),md=Object.getOwnPropertyDescriptor(masks,String(i));if(!vd||!md||!('value'in vd)||!('value'in md))fail('component_column:'+id);
     const v=vd.value,m=md.value;if(v!==null&&(typeof v!=='number'||!Number.isFinite(v))||![0,1,false,true].includes(m)||Boolean(m)!==(v===null))fail('component_column:'+id);rowValues.push(v);missing.push(Boolean(m));
    }
    rowRecord=featureAssetRecord(freeze({values:rowValues,missing}),rowBytes,[schemaRecord]);rowLease=hold(rowRecord);
   }finally{creation.release();}
   let active=true;const out=withFeatureRelease({...schema,values:rowRecord.value.values,missing:rowRecord.value.missing},()=>{if(!active)return false;active=false;activeBlocks--;rowLease.release();return true;});
   normalized.set(out,{schemaRecord,rowRecord,rowId:++nextRow,isActive:()=>active});activeBlocks++;return Object.freeze(out);
  }catch(error){rowLease?.release();throw error;}finally{transient.release();}
 }
 function project(blocks,targetId,stateMode,semanticInputs=null,rowVectorCache=new Map()){
  ensure();if(!Array.isArray(blocks)||blocks.length>8||new Set(blocks.map(b=>b.id)).size!==blocks.length)fail('component_blocks');
  const bindings=blocks.map(b=>{const held=normalized.get(b);if(!held?.isActive())fail('component_ownership_required');return held;});
  const target=localRegistry.targets.get(targetId);if(!target||!target.stateModes.includes(stateMode))fail('projection_state_mode');
  const transient=reserve(workingBytes);let routeLease=null,planLease=null;
  try{
   const semanticSize=inspectFeatureAsset(semanticInputs,{workingBytes,maxBytes:1024*1024});
   const key=hash({targetId,stateMode,registryHash,components:blocks.map(b=>({id:b.id,schema:b.semanticHash,declared:b.componentSchemaHash})),semanticInputs});
   let planRecord=plans.get(key)?.record??null;if(planRecord)touch(plans,key,plans.get(key));
   if(!planRecord){
    const count=blocks.reduce((n,b)=>n+b.names.length,0);if(count>600000)fail('component_count_bound');const creation=reserve(131072+count*224+semanticSize.bytes*2);
    try{
     const names=[],definitions=[],parts=[],excluded=[],familyCounts=new Map();
     for(const b of blocks){const indices=[];for(let i=0;i<b.names.length;i++){
      const d=b.definitions[i],policyReason=projectionScopeRejection(d,targetId,stateMode),reason=({feature_target_ineligible:'family_or_definition_target_not_in_current_registry',allowed_targets:'family_or_definition_target_not_in_current_registry',dynamic_in_nonlive_projection:'current_live_unavailable_in_phase',draft_in_undrafted_projection:'current_draft_unavailable_in_phase',previous_series_scope:'previous_series_map_namespace'})[policyReason]??policyReason;
      if(reason){excluded.push({component:b.id,name:d.name,familyId:d.familyId,reason});continue;}
      if(!validatedDefinitions.has(d)){validateDefinition(d,localRegistry);validatedDefinitions.add(d);}indices.push(i);names.push(d.name);definitions.push(d);familyCounts.set(d.familyId,(familyCounts.get(d.familyId)??0)+1);
     }parts.push({id:b.id,indices});}
     if(names.length>150000)fail('projected_feature_count_bound');if(new Set(names).size!==names.length)fail('qualified_name_collision');
     const schema=freeze({contract:'aegis.unified-feature-projection-schema.v1',registryHash,targetId,stateMode,definitions,sourceInventory:owned.sourceInventory,componentSchemas:blocks.map(b=>({id:b.id,sha256:b.componentSchemaHash})),semanticInputs:structuredClone(semanticInputs)});
     const schemaHash=hash(schema),familyStatuses=FAMILY_IDS.map(familyId=>{const f=localRegistry.families.get(familyId),n=familyCounts.get(familyId)??0;return{familyId,eligibleInCanonicalTarget:f.eligibleTargets.includes(targetId),generatedColumnCount:n,status:n?'implemented_subset_requires_full_family_review':f.eligibleTargets.includes(targetId)?'not_generated_or_unavailable_in_phase':'not_eligible_in_canonical_target'};});
     const plan=freeze({schema,hash:schemaHash,names,namesHash:hash(names),parts,vectorSignature:hash(parts),familyStatuses,excluded});
     // Shared definitions/strings/configuration belong to dependencies. This
     // plan owns reference/index arrays, dispositions and its small header.
     planRecord=featureAssetRecord(plan,131072+count*32+excluded.length*192+semanticSize.bytes,[...bindings.map(b=>b.schemaRecord)]);cache(plans,key,planRecord,maxSchemas,false);projectionCompilations++;
     verifiedSchemas.set(schema,{arena,record:planRecord,descriptor:freeze({sha256:schemaHash,featureCount:names.length,namesSha256:plan.namesHash})});
    }finally{creation.release();}
   }
   planLease=hold(planRecord);
   const plan=planRecord.value,rowKey=plan.vectorSignature+'@'+bindings.map(b=>b.rowId).join(','),token=rowVectorCache.get(rowKey),cached=token&&vectors.get(token);let vectorRecord=cached?.value?cached:null;
   if(!vectorRecord){
    const bytes=65536+plan.names.length*32,creation=reserve(bytes);
    try{const values=[],missing=[],byId=new Map(blocks.map(b=>[b.id,b]));for(const p of plan.parts){const b=byId.get(p.id);for(const i of p.indices){values.push(b.values[i]);missing.push(b.missing[i]);}}vectorRecord=featureAssetRecord(freeze({names:plan.names,values,missing}),bytes,[planRecord]);routeLease=hold(vectorRecord);verifiedVectors.set(vectorRecord.value,{arena,record:vectorRecord,descriptor:freeze({namesSha256:plan.namesHash,featureCount:plan.names.length})});const ref=Object.freeze({contract:'aegis.private-row-vector.v1'});vectors.set(ref,vectorRecord);rowVectorCache.set(rowKey,ref);}finally{creation.release();}
   }else routeLease=hold(vectorRecord);
   let active=true;const out=withFeatureRelease({targetId,stateMode,schemaRef:{sha256:plan.hash,featureCount:plan.names.length,namesSha256:plan.namesHash},diagnosticSchema:plan.schema,diagnosticVector:vectorRecord.value,inferenceVector:null,familyStatuses:plan.familyStatuses,excludedDefinitions:plan.excluded,completenessScope:'explicit_generated_diagnostic_components_not_all79_families',eligibleForTraining:false,eligibleForServing:false},()=>{if(!active)return false;active=false;activeRoutes--;routeLease.release();planLease.release();return true;});activeRoutes++;return out;
  }catch(error){routeLease?.release();planLease?.release();throw error;}finally{transient.release();}
 }
 function getSchema(schemaHash){if(!SH.test(schemaHash))fail('schema_hash');for(const[key,e]of plans)if(e.record.value?.hash===schemaHash){touch(plans,key,e);return e.record.value.schema;}return null;}
 return Object.freeze({normalize,project,getSchema,retainSchema(schemaHash){const schema=getSchema(schemaHash);return schema?retainVerifiedProjectionSchema(schema,{expectedSchemaHash:schemaHash}):null;},close(){if(closed)return false;closed=true;for(const e of plans.values())e.lease.release();plans.clear();for(const e of components.values())e.lease.release();components.clear();configuration.lease.release();owned=null;localRegistry=null;return true;},status(){return{componentSchemas:components.size,projectionSchemas:plans.size,componentCompilations,projectionCompilations,componentEvictions,projectionEvictions,metadataIdentityHits,activeBlocks,activeRoutes,maxSchemas,maxComponentSchemas,closed,resources:arena.status?.()??null};}});
}
