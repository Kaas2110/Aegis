/** One calculation's bounded map snapshot. Trusted private map-view callbacks
 * provide actual verified rows and the writer epoch; this helper mints no proof.
 * Every invocation rereads its actual dependencies before finalizing. */
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {canonical} from '../../feature-registry/registry-contract.mjs';
import {measureBoundedJsonBytes,snapshotPlainRecord} from './diagnosticResourceArena.mjs';

export const PROOF_SCOPED_MAP_CACHE_MAX_UTF8_BYTES=128*1024*1024;
const MAX_ROWS=50000,MAX_ROW_BYTES=1024*1024+4096,MAX_ROW_NODES=100000;
const WORKING_BYTES=8*1024*1024,BASE_BYTES=65536,YIELD_ROWS=128;
const EPOCH_KEYS=['sourceSnapshotHash','generation','epoch','journalBytes','committedArtifacts','reservedArtifacts','reservations','effectiveBytes'];
const fail=reason=>{throw Error('proof_scoped_map_reader:'+reason);};

function epochSnapshot(raw){
 const value=snapshotPlainRecord(raw,{maxKeys:EPOCH_KEYS.length});
 if(Object.keys(value).some(key=>!EPOCH_KEYS.includes(key)))fail('epoch_fields');
 // Legacy synthetic writers do not provide actual generation evidence. Their
 // original streaming path remains available; they cannot authorize this cache.
 if(!EPOCH_KEYS.every(key=>Object.hasOwn(value,key)))return null;
 if(!/^[a-f0-9]{64}$/.test(value.sourceSnapshotHash??'')||
   ['generation','epoch'].some(key=>typeof value[key]!=='string'||value[key].length<1||value[key].length>128)||
   EPOCH_KEYS.slice(3).some(key=>!Number.isSafeInteger(value[key])||value[key]<0))return null;
 return Object.freeze(value);
}

/** Check nested arrays too: Object.freeze(row) alone supplies no ownership. */
function immutableNodes(value){
 let nodes=0;const ancestors=new Set();
 function visit(item,depth){
  if(++nodes>MAX_ROW_NODES||depth>64)fail('row_structure');
  if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
  if(!item||typeof item!=='object'||types.isProxy(item)||ancestors.has(item)||!Object.isFrozen(item)||Object.getOwnPropertySymbols(item).length)fail('immutable_plain_row_required');
  const array=Array.isArray(item);
  if(!array&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('immutable_plain_row_required');
  const keys=Object.keys(item),names=Object.getOwnPropertyNames(item);
  if(names.length!==keys.length+(array?1:0)||array&&keys.length!==item.length)fail('row_properties');
  ancestors.add(item);
  for(let i=0;i<keys.length;i++){
   const key=keys[i];if(array&&key!==String(i))fail('row_properties');
   const descriptor=Object.getOwnPropertyDescriptor(item,key);
   if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('row_accessor');
   visit(descriptor.value,depth+1);
  }
  ancestors.delete(item);
 }
 visit(value,0);return nodes;
}

/** iterate and readEpoch are trusted internal callbacks to the SAME private
 * observed/static map view. Neither caller JSON nor this result is authority.
 * maxCachedUtf8Bytes may lower the fixed ceiling, never raise it. */
export async function createProofScopedMapReader({iterate,readEpoch,resourceArena,shouldContinue=()=>true,maxCachedUtf8Bytes=PROOF_SCOPED_MAP_CACHE_MAX_UTF8_BYTES}={}){
 if(typeof iterate!=='function'||typeof readEpoch!=='function'||typeof shouldContinue!=='function'||typeof resourceArena?.reserve!=='function'||
  !Number.isSafeInteger(maxCachedUtf8Bytes)||maxCachedUtf8Bytes<0||maxCachedUtf8Bytes>PROOF_SCOPED_MAP_CACHE_MAX_UTF8_BYTES)fail('ports_or_cache_bound');
 const working=resourceArena.reserve(WORKING_BYTES+BASE_BYTES);if(!working)fail('working_memory');
 let active=true,busy=false,finalized=false,initialEpoch=null,rows=[],leases=[],cacheBytes=2,chargedBytes=WORKING_BYTES+BASE_BYTES;
 let cacheEnabled=true,fallbackReason=null,initial=null,cachedRowReads=0,streamedRowReads=0;
 async function proceed(){if(!active)fail('released');if(await shouldContinue()!==true)fail('stopped');if(!active)fail('released');}
 function discardCache(reason){for(const held of leases)held.release();leases=[];rows=[];chargedBytes=WORKING_BYTES+BASE_BYTES;cacheEnabled=false;fallbackReason??=reason;}
 function release(){if(!active)return false;active=false;discardCache('released');working.release();chargedBytes=0;return true;}
 async function scan({retain=false}={}){
  const digest=createHash('sha256');digest.update('[');let count=0,wireBytes=2;
  await proceed();
  for await(const row of iterate()){
   await proceed();if(++count>MAX_ROWS)fail('row_count');
   const nodes=immutableNodes(row),size=measureBoundedJsonBytes(row,{maxBytes:MAX_ROW_BYTES,maxNodes:MAX_ROW_NODES,maxDepth:64});
   const text=canonical(row);if(Buffer.byteLength(text)!==size)fail('row_wire_length');
   if(count>1)digest.update(',');digest.update(text);wireBytes+=size+(count>1?1:0);
   if(retain&&cacheEnabled){
    if(wireBytes>maxCachedUtf8Bytes)discardCache('cache_wire_bound');
    else{
     // Existing engineering convention plus explicit graph/row overhead. This
     // charge is conservative admission, not a measured heap-size assertion.
     const charge=size*8+nodes*64+128,held=resourceArena.reserve(charge);
     if(!held)discardCache('cache_memory_admission');
     else{leases.push(held);rows.push(row);chargedBytes+=charge;cacheBytes=wireBytes;}
    }
   }
   if(count%YIELD_ROWS===0){await yieldTurn();await proceed();}
  }
  digest.update(']');await proceed();return Object.freeze({sha256:digest.digest('hex'),count,wireBytes});
 }
 try{
  await proceed();initialEpoch=epochSnapshot(await readEpoch());await proceed();
  if(initialEpoch===null)discardCache('epoch_evidence_unavailable');
  initial=await scan({retain:true});
  const loadedEpoch=epochSnapshot(await readEpoch());await proceed();
  if(initialEpoch!==null&&(loadedEpoch===null||canonical(initialEpoch)!==canonical(loadedEpoch)))fail('epoch_changed');
  return Object.freeze({
   async *iterate(){
    if(!active)fail('released');if(busy)fail('reader_busy');if(finalized)fail('epoch_finalized');busy=true;
    try{
     await proceed();
     if(cacheEnabled){for(let i=0;i<rows.length;i++){await proceed();cachedRowReads++;yield rows[i];if((i+1)%YIELD_ROWS===0){await yieldTurn();await proceed();}}}
     else{let count=0;for await(const row of iterate()){await proceed();streamedRowReads++;yield row;if(++count%YIELD_ROWS===0){await yieldTurn();await proceed();}}}
    }finally{busy=false;}
   },
   async verifyFinal(){
    if(!active)fail('released');if(busy)fail('reader_busy');if(finalized)fail('epoch_finalized');busy=true;
    try{
     const final=await scan(),finalEpoch=epochSnapshot(await readEpoch());await proceed();
     if(canonical(final)!==canonical(initial))fail('source_changed');
     if(initialEpoch!==null&&(finalEpoch===null||canonical(finalEpoch)!==canonical(initialEpoch)))fail('epoch_changed');
     finalized=true;return Object.freeze({verifiedEpoch:initialEpoch!==null,cached:cacheEnabled,...initial});
    }catch(error){release();throw error;}finally{busy=false;}
   },
   status(){return Object.freeze({active,finalized,cached:cacheEnabled&&active,cachedUtf8Bytes:cacheEnabled&&active?cacheBytes:0,cachedRows:rows.length,chargedBytes,fallbackReason,cachedRowReads,streamedRowReads,maxCachedUtf8Bytes,accounting:'explicit_estimates_not_measured_heap'});},
   release
  });
 }catch(error){release();throw error;}
}
