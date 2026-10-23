'use strict';
// Stage only. Explicit root-created session; no automatic creation or reset.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MiB=1024**2,GiB=1024**3;
const LIMITS=Object.freeze({durationMs:7200000,maxDispatches:128,maxReservedBytes:2*GiB,
 maxResponseBytes:16*MiB,maxRequestBytes:16*MiB,minFreeDiskBytes:20*GiB,maxIngressBytes:128*MiB,maxIngressBatches:1024});
const CLOSED=new Set(['session_expired','dispatch_cap','byte_cap','ingress_cap','disk_floor','disk_probe_failed','clock_regressed','root_stopped']);
function stable(value){
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
const hash=value=>crypto.createHash('sha256').update(stable(value)).digest('hex');
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function checked(file){
 if(!path.isAbsolute(file))throw Error('session_absolute_path');
 let p=path.resolve(file);
 for(;;){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('session_reparse_path');
  const parent=path.dirname(p);if(parent===p)break;p=parent;}
 return path.resolve(file);
}
function specValid(s){
 if(!s||s.version!==1||! /^[a-f0-9]{32}$/.test(s.sessionId)||! /^[a-f0-9]{64}$/.test(s.candidateManifestSha256)
  ||!integer(s.startsAtMs)||!integer(s.expiresAtMs)||s.expiresAtMs-s.startsAtMs!==LIMITS.durationMs
  ||s.maxDispatches!==LIMITS.maxDispatches||s.maxReservedBytes!==LIMITS.maxReservedBytes
  ||s.maxResponseBytes!==LIMITS.maxResponseBytes||s.minFreeDiskBytes!==LIMITS.minFreeDiskBytes
  ||Object.keys(s).sort().join(',')!==['version','sessionId','candidateManifestSha256','startsAtMs','expiresAtMs','maxDispatches','maxReservedBytes','maxResponseBytes','minFreeDiskBytes'].sort().join(','))throw Error('session_spec');
}
function verifyState(s,pin){
 specValid(s.spec);
 if(s.contract!=='aegis.wide.bounded-session.v2'||hash(s.spec)!==pin||s.specSha256!==pin
  ||!integer(s.lastObservedAtMs)||s.lastObservedAtMs<s.spec.startsAtMs||!Array.isArray(s.reservations)
  ||s.reservations.length>LIMITS.maxDispatches)throw Error('session_binding');
 const seen=new Set();let total=0;
 for(const r of s.reservations){
  if(! /^[a-f0-9]{64}$/.test(r.attemptId)||! /^[a-f0-9]{64}$/.test(r.requestSha256)||seen.has(r.attemptId)
   ||!integer(r.requestBytes)||r.requestBytes>LIMITS.maxRequestBytes
   ||r.reservedBytes!==r.requestBytes+LIMITS.maxResponseBytes||!integer(r.atMs)
   ||r.atMs<s.spec.startsAtMs||r.atMs>=s.spec.expiresAtMs||r.atMs>s.lastObservedAtMs)throw Error('session_reservation');
  seen.add(r.attemptId);total+=r.reservedBytes;
 }
 if(s.dispatches!==s.reservations.length||s.reservedBytes!==total||total>LIMITS.maxReservedBytes)throw Error('session_counters');
 if(!Array.isArray(s.ingress)||s.ingress.length>LIMITS.maxIngressBatches)throw Error('session_ingress');
 const batches=new Set();let ingressTotal=0;
 for(const r of s.ingress){if(!/^[a-f0-9]{64}$/.test(r.batchId)||batches.has(r.batchId)||!integer(r.bytes)
  ||r.bytes>LIMITS.maxRequestBytes||!integer(r.atMs)||r.atMs<s.spec.startsAtMs||r.atMs>=s.spec.expiresAtMs
  ||r.atMs>s.lastObservedAtMs)throw Error('session_ingress');batches.add(r.batchId);ingressTotal+=r.bytes;}
 if(s.ingressBytes!==ingressTotal||ingressTotal>LIMITS.maxIngressBytes)throw Error('session_ingress');
 if(s.closure!==null&&(!CLOSED.has(s.closure?.reason)||!integer(s.closure.atMs)||s.closure.atMs>s.lastObservedAtMs))throw Error('session_closure');
 return s;
}
function readState(file,pin){
 file=checked(file);if(!fs.lstatSync(file).isFile()||fs.statSync(file).size>300000)throw Error('session_file');
 return verifyState(JSON.parse(fs.readFileSync(file,'utf8')),pin);
}
function createExplicitSession(file,spec){
 checked(file);specValid(spec);const state={contract:'aegis.wide.bounded-session.v2',spec,specSha256:hash(spec),
  lastObservedAtMs:spec.startsAtMs,dispatches:0,reservedBytes:0,reservations:[],ingress:[],ingressBytes:0,closure:null};
 const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return state.specSha256;
}
function locked(file,operation){
 checked(file);const lock=checked(file+'.lock'),owner=JSON.stringify({pid:process.pid,nonce:crypto.randomUUID()});
 let fd;try{fd=fs.openSync(lock,'wx');}catch(e){if(e.code==='EEXIST')return {allowed:false,reason:'session_busy_or_recovery_required'};throw e;}
 try{fs.writeFileSync(fd,owner);fs.fsyncSync(fd);return operation();}
 finally{fs.closeSync(fd);if(fs.existsSync(lock)&&fs.readFileSync(lock,'utf8')===owner)fs.unlinkSync(lock);}
}
function persist(file,state){
 const temporary=checked(file+'.'+crypto.randomUUID()+'.tmp'),fd=fs.openSync(temporary,'wx');
 try{fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(temporary,file); // failure is closed; no request may follow it
}
function close(state,reason,now){state.closure??={reason,atMs:Math.max(now,state.lastObservedAtMs)};return {allowed:false,reason:state.closure.reason};}
function timeGate(state,now){
 if(!integer(now))throw Error('session_clock');
 if(state.closure)return {allowed:false,reason:state.closure.reason};
 if(now<state.lastObservedAtMs)return close(state,'clock_regressed',now);
 state.lastObservedAtMs=now;
 if(now>=state.spec.expiresAtMs)return close(state,'session_expired',now);
 return null;
}
const defaultFree=file=>()=>{const stat=fs.statfsSync(path.dirname(file));return Number(stat.bavail)*Number(stat.bsize);};
function diskGate(s,charge,now,freeBytes){
 let free;try{free=freeBytes();}catch{return close(s,'disk_probe_failed',now);}
 return !integer(free)||free<LIMITS.minFreeDiskBytes+charge?close(s,'disk_floor',now):null;
}
function checkWindow(file,pin,now=Date.now(),freeBytes=defaultFree(file)){
 return locked(file,()=>{const s=readState(file,pin);const gate=timeGate(s,now)||diskGate(s,0,now,freeBytes);persist(file,s);
  return gate??{allowed:true,expiresAtMs:s.spec.expiresAtMs,dispatches:s.dispatches,reservedBytes:s.reservedBytes};});
}
function admitIngress(file,pin,batchId,bytes,{now=Date.now(),freeBytes=defaultFree(file)}={}){
 return locked(file,()=>{const s=readState(file,pin);let refusal=timeGate(s,now);
  if(!refusal){if(!/^[a-f0-9]{64}$/.test(batchId)||!integer(bytes)||bytes>LIMITS.maxRequestBytes)throw Error('session_ingress');
   if(s.ingress.some(r=>r.batchId===batchId)){persist(file,s);return {allowed:false,reason:'session_duplicate_ingress'};}
   if(s.ingress.length>=LIMITS.maxIngressBatches||s.ingressBytes+bytes>LIMITS.maxIngressBytes)refusal=close(s,'ingress_cap',now);
   else refusal=diskGate(s,bytes,now,freeBytes);
   if(!refusal){s.ingress.push({batchId,bytes,atMs:now});s.ingressBytes+=bytes;}}
  persist(file,s);return refusal??{allowed:true};});
}
function reserve(file,pin,request,{now=Date.now(),freeBytes=defaultFree(file)}={}){
 return locked(file,()=>{
  const s=readState(file,pin);let refusal=timeGate(s,now);
  if(!refusal){
   if(!request||! /^[a-f0-9]{64}$/.test(request.attemptId)||! /^[a-f0-9]{64}$/.test(request.requestSha256)
    ||!integer(request.requestBytes)||request.requestBytes>LIMITS.maxRequestBytes)throw Error('session_request');
   const prior=s.reservations.find(r=>r.attemptId===request.attemptId);
   if(prior){persist(file,s);return {allowed:false,reason:'session_duplicate_dispatch'};}
   const charge=request.requestBytes+LIMITS.maxResponseBytes;
   if(s.dispatches>=LIMITS.maxDispatches)refusal=close(s,'dispatch_cap',now);
   else if(s.reservedBytes+charge>LIMITS.maxReservedBytes)refusal=close(s,'byte_cap',now);
   else{
    refusal=diskGate(s,charge,now,freeBytes);
    if(!refusal){s.reservations.push({...request,atMs:now,reservedBytes:charge});s.dispatches++;s.reservedBytes+=charge;}
   }
  }
  persist(file,s);
  return refusal??{allowed:true,reservedBytes:s.reservedBytes,dispatches:s.dispatches,
   remainingMs:s.spec.expiresAtMs-now,maximumResponseBytes:LIMITS.maxResponseBytes};
 });
}
// No refund: unknown request outcome and crash consume the full reservation.
module.exports={LIMITS,hash,readState,createExplicitSession,checkWindow,admitIngress,reserve};
