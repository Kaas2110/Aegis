/** Owned verified feature-trace routing. Descriptors are diagnostic evidence,
 * never model predictions, probabilities or permission to activate public UI. */
import {TARGET_IDS,digest} from '../../feature-registry/registry-contract.mjs';
import {produceSeriesContext} from './seriesContextFeatures.mjs';
import {instantNs} from './causalTime.mjs';
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
export function createDiagnosticTargetRouter({journal,targetDocument,expectedSchemaHashes}={}){
 if(typeof journal?.loadTrace!=='function'||typeof journal?.loadSchema!=='function'||targetDocument?.contract!=='aegis.twelve-logical-targets.v1'||!Array.isArray(targetDocument.targets)||targetDocument.targets.length!==TARGET_IDS.length||new Set(targetDocument.targets.map(t=>t.id)).size!==TARGET_IDS.length||targetDocument.targets.some(t=>!TARGET_IDS.includes(t.id)||!Object.hasOwn(SEMANTICS,t.target)||!Array.isArray(t.stateModes)||!t.stateModes.length||!Object.values(PHASES).some(phases=>phases.includes(t.phase))))fail('owned_registry_or_journal');
 if(!exact(expectedSchemaHashes,TARGET_IDS)||Object.values(expectedSchemaHashes).some(xs=>!Array.isArray(xs)||!xs.length||xs.length>8||xs.some(x=>!SHA.test(x))||new Set(xs).size!==xs.length))fail('exact_schema_allowlist');
 const document=freeze(structuredClone(targetDocument)),metadata=new Map(document.targets.map(t=>[t.id,t])),allowed=freeze(structuredClone(expectedSchemaHashes)),targetDocumentSha256=digest(document);
 function descriptor(trace,traceSha256,route){
  const meta=metadata.get(route.targetId),semantic=SEMANTICS[meta.target];
  return{status:'diagnostic_features_available',targetId:route.targetId,targetContract:meta.target,phase:meta.phase,stateMode:route.stateMode,...semantic,traceSha256,schemaRef:structuredClone(route.schemaRef),featureCount:route.featureCount,sourceEvidence:{sourceSnapshotHash:trace.sourceSnapshotHash??null,historicalInputRef:trace.historicalInputRef??null,rawSourceReplayPerformedByRouter:false,providerAuthenticationClaimed:false},prediction:null,modelOutputRequired:true,...(semantic.metric==='kills'||semantic.metric==='duration'?{totals:{metric:semantic.metric,unit:semantic.units,discrete:true,featureTargetQuantity:semantic.quantity,distribution:null,outputMetadataRequired:true,remainingToFinalConversionPerformed:false,consumer:'existing_TotalsDistribution_and_BookmakerTotalsLadder'}}:{}),...flags};
 }
 async function read({traceSha256=null,seriesInput,phase,currentMap=null,selection={kind:'entry'},decisionAt}={}){
  const decision=instantNs(decisionAt);if(decision===null||!Object.hasOwn(PHASES,phase)||currentMap!==null&&(!exact(currentMap,['mapId','mapNumber'])||!ID.test(currentMap.mapId)||!Number.isInteger(currentMap.mapNumber))||!obj(selection)||selection.kind==='entry'&&!exact(selection,['kind'])||selection.kind==='manual'&&(!exact(selection,['kind','mapId'])||!ID.test(selection.mapId))||!['entry','manual'].includes(selection.kind))fail('selection_contract');
  if(['PRE','POST','LIVE'].includes(phase)!==(currentMap!==null))fail('phase_map_identity');
  const series=produceSeriesContext({seriesInput,decisionAt,currentMapId:currentMap?.mapId??null,currentMapNumber:currentMap?.mapNumber??null}),seriesRaw=parseSeries(seriesInput),selectedMapId=selection.kind==='manual'?selection.mapId:currentMap?.mapId??(series.terminal?seriesRaw.previousMaps.at(-1)?.mapId??null:null);
  if(phase==='COMPLETE'&&!series.terminal)fail('series_not_complete');
  const selectedPrevious=seriesRaw.previousMaps.find(m=>m.mapId===selectedMapId)??null;
  if(selectedMapId!==null&&selectedMapId!==currentMap?.mapId&&!selectedPrevious)fail('selected_map_not_in_series');
  let main=series.terminal?{status:'actual_result',entity:'series',seriesId:series.seriesId,team1Id:series.team1Id,team2Id:series.team2Id,score:series.score,winnerTeamId:series.actualWinnerTeamId,prediction:null,...flags}:unavailable('verified_current_series_trace_required');
  let detail=selectedPrevious?{status:'actual_result',entity:'map',seriesId:series.seriesId,mapId:selectedPrevious.mapId,mapNumber:selectedPrevious.mapNumber,winnerTeamId:selectedPrevious.winnerTeamId,team1Kills:selectedPrevious.team1Kills,team2Kills:selectedPrevious.team2Kills,durationSeconds:selectedPrevious.durationSeconds,heroes:{orientation:'series_team1_team2',team1:selectedPrevious.team1Heroes,team2:selectedPrevious.team2Heroes},historicalForecast:null,historicalForecastReason:'verified_original_model_forecast_receipt_unavailable',prediction:null,...flags}:unavailable(selectedMapId===null?'no_current_or_selected_map':'verified_selected_map_trace_required');
  let sourceRejection=null;
  const result=()=>freeze({contract:DIAGNOSTIC_ROUTING_CONTRACT,seriesId:series.seriesId,bestOf:series.bestOf,phase,selection:structuredClone(selection),selectedMapId,currentMapId:currentMap?.mapId??null,main:{...main,entity:'series',seriesId:series.seriesId,eventRelation:series.bestOf===1?'same_event_as_only_map':'whole_series'},detail,sourceRejection,originalForecastReplayEnabled:false,targetDocumentSha256,...flags});
  if(traceSha256===null||series.terminal)return result();
  if(!SHA.test(traceSha256))fail('trace_hash');
  let trace;
  try{
   trace=await journal.loadTrace(traceSha256);
   if(trace?.contract!=='aegis.diagnostic-feature-trace.v1'||trace.eligibleForServing!==false||trace.eligibleForTraining!==false||trace.recordedPrediction!==false||trace.mode!==phase||trace.seriesId!==series.seriesId||trace.matchId!==(currentMap?.mapId??null)||!notFuture(trace.decisionAt,decision)||!notFuture(trace.availableAt,decision)||trace.timings?.featuresReadyAt!==undefined&&!notFuture(trace.timings.featuresReadyAt,decision)||!Array.isArray(trace.routes)||trace.routes.length>12)fail('trace_identity_phase_or_time');
   const binding=trace.targetBinding;
   if(['series_history','map_prematch'].includes(trace.historicalBindings?.kind)){const ref=trace.historicalInputRef;if(ref?.contract!=='aegis.static-historical-input-reference.v1'||!SHA.test(ref.sha256??'')||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>16384)fail('static_historical_input_reference_required');}
   if(binding?.mapId!==trace.matchId||binding?.series?.seriesId!==series.seriesId||binding.series.team1Id!==series.team1Id||binding.series.team2Id!==series.team2Id||binding.series.outcome!=='series_team1_win')fail('trace_series_orientation');
   if(currentMap){const s=binding.mapSides;if(!obj(s)||s.radiant===s.dire||![s.radiant,s.dire].every(t=>[series.team1Id,series.team2Id].includes(t))||binding.mapOutcome!=='map_radiant_win'||binding.series.team1CurrentSide!==(s.radiant===series.team1Id?'radiant':'dire'))fail('trace_current_map_orientation');}
   else if(binding.mapSides!==null||binding.mapOutcome!==null||binding.series.team1CurrentSide!==null)fail('unexpected_map_side_binding');
   const seen=new Set();
   for(const route of trace.routes){
    const meta=metadata.get(route.targetId);if(!meta||seen.has(route.targetId)||!PHASES[phase].includes(meta.phase)||!meta.stateModes.includes(route.stateMode)||meta.phase==='SERIES_LIVE'&&route.stateMode!==(phase==='LIVE'?'observed_live':'observed_postdraft')||!allowed[route.targetId].includes(route.schemaRef?.sha256))fail('route_phase_or_schema');seen.add(route.targetId);
    const schema=await journal.loadSchema(route.schemaRef.sha256);if(schema.contract!=='aegis.unified-feature-projection-schema.v1'||schema.targetId!==route.targetId||schema.stateMode!==route.stateMode||!Array.isArray(schema.definitions)||schema.definitions.length!==route.featureCount||route.schemaRef.featureCount!==route.featureCount)fail('exact_schema_target_binding');
   }
  }catch(error){sourceRejection=typeof error?.message==='string'&&error.message.startsWith('diagnostic_target_routing:')?error.message.slice('diagnostic_target_routing:'.length):'journal_evidence_unavailable';return result();}
  if(!series.terminal){const route=trace.routes.find(r=>metadata.get(r.targetId).phase===MAIN_PHASE[phase]&&SEMANTICS[metadata.get(r.targetId).target].entity==='series');if(route)main={...descriptor(trace,traceSha256,route),team1Id:series.team1Id,team2Id:series.team2Id,team1CurrentSide:trace.targetBinding.series.team1CurrentSide};}
  if(selectedMapId!==null&&selectedMapId===currentMap?.mapId){
   const routes=trace.routes.filter(r=>SEMANTICS[metadata.get(r.targetId).target].entity==='map');
   if(routes.length)detail={status:'diagnostic_features_available',entity:'map',seriesId:series.seriesId,mapId:selectedMapId,mapNumber:currentMap.mapNumber,mapSides:structuredClone(trace.targetBinding.mapSides),targets:routes.map(r=>descriptor(trace,traceSha256,r)),prediction:null,...flags};
  }
  return result();
 }
 return Object.freeze({read,targetDocumentSha256,originalForecastReplayEnabled:false,...flags});
}
