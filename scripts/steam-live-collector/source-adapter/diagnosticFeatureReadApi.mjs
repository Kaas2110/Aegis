/** Owned read-only admin handler. Disabled by default; does not listen, fetch,
 * migrate, fit or invoke a consumer. The host separately owns access control. */
const SHA=/^[a-f0-9]{64}$/,TARGET=/^[A-Z_]{3,40}$/;
const flags={diagnosticOnly:true,eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
const answer=(status,body)=>({status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},body});
const error=(status,code)=>answer(status,{error:code,...flags});
export function createDiagnosticFeatureReadApi({journal,enabled=false,basePath='/admin/feature-diagnostics',maxFeaturePage=200,maxResponseBytes=1024*1024,maxConcurrentReads=4}={}){
 if(typeof journal?.loadTrace!=='function'||typeof journal?.loadSchema!=='function'||typeof enabled!=='boolean'||typeof basePath!=='string'||!/^\/[a-zA-Z0-9_/-]+$/.test(basePath)||basePath.endsWith('/')||!Number.isSafeInteger(maxFeaturePage)||maxFeaturePage<1||maxFeaturePage>1000||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1024||maxResponseBytes>4*1024*1024)throw Error('diagnostic_feature_read_api:configuration');
 if(!Number.isSafeInteger(maxConcurrentReads)||maxConcurrentReads<1||maxConcurrentReads>16)throw Error('diagnostic_feature_read_api:read_bound');
 let activeReads=0;
 const bounded=body=>Buffer.byteLength(JSON.stringify(body))>maxResponseBytes?error(413,'diagnostic_response_bound'):answer(200,body);
 async function handle({method='GET',url}={}){
  if(!enabled)return error(404,'diagnostic_admin_disabled');
  if(method!=='GET')return error(405,'read_only');
  if(typeof url!=='string'||url.length>2048||!url.startsWith('/')||url.startsWith('//'))return error(400,'request_contract');
  let parsed;try{parsed=new URL(url,'http://127.0.0.1');}catch{return error(400,'request_contract');}
  const prefix=basePath+'/traces/';if(!parsed.pathname.startsWith(prefix))return error(404,'not_found');
  const rest=parsed.pathname.slice(prefix.length).split('/'),hash=rest[0];if(!SHA.test(hash??''))return error(400,'trace_hash');
  const page=rest.length===3&&rest[1]==='features'&&TARGET.test(rest[2]);if(rest.length!==1&&!page)return error(404,'not_found');
  const allowed=page?['offset','limit']:[];if([...parsed.searchParams.keys()].some(k=>!allowed.includes(k)||parsed.searchParams.getAll(k).length!==1))return error(400,'query_contract');
  const integer=(key,fallback)=>{const raw=parsed.searchParams.get(key);return raw===null?fallback:/^(0|[1-9]\d{0,6})$/.test(raw)?Number(raw):null;};
  const offset=integer('offset',0),limit=integer('limit',maxFeaturePage);if(page&&(offset===null||limit===null||limit<1||limit>maxFeaturePage||offset>150000))return error(400,'page_bound');
  if(activeReads>=maxConcurrentReads)return error(429,'diagnostic_reader_busy');activeReads++;
  try{
   const trace=await journal.loadTrace(hash);
   if(page){
    const route=trace.routes.find(r=>r.targetId===rest[2]);if(!route)return error(404,'target_not_found');
    const schema=await journal.loadSchema(route.schemaRef.sha256),vector=trace.vectors[route.vectorRef],total=vector.values.length,end=Math.min(total,offset+limit),features=[];
    if(schema.targetId!==route.targetId||schema.definitions.length!==total)return error(503,'diagnostic_evidence_unavailable');
    for(let index=offset;index<end;index++)features.push({index,name:schema.definitions[index].name,value:vector.values[index],missing:vector.missing[index]});
    return bounded({contract:'aegis.diagnostic-feature-page.v1',traceSha256:hash,matchId:trace.matchId??null,seriesId:trace.seriesId??null,targetId:route.targetId,stateMode:route.stateMode,schemaRef:route.schemaRef,offset,limit,total,nextOffset:end<total?end:null,features,...flags});
   }
   const routes=trace.routes.map(r=>{const v=trace.vectors[r.vectorRef];return{targetId:r.targetId,stateMode:r.stateMode,schemaRef:r.schemaRef,featureCount:r.featureCount,observedFeatures:v.missing.reduce((n,m)=>n+Number(!m),0),missingFeatures:v.missing.reduce((n,m)=>n+Number(m),0)};});
   const body={contract:'aegis.diagnostic-feature-summary.v1',traceSha256:hash,routes,...flags};
   // Explicit safe scalar provenance only; do not expose raw captures, private
   // filesystem references, full schemas or vectors through the summary route.
   for(const key of ['producerContract','matchId','seriesId','decisionAt','availableAt','mode','historyCutoffAt','historyContextHash','sourceSnapshotHash','nativeObservationId','nativeRawSha256','nativeKnownAt','nativeGameClock'])if(trace[key]!==undefined)body[key]=trace[key];
   return bounded(body);
  }catch{return error(503,'diagnostic_evidence_unavailable');}finally{activeReads--;}
 }
 return Object.freeze({handle,enabled,basePath,readOnly:true});
}
