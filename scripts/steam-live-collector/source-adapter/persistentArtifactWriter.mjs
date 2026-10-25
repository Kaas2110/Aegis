/** Bounded single-writer immutable artifact store. Source-only diagnostic port:
 * no services, providers, activation or implicit lease acquisition at import.
 * File bytes + future reservation bytes share one cumulative root budget.
 * Commit markers are published last; uncommitted objects are never readable.
 * A crash may require an exact-input retry, but cannot expose a partial object.
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isProxy} from 'node:util/types';
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
function plainFields(value,keys,label){
 if(isProxy(value)||!object(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(label);
 const fields=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(fields);
 if(names.some(k=>typeof k!=='string')||names.sort().join(',')!==[...keys].sort().join(',')||Object.values(fields).some(d=>!Object.hasOwn(d,'value')))fail(label);
 return Object.fromEntries(Object.entries(fields).map(([k,d])=>[k,d.value]));
}
function batchLength(inputs,label){
 if(isProxy(inputs)||!Array.isArray(inputs))fail(label);
 const length=Object.getOwnPropertyDescriptor(inputs,'length')?.value;
 if(!Number.isSafeInteger(length)||length<1||length>64)fail(label);return length;
}
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
 let rootAnchor=null,journalAnchor=null,activeAccounting=null,batchOrdinal=0,outstandingAckBytes=0;
 const reservations=new Map(),byKey=new Map(),epochs=new Map(),committed=new Map(),verifiedObjects=new Map(),plannedFiles=new Map(),unacknowledgedMarkers=new Set();
 // Fixed scalar counters; no instrumentation callback can run inside the lane.
 const metrics={verificationEpochs:0,inventoryScans:0,fileStats:0,directoryLists:0,fileReads:0,rootReads:0,journalReads:0,objectReads:0,markerReads:0,objectHashes:0,payloadHashes:0,markerHashes:0,anchorHashes:0,journalWrites:0,fileFlushes:0,directoryFlushAttempts:0,fileLinks:0,fileUnlinks:0};
 const filename=relative=>path.join(root,...relative.split('/'));
 const objectPath=r=>`objects/${r.sha256}.blob`,markerPath=r=>`commits/${key(r)}.json`;
 const tempPath=r=>`temporary/${r.id}.blob.tmp`,markerTempPath=r=>`temporary/${r.id}.marker.tmp`;
 async function held(){if(closed)fail('closed');if(poisoned)fail('recovery_required');await assertArtifactWriterLease(lease,root);if(await shouldContinue()!==true)fail('stopped');}
 function markerFor(r,commitEpoch){return {contract:'aegis.immutable-artifact-commit.v1',generation,reservationId:r.id,reservedEpoch:r.reservedEpoch,commitEpoch,reference:reference(r)};}
 const plannedPaths=r=>[[tempPath(r),r.bytes],[markerTempPath(r),r.markerBytes],[markerPath(r),r.markerBytes],...(r.objectNew?[[objectPath(r),r.bytes]]:[])];
 function planFile(p,n,delta){const old=plannedFiles.get(p);if(old&&old.bytes!==n)fail('planned_file_conflict');
  const count=(old?.count||0)+delta;if(count<0||(!old&&delta<0))fail('planned_file_owner');const wanted=count?n:0;
  if(activeAccounting){const actual=activeAccounting.files.get(p)||0;activeAccounting.reservedBytes+=Math.max(0,wanted-actual)-Math.max(0,(old?.bytes||0)-actual);}
  if(count)plannedFiles.set(p,{bytes:n,count});else plannedFiles.delete(p);
 }
 function reserveFuture(r){for(const [p,n]of plannedPaths(r))planFile(p,n,1);outstandingAckBytes+=ACK_RESERVE;if(activeAccounting)activeAccounting.reservedBytes+=ACK_RESERVE;}
 function acknowledge(r,markerSha256,commitSequence){if(r.ack)fail('duplicate_acknowledgement');for(const [p,n]of plannedPaths(r))planFile(p,n,-1);outstandingAckBytes-=ACK_RESERVE;if(activeAccounting)activeAccounting.reservedBytes-=ACK_RESERVE;r.ack=true;r.markerHash=markerSha256;r.commitSequence=commitSequence;unacknowledgedMarkers.delete(key(r));}
 function futureAllowance(files){
  // Full boundary reconciliation derives the plan again from durable reservation
  // state; it does not certify the incremental counters by reading them back.
  const actualPlan=new Map();let ackBytes=0;
  for(const r of reservations.values())if(!r.ack){ackBytes+=ACK_RESERVE;for(const [p,n]of plannedPaths(r)){const old=actualPlan.get(p);if(old&&old.bytes!==n)fail('planned_file_conflict');actualPlan.set(p,{bytes:n,count:(old?.count||0)+1});}}
  if(ackBytes!==outstandingAckBytes||actualPlan.size!==plannedFiles.size||[...actualPlan].some(([p,v])=>plannedFiles.get(p)?.bytes!==v.bytes||plannedFiles.get(p)?.count!==v.count))fail('future_accounting_mismatch');
  let total=ackBytes;for(const [p,{bytes:n}]of actualPlan)total+=Math.max(0,n-(files.get(p)||0));return total;
 }
 function noteFile(p,n){if(!activeAccounting)return;const s=activeAccounting,old=s.files.get(p)||0,wanted=plannedFiles.get(p)?.bytes||0;s.physicalBytes+=n-old;s.reservedBytes+=Math.max(0,wanted-n)-Math.max(0,wanted-old);s.files.set(p,n);}
 function forgetFile(p){if(!activeAccounting)return;const s=activeAccounting,old=s.files.get(p)||0,wanted=plannedFiles.get(p)?.bytes||0;s.physicalBytes-=old;s.reservedBytes+=wanted-Math.max(0,wanted-old);s.files.delete(p);}
 async function statOwned(p){metrics.fileStats++;return optionalStat(filename(p));}
 async function namesOwned(p,maximum){metrics.directoryLists++;return listNames(filename(p),maximum);}
 async function readOwned(p,maximum){metrics.fileReads++;metrics.fileStats++;if(p===ROOT)metrics.rootReads++;else if(p===JOURNAL)metrics.journalReads++;else if(p.startsWith('objects/'))metrics.objectReads++;else if(p.startsWith('commits/'))metrics.markerReads++;return readBounded(filename(p),maximum);}
 async function writeOwned(p,content){await writeNew(filename(p),content);metrics.fileFlushes++;noteFile(p,bytes(content));}
 async function syncOwned(p){metrics.directoryFlushAttempts++;await syncDir(filename(p));}
 async function linkOwned(from,to,n){await fs.link(filename(from),filename(to));metrics.fileLinks++;noteFile(to,n);}
 async function unlinkOwned(p){await fs.unlink(filename(p));metrics.fileUnlinks++;forgetFile(p);}
 async function inventory(){
  metrics.inventoryScans++;const files=new Map(),entries=await namesOwned('',6);
  const allowedRoot=new Set([ROOT,JOURNAL,LEASE,'objects','commits','temporary']);
  for(const name of entries){if(!allowedRoot.has(name))fail('unknown_root_entry');metrics.fileStats++;const stat=await fs.lstat(filename(name));if(stat.isSymbolicLink())fail('artifact_file_type');
   if(['objects','commits','temporary'].includes(name)){
    if(!stat.isDirectory())fail('artifact_directory');
    const names=await namesOwned(name,cfg.maxArtifacts*2+cfg.maxReservations*2);
    for(const n of names){const p=name+'/'+n;metrics.fileStats++;const s=await fs.lstat(filename(p));if(!s.isFile()||s.isSymbolicLink())fail('artifact_file_type');files.set(p,s.size);}
   }else{if(!stat.isFile()||(name===LEASE&&stat.size>1))fail('root_file_type');files.set(name,stat.size);}
  }
  const known=new Set([ROOT,JOURNAL,LEASE]);for(const r of reservations.values()){known.add(objectPath(r));known.add(markerPath(r));known.add(tempPath(r));known.add(markerTempPath(r));}
  for(const p of files.keys())if(!known.has(p))fail('unreserved_file');
  const physicalBytes=[...files.values()].reduce((a,b)=>a+b,0),reservedBytes=futureAllowance(files);
  if(physicalBytes+reservedBytes>cfg.maxStoredBytes)fail('stored_byte_limit');
  return {files,physicalBytes,reservedBytes};
 }
 async function room(extra=0){const state=activeAccounting||await inventory();if(state.physicalBytes+state.reservedBytes+extra>cfg.maxStoredBytes)fail('stored_byte_limit');return state;}
 async function verifyAnchors(){
  try{const actualRoot=await readOwned(ROOT,1024),actualJournal=await readOwned(JOURNAL,cfg.maxJournalBytes);
   metrics.anchorHashes++;if(hash(actualRoot)!==rootAnchor)fail('root_integrity');
   metrics.anchorHashes++;if(bytes(actualJournal)!==journalBytes||hash(actualJournal)!==journalAnchor.copy().digest('hex'))fail('journal_integrity');
  }catch(error){poisoned=true;throw error;}
 }
 async function beginVerification(){await verifyAnchors();const state=await inventory();metrics.verificationEpochs++;return {...state,ordinal:++batchOrdinal,generation,writerEpoch:epoch,sequence:seq,head};}
 async function finishVerification(state){
  try{await verifyAnchors();const actual=await inventory();
    if(state.ordinal!==batchOrdinal||state.generation!==generation||state.writerEpoch!==epoch||state.sequence!==seq||state.head!==head||actual.physicalBytes!==state.physicalBytes||actual.reservedBytes!==state.reservedBytes||actual.files.size!==state.files.size||[...actual.files].some(([p,n])=>state.files.get(p)!==n))fail('epoch_inventory_changed');
  }catch(error){poisoned=true;throw error;}
 }
 function encode(type,data){const base={seq:seq+1,previous:head,generation,epoch,type,data};return JSON.stringify({...base,sha256:hash(JSON.stringify(base))})+'\n';}
 async function append(type,data,{reservedAck=false,extraJournalReservation=0}={}){
  await held();const line=encode(type,data),n=bytes(line);if(n>ACK_RESERVE)fail('journal_record_limit');
  const outstanding=outstandingAckBytes-(reservedAck?ACK_RESERVE:0);
  if(journalBytes+n+outstanding+extraJournalReservation>cfg.maxJournalBytes)fail('journal_limit');
  await room(reservedAck?Math.max(0,n-ACK_RESERVE):n);
  const handle=await fs.open(filename(JOURNAL),'a');try{await handle.writeFile(line,'utf8');await handle.sync();}catch(e){poisoned=true;throw e;}finally{await handle.close();}
  metrics.journalWrites++;metrics.fileFlushes++;seq++;head=parse(line,'journal').sha256;journalBytes+=n;journalAnchor.update(line,'utf8');noteFile(JOURNAL,journalBytes);if(activeAccounting){activeAccounting.sequence=seq;activeAccounting.head=head;}return seq;
 }
 function installReserve(data,reservedEpoch){
  if(!exact(data,['id','kind','sha256','bytes','objectNew','markerBytes'])||!uuid(data.id)||typeof data.objectNew!=='boolean'||!Number.isSafeInteger(data.markerBytes)||data.markerBytes<1||data.markerBytes>2048)fail('reserve_record');
  checkReference(reference(data),cfg);if(reservations.has(data.id)||byKey.has(key(data))||reservations.size>=cfg.maxReservations||byKey.size>=cfg.maxArtifacts)fail('reservation_count_or_identity');
  const r={...data,reservedEpoch,ack:false,markerHash:null,commitSequence:null};reservations.set(r.id,r);byKey.set(key(r),r);reserveFuture(r);return r;
 }
 async function verifyObject(r,{cache=false}={}){
  const old=verifiedObjects.get(r.sha256);if(cache&&old===r.bytes)return;
  const text=await readOwned(objectPath(r),cfg.maxObjectBytes);metrics.objectHashes++;if(bytes(text)!==r.bytes||hash(text)!==r.sha256)fail('object_integrity');
  verifiedObjects.set(r.sha256,r.bytes);return text;
 }
 function validateMarkerText(r,text){
  const m=parse(text,'marker');
  if(!exact(m,['contract','generation','reservationId','reservedEpoch','commitEpoch','reference'])||m.contract!=='aegis.immutable-artifact-commit.v1'||m.generation!==generation||m.reservationId!==r.id||m.reservedEpoch!==r.reservedEpoch||!epochs.has(m.commitEpoch)||epochs.get(m.commitEpoch)<epochs.get(r.reservedEpoch)||JSON.stringify(m.reference)!==JSON.stringify(reference(r))||bytes(text)!==r.markerBytes)fail('marker_integrity');
  metrics.markerHashes++;const digest=hash(text);if(r.markerHash&&digest!==r.markerHash)fail('marker_ack_mismatch');return {sha256:digest,marker:m};
 }
 async function verifyMarker(r){return validateMarkerText(r,await readOwned(markerPath(r),2048));}
 async function load(){
  await held();const initial=await namesOwned('',6);if(initial.some(n=>![ROOT,JOURNAL,LEASE,'objects','commits','temporary'].includes(n)))fail('unknown_root_entry');if(!initial.includes(ROOT)){
   if(initial.some(n=>n!==LEASE))fail('uninitialized_nonempty_root');
   generation=randomUUID();const text=JSON.stringify({contract:PERSISTENT_ARTIFACT_WRITER_CONTRACT,generation});
   if(bytes(text)+1>cfg.maxStoredBytes)fail('stored_byte_limit');await writeOwned(ROOT,text);await syncOwned('');rootAnchor=hash(text);
  }else{
   const text=await readOwned(ROOT,1024),meta=parse(text,'root');if(!exact(meta,['contract','generation'])||meta.contract!==PERSISTENT_ARTIFACT_WRITER_CONTRACT||!uuid(meta.generation))fail('root_contract');generation=meta.generation;rootAnchor=hash(text);
  }
  for(const d of ['objects','commits','temporary']){await held();const st=await statOwned(d);if(!st)await fs.mkdir(filename(d));else if(!st.isDirectory()||st.isSymbolicLink())fail('artifact_directory');}
  const journalStat=await statOwned(JOURNAL);
  if(!journalStat){for(const d of ['objects','commits','temporary'])if((await namesOwned(d,1)).length)fail('journal_missing_with_artifacts');await held();await writeOwned(JOURNAL,'');}
  const journal=await readOwned(JOURNAL,cfg.maxJournalBytes);journalBytes=bytes(journal);journalAnchor=createHash('sha256').update(journal,'utf8');if(journal&&!journal.endsWith('\n'))fail('partial_journal');
  let active=null;for(const line of journal?journal.slice(0,-1).split('\n'):[]){if(!line)fail('empty_journal_record');if(bytes(line)>ACK_RESERVE)fail('journal_record_limit');
   const rec=parse(line,'journal');if(!exact(rec,['seq','previous','generation','epoch','type','data','sha256']))fail('journal_shape');const {sha256,...base}=rec;
   if(rec.seq!==seq+1||rec.previous!==head||rec.generation!==generation||!uuid(rec.epoch)||!hashOk(sha256)||hash(JSON.stringify(base))!==sha256)fail('journal_chain');
   if(rec.type==='fence'){if(!exact(rec.data,[])||epochs.has(rec.epoch))fail('fence_record');active=rec.epoch;epochs.set(active,rec.seq);}
   else if(rec.epoch!==active)fail('stale_fence');
   else if(rec.type==='reserve')installReserve(rec.data,active);
   else if(rec.type==='committed'){
    if(!exact(rec.data,['reservationId','markerSha256'])||!hashOk(rec.data.markerSha256))fail('commit_record');const r=reservations.get(rec.data.reservationId);if(!r||r.ack)fail('commit_reservation');acknowledge(r,rec.data.markerSha256,rec.seq);
   }else fail('journal_type');seq=rec.seq;head=sha256;
  }
  const state=await inventory();
  for(const r of reservations.values()){
   const objectExists=state.files.has(objectPath(r)),markerExists=state.files.has(markerPath(r));
   if(r.ack&&!markerExists)fail('acknowledged_marker_missing');
   if(objectExists)await verifyObject(r,{cache:true});
    if(markerExists){if(!objectExists)fail('committed_object_missing');await verifyMarker(r);committed.set(key(r),r);if(!r.ack)unacknowledgedMarkers.add(key(r));}
   for(const p of [tempPath(r),markerTempPath(r)])if(state.files.has(p)){
    const text=await readOwned(p,p===tempPath(r)?cfg.maxObjectBytes:2048);
    if(p===tempPath(r)){if(bytes(text)!==r.bytes||hash(text)!==r.sha256)fail('temporary_integrity');}
    else validateMarkerText(r,text);
   }
  }
  // Compare the exact bytes replayed before extending their chain. A same-size
  // ROOT/ledger replacement during load must not acquire a fresh fence.
  await verifyAnchors();epoch=randomUUID();await append('fence',{});epochs.set(epoch,seq);
  // A marker is the visibility boundary. A crash after that boundary but before
  // its acknowledgement is reconciled only after verifying its own reservation,
  // marker and complete object, under the newly held OS lease.
  for(const r of committed.values())if(!r.ack){const m=await verifyMarker(r);acknowledge(r,m.sha256,await append('committed',{reservationId:r.id,markerSha256:m.sha256},{reservedAck:true}));}
  await verifyAnchors();await inventory();
 }
 function serial(operation,inputBytes=0){
  if(closing||closed)return Promise.reject(Error('persistent_artifact_writer:closed'));
  if(pendingOperations>=cfg.maxPendingOperations||pendingBytes+inputBytes>cfg.maxPendingBytes)return Promise.reject(Error('persistent_artifact_writer:pending_limit'));
  pendingOperations++;pendingBytes+=inputBytes;
  const result=queue.then(async()=>{
   await held();const state=await beginVerification();activeAccounting=state;let finalAttempted=false;
   try{const value=await operation();finalAttempted=true;await finishVerification(state);await held();return value;}
   catch(error){if(!finalAttempted&&!poisoned){try{await finishVerification(state);}catch(boundaryError){throw boundaryError;}}throw error;}
   finally{activeAccounting=null;}
  }).finally(()=>{pendingOperations--;pendingBytes-=inputBytes;});queue=result.catch(()=>{});return result;
 }
 function prepareCommit(input){
  // Admission precedes byte copies, filesystem writes and reservations.
  if(closed||closing)fail('closed');if(pendingOperations>=cfg.maxPendingOperations)fail('pending_limit');
  if(isProxy(input))fail('commit_plain_data_required');if(!object(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('commit_input');
  const {kind,utf8,expectedSha256}=plainFields(input,['kind','utf8','expectedSha256'],'commit_plain_data_required');
  if(!kindOk(kind)||typeof utf8!=='string'||!hashOk(expectedSha256)||utf8.length>cfg.maxObjectBytes)fail('commit_input');
  if(utf8.length>cfg.maxPendingBytes-pendingBytes)fail('pending_limit');
  const n=bytes(utf8);if(n>cfg.maxPendingBytes-pendingBytes)fail('pending_limit');if(n>cfg.maxObjectBytes)fail('commit_bytes');
  return {utf8,n,ref:{kind,sha256:expectedSha256,bytes:n}};
 }
 async function commitOwned({utf8,n,ref},acknowledged=()=>{}){
    // The immutable string is already byte-admitted. Hash/UTF8 copies happen
    // only after entering the lane; refused batches do no payload hashing.
    metrics.payloadHashes++;if(hash(utf8)!==ref.sha256||Buffer.from(utf8).toString('utf8')!==utf8)fail('commit_bytes');
   await room();let r=byKey.get(key(ref));if(r&&r.bytes!==n)fail('identity_size_conflict');
   if(committed.has(key(ref))){
    const marker=await verifyMarker(r);await verifyObject(r,{cache:false});
    // STOP may have interrupted the acknowledgement after marker publication.
    // An exact retry under this still-owned lease must repair discovery before
    // returning success, just as load() reconciles that boundary after restart.
     if(!r.ack){
      acknowledge(r,marker.sha256,await append('committed',{reservationId:r.id,markerSha256:marker.sha256},{reservedAck:true}));
      acknowledged(reference(r));
     // Remove only this reservation's verified provisional copies. Unknown or
     // corrupted files stay intact and fail closed; no age-based cleanup.
      if(await statOwned(tempPath(r))){const text=await readOwned(tempPath(r),cfg.maxObjectBytes);if(bytes(text)!==r.bytes||hash(text)!==r.sha256)fail('temporary_integrity');await held();await unlinkOwned(tempPath(r));}
      if(await statOwned(markerTempPath(r))){validateMarkerText(r,await readOwned(markerTempPath(r),2048));await held();await unlinkOwned(markerTempPath(r));}
      await syncOwned('temporary');await room();
     }else acknowledged(reference(r));
    return reference(r);
   }
   if(!r){
    if(byKey.size>=cfg.maxArtifacts||reservations.size>=cfg.maxReservations)fail('reservation_count_or_identity');
     const objectNew=!(await statOwned(objectPath(ref)));if(!objectNew)await verifyObject(ref,{cache:false});
    const candidate={id:randomUUID(),...ref,objectNew,markerBytes:0,reservedEpoch:epoch,ack:false,markerHash:null};candidate.markerBytes=bytes(JSON.stringify(markerFor(candidate,epoch)));
    const data={id:candidate.id,...ref,objectNew,markerBytes:candidate.markerBytes};
    const reserveLine=encode('reserve',data),growth=n+(objectNew?n:0)+candidate.markerBytes*2+ACK_RESERVE+bytes(reserveLine);
    await room(growth);await append('reserve',data,{extraJournalReservation:ACK_RESERVE});r=installReserve(data,epoch);
   }
   // Exact-input retries may resume ONLY their own recorded reservation. Unknown
   // files never become implicitly adopted artifacts.
    await held();if(!(await statOwned(tempPath(r))))await writeOwned(tempPath(r),utf8);else{const text=await readOwned(tempPath(r),cfg.maxObjectBytes);if(text!==utf8)fail('temporary_integrity');}
    await held();if(!(await statOwned(objectPath(r)))){await linkOwned(tempPath(r),objectPath(r),r.bytes);await syncOwned('objects');}await verifyObject(r,{cache:false});
    await held();const marker=JSON.stringify(markerFor(r,epoch));
   // A previous incomplete marker temporary is owned but is not a commit. It
   // may contain the old fencing epoch; replace only this verified own path.
    if(await statOwned(markerTempPath(r))){validateMarkerText(r,await readOwned(markerTempPath(r),2048));await unlinkOwned(markerTempPath(r));}
    await writeOwned(markerTempPath(r),marker);await held();
    await linkOwned(markerTempPath(r),markerPath(r),bytes(marker));unacknowledgedMarkers.add(key(r));await syncOwned('commits');
   const committedMarker=await verifyMarker(r);committed.set(key(r),r);
    acknowledge(r,committedMarker.sha256,await append('committed',{reservationId:r.id,markerSha256:committedMarker.sha256},{reservedAck:true}));acknowledged(reference(r));
   // Only verified files belonging to this reservation are removed. No scans,
   // lock deletion, foreign files, PID inference or age-based cleanup.
    await held();await unlinkOwned(tempPath(r));await unlinkOwned(markerTempPath(r));await syncOwned('temporary');await room();return reference(r);
 }
 async function commit(input){const prepared=prepareCommit(input);return serial(()=>commitOwned(prepared),prepared.n);}
 async function commitMany(inputs){
  if(closed||closing)fail('closed');if(pendingOperations>=cfg.maxPendingOperations)fail('pending_limit');
  const count=batchLength(inputs,'commit_batch_bound');
  const prepared=[];let total=0;
  for(let i=0;i<count;i++){const slot=Object.getOwnPropertyDescriptor(inputs,String(i));if(!slot||!Object.hasOwn(slot,'value'))fail('commit_batch_plain');const command=prepareCommit(slot.value);total+=command.n;if(total>Math.min(16*1024*1024,cfg.maxPendingBytes-pendingBytes))fail('commit_batch_bytes');prepared.push(command);}
  const acknowledgedPrefix=[];
  try{return await serial(async()=>{const refs=[];for(const command of prepared){await held();refs.push(await commitOwned(command,ref=>acknowledgedPrefix.push(ref)));}return Object.freeze(refs);},total);}
  catch(error){const unknown=poisoned||prepared.some(({ref})=>unacknowledgedMarkers.has(key(ref))),failure=new Error(error instanceof Error?error.message:'persistent_artifact_writer:batch_failed',{cause:error});
   Object.defineProperty(failure,'batchOutcome',{value:Object.freeze({contract:'aegis.artifact-commit-batch-failure.v1',outcome:unknown?'unknown':'committed-prefix',acknowledgedPrefix:Object.freeze([...acknowledgedPrefix]),nextIndex:acknowledgedPrefix.length}),enumerable:true});throw failure;
  }
 }
 function prepareReference(input,label){const ref=plainFields(input,['kind','sha256','bytes'],label);checkReference(ref,cfg);return Object.freeze(ref);}
 async function read(input){
  if(closed||closing)fail('closed');if(pendingOperations>=cfg.maxPendingOperations)fail('pending_limit');
  const ref=prepareReference(input,'read_plain_data_required');
  return serial(async()=>{const r=committed.get(key(ref));if(!r||r.bytes!==ref.bytes)fail('uncommitted_reference');await verifyMarker(r);return verifyObject(r,{cache:false});},ref.bytes);
 }
 async function readMany(inputs){
  // One bounded operation, not unverified cache reuse. Every marker and object
  // is read/hash-checked; full root inventory fences the batch at BOTH ends.
  // Amortize repeated whole-directory scans over up to16MiB/64references.
  if(closed||closing)fail('closed');if(pendingOperations>=cfg.maxPendingOperations)fail('pending_limit');
  const count=batchLength(inputs,'read_batch_bound');
  let total=0;const refs=[];for(let i=0;i<count;i++){
   const slot=Object.getOwnPropertyDescriptor(inputs,String(i));if(!slot||!Object.hasOwn(slot,'value'))fail('read_batch_plain');
    const ref=prepareReference(slot.value,'read_batch_plain');total+=ref.bytes;if(total>Math.min(16*1024*1024,cfg.maxPendingBytes))fail('read_batch_bytes');refs.push(ref);
  }
   return serial(async()=>{const values=[],verified=new Map();for(const ref of refs){await held();const r=committed.get(key(ref));if(!r||r.bytes!==ref.bytes)fail('uncommitted_reference');const k=key(ref);if(!verified.has(k)){await verifyMarker(r);verified.set(k,await verifyObject(r,{cache:false}));}values.push(verified.get(k));}return Object.freeze(values);},total);
 }
 async function inspect(){return serial(async()=>{const s=activeAccounting;return Object.freeze({contract:PERSISTENT_ARTIFACT_WRITER_CONTRACT,generation,epoch,committedArtifacts:committed.size,reservedArtifacts:byKey.size-committed.size,reservations:reservations.size,physicalBytes:s.physicalBytes,reservedBytes:s.reservedBytes,effectiveBytes:s.physicalBytes+s.reservedBytes,journalBytes,limits:cfg,metrics:Object.freeze({...metrics})});});}
 const discoveryRow=r=>Object.freeze({reference:reference(r),commitSequence:r.commitSequence,generation});
 async function findCommitted(input){
  if(closed||closing)fail('closed');if(pendingOperations>=cfg.maxPendingOperations)fail('pending_limit');
  const query=plainFields(input,['kind','sha256'],'discovery_plain');if(!kindOk(query.kind)||!hashOk(query.sha256))fail('discovery_reference');
  // The slot may be committed by earlier queued work. Reserve the configured
  // maximum readable payload while verifying its bytes; no body escapes this
  // lookup. Lowered pending caps remain usable for correspondingly small data.
  const admittedBytes=Math.min(cfg.maxObjectBytes,cfg.maxPendingBytes);
  return serial(async()=>{const r=committed.get(key(query));if(!r?.ack)return null;if(r.bytes>admittedBytes)fail('pending_limit');await verifyMarker(r);await verifyObject(r,{cache:false});if(!Number.isSafeInteger(r.commitSequence)||r.commitSequence<1)fail('commit_sequence');return discoveryRow(r);},admittedBytes);
 }
 async function listCommitted({kind}={}){
  if(!kindOk(kind))fail('discovery_kind');return serial(async()=>{
    const rows=[];for(const r of committed.values())if(r.ack&&r.kind===kind){await held();await verifyMarker(r);await verifyObject(r,{cache:false});if(!Number.isSafeInteger(r.commitSequence)||r.commitSequence<1)fail('commit_sequence');rows.push(discoveryRow(r));}
   rows.sort((a,b)=>a.commitSequence-b.commitSequence);for(let i=1;i<rows.length;i++)if(rows[i-1].commitSequence===rows[i].commitSequence)fail('ambiguous_commit_sequence');return Object.freeze(rows);
  });
 }
 async function close(){closing=true;await queue;closed=true;await releaseArtifactWriterLease(lease);}
 try{await load();}catch(error){closed=true;await releaseArtifactWriterLease(lease);throw error;}
 return Object.freeze({contract:PERSISTENT_ARTIFACT_WRITER_CONTRACT,commit,commitMany,commitBatchLimits:Object.freeze({maxCommands:64,maxBytes:Math.min(16*1024*1024,cfg.maxPendingBytes)}),read,readMany,readBatchLimits:Object.freeze({maxReferences:64,maxBytes:Math.min(16*1024*1024,cfg.maxPendingBytes)}),inspect,findCommitted,listCommitted,close});
}
