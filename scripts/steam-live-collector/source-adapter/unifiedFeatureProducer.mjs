/** One diagnostic generation entry: same arithmetic for retained replay/runtime.
 * No provider/DB calls, fits, weights, predictions or client supplied vectors.
 * Source inventory is host-owned deployment metadata, never serving admission. */
import {createHash} from 'node:crypto';
import {digest,FAMILY_IDS,validateRegistry,validateProjection} from '../../feature-registry/registry-contract.mjs';
import {producePrematchHistoricalRelationalFeatures,produceSeriesHistoricalRelationalFeatures} from './historicalRelationalFeatures.mjs';
import {readDynamicHistoryProof,advanceObservedDraftFeatureBundle} from './observedDraftFeatureBundle.mjs';
import {produceSeriesContext} from './seriesContextFeatures.mjs';
import {createVerifiedHistorySourceHandle,readVerifiedHistorySourceHandle} from './historySourceVerifier.mjs';
import {instantNs} from './causalTime.mjs';
import {replayPinnedDraftPrefix} from './observedDraftHistory.mjs';
import {readPinnedHistoricalJson} from './historicalAlignment.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {classifySteamObservationPhase} from './steamPhasePolicy.mjs';
import {applyHistoricalTargetEligibility} from '../../feature-registry/historical-target-eligibility.mjs';
import {loadLocalUnifiedProducerConfig} from './unifiedProducerConfig.mjs';
import {createFeatureProjectionCompiler} from './featureProjectionCompiler.mjs';
import {createDiagnosticResourceArena,snapshotPlainRecord} from './diagnosticResourceArena.mjs';
import {FEATURE_ASSET_WORKING_BYTES,inspectFeatureAsset,freezeFeatureAsset,featureAssetRecord,retainFeatureAsset,withFeatureRelease} from './featureProjectionOwnership.mjs';
import {VERIFIED_RETAINED_REFERENCE_SOURCE_HANDLE_CONTRACT,readVerifiedRetainedReferenceSourceHandle} from './retainedReferenceCorpus.mjs';
import {produceDraftIdentityFeatures} from './draftIdentityFeatures.mjs';
import {readCurrentSteamInput} from './currentSteamInput.mjs';
import {steamObservationIdentity} from './steamObservationIdentity.mjs';
export const UNIFIED_PRODUCER_CONTRACT='aegis.unified-diagnostic-feature-producer.v2';
const SH=/^[a-f0-9]{64}$/,scopes=new Set(['prior_maps','current_identity','current_draft','current_live','series_context','previous_series_maps','candidate_axis']);
const fail=x=>{throw Error('unified_features:'+x);};
const latest=xs=>xs.filter(x=>instantNs(x)!==null).reduce((a,b)=>a===null||instantNs(b)>instantNs(a)?b:a,null);
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const targets={PRE:['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','SERIES_PRE'],POST:['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE'],LIVE:['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE'],BETWEEN:['SERIES_BETWEEN'],SERIES_PRE:['SERIES_PRE']};
const sourceProfile={history:'local_prior_completed_map_facts',live:'steam.GetLiveLeagueGames.v1.scoreboard',series:'retained_series_map_receipts',draft:'retained_observed_draft_identity',seriesHistory:'retained_prior_map_facts_oriented_to_series_teams'};
// Routing consumes the same pinned bytes as the dynamic producer. A rejected
// live packet is never converted into a fresh POST result by fallback.
export function createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory,resourceArena=null,projectionOptions={}}={}){
 if(index===undefined&&familyDocument===undefined&&targetDocument===undefined){const local=loadLocalUnifiedProducerConfig();({index,familyDocument,targetDocument}=local);sourceInventory??=local.sourceInventory;}
 // Apply the explicit reviewed family-union correction; per-definition scopes
 // still exclude current heroes/live values from every PRE projection.
 const corrected=applyHistoricalTargetEligibility({familyDocument,targetDocument});
 const docs=structuredClone({index,...corrected}),registry=validateRegistry(docs.index,docs.familyDocument,docs.targetDocument);
 if(!sourceInventory||Object.keys(sourceInventory).sort().join(',')!=='draft,history,live,series,seriesHistory'||Object.values(sourceInventory).some(p=>!SH.test(p?.primarySha256??'')||!Array.isArray(p.files)||!p.files.length||p.files.length>64||p.files.some(f=>typeof f.path!=='string'||!SH.test(f.sha256??''))||!p.files.some(f=>f.sha256===p.primarySha256)||new Set(p.files.map(f=>f.path)).size!==p.files.length))fail('source_inventory');
 const inventory=freeze(structuredClone(sourceInventory)),registryHash=digest(docs);
 const arena=resourceArena??createDiagnosticResourceArena(),compiler=createFeatureProjectionCompiler({...projectionOptions,registry,registryHash,sourceInventory:inventory,sourceProfiles:sourceProfile,resourceArena:arena});
 const normalize=compiler.normalize,draftCache=new Map(),historyCache=new Map(),metadataCache=new Map();let closed=false,activeBundles=0,sharedAssetHits=0,sharedAssetCreations=0;
 const sourceInventoryHash=digest(inventory);
 function retain(record){const lease=retainFeatureAsset(arena,record);if(!lease)fail('producer_resource_admission');return lease;}
 function ownShared(cache,key,value,identity=value){
  let entry=cache.get(key);if(entry&&entry.identity!==identity)fail('shared_asset_identity_changed');
  if(entry){cache.delete(key);cache.set(key,entry);sharedAssetHits++;return{value:entry.record.value,lease:retain(entry.record)};}
  const working=arena.reserve(FEATURE_ASSET_WORKING_BYTES);if(!working)fail('producer_resource_admission');
  try{
   const size=inspectFeatureAsset(value),creation=arena.reserve(size.bytes);if(!creation)fail('producer_resource_admission');
   try{
    const data=size.deeplyFrozen?value:freezeFeatureAsset(structuredClone(value)),record=featureAssetRecord(data,size.bytes),cacheLease=retain(record);
    try{const lease=retain(record);entry={identity,record,lease:cacheLease};while(cache.size>=8){const oldest=cache.keys().next().value;cache.get(oldest).lease.release();cache.delete(oldest);}cache.set(key,entry);sharedAssetCreations++;return{value:data,lease};}catch(error){cacheLease.release();throw error;}
   }finally{creation.release();}
  }finally{working.release();}
 }
 function ownBundleValue(value){const working=arena.reserve(FEATURE_ASSET_WORKING_BYTES);if(!working)fail('producer_resource_admission');try{const size=inspectFeatureAsset(value),creation=arena.reserve(size.bytes);if(!creation)fail('producer_resource_admission');try{const data=freezeFeatureAsset(value),record=featureAssetRecord(data,size.bytes);return retain(record);}finally{creation.release();}}finally{working.release();}}
 const project=(blocks,targetId,mode,semanticInputs,rowCache)=>compiler.project(blocks,targetId,targetId==='SERIES_LIVE'?(mode==='LIVE'?'observed_live':'observed_postdraft'):targetId.startsWith('SERIES_')?targetId:mode,semanticInputs,rowCache);
 return Object.freeze({contract:UNIFIED_PRODUCER_CONTRACT,getSchema:compiler.getSchema,retainSchema:compiler.retainSchema,compilerStatus:compiler.status,
  resourceStatus(){return{activeBundles,sharedAssetHits,sharedAssetCreations,historyAssets:historyCache.size,draftAssets:draftCache.size,metadataAssets:metadataCache.size,closed,resources:arena.status()};},
  close(){if(closed)return false;closed=true;for(const cache of [draftCache,historyCache,metadataCache]){for(const e of cache.values())e.lease.release();cache.clear();}compiler.close();return true;},
  generateFeatureBundle({mode='AUTO',matchId=null,decisionAt,historyProof=null,prematchInput=null,livePrefixInputs=null,previousLiveState=null,seriesInput=null,currentMapNumber=null,rulesEvidence=null,expectedRulesSha256=null,eventsEvidence=null,expectedEventsSha256=null,patch=null,sourceExportInput=null,sourceExportHandle=null,expectedSourceSnapshotHash=null,seriesHistoryInput=null,progressionProof=null,retainedReplayProof=null}={}){
   if(closed)fail('producer_closed');const bundleLeases=[],blocks=[],routes=[];
   try{
   if(!['AUTO','PRE','POST','LIVE','BETWEEN','SERIES_PRE'].includes(mode)||instantNs(decisionAt)===null)fail('mode_or_decision');
   let historical=null,context=null,live=null,series=null,selectedMode=mode,sourceExport=null,sourceAdmission=null,inputSourceBindings=[],targetBinding=null,seriesHistorical=null,draft=null,reconstruction=null;
   if(sourceExportInput!==null&&sourceExportHandle!==null)fail('mixed_source_export_authorities');
   if(sourceExportInput!==null||sourceExportHandle!==null){
    const expected=expectedSourceSnapshotHash??sourceExportInput?.pin?.sha256,options={expectedSourceSnapshotHash:expected,matchId,decisionAt};
    const handle=sourceExportHandle??createVerifiedHistorySourceHandle(sourceExportInput,options);
    const sourceHandleContract=snapshotPlainRecord(handle,{maxKeys:8}).contract;
    sourceExport=sourceHandleContract===VERIFIED_RETAINED_REFERENCE_SOURCE_HANDLE_CONTRACT?readVerifiedRetainedReferenceSourceHandle(handle,options):readVerifiedHistorySourceHandle(handle,options);if(!sourceExport.population.factsUsable)fail('unavailable_history_source_export');
   }
   if(historyProof!==null){const h=readDynamicHistoryProof(historyProof,{matchId,decisionAt});if(!h.accepted)fail(h.reason);const owned=ownShared(historyCache,historyProof,Object.freeze({context:h.context,relational:h.relational}),h.context);bundleLeases.push(owned.lease);context=owned.value.context;historical=owned.value.relational;
   }
   if(prematchInput!==null){if(historyProof!==null)fail('mixed_prematch_and_draft_context');historical=producePrematchHistoricalRelationalFeatures({...prematchInput,decisionAt});}
   if(sourceExport){
    const i=sourceExport.identity;
    if(!historical||historical.factsSha256!==sourceExport.factsSha256)fail('history_export_facts_binding');
    // This export contract includes an observed draft. It must not attest a PRE
    // target, whose selectors and identity intentionally do not contain heroes.
    if(!context)fail('history_export_requires_observed_draft_context');
    const d=context.draftState,b=context.producer.bindings;
    if(i.matchId!==context.matchId||i.revision!==d.revision||i.draftHash!==d.identity.draftHash||i.rosterHash!==d.identity.rosterHash||i.sideIdentityHash!==d.identity.sideIdentityHash||instantNs(i.historyCutoffAt)!==instantNs(context.historyCutoffAt)||instantNs(i.validFrom)!==instantNs(context.validFrom)||sourceExport.nativeSha256!==b.nativeObservations.sha256||sourceExport.draftPrefixBindingHash!==digest(b.draftPrefix.map(p=>({raw:p.raw.sha256,metadata:p.metadata.sha256}))))fail('history_export_context_binding');
   }
   if(seriesHistoryInput!==null){
    if(!['SERIES_PRE','BETWEEN'].includes(mode))fail('independent_series_history_phase_only');
    seriesHistorical=produceSeriesHistoricalRelationalFeatures({...seriesHistoryInput,decisionAt});
    if(seriesInput===null)fail('series_history_series_receipt_required');
    const sr=JSON.parse(seriesInput.utf8),st=JSON.parse(seriesHistoryInput.targetInput.utf8);
    if(sr.seriesId!==seriesHistorical.seriesId||sr.team1Id!==seriesHistorical.team1Id||sr.team2Id!==seriesHistorical.team2Id)fail('series_history_identity_binding');
    if(mode==='SERIES_PRE'&&(sr.completeThroughMapNumber!==0||st.phase!=='SERIES_PRE')||mode==='BETWEEN'&&(sr.completeThroughMapNumber===0||st.phase!=='SERIES_BETWEEN'||st.transitionId!==sr.seriesId+':after:'+sr.completeThroughMapNumber))fail('series_history_transition_binding');
   }
   if(mode==='SERIES_PRE'){
    if(matchId!==null||historyProof!==null||prematchInput!==null||livePrefixInputs!==null||currentMapNumber!==null||seriesHistorical===null)fail('independent_series_prematch_inputs');
   }
   else if(mode==='BETWEEN'){if(historyProof!==null||prematchInput!==null||livePrefixInputs!==null||matchId!==null||currentMapNumber!==null)fail('between_maps_stale_current_map');}
   else if(mode==='PRE'||mode==='AUTO'&&historyProof===null){if(!historical||prematchInput===null||livePrefixInputs!==null)fail('prematch_inputs');if(historical.matchId!==matchId)fail('prematch_map_identity');selectedMode='PRE';}
   else {
    if(!context)fail('verified_draft_history_required');
    if(livePrefixInputs!==null){
     const route=readCurrentSteamInput({prefix:livePrefixInputs,context,matchId,decisionAt,progressionProof,retainedReplayProof});sourceAdmission=route.admission;inputSourceBindings=route.bindings;reconstruction=route.reconstruction;
     if(sourceAdmission.dynamicDiagnosticAllowed){
      if(mode==='POST')fail('explicit_post_on_live_observation');
      live=advanceObservedDraftFeatureBundle(previousLiveState,{livePrefixInputs,matchId,decisionAt,sourceDecisionAt:route.sourceDecisionAt,historyProof,patch,rulesEvidence,expectedRulesSha256,eventsEvidence,expectedEventsSha256,progressionProof,retainedReplayProof});
      if(live?.status!=='diagnostic_produced')fail('live_admission:'+live?.reason);
      selectedMode='LIVE';
     }else{
      if(mode==='LIVE'||previousLiveState!==null)fail('live_phase_unavailable_no_static_downgrade');
      selectedMode='POST';
     }
    }else{
     if(mode==='LIVE'||previousLiveState!==null)fail('live_prefix_required');
     selectedMode='POST';
     sourceAdmission={classification:'retained_context_static_only',reason:'no_current_observation_supplied',dynamicDiagnosticAllowed:false,staticDraftDiagnosticAllowed:true,cohort:'unknown_or_late_not_early_postdraft',provenance:null};
    }
   }
   if(context){
    const existing=draftCache.get(context),owned=ownShared(draftCache,context,existing?.record.value??produceDraftIdentityFeatures({historyProof,matchId,decisionAt}),context);
    draft=owned.value;bundleLeases.push(owned.lease);
   }
   let seriesDraft=null,currentMapSides=null;
   const mapSides=context?Object.fromEntries(context.draftState.identity.sides.map(x=>[x.side,x.teamId])):prematchInput?JSON.parse(prematchInput.targetInput.utf8).teams:null;
   targetBinding={mapId:matchId,mapOutcome:matchId===null?null:'map_radiant_win',mapSides,series:null};
   if(seriesInput!==null){
    const s=JSON.parse(seriesInput.utf8);
    if(mapSides){
     if(!mapSides.radiant||!mapSides.dire||new Set([mapSides.radiant,mapSides.dire]).size!==2||![s.team1Id,s.team2Id].every(t=>[mapSides.radiant,mapSides.dire].includes(t)))fail('series_current_team_orientation');
     currentMapSides={mapId:matchId,seriesId:s.seriesId,radiantTeamId:mapSides.radiant,direTeamId:mapSides.dire,availableAt:context?.validFrom??historical.validFrom};
    }
    targetBinding.series={seriesId:s.seriesId,team1Id:s.team1Id,team2Id:s.team2Id,outcome:'series_team1_win',team1CurrentSide:mapSides?(s.team1Id===mapSides.radiant?'radiant':'dire'):null};
    if(context){const players=context.draftState.identity.players,group=team=>players.filter(p=>p.teamId===team).map(p=>Number(p.heroId));
     const a=group(s.team1Id),b=group(s.team2Id);if(a.length!==5||b.length!==5)fail('series_team_draft_orientation');
     seriesDraft={seriesId:s.seriesId,mapId:matchId,availableAt:context.validFrom,team1Heroes:a,team2Heroes:b};
    }
    series=produceSeriesContext({seriesInput,decisionAt:reconstruction?.sourceDecisionAt??decisionAt,currentMapId:['BETWEEN','SERIES_PRE'].includes(selectedMode)?null:matchId,currentMapNumber:['BETWEEN','SERIES_PRE'].includes(selectedMode)?null:currentMapNumber,currentDraft:seriesDraft,currentMapSides});
   }
   for(const [component,id] of [[historical,'history'],[draft,'draft'],[seriesHistorical,'seriesHistory'],[selectedMode==='LIVE'?live:null,'live'],[series&&!series.terminal?series:null,'series']])if(component)blocks.push(normalize(component,id));
   if(selectedMode==='LIVE'){
    const v=live.vector,owned=ownShared(metadataCache,v.definitions,Object.freeze({names:v.names,definitions:v.definitions}),v.names);bundleLeases.push(owned.lease);
   }
   // The bundle owns retained source rows as well as compiled output rows. Shared
   // history/draft and live metadata are accounted once by their cache owners.
   bundleLeases.push(ownBundleValue({historical:historyProof===null?historical:null,seriesHistorical,liveRows:selectedMode==='LIVE'?{values:live.vector.values,masks:live.vector.masks}:null,legacyNative:selectedMode==='LIVE'?live.nativeBundle:null,series}));
   const semanticInputs=selectedMode==='LIVE'?{patch,rulesSha256:live.semanticEvidence.rulesSha256,nativeBundleContract:live.nativeBundle.contract,sourceProfile:live.sourceCoherence.sourceProfile,admissionProfile:sourceAdmission?.admissionProfile??'EXPLICIT_PHASE5'}:null;
   const rowCache=new Map();
   const seriesAlreadyStarted=seriesInput!==null&&JSON.parse(seriesInput.utf8).completeThroughMapNumber>0;
   if(!series?.terminal)for(const target of targets[selectedMode].filter(t=>(!t.startsWith('SERIES_')||series!==null)&&!(selectedMode==='PRE'&&t==='SERIES_PRE'&&seriesAlreadyStarted)))routes.push(project(blocks,target,selectedMode,semanticInputs,rowCache));
   const availableAt=latest([context?.computedAt,historical?.validFrom,seriesHistorical?.validFrom,live?.knownAt,sourceAdmission?.provenance?.receivedAt,series?.availableAt,sourceExport?.exportedAt,sourceExport?.availableAt]);
   if(availableAt!==null&&instantNs(availableAt)>instantNs(decisionAt))fail('component_availability_after_decision');
   const bundle={contract:UNIFIED_PRODUCER_CONTRACT,status:series?.terminal?'series_complete_actual_result':'diagnostic_generated',mode:selectedMode,matchId,seriesId:series?.seriesId??null,decisionAt,featureInputCutoffAt:reconstruction?.sourceDecisionAt??decisionAt,availableAt,historyCutoffAt:context?.historyCutoffAt??historical?.historyCutoffAt??seriesHistorical?.historyCutoffAt??null,historyContextHash:context?.contentHash??null,sourceSnapshotHash:sourceExport?.sourceSnapshotHash??null,
    targetBinding,sourceAdmission,inputSourceBindings,reconstruction,historicalBindings:{kind:seriesHistorical?'series_history':prematchInput?'map_prematch':context?'draft_frozen_context':null,factsSha256:seriesHistorical?.factsSha256??historical?.factsSha256??null,targetSha256:seriesHistoryInput?.targetInput?.pin?.sha256??prematchInput?.targetInput?.pin?.sha256??null,transitionId:seriesHistorical?.transitionId??null,identityRevision:seriesHistorical?.identityRevision??context?.draftState.revision??null,historyCutoffAt:context?.historyCutoffAt??historical?.historyCutoffAt??seriesHistorical?.historyCutoffAt??null,validFrom:seriesHistorical?.validFrom??context?.validFrom??historical?.validFrom??null},draftObservation:context?{firstCompleteObservationId:context.draftState.firstCompleteObservationId,firstClock:context.draftState.firstClock,firstObservationCohort:context.draftState.firstObservationCohort,firstObservedBasis:context.draftState.firstObservedBasis,identityRevision:context.draftState.revision,validFrom:context.validFrom}:null,
    routes,components:{historical,draftIdentity:draft,seriesHistorical,liveInteractions:selectedMode==='LIVE'?live?.vector??null:null,legacyNative:selectedMode==='LIVE'?live?.nativeBundle??null:null,series},nextLiveState:selectedMode==='LIVE'?live.state:null,liveRejection:sourceAdmission?.classification==='unclassified_static_draft_only'?sourceAdmission.reason:null,
    semanticStatus:{sourceInventoryHash,nativeLegacySemantics:'preserved_separate_not_blindly_concatenated',canonicalFamilyMatrixRequiresReview:true,zeroMinuteCohortClaimed:false,fullFeatureGateComplete:false},semanticEvidence:{patch,rulesSha256:live?.semanticEvidence?.rulesSha256??null,eventsSha256:live?.semanticEvidence?.eventsSha256??null,trust:'host_pinned_inputs_not_provider_authentication'},eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
   let active=true;activeBundles++;return withFeatureRelease(bundle,()=>{if(!active)return false;active=false;activeBundles--;for(const r of routes)r.release();for(const lease of bundleLeases)lease.release();bundleLeases.length=0;return true;});
   }catch(error){for(const r of routes)r.release();for(const lease of bundleLeases)lease.release();throw error;}finally{for(const block of blocks)block.release();}
  }
 });
}

/** Bounded journal payload. Schemas/definitions are registered once through
 * getSchema(ref); equal ordered values/masks are pooled across output heads. */
export function encodeDiagnosticFeatureTrace(bundle,{maxBytes=16*1024*1024}={}){
 if(bundle?.contract!==UNIFIED_PRODUCER_CONTRACT||bundle.eligibleForTraining!==false||bundle.eligibleForServing!==false||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>64*1024*1024)fail('trace_contract_or_bound');
 const vectors={},seenVectors=new WeakMap(),routes=bundle.routes.map(r=>{const v=r.diagnosticVector;let ref=seenVectors.get(v);if(!ref){const payload={namesHash:r.schemaRef.namesSha256??digest(v.names),values:v.values,missing:v.missing},hash=digest(payload);vectors[hash]=payload;ref=hash;seenVectors.set(v,ref);}return{targetId:r.targetId,stateMode:r.stateMode,schemaRef:r.schemaRef,vectorRef:ref,featureCount:v.names.length,fullFeatureGateComplete:false};});
 const body={contract:'aegis.diagnostic-feature-trace.v1',producerContract:bundle.contract,matchId:bundle.matchId,seriesId:bundle.seriesId,decisionAt:bundle.decisionAt,featureInputCutoffAt:bundle.featureInputCutoffAt??bundle.decisionAt,availableAt:bundle.availableAt,mode:bundle.mode,timings:bundle.timings??null,historyCutoffAt:bundle.historyCutoffAt,historyContextHash:bundle.historyContextHash,sourceSnapshotHash:bundle.sourceSnapshotHash,semanticEvidence:bundle.semanticEvidence,targetBinding:bundle.targetBinding,sourceAdmission:bundle.sourceAdmission,inputSourceBindings:bundle.inputSourceBindings,draftObservation:bundle.draftObservation,liveRejection:bundle.liveRejection,
  nativeObservationId:bundle.components.legacyNative?.observationId??null,nativeRawSha256:bundle.components.legacyNative?.rawSha256??null,nativeKnownAt:bundle.components.legacyNative?.knownAt??null,nativeGameClock:bundle.components.legacyNative?.eventClockSeconds??null,seriesReceiptPin:bundle.components.series?.sourcePin??null,routes,vectors,
  reconstruction:bundle.reconstruction??null,historicalBindings:bundle.historicalBindings??null,historicalInputRef:bundle.historicalInputRef??null,eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
 const utf8=JSON.stringify(body),bytes=Buffer.byteLength(utf8);if(bytes>maxBytes)fail('trace_byte_bound');
 return{contract:body.contract,utf8,bytes,sha256:createHash('sha256').update(utf8).digest('hex'),vectorPoolSize:Object.keys(vectors).length};
}
