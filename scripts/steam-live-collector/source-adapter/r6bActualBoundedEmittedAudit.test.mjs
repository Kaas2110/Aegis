/** OPT-IN actual canonical producer emissions from retained SYNTHETIC fixtures.
 * No mocked vectors, providers, data refresh, fits, source95 claim or activation.
 * Run only in root's serial owned JobObject. R6b's explicit owner override
 * permits6GiB including owned children / aggregate24GiB; old R6 receipts stay
 * immutable. This NEW bounded-audit fixture explicitly selects6GiB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {digest,TARGET_IDS} from '../../feature-registry/registry-contract.mjs';
import {applyHistoricalTargetEligibility} from '../../feature-registry/historical-target-eligibility.mjs';
import {createBoundedEmittedDefinitionAudit,BOUNDED_EMITTED_AUDIT_LIMITS} from '../../feature-registry/bounded-emitted-definition-audit.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {loadLocalUnifiedProducerConfig} from './unifiedProducerConfig.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {syntheticRichProducerFixture} from './r5RichProducer.fixtures.mjs';
import {advanceSeriesHistoryTarget} from './seriesHistoryTarget.mjs';
import {draftArgs,pinned,roster} from './observedDraftHistory.fixtures.mjs';

const AT='2026-10-23T12:40:00Z';
const OPT_IN=process.env.AEGIS_R6B_ACTUAL_BOUNDED_AUDIT==='1';

const AUDIT_ARENA_GIB=6; // Explicit owner R6b override; not a historical R6 receipt.

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

test('R6b actual canonical all13 schema declaration audits are exhaustive with bounded details',{skip:!OPT_IN},t=>{
 const config=loadLocalUnifiedProducerConfig(),docs={index:config.index,...applyHistoricalTargetEligibility(config)},registryHash=digest(docs),receipts=[],phases=[];
 const sourceFiles=[...new Map(Object.values(config.sourceInventory).flatMap(i=>i.files).map(f=>[f.path,f])).values()].sort((a,b)=>a.path.localeCompare(b.path,'en'));
 for(const phase of ['PRE','SERIES_PRE','POST','LIVE','BETWEEN']){
  const arena=createDiagnosticResourceArena({maxBytes:AUDIT_ARENA_GIB*1024**3}),started=performance.now();let held=[],auditor=null;
  try{
   held=capturePhase(phase,arena,config);auditor=createBoundedEmittedDefinitionAudit({...docs,resourceArena:arena});
   for(const item of held){
    let handle=null;const arenaBeforeAudit=arena.status();
    try{
     handle=auditor.auditSchema({schema:item.lease.schema,sha256:item.route.schemaSha256});const r=handle.receipt;
     assert.equal(r.schemaSha256,item.route.schemaSha256);assert.equal(r.namesSha256,item.route.namesSha256);assert.equal(r.registryHash,registryHash);assert.equal(r.targetId,item.route.targetId);assert.equal(r.stateMode,item.route.stateMode);assert.equal(r.counts.definitionOccurrences,item.route.featureCount);assert.equal(r.counts.families,79);assert.equal(r.counts.legacyGroups,14);assert.equal(r.counts.legacyUnresolvedOccurrences,config.index.catalogueOccurrenceCount);assert.equal(r.exhaustiveDeclarationAudit,true);assert.equal(r.skippedDefinitions,0);assert.ok(r.counts.occurrencesWithDeclarationGaps>0);
     for(const key of ['semanticAcceptance','fullFeatureGateComplete','sourceAvailabilityAttested','observedAvailabilityMeasured','trainingAdmitted','servingAdmitted','legacyAliasesResolved'])assert.equal(r[key],false);
     // Exhaustive first pass is above; detail samples do not stand in for it.
     // Each independently owned page binds original index+definition bytes.
     const samples=[0,Math.floor(item.route.featureCount/2),item.route.featureCount-1],pageReceipts=[];
     for(const offset of [...new Set(samples)]){
      const page=handle.readPage({offset,limit:1});
      try{assert.equal(page.findings.length,1);const f=page.findings[0];assert.equal(f.index,offset);assert.equal(f.definition,item.lease.schema.definitions[offset]);assert.equal(digest(f.definition),f.definitionSha256);pageReceipts.push({offset,definitionSha256:f.definitionSha256,variantSha256:f.variantSha256});}finally{page.release();}
     }
     receipts.push({...item.route,phase,auditStatus:'accepted_exhaustive_original_schema_declaration_audit',exhaustiveDeclarationAudit:r.exhaustiveDeclarationAudit,skippedDefinitions:r.skippedDefinitions,auditSha256:r.contentHash,orderedDefinitionFindingsSha256:r.orderedDefinitionFindingsSha256,definitionOccurrences:r.counts.definitionOccurrences,occurrencesWithDeclarationGaps:r.counts.occurrencesWithDeclarationGaps,metadataGapCounts:r.metadataGapCounts,emittedFamilyIds:r.emittedFamilyIds,missingEligibleFamilyIds:r.missingEligibleFamilyIds,sourceProfiles:r.sourceProfiles,currentDynamicProfiles:r.currentDynamicProfiles,mixedCurrentDynamicSourceProfiles:r.mixedCurrentDynamicSourceProfiles,sourceInventoryRefs:r.sourceInventoryRefs,pageReceipts,arenaBeforeAudit,arenaWhileAuditOwned:arena.status()});
    }finally{handle?.release();item.lease.release();}
   }
  }finally{auditor?.close();for(const item of held)item.lease.release();held=[];const state=arena.status();assert.equal(state.chargedBytes,0);assert.equal(state.leases,0);assert.equal(state.heldAssets,0);phases.push({phase,elapsedMs:performance.now()-started,arena:state});}
 }
 assert.deepEqual(receipts.map(r=>modeKey(r.targetId,r.stateMode)).sort(),expectedModes());assert.equal(new Set(receipts.map(r=>r.targetId)).size,12);assert.equal(new Set(receipts.map(r=>r.schemaSha256)).size,13);assert.equal(receipts.length,13);assert.equal(receipts.filter(r=>r.stateMode==='LIVE'||r.stateMode==='observed_live').length,4);assert.equal(receipts.reduce((n,r)=>n+r.skippedDefinitions,0),0);
 const body={contract:'aegis.r6b-actual-bounded-emitted-audit-technical-receipt.v1',canonicalRegistrySha256:config.canonicalRegistrySha256,registryHash,sourceInventoryHash:digest(config.sourceInventory),sourceFiles,arenaGiB:AUDIT_ARENA_GIB,arenaPolicy:'explicit_owner_R6b_override_one_check6GiB_aggregate24GiB',auditLimits:BOUNDED_EMITTED_AUDIT_LIMITS,counts:{logicalTargets:12,targetModes:13,distinctSchemas:13,acceptedDeclarationAuditTargetModes:receipts.length,deferredDeclarationAuditTargetModes:0,skippedDefinitions:0,schemaDefinitionOccurrences:receipts.reduce((n,r)=>n+r.definitionOccurrences,0),families:79,legacyGroups:14,legacyUnresolvedOccurrences:config.index.catalogueOccurrenceCount},auditGrouping:'one_original_full_schema_per_bounded_exhaustive_audit_with_private_compiler_lease; no_global_variant_dedup_claim',receipts,phases,actualEmissionCoverageAccepted:true,fullActualDeclarationAuditAccepted:true,syntheticInputs:true,actualCanonicalProducer:true,mockedVectors:false,positiveLiveClockSeconds:30,independentSeriesPreWithoutMapOrSides:true,engineeringOwnershipEstimatesNotMeasuredRSS:true,sourceAvailabilityAttested:false,prospectiveCoverageAttested:false,semanticAcceptance:false,fullFeatureGateComplete:false,training:false,serving:false,modelQualityEvaluated:false};
 t.diagnostic(JSON.stringify({...body,contentHash:digest(body)}));
});