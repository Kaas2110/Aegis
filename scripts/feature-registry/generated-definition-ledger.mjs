/** Pure metadata inventory from exact unified producer schemas. Captures every
 * generated variant and all catalogue families; it neither invents missing
 * semantic rules nor claims source coverage, formula review, training or serving. */
import {digest,FAMILY_IDS,TARGET_IDS,validateRegistry,validateProjection,canonicalSemanticDescriptor} from './registry-contract.mjs';
import {LEGACY_FEATURE_CAPACITY_PROFILE as LEGACY,FULL_FEATURE_CAPACITY_PROFILE as FULL,featureCapacityProfileForSchema} from '../steam-live-collector/source-adapter/featureCapacityProfiles.mjs';
import {measureBoundedJsonBytes,snapshotPlainRecord} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';

export const GENERATED_DEFINITION_LEDGER_CONTRACT='aegis.generated-definition-ledger.v1';
export const GENERATED_DEFINITION_LEDGER_FULL_CONTRACT='aegis.generated-definition-ledger.v2';
// Bulk clones/canonical strings remain a SMALL oracle. Full-scale full-profile
// schemas must use the private leased bounded auditor, never4GiB string copies.
export const FULL_PROFILE_BULK_ORACLE_LIMITS=Object.freeze({maxWireBytes:64*1024*1024,maxNodes:2000000});
const HASH=/^[a-f0-9]{64}$/,MAX_DEFINITIONS=300000,MAX_OCCURRENCES=2000000;
const flags={fullFeatureGateComplete:false,trainingAdmitted:false,servingAdmitted:false,observedAvailabilityMeasured:false,legacyAliasesResolved:false};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>obj(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const fail=reason=>{throw Error('definition_ledger:'+reason);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const ints=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const nonempty=x=>typeof x==='string'&&x.trim().length>0;
function inventory(input){
 if(!obj(input)||!HASH.test(input.primarySha256??'')||!Array.isArray(input.files)||!input.files.length||input.files.length>64||new Set(input.files.map(f=>f?.path)).size!==input.files.length)fail('source_inventory');
 for(const f of input.files)if(!exact(f,['path','sha256'])||!nonempty(f.path)||f.path.length>512||/^[a-z]:[\\/]|^\\\\|^\//i.test(f.path)||f.path.split(/[\\/]/).includes('..')||!HASH.test(f.sha256??''))fail('source_inventory_file');
 if(!input.files.some(f=>f.sha256===input.primarySha256))fail('source_inventory_primary');return input;
}
function declaration(d,key,predicate=()=>true){if(!Object.hasOwn(d,key))return null;if(!predicate(d[key]))fail('semantic_metadata:'+key);return structuredClone(d[key]);}
function semantics(d){
 const historical=d.inputScopes.some(x=>x==='prior_maps'||x==='previous_series_maps');
 const inputFields=declaration(d,'inputFields',x=>Array.isArray(x)&&x.every(nonempty));
 const supportUnit=declaration(d,'supportUnit',nonempty),minimumSupport=declaration(d,'minimumSupport',x=>x===null||ints(x,0,1000000)),historyWindowDays=declaration(d,'historyWindowDays',x=>x===null||typeof x==='number'&&Number.isFinite(x)&&x>0);
 const eventTimePolicy=declaration(d,'eventTimePolicy',nonempty),availabilityTimePolicy=declaration(d,'availabilityTimePolicy',nonempty);
 const rolePolicy=declaration(d,'rolePolicy',nonempty),patchPolicy=declaration(d,'patchPolicy',nonempty),populationPolicy=declaration(d,'populationPolicy',nonempty);
 const gameClockPolicy=declaration(d,'gameClockPolicy',nonempty),supportPolicy=declaration(d,'supportPolicy',nonempty),phasePolicy=declaration(d,'phasePolicy',nonempty),missingReasonPolicy=declaration(d,'missingReasonPolicy',nonempty);
 const gaps=[];if(inputFields===null||inputFields.length===0)gaps.push('exact_input_fields_not_declared');if(eventTimePolicy===null)gaps.push('separate_event_time_policy_not_declared');if(availabilityTimePolicy===null)gaps.push('separate_availability_time_policy_not_declared');
 if(historical&&supportUnit===null)gaps.push('historical_support_unit_not_declared');if(historical&&populationPolicy===null)gaps.push('historical_population_policy_not_declared');
 // An absent policy must not silently mean "irrelevant". Producers can declare
 // explicit not-applicable policies; the ledger cannot infer them from names.
 if(rolePolicy===null)gaps.push('role_policy_or_nonapplicability_not_declared');if(patchPolicy===null)gaps.push('patch_policy_or_nonapplicability_not_declared');
 if(d.inputScopes.includes('current_live')&&gameClockPolicy===null)gaps.push('current_game_clock_policy_not_declared');
 if(historical&&minimumSupport===null&&supportPolicy===null)gaps.push('minimum_support_or_nonapplicability_not_declared');
 if(phasePolicy===null)gaps.push('explicit_phase_policy_not_declared');if(missingReasonPolicy===null)gaps.push('missing_reason_policy_not_declared');
 const identity=canonicalSemanticDescriptor(d);for(const key of identity.missingFields)gaps.push('semantic_identity_unbound:'+key);
 const exactPolicies={};for(const key of ['inputBindings','orientation','coordinate','windowPolicy','weightPolicy','tiePolicy','variancePolicy','quantilePolicy','formulaParameters','learnedStateBinding','semanticVerification'])exactPolicies[key]=Object.hasOwn(d,key)?structuredClone(d[key]):null;
 return{inputs:{scopes:[...d.inputScopes],fields:inputFields,historyDefinitions:declaration(d,'historyDefinitions',Array.isArray)},formula:d.formula,formulaVersion:d.formulaVersion,units:d.units,dtype:d.dtype,missingPolicy:d.missingPolicy,missingReasonPolicy,time:{declaredTimePolicy:d.timePolicy,eventTimePolicy,availabilityTimePolicy,gameClockPolicy},support:{historicalDependency:historical,unit:supportUnit,minimumSupport,historyWindowDays,supportPolicy},phase:{allowedTargets:[...d.allowedTargets],explicitPolicy:phasePolicy},rolePolicy,patchPolicy,populationPolicy,exactPolicies,completeSemanticIdentity:identity.complete,metadataGaps:gaps};
}
function disposition(f,n){
 if(f.kind==='label_only')return'label_only';if(f.kind==='presentation_context')return'presentation_only';
 if(f.status==='learned_state_pending')return'TRAIN_only_deferred';if(f.status==='unavailable_input')return'unavailable_pending_source_or_rule_evidence';
 return n?'generated_subset_requires_semantic_review':'not_generated';
}
// Additive R6b seam: the exhaustive paged audit uses these exact functions.
// Keeping one implementation prevents a smaller audit from inferring richer
// policies than the bulk oracle. Callers must bound/own inputs before cloning.
export {semantics as captureGeneratedDefinitionSemantics,inventory as validateGeneratedDefinitionSourceInventory,disposition as generatedFamilyDisposition};
/** Legacy saved row shape stays byte-compatible. Full rows bind both the new
 * schema contract and explicit profile; absence never grants300000 capacity. */
export function generatedLedgerSchemaCapacity(row){
 if(!obj(row))fail('schema_capacity');
 if(!Object.hasOwn(row,'schemaContract')&&!Object.hasOwn(row,'capacityProfile'))return LEGACY;
 const capacity=featureCapacityProfileForSchema({contract:row.schemaContract,...(Object.hasOwn(row,'capacityProfile')?{capacityProfile:row.capacityProfile}:{})});
 if(capacity===LEGACY)fail('schema_capacity');return capacity;
}
/** schemas contains {schema,sha256} objects from producer.getSchema(ref). Never
 * infer feature formulas or aliases from column names or a family-level label. */
export function createGeneratedDefinitionLedger({index,familyDocument,targetDocument,schemas=[],limits={}}={}){
 const registry=validateRegistry(index,familyDocument,targetDocument),registryHash=digest({index,familyDocument,targetDocument});
 const maxDefinitions=limits.maxDefinitions??MAX_DEFINITIONS,maxOccurrences=limits.maxOccurrences??MAX_OCCURRENCES,maxSchemas=limits.maxSchemas??64;
 if(!ints(maxDefinitions,1,MAX_DEFINITIONS)||!ints(maxOccurrences,1,MAX_OCCURRENCES)||!ints(maxSchemas,1,64)||!Array.isArray(schemas)||schemas.length>maxSchemas)fail('bounds');
 const inputs=schemas.map(input=>{const wrapper=snapshotPlainRecord(input,{maxKeys:2});if(!exact(wrapper,['schema','sha256']))fail('schema_input');return wrapper;}),capacities=inputs.map(input=>featureCapacityProfileForSchema(input.schema));
 if(capacities.includes(FULL)){try{measureBoundedJsonBytes(inputs,{maxBytes:FULL_PROFILE_BULK_ORACLE_LIMITS.maxWireBytes,maxNodes:FULL_PROFILE_BULK_ORACLE_LIMITS.maxNodes});}catch{fail('full_profile_requires_bounded_streaming_audit');}}
 const definitions=new Map(),sourceInventories=new Map(),schemaRows=[],schemaSeen=new Set();let occurrenceCount=0;
 for(const [inputIndex,input] of inputs.entries()){
  const s=input.schema,capacity=capacities[inputIndex],full=capacity===FULL;
  if(!HASH.test(input?.sha256??'')||digest(s)!==input.sha256)fail('schema_hash');if(schemaSeen.has(input.sha256))continue;schemaSeen.add(input.sha256);
  if(!exact(s,['contract',...(full?['capacityProfile']:[]),'registryHash','targetId','stateMode','definitions','sourceInventory','componentSchemas','semanticInputs'])||s.registryHash!==registryHash||!Array.isArray(s.definitions)||s.definitions.length>capacity.maxFeatures||!obj(s.sourceInventory)||Object.keys(s.sourceInventory).length>16||!Array.isArray(s.componentSchemas)||s.componentSchemas.length>16)fail('schema_contract');
  if(s.definitions.length)validateProjection(s,registry);else if(!registry.targets.has(s.targetId)||!registry.targets.get(s.targetId).stateModes.includes(s.stateMode))fail('empty_schema_target');
  const sourceRefs={};for(const [component,raw]of Object.entries(s.sourceInventory)){if(!nonempty(component)||component.includes(':'))fail('component_id');const inv=inventory(raw),ref=digest(inv);sourceRefs[component]=ref;if(!sourceInventories.has(ref))sourceInventories.set(ref,structuredClone(inv));}
  for(const c of s.componentSchemas)if(!exact(c,['id','sha256'])||!Object.hasOwn(sourceRefs,c.id)||c.sha256!==null&&!HASH.test(c.sha256??''))fail('component_schema');
  schemaRows.push({sha256:input.sha256,...(full?{schemaContract:s.contract,capacityProfile:capacity.id}:{}),targetId:s.targetId,stateMode:s.stateMode,definitionCount:s.definitions.length,componentSchemas:structuredClone(s.componentSchemas),semanticInputs:structuredClone(s.semanticInputs),sourceInventoryRefs:sourceRefs});
  for(let i=0;i<s.definitions.length;i++){
   if(++occurrenceCount>maxOccurrences)fail('occurrence_bound');const d=s.definitions[i],component=d.id.slice(0,d.id.indexOf(':')),ref=sourceRefs[component],inv=sourceInventories.get(ref);
   if(!ref||inv.primarySha256!==d.producer.sourceSha256)fail('definition_source_binding');
   const definitionSha256=digest(d),variantSha256=digest({definitionSha256,sourceInventorySha256:ref});let row=definitions.get(variantSha256);
   if(!row){if(definitions.size>=maxDefinitions)fail('definition_bound');row={variantSha256,definitionSha256,definition:structuredClone(d),sourceInventorySha256:ref,semantics:semantics(d),occurrences:[],reviewStatus:'captured_actual_schema_declaration_not_semantic_acceptance',aliasOf:null};definitions.set(variantSha256,row);}
   row.occurrences.push({schemaSha256:input.sha256,targetId:s.targetId,stateMode:s.stateMode,index:i});
  }
 }
 const rows=[...definitions.values()].sort((a,b)=>a.variantSha256.localeCompare(b.variantSha256,'en')),byFamily=new Map(FAMILY_IDS.map(id=>[id,[]]));for(const row of rows)byFamily.get(row.definition.familyId).push(row);
 const families=FAMILY_IDS.map(id=>{const f=registry.families.get(id),generated=byFamily.get(id);return{familyId:id,catalogueKind:f.kind,catalogueStatus:f.status,disposition:disposition(f,generated.length),generatedVariantCount:generated.length,generatedVariantsWithMetadataGaps:generated.filter(x=>x.semantics.metadataGaps.length).length,variantSha256s:generated.map(x=>x.variantSha256),eligibleTargets:[...f.eligibleTargets],catalogueSpecification:{formula:f.formula,units:f.units,missingPolicy:f.missingPolicy,availabilityGate:f.availabilityGate},fullFamilyComplete:false,sourceAvailabilityAttested:false};});
 const legacyOccurrences=index.catalogues.map(c=>({catalogueId:c.id,count:c.count,occurrenceRange:{startInclusive:0,endExclusive:c.count},orderedNameHash:c.orderedNameHash,namesPin:structuredClone(c.namesPin),source:structuredClone(c.source),disposition:'unresolved_semantic_migration_no_alias_claim'}));
 const body={contract:schemaRows.some(s=>s.capacityProfile===FULL.id)?GENERATED_DEFINITION_LEDGER_FULL_CONTRACT:GENERATED_DEFINITION_LEDGER_CONTRACT,registryHash,schemas:schemaRows,sourceInventories:Object.fromEntries([...sourceInventories].sort(([a],[b])=>a.localeCompare(b,'en'))),definitions:rows,families,legacyOccurrences,counts:{schemas:schemaRows.length,generatedVariants:rows.length,generatedSchemaOccurrences:occurrenceCount,families:families.length,legacyCatalogueOccurrences:index.catalogueOccurrenceCount},evidenceMeaning:'Exact supplied producer schema metadata; not provider/source availability, formula correctness, legacy alias parity or model quality evidence.',...flags};
 return freeze({...body,contentHash:digest(body)});
}

/** Receipt integrity for a saved ledger. Rebuild from exact schemas for semantic
 * verification; a self-consistent edited ledger is not an authority by itself. */
export function verifyGeneratedDefinitionLedgerReceipt(ledger){
 if(!obj(ledger)||![GENERATED_DEFINITION_LEDGER_CONTRACT,GENERATED_DEFINITION_LEDGER_FULL_CONTRACT].includes(ledger.contract)||!HASH.test(ledger.contentHash??'')||Object.keys(flags).some(k=>ledger[k]!==false))fail('receipt_contract');
 const{contentHash,...body}=ledger;if(digest(body)!==contentHash)fail('receipt_hash');
 if(!Array.isArray(ledger.schemas))fail('receipt_schema_capacity');
 let fullRows=0;for(const row of ledger.schemas){const capacity=generatedLedgerSchemaCapacity(row);if(capacity===FULL)fullRows++;if(!ints(row.definitionCount,0,capacity.maxFeatures))fail('receipt_schema_capacity');}
 if((fullRows>0)!==(ledger.contract===GENERATED_DEFINITION_LEDGER_FULL_CONTRACT))fail('receipt_schema_capacity');
 if(ledger.families.length!==79||new Set(ledger.families.map(f=>f.familyId)).size!==79||FAMILY_IDS.some(id=>!ledger.families.some(f=>f.familyId===id))||ledger.families.some(f=>f.fullFamilyComplete!==false||f.sourceAvailabilityAttested!==false))fail('receipt_family_claim');
 if(ledger.definitions.some(d=>digest(d.definition)!==d.definitionSha256||digest({definitionSha256:d.definitionSha256,sourceInventorySha256:d.sourceInventorySha256})!==d.variantSha256||digest(ledger.sourceInventories[d.sourceInventorySha256])!==d.sourceInventorySha256||d.aliasOf!==null))fail('receipt_definition_binding');
 return{accepted:true,reason:'ledger_receipt_bytes_consistent',contentHash,semanticAcceptance:false,sourceAvailabilityAttested:false,...flags};
}

/** Compact disposition view of an already bounded exact ledger. Each definition
 * remains in its pinned ledger; this view counts occurrences without copying its
 * expanded formulas/support again. Missing schemas are explicit, never coverage.
 * This does not promote the integrity receipt into semantic/source acceptance. */
export function summarizeGeneratedDefinitionDispositions(ledger){
 verifyGeneratedDefinitionLedgerReceipt(ledger);
 const targets=new Map(),families=new Map(ledger.families.map(f=>[f.familyId,{familyId:f.familyId,catalogueKind:f.catalogueKind,catalogueStatus:f.catalogueStatus,disposition:f.disposition,generatedVariants:f.generatedVariantCount,eligibleTargets:[...f.eligibleTargets],catalogueSpecification:structuredClone(f.catalogueSpecification),sourceProfiles:new Set(),metadataGaps:new Set(),fullFamilyComplete:false,sourceAvailabilityAttested:false}]));
 // All twelve logical targets, including both modes of SERIES_LIVE, are present
 // even when the supplied immutable schema set does not contain those modes.
 for(const id of TARGET_IDS)for(const mode of id==='SERIES_LIVE'?['observed_postdraft','observed_live']:[id.startsWith('SERIES_')?id:id.split('_')[0]])targets.set(id+':'+mode,{targetId:id,stateMode:mode,scope:id.startsWith('SERIES_')?'whole_series':'selected_map',outcome:id.startsWith('SERIES_')?'series_team1_win':id.endsWith('_WIN')?'map_radiant_win':id.endsWith('_KILLS')?(id.startsWith('LIVE_')?'remaining_kills_distribution':'map_total_kills_distribution'):(id.startsWith('LIVE_')?'remaining_duration_seconds_distribution':'map_total_duration_seconds_distribution'),schemas:[],familyIds:new Set(),generatedVariants:new Set(),variantsWithMetadataGaps:new Set(),sourceProfiles:new Set(),phaseSchemaObserved:false,sourceAvailabilityAttested:false,modelTrained:false,productionServingWired:false});
 for(const s of ledger.schemas){const row=targets.get(s.targetId+':'+s.stateMode);if(!row)fail('summary_target_mode');row.schemas.push(s.sha256);row.phaseSchemaObserved=true;}
 for(const d of ledger.definitions){const family=families.get(d.definition.familyId);if(!family)fail('summary_family');family.sourceProfiles.add(d.definition.sourceProfile);for(const gap of d.semantics.metadataGaps)family.metadataGaps.add(gap);for(const occurrence of d.occurrences){const row=targets.get(occurrence.targetId+':'+occurrence.stateMode);if(!row||!row.schemas.includes(occurrence.schemaSha256))fail('summary_occurrence');row.familyIds.add(d.definition.familyId);row.generatedVariants.add(d.variantSha256);row.sourceProfiles.add(d.definition.sourceProfile);if(d.semantics.metadataGaps.length)row.variantsWithMetadataGaps.add(d.variantSha256);}}
 const toArray=s=>[...s].sort();
 const body={contract:'aegis.generated-definition-dispositions.v1',ledgerSha256:ledger.contentHash,registryHash:ledger.registryHash,targets:[...targets.values()].map(r=>({...r,schemas:[...r.schemas].sort(),familyIds:toArray(r.familyIds),generatedVariantCount:r.generatedVariants.size,generatedVariantsWithMetadataGaps:r.variantsWithMetadataGaps.size,generatedVariants:undefined,variantsWithMetadataGaps:undefined,sourceProfiles:toArray(r.sourceProfiles)})).map(({generatedVariants,variantsWithMetadataGaps,...r})=>r),families:[...families.values()].map(f=>({...f,sourceProfiles:toArray(f.sourceProfiles),metadataGaps:toArray(f.metadataGaps)})),legacyGroups:ledger.legacyOccurrences.map(c=>({catalogueId:c.catalogueId,count:c.count,orderedNameHash:c.orderedNameHash,disposition:c.disposition})),counts:{logicalTargets:12,targetModes:13,families:families.size,legacyGroups:ledger.legacyOccurrences.length},evidenceMeaning:'Supplied schema and exact-ledger inventory only; no measured joint source coverage or semantic/model/serving acceptance.',...flags};
 return freeze({...body,contentHash:digest(body)});
}
