/** Opt-in private file CAS, never a DB migration or running materializer.
 * Atomic immutable publication makes independent writers commute. Every read
 * verifies bytes and replays derivation from retained sources; no success cache.
 * This does not isolate a hostile filesystem administrator. */
import {open,lstat,realpath,link,unlink,readdir} from 'node:fs/promises';
import {isAbsolute,resolve,dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {deriveHistoricalFactVersion,verifyHistoricalFactVersion,RETAINED_FACT_MAX_BYTES,exportHistoricalFactsFromVersions} from './retainedOpenDotaFacts.mjs';
export const HISTORY_FACT_REFERENCE_CONTRACT='aegis.retained-history-fact-reference.v1';
const HASH=/^[a-f0-9]{64}$/,SUFFIX='.history-fact.json';
const fail=reason=>{throw Error('history_fact_store:'+reason);};
function reference(r){
 if(!r||r.contract!==HISTORY_FACT_REFERENCE_CONTRACT||Object.keys(r).sort().join(',')!=='bytes,contract,sha256'||!HASH.test(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>RETAINED_FACT_MAX_BYTES)fail('reference');
 return{contract:HISTORY_FACT_REFERENCE_CONTRACT,sha256:r.sha256,bytes:r.bytes};
}
export async function createAppendOnlyHistoryFactStore(directory,{shouldContinue=()=>true,signal=null,maxVersions=20000,maxTotalBytes=64*1024*1024}={}){
 if(typeof directory!=='string'||!isAbsolute(directory)||directory.startsWith('\\\\')||typeof shouldContinue!=='function'||!Number.isSafeInteger(maxVersions)||maxVersions<1||maxVersions>20000||!Number.isSafeInteger(maxTotalBytes)||maxTotalBytes<1||maxTotalBytes>64*1024*1024||signal!==null&&typeof signal.aborted!=='boolean')fail('configuration');
 const root=resolve(directory),same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
 const check=()=>{let active=false;try{active=shouldContinue()===true;}catch{}if(signal?.aborted||!active)fail('manual_stop');};
 async function assertRoot(){check();let path=root;for(;;){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())fail('plain_directory_required');const parent=dirname(path);if(path===parent)break;path=parent;}if(!same(await realpath(root),root))fail('plain_directory_required');check();}
 await assertRoot();
 async function load(ref){
  ref=reference(ref);await assertRoot();const filename=join(root,ref.sha256+SUFFIX),before=await lstat(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.size!==ref.bytes)fail('file_type_or_bound');
  const handle=await open(filename,'r');let body;
  try{const s=await handle.stat();if(!s.isFile()||s.size!==ref.bytes)fail('file_type_or_bound');const buffer=Buffer.alloc(ref.bytes+1),read=await handle.read(buffer,0,buffer.length,0);if(read.bytesRead!==ref.bytes)fail('file_bytes_bound');body=buffer.subarray(0,ref.bytes);}
  finally{await handle.close();}
  check();const utf8=body.toString('utf8');if(!Buffer.from(utf8).equals(body))fail('utf8');
  const checked=verifyHistoricalFactVersion({utf8,pin:{path:'retained-history/cas/'+ref.sha256+SUFFIX,sha256:ref.sha256,bytes:ref.bytes}});check();
  return{...checked,reference:ref};
 }
 async function append(sourceInputs){
  check();const checked=deriveHistoricalFactVersion(sourceInputs),ref=reference({contract:HISTORY_FACT_REFERENCE_CONTRACT,sha256:checked.versionSha256,bytes:checked.versionInput.pin.bytes});
  if(ref.bytes>maxTotalBytes)fail('append_bytes_bound');await assertRoot();
  const temporary=join(root,'.'+randomUUID()+'.pending'),destination=join(root,ref.sha256+SUFFIX);let handle,createdTemp=false,created=false;
  try{handle=await open(temporary,'wx',0o600);createdTemp=true;await handle.writeFile(checked.versionInput.utf8);await handle.sync();await handle.close();handle=null;await assertRoot();
   try{await link(temporary,destination);created=true;}catch(e){if(e.code!=='EEXIST')throw e;await load(ref);}
  }finally{if(handle)await handle.close();if(createdTemp)await unlink(temporary);}
  const saved=await load(ref);return{reference:saved.reference,versionSha256:saved.versionSha256,created,appendOnly:true,overwroteExisting:false};
 }
 async function references(){
  await assertRoot();const names=await readdir(root);check();const files=names.filter(n=>new RegExp('^[a-f0-9]{64}'+SUFFIX.replaceAll('.','\\.')+'$').test(n));
  // Ignore only our own interrupted publication names. Unknown files are not a
  // silently accepted population, and no stale/pending file is promoted.
  if(names.some(n=>!files.includes(n)&&!/^\.[a-f0-9-]{36}\.pending$/.test(n)))fail('unexpected_directory_entry');
  if(files.length>maxVersions)fail('version_count_bound');const refs=[];let total=0;
  for(const name of files.sort()){check();const info=await lstat(join(root,name));if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>RETAINED_FACT_MAX_BYTES||(total+=info.size)>maxTotalBytes)fail('population_bytes_bound');refs.push(reference({contract:HISTORY_FACT_REFERENCE_CONTRACT,sha256:name.slice(0,64),bytes:info.size}));}
  return refs;
 }
 async function exportAsOf(options={}){const refs=await references(),versionInputs=[];for(const ref of refs){const v=await load(ref);versionInputs.push(v.versionInput);}check();const exported=exportHistoricalFactsFromVersions({...options,versionInputs});check();return exported;}
 return Object.freeze({append,load,references,exportAsOf});
}
