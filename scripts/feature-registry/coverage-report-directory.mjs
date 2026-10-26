/** Separate bounded technical-report root. Immutable wx files, no overwrite,
 * no report deletion, no journal-root limit change or native lease claim. */
import {lstat,mkdir,opendir,open,unlink} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join,parse,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createDiagnosticResourceArena,snapshotPlainRecord} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
const MiB=1024**2,MAX_TOTAL=128*MiB,MAX_OBJECT=16*MiB,MAX_FILES=25000,LOCK='.coverage-writer.lock',fail=x=>{throw Error('coverage_directory:'+x);},sha=x=>createHash('sha256').update(x).digest('hex');
const kinds=new Set(['feature-data-coverage-page-gzip-v1','feature-data-coverage-index-v1','feature-data-coverage-collection-index-v1']);
function pin(value){const r=snapshotPlainRecord(value,{maxKeys:3});if(Object.keys(r).sort().join(',')!=='bytes,kind,sha256'||!kinds.has(r.kind)||!/^[a-f0-9]{64}$/.test(r.sha256??'')||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>MAX_OBJECT)fail('pin');return r;}
function label(value){if(typeof value!=='string'||!/^[A-Z_]+--[A-Za-z_]+--[a-f0-9]{16}$/.test(value)||value.length>80)fail('file_label');return value;}
function filename(ref,fileLabel){return ref.kind==='feature-data-coverage-page-gzip-v1'?ref.sha256+'.coverage.json.gz':ref.kind==='feature-data-coverage-collection-index-v1'?'FEATURE-DATA-COVERAGE-'+ref.sha256+'.json':label(fileLabel)+'-FEATURE-DATA-COVERAGE-'+ref.sha256+'.json';}
function identity(name){let m=/^([a-f0-9]{64})\.coverage\.json\.gz$/.exec(name);if(m)return{kind:'feature-data-coverage-page-gzip-v1',sha256:m[1]};m=/^FEATURE-DATA-COVERAGE-([a-f0-9]{64})\.json$/.exec(name);if(m)return{kind:'feature-data-coverage-collection-index-v1',sha256:m[1]};m=/^([A-Z_]+--[A-Za-z_]+--[a-f0-9]{16})-FEATURE-DATA-COVERAGE-([a-f0-9]{64})\.json$/.exec(name);if(m){label(m[1]);return{kind:'feature-data-coverage-index-v1',sha256:m[2]};}fail('unknown_file');}
async function regular(path){const s=await lstat(path);if(s.isSymbolicLink()||!s.isFile()||s.size>MAX_OBJECT)fail('regular_file_required');return s;}
async function plainAncestors(path){const absolute=resolve(path),root=parse(absolute).root;let current=root;for(const part of absolute.slice(root.length).split(sep).filter(Boolean)){current=join(current,part);const s=await lstat(current);if(s.isSymbolicLink()||!s.isDirectory())fail('plain_directory_required');}}
export async function createCoverageReportDirectory({directory,scopeRoot,resourceArena=null,shouldContinue=()=>true,maxStoredBytes=MAX_TOTAL,maxWallMs=1200000}={}){
 if(typeof directory!=='string'||typeof scopeRoot!=='string'||!isAbsolute(directory)||!isAbsolute(scopeRoot)||directory.startsWith('\\\\')||scopeRoot.startsWith('\\\\')||typeof shouldContinue!=='function'||!Number.isSafeInteger(maxStoredBytes)||maxStoredBytes<1024||maxStoredBytes>MAX_TOTAL||!Number.isInteger(maxWallMs)||maxWallMs<1||maxWallMs>1200000)fail('configuration');
 const root=resolve(scopeRoot),destination=resolve(directory),part=relative(root,destination);if(!part||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))fail('outside_scope');
 const arena=resourceArena??createDiagnosticResourceArena(),ownershipBytes=32*MiB,ownership=arena.reserve(ownershipBytes);if(!ownership)fail('memory_admission');const start=performance.now(),files=new Map();let lock=null,ownershipLost=false,closed=false,closing=false,busy=false,pending=null,storedBytes=0,lockBytes=0,readbacks=0,writes=0;
 const proceed=()=>{if(ownershipLost)fail('owned_lock_lost');if(closed||closing||shouldContinue()!==true)fail('stopped_or_closed');if(performance.now()-start>maxWallMs)fail('wall_bound');};
 const sameStat=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size;
 let lockToken=null,lockPath=join(destination,LOCK),lockIdentity=null;
 async function assertOwnedLock(){
  if(ownershipLost||!lock||!lockIdentity||lockToken===null)fail('owned_lock_lost');let reader=null;
  try{const before=await regular(lockPath);if(!sameStat(before,lockIdentity))fail('owned_lock_changed');reader=await open(lockPath,'r');const opened=await reader.stat();if(!opened.isFile()||!sameStat(opened,lockIdentity))fail('owned_lock_changed');const raw=Buffer.alloc(lockIdentity.size+1);let offset=0;while(offset<raw.length){const r=await reader.read(raw,offset,raw.length-offset,offset);if(!r.bytesRead)break;offset+=r.bytesRead;}const after=await regular(lockPath);if(offset!==lockIdentity.size||raw.subarray(0,offset).toString('utf8')!==lockToken||!sameStat(after,lockIdentity)||!sameStat(await lock.stat(),lockIdentity))fail('owned_lock_changed');}
  catch{ownershipLost=true;fail('owned_lock_lost');}finally{await reader?.close();}
 }
 async function releaseLock(){if(!lock)return;try{await assertOwnedLock();const final=await regular(lockPath);if(!sameStat(final,lockIdentity)){ownershipLost=true;fail('owned_lock_changed');}await unlink(lockPath);storedBytes-=lockBytes;lockBytes=0;}finally{await lock.close();lock=null;}}
 try{
  proceed();await plainAncestors(root);let current=root;
  for(const entry of part.split(sep)){current=join(current,entry);try{await mkdir(current);}catch(e){if(e.code!=='EEXIST')throw e;}const s=await lstat(current);if(s.isSymbolicLink()||!s.isDirectory())fail('plain_directory_required');}
  proceed();try{lock=await open(lockPath,'wx');}catch(e){if(e.code==='EEXIST')fail('foreign_lock');throw e;}
  lockToken=JSON.stringify({contract:'aegis.coverage-report-writer-lock.v1',owner:randomUUID()});await lock.writeFile(lockToken,'utf8');await lock.sync();lockIdentity=await lock.stat();lockBytes=lockIdentity.size;storedBytes=lockBytes;
  const entries=await opendir(destination);for await(const entry of entries){proceed();if(entry.name===LOCK)continue;if(files.size>=MAX_FILES)fail('file_count');const id=identity(entry.name),s=await regular(join(destination,entry.name)),key=id.kind+':'+id.sha256;if(files.has(key))fail('duplicate_artifact_identity');storedBytes+=s.size;if(storedBytes>maxStoredBytes)fail('stored_byte_limit');files.set(key,{...id,bytes:s.size,name:entry.name});}
  await assertOwnedLock();proceed();
 }catch(error){try{await releaseLock();}finally{ownership.release();}throw error;}
 function operation(fn){if(busy)return Promise.reject(Error('coverage_directory:busy'));try{proceed();}catch(e){return Promise.reject(e);}busy=true;pending=(async()=>{try{await assertOwnedLock();const result=await fn();proceed();await assertOwnedLock();return result;}finally{busy=false;pending=null;}})();return pending;}
 async function load(ref){
  proceed();const row=files.get(ref.kind+':'+ref.sha256);if(!row||row.bytes!==ref.bytes)fail('unknown_reference');const work=arena.reserve(ref.bytes*2+65536);if(!work)fail('read_memory_admission');let handle=null;
  try{await plainAncestors(destination);await assertOwnedLock();const path=join(destination,row.name),before=await regular(path);if(before.size!==ref.bytes)fail('file_integrity');handle=await open(path,'r');const opened=await handle.stat();if(!opened.isFile()||!sameStat(before,opened))fail('file_changed');const bytes=Buffer.alloc(ref.bytes);let at=0;while(at<bytes.length){proceed();const r=await handle.read(bytes,at,bytes.length-at,at);if(!r.bytesRead)fail('file_integrity');at+=r.bytesRead;}const extra=await handle.read(Buffer.alloc(1),0,1,ref.bytes);proceed();const after=await regular(path);if(extra.bytesRead!==0||!sameStat(before,after)||sha(bytes)!==ref.sha256)fail('file_integrity');await assertOwnedLock();readbacks++;return bytes;}finally{await handle?.close();work.release();}
 }
 return Object.freeze({
  directory:destination,scopeRoot:root,contract:'aegis.coverage-report-directory.v1',
  writePinned({reference,bytes,fileLabel}){return operation(async()=>{
   const ref=pin(reference);if(!Buffer.isBuffer(bytes)||bytes.length!==ref.bytes)fail('input_bytes');const work=arena.reserve(ref.bytes*2+65536);if(!work)fail('write_memory_admission');try{const ownedBytes=Buffer.from(bytes);if(sha(ownedBytes)!==ref.sha256)fail('input_bytes');const name=filename(ref,fileLabel),key=ref.kind+':'+ref.sha256,existing=files.get(key);if(existing){if(existing.name!==name)fail('artifact_name_changed');await load(ref);return Object.freeze(ref);}
   if(files.size>=MAX_FILES||storedBytes+ref.bytes>maxStoredBytes)fail('stored_byte_limit');await plainAncestors(destination);proceed();await assertOwnedLock();const path=join(destination,name);let handle=null,creationError=null;
   try{handle=await open(path,'wx');await assertOwnedLock();await handle.writeFile(ownedBytes);await handle.sync();proceed();await assertOwnedLock();writes++;}
   catch(error){creationError=error;throw error;}
   finally{if(handle){try{const s=await handle.stat();if(!s.isFile()||s.size>ref.bytes)fail('created_file_changed');storedBytes+=s.size;files.set(key,{...ref,bytes:s.size,name});}finally{await handle.close();}}else if(!creationError)fail('file_create_failed');}
   return Object.freeze(ref);
   }finally{work.release();}
  });},
  readPinned(reference){return operation(()=>load(pin(reference)));},
  status(){return{contract:'aegis.coverage-report-directory.v1',directory:destination,retainedEncodedFileBytes:storedBytes,budgetScope:'encoded_regular_file_bytes_including_lock',filesystemAllocatedBytesMeasured:false,filesystemOverhead:'not_measured',lockBytes,artifactFiles:files.size,maxStoredBytes,maximumFiles:MAX_FILES,ownershipBytes:closed?0:ownershipBytes,ownedArenaLeases:closed?0:1,ownershipLost,atomicNativeLeaseGuarantee:false,readbacks,writes,closed,busy,sharedWithJournalRoot:false,sourceAuthority:false,durableStorageAttested:false};},
  async close(){if(closed)return false;if(closing){if(pending)await pending.catch(()=>{});return false;}closing=true;if(pending)await pending.catch(()=>{});try{await releaseLock();}finally{closed=true;files.clear();ownership.release();}return true;}
 });
}
