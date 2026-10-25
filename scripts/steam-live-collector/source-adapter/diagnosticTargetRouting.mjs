/** Owned verified feature-trace routing. Descriptors are diagnostic evidence,
 * never model predictions, probabilities or permission to activate public UI. */
import {TARGET_IDS,digest} from '../../feature-registry/registry-contract.mjs';
import {produceSeriesContext} from './seriesContextFeatures.mjs';
import {instantNs} from './causalTime.mjs';
import {readCurrentLiveEligibilitySnapshot} from './currentLiveEligibilitySnapshot.mjs';
import {LEGACY_FEATURE_CAPACITY_PROFILE,featureCapacityProfileForSchema} from './featureCapacityProfiles.mjs';
export const DIAGNOSTIC_ROUTING_CONTRACT='aegis.diagnostic-target-routing.v1';
const flags={diagnosticOnly:true,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false,publicPromotion:false};
const ID=/^[1-9]\d{0,19}$/,SHA=/^[a-f0-9]{64}$/;
const PHASES={PRE:['PRE','SERIES_PRE'],POST:['POST','SERIES_LIVE'],LIVE:['LIVE','SERIES_LIVE'],BETWEEN:['SERIES_BETWEEN'],SERIES_PRE:['SERIES_PRE'],COMPLETE:[]};
const MAIN_PHASE={PRE:'SERIES_PRE',POST:'SERIES_LIVE',LIVE:'SERIES_LIVE',BETWEEN:'SERIES_BETWEEN',SERIES_PRE:'SERIES_PRE'};
const SEMANTICS={
 map_radiant_win:{entity:'map',metric:'winner',orientation:'map_radiant',quantity:'whole_map',units:'event'},
 series_team1_win:{entity:'series',metric:'winner',orientation:'series_team1',quantity:'whole_series',units:'event'},
 map_total_kills_distribution:{entity:'map',metric:'kills',orientation:null,quantity:'final',units:'kills',discrete:true},
 map_total_duration_seconds_distribution:{entity:'map',metric:'duration',orientation:null,quantity:'final',units:'seconds',discrete:true},
 remaining_kills_distribution:{entity:'map',metric:'kills',orientation:null,quantity:'remaining',units:'kills',discrete:true},
 remaining_duration_seconds_distribution:{entity:'map',metric:'duration',orientation:null,quantity:'remaining',units:'seconds',discrete:true}
};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>obj(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const fail=reason=>{throw Error('diagnostic_target_routing:'+reason);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const unavailable=reason=>({status:'unavailable',reason,displayText:'Прогноз недоступен',prediction:null,...flags});
function parseSeries(input){if(typeof input?.utf8!=='string')fail('series_receipt_required');try{return JSON.parse(input.utf8);}catch{fail('series_receipt_json');}}
function notFuture(value,cutoff){const at=instantNs(value);return at!==null&&at<=cutoff;}

/** targetDocument and schema allowlist are trusted deployment configuration.
 * The former comes from the validated canonical registry, not trace filenames.
 * journal is an owned verifying read port such as createDiagnosticFeatureJournal.
 * Original-model forecast replay stays unavailable until its separate receipt/
 * model-output contract is reviewed; feature traces cannot satisfy that proof. */
export function createDiagnosticTargetRouter({journal,targetDocument,expectedSchemaHashes,readLiveEligibility=null,now=()=>new Date().toISOString()}={}){
 const compact=journal?.contract==='aegis.compact-diagnostic-feature-journal.v2';
 if(typeof now!=='function')fail('owned_current_read_clock');
 if(readLiveEligibility!==null&&typeof readLiveEligibility!=='function')fail('owned_live_eligibility_port');
 if(typeof journal?.loadTrace!=='function'||!compact&&typeof journal?.loadSchema!=='function'||targetDocument?.contract!=='aegis.twelve-logical-targets.v1'||!Array.isArray(targetDocument.targets)||targetDocument.targets.length!==TARGET_IDS.length||new Set(targetDocument.targets.map(t=>t.id)).size!==TARGET_IDS.length||targetDocument.targets.some(t=>!TARGET_IDS.includes(t.id)||!Object.hasOwn(SEMANTICS,t.target)||!Array.isArray(t.stateModes)||!t.stateModes.length||!Object.values(PHASES).some(phases=>phases.includes(t.phase))))fail('owned_registry_or_journal');
 if(!exact(expectedSchemaHashes,TARGET_IDS)||Object.values(expectedSchemaHashes).some(xs=>!Array.isArray(xs)||!xs.length||xs.length>8||xs.some(x=>!SHA.test(x))||new Set(xs).size!==xs.length))fail('exact_schema_allowlist');
 const document=freeze(structuredClone(targetDocument)),metadata=new Map(document.targets.map(t=>[t.id,t])),allowed=freeze(structuredClone(expectedSchemaHashes)),targetDocumentSha256=digest(document),ownedReads=new WeakMap();
 function eligibleView(snapshot,key){const state=snapshot.state;return{status:'eligible_retention_candidate',reason:state.reason,eligibleForRetainingForecast:true,evaluatedAt:snapshot.evaluatedAt,lastTraceSha256:key,observationId:state.stateView.observationId,lastConfirmedAt:state.stateView.lastConfirmedAt,expiresAt:state.stateView.expiresAt,continuityGeneration:state.stateView.continuityGeneration,ageSeconds:state.ageSeconds,recordedPrediction:false,eligibleForServing:false};}
 /** The HTTP host calls this after awaiting read(). It closes that final promise
  * boundary with a synchronous source/STOP fence; only our held output is valid. */
 function finalizeRead(route){
  const meta=ownedReads.get(route);if(!meta)fail('owned_route_read_required');
  const hasCurrent=panel=>panel?.currentLiveEligibility?.eligibleForRetainingForecast===true;
  if(!hasCurrent(route.main)&&!hasCurrent(route.detail))return route;
  const minimumDecisionAt=[meta.decisionAt,route.main?.currentLiveEligibility?.evaluatedAt,route.detail?.currentLiveEligibility?.evaluatedAt].filter(x=>instantNs(x)!==null).reduce((a,b)=>instantNs(a)>=instantNs(b)?a:b);
  const snapshot=readCurrentLiveEligibilitySnapshot({readLiveEligibility,now,matchId:route.currentMapId,minimumDecisionAt}),state=snapshot.state,next=structuredClone(route);
  function refresh(panel,label){
   if(!hasCurrent(panel))return panel;
   const prior=panel.currentLiveEligibility,reason=state.eligibleForRetainingForecast!==true?'current_live_state_ineligible':state.lastTraceSha256!==prior.lastTraceSha256||state.stateView?.observationId!==prior.observationId?'current_live_trace_binding':null;
   if(reason){next.panelRejections[label]=reason;return label==='series'?{...unavailable(reason),entity:'series',seriesId:next.seriesId,eventRelation:panel.eventRelation}:unavailable(reason);}
   const currentLiveEligibility=eligibleView(snapshot,prior.lastTraceSha256);return{...panel,currentLiveEligibility,...(Array.isArray(panel.targets)?{targets:panel.targets.map(target=>({...target,currentLiveEligibility}))}:{})};
  }
  next.main=refresh(next.main,'series');next.detail=refresh(next.detail,'map');next.sourceRejection=next.panelRejections.series??next.panelRejections.map;
  const value=freeze(next);ownedReads.set(value,meta);return value;
 }
 function descriptor(trace,traceSha256,route){
  const meta=metadata.get(route.targetId),semantic=SEMANTICS[meta.target];
  return{status:'diagnostic_features_available',targetId:route.targetId,targetContract:meta.target,phase:meta.phase,stateMode:route.stateMode,...semantic,traceSha256,schemaRef:structuredClone(route.schemaRef),featureCount:route.featureCount,sourceEvidence:{sourceSnapshotHash:trace.sourceSnapshotHash??null,historicalInputRef:trace.historicalInputRef??null,featureInputCutoffAt:trace.featureInputCutoffAt??trace.reconstruction?.sourceDecisionAt??trace.decisionAt,calculatedAt:trace.decisionAt,rawSourceReplayPerformedByRouter:false,providerAuthenticationClaimed:false},prediction:null,modelOutputRequired:true,...(semantic.metric==='kills'||semantic.metric==='duration'?{totals:{metric:semantic.metric,unit:semantic.units,discrete:true,featureTargetQuantity:semantic.quantity,distribution:null,outputMetadataRequired:true,remainingToFinalConversionPerformed:false,consumer:'existing_TotalsDistribution_and_BookmakerTotalsLadder'}}:{}),...flags};
 }
 async function read({traceSha256=null,seriesTraceSha256=null,mapTraceSha256=null,seriesInput,phase,currentMap=null,selection={kind:'entry'},decisionAt}={}){
  if(traceSha256!==null&&(seriesTraceSha256!==null||mapTraceSha256!==null))fail('ambiguous_trace_references');
  for(const key of [traceSha256,seriesTraceSha256,mapTraceSha256])if(key!==null&&!SHA.test(key))fail('trace_hash');
  const legacy=traceSha256!==null;
  if(legacy){seriesTraceSha256=traceSha256;mapTraceSha256=traceSha256;}
  const decision=instantNs(decisionAt);if(decision===null||!Object.hasOwn(PHASES,phase)||currentMap!==null&&(!exact(currentMap,['mapId','mapNumber'])||!ID.test(currentMap.mapId)||!Number.isInteger(currentMap.mapNumber))||!obj(selection)||selection.kind==='entry'&&!exact(selection,['kind'])||selection.kind==='manual'&&(!exact(selection,['kind','mapId'])||!ID.test(selection.mapId))||!['entry','manual'].includes(selection.kind))fail('selection_contract');
  if(['PRE','POST','LIVE'].includes(phase)!==(currentMap!==null))fail('phase_map_identity');
  const series=produceSeriesContext({seriesInput,decisionAt,currentMapId:currentMap?.mapId??null,currentMapNumber:currentMap?.mapNumber??null}),seriesRaw=parseSeries(seriesInput),selectedMapId=selection.kind==='manual'?selection.mapId:currentMap?.mapId??(series.terminal?seriesRaw.previousMaps.at(-1)?.mapId??null:null);
  if(phase==='COMPLETE'&&!series.terminal)fail('series_not_complete');
  if(phase==='SERIES_PRE'&&series.sourceMapIds.length!==0||phase==='BETWEEN'&&(series.sourceMapIds.length===0||series.terminal))fail('phase_series_progress');
  const selectedPrevious=seriesRaw.previousMaps.find(m=>m.mapId===selectedMapId)??null;
  if(selectedMapId!==null&&selectedMapId!==currentMap?.mapId&&!selectedPrevious)fail('selected_map_not_in_series');
  let main=series.terminal?{status:'actual_result',entity:'series',seriesId:series.seriesId,team1Id:series.team1Id,team2Id:series.team2Id,score:series.score,winnerTeamId:series.actualWinnerTeamId,prediction:null,...flags}:unavailable('verified_current_series_trace_required');
  let detail=selectedPrevious?{status:'actual_result',entity:'map',seriesId:series.seriesId,mapId:selectedPrevious.mapId,mapNumber:selectedPrevious.mapNumber,winnerTeamId:selectedPrevious.winnerTeamId,team1Kills:selectedPrevious.team1Kills,team2Kills:selectedPrevious.team2Kills,durationSeconds:selectedPrevious.durationSeconds,heroes:{orientation:'series_team1_team2',team1:selectedPrevious.team1Heroes,team2:selectedPrevious.team2Heroes},historicalForecast:null,historicalForecastReason:'verified_original_model_forecast_receipt_unavailable',prediction:null,...flags}:unavailable(selectedMapId===null?'no_current_or_selected_map':'verified_selected_map_trace_required');
  let sourceRejection=null;
  const panelRejections={series:null,map:null},traceCache=new Map(),heldTraces=[];
   const result=()=>{const value=freeze({contract:DIAGNOSTIC_ROUTING_CONTRACT,seriesId:series.seriesId,bestOf:series.bestOf,phase,selection:structuredClone(selection),selectedMapId,currentMapId:currentMap?.mapId??null,traceRefs:{seriesTraceSha256,mapTraceSha256},main:{...main,entity:'series',seriesId:series.seriesId,eventRelation:series.bestOf===1?'same_event_as_only_map':'whole_series'},detail,sourceRejection,panelRejections,originalForecastReplayEnabled:false,targetDocumentSha256,...flags});ownedReads.set(value,{decisionAt});return value;};
  if(series.terminal)return result();
  const rejection=error=>typeof error?.message==='string'&&error.message.startsWith('diagnostic_target_routing:')?error.message.slice('diagnostic_target_routing:'.length):'journal_evidence_unavailable';
  const load=async key=>{if(!traceCache.has(key))traceCache.set(key,Promise.resolve(journal.loadTrace(key)).then(value=>{if(compact&&value?.contract==='aegis.compact-diagnostic-feature-journal.v2'&&value.body){heldTraces.push(value);return{trace:value.body,held:value};}return{trace:value,held:null};}));return traceCache.get(key);};
  async function verify(key,expectedModes){
   const {trace,held}=await load(key),traceMap=['PRE','POST','LIVE'].includes(trace?.mode)?currentMap:null;
   if(trace?.contract!==(held?'aegis.compact-diagnostic-feature-trace.v2':'aegis.diagnostic-feature-trace.v1')||trace.eligibleForServing!==false||trace.eligibleForTraining!==false||trace.recordedPrediction!==false||!expectedModes.includes(trace.mode)||trace.seriesId!==series.seriesId||trace.matchId!==(traceMap?.mapId??null)||!notFuture(trace.decisionAt,decision)||!notFuture(trace.availableAt,decision)||trace.timings?.featuresReadyAt!==undefined&&!notFuture(trace.timings.featuresReadyAt,decision)||!Array.isArray(trace.routes)||trace.routes.length>12)fail('trace_identity_phase_or_time');
   // A series ID does not pin its format, score, previous drafts or corrections.
   // A trace can only describe the exact receipt used to generate its vector.
   if(trace.seriesReceiptPin?.sha256!==seriesInput.pin.sha256||trace.seriesReceiptPin?.bytes!==seriesInput.pin.bytes)fail('trace_series_receipt_binding');
   const horizon=trace.reconstruction?.sourceDecisionAt??trace.decisionAt;
   if(!notFuture(horizon,instantNs(trace.decisionAt))||trace.featureInputCutoffAt!==undefined&&instantNs(trace.featureInputCutoffAt)!==instantNs(horizon)||!notFuture(series.availableAt,instantNs(horizon)))fail('trace_series_source_horizon');
   const binding=trace.targetBinding;
   if(['series_history','map_prematch'].includes(trace.historicalBindings?.kind)){const ref=trace.historicalInputRef;if(!(held?['aegis.static-historical-input-reference.v1','aegis.static-historical-input-reference.v2']:['aegis.static-historical-input-reference.v1']).includes(ref?.contract)||!SHA.test(ref.sha256??'')||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>16384)fail('static_historical_input_reference_required');}
   if(trace.historicalBindings?.kind==='series_history'&&trace.historicalBindings.transitionId!==series.seriesId+':after:'+series.sourceMapIds.length)fail('trace_series_transition_binding');
   if(binding?.mapId!==trace.matchId||binding?.series?.seriesId!==series.seriesId||binding.series.team1Id!==series.team1Id||binding.series.team2Id!==series.team2Id||binding.series.outcome!=='series_team1_win')fail('trace_series_orientation');
   if(traceMap){const s=binding.mapSides;if(!obj(s)||s.radiant===s.dire||![s.radiant,s.dire].every(t=>[series.team1Id,series.team2Id].includes(t))||binding.mapOutcome!=='map_radiant_win'||binding.series.team1CurrentSide!==(s.radiant===series.team1Id?'radiant':'dire'))fail('trace_current_map_orientation');}
   else if(binding.mapSides!==null||binding.mapOutcome!==null||binding.series.team1CurrentSide!==null)fail('unexpected_map_side_binding');
   const seen=new Set();
   for(const route of trace.routes){
    const meta=metadata.get(route.targetId);if(!meta||seen.has(route.targetId)||!PHASES[trace.mode].includes(meta.phase)||meta.phase==='SERIES_PRE'&&series.sourceMapIds.length!==0||!meta.stateModes.includes(route.stateMode)||meta.phase==='SERIES_LIVE'&&route.stateMode!==(trace.mode==='LIVE'?'observed_live':'observed_postdraft')||!allowed[route.targetId].includes(route.schemaRef?.sha256))fail('route_phase_or_schema');seen.add(route.targetId);
    if(held){const page=held.readSchemaPage({targetId:route.targetId,offset:0,limit:1});if(!page)fail('exact_schema_target_binding');try{const schema=page.header,capacity=featureCapacityProfileForSchema(schema);if(capacity.id!==(route.schemaRef.capacityProfile??LEGACY_FEATURE_CAPACITY_PROFILE.id)||schema.targetId!==route.targetId||schema.stateMode!==route.stateMode||page.expandedSchemaHash!==route.schemaRef.sha256||page.total!==route.featureCount||route.featureCount>capacity.maxFeatures||route.schemaRef.featureCount!==route.featureCount)fail('exact_schema_target_binding');}finally{page.release();}}
    else{const schema=await journal.loadSchema(route.schemaRef.sha256);if(schema.contract!=='aegis.unified-feature-projection-schema.v1'||schema.targetId!==route.targetId||schema.stateMode!==route.stateMode||!Array.isArray(schema.definitions)||schema.definitions.length!==route.featureCount||route.schemaRef.featureCount!==route.featureCount)fail('exact_schema_target_binding');}
   }
    const currentLiveEligibility=trace.mode==='LIVE'?{status:'unavailable',reason:'owned_live_eligibility_port_not_configured',eligibleForRetainingForecast:false}:{status:'not_applicable',eligibleForRetainingForecast:false};
   return{trace,key,currentLiveEligibility};
  }
  try{
  const mainModes=legacy?[phase]:phase==='PRE'?(series.sourceMapIds.length?['BETWEEN']:['SERIES_PRE','PRE']):[phase];
  let seriesEvidence=null,mapEvidence=null;
  if(seriesTraceSha256!==null){try{seriesEvidence=await verify(seriesTraceSha256,mainModes);}catch(error){panelRejections.series=rejection(error);}}
  if(mapTraceSha256!==null&&currentMap!==null&&selectedMapId===currentMap.mapId){try{mapEvidence=await verify(mapTraceSha256,[phase]);}catch(error){panelRejections.map=rejection(error);}}
  if(seriesEvidence&&mapEvidence&&seriesEvidence.trace.matchId!==null&&['radiant','dire'].some(side=>seriesEvidence.trace.targetBinding.mapSides[side]!==mapEvidence.trace.targetBinding.mapSides[side])){seriesEvidence=null;mapEvidence=null;panelRejections.series=panelRejections.map='trace_pair_map_orientation';}
   // All asynchronous evidence IO is complete. Read ONE current source snapshot
   // for both panels. The synchronous port observes STOP and source epoch now;
   // no await follows this fence before the response is constructed.
   if(readLiveEligibility!==null&&(seriesEvidence?.trace.mode==='LIVE'||mapEvidence?.trace.mode==='LIVE')){
    const snapshot=readCurrentLiveEligibilitySnapshot({readLiveEligibility,now,matchId:currentMap.mapId,minimumDecisionAt:decisionAt}),state=snapshot.state;
    function qualify(evidence,panel){
     if(evidence?.trace.mode!=='LIVE')return evidence;
     if(state.eligibleForRetainingForecast!==true){panelRejections[panel]='current_live_state_ineligible';return null;}
     if(state.lastTraceSha256!==evidence.key||!SHA.test(evidence.trace.nativeObservationId??'')||state.stateView?.observationId!==evidence.trace.nativeObservationId){panelRejections[panel]='current_live_trace_binding';return null;}
     evidence.currentLiveEligibility=eligibleView(snapshot,evidence.key);return evidence;
    }
    seriesEvidence=qualify(seriesEvidence,'series');mapEvidence=qualify(mapEvidence,'map');
   }
  // The legacy one-trace call historically rejected both panels atomically.
  if(legacy&&(panelRejections.series||panelRejections.map)){sourceRejection=panelRejections.series??panelRejections.map;return result();}
  sourceRejection=panelRejections.series??panelRejections.map;
  if(seriesEvidence){const {trace,key,currentLiveEligibility}=seriesEvidence,mainPhase=trace.mode==='BETWEEN'?'SERIES_BETWEEN':MAIN_PHASE[trace.mode],route=trace.routes.find(r=>metadata.get(r.targetId).phase===mainPhase&&SEMANTICS[metadata.get(r.targetId).target].entity==='series');if(route)main={...descriptor(trace,key,route),team1Id:series.team1Id,team2Id:series.team2Id,team1CurrentSide:trace.targetBinding.series.team1CurrentSide,currentLiveEligibility};}
  if(mapEvidence){
   const {trace,key,currentLiveEligibility}=mapEvidence,routes=trace.routes.filter(r=>SEMANTICS[metadata.get(r.targetId).target].entity==='map');
   if(routes.length)detail={status:'diagnostic_features_available',entity:'map',seriesId:series.seriesId,mapId:selectedMapId,mapNumber:currentMap.mapNumber,mapSides:structuredClone(trace.targetBinding.mapSides),targets:routes.map(r=>({...descriptor(trace,key,r),currentLiveEligibility})),currentLiveEligibility,prediction:null,...flags};
  }
  return result();
  }finally{for(const held of heldTraces)held.release();}
 }
  return Object.freeze({read,finalizeRead,targetDocumentSha256,originalForecastReplayEnabled:false,...flags});
}
