/** Immutable revision -> actual history export reference, never data/weights.
 * Explicit existing private directory; no provider, DB, scheduler or retries.
 * Filesystem administrators are outside this integrity/coordination boundary.
 */
import {open,lstat,realpath,mkdir,readdir,link,unlink,rmdir} from 'node:fs/promises';
import {resolve,join,isAbsolute,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
export const REVISION_POINTER_CONTRACT='aegis.retained-history-revision-pointer.v1';
const REFERENCE_CONTRACT='aegis.history-source-export-reference.v1';
const LOCK_CONTRACT='aegis.retained-history-revision-lock.v1';
const MAX_POINTER_BYTES=8192,MAX_SOURCE_BYTES=64*1024*1024;
const HASH=/^[a-f0-9]{64}$/,NONCE=/^[a-f0-9-]{36}$/;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=reason=>{throw Error('retained_revision_store:'+reason);};
const keyOf=x=>{if(typeof x!=='string'||!HASH.test(x))fail('key_sha256');return x;};
const fileName=key=>key+'.history-revision.json';
function referenceOf(r){
 if(!exact(r,['contract','sha256','bytes'])||r.contract!==REFERENCE_CONTRACT||typeof r.sha256!=='string'||!HASH.test(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>MAX_SOURCE_BYTES)fail('source_reference');
 return{contract:REFERENCE_CONTRACT,sha256:r.sha256,bytes:r.bytes};
}
function bodyOf(key,built){
 if(!exact(built,['reference','sourceSnapshotHash'])||typeof built.sourceSnapshotHash!=='string'||!HASH.test(built.sourceSnapshotHash))fail('builder_reference_only');
 const reference=referenceOf(built.reference);
 if(reference.sha256!==built.sourceSnapshotHash)fail('reference_source_hash_mismatch');
 return{contract:REVISION_POINTER_CONTRACT,key,reference,sourceSnapshotHash:built.sourceSnapshotHash};
}
function pointerOf(key,built){const body=bodyOf(key,built);return{...body,contentHash:sha(JSON.stringify(body))};}
function verifyPointer(data,key){
 if(!exact(data,['contract','key','reference','sourceSnapshotHash','contentHash'])||data.contract!==REVISION_POINTER_CONTRACT||data.key!==key||typeof data.contentHash!=='string'||!HASH.test(data.contentHash))fail('pointer_contract_or_identity');
 const expected=pointerOf(key,{reference:data.reference,sourceSnapshotHash:data.sourceSnapshotHash});
 if(expected.contentHash!==data.contentHash)fail('pointer_content_hash');
 return expected;
}
const result=(p,created)=>({contract:REVISION_POINTER_CONTRACT,key:p.key,reference:{...p.reference},sourceSnapshotHash:p.sourceSnapshotHash,created});
async function readBounded(path,max){
 const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.size<1||before.size>max)fail('file_bound_or_link');
 const handle=await open(path,'r');
 try{const current=await handle.stat();if(!current.isFile()||current.size<1||current.size>max)fail('file_bound_or_link');const bytes=Buffer.alloc(max+1),read=await handle.read(bytes,0,max+1,0);if(read.bytesRead<1||read.bytesRead>max)fail('file_bound_or_link');const used=bytes.subarray(0,read.bytesRead),text=used.toString('utf8');if(!Buffer.from(text,'utf8').equals(used))fail('file_utf8');let data;try{data=JSON.parse(text);}catch{fail('file_json');}return data;}
 finally{await handle.close();}
}

/** The host creates/selects this private folder separately. No reference field
 * is a filename. Every ancestor/root is required to be a plain existing folder.
 * This is not isolation against a hostile filesystem administrator/TOCTOU writer.
 */
export async function createRetainedHistoryRevisionStore(directory,{shouldContinue=()=>true,signal=null,deadlineMs=15000,now=Date.now}={}){
 if(typeof directory!=='string'||!isAbsolute(directory)||directory.startsWith('\\\\')||typeof shouldContinue!=='function'||typeof now!=='function'||!Number.isSafeInteger(deadlineMs)||deadlineMs<5||deadlineMs>60000||signal!==null&&(typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'))fail('configuration');
 const root=resolve(directory),flights=new Map();
 const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
 async function assertRoot(){
  let path=root;
  for(;;){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())fail('plain_directory_required');const parent=dirname(path);if(parent===path)break;path=parent;}
  if(!same(await realpath(root),root))fail('plain_directory_required');
 }
 await assertRoot();
 function scope(){
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const started=performance.now(),wall=now();if(!Number.isSafeInteger(wall)||wall<0)fail('clock');
  const timer=setTimeout(()=>controller.abort(Error('retained_revision_store:deadline')),deadlineMs);
  const stopped=()=>{try{return signal?.aborted===true||shouldContinue()!==true;}catch{return true;}};
  const check=()=>{if(stopped())fail('manual_stop');if(controller.signal.aborted||performance.now()-started>=deadlineMs)fail('deadline');};
  let listener;
  const aborted=new Promise((_,reject)=>{listener=()=>reject(Error('retained_revision_store:'+(signal?.aborted?'manual_stop':'deadline')));if(combined.aborted)listener();else combined.addEventListener('abort',listener,{once:true});});
  return{signal:combined,deadlineAtMillis:wall+deadlineMs,remaining:()=>Math.max(0,deadlineMs-(performance.now()-started)),check,aborted,close(){clearTimeout(timer);combined.removeEventListener('abort',listener);}};
 }
 async function loadPointer(key,op){
  op.check();await assertRoot();let data;
  try{data=await readBounded(join(root,fileName(key)),MAX_POINTER_BYTES);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  op.check();return verifyPointer(data,key);
 }
 async function acquire(key,op){
  const lock=join(root,key+'.lock');
  for(;;){
   op.check();const existing=await loadPointer(key,op);if(existing)return{existing};
   await assertRoot();let owned=false;
   try{await mkdir(lock,{mode:0o700});owned=true;}catch(error){if(error.code!=='EEXIST')throw error;const s=await lstat(lock);if(!s.isDirectory()||s.isSymbolicLink())fail('lock_not_plain');}
   if(owned){
    const nonce=randomUUID(),owner={contract:LOCK_CONTRACT,key,nonce,pid:process.pid,createdAtMillis:now()},ownerPath=join(lock,'OWNER.json');
    let handle;
    try{handle=await open(ownerPath,'wx',0o600);await handle.writeFile(JSON.stringify(owner)+'\n');await handle.sync();}
    finally{if(handle)await handle.close();}
    // Failure to persist ownership leaves the lock for manual inspection. No
    // process may assume ownership from age, PID liveness or an empty directory.
    async function assertOwned(){
     const s=await lstat(lock);if(!s.isDirectory()||s.isSymbolicLink())fail('lock_ownership_changed');
     const got=await readBounded(ownerPath,2048);
     if(!exact(got,['contract','key','nonce','pid','createdAtMillis'])||got.contract!==LOCK_CONTRACT||got.key!==key||got.nonce!==nonce||!NONCE.test(got.nonce))fail('lock_ownership_changed');
    }
    return{assertOwned,async release(){await assertOwned();const names=await readdir(lock);if(names.length!==1||names[0]!=='OWNER.json')fail('lock_contents_changed');await unlink(ownerPath);await rmdir(lock);}};
   }
   try{await delay(Math.max(1,Math.min(25,Math.floor(op.remaining()))),undefined,{signal:op.signal});}catch{op.check();throw Error('retained_revision_store:lock_wait_aborted');}
  }
 }
 async function publish(key,pointer,lock,op){
  op.check();await assertRoot();await lock.assertOwned();
  const bytes=Buffer.from(JSON.stringify(pointer)+'\n');if(bytes.length>MAX_POINTER_BYTES)fail('pointer_bytes_bound');
  const temporary=join(root,'.'+key+'.'+randomUUID()+'.tmp'),destination=join(root,fileName(key));let handle,createdTemp=false;
  try{
   handle=await open(temporary,'wx',0o600);createdTemp=true;await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
   op.check();await assertRoot();await lock.assertOwned();
   try{await link(temporary,destination);return true;}
   catch(error){if(error.code!=='EEXIST')throw error;const existing=await loadPointer(key,op);if(existing.contentHash!==pointer.contentHash)fail('immutable_pointer_conflict');return false;}
  }finally{if(handle)await handle.close();if(createdTemp)await unlink(temporary);}
 }
 async function buildOrLoad(key,builder,op){
  const fast=await loadPointer(key,op);if(fast)return result(fast,false);
  const lock=await acquire(key,op);if(lock.existing)return result(lock.existing,false);
  try{
   // Check again after owning the lock; a former owner could publish between
   // our preceding read and lock acquisition.
   const existing=await loadPointer(key,op);if(existing)return result(existing,false);
   op.check();const built=await builder({keySha256:key,signal:op.signal,deadlineAtMillis:op.deadlineAtMillis,shouldContinue});
   const pointer=pointerOf(key,built);op.check();await lock.assertOwned();
   const created=await publish(key,pointer,lock,op);
   op.check();const saved=await loadPointer(key,op);if(!saved||saved.contentHash!==pointer.contentHash)fail('published_pointer_verification');return result(saved,created);
  }finally{await lock.release();}
 }
 return Object.freeze({
  async load(key){key=keyOf(key);const op=scope(),work=loadPointer(key,op).then(p=>p?result(p,false):null);work.then(()=>op.close(),()=>op.close());return Promise.race([work,op.aborted]);},
  getOrCreate(key,builder){
   key=keyOf(key);if(typeof builder!=='function')fail('builder_function');
   if(flights.has(key))return flights.get(key).exposed.then(structuredClone);
   const op=scope(),work=buildOrLoad(key,builder,op),exposed=Promise.race([work,op.aborted]);
   const record={work,exposed};flights.set(key,record);
   const finished=()=>{op.close();if(flights.get(key)===record)flights.delete(key);};work.then(finished,finished);
   // If a builder ignores abort, exposed can reject while work retains the
   // owned lock. It releases only on actual settlement and never publishes late.
   return exposed.then(structuredClone);
  }
 });
}
