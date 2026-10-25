import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,validateRegistry} from './registry-contract.mjs';
import {syntheticRegistry} from './registry-contract.fixtures.mjs';
import {createGeneratedDefinitionLedger} from './generated-definition-ledger.mjs';
import {createBoundedEmittedDefinitionAudit as createAudit,BOUNDED_EMITTED_AUDIT_LIMITS as LIMITS} from './bounded-emitted-definition-audit.mjs';
import {createFeatureProjectionCompiler} from '../steam-live-collector/source-adapter/featureProjectionCompiler.mjs';
import {createDiagnosticResourceArena} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),MiB=1024**2;
function documents(){const[index,familyDocument,targetDocument]=syntheticRegistry();return{index,familyDocument,targetDocument};}
function actual({docs=documents(),arena=createDiagnosticResourceArena(),count=3,fields=true,formula='synthetic prior map count',extra={},targetId='PRE_MAP_WIN',stateMode='PRE'}={}){
 const sourceInventory={history:{primarySha256:A,files:[{path:'synthetic-history.mjs',sha256:A},{path:'synthetic-helper.mjs',sha256:B}]}},compiler=createFeatureProjectionCompiler({registry:validateRegistry(docs.index,docs.familyDocument,docs.targetDocument),registryHash:digest(docs),sourceInventory,sourceProfiles:{history:'synthetic.history.v1'},resourceArena:arena});
 const definitions=Array.from({length:count},(_,i)=>({name:'history.synthetic_'+i,familyId:'H01',formula,formulaVersion:'synthetic.v1',units:'distinct_maps',inputScopes:['prior_maps'],...fields?{inputFields:['priorMap.matchId','priorMap.outcomeKnownAt'],supportUnit:'distinct_maps',eventTimePolicy:'ended before cutoff',availabilityTimePolicy:'provided facts available before cutoff',populationPolicy:'synthetic corpus only',minimumSupport:5,historyWindowDays:30}:{},...extra}));
 const block=compiler.normalize({names:definitions.map(d=>d.name),values:definitions.map(()=>null),masks:definitions.map(()=>true),definitions,schemaHash:C},'history'),route=compiler.project([block],targetId,stateMode);
 const input={schema:route.diagnosticSchema,sha256:route.schemaRef.sha256};let active=true;
 return{docs,arena,compiler,input,definitions,close(){if(!active)return;active=false;route.release();block.release();compiler.close();}};
}
function zero(arena){assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().heldAssets,0);assert.equal(arena.status().leases,0);}

test('small actual schema has exact per-definition bulk oracle parity, ordered hash and all catalogue dispositions',()=>{
 const f=actual(),audit=createAudit({...f.docs,resourceArena:f.arena});let handle=null,page=null;
 try{
  const bulk=createGeneratedDefinitionLedger({...f.docs,schemas:[f.input]});handle=audit.auditSchema(f.input);page=handle.readPage({limit:3});const r=handle.receipt;
  assert.equal(r.schemaSha256,f.input.sha256);assert.equal(r.namesSha256,digest(f.input.schema.definitions.map(d=>d.name)));assert.equal(r.exhaustiveDeclarationAudit,true);assert.equal(r.skippedDefinitions,0);
  const rows=page.findings.map(({definition,...row})=>row);assert.equal(r.orderedDefinitionFindingsSha256,digest(rows.map(row=>digest(row))));
  const expectedGaps={};for(const row of page.findings){const oracle=bulk.definitions.find(d=>d.definition.id===row.definitionId);assert.ok(oracle);assert.equal(row.definition,f.input.schema.definitions[row.index]);assert.deepEqual(row.definition,oracle.definition);assert.deepEqual(row.semantics,oracle.semantics);for(const key of ['definitionSha256','variantSha256','sourceInventorySha256','aliasOf'])assert.deepEqual(row[key],oracle[key]);for(const gap of row.semantics.metadataGaps)expectedGaps[gap]=(expectedGaps[gap]??0)+1;}
  assert.deepEqual(r.metadataGapCounts,expectedGaps);assert.equal(r.counts.definitionOccurrences,bulk.counts.generatedSchemaOccurrences);assert.equal(r.counts.families,79);assert.equal(r.counts.legacyGroups,14);assert.equal(r.counts.legacyUnresolvedOccurrences,14);assert.deepEqual(r.legacyOccurrences,bulk.legacyOccurrences);assert.equal(r.targetInventory.length,13);assert.equal(r.targetInventory.filter(x=>x.supplied).length,1);
  for(const family of r.families){const oracle=bulk.families.find(x=>x.familyId===family.familyId);assert.equal(family.disposition,oracle.disposition);assert.equal(family.generatedDefinitionOccurrences,oracle.generatedVariantCount);assert.equal(family.generatedOccurrencesWithMetadataGaps,oracle.generatedVariantsWithMetadataGaps);}
  assert.equal(r.contentHash,digest(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='contentHash'))));for(const key of ['semanticAcceptance','sourceAvailabilityAttested','observedAvailabilityMeasured','fullFeatureGateComplete','trainingAdmitted','servingAdmitted','legacyAliasesResolved'])assert.equal(r[key],false);
 }finally{page?.release();handle?.release();audit.close();f.close();zero(f.arena);}
});

test('missing optional declarations match bulk gaps; declared policies are preserved without source attestation',()=>{
 for(const extra of [{},{rolePolicy:'not applicable to synthetic count',patchPolicy:'fixed synthetic patch',phasePolicy:'historical cutoff in PRE',missingReasonPolicy:'synthetic insufficient support',supportPolicy:'defined at zero count'}]){
  const f=actual({fields:false,extra}),audit=createAudit({...f.docs,resourceArena:f.arena});let h,p;
  try{h=audit.auditSchema(f.input);p=h.readPage({limit:1});const oracle=createGeneratedDefinitionLedger({...f.docs,schemas:[f.input]}).definitions.find(d=>d.definition.id===p.findings[0].definitionId);assert.deepEqual(p.findings[0].semantics,oracle.semantics);assert.equal(p.findings[0].semantics.inputs.fields,null);assert.ok(p.findings[0].semantics.metadataGaps.includes('exact_input_fields_not_declared'));assert.equal(h.receipt.semanticAcceptance,false);}finally{p?.release();h?.release();audit.close();f.close();zero(f.arena);}
 }
});

test('private schema authority rejects JSON copies, mismatched hash and expired original ownership',()=>{
 const f=actual(),audit=createAudit({...f.docs,resourceArena:f.arena});
 try{assert.throws(()=>audit.auditSchema(structuredClone(f.input)),/private_schema_ownership_required/);assert.throws(()=>audit.auditSchema({...f.input,sha256:B}),/private_schema_ownership_required/);f.close();assert.throws(()=>audit.auditSchema(f.input),/private_schema_ownership_required/);}finally{audit.close();f.close();zero(f.arena);}
});

test('independent page lease survives producer, audit and factory release while keeping its schema charged',()=>{
 const f=actual(),audit=createAudit({...f.docs,resourceArena:f.arena});let h,p;
 try{h=audit.auditSchema(f.input);p=h.readPage({offset:1,limit:1});const definition=p.findings[0].definition;f.close();audit.close();h.release();assert.ok(f.arena.status().chargedBytes>0);assert.equal(p.findings[0].definition,definition);assert.equal(p.findings[0].index,1);assert.equal(digest(definition),p.findings[0].definitionSha256);assert.throws(()=>h.readPage(),/audit_released/);assert.equal(p.release(),true);assert.equal(p.release(),false);zero(f.arena);}finally{p?.release();h?.release();audit.close();f.close();zero(f.arena);}
});

test('factory captures registry ownership; caller mutation and close do not alter an existing audit page',()=>{
 const f=actual(),audit=createAudit({...f.docs,resourceArena:f.arena});let h,p;
 try{f.docs.familyDocument.families[0].formula='caller mutation';h=audit.auditSchema(f.input);audit.close();p=h.readPage({offset:3,limit:1});assert.equal(p.total,3);assert.deepEqual(p.findings,[]);assert.equal(p.hasMore,false);assert.throws(()=>audit.auditSchema(f.input),/closed/);}finally{p?.release();h?.release();audit.close();f.close();zero(f.arena);}
});

test('wrong registry is rejected before definition capture, with all reservations released',()=>{
 const f=actual(),docs=documents();docs.familyDocument.families[0].formula='different registry';const audit=createAudit({...docs,resourceArena:f.arena});
 try{const before=f.arena.status().chargedBytes;assert.throws(()=>audit.auditSchema(f.input),/schema_contract/);assert.equal(f.arena.status().chargedBytes,before);}finally{audit.close();f.close();zero(f.arena);}
});

test('fixed workspace admission fails honestly; no lowered reservation or partial receipt',()=>{
 const f=actual(),audit=createAudit({...f.docs,resourceArena:f.arena}),before=f.arena.status().chargedBytes;
 const pressure=f.arena.reserve(f.arena.status().maxBytes-before-LIMITS.workingBytes+1);assert.ok(pressure);
 try{assert.throws(()=>audit.auditSchema(f.input),/resource_admission/);assert.equal(f.arena.status().chargedBytes,before+(f.arena.status().maxBytes-before-LIMITS.workingBytes+1));}finally{pressure.release();audit.close();f.close();zero(f.arena);}
});

test('per-definition expanded wire bounds reject an actual compiler schema without pruning columns',()=>{
 const f=actual({count:1,formula:'x'.repeat(MiB)}),audit=createAudit({...f.docs,resourceArena:f.arena});
 try{const before=f.arena.status().chargedBytes;assert.throws(()=>audit.auditSchema(f.input),/diagnostic_size:byte_bound/);assert.equal(f.arena.status().chargedBytes,before);}finally{audit.close();f.close();zero(f.arena);}
});

test('invalid optional semantics are rejected by the shared bulk semantics function',()=>{
 const f=actual({extra:{inputFields:[123]}}),audit=createAudit({...f.docs,resourceArena:f.arena});
 try{assert.throws(()=>audit.auditSchema(f.input),/semantic_metadata:inputFields/);assert.throws(()=>createGeneratedDefinitionLedger({...f.docs,schemas:[f.input]}),/semantic_metadata:inputFields/);}finally{audit.close();f.close();zero(f.arena);}
});

test('actual current-live declaration keeps a separate game-clock gap with exact bulk parity',()=>{
 const f=actual({targetId:'LIVE_MAP_WIN',stateMode:'LIVE',extra:{familyId:'L01',inputScopes:['current_live']}}),audit=createAudit({...f.docs,resourceArena:f.arena});let h,p;
 try{h=audit.auditSchema(f.input);p=h.readPage({limit:1});const oracle=createGeneratedDefinitionLedger({...f.docs,schemas:[f.input]}).definitions.find(d=>d.definition.id===p.findings[0].definitionId);assert.deepEqual(p.findings[0].semantics,oracle.semantics);assert.ok(p.findings[0].semantics.metadataGaps.includes('current_game_clock_policy_not_declared'));assert.deepEqual(h.receipt.currentDynamicProfiles,['synthetic.history.v1']);assert.equal(h.receipt.mixedCurrentDynamicSourceProfiles,false);}finally{p?.release();h?.release();audit.close();f.close();zero(f.arena);}
});

test('original schema identity, source-inventory variants and order remain distinct',()=>{
 const first=actual(),second=actual({formula:'changed formula'});const a=createAudit({...first.docs,resourceArena:first.arena}),b=createAudit({...second.docs,resourceArena:second.arena});let h1,h2;
 try{h1=a.auditSchema(first.input);h2=b.auditSchema(second.input);assert.notEqual(h1.receipt.schemaSha256,h2.receipt.schemaSha256);assert.notEqual(h1.receipt.orderedDefinitionFindingsSha256,h2.receipt.orderedDefinitionFindingsSha256);assert.equal(h1.receipt.namesSha256,h2.receipt.namesSha256);assert.equal(h1.receipt.counts.definitionOccurrences,3);assert.equal(h2.receipt.counts.definitionOccurrences,3);}finally{h1?.release();h2?.release();a.close();b.close();first.close();second.close();zero(first.arena);zero(second.arena);}
});

test('detail pages enforce independent bounds and workspace; a rejected page does not revoke its audit',()=>{
 const f=actual({count:5,formula:'x'.repeat(900000)}),audit=createAudit({...f.docs,resourceArena:f.arena});let h,p;
 try{h=audit.auditSchema(f.input);const before=f.arena.status().chargedBytes;assert.throws(()=>h.readPage({limit:129}),/page_bounds/);assert.throws(()=>h.readPage({offset:-1}),/page_bounds/);assert.throws(()=>h.readPage({limit:5}),/page_content_bound/);assert.equal(f.arena.status().chargedBytes,before);const pressure=f.arena.reserve(f.arena.status().maxBytes-before-LIMITS.pageWorkingBytes+1);assert.ok(pressure);try{assert.throws(()=>h.readPage({limit:1}),/resource_admission/);}finally{pressure.release();}p=h.readPage({offset:4,limit:1});assert.equal(p.findings.length,1);assert.equal(p.hasMore,false);}finally{p?.release();h?.release();audit.close();f.close();zero(f.arena);}
});

test('cancellation, reentrant audit and factory close during checkpoint never emit partial acceptance',()=>{
 for(const action of ['cancel','reenter','close']){
  const f=actual();let audit,armed=false,calls=0;const before=f.arena.status().chargedBytes;
  audit=createAudit({...f.docs,resourceArena:f.arena,shouldContinue(){calls++;if(!armed||calls<2)return true;if(action==='cancel')return false;if(action==='reenter')audit.auditSchema(f.input);else audit.close();return true;}});armed=true;
  try{assert.throws(()=>audit.auditSchema(f.input),new RegExp(action==='cancel'?'cancelled':action==='reenter'?'busy':'closed'));}finally{audit.close();assert.equal(f.arena.status().chargedBytes,before);f.close();zero(f.arena);}
 }
});
