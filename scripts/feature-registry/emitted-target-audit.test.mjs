import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,validateRegistry} from './registry-contract.mjs';
import {syntheticRegistry} from './registry-contract.fixtures.mjs';
import {loadCanonicalRegistry} from './canonical-registry.mjs';
import {createFeatureProjectionCompiler} from '../steam-live-collector/source-adapter/featureProjectionCompiler.mjs';
import {createGeneratedDefinitionLedger} from './generated-definition-ledger.mjs';
import {auditEmittedTargetSchemas,auditGeneratedDefinitionEmissions,pageEmittedDefinitionFindings} from './emitted-target-audit.mjs';
const A='a'.repeat(64),B='b'.repeat(64);
function fixture({allModes=false}={}){
 const[index,familyDocument,targetDocument]=syntheticRegistry(),docs={index,familyDocument,targetDocument},registry=validateRegistry(index,familyDocument,targetDocument);
 const compiler=createFeatureProjectionCompiler({registry,registryHash:digest(docs),sourceInventory:{history:{primarySha256:A,files:[{path:'synthetic-history.mjs',sha256:A}]}},sourceProfiles:{history:'synthetic-history-v1'}});
 const definitions=[{name:'history.maps',familyId:'H01',formula:'count of distinct provided prior maps',formulaVersion:'synthetic-v1',units:'maps',inputScopes:['prior_maps'],minimumSupport:5,inputFields:['map.id','map.outcomeKnownAt'],supportUnit:'distinct_maps',populationPolicy:'provided synthetic cohort',eventTimePolicy:'prior map end',availabilityTimePolicy:'facts available by history cutoff',rolePolicy:'not applicable to map count',patchPolicy:'provided revisions only'}];
 const normalized=compiler.normalize({names:['history.maps'],values:[null],masks:[true],definitions,schemaHash:B},'history');
 const targets=allModes?targetDocument.targets.flatMap(t=>t.stateModes.map(m=>[t.id,m])):[['PRE_MAP_WIN','PRE']];
 const schemas=targets.map(([t,m])=>{const out=compiler.project([normalized],t,m);return{schema:compiler.getSchema(out.schemaRef.sha256),sha256:out.schemaRef.sha256};});return{...docs,schemas};
}
test('all12targets/13modes are audited from actual compiler emissions; no full semantic claim',()=>{
 const input=fixture({allModes:true}),a=auditEmittedTargetSchemas(input);assert.equal(a.counts.logicalTargets,12);assert.equal(a.counts.targetModes,13);assert.equal(a.counts.suppliedTargetModes,13);assert.equal(a.counts.generatedVariants,1);assert.equal(a.counts.families,79);assert.equal(a.counts.legacyGroups,14);assert.equal(a.counts.legacyUnresolvedOccurrences,14);
 assert.equal(a.targets.filter(t=>t.targetId==='SERIES_LIVE').length,2);assert.ok(a.targets.every(t=>t.generatedVariantCount===1));assert.ok(a.targets.find(t=>t.targetId==='SERIES_PRE').scope==='whole_series');assert.equal(a.semanticAcceptance,false);assert.equal(a.fullFeatureGateComplete,false);assert.equal(a.sourceAvailabilityAttested,false);
 const group=a.declarationGapGroups.find(g=>g.variantSha256s.length);assert.ok(group.gapCodes.includes('explicit_phase_policy_not_declared'));assert.ok(group.gapCodes.includes('missing_reason_policy_not_declared'));assert.ok(!group.gapCodes.includes('historical_population_policy_not_declared'));
});
test('missing modes and eligible-family emissions stay open even when the catalogue is complete',()=>{
 const a=auditEmittedTargetSchemas(fixture());assert.equal(a.counts.suppliedTargetModes,1);const live=a.targets.find(t=>t.targetId==='LIVE_MAP_WIN');assert.ok(live.issues.includes('target_mode_schema_not_supplied'));assert.ok(live.missingEligibleFamilies.some(f=>f.familyId==='H01'));assert.equal(a.families.find(f=>f.familyId==='H01').generatedVariantCount,1);assert.ok(a.families.find(f=>f.familyId==='S01').remainingMeaning.includes('No supplied'));
 assert.ok(a.legacyGroups.every(g=>g.resolvedOccurrenceCount===0&&g.unresolvedOccurrenceCount===g.count));assert.equal(a.legacyAliasesResolved,false);
});
test('detail pages bind the exact ledger and expose declarations without inventing gaps away',()=>{
 const ledger=createGeneratedDefinitionLedger(fixture()),audit=auditGeneratedDefinitionEmissions(ledger),p=pageEmittedDefinitionFindings({ledger,audit,limit:1});assert.equal(p.total,1);assert.equal(p.nextOffset,1);assert.deepEqual(p.definitions[0].semantics.phase.allowedTargets,ledger.definitions[0].definition.allowedTargets);assert.equal(p.definitions[0].semantics.phase.explicitPolicy,null);assert.equal(p.semanticAcceptance,false);assert.throws(()=>pageEmittedDefinitionFindings({ledger,audit,limit:1025}),/page_bounds/);
 const changed=structuredClone(audit);changed.counts.generatedVariants=999;assert.throws(()=>pageEmittedDefinitionFindings({ledger,audit:changed}),/audit_binding/);const other=createGeneratedDefinitionLedger({...fixture(),schemas:[]});assert.throws(()=>pageEmittedDefinitionFindings({ledger:other,audit}),/audit_binding/);
});
test('source corruption and future/label scopes fail before audit inventories can be issued',()=>{
 const input=fixture(),changed=structuredClone(input);changed.schemas[0].schema.definitions[0].inputScopes=['current_map_label'];changed.schemas[0].sha256=digest(changed.schemas[0].schema);assert.throws(()=>auditEmittedTargetSchemas(changed),/current_map_label/);
 input.schemas[0].schema=structuredClone(input.schemas[0].schema);input.schemas[0].schema.definitions[0].formula='tampered';assert.throws(()=>auditEmittedTargetSchemas(input),/schema_hash/);
});
test('actual canonical registry preserves465359 unresolved old occurrences without loading historical formula/data files',()=>{
 const{index,familyDocument,targetDocument}=loadCanonicalRegistry(),a=auditEmittedTargetSchemas({index,familyDocument,targetDocument,schemas:[]});assert.equal(a.counts.families,79);assert.equal(a.counts.legacyGroups,14);assert.equal(a.counts.legacyOccurrences,465359);assert.equal(a.counts.legacyUnresolvedOccurrences,465359);assert.equal(a.counts.suppliedTargetModes,0);assert.equal(a.fullFeatureGateComplete,false);
});
test('self-consistent receipts with duplicate/missing occurrences do not become complete emitted audits',()=>{
 const base=createGeneratedDefinitionLedger(fixture()),changed=structuredClone(base);changed.definitions[0].occurrences.push({...changed.definitions[0].occurrences[0]});const{contentHash,...body}=changed;changed.contentHash=digest(body);assert.throws(()=>auditGeneratedDefinitionEmissions(changed),/duplicate_schema_occurrence/);
 const missing=structuredClone(base);missing.definitions=[];const{contentHash:old,...withoutHash}=missing;missing.contentHash=digest(withoutHash);assert.throws(()=>auditGeneratedDefinitionEmissions(missing),/schema_occurrences_incomplete/);
});
test('alternative coherent schemas stay separate; multiple current sources inside one schema remain an explicit issue',()=>{
 const input=fixture(),one=structuredClone(input.schemas[0].schema);one.targetId='LIVE_MAP_WIN';one.stateMode='LIVE';one.definitions[0].inputScopes=['current_live'];one.definitions[0].sourceProfile='synthetic-current-A';const two=structuredClone(one);two.definitions[0].sourceProfile='synthetic-current-B';
 let a=auditEmittedTargetSchemas({...input,schemas:[{schema:one,sha256:digest(one)},{schema:two,sha256:digest(two)}]}),live=a.targets.find(t=>t.targetId==='LIVE_MAP_WIN');assert.equal(live.currentDynamicProfiles.length,2);assert.deepEqual(live.mixedCurrentDynamicSchemaSha256s,[]);
 const mixed=structuredClone(one);mixed.definitions.push({...two.definitions[0],id:'history:history.other',name:'history.other'});a=auditEmittedTargetSchemas({...input,schemas:[{schema:mixed,sha256:digest(mixed)}]});live=a.targets.find(t=>t.targetId==='LIVE_MAP_WIN');assert.ok(live.issues.includes('multiple_current_dynamic_source_profiles_within_schema'));assert.deepEqual(live.mixedCurrentDynamicSchemaSha256s,[digest(mixed)]);
});
