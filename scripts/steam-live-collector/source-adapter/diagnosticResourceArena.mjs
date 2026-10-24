import {types} from 'node:util';
/** Owned engineering byte admission. This accounting supplements the OS job cap;
 * serialized-byte estimates are deliberately not presented as measured heap size. */
export function createDiagnosticResourceArena({maxBytes=2*1024**3,maxLeases=65536}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>6*1024**3||!Number.isSafeInteger(maxLeases)||maxLeases<1||maxLeases>65536)throw Error('diagnostic_arena:configuration');
 const assets=new WeakMap();let chargedBytes=0,peakChargedBytes=0,leases=0,denied=0,heldAssets=0;
 function ticket(release){let active=true;leases++;return Object.freeze({release(){if(!active)return false;active=false;leases--;release();return true;}});}
 function capacity(bytes){if(!Number.isSafeInteger(bytes)||bytes<0)throw Error('diagnostic_arena:bytes');if(leases>=maxLeases||bytes>maxBytes-chargedBytes){denied++;return false;}return true;}
 function charge(bytes){chargedBytes+=bytes;peakChargedBytes=Math.max(peakChargedBytes,chargedBytes);}
 return Object.freeze({
  reserve(bytes){if(!capacity(bytes))return null;charge(bytes);return ticket(()=>{chargedBytes-=bytes;});},
  retainAsset(asset,bytes){
   if(!asset||typeof asset!=='object'||!Object.isFrozen(asset))throw Error('diagnostic_arena:owned_immutable_asset');
   const existing=assets.get(asset);if(existing&&existing.bytes!==bytes)throw Error('diagnostic_arena:asset_charge_changed');
   if(!capacity(existing?0:bytes))return null;
   const entry=existing??{bytes,refs:0};if(!existing){assets.set(asset,entry);heldAssets++;charge(bytes);}entry.refs++;
   return ticket(()=>{if(--entry.refs===0){assets.delete(asset);heldAssets--;chargedBytes-=entry.bytes;}});
  },
  status(){return{contract:'aegis.diagnostic-resource-arena.v1',chargedBytes,peakChargedBytes,leases,heldAssets,denied,maxBytes,maxLeases,accounting:'explicit_estimates_not_measured_heap'};}
 });
}

/** Exact JSON wire length for plain owned data, without allocating a JSON copy.
 * Accessors/cycles/deep or excessively wide input fail before clone/hash. */
export function measureBoundedJsonBytes(value,{maxBytes=128*1024*1024,maxNodes=4000000,maxDepth=64}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxNodes)||maxNodes<1||!Number.isSafeInteger(maxDepth)||maxDepth<1||maxDepth>128)throw Error('diagnostic_size:configuration');
 let bytes=0,nodes=0;const ancestors=new Set();
 const add=n=>{bytes+=n;if(bytes>maxBytes)throw Error('diagnostic_size:byte_bound');};
 function string(s){add(2);for(let i=0;i<s.length;i++){
  const c=s.charCodeAt(i);
  if(c===34||c===92)add(2);
  else if(c<32)add([8,9,10,12,13].includes(c)?2:6);
  else if(c<128)add(1);
  else if(c<2048)add(2);
  else if(c>=0xd800&&c<=0xdbff){const n=s.charCodeAt(i+1);if(n>=0xdc00&&n<=0xdfff){add(4);i++;}else add(6);}
  else if(c>=0xdc00&&c<=0xdfff)add(6);
  else add(3);
 }}
 function visit(v,depth){
  if(++nodes>maxNodes||depth>maxDepth)throw Error('diagnostic_size:structure_bound');
  if(v===null){add(4);return;}
  if(typeof v==='string'){string(v);return;}
  if(typeof v==='boolean'){add(v?4:5);return;}
  if(typeof v==='number'&&Number.isFinite(v)){add(String(v).length);return;}
  if(!v||typeof v!=='object'||types.isProxy(v)||ancestors.has(v)||!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw Error('diagnostic_size:plain_json_required');
  ancestors.add(v);
  if(Array.isArray(v)){
   if(v.length>maxNodes-nodes)throw Error('diagnostic_size:structure_bound');add(2);
   for(let i=0;i<v.length;i++){if(i)add(1);const d=Object.getOwnPropertyDescriptor(v,String(i));if(d&&!('value'in d))throw Error('diagnostic_size:accessor');visit(!d||d.value===undefined?null:d.value,depth+1);}
  }else{
   add(2);let count=0;
   for(const k of Object.keys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!('value'in d))throw Error('diagnostic_size:accessor');if(d.value===undefined)continue;if(count++)add(1);string(k);add(1);visit(d.value,depth+1);}
  }
  ancestors.delete(v);
 }
 visit(value,0);return bytes;
}

/** Tiny top-level ownership boundary. Opaque proof values are held by reference,
 * but accessor properties and proxies cannot run while admission is in progress. */
export function snapshotPlainRecord(value,{maxKeys=32}={}){
 if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('diagnostic_size:plain_record_required');
 const keys=Object.keys(value);if(keys.length>maxKeys)throw Error('diagnostic_size:record_key_bound');
 const out={};for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);if(!d||!('value'in d))throw Error('diagnostic_size:accessor');Object.defineProperty(out,k,{value:d.value,writable:true,enumerable:true,configurable:true});}return out;
}
