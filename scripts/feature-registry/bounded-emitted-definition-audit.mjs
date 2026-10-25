/** Exhaustive declaration audit over an ORIGINAL compiler-owned schema.
 * One definition is inspected, hashed and interpreted at a time. No bulk clone,
 * full-schema canonical string, variant set or expanded findings array exists.
 * The compiler's private actual-byte lease binds identity/unique ordered names;
 * this module never mints a subset schema or treats declarations as availability.
 */
import {createHash} from 'node:crypto';
import {FAMILY_IDS,TARGET_IDS,validateRegistry,validateDefinition,projectionScopeRejection} from './registry-contract.mjs';
import {captureGeneratedDefinitionSemantics,validateGeneratedDefinitionSourceInventory,generatedFamilyDisposition} from './generated-definition-ledger.mjs';
import {retainVerifiedProjectionSchema} from '../steam-live-collector/source-adapter/featureProjectionCompiler.mjs';
import {measureBoundedJsonBytes,snapshotPlainRecord} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
import {inspectFeatureAsset,freezeFeatureAsset as freeze,hashFeatureAsset as hash,featureAssetRecord,retainFeatureAsset,withFeatureRelease} from '../steam-live-collector/source-adapter/featureProjectionOwnership.mjs';

export const BOUNDED_EMITTED_AUDIT_CONTRACT='aegis.bounded-emitted-definition-audit.v1';
const MiB=1024**2,HASH=/^[a-f0-9]{64}$/;
export const BOUNDED_EMITTED_AUDIT_LIMITS=Object.freeze({workingBytes:64*MiB,pageWorkingBytes:128*MiB,maxDefinitionWireBytes:MiB,maxDefinitionAssetBytes:8*MiB,maxDefinitionNodes:65536,maxDefinitions:150000,maxPageDefinitions:128,maxPageWireBytes:4*MiB,maxPageAssetBytes:16*MiB,maxPageNodes:262144});
const L=BOUNDED_EMITTED_AUDIT_LIMITS,fail=x=>{throw Error('bounded_definition_audit:'+x);};
const flags=Object.freeze({semanticAcceptance:false,fullFeatureGateComplete:false,sourceAvailabilityAttested:false,observedAvailabilityMeasured:false,legacyAliasesResolved:false,trainingAdmitted:false,servingAdmitted:false});
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const modes=id=>id==='SERIES_LIVE'?['observed_postdraft','observed_live']:[id.startsWith('SERIES_')?id:id.split('_')[0]];
const sorted=s=>[...s].sort();
function orderedHash(){const h=createHash('sha256');let n=0;h.update('[');return{add(value){if(n++)h.update(',');h.update(JSON.stringify(value));},finish(){h.update(']');return h.digest('hex');}};}
function bounded(value,{wire=MiB,asset=8*MiB,nodes=65536,work=L.workingBytes}={}){
 const wireBytes=measureBoundedJsonBytes(value,{maxBytes:wire,maxNodes:nodes,maxDepth:64});
 const size=inspectFeatureAsset(value,{workingBytes:work,maxBytes:asset,maxNodes:nodes});return{...size,wireBytes};
}
function definitionSize(d){return bounded(d,{wire:L.maxDefinitionWireBytes,asset:L.maxDefinitionAssetBytes,nodes:L.maxDefinitionNodes});}
function finding(d,index,sourceRef){
 const definitionSha256=hash(d),variantSha256=hash({definitionSha256,sourceInventorySha256:sourceRef});
 return{index,definitionId:d.id,name:d.name,familyId:d.familyId,definitionSha256,variantSha256,sourceInventorySha256:sourceRef,semantics:captureGeneratedDefinitionSemantics(d),aliasOf:null};
}

/** Engineering admission, not a V8/RSS guarantee: one definition is <=1MiB
 * expanded JSON, <=8MiB estimated asset and <=65536 nodes.64MiB covers four
 * asset copies +256bytes/node +4 wire copies +8MiB overhead (<=60MiB), including
 * scan sets, clone/hash temporaries and a single semantics finding. Pages have
 * separate128MiB admission:4*16MiB +128*262144 +4*4MiB +8MiB =120MiB.
 * Persistent owned metadata is measured separately. Root's owned process cap
 * remains authoritative; original compiler schema ownership stays charged.
 */
export function createBoundedEmittedDefinitionAudit({index,familyDocument,targetDocument,resourceArena,shouldContinue=()=>true}={}){
 if(typeof resourceArena?.reserve!=='function'||typeof resourceArena?.retainAsset!=='function'||typeof shouldContinue!=='function')fail('configuration');
 const arena=resourceArena,reserve=bytes=>{const r=arena.reserve(bytes);if(!r)fail('resource_admission');return r;};
 const hold=record=>{const r=retainFeatureAsset(arena,record);if(!r)fail('resource_admission');return r;};
 let closed=false,busy=false,configuration=null,configurationLease=null,owned=null,registry=null,registryHash=null;
 const setup=reserve(L.workingBytes);
 try{
  const input={index,familyDocument,targetDocument},size=bounded(input);owned=freeze(structuredClone(input));
  registry=validateRegistry(owned.index,owned.familyDocument,owned.targetDocument);registryHash=hash(owned);
  configuration=featureAssetRecord(owned,size.bytes+65536);configurationLease=hold(configuration);
 }finally{setup.release();}
 const ensure=()=>{if(closed)fail('closed');};
 const checkpoint=()=>{if(shouldContinue()!==true)fail('cancelled');ensure();};
 function auditSchema(input){
  ensure();if(busy)fail('busy');busy=true;
  let work=null,schemaLease=null,configLease=null,receiptLease=null;
  try{
   work=reserve(L.workingBytes);checkpoint();const wrapper=snapshotPlainRecord(input,{maxKeys:2});
   if(!exact(wrapper,['schema','sha256'])||!HASH.test(wrapper.sha256??''))fail('schema_input');
   schemaLease=retainVerifiedProjectionSchema(wrapper.schema,{expectedSchemaHash:wrapper.sha256});if(!schemaLease)fail('private_schema_ownership_required');
   configLease=hold(configuration);let schema=schemaLease.schema;const descriptor=schemaLease.descriptor;
   if(!exact(schema,['contract','registryHash','targetId','stateMode','definitions','sourceInventory','componentSchemas','semanticInputs'])||schema.contract!=='aegis.unified-feature-projection-schema.v1'||schema.registryHash!==registryHash||!Array.isArray(schema.definitions)||schema.definitions.length>L.maxDefinitions||schema.definitions.length!==descriptor.featureCount||!registry.targets.get(schema.targetId)?.stateModes.includes(schema.stateMode))fail('schema_contract');
   const header={sourceInventory:schema.sourceInventory,componentSchemas:schema.componentSchemas,semanticInputs:schema.semanticInputs};bounded(header,{wire:2*MiB});
   if(!schema.sourceInventory||Object.keys(schema.sourceInventory).length>16||!Array.isArray(schema.componentSchemas)||schema.componentSchemas.length>16)fail('schema_header');
   const sourceRefs={},sourceInventories={};
   for(const [component,raw]of Object.entries(schema.sourceInventory)){
    if(!component.trim()||component.includes(':'))fail('component_id');const inv=validateGeneratedDefinitionSourceInventory(raw),ref=hash(inv);Object.defineProperty(sourceRefs,component,{value:ref,enumerable:true,writable:true,configurable:true});sourceInventories[ref]=structuredClone(inv);
   }
   for(const c of schema.componentSchemas)if(!exact(c,['id','sha256'])||!Object.hasOwn(sourceRefs,c.id)||c.sha256!==null&&!HASH.test(c.sha256??''))fail('component_schema');
   const byFamily=new Map(FAMILY_IDS.map(id=>[id,{count:0,gapped:0,gaps:new Set(),sourceProfiles:new Set()}]));
   const gapCounts={},profiles=new Set(),dynamicProfiles=new Set(),namesRoot=orderedHash(),findingsRoot=orderedHash();let withGaps=0;
   for(let i=0;i<schema.definitions.length;i++){
    if(i%256===0)checkpoint();const d=schema.definitions[i];definitionSize(d);validateDefinition(d,registry);
    const rejection=projectionScopeRejection(d,schema.targetId,schema.stateMode);if(rejection)fail('projection_scope:'+rejection);
    const component=d.id.slice(0,d.id.indexOf(':')),ref=sourceRefs[component];if(!ref||schema.sourceInventory[component].primarySha256!==d.producer.sourceSha256)fail('definition_source_binding');
    const row=finding(d,i,ref),f=byFamily.get(d.familyId);findingsRoot.add(hash(row));namesRoot.add(d.name);f.count++;profiles.add(d.sourceProfile);f.sourceProfiles.add(d.sourceProfile);
    if(d.inputScopes.includes('current_live'))dynamicProfiles.add(d.sourceProfile);
    if(profiles.size>16||dynamicProfiles.size>16)fail('source_profile_bound');
    if(row.semantics.metadataGaps.length){withGaps++;f.gapped++;}
    for(const gap of row.semantics.metadataGaps){gapCounts[gap]=(gapCounts[gap]??0)+1;f.gaps.add(gap);}
   }
   checkpoint();const namesSha256=namesRoot.finish();if(namesSha256!==descriptor.namesSha256)fail('ordered_names_binding');
   const families=FAMILY_IDS.map(id=>{const f=registry.families.get(id),n=byFamily.get(id);return{familyId:id,catalogueKind:f.kind,catalogueStatus:f.status,disposition:generatedFamilyDisposition(f,n.count),generatedDefinitionOccurrences:n.count,generatedOccurrencesWithMetadataGaps:n.gapped,metadataGaps:sorted(n.gaps),sourceProfiles:sorted(n.sourceProfiles),eligibleTargets:[...f.eligibleTargets],fullFamilyComplete:false,sourceAvailabilityAttested:false};});
   const legacyOccurrences=owned.index.catalogues.map(c=>({catalogueId:c.id,count:c.count,occurrenceRange:{startInclusive:0,endExclusive:c.count},orderedNameHash:c.orderedNameHash,namesPin:structuredClone(c.namesPin),source:structuredClone(c.source),disposition:'unresolved_semantic_migration_no_alias_claim'}));
   const missingEligibleFamilyIds=families.filter(f=>f.eligibleTargets.includes(schema.targetId)&&f.generatedDefinitionOccurrences===0).map(f=>f.familyId);
   const body={contract:BOUNDED_EMITTED_AUDIT_CONTRACT,registryHash,schemaSha256:wrapper.sha256,namesSha256,targetId:schema.targetId,stateMode:schema.stateMode,componentSchemas:structuredClone(schema.componentSchemas),semanticInputs:structuredClone(schema.semanticInputs),sourceInventoryRefs:sourceRefs,sourceInventories,orderedDefinitionFindingsSha256:findingsRoot.finish(),schemaIntegrityAuthority:'private_compiler_actual_byte_schema_lease',definitionOrder:'original_full_schema_index',declarationFunction:'generated-definition-ledger.captureGeneratedDefinitionSemantics',exhaustiveDeclarationAudit:true,skippedDefinitions:0,counts:{definitionOccurrences:schema.definitions.length,occurrencesWithDeclarationGaps:withGaps,families:families.length,legacyGroups:legacyOccurrences.length,legacyOccurrences:owned.index.catalogueOccurrenceCount,legacyUnresolvedOccurrences:owned.index.catalogueOccurrenceCount},metadataGapCounts:gapCounts,sourceProfiles:sorted(profiles),currentDynamicProfiles:sorted(dynamicProfiles),mixedCurrentDynamicSourceProfiles:dynamicProfiles.size>1,emittedFamilyIds:families.filter(f=>f.generatedDefinitionOccurrences).map(f=>f.familyId),missingEligibleFamilyIds,families,legacyOccurrences,targetInventory:TARGET_IDS.flatMap(id=>modes(id).map(stateMode=>({targetId:id,stateMode,supplied:id===schema.targetId&&stateMode===schema.stateMode}))),admission:{workingBytes:L.workingBytes,pageWorkingBytes:L.pageWorkingBytes,engineeringEstimatesNotMeasuredRSS:true,originalSchemaOwnership:'retained_in_private_compiler_arena'},evidenceMeaning:'Exhaustive supplied actual schema declaration capture; no semantic correctness, original source availability, catalogue alias, joint source coverage or model quality acceptance.',...flags};
   const receipt=freeze({...body,contentHash:hash(body)}),receiptSize=bounded(receipt,{wire:4*MiB});
   receiptLease=hold(featureAssetRecord(receipt,receiptSize.bytes+65536));let active=true;
   const fixed={sha256:wrapper.sha256,targetId:schema.targetId,stateMode:schema.stateMode,count:schema.definitions.length};
   function readPage({offset=0,limit=32}={}){
    if(!active)fail('audit_released');if(!Number.isSafeInteger(offset)||offset<0||offset>fixed.count||!Number.isSafeInteger(limit)||limit<1||limit>L.maxPageDefinitions)fail('page_bounds');
    const pageWork=reserve(L.pageWorkingBytes);let pageSchemaLease=null,pageMetadataLease=null;
    try{
     pageSchemaLease=retainVerifiedProjectionSchema(schema,{expectedSchemaHash:fixed.sha256});if(!pageSchemaLease)fail('private_schema_ownership_required');
     const end=Math.min(fixed.count,offset+limit);let bytes=0,nodes=0,wire=0;
     for(let i=offset;i<end;i++){const size=definitionSize(schema.definitions[i]);bytes+=size.bytes;nodes+=size.nodes;wire+=size.wireBytes;if(bytes>L.maxPageAssetBytes||nodes>L.maxPageNodes||wire>L.maxPageWireBytes)fail('page_content_bound');}
     const findings=[];for(let i=offset;i<end;i++){const d=schema.definitions[i],component=d.id.slice(0,d.id.indexOf(':'));findings.push({...finding(d,i,sourceRefs[component]),definition:d});}
     const pageBody={contract:'aegis.bounded-emitted-definition-page.v1',schemaSha256:fixed.sha256,targetId:fixed.targetId,stateMode:fixed.stateMode,orderedDefinitionFindingsSha256:receipt.orderedDefinitionFindingsSha256,total:fixed.count,offset,limit,hasMore:end<fixed.count,findings,...flags};
     // Original definitions are borrowed only under the independent schema
     // lease. Charge newly owned semantics/row metadata separately, once.
     const own={...pageBody,findings:findings.map(({definition,...row})=>row)},size=bounded(own,{wire:L.maxPageWireBytes,asset:L.maxPageAssetBytes,nodes:L.maxPageNodes,work:L.pageWorkingBytes});
     pageMetadataLease=hold(featureAssetRecord(freeze(own),size.bytes+65536));let pageActive=true;
     let heldSchema=pageSchemaLease,heldMetadata=pageMetadataLease;pageSchemaLease=null;pageMetadataLease=null;
     return freeze(withFeatureRelease(pageBody,()=>{if(!pageActive)return false;pageActive=false;heldMetadata.release();heldSchema.release();heldMetadata=null;heldSchema=null;return true;}));
    }finally{pageMetadataLease?.release();pageSchemaLease?.release();pageWork.release();}
   }
   let heldSchema=schemaLease,heldConfig=configLease,heldReceipt=receiptLease;schemaLease=null;configLease=null;receiptLease=null;
   return Object.freeze(withFeatureRelease({receipt,readPage},()=>{if(!active)return false;active=false;heldReceipt.release();heldSchema.release();heldConfig.release();heldReceipt=null;heldSchema=null;heldConfig=null;schema=null;return true;}));
  }finally{receiptLease?.release();configLease?.release();schemaLease?.release();work?.release();busy=false;}
 }
 return Object.freeze({auditSchema,close(){if(closed)return false;closed=true;configurationLease.release();configurationLease=null;owned=null;registry=null;return true;},status(){return{closed,busy,resources:arena.status?.()??null};}});
}
