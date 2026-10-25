/** Opt-in host startup composition. Discovery is from an owned writer journal,
 * never a client-supplied path, timestamp or chosen "latest" context. The store
 * is returned only after all discovered series heads have been verified. */
import {createHash} from 'node:crypto';
import {createSeriesRouteContextStore,SERIES_ROUTE_POINTER_KIND} from './seriesRouteContextStore.mjs';
const fail=x=>{throw Error('persisted_series_route_context:'+x);};
const sha=x=>createHash('sha256').update(x).digest('hex');
const SHA=/^[a-f0-9]{64}$/,SID=/^[A-Za-z0-9_.:-]{1,128}$/;
function plain(x,keys){if(!x||typeof x!=='object'||Array.isArray(x)||![Object.prototype,null].includes(Object.getPrototypeOf(x))||Object.getOwnPropertySymbols(x).length)fail('plain_record');const descriptors=Object.getOwnPropertyDescriptors(x);if(Object.keys(descriptors).length!==keys.length||keys.some(k=>!Object.hasOwn(descriptors,k)||!Object.hasOwn(descriptors[k],'value')))fail('record_fields');return x;}
function pointerRef(ref){plain(ref,['kind','sha256','bytes']);if(ref.kind!==SERIES_ROUTE_POINTER_KIND||typeof ref.sha256!=='string'||!SHA.test(ref.sha256)||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>4096)fail('pointer_reference');return Object.freeze({...ref});}
const same=(a,b)=>a===null||b===null?a===b:a.kind===b.kind&&a.sha256===b.sha256&&a.bytes===b.bytes;
export async function createPersistedSeriesRouteContextStore({storage,now,shouldContinue=()=>true,storeLimits={},recoveryLimits={}}={}){
 if(typeof storage?.listCommitted!=='function'||typeof storage?.read!=='function'||typeof storage?.commit!=='function'||typeof shouldContinue!=='function')fail('owned_writer_ports');
 if(!recoveryLimits||typeof recoveryLimits!=='object'||Object.getOwnPropertySymbols(recoveryLimits).length)fail('recovery_limits');
 const descriptors=Object.getOwnPropertyDescriptors(recoveryLimits);if(Object.keys(descriptors).some(k=>!['maxPointers','maxPointerBytes'].includes(k)||!Object.hasOwn(descriptors[k],'value')))fail('recovery_limits');
 const limits={maxPointers:2048,maxPointerBytes:8*1024*1024,...recoveryLimits};
 if(!Number.isSafeInteger(limits.maxPointers)||limits.maxPointers<1||limits.maxPointers>4096||!Number.isSafeInteger(limits.maxPointerBytes)||limits.maxPointerBytes<1||limits.maxPointerBytes>16*1024*1024)fail('recovery_limits');
 const check=()=>{let okay=false;try{okay=shouldContinue()===true;}catch{}if(!okay)fail('manual_stop_or_abort');};
 function normalizeInventory(listed){
 if(!Array.isArray(listed)||listed.length>limits.maxPointers)fail('pointer_inventory_bound');
 // Copy only bounded primitive references; the owned storage may return frozen
 // records. No untrusted callbacks/accessors execute during later awaits.
 return listed.map(raw=>{plain(raw,['reference','commitSequence','generation']);if(!Number.isSafeInteger(raw.commitSequence)||raw.commitSequence<1||typeof raw.generation!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(raw.generation))fail('commit_sequence_or_generation');return{reference:pointerRef(raw.reference),commitSequence:raw.commitSequence,generation:raw.generation};});
 }
 check();const entries=normalizeInventory(await storage.listCommitted({kind:SERIES_ROUTE_POINTER_KIND}));check();
 const heads=new Map(),seen=new Set();let lastSequence=0,totalBytes=0,generation=null;
 for(const entry of entries){
  check();if(entry.commitSequence<=lastSequence||seen.has(entry.reference.sha256))fail('commit_order_or_duplicate');if(generation!==null&&generation!==entry.generation)fail('mixed_writer_generations');generation=entry.generation;lastSequence=entry.commitSequence;seen.add(entry.reference.sha256);
  totalBytes+=entry.reference.bytes;if(totalBytes>limits.maxPointerBytes)fail('pointer_bytes_bound');
  const utf8=await storage.read(entry.reference);check();if(typeof utf8!=='string'||utf8.length>entry.reference.bytes||Buffer.byteLength(utf8)!==entry.reference.bytes||sha(utf8)!==entry.reference.sha256)fail('pointer_bytes');
  const body=JSON.parse(utf8);plain(body,['contract','seriesId','ordinal','revisionRef','previousPointer']);
  if(body.contract!=='aegis.series-route-context-pointer.v1'||typeof body.seriesId!=='string'||!SID.test(body.seriesId)||!Number.isSafeInteger(body.ordinal)||body.ordinal<1)fail('pointer_body');
  if(body.previousPointer!==null)pointerRef(body.previousPointer);
  const prior=heads.get(body.seriesId);if(body.ordinal!==(prior?.ordinal??0)+1||!same(body.previousPointer,prior?.reference??null))fail('committed_pointer_fork_or_gap');
  heads.set(body.seriesId,{...entry,ordinal:body.ordinal});
 }
 const contextStore=createSeriesRouteContextStore({storage,now,shouldContinue,limits:storeLimits});
 // This newly owned store is deliberately not exposed until recovery succeeds.
 // restorePointer verifies revision bytes, correction links and the whole chain.
 const restored=[];for(const [seriesId,head] of heads){check();const receipt=await contextStore.restorePointer(head.reference);check();if(receipt.seriesId!==seriesId)fail('restored_series_identity');restored.push({seriesId,ordinal:receipt.ordinal,pointerRef:receipt.pointerRef,commitSequence:head.commitSequence,verifiedRevisions:receipt.verifiedRevisions});}
 // Startup uses one context owner. Detect series writes racing this bounded
 // recovery; do not expose a head that became stale during awaited reads.
 const finalInventory=normalizeInventory(await storage.listCommitted({kind:SERIES_ROUTE_POINTER_KIND}));check();if(JSON.stringify(finalInventory)!==JSON.stringify(entries))fail('pointer_inventory_changed_during_recovery');
 return Object.freeze({contextStore,recovery:Object.freeze({contract:'aegis.persisted-series-context-recovery.v1',generation,pointerRecords:entries.length,pointerBytes:totalBytes,series:restored.length,heads:Object.freeze(restored.map(row=>Object.freeze(row))),discoveryBasis:'owned_committed_writer_journal',diagnosticOnly:true,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false})});
}
