/** One aggregate, credential-safe diagnostic collection cycle. No serving/ML imports. */
import {existsSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {VERSION,sha,iso,boundedFile,openArchive,loadState,reserve,atomic,immutable} from './store.mjs';
import {normalizeLocalCapture} from './source-adapter/steamLiveAdapter.mjs';
import {persistDynamicCapture,openLocalDiagnosticDatabase} from './source-adapter/dynamicDbSink.mjs';
export const ENDPOINT='https://api.steampowered.com/IDOTA2Match_570/GetLiveLeagueGames/v1/';
const MAX_BYTES=4*1024**2,ACTIVE_MS=120000,IDLE_MS=600000;
const falseFlags={diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false};
export function validateConfig(c){
 if(c?.version!==VERSION||c.diagnosticOnly!==true||c.servingEnabled!==false||c.trainingEnabled!==false||c.publicPromotion!==false||!isAbsolute(c.outputDir??'')||!isAbsolute(c.controlFile??'')||!isAbsolute(c.stopFile??''))throw Error('diagnostic_config_required');
 if(!Number.isSafeInteger(c.owner?.pid)||c.owner.pid<=0||typeof c.owner.startTimeTicks!=='string'||!/^\d{16,20}$/.test(c.owner.startTimeTicks))throw Error('actual_session_owner_required');
 if(!Number.isSafeInteger(c.wallCapSeconds)||c.wallCapSeconds<1||c.wallCapSeconds>86400||!Number.isSafeInteger(c.maxRequests)||c.maxRequests<1||c.maxRequests>1000)throw Error('bounded_session_required');
 if(c.dynamicSink!==undefined&&(c.dynamicSink===null||typeof c.dynamicSink!=='object'||typeof c.dynamicSink.enabled!=='boolean'||c.dynamicSink.enabled&&(!/^[A-Z][A-Z0-9_]{0,63}$/.test(c.dynamicSink.databaseEnv??'DATABASE_URL'))))throw Error('dynamic_sink_config_invalid');
 return c;
}
export function inspectOwner(owner){
 if(process.platform!=='win32')return false;
 const powershell=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const r=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; (Get-Process -Id "+owner.pid+").StartTime.ToUniversalTime().Ticks.ToString()"],{encoding:'utf8',timeout:5000,windowsHide:true});
 return r.status===0&&r.stdout.trim()===owner.startTimeTicks;
}
export function readControl(config){
 if(existsSync(config.stopFile))return {allowed:false,reason:'manual_stop_latch'};
 try{const c=JSON.parse(boundedFile(config.controlFile,65536));if(c.version!==1||c.enabled!==true||c.paused!==false)return{allowed:false,reason:'manual_disabled_or_paused'};return{allowed:true};}catch{return{allowed:false,reason:'manual_control_unavailable'};}
}
function retryAfter(value,now){
 if(!value)return 0;let at;if(/^\d{1,10}$/.test(value))at=now+Number(value)*1000;else at=Date.parse(value);
 return Number.isFinite(at)&&at>now?at:0;
}
async function readBody(response,signal){
 if(!response.body)return Buffer.alloc(0);const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){if(signal.aborted)throw Error('request_aborted');const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES){await reader.cancel();throw Error('response_body_bound');}chunks.push(Buffer.from(value));}return Buffer.concat(chunks);}
 finally{reader.releaseLock();}
}
export async function runCycle(config,{env=process.env,transport=globalThis.fetch,now=Date.now,verifyOwner=inspectOwner,signal,dynamicDbFactory=openLocalDiagnosticDatabase}={}){
 validateConfig(config);const base={version:VERSION,...falseFlags};
 const blocked=reason=>({...base,status:'blocked',reason,attempted:false});
 if(signal?.aborted)return blocked('session_stopped');
 const control=readControl(config);if(!control.allowed)return blocked(control.reason);
 if(verifyOwner(config.owner)!==true)return blocked('session_owner_unverified');
 const key=env.STEAM_WEB_API_KEY;if(typeof key!=='string'||! /^[a-fA-F0-9]{32}$/.test(key))return blocked('server_credential_unavailable');
 let lock;try{lock=openArchive(config.outputDir,config.owner,now());}catch(error){if(error?.message==='collector_lock_requires_manual_review')return {...blocked('collector_lock_busy'),nextAttemptAt:iso(now()+1000)};return blocked('collector_lock_or_archive_unavailable');}
 try{
  const state=loadState(config.outputDir),at=now(),previousRaw=state.lastRawSha256;if(!Number.isSafeInteger(at)||at<0)throw Error('invalid_clock');
  if(state.lastAttemptAt&&at<Date.parse(state.lastAttemptAt))return blocked('clock_moved_backwards');
  if(state.authBlocked403)return blocked('provider_403_requires_manual_review');
  if(Number(state.dayCounts[iso(at).slice(0,10)]??0)>=1000)return blocked('daily_quota_exhausted');
  const floor=state.lastAttemptAt?Date.parse(state.lastAttemptAt)+60000:0,next=Math.max(floor,state.nextAttemptAt?Date.parse(state.nextAttemptAt):0);
  if(at<next)return {...blocked('cadence_or_backoff'),nextAttemptAt:iso(next)};
  if(!readControl(config).allowed||signal?.aborted)return blocked('manual_stop_before_reservation');
  const requestId=reserve(config.outputDir,state,at),requestStartedAt=iso(at);
  const timeout=new AbortController(),combined=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
  const timer=setTimeout(()=>timeout.abort(),20000);let status=null,receivedAt=null,bytes=null,retry=0,reason=null,normalized=null,rawSha256=null,rawPersistedAt=null;
  try{
   // Fixed URL, no query credential, no redirects, no per-match/user fanout.
   const response=await transport(ENDPOINT,{method:'GET',headers:{'x-webapi-key':key,Accept:'application/json','User-Agent':'Aegis-Steam-Diagnostic/1.0'},redirect:'error',signal:combined});
   status=response.status;if(!Number.isInteger(status)||status<100||status>599)throw Error('invalid_http_status');
   retry=retryAfter(response.headers.get('retry-after'),now());bytes=await readBody(response,combined);receivedAt=iso(now());
   if(bytes.includes(Buffer.from(key))){bytes=null;reason='secret_echo_suppressed';}
   else {
    const bodyHash=sha(bytes);immutable(config.outputDir,'raw/'+bodyHash+'.body',bytes);rawSha256=bodyHash;rawPersistedAt=iso(now());
    normalized=normalizeLocalCapture({endpoint:'GetLiveLeagueGames/v1',body:bytes,httpStatus:status,requestStartedAt,receivedAt,persistedAt:rawPersistedAt,rawSha256,payloadRef:'journal:'+rawSha256,authenticatedAttempt:true});
    immutable(config.outputDir,'normalized/'+requestId+'.json',Buffer.from(JSON.stringify(normalized)+'\n'));
    if(status!==200)reason='http_'+status;else if(!['normalized_capture_diagnostic','empty_games_diagnostic'].includes(normalized.status))reason='source_schema_or_payload_unconfirmed';
   }
  }catch{reason=combined.aborted?'request_aborted':'transport_or_capture_failed';}
  finally{clearTimeout(timer);}
  let dynamicDbSink={status:'disabled',attempted:0,diagnosticOnly:true};
  if(config.dynamicSink?.enabled===true&&normalized?.observations.length&&status===200){
   let db;try{
    if(signal?.aborted||!readControl(config).allowed)throw Error('diagnostic_sink_manual_stop');
    db=await dynamicDbFactory({env,envName:config.dynamicSink.databaseEnv??'DATABASE_URL'});
    dynamicDbSink={status:'persisted',...await persistDynamicCapture(normalized,db,{signal,deadlineMs:Date.now()+10000})};
   }catch{dynamicDbSink={status:'failed_requires_archive_catchup',reason:'diagnostic_db_unavailable_or_write_failed',diagnosticOnly:true,sourceArchivePreserved:true};}
   finally{if(db)try{await db.end();}catch{}}
  }
  const completed=now();if(completed<at||receivedAt&&Date.parse(receivedAt)>completed)throw Error('capture_clock_regressed');
  const successful=reason===null&&status===200&&normalized!==null;
  if(successful){state.lastSuccessfulAt=receivedAt;state.lastGamesCount=normalized.observations.length+normalized.rejections.length;state.consecutiveFailures=0;state.nextAttemptAt=iso(completed+(state.lastGamesCount===0?IDLE_MS:ACTIVE_MS));state.lastRawSha256=rawSha256;}
  else {state.consecutiveFailures++;const base=state.lastGamesCount===0?IDLE_MS:ACTIVE_MS,backoff=Math.min(6*3600000,base*2**Math.min(state.consecutiveFailures,12));state.nextAttemptAt=iso(Math.max(completed+(status===429?Math.max(backoff,600000):backoff),retry));if(status===403)state.authBlocked403=true;}
  const receipt={...base,dynamicDbSink,requestId,endpoint:'GetLiveLeagueGames/v1',source:'steam',requestStartedAt,receivedAt,rawPersistedAt,persistedAt:rawPersistedAt,httpStatus:status,status:successful?'captured_diagnostic':'degraded',reason,
   rawSha256,rawFile:rawSha256?'raw/'+rawSha256+'.body':null,payloadRef:rawSha256?'journal:'+rawSha256:null,bodyBytes:bytes?.length??null,
   normalizedFile:normalized?'normalized/'+requestId+'.json':null,normalizedStatus:normalized?.status??null,observations:normalized?.observations.length??0,rejections:normalized?.rejections.length??0,
   cadenceMode:state.lastGamesCount===null?'unknown':state.lastGamesCount===0?'idle':'active',activePollSeconds:120,idlePollSeconds:600,requestFloorSeconds:60,dailyLimit:1000,
   providerEventAt:null,eventToAppLatencyMeasured:false,declaredDelayIsSla:false,unchangedRawFromPrevious:rawSha256!==null&&rawSha256===previousRaw,
   quotaDay:requestStartedAt.slice(0,10),quotaReservedToday:state.dayCounts[requestStartedAt.slice(0,10)],nextAttemptAt:state.authBlocked403?null:state.nextAttemptAt,requiresManualReview:state.authBlocked403,completedAt:iso(completed),attempted:true};
  immutable(config.outputDir,'observations/'+requestId+'.json',Buffer.from(JSON.stringify(receipt,null,2)+'\n'));atomic(config.outputDir,'STATE.json',state);atomic(config.outputDir,'CURRENT.json',receipt);return receipt;
 }finally{lock.release();}
}
