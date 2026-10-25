/** Private engineering ownership for shared projection data. Estimates describe
 * admitted JS storage, not measured heap or an alternative to the owned job cap. */
import {createHash} from 'node:crypto';
import {types} from 'node:util';
const fail=x=>{throw Error('unified_features:'+x);};
export const FEATURE_ASSET_WORKING_BYTES=128*1024*1024;
export function inspectFeatureAsset(value,{workingBytes=FEATURE_ASSET_WORKING_BYTES,maxBytes=2*1024**3,maxNodes=16000000}={}){
 let bytes=0,nodes=0,objects=0,deeplyFrozen=true;const seen=new WeakSet(),active=new WeakSet();
 const add=n=>{bytes+=n;if(bytes>maxBytes)fail('asset_byte_bound');};
 function visit(v,depth=0){
  if(++nodes>maxNodes||depth>64)fail('asset_structure_bound');
  if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)){add(8);return;}
  if(typeof v==='string'){add(16+v.length*2);return;}
  if(!v||typeof v!=='object'||types.isProxy(v)||!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v))||active.has(v))fail('asset_plain_json');
  if(seen.has(v))return;seen.add(v);active.add(v);if(++objects*64>workingBytes)fail('asset_scan_working_bound');deeplyFrozen&&=Object.isFrozen(v);
  if(Array.isArray(v)){
   if(v.length>maxNodes-nodes)fail('asset_structure_bound');add(64+v.length*8);
   for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!('value'in d))fail('asset_data_property');visit(d.value,depth+1);}
  }else{
   const keys=Object.keys(v);add(64+keys.length*24);
   for(const key of keys){const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!('value'in d))fail('asset_data_property');if(d.value===undefined)continue;add(key.length*2);visit(d.value,depth+1);}
  }
  active.delete(v);
 }
 visit(value);return{bytes:Math.max(256,bytes),nodes,objects,deeplyFrozen};
}
export function freezeFeatureAsset(value,seen=new WeakSet()){
 if(value&&typeof value==='object'&&!seen.has(value)){seen.add(value);for(const v of Object.values(value))freezeFeatureAsset(v,seen);Object.freeze(value);}return value;
}
/** Sorted-key canonical JSON, identical to registry digest, with bounded hash
 * updates and no complete expanded schema string. Inputs were inspected first. */
export function hashFeatureAsset(value){
 const hash=createHash('sha256');let chunk='';
 const emit=s=>{if(chunk.length+s.length>65536){hash.update(chunk);chunk='';}if(s.length>65536)hash.update(s);else chunk+=s;};
 function visit(v){
  if(v===null||['string','boolean','number'].includes(typeof v)){emit(JSON.stringify(v));return;}
  if(Array.isArray(v)){emit('[');for(let i=0;i<v.length;i++){if(i)emit(',');visit(v[i]);}emit(']');}
  else{emit('{');const keys=Object.keys(v).sort();for(let i=0;i<keys.length;i++){if(i)emit(',');emit(JSON.stringify(keys[i]));emit(':');visit(v[keys[i]]);}emit('}');}
 }
 visit(value);if(chunk)hash.update(chunk);return hash.digest('hex');
}
export function featureAssetRecord(value,bytes,dependencies=[]){return{value,bytes,dependencies,refs:0,anchor:Object.freeze({contract:'aegis.private-projection-asset.v1'})};}
export function retainFeatureAsset(arena,record){
 if(record?.value===null||!record)return null;const dependencies=[];
 for(const dependency of record.dependencies){const held=retainFeatureAsset(arena,dependency);if(!held){for(const x of dependencies)x.release();return null;}dependencies.push(held);}
 const lease=arena.retainAsset(record.anchor,record.bytes);if(!lease){for(const x of dependencies)x.release();return null;}
 record.refs++;let active=true;
 return Object.freeze({release(){if(!active)return false;active=false;lease.release();for(const x of dependencies)x.release();dependencies.length=0;if(--record.refs===0){record.value=null;record.dependencies=[];}return true;}});
}
export function withFeatureRelease(value,release){Object.defineProperty(value,'release',{value:release,enumerable:false});return value;}
