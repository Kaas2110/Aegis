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
export async function createRetainedDiagnosticHostPorts({config,shouldContinue,signal,now,onTraceIntent,seriesRouting=null}){
 if(seriesRouting!==null&&(typeof seriesRouting.contextStore?.resolve!=='function'||typeof seriesRouting.contextStore?.isCurrentContext!=='function'||!seriesRouting.targetDocument||!seriesRouting.expectedSchemaHashes))throw Error('retained_diagnostic_bootstrap:owned_series_routing_ports');
 const sources=join(config.stateDirectory,'sources'),revisions=join(config.stateDirectory,'revisions');
 await mkdir(sources,{recursive:true});await mkdir(revisions,{recursive:true});
 const sourceStore=await createHistorySourceExportStore(sources),historyRevisions=await createRetainedHistoryRevisionStore(revisions,{shouldContinue,signal});
 const factStore=await createAppendOnlyHistoryFactStore(config.historyFactDirectory,{shouldContinue,signal});
 const resourceArena=createDiagnosticResourceArena({maxBytes:2*1024**3});
 const journal=createDiagnosticFeatureJournal({directory:join(config.stateDirectory,'journal'),resourceArena});
 const featureJournal={...journal,async appendTrace(trace){
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
 const producer=createUnifiedFeatureProducer();
 const pipeline=createRetainedFeaturePipeline({producer,sourceStore,historyRevisions,historyProfileSha256:config.historyProfileSha256,materializationGeneration:config.materializationGeneration,featureJournal,historySourceFactory,shouldContinue,signal,now,limits:config.pipelineLimits,resourceArena});
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
 return{pipeline,readApi,readLiveEligibility,async hasCommittedTrace(hash){
  if(!/^[a-f0-9]{64}$/.test(hash??''))throw Error('retained_diagnostic_bootstrap:trace_hash');
  // Only an absent trace itself means an uncommitted intent. A present trace
  // with a missing schema/source dependency is damaged evidence, not permission
  // to silently generate a replacement during pending-intent recovery.
  try{await lstat(join(config.stateDirectory,'journal','traces',hash+'.json'));}catch(e){if(e.code==='ENOENT')return false;throw e;}
  await journal.loadTrace(hash);return true;
 }};
}
