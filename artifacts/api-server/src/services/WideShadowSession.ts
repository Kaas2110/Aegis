import {isAbsolute} from 'node:path';
import * as ledger from './wideSessionGuard.cjs';
import {WIDE_PINS as P} from './WideShadowPins';

export type SessionPermit={expiresAtMs:number;sessionId:string;specSha256:string};
export interface WideSession {
 check(receivedAt?:Date):SessionPermit;
 reserve(attemptId:string,bodySha256:string,bytes:number):SessionPermit;
 admit(batchId:string,bytes:number):void;
 admitted(batchId:string,bytes:number):void;
 status():Record<string,unknown>;
}
export const SESSION_REASONS=new Set(['wide_session_disabled','wide_session_config','wide_session_binding',
 'wide_session_unavailable','wide_session_receipt_outside_window','wide_session_expired','wide_session_busy_or_recovery_required',
 'wide_session_dispatch_cap','wide_session_byte_cap','wide_session_ingress_cap','wide_session_disk_floor',
 'wide_session_disk_probe_failed','wide_session_clock_regressed','wide_session_root_stopped',
 'wide_session_duplicate_dispatch','wide_session_duplicate_ingress','wide_session_unadmitted_batch']);
const fail=(reason:string):never=>{throw Error(SESSION_REASONS.has(reason)?reason:'wide_session_unavailable');};

/** No initializer, provider, DB, model or timer. Root creates a ledger explicitly. */
export function createWideSession(options:{env?:NodeJS.ProcessEnv;clock?:()=>Date;freeBytes?:()=>number}={}):WideSession {
 const env=options.env??process.env,clock=options.clock??(()=>new Date());
 let binding:{file:string;pin:string}|null=null;
 const config=()=>{
  if(env.AEGIS_WIDE_SHADOW_ENABLED!=='1')return fail('wide_session_disabled');
  const file=env.AEGIS_WIDE_SHADOW_SESSION_PATH,pin=env.AEGIS_WIDE_SHADOW_SESSION_SHA256;
  if(!file||!isAbsolute(file)||!pin||!/^[a-f0-9]{64}$/.test(pin))return fail('wide_session_config');
  if(binding&&(binding.file!==file||binding.pin!==pin))return fail('wide_session_binding');
  return binding??(binding={file,pin});
 };
 const read=()=>{const c=config(),s=ledger.readState(c.file,c.pin);
  if(s.spec.candidateManifestSha256!==P.candidateManifestSha256)return fail('wide_session_binding');return {c,s};};
 const safe=<T>(action:()=>T):T=>{try{return action();}catch(e){return fail(e instanceof Error?e.message:'');}};
 const permit=(s:ledger.State):SessionPermit=>({expiresAtMs:s.spec.expiresAtMs,sessionId:s.spec.sessionId,specSha256:s.specSha256});
 const allowed=(d:ledger.Decision)=>{if(!d.allowed)fail(d.reason?.startsWith('session_')?'wide_'+d.reason:'wide_session_'+d.reason);};
 const check=(receivedAt?:Date)=>safe(()=>{const {c,s}=read();
  allowed(ledger.checkWindow(c.file,c.pin,clock().getTime(),options.freeBytes));
  if(receivedAt&&(!Number.isFinite(receivedAt.getTime())||receivedAt.getTime()<s.spec.startsAtMs
   ||receivedAt.getTime()>=s.spec.expiresAtMs||receivedAt>clock()))fail('wide_session_receipt_outside_window');
  return permit(s);});
 return {check,
  reserve:(attemptId,requestSha256,requestBytes)=>safe(()=>{const {c,s}=read();
   allowed(ledger.reserve(c.file,c.pin,{attemptId,requestSha256,requestBytes},{now:clock().getTime(),freeBytes:options.freeBytes}));return permit(s);}),
  admit:(batchId,bytes)=>safe(()=>{const {c}=read();allowed(ledger.admitIngress(c.file,c.pin,batchId,bytes,
   {now:clock().getTime(),freeBytes:options.freeBytes}));}),
  // Used ONLY to finish previously admitted durable batches after expiry/restart.
  admitted:(batchId,bytes)=>safe(()=>{const {s}=read();if(!s.ingress.some(r=>r.batchId===batchId&&r.bytes===bytes))fail('wide_session_unadmitted_batch');}),
  status:()=>{try{if(env.AEGIS_WIDE_SHADOW_ENABLED!=='1')return {status:'disabled'};
   // Read-only status: expiry is effective even before next admission persists closure.
   const {s}=read(),now=clock().getTime(),closure=s.closure??(now>=s.spec.expiresAtMs?
    {reason:'session_expired',atMs:s.spec.expiresAtMs}:null);
   return {status:closure?'closed':'open',sessionId:s.spec.sessionId,specSha256:s.specSha256,
    plannedStart:new Date(s.spec.startsAtMs).toISOString(),plannedEnd:new Date(s.spec.expiresAtMs).toISOString(),
    closure,closureDurable:s.closure!==null,dispatches:s.dispatches,reservedBytes:s.reservedBytes,
    ingressBatches:s.ingress.length,ingressBytes:s.ingressBytes,limits:ledger.LIMITS,
    denominatorPolicy:'planned_window_with_explicit_scope_exclusion_no_success_renormalization_v1',
    coverage95Validated:false,physicalDatabaseBytesCapped:false};
   }catch{return {status:'unavailable',reason:'wide_session_unavailable',coverage95Validated:false};}}
 };
}
export const wideSession=createWideSession();
