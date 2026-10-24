/** Portable host-owned metadata. No continuation-workspace path, data acquisition,
 * executable legacy imports, model state or runtime activation. Hashes bind bytes;
 * they do not attest provider truth, formula parity or full-family completion. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonical,digest,validateRegistry,occurrenceId,FAMILY_IDS,CATALOGUE_IDS,TARGET_SCOPE_POLICY} from './registry-contract.mjs';

export const CANONICAL_REGISTRY_VERSION='2026-10-24.r1';
const BASE=new URL('./artifacts/'+CANONICAL_REGISTRY_VERSION+'/',import.meta.url);
const SHA=/^[a-f0-9]{64}$/;
const ARTIFACTS=['CATALOGUE-INDEX.json','FAMILY-REGISTRY.json','TWELVE-TARGET-MATRIX.json','SEMANTIC-DISPOSITION-LEDGER.json','PROVENANCE.json'];
const STATES=new Set(['not_generated','partially_generated','exact_alias','unavailable_input','learned_state_pending','label_only','presentation_only']);
const fail=reason=>{throw Error('canonical_registry:'+reason);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const same=(a,b)=>canonical(a)===canonical(b);
const unique=xs=>Array.isArray(xs)&&xs.every(x=>typeof x==='string'&&x.length)&&new Set(xs).size===xs.length;
function parse(bytes,name){try{return JSON.parse(bytes.toString('utf8'));}catch{fail('json:'+name);}}
function safeMetadata(value){
 if(typeof value==='string'&&(/^[a-z]:[\\/]/i.test(value)||/^\\\\/.test(value)||/file:\/\//i.test(value)))fail('absolute_path_in_artifact');
 if(value&&typeof value==='object')Object.values(value).forEach(safeMetadata);
}
function validateLedger(ledger,index,registry){
 if(ledger?.contract!=='aegis.feature-semantic-disposition-ledger.v1'||ledger.version!==CANONICAL_REGISTRY_VERSION||ledger.fullFeatureGateComplete!==false||ledger.trainingAdmitted!==false||ledger.servingAdmitted!==false)fail('ledger_contract');
 if(!Array.isArray(ledger.families)||!unique(ledger.families.map(f=>f.familyId))||ledger.families.length!==FAMILY_IDS.length)fail('family_dispositions');
 for(const row of ledger.families){
  const f=registry.families.get(row.familyId);
  if(!f||!STATES.has(row.implementationStatus)||row.implementationStatus!==f.status||row.fullFamilyComplete!==false||!same(row.eligibleTargets,f.eligibleTargets)||!same(row.dependencyScopes,f.dependencyScopeUnion)||!unique(row.sourceProfiles)||!row.sourceProfiles.length||!row.remainingWork||!row.oldFormula||!Array.isArray(row.sourceEvidence)||!Array.isArray(row.testEvidence))fail('family_disposition:'+row.familyId);
  if(row.newDefinitionId!==null||row.newFormula!==null||row.newFormulaVersion!==null||row.implementationStatus==='exact_alias')fail('unreviewed_definition_or_alias');
 }
 if(!Array.isArray(ledger.inputSchemas)||!unique(ledger.inputSchemas.map(c=>c.catalogueId))||ledger.inputSchemas.length!==CATALOGUE_IDS.length)fail('schema_dispositions');
 let count=0;
 for(const row of ledger.inputSchemas){
  const c=registry.catalogues.get(row.catalogueId);
  if(!c||row.count!==c.count||row.occurrenceRange?.startInclusive!==0||row.occurrenceRange?.endExclusive!==c.count||row.orderedNameHash!==c.orderedNameHash||!same(row.oldSchemaSource,c.source)||!same(row.namesPin,c.namesPin)||row.aliasOrConflictDecision!=='unresolved_semantic_migration'||row.implementationStatus!=='not_concatenated_into_unified_projection'||!Array.isArray(row.targetEligibility)||row.targetEligibility.length||row.newDefinitionId!==null||row.newFormula!==null||row.newFormulaVersion!==null)fail('schema_disposition:'+row.catalogueId);
  count+=row.count;
 }
 if(count!==ledger.occurrenceCount||count!==index.catalogueOccurrenceCount)fail('occurrence_coverage');
}
let cached;
/** Load only this installed version. An optional expected semantic hash rejects
 * stale weight/schema bindings. An injected remote path is deliberately absent. */
export function loadCanonicalRegistry({expectedRegistrySha256=null}={}){
 if(expectedRegistrySha256!==null&&!SHA.test(expectedRegistrySha256))fail('expected_registry_hash');
 if(!cached){
  const manifestBytes=readFileSync(new URL('BUNDLE-MANIFEST.json',BASE));
  if(manifestBytes.length>65536)fail('manifest_bound');
  const manifest=parse(manifestBytes,'manifest');
  if(manifest?.contract!=='aegis.portable-feature-registry-bundle.v1'||manifest.version!==CANONICAL_REGISTRY_VERSION||!SHA.test(manifest.registrySha256??'')||manifest.scopePolicySha256!==digest(TARGET_SCOPE_POLICY)||manifest.fullFeatureGateComplete!==false||!Array.isArray(manifest.artifacts)||!unique(manifest.artifacts.map(p=>p.path))||manifest.artifacts.length!==ARTIFACTS.length||manifest.artifacts.some(p=>!ARTIFACTS.includes(p.path)))fail('manifest_contract');
  const docs={};
  for(const name of ARTIFACTS){
   const pin=manifest.artifacts.find(p=>p.path===name);
   if(!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>1024*1024||!SHA.test(pin.sha256??''))fail('artifact_pin:'+name);
   const bytes=readFileSync(new URL(name,BASE));
   if(bytes.length!==pin.bytes||sha(bytes)!==pin.sha256)fail('artifact_bytes:'+name);
   docs[name]=parse(bytes,name);safeMetadata(docs[name]);
  }
  const index=docs['CATALOGUE-INDEX.json'],familyDocument=docs['FAMILY-REGISTRY.json'],targetDocument=docs['TWELVE-TARGET-MATRIX.json'],ledger=docs['SEMANTIC-DISPOSITION-LEDGER.json'],provenance=docs['PROVENANCE.json'];
  const registry=validateRegistry(index,familyDocument,targetDocument);
  for(const [name,key]of [['FAMILY-REGISTRY.json','familyRegistry'],['TWELVE-TARGET-MATRIX.json','targetMatrix'],['SEMANTIC-DISPOSITION-LEDGER.json','semanticDispositionLedger'],['PROVENANCE.json','provenance']])if(!same(index[key],manifest.artifacts.find(p=>p.path===name)))fail('index_artifact_binding:'+key);
  if(index.version!==CANONICAL_REGISTRY_VERSION||familyDocument.version!==CANONICAL_REGISTRY_VERSION||targetDocument.version!==CANONICAL_REGISTRY_VERSION||!same(index.targetScopePolicy,TARGET_SCOPE_POLICY)||!same(targetDocument.targetScopePolicy,TARGET_SCOPE_POLICY))fail('semantic_policy_binding');
  validateLedger(ledger,index,registry);
  if(provenance?.contract!=='aegis.feature-registry-provenance.v1'||provenance.namesCorpusBundled!==false||provenance.legacyFormulaCompletenessAttested!==false)fail('provenance_contract');
  const registrySha256=digest({index,familyDocument,targetDocument});
  if(registrySha256!==manifest.registrySha256)fail('semantic_hash');
  cached=freeze({index,familyDocument,targetDocument,ledger,provenance,registrySha256,provenanceSha256:digest(provenance),manifestSha256:sha(manifestBytes)});
 }
 if(expectedRegistrySha256!==null&&expectedRegistrySha256!==cached.registrySha256)fail('stale_registry_binding');
 return cached;
}

/** Verify the entire supplied ordered-name array before resolving even one old
 * occurrence. No arbitrary name, hash-shaped assertion or same-spelling alias can
 * establish its membership. The old corpus need not ship in every application. */
export function bindLegacyCatalogueNames(catalogueId,names){
 const bundle=loadCanonicalRegistry(),catalogue=bundle.index.catalogues.find(c=>c.id===catalogueId),row=bundle.ledger.inputSchemas.find(c=>c.catalogueId===catalogueId);
 if(!catalogue)fail('legacy_catalogue');
 if(!Array.isArray(names)||names.length!==catalogue.count||names.some(n=>typeof n!=='string'||!n.length||n.length>4096)||new Set(names).size!==names.length||sha(JSON.stringify(names))!==catalogue.orderedNameHash)fail('legacy_ordered_names');
 const pinnedNames=Object.freeze([...names]);
 return Object.freeze({catalogueId,orderedNameHash:catalogue.orderedNameHash,count:catalogue.count,registrySha256:bundle.registrySha256,
  dispositionAt(columnIndex){
   if(!Number.isSafeInteger(columnIndex)||columnIndex<0||columnIndex>=pinnedNames.length)fail('legacy_column_index');
   const name=pinnedNames[columnIndex];
   return freeze({contract:'aegis.legacy-feature-occurrence-disposition.v1',occurrenceId:occurrenceId(catalogue,columnIndex,name),catalogueId,columnIndex,oldName:name,oldSourceVersion:row.oldSourceVersion,sourceSchemaSha256:catalogue.source.sha256,orderedNameHash:catalogue.orderedNameHash,newDefinitionId:null,newFormula:null,newFormulaVersion:null,aliasOrConflictDecision:row.aliasOrConflictDecision,implementationStatus:row.implementationStatus,availabilityStatus:row.availabilityStatus,targetEligibility:row.targetEligibility,remainingWork:row.remainingWork,registrySha256:bundle.registrySha256});
  }
 });
}
