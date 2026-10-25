/** Owned read-only admin handler. Disabled by default; does not listen, fetch,
 * migrate, fit or invoke a consumer. The host separately owns access control. */
import {readCurrentLiveEligibilitySnapshot} from './currentLiveEligibilitySnapshot.mjs';
import {LEGACY_FEATURE_CAPACITY_PROFILE,FULL_FEATURE_CAPACITY_PROFILE,resolveFeatureCapacityProfile} from './featureCapacityProfiles.mjs';
const SHA=/^[a-f0-9]{64}$/,TARGET=/^[A-Z_]{3,40}$/;
const flags={diagnosticOnly:true,eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
const answer=(status,body)=>({status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},body});
const error=(status,code)=>answer(status,{error:code,...flags});
export function createDiagnosticFeatureReadApi({journal,enabled=false,basePath='/admin/feature-diagnostics',maxFeaturePage=200,maxResponseBytes=1024*1024,maxConcurrentReads=4,readLiveEligibility=null,now=()=>new Date().toISOString(),targetRouter=null,resolveRouteContext=null,isCurrentRouteContext=null}={}){
 const compact=journal?.contract==='aegis.compact-diagnostic-feature-journal.v2';
 if(typeof journal?.loadTrace!=='function'||!compact&&typeof journal?.loadSchema!=='function'||typeof enabled!=='boolean'||typeof basePath!=='string'||!/^\/[a-zA-Z0-9_/-]+$/.test(basePath)||basePath.endsWith('/')||!Number.isSafeInteger(maxFeaturePage)||maxFeaturePage<1||maxFeaturePage>1000||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1024||maxResponseBytes>4*1024*1024)throw Error('diagnostic_feature_read_api:configuration');
 if(!Number.isSafeInteger(maxConcurrentReads)||maxConcurrentReads<1||maxConcurrentReads>16)throw Error('diagnostic_feature_read_api:read_bound');
 if(typeof now!=='function'||readLiveEligibility!==null&&typeof readLiveEligibility!=='function'||targetRouter!==null&&typeof targetRouter?.read!=='function'||resolveRouteContext!==null&&typeof resolveRouteContext!=='function'||isCurrentRouteContext!==null&&(typeof isCurrentRouteContext!=='function'||resolveRouteContext===null)||(targetRouter===null)!==(resolveRouteContext===null))throw Error('diagnostic_feature_read_api:owned_state_or_route_ports');
 let activeReads=0;
 const bounded=body=>Buffer.byteLength(JSON.stringify(body))>maxResponseBytes?error(413,'diagnostic_response_bound'):answer(200,body);
 function currentRouteContext(context){
  if(isCurrentRouteContext===null)return true; // Existing trusted host resolver compatibility.
  const current=isCurrentRouteContext(context);if(current&&typeof current.then==='function'){Promise.resolve(current).catch(()=>{});return false;}return current===true;
 }
  function currentEligibility(trace,hash){
  if(trace.mode!=='LIVE')return{applicable:false,eligibleForRetainingForecast:false,reason:'not_live_trace'};
   const snapshot=readLiveEligibility===null?{state:null,evaluatedAt:null}:readCurrentLiveEligibilitySnapshot({readLiveEligibility,now,matchId:trace.matchId,minimumDecisionAt:trace.decisionAt}),state=snapshot.state;
  const eligible=state?.eligibleForRetainingForecast===true&&state.lastTraceSha256===hash&&state.stateView?.observationId===trace.nativeObservationId;
   return{applicable:true,eligibleForRetainingForecast:eligible,reason:eligible?'qualified_current_source_state':state?.lastTraceSha256&&state.lastTraceSha256!==hash?'trace_is_not_latest_qualified_state':state?.reason??'qualified_live_state_port_unavailable',evaluatedAt:snapshot.evaluatedAt,lastConfirmedAt:state?.stateView?.lastConfirmedAt??null,expiresAt:state?.stateView?.expiresAt??null,continuityGeneration:state?.stateView?.continuityGeneration??null,classification:state?.stateView?.classification??'unknown',ageSeconds:state?.ageSeconds??null,userMessage:eligible?null:'Прогноз недоступен',recordedPrediction:false};
 }
 async function handle({method='GET',url,signal=null}={}){
  if(!enabled)return error(404,'diagnostic_admin_disabled');
  if(signal!==null&&!(signal instanceof AbortSignal))return error(400,'request_contract');
  if(signal?.aborted)return error(499,'diagnostic_request_cancelled');
  if(method!=='GET')return error(405,'read_only');
  if(typeof url!=='string'||url.length>2048||!url.startsWith('/')||url.startsWith('//'))return error(400,'request_contract');
  let parsed;try{parsed=new URL(url,'http://127.0.0.1');}catch{return error(400,'request_contract');}
  const routeMatch=parsed.pathname.match(new RegExp('^'+basePath+'/series/([^/]{1,384})/routes$'));
  if(routeMatch){
   let seriesId;try{seriesId=decodeURIComponent(routeMatch[1]);}catch{return error(400,'series_id');}
   if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(seriesId))return error(400,'series_id');
   if([...parsed.searchParams.keys()].some(k=>k!=='mapId'||parsed.searchParams.getAll(k).length!==1))return error(400,'query_contract');
   const selectedMapId=parsed.searchParams.get('mapId');if(selectedMapId!==null&&!/^[1-9]\d{0,19}$/.test(selectedMapId))return error(400,'query_contract');
   const selection=selectedMapId===null?{kind:'entry'}:{kind:'manual',mapId:selectedMapId};
   if(!targetRouter)return error(404,'owned_route_context_unavailable');
   if(activeReads>=maxConcurrentReads)return error(429,'diagnostic_reader_busy');activeReads++;
   try{
    const context=await resolveRouteContext({seriesId,selection});
    if(!context||context.seriesInput===undefined||!currentRouteContext(context))return error(503,'diagnostic_evidence_unavailable');
    // URL inputs never supply source bytes, filesystem paths or a backdated cutoff.
     let route=await targetRouter.read({...context,selection,decisionAt:now()});
    if(route.seriesId!==seriesId)return error(503,'diagnostic_evidence_unavailable');
     // Awaiting the router itself is an async boundary. Its owned synchronous
     // finalizer closes it after all IO, without client-controlled source/time.
     if(typeof targetRouter.finalizeRead==='function'){route=targetRouter.finalizeRead(route);if(route&&typeof route.then==='function'){Promise.resolve(route).catch(()=>{});return error(503,'diagnostic_evidence_unavailable');}}
     else if(route.main?.currentLiveEligibility?.eligibleForRetainingForecast===true||route.detail?.currentLiveEligibility?.eligibleForRetainingForecast===true)return error(503,'diagnostic_evidence_unavailable');
     if(!route||route.seriesId!==seriesId||!currentRouteContext(context))return error(503,'diagnostic_evidence_unavailable');
    return bounded(route);
   }catch{return error(503,'diagnostic_evidence_unavailable');}finally{activeReads--;}
  }
  const prefix=basePath+'/traces/';if(!parsed.pathname.startsWith(prefix))return error(404,'not_found');
  const rest=parsed.pathname.slice(prefix.length).split('/'),hash=rest[0];if(!SHA.test(hash??''))return error(400,'trace_hash');
  const page=rest.length===3&&rest[1]==='features'&&TARGET.test(rest[2]);if(rest.length!==1&&!page)return error(404,'not_found');
  const allowed=page?['offset','limit']:[];if([...parsed.searchParams.keys()].some(k=>!allowed.includes(k)||parsed.searchParams.getAll(k).length!==1))return error(400,'query_contract');
  const integer=(key,fallback)=>{const raw=parsed.searchParams.get(key);return raw===null?fallback:/^(0|[1-9]\d{0,6})$/.test(raw)?Number(raw):null;};
  const offset=integer('offset',0),limit=integer('limit',maxFeaturePage);if(page&&(offset===null||limit===null||limit<1||limit>maxFeaturePage||offset>(compact?FULL_FEATURE_CAPACITY_PROFILE:LEGACY_FEATURE_CAPACITY_PROFILE).maxFeatures))return error(400,'page_bound');
  if(activeReads>=maxConcurrentReads)return error(429,'diagnostic_reader_busy');activeReads++;
  let held=null;
  try{
   const loaded=await journal.loadTrace(hash,compact?(page?{targetId:rest[2]}:{metadataOnly:true}):{},compact?{signal}:{});held=compact&&loaded?.contract==='aegis.compact-diagnostic-feature-journal.v2'&&loaded.body?loaded:null;const trace=held?held.body:loaded;
   if(signal?.aborted)return error(499,'diagnostic_request_cancelled');
   if(page){
    const route=trace.routes.find(r=>r.targetId===rest[2]);if(!route)return error(404,'target_not_found');
    const capacity=resolveFeatureCapacityProfile(held?(route.schemaRef.capacityProfile??LEGACY_FEATURE_CAPACITY_PROFILE.id):LEGACY_FEATURE_CAPACITY_PROFILE.id);if(offset>capacity.maxFeatures)return error(400,'page_bound');
    if(held){let schemaPage=null,vectorPage=null;try{
     schemaPage=held.readSchemaPage({targetId:route.targetId,offset,limit});vectorPage=held.readVectorPage({targetId:route.targetId,offset,limit});
     if(!schemaPage||!vectorPage||schemaPage.header.targetId!==route.targetId||schemaPage.header.stateMode!==route.stateMode||schemaPage.expandedSchemaHash!==route.schemaRef.sha256||vectorPage.expandedSchemaHash!==route.schemaRef.sha256||schemaPage.total!==route.featureCount||vectorPage.total!==route.featureCount||schemaPage.definitions.length!==vectorPage.values.length||vectorPage.names.length!==vectorPage.values.length||vectorPage.missing.length!==vectorPage.values.length)return error(503,'diagnostic_evidence_unavailable');
     const features=vectorPage.values.map((value,index)=>{if(schemaPage.definitions[index].name!==vectorPage.names[index])throw Error('compact_page_order');return{index:offset+index,name:vectorPage.names[index],value,missing:vectorPage.missing[index]};});
     return bounded({contract:'aegis.diagnostic-feature-page.v1',traceFormat:'compact_v2',traceSha256:hash,matchId:trace.matchId??null,seriesId:trace.seriesId??null,targetId:route.targetId,stateMode:route.stateMode,schemaRef:route.schemaRef,offset,limit,total:vectorPage.total,nextOffset:vectorPage.nextOffset,features,currentLiveEligibility:currentEligibility(trace,hash),...flags});
    }finally{schemaPage?.release();vectorPage?.release();}}
    const schema=await journal.loadSchema(route.schemaRef.sha256),vector=trace.vectors[route.vectorRef],total=vector.values.length,end=Math.min(total,offset+limit),features=[];
    if(schema.targetId!==route.targetId||schema.definitions.length!==total)return error(503,'diagnostic_evidence_unavailable');
    for(let index=offset;index<end;index++)features.push({index,name:schema.definitions[index].name,value:vector.values[index],missing:vector.missing[index]});
     return bounded({contract:'aegis.diagnostic-feature-page.v1',traceSha256:hash,matchId:trace.matchId??null,seriesId:trace.seriesId??null,targetId:route.targetId,stateMode:route.stateMode,schemaRef:route.schemaRef,offset,limit,total,nextOffset:end<total?end:null,features,currentLiveEligibility:currentEligibility(trace,hash),...flags});
   }
   const routes=trace.routes.map(r=>{if(held)return{targetId:r.targetId,stateMode:r.stateMode,schemaRef:r.schemaRef,featureCount:r.featureCount,observedFeatures:null,missingFeatures:null,countsStatus:'not_scanned_use_bounded_feature_pages'};const v=trace.vectors[r.vectorRef];return{targetId:r.targetId,stateMode:r.stateMode,schemaRef:r.schemaRef,featureCount:r.featureCount,observedFeatures:v.missing.reduce((n,m)=>n+Number(!m),0),missingFeatures:v.missing.reduce((n,m)=>n+Number(m),0)};});
    const body={contract:'aegis.diagnostic-feature-summary.v1',...(held?{traceFormat:'compact_v2',assetVerification:held.assetVerification??'all_targets'}:{}),traceSha256:hash,routes,currentLiveEligibility:currentEligibility(trace,hash),...flags};
   // Explicit safe scalar provenance only; do not expose raw captures, private
   // filesystem references, full schemas or vectors through the summary route.
   for(const key of ['producerContract','matchId','seriesId','decisionAt','availableAt','mode','historyCutoffAt','historyContextHash','sourceSnapshotHash','nativeObservationId','nativeRawSha256','nativeKnownAt','nativeGameClock'])if(trace[key]!==undefined)body[key]=trace[key];
   return bounded(body);
  }catch(cause){return /compact_feature_journal:request_cancelled/.test(cause?.message??'')?error(499,'diagnostic_request_cancelled'):/compact_feature_journal:(pending_limit|queue_expired|queue_memory_reservation)/.test(cause?.message??'')?{...error(429,'diagnostic_reader_busy'),headers:{...answer(429,{}).headers,'retry-after':'1'}}:error(503,'diagnostic_evidence_unavailable');}finally{held?.release();activeReads--;}
 }
 return Object.freeze({handle,enabled,basePath,readOnly:true});
}
