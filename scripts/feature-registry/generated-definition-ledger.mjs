/** Pure metadata inventory from exact unified producer schemas. Captures every
 * generated variant and all catalogue families; it neither invents missing
 * semantic rules nor claims source coverage, formula review, training or serving. */
import {digest,FAMILY_IDS,validateRegistry,validateProjection} from './registry-contract.mjs';

export const GENERATED_DEFINITION_LEDGER_CONTRACT='aegis.generated-definition-ledger.v1';
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
 const inputFields=declaration(d,'inputFields',x=>Array.isArray(x)&&x.length>0&&x.every(nonempty));
 const supportUnit=declaration(d,'supportUnit',nonempty),minimumSupport=declaration(d,'minimumSupport',x=>ints(x,0,1000000)),historyWindowDays=declaration(d,'historyWindowDays',x=>typeof x==='number'&&Number.isFinite(x)&&x>0);
 const eventTimePolicy=declaration(d,'eventTimePolicy',nonempty),availabilityTimePolicy=declaration(d,'availabilityTimePolicy',nonempty);
 const rolePolicy=declaration(d,'rolePolicy',nonempty),patchPolicy=declaration(d,'patchPolicy',nonempty),populationPolicy=declaration(d,'populationPolicy',nonempty);
 const gaps=[];if(inputFields===null)gaps.push('exact_input_fields_not_declared');if(eventTimePolicy===null)gaps.push('separate_event_time_policy_not_declared');if(availabilityTimePolicy===null)gaps.push('separate_availability_time_policy_not_declared');
 if(historical&&supportUnit===null)gaps.push('historical_support_unit_not_declared');if(historical&&populationPolicy===null)gaps.push('historical_population_policy_not_declared');
 return{inputs:{scopes:[...d.inputScopes],fields:inputFields,historyDefinitions:declaration(d,'historyDefinitions',Array.isArray)},formula:d.formula,formulaVersion:d.formulaVersion,units:d.units,dtype:d.dtype,missingPolicy:d.missingPolicy,time:{declaredTimePolicy:d.timePolicy,eventTimePolicy,availabilityTimePolicy},support:{historicalDependency:historical,unit:supportUnit,minimumSupport,historyWindowDays},rolePolicy,patchPolicy,populationPolicy,metadataGaps:gaps};
}
function disposition(f,n){
 if(f.kind==='label_only')return'label_only';if(f.kind==='presentation_context')return'presentation_only';
 if(f.status==='learned_state_pending')return'TRAIN_only_deferred';if(f.status==='unavailable_input')return'unavailable_pending_source_or_rule_evidence';
 return n?'generated_subset_requires_semantic_review':'not_generated';
}
/** schemas contains {schema,sha256} objects from producer.getSchema(ref). Never
 * infer feature formulas or aliases from column names or a family-level label. */
export function createGeneratedDefinitionLedger({index,familyDocument,targetDocument,schemas=[],limits={}}={}){
 const registry=validateRegistry(index,familyDocument,targetDocument),registryHash=digest({index,familyDocument,targetDocument});
 const maxDefinitions=limits.maxDefinitions??MAX_DEFINITIONS,maxOccurrences=limits.maxOccurrences??MAX_OCCURRENCES,maxSchemas=limits.maxSchemas??64;
 if(!ints(maxDefinitions,1,MAX_DEFINITIONS)||!ints(maxOccurrences,1,MAX_OCCURRENCES)||!ints(maxSchemas,1,64)||!Array.isArray(schemas)||schemas.length>maxSchemas)fail('bounds');
 const definitions=new Map(),sourceInventories=new Map(),schemaRows=[],schemaSeen=new Set();let occurrenceCount=0;
 for(const input of schemas){
  const s=input?.schema;if(!HASH.test(input?.sha256??'')||digest(s)!==input.sha256)fail('schema_hash');if(schemaSeen.has(input.sha256))continue;schemaSeen.add(input.sha256);
  if(!exact(s,['contract','registryHash','targetId','stateMode','definitions','sourceInventory','componentSchemas','semanticInputs'])||s.contract!=='aegis.unified-feature-projection-schema.v1'||s.registryHash!==registryHash||!Array.isArray(s.definitions)||s.definitions.length>150000||!obj(s.sourceInventory)||Object.keys(s.sourceInventory).length>16||!Array.isArray(s.componentSchemas)||s.componentSchemas.length>16)fail('schema_contract');
  if(s.definitions.length)validateProjection(s,registry);else if(!registry.targets.has(s.targetId)||!registry.targets.get(s.targetId).stateModes.includes(s.stateMode))fail('empty_schema_target');
  const sourceRefs={};for(const [component,raw]of Object.entries(s.sourceInventory)){if(!nonempty(component)||component.includes(':'))fail('component_id');const inv=inventory(raw),ref=digest(inv);sourceRefs[component]=ref;if(!sourceInventories.has(ref))sourceInventories.set(ref,structuredClone(inv));}
  for(const c of s.componentSchemas)if(!exact(c,['id','sha256'])||!Object.hasOwn(sourceRefs,c.id)||c.sha256!==null&&!HASH.test(c.sha256??''))fail('component_schema');
  schemaRows.push({sha256:input.sha256,targetId:s.targetId,stateMode:s.stateMode,definitionCount:s.definitions.length,componentSchemas:structuredClone(s.componentSchemas),semanticInputs:structuredClone(s.semanticInputs),sourceInventoryRefs:sourceRefs});
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
 const body={contract:GENERATED_DEFINITION_LEDGER_CONTRACT,registryHash,schemas:schemaRows,sourceInventories:Object.fromEntries([...sourceInventories].sort(([a],[b])=>a.localeCompare(b,'en'))),definitions:rows,families,legacyOccurrences,counts:{schemas:schemaRows.length,generatedVariants:rows.length,generatedSchemaOccurrences:occurrenceCount,families:families.length,legacyCatalogueOccurrences:index.catalogueOccurrenceCount},evidenceMeaning:'Exact supplied producer schema metadata; not provider/source availability, formula correctness, legacy alias parity or model quality evidence.',...flags};
 return freeze({...body,contentHash:digest(body)});
}

/** Receipt integrity for a saved ledger. Rebuild from exact schemas for semantic
 * verification; a self-consistent edited ledger is not an authority by itself. */
export function verifyGeneratedDefinitionLedgerReceipt(ledger){
 if(!obj(ledger)||ledger.contract!==GENERATED_DEFINITION_LEDGER_CONTRACT||!HASH.test(ledger.contentHash??'')||Object.keys(flags).some(k=>ledger[k]!==false))fail('receipt_contract');
 const{contentHash,...body}=ledger;if(digest(body)!==contentHash)fail('receipt_hash');
 if(ledger.families.length!==79||new Set(ledger.families.map(f=>f.familyId)).size!==79||FAMILY_IDS.some(id=>!ledger.families.some(f=>f.familyId===id))||ledger.families.some(f=>f.fullFamilyComplete!==false||f.sourceAvailabilityAttested!==false))fail('receipt_family_claim');
 if(ledger.definitions.some(d=>digest(d.definition)!==d.definitionSha256||digest({definitionSha256:d.definitionSha256,sourceInventorySha256:d.sourceInventorySha256})!==d.variantSha256||digest(ledger.sourceInventories[d.sourceInventorySha256])!==d.sourceInventorySha256||d.aliasOf!==null))fail('receipt_definition_binding');
 return{accepted:true,reason:'ledger_receipt_bytes_consistent',contentHash,semanticAcceptance:false,sourceAvailabilityAttested:false,...flags};
}
