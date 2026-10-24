import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadCanonicalRegistry,bindLegacyCatalogueNames} from './canonical-registry.mjs';
import {validateRegistry,validateProjection,projectionScopeRejection,occurrenceId,digest,FAMILY_IDS,CATALOGUE_IDS,TARGET_SCOPE_POLICY} from './registry-contract.mjs';

const bundle=loadCanonicalRegistry(),registry=validateRegistry(bundle.index,bundle.familyDocument,bundle.targetDocument);
const source=path.dirname(fileURLToPath(import.meta.url));
const hash=x=>createHash('sha256').update(x).digest('hex');
function definition(family,inputScopes=['prior_maps','current_identity']){
 return {contract:'aegis.executable-feature-definition.v1',id:'synthetic:'+family.id,name:'synthetic_'+family.id,version:'test-only',familyId:family.id,formula:'synthetic scope probe, not an implemented family',formulaVersion:'synthetic.v1',units:'count',dtype:'float64',missingPolicy:'null_and_mask',timePolicy:'input_available_at_frozen_cutoff',sourceProfile:'synthetic_prior_maps',learnedStatePolicy:'none',semanticStatus:'specified',inputScopes,allowedTargets:family.eligibleTargets,producer:{sourceSha256:'a'.repeat(64),symbol:'syntheticScopeProbe'}};
}
function relocated(change){
 const temporary=mkdtempSync(path.join(tmpdir(),'aegis-registry-test-'));
 cpSync(source,temporary,{recursive:true});
 if(change)change(temporary);
 return {temporary,url:pathToFileURL(path.join(temporary,'canonical-registry.mjs')).href};
}
test('real pinned metadata preserves all 79 families, 14 input schemas and 12 targets',()=>{
 assert.equal(registry.families.size,79);assert.equal(registry.targets.size,12);assert.equal(registry.catalogues.size,14);
 assert.equal(bundle.ledger.families.length,79);assert.equal(bundle.ledger.inputSchemas.length,14);
 assert.equal(bundle.ledger.inputSchemas.reduce((n,c)=>n+c.occurrenceRange.endExclusive-c.occurrenceRange.startInclusive,0),465359);
 assert.ok(bundle.ledger.families.every(f=>f.fullFamilyComplete===false));
 assert.ok(bundle.ledger.inputSchemas.every(c=>c.aliasOrConflictDecision==='unresolved_semantic_migration'&&c.targetEligibility.length===0));
 assert.deepEqual([...registry.families.keys()],FAMILY_IDS);assert.deepEqual([...registry.catalogues.keys()],CATALOGUE_IDS);
});
test('portable registry validates and is immutable outside the continuation directory',async()=>{
 const r=relocated();
 try{
  const mod=await import(r.url),copy=mod.loadCanonicalRegistry({expectedRegistrySha256:bundle.registrySha256});
  assert.equal(copy.registrySha256,bundle.registrySha256);
  assert.ok(Object.isFrozen(copy.index));assert.ok(Object.isFrozen(copy.ledger.families));
  assert.throws(()=>{copy.familyDocument.families[0].eligibleTargets.push('invented');},TypeError);
 }finally{rmSync(r.temporary,{recursive:true,force:true});}
});
test('registry semantic identity includes ledger, provenance and target scope policy',()=>{
 for(const key of ['semanticDispositionLedger','provenance','targetScopePolicy']){
  const index=structuredClone(bundle.index);index[key]={...index[key],changed:true};
  assert.notEqual(digest({index,familyDocument:bundle.familyDocument,targetDocument:bundle.targetDocument}),bundle.registrySha256);
 }
 assert.throws(()=>loadCanonicalRegistry({expectedRegistrySha256:'b'.repeat(64)}),/stale_registry_binding/);
});
test('old occurrence identity also changes when source bytes change but names do not',()=>{
 const catalogue=bundle.index.catalogues[0],changed={...catalogue,source:{...catalogue.source,sha256:'b'.repeat(64)}};
 assert.notEqual(occurrenceId(catalogue,0,'same'),occurrenceId(changed,0,'same'));
});
test('corrupt artifact bytes are rejected before projection',async()=>{
 const r=relocated(root=>{
  const p=path.join(root,'artifacts/2026-10-24.r1/FAMILY-REGISTRY.json');
  writeFileSync(p,readFileSync(p,'utf8')+' ');
 });
 try{const mod=await import(r.url);assert.throws(()=>mod.loadCanonicalRegistry(),/artifact_bytes/);}finally{rmSync(r.temporary,{recursive:true,force:true});}
});
test('a ledger range edit with a rehashed artifact still fails semantic index binding',async()=>{
 const r=relocated(root=>{
  const dir=path.join(root,'artifacts/2026-10-24.r1'),p=path.join(dir,'SEMANTIC-DISPOSITION-LEDGER.json'),manifestPath=path.join(dir,'BUNDLE-MANIFEST.json');
  const ledger=JSON.parse(readFileSync(p));ledger.inputSchemas[0].occurrenceRange.endExclusive--;
  const bytes=Buffer.from(JSON.stringify(ledger));writeFileSync(p,bytes);
  const manifest=JSON.parse(readFileSync(manifestPath)),pin=manifest.artifacts.find(p=>p.path==='SEMANTIC-DISPOSITION-LEDGER.json');
  pin.bytes=bytes.length;pin.sha256=hash(bytes);writeFileSync(manifestPath,JSON.stringify(manifest));
 });
 try{const mod=await import(r.url);assert.throws(()=>mod.loadCanonicalRegistry(),/index_artifact_binding/);}finally{rmSync(r.temporary,{recursive:true,force:true});}
});
test('every eligible identity/prior-map family can reach each applicable undrafted target',()=>{
 let checks=0;
 for(const family of bundle.familyDocument.families){
  if(['label_only','presentation_context','model_axis'].includes(family.kind))continue;
  for(const targetId of TARGET_SCOPE_POLICY.undraftedTargets){
   if(!family.eligibleTargets.includes(targetId))continue;
   const d=definition(family),stateMode=registry.targets.get(targetId).phase;
   assert.equal(projectionScopeRejection(d,targetId,stateMode),null);
   assert.equal(validateProjection({targetId,stateMode,definitions:[d]},registry).featureCount,1);checks++;
  }
 }
 assert.ok(checks>=100,'exhaustive across the installed eligible family unions');
});
test('no eligible PRE or BETWEEN union admits draft/live/label definitions',()=>{
 for(const family of bundle.familyDocument.families){
  if(['label_only','presentation_context','model_axis'].includes(family.kind))continue;
  for(const targetId of TARGET_SCOPE_POLICY.undraftedTargets){
   if(!family.eligibleTargets.includes(targetId))continue;
   for(const scope of ['current_draft','current_live','current_map_label']){
    const d=definition(family,['prior_maps',scope]),stateMode=registry.targets.get(targetId).phase;
    assert.ok(projectionScopeRejection(d,targetId,stateMode));
    assert.throws(()=>validateProjection({targetId,stateMode,definitions:[d]},registry),/draft_in_undrafted|dynamic_in_nonlive|current_map_label/);
   }
  }
 }
});
test('scope helper rejects malformed, wrong-mode, duplicate or empty allowances',()=>{
 const f=definition(registry.families.get('H01'));
 for(const allowedTargets of [[],null,['PRE_MAP_WIN','PRE_MAP_WIN'],['not_a_target']])assert.equal(projectionScopeRejection({...f,allowedTargets},'PRE_MAP_WIN','PRE'),'allowed_targets');
 assert.equal(projectionScopeRejection(f,'PRE_MAP_WIN','LIVE'),'projection_state_mode');
 assert.equal(projectionScopeRejection({...f,inputScopes:['prior_maps','prior_maps']},'PRE_MAP_WIN','PRE'),'input_scope');
 assert.equal(projectionScopeRejection(f,'invented','PRE'),'projection_target');
});
test('six historical unions include SERIES_BETWEEN without admitting selected-hero definitions',()=>{
 for(const id of ['H10','H11','H12','H14','P01','P05']){
  const family=registry.families.get(id);
  assert.ok(family.eligibleTargets.includes('SERIES_BETWEEN'));
  const d=definition(family,['prior_maps','current_draft']);
  assert.throws(()=>validateProjection({targetId:'SERIES_BETWEEN',stateMode:'SERIES_BETWEEN',definitions:[d]},registry),/draft_in_undrafted/);
 }
});
test('small pinned totals names demonstrate per-occurrence unresolved disposition and no blind concat',()=>{
 const names=['dire_kills','game_minutes','kill_diff','kills_per_minute','radiant_kills','total_kills'];
 const binding=bindLegacyCatalogueNames('totals-state6',names);
 for(let index=0;index<names.length;index++){
  const d=binding.dispositionAt(index);
  assert.equal(d.oldName,names[index]);assert.equal(d.columnIndex,index);
  assert.equal(d.newDefinitionId,null);assert.deepEqual(d.targetEligibility,[]);
  assert.equal(d.aliasOrConflictDecision,'unresolved_semantic_migration');
  assert.ok(d.occurrenceId.includes(d.sourceSchemaSha256));
 }
 names[0]='invented';
 assert.equal(binding.dispositionAt(0).oldName,'dire_kills');
 assert.throws(()=>binding.dispositionAt(-1),/legacy_column_index/);
 assert.throws(()=>binding.dispositionAt(6),/legacy_column_index/);
 // A plausible same-width list cannot establish pinned occurrence membership.
 assert.throws(()=>bindLegacyCatalogueNames('totals-state6',names),/legacy_ordered_names/);
 assert.throws(()=>bindLegacyCatalogueNames('unknown',[]),/legacy_catalogue/);
});
