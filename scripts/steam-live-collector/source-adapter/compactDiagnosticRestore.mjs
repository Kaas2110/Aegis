/** Compare replay with actual compact pages. No expanded schema/vector JSON. */
import {evidenceHash} from './playerHeroEconomyFeatures.mjs';
const KEYS=['producerContract','matchId','seriesId','mode','featureInputCutoffAt','historyCutoffAt','sourceSnapshotHash','historicalBindings','historicalInputRef','semanticEvidence','targetBinding','sourceAdmission','inputSourceBindings','draftObservation','liveRejection','nativeObservationId','nativeRawSha256','nativeKnownAt','nativeGameClock','seriesReceiptPin','eligibleForTraining','eligibleForServing','recordedPrediction'];
function select(value){return{...Object.fromEntries(KEYS.map(k=>[k,value[k]??null])),reconstruction:value.reconstruction==null?null:Object.fromEntries(Object.entries(value.reconstruction).filter(([k])=>k!=='reconstructedAt'))};}
export function compactTraceMatchesBundle(held,bundle){
 const body=held?.body;if(body?.contract!=='aegis.compact-diagnostic-feature-trace.v2'||typeof held.readVectorPage!=='function'||!Array.isArray(body.routes)||body.routes.length!==bundle.routes.length)return false;
 const native=bundle.components.legacyNative,expected={...bundle,producerContract:bundle.contract,nativeObservationId:native?.observationId??null,nativeRawSha256:native?.rawSha256??null,nativeKnownAt:native?.knownAt??null,nativeGameClock:native?.eventClockSeconds??null,seriesReceiptPin:bundle.components.series?.sourcePin??null};
 if(evidenceHash(select(body))!==evidenceHash(select(expected)))return false;
 for(let routeIndex=0;routeIndex<body.routes.length;routeIndex++){
  const route=body.routes[routeIndex],actual=bundle.routes[routeIndex],vector=actual.diagnosticVector,n=vector.names.length;
  if(route.targetId!==actual.targetId||route.stateMode!==actual.stateMode||route.featureCount!==n||route.schemaRef.sha256!==actual.schemaRef.sha256||route.schemaRef.namesSha256!==actual.schemaRef.namesSha256)return false;
  for(let offset=0;offset<n;offset+=200){const page=held.readVectorPage({targetId:route.targetId,offset,limit:200});if(!page)return false;try{const length=Math.min(200,n-offset);if(page.offset!==offset||page.total!==n||page.expandedSchemaHash!==actual.schemaRef.sha256||page.values.length!==length||page.names.length!==length||page.missing.length!==length)return false;for(let i=0;i<length;i++)if(page.names[i]!==vector.names[offset+i]||!Object.is(page.values[i],vector.values[offset+i])||page.missing[i]!==vector.missing[offset+i])return false;}finally{page.release();}}
 }
 return true;
}
