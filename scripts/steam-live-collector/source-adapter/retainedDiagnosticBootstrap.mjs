/** Explicit host-owned ports. Imports no provider clients, database configuration,
 * model weights or schedulers. Creating this bootstrap never starts a server. */
import {mkdir} from 'node:fs/promises';import {join} from 'node:path';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {createRetainedFeaturePipeline} from './retainedFeaturePipeline.mjs';
import {createHistorySourceExportStore} from './historySourceExportStore.mjs';
import {createRetainedHistoryRevisionStore} from './retainedHistoryRevisionStore.mjs';
import {createDiagnosticFeatureJournal} from './diagnosticFeatureJournal.mjs';
import {createAppendOnlyHistoryFactStore} from './appendOnlyHistoryFactStore.mjs';
import {createRetainedHistorySourceExport} from './retainedHistorySourceExport.mjs';
export async function createRetainedDiagnosticHostPorts({config,shouldContinue,signal,now,onTraceIntent}){
 const sources=join(config.stateDirectory,'sources'),revisions=join(config.stateDirectory,'revisions');
 await mkdir(sources,{recursive:true});await mkdir(revisions,{recursive:true});
 const sourceStore=await createHistorySourceExportStore(sources),historyRevisions=await createRetainedHistoryRevisionStore(revisions,{shouldContinue,signal});
 const factStore=await createAppendOnlyHistoryFactStore(config.historyFactDirectory,{shouldContinue,signal});
 const journal=createDiagnosticFeatureJournal({directory:join(config.stateDirectory,'journal')});
 const featureJournal={...journal,async appendTrace(trace){
  // Intent precedes the CAS write. Restart checks the real journal bytes before
  // deciding to restore; an interrupted or failed append never counts as success.
  const body=JSON.parse(trace.utf8);await onTraceIntent({matchId:body.matchId,traceSha256:trace.sha256});
  return journal.appendTrace(trace);
 }};
 const historySourceFactory=async options=>{
  const refs=await factStore.references(),versionInputs=[];
  for(const ref of refs){if(!shouldContinue()||signal?.aborted)throw Error('manual_stop');versionInputs.push((await factStore.load(ref)).versionInput);}
  const computedAt=now();
  return createRetainedHistorySourceExport({draftPrefixInputs:options.draftPrefixInputs,matchId:options.matchId,computedAt,exportedAt:now(),versionInputs});
 };
 const producer=createUnifiedFeatureProducer();
 const pipeline=createRetainedFeaturePipeline({producer,sourceStore,historyRevisions,historyProfileSha256:config.historyProfileSha256,materializationGeneration:config.materializationGeneration,featureJournal,historySourceFactory,shouldContinue,signal,now,limits:config.pipelineLimits});
 return{pipeline,async hasCommittedTrace(hash){
  try{await journal.loadTrace(hash);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}
 }};
}
