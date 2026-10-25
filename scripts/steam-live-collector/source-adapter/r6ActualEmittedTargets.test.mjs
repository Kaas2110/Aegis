/** OPT-IN actual canonical producer emissions from retained SYNTHETIC fixtures.
 * No mocked vectors, providers, data refresh, fits, source95 claim or activation.
 * Run only in root's serial owned JobObject. R6b's explicit owner override
 * permits6GiB including owned children / aggregate24GiB; old R6 receipts stay
 * immutable. Default internal arena remains the historical2GiB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {digest,TARGET_IDS} from '../../feature-registry/registry-contract.mjs';
import {applyHistoricalTargetEligibility} from '../../feature-registry/historical-target-eligibility.mjs';
import {auditEmittedTargetSchemas} from '../../feature-registry/emitted-target-audit.mjs';
import {measureBoundedJsonBytes,createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {loadLocalUnifiedProducerConfig} from './unifiedProducerConfig.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {syntheticRichProducerFixture} from './r5RichProducer.fixtures.mjs';
import {advanceSeriesHistoryTarget} from './seriesHistoryTarget.mjs';
import {draftArgs,pinned,roster} from './observedDraftHistory.fixtures.mjs';

const AT='2026-10-23T12:40:00Z',AUDIT_WORK_BYTES=1536*1024**2,MAX_AUDIT_SCHEMA_BYTES=256*1024**2;
const OPT_IN=process.env.AEGIS_R6_ACTUAL_EMITTED_TARGETS==='1';
const REQUIRE_FULL_AUDIT=process.env.AEGIS_R6_REQUIRE_FULL_AUDIT==='1';
const AUDIT_ARENA_GIB=process.env.AEGIS_R6_AUDIT_ARENA_GIB??'2';
assert.ok(['2','6'].includes(AUDIT_ARENA_GIB),'only historical2GiB or explicitly authorized R6b6GiB arena');
const modeKey=(id,mode)=>id+':'+mode;
const expectedModes=()=>TARGET_IDS.flatMap(id=>(id==='SERIES_LIVE'?['observed_postdraft','observed_live']:[id.startsWith('SERIES_')?id:id.split('_')[0]]).map(mode=>modeKey(id,mode))).sort();

// Existing staticDiagnosticWriter/seriesHistoryTarget fixture semantics. PRE
// series identity has nominal teams/roster only: no first-map ID, sides or heroes.
function seriesInputs(maps=0){
 const known=maps?'2026-10-23T12:00:00Z':'2026-10-23T11:58:00Z';
 const seriesInput=pinned({contract:'aegis.series-map-receipts.v1',seriesId:'synthetic-series',bestOf:3,team1Id:'100',team2Id:'200',availableAt:known,completeThroughMapNumber:maps,previousMaps:maps?[{mapId:'80001',mapNumber:1,winnerTeamId:'100',availableAt:known,finishedAt:'2026-10-23T11:59:00Z',durationSeconds:2400,team1Kills:30,team2Kills:20,team1Heroes:[1,2,3,4,5],team2Heroes:[6,7,8,9,10]}]:[]});
 const identityInput=pinned({contract:'aegis.series-roster-receipt.v1',seriesId:'synthetic-series',team1Id:'100',team2Id:'200',knownAt:known,players:roster().map(p=>({team:p.side==='radiant'?'team1':'team2',accountId:p.accountId}))});
 const target=advanceSeriesHistoryTarget(null,{seriesInput,identityInput,decisionAt:AT}),facts=JSON.parse(draftArgs({accounts:true}).factsInput.utf8);facts.scope.targetHeroIds=[];
 assert.equal(Object.hasOwn(target.target,'matchId'),false);assert.equal(Object.hasOwn(target.target,'heroes'),false);assert.equal(Object.hasOwn(target.target,'sides'),false);
 return{seriesInput,seriesHistoryInput:{targetInput:target.targetInput,factsInput:pinned(facts)},decisionAt:AT};
}
function prematchInputs(){
 const facts=JSON.parse(draftArgs({accounts:true}).factsInput.utf8);facts.scope.targetHeroIds=[];
 const target={contract:'aegis.prematch-history-target.v1',matchId:'90001',knownAt:'2026-10-23T11:58:00Z',historyCutoffAt:'2026-10-23T11:58:00Z',teams:{radiant:'100',dire:'200'},players:roster().map(p=>({...p,heroId:null}))};
 return{mode:'PRE',matchId:'90001',decisionAt:AT,prematchInput:{targetInput:pinned(target),factsInput:pinned(facts)}};
}

/** Hold exact compiler-minted schemas, then discard producer/bundle owners before
 * building any ledger. Only compact receipts and private schema leases escape.
 * Every numeric value/missing bit below comes from the actual producer output. */
function capturePhase(phase,arena,config){
 let producer=null,bundle=null,richFixture=null;const held=[];
 try{
  if(phase==='POST'||phase==='LIVE'){
   richFixture=syntheticRichProducerFixture({resourceArena:arena});producer=richFixture.producer;bundle=richFixture.generate(phase==='LIVE'?30:null);
  }else{
   producer=createUnifiedFeatureProducer({...config,resourceArena:arena});bundle=producer.generateFeatureBundle(phase==='PRE'?prematchInputs():{mode:phase,...seriesInputs(phase==='BETWEEN'?1:0)});
  }
  assert.equal(bundle.mode,phase);assert.equal(bundle.eligibleForTraining,false);assert.equal(bundle.eligibleForServing,false);assert.equal(bundle.recordedPrediction,false);assert.equal(bundle.semanticStatus.sourceInventoryHash,digest(config.sourceInventory));
  if(phase==='SERIES_PRE'||phase==='BETWEEN'){assert.equal(bundle.matchId,null);assert.equal(bundle.targetBinding.mapId,null);assert.equal(bundle.targetBinding.mapSides,null);assert.ok(bundle.components.seriesHistorical?.names.length>0);assert.equal(bundle.components.legacyNative,null);}
  if(phase==='LIVE'){assert.equal(bundle.components.legacyNative.eventClockSeconds,30);assert.ok(bundle.components.legacyNative.eventClockSeconds>0);assert.equal(bundle.routes.find(r=>r.targetId==='SERIES_LIVE').stateMode,'observed_live');}
  if(phase==='POST')assert.equal(bundle.routes.find(r=>r.targetId==='SERIES_LIVE').stateMode,'observed_postdraft');
  const expected={PRE:['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION'],SERIES_PRE:['SERIES_PRE'],POST:['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE'],LIVE:['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE'],BETWEEN:['SERIES_BETWEEN']}[phase];
  assert.deepEqual(bundle.routes.map(r=>r.targetId),expected);
  for(const route of bundle.routes){
   const lease=producer.retainSchema(route.schemaRef.sha256);assert.ok(lease,'actual schema must retain its private compiler ownership');
   const historyComponent=bundle.components.seriesHistorical??bundle.components.historical;
   const item={lease,route:{targetId:route.targetId,stateMode:route.stateMode,schemaSha256:route.schemaRef.sha256,namesSha256:route.schemaRef.namesSha256,featureCount:route.schemaRef.featureCount,historicalScopeQualified:historyComponent?.audit?.scopeQualified??null,historicalPopulationBasis:historyComponent?.audit?.populationBasis??null,sourceAdmissionClassification:bundle.sourceAdmission?.classification??null,sourceAdmissionDynamicAllowed:bundle.sourceAdmission?.dynamicDiagnosticAllowed??false},phase};held.push(item);
   assert.equal(lease.schema,route.diagnosticSchema);assert.equal(lease.descriptor.sha256,route.schemaRef.sha256);assert.equal(route.inferenceVector,null);assert.ok(item.route.featureCount>0);assert.equal(route.diagnosticVector.names.length,item.route.featureCount);assert.equal(lease.schema.definitions.length,item.route.featureCount);
   const familyIds=new Set(),sourceProfiles=new Set(),inputScopes=new Set();
   for(let i=0;i<item.route.featureCount;i++){const d=lease.schema.definitions[i];assert.equal(d.name,route.diagnosticVector.names[i]);assert.equal(typeof route.diagnosticVector.missing[i],'boolean');assert.equal(route.diagnosticVector.missing[i],route.diagnosticVector.values[i]===null);familyIds.add(d.familyId);sourceProfiles.add(d.sourceProfile);for(const scope of d.inputScopes)inputScopes.add(scope);}
   Object.assign(item.route,{actualDeclaredFamilyIds:[...familyIds].sort(),actualDeclaredSourceProfiles:[...sourceProfiles].sort(),actualDeclaredInputScopes:[...inputScopes].sort()});
   if(['PRE','SERIES_PRE','BETWEEN'].includes(phase))assert.ok(lease.schema.definitions.every(d=>!d.inputScopes.includes('current_draft')&&!d.inputScopes.includes('current_live')));
   item.route.expandedVectorSha256=digest({namesHash:item.route.namesSha256,values:route.diagnosticVector.values,missing:route.diagnosticVector.missing});
  }
  return held;
 }catch(error){for(const item of held)item.lease.release();throw error;}
 finally{bundle?.release();producer?.close();bundle=null;richFixture=null;producer=null;}
}

test('actual canonical producer covers all13modes with explicit per-target audit admission',{skip:!OPT_IN},t=>{
 const config=loadLocalUnifiedProducerConfig(),docs={index:config.index,...applyHistoricalTargetEligibility(config)},registryHash=digest(docs),sourceInventoryHash=digest(config.sourceInventory),receipts=[],phases=[];
 const sourceFiles=[...new Map(Object.values(config.sourceInventory).flatMap(i=>i.files).map(f=>[f.path,f])).values()].sort((a,b)=>a.path.localeCompare(b.path,'en'));
 for(const phase of ['PRE','SERIES_PRE','POST','LIVE','BETWEEN']){
  const arena=createDiagnosticResourceArena({maxBytes:Number(AUDIT_ARENA_GIB)*1024**3}),started=performance.now();let held=[];
  try{
   held=capturePhase(phase,arena,config);
   for(const item of held){
    assert.equal(item.lease.schema.registryHash,registryHash);const arenaBeforeAdmission=arena.status(),work=arena.reserve(AUDIT_WORK_BYTES);
    if(!work){
     // Emission coverage and exact bytes/definitions are already bound by the
     // actual private schema/vector receipts. Denied bulk-ledger admission must
     // remain a separate OPEN gate, never a smaller unchecked scratch estimate,
     // fabricated empty audit, omitted target, reduced vector or raised cap.
     receipts.push({...item.route,phase,registryHash,auditStatus:'deferred_memory_admission',auditRequestedWorkingBytes:AUDIT_WORK_BYTES,arenaBeforeAuditAdmission:arenaBeforeAdmission,arenaAfterAuditAdmission:arena.status(),schemaBytes:null,ledgerSha256:null,auditSha256:null,generatedVariants:null,variantsWithDeclarationGaps:null,metadataGapCounts:null,emittedFamilyIds:null,missingEligibleFamilyIds:null,sourceProfiles:null,mixedCurrentDynamicSchemaSha256s:null,issues:['bulk_exact_ledger_workspace_not_admitted']});
     item.lease.release();continue;
    }
    try{
     const schemaBytes=measureBoundedJsonBytes(item.lease.schema,{maxBytes:MAX_AUDIT_SCHEMA_BYTES,maxNodes:16000000});
     // One complete held actual schema per audit. All twelve targets/79families/
     // 14legacy ranges remain visible in each report; absent schemas stay absent.
     const audit=auditEmittedTargetSchemas({...docs,schemas:[{schema:item.lease.schema,sha256:item.route.schemaSha256}],limits:{maxSchemas:1,maxDefinitions:150000,maxOccurrences:150000}}),row=audit.targets.find(r=>r.targetId===item.route.targetId&&r.stateMode===item.route.stateMode);
     assert.ok(row);assert.equal(audit.counts.suppliedTargetModes,1);assert.equal(audit.counts.generatedVariants,item.route.featureCount);assert.equal(row.definitionOccurrenceCount,item.route.featureCount);assert.deepEqual(row.schemaSha256s,[item.route.schemaSha256]);assert.equal(audit.counts.families,79);assert.equal(audit.counts.legacyGroups,14);assert.equal(audit.counts.legacyOccurrences,config.index.catalogueOccurrenceCount);assert.equal(audit.counts.legacyUnresolvedOccurrences,config.index.catalogueOccurrenceCount);assert.ok(audit.counts.variantsWithDeclarationGaps>0);
     for(const key of ['semanticAcceptance','fullFeatureGateComplete','sourceAvailabilityAttested','trainingAdmitted','servingAdmitted','legacyAliasesResolved'])assert.equal(audit[key],false);
     const metadataGapCounts={};for(const group of audit.declarationGapGroups)for(const code of group.gapCodes)metadataGapCounts[code]=(metadataGapCounts[code]??0)+group.variantSha256s.length;
     receipts.push({...item.route,phase,schemaBytes,registryHash,auditStatus:'accepted_exact_supplied_schema_declaration_audit',auditRequestedWorkingBytes:AUDIT_WORK_BYTES,arenaBeforeAuditAdmission:arenaBeforeAdmission,arenaAfterAuditAdmission:arena.status(),ledgerSha256:audit.ledgerSha256,auditSha256:audit.contentHash,generatedVariants:audit.counts.generatedVariants,variantsWithDeclarationGaps:audit.counts.variantsWithDeclarationGaps,metadataGapCounts,emittedFamilyIds:row.emittedFamilies,missingEligibleFamilyIds:row.missingEligibleFamilies.map(f=>f.familyId),sourceProfiles:row.sourceProfiles,mixedCurrentDynamicSchemaSha256s:row.mixedCurrentDynamicSchemaSha256s,issues:row.issues});
    }finally{work.release();item.lease.release();}
   }
  }finally{for(const item of held)item.lease.release();held=[];const state=arena.status();assert.equal(state.chargedBytes,0);assert.equal(state.leases,0);assert.equal(state.heldAssets,0);phases.push({phase,elapsedMs:performance.now()-started,arena:state});}
 }
 assert.deepEqual(receipts.map(r=>modeKey(r.targetId,r.stateMode)).sort(),expectedModes());assert.equal(new Set(receipts.map(r=>r.targetId)).size,12);assert.equal(new Set(receipts.map(r=>r.schemaSha256)).size,13);assert.ok(receipts.find(r=>r.targetId==='SERIES_PRE'&&r.phase==='SERIES_PRE'));assert.equal(receipts.filter(r=>r.targetId==='SERIES_LIVE').length,2);
 const acceptedAudits=receipts.filter(r=>r.auditStatus==='accepted_exact_supplied_schema_declaration_audit').length,deferredAudits=receipts.filter(r=>r.auditStatus==='deferred_memory_admission').length,fullActualAuditAccepted=acceptedAudits===13&&deferredAudits===0;
 assert.equal(acceptedAudits+deferredAudits,13);for(const r of receipts.filter(r=>r.auditStatus==='deferred_memory_admission'))for(const key of ['schemaBytes','ledgerSha256','auditSha256','generatedVariants','variantsWithDeclarationGaps','metadataGapCounts','emittedFamilyIds','missingEligibleFamilyIds','sourceProfiles','mixedCurrentDynamicSchemaSha256s'])assert.equal(r[key],null);
 const body={contract:'aegis.r6-actual-emitted-targets-technical-receipt.v2',arenaGiB:Number(AUDIT_ARENA_GIB),arenaPolicy:AUDIT_ARENA_GIB==='6'?'explicit_owner_R6b_override_one_check6GiB_aggregate24GiB':'historical_R6_internal2GiB',canonicalRegistrySha256:config.canonicalRegistrySha256,registryHash,sourceInventoryHash,sourceFiles,counts:{logicalTargets:12,targetModes:13,distinctSchemas:13,schemaDefinitionOccurrences:receipts.reduce((n,r)=>n+r.featureCount,0),acceptedDeclarationAuditTargetModes:acceptedAudits,deferredDeclarationAuditTargetModes:deferredAudits,catalogueFamilies:79,legacyGroups:14,legacyUnresolvedOccurrences:config.index.catalogueOccurrenceCount},auditGrouping:'one_exact_actual_schema_at_a_time_with_private_lease; no_global_definition_dedup_count',auditWorkingBytes:AUDIT_WORK_BYTES,maximumAuditSchemaBytes:MAX_AUDIT_SCHEMA_BYTES,receipts,phases,actualEmissionCoverageAccepted:true,fullActualAuditAccepted,requireFullAudit:REQUIRE_FULL_AUDIT,syntheticInputs:true,actualCanonicalProducer:true,mockedVectors:false,positiveLiveClockSeconds:30,independentSeriesPreWithoutMapOrSides:true,sourceAvailabilityAttested:false,prospectiveCoverageAttested:false,semanticAcceptance:false,fullFeatureGateComplete:false,training:false,serving:false,modelQualityEvaluated:false};
 t.diagnostic(JSON.stringify({...body,contentHash:digest(body)}));
 if(REQUIRE_FULL_AUDIT)assert.equal(fullActualAuditAccepted,true,'all13declaration audits required; actual emission success cannot close a deferred bulk-ledger memory gate');
});
