import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,validateRegistry} from './registry-contract.mjs';
import {syntheticRegistry} from './registry-contract.fixtures.mjs';
import {createFeatureProjectionCompiler} from '../steam-live-collector/source-adapter/featureProjectionCompiler.mjs';
import {createGeneratedDefinitionLedger as build,verifyGeneratedDefinitionLedgerReceipt as receipt} from './generated-definition-ledger.mjs';
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
function documents(){const[index,familyDocument,targetDocument]=syntheticRegistry();return{index,familyDocument,targetDocument};}
function actualSchemas({docs=documents(),fields=true,formula='count of provided distinct prior maps',helper=B,targets=['PRE_MAP_WIN','PRE_KILLS'],count=2}={}){
 const registry=validateRegistry(docs.index,docs.familyDocument,docs.targetDocument),registryHash=digest(docs),sourceInventory={history:{primarySha256:A,files:[{path:'synthetic-history.mjs',sha256:A},{path:'synthetic-helper.mjs',sha256:helper}]}};
 const compiler=createFeatureProjectionCompiler({registry,registryHash,sourceInventory,sourceProfiles:{history:'synthetic.prior-maps.v1'}}),definitions=Array.from({length:count},(_,i)=>({name:'history.synthetic_'+i,familyId:'H01',formula,formulaVersion:'synthetic.v1',units:'distinct_maps',inputScopes:['prior_maps'],minimumSupport:5,historyWindowDays:30,...fields?{inputFields:['priorMap.matchId','priorMap.outcomeKnownAt'],supportUnit:'distinct_maps',eventTimePolicy:'historical map ended before cutoff',availabilityTimePolicy:'all used facts available at history cutoff',populationPolicy:'provided synthetic corpus only'}:{}}));
 const normalized=compiler.normalize({names:definitions.map(d=>d.name),values:definitions.map(()=>null),masks:definitions.map(()=>true),definitions,schemaHash:C},'history');
 const schemas=targets.map(targetId=>{const r=compiler.project([normalized],targetId,'PRE');return{schema:compiler.getSchema(r.schemaRef.sha256),sha256:r.schemaRef.sha256};});return{docs,schemas};
}
test('ledger consumes actual compiler schemas, retains every variant and all79families',()=>{
 const{docs,schemas}=actualSchemas(),l=build({...docs,schemas});assert.equal(l.counts.families,79);assert.equal(l.counts.generatedVariants,2);assert.equal(l.counts.generatedSchemaOccurrences,4);assert.equal(l.legacyOccurrences.length,14);assert.equal(l.counts.legacyCatalogueOccurrences,14);
 assert.equal(l.families.find(f=>f.familyId==='H01').generatedVariantCount,2);assert.ok(l.families.every(f=>f.fullFamilyComplete===false));assert.equal(receipt(l).semanticAcceptance,false);assert.equal(l.fullFeatureGateComplete,false);
 const row=l.definitions[0];assert.deepEqual(row.semantics.inputs.fields,['priorMap.matchId','priorMap.outcomeKnownAt']);assert.equal(row.semantics.formula,'count of provided distinct prior maps');assert.equal(row.definition.producer.symbol,'produceHistoricalRelationalFeatures');assert.equal(row.semantics.support.minimumSupport,5);assert.equal(row.semantics.support.historyWindowDays,30);
});
test('unprovided semantics remain explicit gaps rather than invented rules',()=>{
 const{docs,schemas}=actualSchemas({fields:false}),l=build({...docs,schemas}),r=l.definitions[0];assert.equal(r.semantics.inputs.fields,null);assert.equal(r.semantics.time.eventTimePolicy,null);assert.equal(r.semantics.support.unit,null);assert.equal(r.semantics.populationPolicy,null);assert.ok(r.semantics.metadataGaps.includes('exact_input_fields_not_declared'));assert.equal(l.families.find(f=>f.familyId==='H01').generatedVariantsWithMetadataGaps,2);
});
test('unavailable/TRAIN-only/label/presentation dispositions preserve catalogue families',()=>{
 const docs=documents();docs.familyDocument.families.find(f=>f.id==='R01').status='unavailable_input';docs.familyDocument.families.find(f=>f.id==='H13').status='learned_state_pending';const{schemas}=actualSchemas({docs}),l=build({...docs,schemas}),get=id=>l.families.find(f=>f.familyId===id);
 assert.equal(get('R01').disposition,'unavailable_pending_source_or_rule_evidence');assert.equal(get('H13').disposition,'TRAIN_only_deferred');assert.equal(get('O04').disposition,'label_only');assert.equal(get('T04').disposition,'presentation_only');assert.equal(get('S01').disposition,'not_generated');assert.ok(l.legacyOccurrences.every(x=>x.disposition==='unresolved_semantic_migration_no_alias_claim'));
});
test('same names/IDs with different formulas stay independent variants without alias claims',()=>{
 const first=actualSchemas({targets:['PRE_MAP_WIN'],formula:'first formula'}),second=actualSchemas({targets:['PRE_MAP_WIN'],formula:'second formula'}),l=build({...first.docs,schemas:[...first.schemas,...second.schemas]});assert.equal(l.counts.generatedVariants,4);assert.ok(l.definitions.every(d=>d.aliasOf===null));assert.equal(l.definitions.filter(d=>d.definition.id==='history:history.synthetic_0').length,2);
});
test('a helper-source change creates a new variant even when primary definition bytes are unchanged',()=>{
 const first=actualSchemas({helper:B,targets:['PRE_MAP_WIN']}),second=actualSchemas({helper:C,targets:['PRE_MAP_WIN']}),l=build({...first.docs,schemas:[...first.schemas,...second.schemas]});assert.equal(l.counts.generatedVariants,4);assert.equal(new Set(l.definitions.map(d=>d.definitionSha256)).size,2);assert.equal(Object.keys(l.sourceInventories).length,2);
});
test('schema bytes and registry/definition source binding are mandatory',()=>{
 const{docs,schemas}=actualSchemas(),tampered=structuredClone(schemas);tampered[0].schema.definitions[0].formula='changed';assert.throws(()=>build({...docs,schemas:tampered}),/schema_hash/);
 const wrong=structuredClone(schemas);wrong[0].schema.registryHash=B;wrong[0].sha256=digest(wrong[0].schema);assert.throws(()=>build({...docs,schemas:wrong}),/schema_contract/);
 const source=structuredClone(schemas);source[0].schema.definitions[0].producer.sourceSha256=C;source[0].sha256=digest(source[0].schema);assert.throws(()=>build({...docs,schemas:source}),/definition_source_binding/);
});
test('live fields and final labels cannot become PRE ledger predictors after a rehash',()=>{
 const{docs,schemas}=actualSchemas();for(const scope of ['current_live','current_map_label']){const changed=structuredClone(schemas);changed[0].schema.definitions[0].inputScopes=[scope];changed[0].sha256=digest(changed[0].schema);assert.throws(()=>build({...docs,schemas:changed}),/dynamic_in_nonlive|current_map_label/);}
});
test('duplicate schema import is idempotent while declared bounds fail explicitly',()=>{
 const{docs,schemas}=actualSchemas(),l=build({...docs,schemas:[...schemas,...schemas]});assert.equal(l.counts.schemas,2);assert.equal(l.counts.generatedSchemaOccurrences,4);assert.throws(()=>build({...docs,schemas,limits:{maxDefinitions:1}}),/definition_bound/);assert.throws(()=>build({...docs,schemas,limits:{maxOccurrences:1}}),/occurrence_bound/);
});
test('empty schema set retains full unresolved inventory and receipt rejects tampering',()=>{
 const docs=documents(),l=build({...docs,schemas:[]});assert.equal(l.definitions.length,0);assert.equal(l.families.length,79);assert.equal(l.legacyOccurrences.length,14);assert.equal(receipt(l).accepted,true);
 const changed=structuredClone(l);changed.counts.generatedVariants=1;assert.throws(()=>receipt(changed),/receipt_hash/);const falseAcceptance=structuredClone(l);falseAcceptance.fullFeatureGateComplete=true;const{contentHash,...body}=falseAcceptance;falseAcceptance.contentHash=digest(body);assert.throws(()=>receipt(falseAcceptance),/receipt_contract/);
});
