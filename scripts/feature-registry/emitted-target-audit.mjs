/** Audit exact supplied emissions. Catalogue coverage and JSON/hash integrity do
 * not establish formula correctness, source availability or semantic acceptance.
 * Gap groups reference the ledger's exact definitions without expanding formulas
 * again. No provider access, vector generation, model fitting or activation. */
import {digest,TARGET_IDS,FAMILY_IDS} from './registry-contract.mjs';
import {createGeneratedDefinitionLedger,verifyGeneratedDefinitionLedgerReceipt,generatedLedgerSchemaCapacity,GENERATED_DEFINITION_LEDGER_FULL_CONTRACT} from './generated-definition-ledger.mjs';

export const EMITTED_TARGET_AUDIT_CONTRACT='aegis.emitted-target-audit.v1';
export const EMITTED_TARGET_AUDIT_FULL_CONTRACT='aegis.emitted-target-audit.v2';
const fail=reason=>{throw Error('emitted_target_audit:'+reason);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const modes=id=>id==='SERIES_LIVE'?['observed_postdraft','observed_live']:[id.startsWith('SERIES_')?id:id.split('_')[0]];
const sorted=x=>[...x].sort();
const disabled={fullFeatureGateComplete:false,semanticAcceptance:false,sourceAvailabilityAttested:false,trainingAdmitted:false,servingAdmitted:false,legacyAliasesResolved:false};

/** This reports declaration completeness, never validates a declaration's truth.
 * Missing target modes and absent eligible family emissions remain separate from
 * supplied definitions whose exact metadata is incomplete. */
export function auditGeneratedDefinitionEmissions(ledger){
 verifyGeneratedDefinitionLedgerReceipt(ledger);
 if(!Array.isArray(ledger.schemas)||!Array.isArray(ledger.definitions)||ledger.families.length!==FAMILY_IDS.length)fail('ledger_shape');
 const targetRows=new Map(),familyRows=new Map(),gapGroups=new Map(),schemaByHash=new Map(),variantByHash=new Map(),schemaIndices=new Map(),schemaCurrentProfiles=new Map();
 for(const id of TARGET_IDS)for(const mode of modes(id))targetRows.set(id+':'+mode,{targetId:id,stateMode:mode,scope:id.startsWith('SERIES_')?'whole_series':'selected_map',schemaSha256s:[],definitionOccurrenceCount:0,definitionVariants:new Set(),variantsWithDeclarationGaps:new Set(),emittedFamilies:new Set(),sourceProfiles:new Set(),currentDynamicProfiles:new Set(),mixedCurrentDynamicSchemaSha256s:[],missingEligibleFamilies:[],issues:[]});
 for(const f of ledger.families)familyRows.set(f.familyId,{familyId:f.familyId,catalogueKind:f.catalogueKind,catalogueStatus:f.catalogueStatus,disposition:f.disposition,eligibleTargets:[...f.eligibleTargets],emittedTargetModes:new Set(),generatedVariantCount:0,variantsWithDeclarationGaps:0,metadataGapCodes:new Set(),remainingMeaning:f.generatedVariantCount?'Generated subset only; full family/source semantics require independent review.':'No supplied emitted definition; catalogue disposition does not establish implementation.'});
 for(const schema of ledger.schemas){
  const capacity=generatedLedgerSchemaCapacity(schema),t=targetRows.get(schema.targetId+':'+schema.stateMode);if(!t||schemaByHash.has(schema.sha256)||!Number.isSafeInteger(schema.definitionCount)||schema.definitionCount<0||schema.definitionCount>capacity.maxFeatures)fail('schema_target_or_duplicate');schemaByHash.set(schema.sha256,schema);schemaIndices.set(schema.sha256,new Set());schemaCurrentProfiles.set(schema.sha256,new Set());t.schemaSha256s.push(schema.sha256);
 }
 for(const row of ledger.definitions){
  if(variantByHash.has(row.variantSha256))fail('duplicate_variant');variantByHash.set(row.variantSha256,row);const f=familyRows.get(row.definition.familyId);if(!f)fail('unknown_family');
  const gaps=row.semantics.metadataGaps;if(!Array.isArray(gaps)||new Set(gaps).size!==gaps.length||gaps.some(g=>typeof g!=='string'||!g))fail('metadata_gaps');
  f.generatedVariantCount++;if(gaps.length)f.variantsWithDeclarationGaps++;for(const code of gaps)f.metadataGapCodes.add(code);
  const groupKey=sorted(gaps).join('|');if(!gapGroups.has(groupKey))gapGroups.set(groupKey,{gapCodes:sorted(gaps),variantSha256s:[]});gapGroups.get(groupKey).variantSha256s.push(row.variantSha256);
  if(!Array.isArray(row.occurrences)||!row.occurrences.length)fail('variant_without_occurrence');for(const o of row.occurrences){
   const t=targetRows.get(o.targetId+':'+o.stateMode),schema=schemaByHash.get(o.schemaSha256);if(!t||!schema||schema.targetId!==o.targetId||schema.stateMode!==o.stateMode||!Number.isSafeInteger(o.index)||o.index<0||o.index>=schema.definitionCount)fail('occurrence_binding');
   const indices=schemaIndices.get(o.schemaSha256);if(indices.has(o.index))fail('duplicate_schema_occurrence');indices.add(o.index);
   t.definitionOccurrenceCount++;t.definitionVariants.add(row.variantSha256);if(gaps.length)t.variantsWithDeclarationGaps.add(row.variantSha256);t.emittedFamilies.add(row.definition.familyId);t.sourceProfiles.add(row.definition.sourceProfile);if(row.definition.inputScopes.includes('current_live')){t.currentDynamicProfiles.add(row.definition.sourceProfile);schemaCurrentProfiles.get(o.schemaSha256).add(row.definition.sourceProfile);}f.emittedTargetModes.add(o.targetId+':'+o.stateMode);
  }
 }
 for(const schema of ledger.schemas){if(schemaIndices.get(schema.sha256).size!==schema.definitionCount)fail('schema_occurrences_incomplete');if(schemaCurrentProfiles.get(schema.sha256).size>1)targetRows.get(schema.targetId+':'+schema.stateMode).mixedCurrentDynamicSchemaSha256s.push(schema.sha256);}
 for(const t of targetRows.values()){
  for(const f of familyRows.values())if(f.eligibleTargets.includes(t.targetId)&&!t.emittedFamilies.has(f.familyId))t.missingEligibleFamilies.push({familyId:f.familyId,disposition:f.disposition,reason:'not_emitted_in_supplied_target_mode_schemas'});
  if(!t.schemaSha256s.length)t.issues.push('target_mode_schema_not_supplied');else if(!t.definitionOccurrenceCount)t.issues.push('supplied_target_mode_schema_empty');
  if(t.variantsWithDeclarationGaps.size)t.issues.push('emitted_definition_metadata_incomplete');if(t.missingEligibleFamilies.length)t.issues.push('eligible_family_emissions_absent');
  if(t.mixedCurrentDynamicSchemaSha256s.length)t.issues.push('multiple_current_dynamic_source_profiles_within_schema');
 }
 const targets=[...targetRows.values()].map(t=>({...t,schemaSha256s:sorted(t.schemaSha256s),generatedVariantCount:t.definitionVariants.size,variantsWithDeclarationGaps:t.variantsWithDeclarationGaps.size,emittedFamilies:sorted(t.emittedFamilies),sourceProfiles:sorted(t.sourceProfiles),currentDynamicProfiles:sorted(t.currentDynamicProfiles),definitionVariants:undefined})).map(({definitionVariants,...t})=>t);
 const families=[...familyRows.values()].map(f=>({...f,emittedTargetModes:sorted(f.emittedTargetModes),metadataGapCodes:sorted(f.metadataGapCodes)}));
 const legacyGroups=ledger.legacyOccurrences.map(c=>({catalogueId:c.catalogueId,count:c.count,orderedNameHash:c.orderedNameHash,occurrenceRange:structuredClone(c.occurrenceRange),disposition:c.disposition,resolvedOccurrenceCount:0,unresolvedOccurrenceCount:c.count,reason:'Pinned occurrence inventory only; no emitted per-occurrence semantic migration/parity proof supplied.'}));
 const groups=[...gapGroups.values()].map(g=>({...g,variantSha256s:sorted(g.variantSha256s)})).sort((a,b)=>a.gapCodes.join('|').localeCompare(b.gapCodes.join('|'),'en'));
 const body={contract:ledger.contract===GENERATED_DEFINITION_LEDGER_FULL_CONTRACT?EMITTED_TARGET_AUDIT_FULL_CONTRACT:EMITTED_TARGET_AUDIT_CONTRACT,ledgerSha256:ledger.contentHash,registryHash:ledger.registryHash,targets,families,legacyGroups,declarationGapGroups:groups,counts:{logicalTargets:12,targetModes:targets.length,suppliedTargetModes:targets.filter(t=>t.schemaSha256s.length).length,suppliedSchemas:ledger.schemas.length,families:families.length,generatedVariants:ledger.definitions.length,variantsWithDeclarationGaps:groups.filter(g=>g.gapCodes.length).reduce((n,g)=>n+g.variantSha256s.length,0),legacyGroups:legacyGroups.length,legacyOccurrences:legacyGroups.reduce((n,g)=>n+g.count,0),legacyUnresolvedOccurrences:legacyGroups.reduce((n,g)=>n+g.unresolvedOccurrenceCount,0)},evidenceMeaning:'Actual supplied schema declarations and explicit gaps. A complete inventory or no declaration gaps is not reviewed semantics, measured source coverage, model quality or runtime acceptance.',...disabled};
 return freeze({...body,contentHash:digest(body)});
}

export function auditEmittedTargetSchemas(input){return auditGeneratedDefinitionEmissions(createGeneratedDefinitionLedger(input));}

/** Bounded exact detail pages from a separately retained ledger. A changed ledger
 * cannot be paired with an older audit merely because feature names match. */
export function pageEmittedDefinitionFindings({ledger,audit,offset=0,limit=128}={}){
 verifyGeneratedDefinitionLedgerReceipt(ledger);const{contentHash,...body}=audit??{};
 const expectedContract=ledger.contract===GENERATED_DEFINITION_LEDGER_FULL_CONTRACT?EMITTED_TARGET_AUDIT_FULL_CONTRACT:EMITTED_TARGET_AUDIT_CONTRACT;
 if(audit?.contract!==expectedContract||digest(body)!==contentHash||audit.ledgerSha256!==ledger.contentHash||Object.keys(disabled).some(k=>audit[k]!==false))fail('audit_binding');
 if(!Number.isSafeInteger(offset)||offset<0||offset>ledger.definitions.length||!Number.isSafeInteger(limit)||limit<1||limit>1024)fail('page_bounds');
 return freeze({ledgerSha256:ledger.contentHash,auditSha256:contentHash,offset,total:ledger.definitions.length,nextOffset:Math.min(offset+limit,ledger.definitions.length),definitions:ledger.definitions.slice(offset,offset+limit).map(d=>({variantSha256:d.variantSha256,definitionId:d.definition.id,familyId:d.definition.familyId,metadataGaps:[...d.semantics.metadataGaps],semantics:structuredClone(d.semantics),occurrences:structuredClone(d.occurrences)})),semanticAcceptance:false,sourceAvailabilityAttested:false});
}
