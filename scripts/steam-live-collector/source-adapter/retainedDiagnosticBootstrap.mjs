/** Explicit host-owned ports. Imports no provider clients, database configuration,
 * model weights or schedulers. Creating this bootstrap never starts a server. */
import {mkdir,lstat} from 'node:fs/promises';import {join} from 'node:path';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {createRetainedFeaturePipeline} from './retainedFeaturePipeline.mjs';
import {createHistorySourceExportStore} from './historySourceExportStore.mjs';
import {createRetainedHistoryRevisionStore} from './retainedHistoryRevisionStore.mjs';
import {createDiagnosticFeatureJournal} from './diagnosticFeatureJournal.mjs';
import {createAppendOnlyHistoryFactStore} from './appendOnlyHistoryFactStore.mjs';
import {createRetainedHistorySourceExport} from './retainedHistorySourceExport.mjs';
import {createDiagnosticFeatureReadApi} from './diagnosticFeatureReadApi.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createDiagnosticTargetRouter} from './diagnosticTargetRouting.mjs';
import {createCompactDiagnosticHostJournal} from './compactDiagnosticHostJournal.mjs';
import {createRetainedMapHistoryHost} from './retainedMapHistoryHost.mjs';
export async function createRetainedDiagnosticHostPorts({config,shouldContinue,signal,now,onTraceIntent,seriesRouting=null,compactStorage=null,producerOptions={},boundedHistory=null}){
 if(boundedHistory!==null&&compactStorage===null)throw Error('retained_diagnostic_bootstrap:bounded_history_requires_explicit_compact_storage');
 if(seriesRouting!==null&&(typeof seriesRouting.contextStore?.resolve!=='function'||typeof seriesRouting.contextStore?.isCurrentContext!=='function'||!seriesRouting.targetDocument||!seriesRouting.expectedSchemaHashes))throw Error('retained_diagnostic_bootstrap:owned_series_routing_ports');
 const sources=join(config.stateDirectory,'sources'),revisions=join(config.stateDirectory,'revisions');
 await mkdir(sources,{recursive:true});await mkdir(revisions,{recursive:true});
 const sourceStore=await createHistorySourceExportStore(sources),historyRevisions=await createRetainedHistoryRevisionStore(revisions,{shouldContinue,signal});
 const factStore=await createAppendOnlyHistoryFactStore(config.historyFactDirectory,{shouldContinue,signal});
 const resourceArena=compactStorage?.resourceArena??createDiagnosticResourceArena({maxBytes:2*1024**3});
 const legacyJournal=createDiagnosticFeatureJournal({directory:join(config.stateDirectory,'journal'),resourceArena});
 async function legacyHasCommittedTrace(hash){
  if(!/^[a-f0-9]{64}$/.test(hash??''))throw Error('retained_diagnostic_bootstrap:trace_hash');
  try{await lstat(join(config.stateDirectory,'journal','traces',hash+'.json'));}catch(e){if(e.code==='ENOENT')return false;throw e;}
  await legacyJournal.loadTrace(hash);return true;
 }
 const journal=compactStorage===null?legacyJournal:createCompactDiagnosticHostJournal({...compactStorage,resourceArena,legacyJournal:{...legacyJournal,hasCommittedTrace:legacyHasCommittedTrace},onTraceIntent,shouldContinue,signal});
 const featureJournal=compactStorage!==null?journal:{...journal,async appendTrace(trace){
  // Intent precedes the CAS write. Restart checks the real journal bytes before
  // deciding to restore; an interrupted or failed append never counts as success.
  const body=JSON.parse(trace.utf8);await onTraceIntent({matchId:body.matchId,traceSha256:trace.sha256});
  if(!shouldContinue()||signal?.aborted)throw Error('manual_stop_before_trace_commit');
  return journal.appendTrace(trace);
 }};
 const historySourceFactory=async options=>{
  const refs=await factStore.references(),versionInputs=[];
  for(const ref of refs){if(!shouldContinue()||signal?.aborted)throw Error('manual_stop');versionInputs.push((await factStore.load(ref)).versionInput);}
  const computedAt=now();
  return createRetainedHistorySourceExport({draftPrefixInputs:options.draftPrefixInputs,matchId:options.matchId,computedAt,exportedAt:now(),versionInputs});
 };
 const producer=createUnifiedFeatureProducer({...producerOptions,resourceArena});
 const boundedHistoryPort=boundedHistory===null?null:createRetainedMapHistoryHost({...boundedHistory,writer:compactStorage.writer,resourceArena,historyProfileSha256:config.historyProfileSha256,materializationGeneration:config.materializationGeneration,shouldContinue,signal,now});
 const isCurrentSeriesInput=seriesRouting===null?null:({seriesInput,currentMapNumber,matchId,bundle})=>{
  if(seriesInput===null)return bundle.seriesId===null;
  const seriesId=JSON.parse(seriesInput.utf8).seriesId,context=seriesRouting.contextStore.resolve({seriesId,selection:{kind:'entry'}});
  return context!==null&&seriesRouting.contextStore.isCurrentContext(context)===true&&context.seriesInput.pin.sha256===seriesInput.pin.sha256&&context.seriesInput.pin.bytes===seriesInput.pin.bytes&&context.currentMap?.mapId===matchId&&context.currentMap?.mapNumber===currentMapNumber&&context.phase===bundle.mode;
 };
 const pipeline=createRetainedFeaturePipeline({producer,sourceStore,historyRevisions,historyProfileSha256:config.historyProfileSha256,materializationGeneration:config.materializationGeneration,featureJournal,historySourceFactory,shouldContinue,signal,now,limits:config.pipelineLimits,resourceArena,isCurrentSeriesInput,boundedHistory:boundedHistoryPort});
 // An owned handler is returned to the host; no HTTP listener or public serving
 // is activated. Its current-state view expires even without another capture.
 const readLiveEligibility=input=>pipeline.readLiveEligibility(input);
 // The optional series port is host-injected, never client configuration. It
 // performs no discovery, provider calls or writes on a read request. The host
 // restores its context store before exposing this handler.
 const targetRouter=seriesRouting===null?null:createDiagnosticTargetRouter({journal,targetDocument:seriesRouting.targetDocument,expectedSchemaHashes:seriesRouting.expectedSchemaHashes,readLiveEligibility,now});
 const readApi=createDiagnosticFeatureReadApi({journal,enabled:true,readLiveEligibility,now,targetRouter,
  resolveRouteContext:seriesRouting===null?null:input=>seriesRouting.contextStore.resolve(input),
  isCurrentRouteContext:seriesRouting===null?null:context=>seriesRouting.contextStore.isCurrentContext(context)});
 return{pipeline,readApi,readLiveEligibility,traceFormat:compactStorage===null?'legacy_v1':'compact_v2',resourceStatus:()=>resourceArena.status(),async close(){const result=pipeline.close();if(result.closed){producer.close();await journal.close?.();}return result;},async hasCommittedTrace(hash){
  // Only an absent trace itself means an uncommitted intent. A present trace
  // with a missing schema/source dependency is damaged evidence, not permission
  // to silently generate a replacement during pending-intent recovery.
  return compactStorage===null?legacyHasCommittedTrace(hash):journal.hasCommittedTrace(hash);
 }};
}
