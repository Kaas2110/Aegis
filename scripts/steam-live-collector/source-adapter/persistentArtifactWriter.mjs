/** Bounded single-writer immutable artifact store. Source-only diagnostic port:
 * no services, providers, activation or implicit lease acquisition at import.
 * File bytes + future reservation bytes share one cumulative root budget.
 * Commit markers are published last; uncommitted objects are never readable.
 * A crash may require an exact-input retry, but cannot expose a partial object.
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {acquireArtifactWriterLease,assertArtifactWriterLease,releaseArtifactWriterLease} from './artifactWriterLease.mjs';

export const PERSISTENT_ARTIFACT_WRITER_CONTRACT='aegis.persistent-artifact-writer.v1';
export const PERSISTENT_ARTIFACT_DEFAULT_LIMITS=Object.freeze({maxStoredBytes:256*1024*1024,maxObjectBytes:16*1024*1024,maxArtifacts:10000,maxReservations:10000,maxJournalBytes:16*1024*1024,maxPendingOperations:8,maxPendingBytes:32*1024*1024});
const ROOT='ROOT.json',JOURNAL='ledger.jsonl',LEASE='.artifact-writer-lease',ACK_RESERVE=2048;
const hash=x=>createHash('sha256').update(x).digest('hex');
const hashOk=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const kindOk=x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(x);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const fail=x=>{throw Error('persistent_artifact_writer:'+x);};
const key=x=>`${x.kind}--${x.sha256}`;
const reference=x=>Object.freeze({kind:x.kind,sha256:x.sha256,bytes:x.bytes});
const bytes=x=>Buffer.byteLength(x,'utf8');
function checkReference(r,limits){if(!exact(r,['kind','sha256','bytes'])||!kindOk(r.kind)||!hashOk(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<0||r.bytes>limits.maxObjectBytes)fail('reference');}
function parse(text,label){try{return JSON.parse(text);}catch{fail(label+'_json');}}
function limitConfig(value){
 if(!object(value)||Object.keys(value).some(k=>!Object.hasOwn(PERSISTENT_ARTIFACT_DEFAULT_LIMITS,k)))fail('limits');
 const out={...PERSISTENT_ARTIFACT_DEFAULT_LIMITS,...value};
 for(const [k,v]of Object.entries(out))if(!Number.isSafeInteger(v)||v<1||v>PERSISTENT_ARTIFACT_DEFAULT_LIMITS[k])fail('limit_'+k);
 return Object.freeze(out);
}
async function optionalStat(file){try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function listNames(directory,maximum){const names=[];for await(const entry of await fs.opendir(directory)){if(names.length>=maximum)fail('directory_count');names.push(entry.name);}return names;}
async function checkRoot(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory))fail('absolute_directory');
 const resolved=path.resolve(directory);let cursor=resolved;
 while(true){const s=await fs.lstat(cursor);if(s.isSymbolicLink()||!s.isDirectory())fail('directory_ancestry');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
 return resolved;
}
async function syncDir(directory){
 let h;try{h=await fs.open(directory,'r');await h.sync();}catch(e){
  // Windows does not expose a portable directory fsync. Files and ledger are
  // flushed; recovery rejects missing directory entries rather than inventing
  // a durable commit. POSIX directory flush errors are never suppressed.
  if(process.platform!=='win32'||!['EACCES','EPERM','EINVAL','EBADF','EISDIR'].includes(e.code))throw e;
 }finally{await h?.close();}
}
async function writeNew(file,content){const h=await fs.open(file,'wx');try{await h.writeFile(content,'utf8');await h.sync();}finally{await h.close();}}
async function readBounded(file,maximum){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maximum)fail('bounded_regular_file');const buffer=await fs.readFile(file);if(buffer.length!==stat.size||buffer.length>maximum)fail('file_changed');const text=buffer.toString('utf8');if(!buffer.equals(Buffer.from(text,'utf8')))fail('non_utf8');return text;}

export async function createPersistentArtifactWriter({directory,leaseProvider,shouldContinue=()=>true,limits={}}={}){
 const cfg=limitConfig(limits),root=await checkRoot(directory);
 if(typeof shouldContinue!=='function')fail('continue_port');
 const lease=await acquireArtifactWriterLease(leaseProvider,root);
 let closed=false,closing=false,poisoned=false,queue=Promise.resolve(),generation,epoch=null,seq=0,head='0'.repeat(64),journalBytes=0,pendingOperations=0,pendingBytes=0;
 const reservations=new Map(),byKey=new Map(),epochs=new Map(),committed=new Map(),verifiedObjects=new Map();
 const filename=relative=>path.join(root,...relative.split('/'));
 const objectPath=r=>`objects/${r.sha256}.blob`,markerPath=r=>`commits/${key(r)}.json`;
 const tempPath=r=>`temporary/${r.id}.blob.tmp`,markerTempPath=r=>`temporary/${r.id}.marker.tmp`;
 async function held(){if(closed)fail('closed');if(poisoned)fail('recovery_required');await assertArtifactWriterLease(lease,root);if(await shouldContinue()!==true)fail('stopped');}
 function markerFor(r,commitEpoch){return {contract:'aegis.immutable-artifact-commit.v1',generation,reservationId:r.id,reservedEpoch:r.reservedEpoch,commitEpoch,reference:reference(r)};}
 function futureAllowance(files){let total=0;for(const r of reservations.values())if(!r.ack){
  const planned=[[tempPath(r),r.bytes],[markerTempPath(r),r.markerBytes],[markerPath(r),r.markerBytes]];
  if(r.objectNew)planned.push([objectPath(r),r.bytes]);
  for(const [p,n]of planned)total+=Math.max(0,n-(files.get(p)||0));
  total+=ACK_RESERVE;
 }return total;}
 async function inventory(){
  const files=new Map(),entries=await listNames(root,6);
  const allowedRoot=new Set([ROOT,JOURNAL,LEASE,'objects','commits','temporary']);
  for(const name of entries){if(!allowedRoot.has(name))fail('unknown_root_entry');const stat=await fs.lstat(filename(name));if(stat.isSymbolicLink())fail('artifact_file_type');
   if(['objects','commits','temporary'].includes(name)){
    if(!stat.isDirectory())fail('artifact_directory');
    const names=await listNames(filename(name),cfg.maxArtifacts*2+cfg.maxReservations*2);
    for(const n of names){const p=name+'/'+n,s=await fs.lstat(filename(p));if(!s.isFile()||s.isSymbolicLink())fail('artifact_file_type');files.set(p,s.size);}
   }else{if(!stat.isFile()||(name===LEASE&&stat.size>1))fail('root_file_type');files.set(name,stat.size);}
  }
  const known=new Set([ROOT,JOURNAL,LEASE]);for(const r of reservations.values()){known.add(objectPath(r));known.add(markerPath(r));known.add(tempPath(r));known.add(markerTempPath(r));}
  for(const p of files.keys())if(!known.has(p))fail('unreserved_file');
  const physicalBytes=[...files.values()].reduce((a,b)=>a+b,0),reservedBytes=futureAllowance(files);
  if(physicalBytes+reservedBytes>cfg.maxStoredBytes)fail('stored_byte_limit');
  return {files,physicalBytes,reservedBytes};
 }
 async function room(extra=0){const state=await inventory();if(state.physicalBytes+state.reservedBytes+extra>cfg.maxStoredBytes)fail('stored_byte_limit');return state;}
 function encode(type,data){const base={seq:seq+1,previous:head,generation,epoch,type,data};return JSON.stringify({...base,sha256:hash(JSON.stringify(base))})+'\n';}
 async function append(type,data,{reservedAck=false,extraJournalReservation=0}={}){
  await held();const line=encode(type,data),n=bytes(line);if(n>ACK_RESERVE)fail('journal_record_limit');
  const outstanding=[...reservations.values()].reduce((sum,r)=>sum+(r.ack?0:ACK_RESERVE),0)-(reservedAck?ACK_RESERVE:0);
  if(journalBytes+n+outstanding+extraJournalReservation>cfg.maxJournalBytes)fail('journal_limit');
  await room(reservedAck?Math.max(0,n-ACK_RESERVE):n);
  const handle=await fs.open(filename(JOURNAL),'a');try{await handle.writeFile(line,'utf8');await handle.sync();}catch(e){poisoned=true;throw e;}finally{await handle.close();}
  seq++;head=parse(line,'journal').sha256;journalBytes+=n;return seq;
 }
 function installReserve(data,reservedEpoch){
  if(!exact(data,['id','kind','sha256','bytes','objectNew','markerBytes'])||!uuid(data.id)||typeof data.objectNew!=='boolean'||!Number.isSafeInteger(data.markerBytes)||data.markerBytes<1||data.markerBytes>2048)fail('reserve_record');
  checkReference(reference(data),cfg);if(reservations.has(data.id)||byKey.has(key(data))||reservations.size>=cfg.maxReservations||byKey.size>=cfg.maxArtifacts)fail('reservation_count_or_identity');
  const r={...data,reservedEpoch,ack:false,markerHash:null,commitSequence:null};reservations.set(r.id,r);byKey.set(key(r),r);return r;
 }
 async function verifyObject(r,{cache=false}={}){
  const old=verifiedObjects.get(r.sha256);if(cache&&old===r.bytes)return;
  const text=await readBounded(filename(objectPath(r)),cfg.maxObjectBytes);if(bytes(text)!==r.bytes||hash(text)!==r.sha256)fail('object_integrity');
  verifiedObjects.set(r.sha256,r.bytes);return text;
 }
 function validateMarkerText(r,text){
  const m=parse(text,'marker');
  if(!exact(m,['contract','generation','reservationId','reservedEpoch','commitEpoch','reference'])||m.contract!=='aegis.immutable-artifact-commit.v1'||m.generation!==generation||m.reservationId!==r.id||m.reservedEpoch!==r.reservedEpoch||!epochs.has(m.commitEpoch)||epochs.get(m.commitEpoch)<epochs.get(r.reservedEpoch)||JSON.stringify(m.reference)!==JSON.stringify(reference(r))||bytes(text)!==r.markerBytes)fail('marker_integrity');
  if(r.markerHash&&hash(text)!==r.markerHash)fail('marker_ack_mismatch');return {sha256:hash(text),marker:m};
 }
 async function verifyMarker(r){return validateMarkerText(r,await readBounded(filename(markerPath(r)),2048));}
 async function load(){
  await held();const initial=await listNames(root,6);if(initial.some(n=>![ROOT,JOURNAL,LEASE,'objects','commits','temporary'].includes(n)))fail('unknown_root_entry');if(!initial.includes(ROOT)){
   if(initial.some(n=>n!==LEASE))fail('uninitialized_nonempty_root');
   generation=randomUUID();const text=JSON.stringify({contract:PERSISTENT_ARTIFACT_WRITER_CONTRACT,generation});
   if(bytes(text)+1>cfg.maxStoredBytes)fail('stored_byte_limit');await writeNew(filename(ROOT),text);await syncDir(root);
  }else{
   const meta=parse(await readBounded(filename(ROOT),1024),'root');if(!exact(meta,['contract','generation'])||meta.contract!==PERSISTENT_ARTIFACT_WRITER_CONTRACT||!uuid(meta.generation))fail('root_contract');generation=meta.generation;
  }
  for(const d of ['objects','commits','temporary']){await held();const st=await optionalStat(filename(d));if(!st)await fs.mkdir(filename(d));else if(!st.isDirectory()||st.isSymbolicLink())fail('artifact_directory');}
  const journalStat=await optionalStat(filename(JOURNAL));
  if(!journalStat){for(const d of ['objects','commits','temporary'])if((await listNames(filename(d),1)).length)fail('journal_missing_with_artifacts');await held();await writeNew(filename(JOURNAL),'');}
  const journal=await readBounded(filename(JOURNAL),cfg.maxJournalBytes);journalBytes=bytes(journal);if(journal&&!journal.endsWith('\n'))fail('partial_journal');
  let active=null;for(const line of journal?journal.slice(0,-1).split('\n'):[]){if(!line)fail('empty_journal_record');if(bytes(line)>ACK_RESERVE)fail('journal_record_limit');
   const rec=parse(line,'journal');if(!exact(rec,['seq','previous','generation','epoch','type','data','sha256']))fail('journal_shape');const {sha256,...base}=rec;
   if(rec.seq!==seq+1||rec.previous!==head||rec.generation!==generation||!uuid(rec.epoch)||!hashOk(sha256)||hash(JSON.stringify(base))!==sha256)fail('journal_chain');
   if(rec.type==='fence'){if(!exact(rec.data,[])||epochs.has(rec.epoch))fail('fence_record');active=rec.epoch;epochs.set(active,rec.seq);}
   else if(rec.epoch!==active)fail('stale_fence');
   else if(rec.type==='reserve')installReserve(rec.data,active);
   else if(rec.type==='committed'){
    if(!exact(rec.data,['reservationId','markerSha256'])||!hashOk(rec.data.markerSha256))fail('commit_record');const r=reservations.get(rec.data.reservationId);if(!r||r.ack)fail('commit_reservation');r.ack=true;r.markerHash=rec.data.markerSha256;r.commitSequence=rec.seq;
   }else fail('journal_type');seq=rec.seq;head=sha256;
  }
  const state=await inventory();
  for(const r of reservations.values()){
   const objectExists=state.files.has(objectPath(r)),markerExists=state.files.has(markerPath(r));
   if(r.ack&&!markerExists)fail('acknowledged_marker_missing');
   if(objectExists)await verifyObject(r,{cache:true});
   if(markerExists){if(!objectExists)fail('committed_object_missing');await verifyMarker(r);committed.set(key(r),r);}
   for(const p of [tempPath(r),markerTempPath(r)])if(state.files.has(p)){
    const text=await readBounded(filename(p),p===tempPath(r)?cfg.maxObjectBytes:2048);
    if(p===tempPath(r)){if(bytes(text)!==r.bytes||hash(text)!==r.sha256)fail('temporary_integrity');}
    else validateMarkerText(r,text);
   }
  }
  epoch=randomUUID();await append('fence',{});epochs.set(epoch,seq);
  // A marker is the visibility boundary. A crash after that boundary but before
  // its acknowledgement is reconciled only after verifying its own reservation,
  // marker and complete object, under the newly held OS lease.
  for(const r of committed.values())if(!r.ack){const m=await verifyMarker(r);r.commitSequence=await append('committed',{reservationId:r.id,markerSha256:m.sha256},{reservedAck:true});r.ack=true;r.markerHash=m.sha256;}
 }
 function serial(operation,inputBytes=0){
  if(closing||closed)return Promise.reject(Error('persistent_artifact_writer:closed'));
  if(pendingOperations>=cfg.maxPendingOperations||pendingBytes+inputBytes>cfg.maxPendingBytes)return Promise.reject(Error('persistent_artifact_writer:pending_limit'));
  pendingOperations++;pendingBytes+=inputBytes;
  const result=queue.then(async()=>{await held();const result=await operation();await held();return result;}).finally(()=>{pendingOperations--;pendingBytes-=inputBytes;});queue=result.catch(()=>{});return result;
 }
 async function commit(input){
  // Admission precedes byte copies, filesystem writes and reservations.
  if(closed||closing)fail('closed');if(pendingOperations>=cfg.maxPendingOperations)fail('pending_limit');
  if(!object(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('commit_input');
  const fields=Object.getOwnPropertyDescriptors(input);if(Object.keys(fields).sort().join(',')!=='expectedSha256,kind,utf8'||Object.values(fields).some(d=>!Object.hasOwn(d,'value')))fail('commit_plain_data_required');
  const {kind,utf8,expectedSha256}=Object.fromEntries(Object.entries(fields).map(([k,d])=>[k,d.value]));
  if(!kindOk(kind)||typeof utf8!=='string'||!hashOk(expectedSha256)||utf8.length>cfg.maxObjectBytes)fail('commit_input');
  if(utf8.length>cfg.maxPendingBytes-pendingBytes)fail('pending_limit');
  const n=bytes(utf8);if(n>cfg.maxPendingBytes-pendingBytes)fail('pending_limit');if(n>cfg.maxObjectBytes||hash(utf8)!==expectedSha256||Buffer.from(utf8).toString('utf8')!==utf8)fail('commit_bytes');
  const ref={kind,sha256:expectedSha256,bytes:n};
  return serial(async()=>{
   await room();let r=byKey.get(key(ref));if(r&&r.bytes!==n)fail('identity_size_conflict');
   if(committed.has(key(ref))){
    const marker=await verifyMarker(r);await verifyObject(r,{cache:false});
    // STOP may have interrupted the acknowledgement after marker publication.
    // An exact retry under this still-owned lease must repair discovery before
    // returning success, just as load() reconciles that boundary after restart.
    if(!r.ack){
     r.commitSequence=await append('committed',{reservationId:r.id,markerSha256:marker.sha256},{reservedAck:true});r.ack=true;r.markerHash=marker.sha256;
     // Remove only this reservation's verified provisional copies. Unknown or
     // corrupted files stay intact and fail closed; no age-based cleanup.
     const temporary=filename(tempPath(r)),markerTemporary=filename(markerTempPath(r));
     if(await optionalStat(temporary)){const text=await readBounded(temporary,cfg.maxObjectBytes);if(bytes(text)!==r.bytes||hash(text)!==r.sha256)fail('temporary_integrity');await held();await fs.unlink(temporary);}
     if(await optionalStat(markerTemporary)){validateMarkerText(r,await readBounded(markerTemporary,2048));await held();await fs.unlink(markerTemporary);}
     await syncDir(filename('temporary'));await room();
    }
    return reference(r);
   }
   if(!r){
    if(byKey.size>=cfg.maxArtifacts||reservations.size>=cfg.maxReservations)fail('reservation_count_or_identity');
    const objectNew=!(await optionalStat(filename(objectPath(ref))));if(!objectNew)await verifyObject(ref,{cache:true});
    const candidate={id:randomUUID(),...ref,objectNew,markerBytes:0,reservedEpoch:epoch,ack:false,markerHash:null};candidate.markerBytes=bytes(JSON.stringify(markerFor(candidate,epoch)));
    const data={id:candidate.id,...ref,objectNew,markerBytes:candidate.markerBytes};
    const reserveLine=encode('reserve',data),growth=n+(objectNew?n:0)+candidate.markerBytes*2+ACK_RESERVE+bytes(reserveLine);
    await room(growth);await append('reserve',data,{extraJournalReservation:ACK_RESERVE});r=installReserve(data,epoch);
   }
   // Exact-input retries may resume ONLY their own recorded reservation. Unknown
   // files never become implicitly adopted artifacts.
   const temporary=filename(tempPath(r));await held();if(!(await optionalStat(temporary)))await writeNew(temporary,utf8);else{const text=await readBounded(temporary,cfg.maxObjectBytes);if(text!==utf8)fail('temporary_integrity');}
   await held();const destination=filename(objectPath(r));if(!(await optionalStat(destination))){await fs.link(temporary,destination);await syncDir(filename('objects'));}await verifyObject(r,{cache:false});
   await held();const marker=JSON.stringify(markerFor(r,epoch)),markerTemporary=filename(markerTempPath(r));
   // A previous incomplete marker temporary is owned but is not a commit. It
   // may contain the old fencing epoch; replace only this verified own path.
   if(await optionalStat(markerTemporary)){validateMarkerText(r,await readBounded(markerTemporary,2048));await fs.unlink(markerTemporary);}
   await writeNew(markerTemporary,marker);await held();
   await fs.link(markerTemporary,filename(markerPath(r)));await syncDir(filename('commits'));
   const committedMarker=await verifyMarker(r);committed.set(key(r),r);
   r.commitSequence=await append('committed',{reservationId:r.id,markerSha256:committedMarker.sha256},{reservedAck:true});r.ack=true;r.markerHash=committedMarker.sha256;
   // Only verified files belonging to this reservation are removed. No scans,
   // lock deletion, foreign files, PID inference or age-based cleanup.
   await held();await fs.unlink(temporary);await fs.unlink(markerTemporary);await syncDir(filename('temporary'));await room();return reference(r);
  },n);
 }
 async function read(ref){checkReference(ref,cfg);return serial(async()=>{await room();const r=committed.get(key(ref));if(!r||r.bytes!==ref.bytes)fail('uncommitted_reference');await verifyMarker(r);return verifyObject(r,{cache:false});});}
 async function readMany(inputs){
  // One bounded operation, not unverified cache reuse. Every marker and object
  // is read/hash-checked; full root inventory fences the batch at BOTH ends.
  // Amortize repeated whole-directory scans over up to16MiB/64references.
  if(!Array.isArray(inputs)||inputs.length<1||inputs.length>64)fail('read_batch_bound');
  let total=0;const refs=[];for(let i=0;i<inputs.length;i++){
   const slot=Object.getOwnPropertyDescriptor(inputs,String(i));if(!slot||!Object.hasOwn(slot,'value'))fail('read_batch_plain');
   const input=slot.value;if(!object(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('read_batch_plain');
   const fields=Object.getOwnPropertyDescriptors(input);if(Object.keys(fields).sort().join(',')!=='bytes,kind,sha256'||Object.values(fields).some(d=>!Object.hasOwn(d,'value')))fail('read_batch_plain');
   const ref=Object.fromEntries(Object.entries(fields).map(([k,d])=>[k,d.value]));checkReference(ref,cfg);total+=ref.bytes;if(total>Math.min(16*1024*1024,cfg.maxPendingBytes))fail('read_batch_bytes');refs.push(ref);
  }
  return serial(async()=>{await room();const values=[];for(const ref of refs){await held();const r=committed.get(key(ref));if(!r||r.bytes!==ref.bytes)fail('uncommitted_reference');await verifyMarker(r);values.push(await verifyObject(r,{cache:false}));}await room();return Object.freeze(values);},total);
 }
 async function inspect(){return serial(async()=>{const s=await inventory();return Object.freeze({contract:PERSISTENT_ARTIFACT_WRITER_CONTRACT,generation,epoch,committedArtifacts:committed.size,reservedArtifacts:byKey.size-committed.size,reservations:reservations.size,physicalBytes:s.physicalBytes,reservedBytes:s.reservedBytes,effectiveBytes:s.physicalBytes+s.reservedBytes,journalBytes,limits:cfg});});}
 async function listCommitted({kind}={}){
  if(!kindOk(kind))fail('discovery_kind');return serial(async()=>{
   await room();const rows=[];for(const r of committed.values())if(r.ack&&r.kind===kind){await held();await verifyMarker(r);await verifyObject(r,{cache:false});if(!Number.isSafeInteger(r.commitSequence)||r.commitSequence<1)fail('commit_sequence');rows.push(Object.freeze({reference:reference(r),commitSequence:r.commitSequence,generation}));}
   rows.sort((a,b)=>a.commitSequence-b.commitSequence);for(let i=1;i<rows.length;i++)if(rows[i-1].commitSequence===rows[i].commitSequence)fail('ambiguous_commit_sequence');return Object.freeze(rows);
  });
 }
 async function close(){closing=true;await queue;closed=true;await releaseArtifactWriterLease(lease);}
 try{await load();}catch(error){closed=true;await releaseArtifactWriterLease(lease);throw error;}
 return Object.freeze({contract:PERSISTENT_ARTIFACT_WRITER_CONTRACT,commit,read,readMany,readBatchLimits:Object.freeze({maxReferences:64,maxBytes:Math.min(16*1024*1024,cfg.maxPendingBytes)}),inspect,listCommitted,close});
}
