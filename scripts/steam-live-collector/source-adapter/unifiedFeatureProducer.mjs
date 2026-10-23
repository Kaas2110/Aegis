/** One diagnostic generation entry: same arithmetic for retained replay/runtime.
 * No provider/DB calls, fits, weights, predictions or client supplied vectors.
 * Source inventory is host-owned deployment metadata, never serving admission. */
import {createHash} from 'node:crypto';
import {digest,FAMILY_IDS,validateRegistry,validateProjection} from '../../feature-registry/registry-contract.mjs';
import {producePrematchHistoricalRelationalFeatures} from './historicalRelationalFeatures.mjs';
import {readDynamicHistoryProof,advanceObservedDraftFeatureBundle} from './observedDraftFeatureBundle.mjs';
import {produceSeriesContext} from './seriesContextFeatures.mjs';
import {verifyHistorySourceExport} from './historySourceExport.mjs';
import {instantNs} from './causalTime.mjs';
export const UNIFIED_PRODUCER_CONTRACT='aegis.unified-diagnostic-feature-producer.v1';
const SH=/^[a-f0-9]{64}$/,scopes=new Set(['prior_maps','current_identity','current_draft','current_live','series_context','previous_series_maps','candidate_axis']);
const fail=x=>{throw Error('unified_features:'+x);};
const latest=xs=>xs.filter(x=>instantNs(x)!==null).reduce((a,b)=>a===null||instantNs(b)>instantNs(a)?b:a,null);
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const targets={PRE:['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','SERIES_PRE'],POST:['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE'],LIVE:['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE'],BETWEEN:['SERIES_BETWEEN']};
const sourceProfile={history:'local_prior_completed_map_facts',live:'steam.GetLiveLeagueGames.v1.scoreboard',series:'retained_series_map_receipts'};
export function createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory}={}){
 const docs=structuredClone({index,familyDocument,targetDocument}),registry=validateRegistry(docs.index,docs.familyDocument,docs.targetDocument);
 if(!sourceInventory||Object.keys(sourceInventory).sort().join(',')!=='history,live,series'||Object.values(sourceInventory).some(p=>!SH.test(p?.primarySha256??'')||!Array.isArray(p.files)||!p.files.length||p.files.length>64||p.files.some(f=>typeof f.path!=='string'||!SH.test(f.sha256??''))||!p.files.some(f=>f.sha256===p.primarySha256)||new Set(p.files.map(f=>f.path)).size!==p.files.length))fail('source_inventory');
 const inventory=freeze(structuredClone(sourceInventory)),registryHash=digest(docs),schemaCache=new Map();
 function normalize(component,id){
  const names=component.names??component.vector?.names,values=component.values??component.vector?.values,masks=component.masks??component.vector?.masks,definitions=component.definitions??component.vector?.definitions;
  if(!Array.isArray(names)||names.length>150000||new Set(names).size!==names.length||values?.length!==names.length||masks?.length!==names.length||definitions?.length!==names.length)fail('component_shape:'+id);
  const normalized=definitions.map((d,i)=>{
   if(d.name!==names[i]||values[i]!==null&&(typeof values[i]!=='number'||!Number.isFinite(values[i]))||Boolean(masks[i])!==(values[i]===null))fail('component_column:'+id);
   const f=registry.families.get(d.familyId);if(!f)fail('component_family:'+d.familyId);
   const inputScopes=[...new Set(d.inputScopes.map(s=>s==='prior_completed_maps'?'prior_maps':s))];
   if(inputScopes.some(s=>!scopes.has(s)))fail('component_input_scope:'+id);
   const allowedTargets=d.allowedTargets?d.allowedTargets.filter(t=>f.eligibleTargets.includes(t)):[...f.eligibleTargets];
   const out={contract:'aegis.executable-feature-definition.v1',id:id+':'+d.name,name:d.name,version:d.version??'1',familyId:d.familyId,formula:d.formula,formulaVersion:d.formulaVersion,units:d.units,dtype:d.dtype??d.type??'float64',missingPolicy:d.missingPolicy??'null_with_boolean_mask',timePolicy:d.timePolicy??'exact input receipt and immutable historical cutoff; never current-map labels',sourceProfile:sourceProfile[id],learnedStatePolicy:'none',semanticStatus:'specified',inputScopes,allowedTargets,producer:{sourceSha256:inventory[id].primarySha256,symbol:id==='history'?'produceHistoricalRelationalFeatures':id==='live'?'advanceObservedDraftFeatureBundle':'produceSeriesContext'}};
   if(d.coordinate)out.coordinate=d.coordinate;
   for(const key of ['minimumSupport','historyWindowDays','orientation'])if(d[key]!==undefined)out[key]=d[key];
   return out;
  });
  const componentSchemaHash=component.schemaHash??component.vector?.semanticSchemaHash??null;
  if(componentSchemaHash!==null&&!SH.test(componentSchemaHash))fail('component_schema_hash:'+id);
  return {id,names,values,missing:masks.map(Boolean),definitions:normalized,sourceInventory:inventory[id],componentSchemaHash,contentHash:component.contentHash??digest({names,values,masks})};
 }
 function project(blocks,targetId,mode,semanticInputs){
  const stateMode=targetId==='SERIES_LIVE'?(mode==='LIVE'?'observed_live':'observed_postdraft'):targetId.startsWith('SERIES_')?targetId:mode;
  const live=mode==='LIVE',draft=live||mode==='POST',names=[],values=[],missing=[],definitions=[],excluded=[];
  for(const b of blocks)for(let i=0;i<b.names.length;i++){
   const d=b.definitions[i];let reason=null;
   if(!d.allowedTargets.includes(targetId))reason='family_or_definition_target_not_in_current_registry';
   else if(d.inputScopes.includes('current_live')&&!live)reason='current_live_unavailable_in_phase';
   else if(d.inputScopes.includes('current_draft')&&!draft)reason='current_draft_unavailable_in_phase';
   else if(d.inputScopes.includes('previous_series_maps')&&!['SERIES_BETWEEN','SERIES_LIVE'].includes(targetId))reason='previous_series_map_namespace';
   if(reason){excluded.push({component:b.id,name:d.name,familyId:d.familyId,reason});continue;}
   names.push(d.name);values.push(b.values[i]);missing.push(b.missing[i]);definitions.push(d);
  }
  if(new Set(names).size!==names.length)fail('qualified_name_collision');
  if(definitions.length)validateProjection({targetId,stateMode,definitions},registry);
  const schema={contract:'aegis.unified-feature-projection-schema.v1',registryHash,targetId,stateMode,definitions,sourceInventory:inventory,componentSchemas:blocks.map(b=>({id:b.id,sha256:b.componentSchemaHash})),semanticInputs};
  const schemaHash=digest(schema);if(!schemaCache.has(schemaHash))schemaCache.set(schemaHash,freeze(schema));
  if(schemaCache.size>32)fail('schema_cache_bound');
  const familyStatuses=FAMILY_IDS.map(familyId=>{const f=registry.families.get(familyId),n=definitions.filter(d=>d.familyId===familyId).length;return{familyId,eligibleInCanonicalTarget:f.eligibleTargets.includes(targetId),generatedColumnCount:n,status:n?'implemented_subset_requires_full_family_review':f.eligibleTargets.includes(targetId)?'not_generated_or_unavailable_in_phase':'not_eligible_in_canonical_target'};});
  return {targetId,stateMode,schemaRef:{sha256:schemaHash,featureCount:names.length},diagnosticVector:{names,values,missing},inferenceVector:null,familyStatuses,excludedDefinitions:excluded,completenessScope:'explicit_generated_diagnostic_components_not_all79_families',eligibleForTraining:false,eligibleForServing:false};
 }
 return Object.freeze({contract:UNIFIED_PRODUCER_CONTRACT,getSchema(hash){if(!SH.test(hash))fail('schema_hash');return schemaCache.get(hash)??null;},
  generateFeatureBundle({mode='AUTO',matchId=null,decisionAt,historyProof=null,prematchInput=null,livePrefixInputs=null,previousLiveState=null,seriesInput=null,currentMapNumber=null,rulesEvidence=null,expectedRulesSha256=null,eventsEvidence=null,expectedEventsSha256=null,patch=null,sourceExportInput=null,expectedSourceSnapshotHash=null}={}){
   if(!['AUTO','PRE','POST','LIVE','BETWEEN'].includes(mode)||instantNs(decisionAt)===null)fail('mode_or_decision');
   let historical=null,context=null,live=null,series=null,selectedMode=mode,sourceExport=null;
   if(sourceExportInput!==null){sourceExport=verifyHistorySourceExport(sourceExportInput,{expectedSourceSnapshotHash,matchId,decisionAt});if(!sourceExport.population.factsUsable)fail('unavailable_history_source_export');}
   if(historyProof!==null){const h=readDynamicHistoryProof(historyProof,{matchId,decisionAt});if(!h.accepted)fail(h.reason);context=h.context;historical=h.relational;
   }
   if(prematchInput!==null){if(historyProof!==null)fail('mixed_prematch_and_draft_context');historical=producePrematchHistoricalRelationalFeatures({...prematchInput,decisionAt});}
   if(sourceExport){
    const e=JSON.parse(sourceExport.envelopeInput.utf8),i=sourceExport.identity;
    if(!historical||historical.factsSha256!==e.factsInput?.pin?.sha256)fail('history_export_facts_binding');
    // This export contract includes an observed draft. It must not attest a PRE
    // target, whose selectors and identity intentionally do not contain heroes.
    if(!context)fail('history_export_requires_observed_draft_context');
    const d=context.draftState,b=context.producer.bindings;
    if(i.matchId!==context.matchId||i.revision!==d.revision||i.draftHash!==d.identity.draftHash||i.rosterHash!==d.identity.rosterHash||i.sideIdentityHash!==d.identity.sideIdentityHash||instantNs(i.historyCutoffAt)!==instantNs(context.historyCutoffAt)||instantNs(i.validFrom)!==instantNs(context.validFrom)||e.nativeInput?.pin?.sha256!==b.nativeObservations.sha256||digest(e.draftPrefixInputs.map(p=>({raw:p.rawInput.pin.sha256,metadata:p.metadataInput.pin.sha256})))!==digest(b.draftPrefix.map(p=>({raw:p.raw.sha256,metadata:p.metadata.sha256}))))fail('history_export_context_binding');
   }
   if(mode==='BETWEEN'){if(historyProof!==null||prematchInput!==null||livePrefixInputs!==null||matchId!==null||currentMapNumber!==null)fail('between_maps_stale_current_map');}
   else if(mode==='PRE'||mode==='AUTO'&&historyProof===null){if(!historical||prematchInput===null||livePrefixInputs!==null)fail('prematch_inputs');if(historical.matchId!==matchId)fail('prematch_map_identity');selectedMode='PRE';}
   else {
    if(!context)fail('verified_draft_history_required');
    if(livePrefixInputs!==null&&mode!=='POST'){live=advanceObservedDraftFeatureBundle(previousLiveState,{livePrefixInputs,matchId,decisionAt,historyProof,patch,rulesEvidence,expectedRulesSha256,eventsEvidence,expectedEventsSha256});}
    if(mode==='LIVE'&&live?.status!=='diagnostic_produced')fail(live?.reason??'live_prefix_required');
    selectedMode=mode==='POST'?'POST':live?.status==='diagnostic_produced'?'LIVE':'POST';
   }
   let seriesDraft=null;
   if(seriesInput!==null){
    const s=JSON.parse(seriesInput.utf8);
    if(context){const players=context.draftState.identity.players,group=team=>players.filter(p=>p.teamId===team).map(p=>Number(p.heroId));
     const a=group(s.team1Id),b=group(s.team2Id);if(a.length!==5||b.length!==5)fail('series_team_draft_orientation');
     seriesDraft={seriesId:s.seriesId,mapId:matchId,availableAt:context.validFrom,team1Heroes:a,team2Heroes:b};
    }
    series=produceSeriesContext({seriesInput,decisionAt,currentMapId:selectedMode==='BETWEEN'?null:matchId,currentMapNumber:selectedMode==='BETWEEN'?null:currentMapNumber,currentDraft:seriesDraft});
   }
   const blocks=[...(historical?[normalize(historical,'history')]:[]),...(selectedMode==='LIVE'?[normalize(live,'live')]:[]),...(series&&!series.terminal?[normalize(series,'series')]:[])];
   const semanticInputs=selectedMode==='LIVE'?{patch,rulesSha256:live.semanticEvidence.rulesSha256,nativeBundleContract:live.nativeBundle.contract,sourceProfile:live.sourceCoherence.sourceProfile}:null;
   const routes=series?.terminal?[]:targets[selectedMode].filter(t=>!t.startsWith('SERIES_')||series!==null).map(t=>project(blocks,t,selectedMode,semanticInputs));
   const availableAt=latest([context?.computedAt,historical?.validFrom,live?.knownAt,series?.availableAt,sourceExport?JSON.parse(sourceExport.envelopeInput.utf8).exportedAt:null]);
   if(availableAt!==null&&instantNs(availableAt)>instantNs(decisionAt))fail('component_availability_after_decision');
   return {contract:UNIFIED_PRODUCER_CONTRACT,status:series?.terminal?'series_complete_actual_result':'diagnostic_generated',mode:selectedMode,matchId,seriesId:series?.seriesId??null,decisionAt,availableAt,historyCutoffAt:context?.historyCutoffAt??historical?.historyCutoffAt??null,historyContextHash:context?.contentHash??null,sourceSnapshotHash:sourceExport?.sourceSnapshotHash??null,
    routes,components:{historical,liveInteractions:selectedMode==='LIVE'?live?.vector??null:null,legacyNative:selectedMode==='LIVE'?live?.nativeBundle??null:null,series},nextLiveState:selectedMode==='LIVE'?live.state:null,liveRejection:live?.status==='blocked'?live.reason:null,
    semanticStatus:{sourceInventoryHash:digest(inventory),nativeLegacySemantics:'preserved_separate_not_blindly_concatenated',canonicalFamilyMatrixRequiresReview:true,zeroMinuteCohortClaimed:false,fullFeatureGateComplete:false},semanticEvidence:{patch,rulesSha256:live?.semanticEvidence?.rulesSha256??null,eventsSha256:live?.semanticEvidence?.eventsSha256??null,trust:'host_pinned_inputs_not_provider_authentication'},eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
  }
 });
}

/** Bounded journal payload. Schemas/definitions are registered once through
 * getSchema(ref); equal ordered values/masks are pooled across output heads. */
export function encodeDiagnosticFeatureTrace(bundle,{maxBytes=16*1024*1024}={}){
 if(bundle?.contract!==UNIFIED_PRODUCER_CONTRACT||bundle.eligibleForTraining!==false||bundle.eligibleForServing!==false||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>64*1024*1024)fail('trace_contract_or_bound');
 const vectors={},routes=bundle.routes.map(r=>{const v=r.diagnosticVector,namesHash=digest(v.names),payload={namesHash,values:v.values,missing:v.missing},hash=digest(payload);vectors[hash]=payload;return{targetId:r.targetId,stateMode:r.stateMode,schemaRef:r.schemaRef,vectorRef:hash,featureCount:v.names.length,fullFeatureGateComplete:false};});
 const body={contract:'aegis.diagnostic-feature-trace.v1',producerContract:bundle.contract,matchId:bundle.matchId,seriesId:bundle.seriesId,decisionAt:bundle.decisionAt,availableAt:bundle.availableAt,mode:bundle.mode,historyCutoffAt:bundle.historyCutoffAt,historyContextHash:bundle.historyContextHash,sourceSnapshotHash:bundle.sourceSnapshotHash,semanticEvidence:bundle.semanticEvidence,
  nativeObservationId:bundle.components.legacyNative?.observationId??null,nativeRawSha256:bundle.components.legacyNative?.rawSha256??null,nativeKnownAt:bundle.components.legacyNative?.knownAt??null,nativeGameClock:bundle.components.legacyNative?.eventClockSeconds??null,seriesReceiptPin:bundle.components.series?.sourcePin??null,routes,vectors,
  eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
 const utf8=JSON.stringify(body),bytes=Buffer.byteLength(utf8);if(bytes>maxBytes)fail('trace_byte_bound');
 return{contract:body.contract,utf8,bytes,sha256:createHash('sha256').update(utf8).digest('hex'),vectorPoolSize:Object.keys(vectors).length};
}
