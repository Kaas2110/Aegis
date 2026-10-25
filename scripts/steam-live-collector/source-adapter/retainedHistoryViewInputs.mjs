/** Private retained-view adapters. No claimed JSON digest can enter this port:
 * the corpus WeakMap token and actual committed parts are validated first. */
import {readRetainedReferenceHistoryMapView,iterateRetainedReferenceHistoryMapView,readRetainedReferenceHistoryMapViewPrefix} from './retainedReferenceCorpus.mjs';
import {qualifyRetainedHistoryCorpus} from './historyCalculationCore.mjs';
import {pinRetainedHistoryJson} from './retainedOpenDotaFacts.mjs';
import {createDiagnosticResourceArena,measureBoundedJsonBytes} from './diagnosticResourceArena.mjs';
import {retainRetainedNativeHistoryView,readRetainedNativeHistoryView} from './retainedNativeHistoryView.mjs';
const MAX=64*1024*1024,KEYS=['matchId','endedAt','outcomeKnownAt','durationSeconds','radiantWon','radiantTeamId','direTeamId','radiantKills','direKills','players','heroes','playersKnownAt','heroesKnownAt','evidenceRef','availabilityBasis','originalHistoricalAvailabilityProven','sourceVersionSetSha256'];
/** Legacy core needs no native performance/clock or per-field provenance values.
 * Validate ALL original field availability before retaining this small projection.
 * The original streamed facts pin still binds every complete normalized row.
 */
export async function readRetainedMapViewCoreInputs({historyView,nativeHistoryView=null,matchId,computedAt,resourceArena=null}={}){
 const options={matchId,decisionAt:computedAt},view=readRetainedReferenceHistoryMapView(historyView,options),d=view.descriptor,arena=resourceArena??createDiagnosticResourceArena(),lease=arena.reserve(MAX*6+65536);if(!lease)throw Error('retained_view_core_memory_reservation');
 let nativeOwner=null;try{
  if(nativeHistoryView!==null)nativeOwner=retainRetainedNativeHistoryView(nativeHistoryView);
  const rows=[];let total=0;
  for await(const map of iterateRetainedReferenceHistoryMapView(historyView,options)){
   const qualified=qualifyRetainedHistoryCorpus({scope:{...d.scope,rowCount:1},maps:[map]},d.historyCutoffAt);if(!qualified.verified)throw Error('retained_view_field_scope:'+qualified.reason);
   const row={...Object.fromEntries(KEYS.map(k=>[k,map[k]])),fieldAvailability:{}};total+=measureBoundedJsonBytes(row,{maxBytes:MAX});if(total>MAX)throw Error('retained_view_core_projection_bound');rows.push(row);
  }
  const facts={data:{contract:'aegis.prior-map-facts.v1',scope:d.scope,maps:rows},rows,pin:d.factsPin,ref:'sha256:'+d.factsSha256},native=nativeOwner===null?null:readRetainedNativeHistoryView(nativeOwner.handle,{historyView,matchId,decisionAt:computedAt}),nativeInput=native?.nativeInput??pinRetainedHistoryJson({contract:'aegis.pinned-native-economy-observations.v1',observations:[]},'retained-history/no-native-observations.json'),draftPrefixInputs=await readRetainedReferenceHistoryMapViewPrefix(historyView,options);
  return {view,facts,nativeInput,draftPrefixInputs,nativeEvidenceInputs:native?.nativeEvidenceInputs??[],nativeAlignmentInputs:native?.nativeAlignmentInputs??[],expectedProfileReviewSha256:native?.expectedProfileReviewSha256??null,release(){lease.release();nativeOwner?.release();}};
 }catch(error){nativeOwner?.release();lease.release();throw error;}
}
