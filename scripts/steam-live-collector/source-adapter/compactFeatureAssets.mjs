/** Lossless opt-in v2 codecs. v1 schemas/vectors are neither rewritten nor retired.
 * Opaque handles own mutable typed storage; no caller receives its ArrayBuffer.
 * Arena charges are explicit conservative estimates, never measured JS heap size.
 */
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {measureBoundedJsonBytes} from './diagnosticResourceArena.mjs';
const SCHEMA='aegis.compact-feature-schema.v2',VECTOR='aegis.compact-feature-vector.v2';
const handles=new WeakMap(),SHA=/^[a-f0-9]{64}$/,MAX_FEATURES=150000,MAX_NODES=1000000,MAX_BYTES=256*1024*1024;
const MAX_DEFINITION_NODES=65536,MAX_DEFINITION_BYTES=1024*1024,MAX_EXPANDED_NODES=16000000,MAX_PAGE_BYTES=8*1024*1024,MAX_PAGE_NODES=262144;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),integer=(x,n)=>Number.isSafeInteger(x)&&x>=0&&x<n;
const fail=reason=>{throw Error('compact_feature_asset:'+reason);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function own(x,key){if(!x||typeof x!=='object'||types.isProxy(x))fail('owned_data_property');const d=Object.getOwnPropertyDescriptor(x,key);if(!d||!('value'in d))fail('owned_data_property');return d.value;}
function config({arena,workingBytes=128*1024*1024,maxWireBytes=MAX_BYTES}={}){
 if(typeof arena?.reserve!=='function'||typeof arena?.retainAsset!=='function'||!Number.isSafeInteger(workingBytes)||workingBytes<1024||workingBytes>2*1024**3||!Number.isSafeInteger(maxWireBytes)||maxWireBytes<1024||maxWireBytes>MAX_BYTES)fail('configuration');
 return{arena,workingBytes,maxWireBytes};
}
/** Canonical JSON pieces; no full logical schema string or definition array copy.
 * The format matches the existing sorted-object-key canonical JSON semantics. */
function* canonical(value,depth=0){
 if(depth>64)fail('json_depth');
 if(value===null||typeof value==='boolean'){yield JSON.stringify(value);return;}
 if(typeof value==='number'){if(!Number.isFinite(value))fail('nonfinite');yield JSON.stringify(value);return;}
 if(typeof value==='string'){if(value.length>4*1024*1024)fail('string_bound');yield JSON.stringify(value);return;}
 if(!value||typeof value!=='object'||types.isProxy(value)||!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)fail('plain_json');
 if(Array.isArray(value)){yield'[';for(let i=0;i<value.length;i++){if(i)yield',';yield*canonical(own(value,String(i)),depth+1);}yield']';}
 else{yield'{';const keys=Object.keys(value).sort();for(let i=0;i<keys.length;i++){if(i)yield',';yield JSON.stringify(keys[i]);yield':';yield*canonical(own(value,keys[i]),depth+1);}yield'}';}
}
function hashPieces(pieces){
 // Hash the SAME canonical byte stream while amortizing tiny JS/native crossings.
 // Caller working leases already include canonical scratch; retain <=32K UTF16
 // units plus one existing token (large tokens pass directly, never accumulate).
 const h=createHash('sha256');let pending='',high='';
 const push=part=>{if(pending&&pending.length+part.length>32768){h.update(pending);pending='';}if(part.length>=32768)h.update(part);else pending+=part;};
 for(const token of pieces){let part=high+token;high='';if(part.length&&part.charCodeAt(part.length-1)>=0xd800&&part.charCodeAt(part.length-1)<=0xdbff){high=part.slice(-1);part=part.slice(0,-1);}push(part);}
 push(high);if(pending)h.update(pending);return h.digest('hex');
}
// DAG reference count is not expanded size. Compute saturated costs once per
// node before any recursive decode/hash, counting repeated children every time.
const plus=(a,b,cap)=>a>cap||b>cap-a?cap+1:a+b;
function expansionProfile(wire){
 let maximumStringTokenBytes=0;const strings=wire.strings.map(s=>{const bytes=Buffer.byteLength(JSON.stringify(s));maximumStringTokenBytes=Math.max(maximumStringTokenBytes,bytes);return bytes;}),costs=[];
 for(const node of wire.nodes){let nodes=1,bytes=0,depth=0;
  if(node[0]===0)bytes=4;else if(node[0]===1)bytes=node[1]?4:5;else if(node[0]===2)bytes=JSON.stringify(node[1]==='-0'?-0:node[1]).length;else if(node[0]===3)bytes=strings[node[1]];
  else{const refs=node[0]===4?node[1]:node[2];bytes=2+Math.max(0,refs.length-1);for(let i=0;i<refs.length;i++){
   const child=costs[refs[i]];nodes=plus(nodes,child.nodes,MAX_DEFINITION_NODES);bytes=plus(bytes,child.bytes,MAX_DEFINITION_BYTES);depth=Math.max(depth,child.depth+1);
   if(node[0]===5)bytes=plus(bytes,strings[wire.shapes[node[1]][i]]+1,MAX_DEFINITION_BYTES);
  }}costs.push({nodes,bytes,depth});
 }
 const headerBytes=measureBoundedJsonBytes(wire.header,{maxBytes:1024*1024,maxNodes:200000,maxDepth:62});let headerNodes=0;
 function countHeader(value){if(++headerNodes>200000)fail('header_node_bound');if(Array.isArray(value)){for(let i=0;i<value.length;i++)countHeader(own(value,String(i)));}else if(object(value))for(const key of Object.keys(value))countHeader(own(value,key));}
 countHeader(wire.header);let totalNodes=headerNodes+1,totalBytes=2,maximumDefinitionWorkBytes=0;const definitions=[];
 for(const ref of wire.definitionRefs){const cost=costs[ref];if(!cost||cost.nodes>MAX_DEFINITION_NODES||cost.bytes>MAX_DEFINITION_BYTES||cost.depth>62)fail('expanded_definition_bound');definitions.push(cost);maximumDefinitionWorkBytes=Math.max(maximumDefinitionWorkBytes,cost.nodes*64+cost.bytes*4);totalNodes=plus(totalNodes,cost.nodes,MAX_EXPANDED_NODES);totalBytes=plus(totalBytes,cost.bytes+1,MAX_BYTES);if(totalNodes>MAX_EXPANDED_NODES||totalBytes>MAX_BYTES)fail('expanded_schema_bound');}
 totalBytes=plus(totalBytes,headerBytes+32,MAX_BYTES);if(totalBytes>MAX_BYTES)fail('expanded_schema_bound');
 return{definitions,headerBytes,headerNodes,maximumDefinitionWorkBytes,maximumTokenBytes:Math.max(headerBytes,maximumStringTokenBytes),expandedNodeCostUpper:totalNodes,expandedSchemaBytesUpper:totalBytes};
}
function requireDecodeWorking(wire,profile,workingBytes){
 const encodedBytes=measureBoundedJsonBytes({...wire,namesHash:'0'.repeat(64)},{maxBytes:MAX_BYTES,maxNodes:16000000});
 const required=encodedBytes*4+wire.featureCount*16+profile.maximumDefinitionWorkBytes+profile.headerNodes*64+profile.headerBytes*4+65536;
 if(required>workingBytes)fail('expanded_working_reservation_too_small');
}
function definitionName(wire,ref){const node=wire.nodes[ref];if(node?.[0]!==5)fail('definition_reference');const i=wire.shapes[node[1]].findIndex(key=>wire.strings[key]==='name');if(i<0)fail('definition_name');const name=decodeNode(wire,node[2][i]);if(typeof name!=='string')fail('definition_name');return name;}
function* expandedSchema(wire){
 yield'{';const keys=[...Object.keys(wire.header),'definitions'].sort();
 for(let i=0;i<keys.length;i++){if(i)yield',';const key=keys[i];yield JSON.stringify(key);yield':';
  if(key==='definitions'){yield'[';for(let j=0;j<wire.definitionRefs.length;j++){if(j)yield',';yield*canonical(decodeNode(wire,wire.definitionRefs[j]));}yield']';}
  else yield*canonical(wire.header[key]);
 }yield'}';
}
function namesHash(wire){
 function* names(){yield'[';for(let i=0;i<wire.definitionRefs.length;i++){if(i)yield',';yield JSON.stringify(definitionName(wire,wire.definitionRefs[i]));}yield']';}
 return hashPieces(names());
}
function decodeNode(wire,ref,depth=0){
 if(depth>64)fail('node_depth');const n=wire.nodes[ref];
 if(n[0]===0)return null;if(n[0]===1)return Boolean(n[1]);if(n[0]===2)return n[1]==='-0'?-0:n[1];if(n[0]===3)return wire.strings[n[1]];
 if(n[0]===4)return n[1].map(child=>decodeNode(wire,child,depth+1));
 return Object.fromEntries(wire.shapes[n[1]].map((key,i)=>[wire.strings[key],decodeNode(wire,n[2][i],depth+1)]));
}
function factorSchema(schema,expectedSchemaHash,workingBytes){
 if(!object(schema)||own(schema,'contract')!=='aegis.unified-feature-projection-schema.v1')fail('schema_contract');
 const definitions=own(schema,'definitions');if(!Array.isArray(definitions)||definitions.length>MAX_FEATURES)fail('definition_bound');
 // Bound the encoded construction itself, before allocating its containers or
 // serialization keys. A later logical-expansion check cannot fund these copies.
 let heldBytes=0,maximumStringLength=0;
 const room=bytes=>{if(!Number.isSafeInteger(bytes)||bytes<0||bytes>workingBytes-heldBytes)fail('factoring_working_reservation_too_small');};
 const hold=bytes=>{room(bytes);heldBytes+=bytes;},drop=bytes=>{heldBytes-=bytes;};
 hold(65536);
 const strings=[],shapes=[],nodes=[],stringMap=new Map(),shapeMap=new Map(),nodeMap=new Map(),memo=new WeakMap(),active=new WeakSet();
 const text=s=>{if(typeof s!=='string'||s.length>1024*1024)fail('string_bound');if(!stringMap.has(s)){if(strings.length>=MAX_NODES)fail('dictionary_bound');hold(s.length*2+128);maximumStringLength=Math.max(maximumStringLength,s.length);stringMap.set(s,strings.length);strings.push(s);}return stringMap.get(s);};
 function keysOf(value,maximum){
  hold(64);const keys=[];for(const key in value)if(Object.hasOwn(value,key)){if(keys.length>=maximum)fail('definition_shape_bound');hold(16);keys.push(key);}keys.sort();return{keys,charge:64+keys.length*16};
 }
 function inspectHeader(value){
  let bytes=0,nodes=0;const ancestors=new Set();
  const add=n=>{bytes+=n;if(bytes>1024*1024)fail('header_byte_bound');room(bytes*16+nodes*64+65536);};
  function visit(v,depth=0){
   if(++nodes>200000||depth>64)fail('header_node_bound');
   if(v===null||['string','boolean','number'].includes(typeof v)){add(measureBoundedJsonBytes(v,{maxBytes:1024*1024,maxNodes:1}));return;}
   if(!v||typeof v!=='object'||types.isProxy(v)||ancestors.has(v)||!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('plain_header');
   ancestors.add(v);add(2);
   if(Array.isArray(v)){if(v.length>200000-nodes)fail('header_node_bound');room(v.length*16+65536);for(let i=0;i<v.length;i++){if(i)add(1);visit(own(v,String(i)),depth+1);}}
   else{let count=0;for(const key in v)if(Object.hasOwn(v,key)){const child=own(v,key);if(child===undefined)continue;if(count++)add(1);add(measureBoundedJsonBytes(key,{maxBytes:1024*1024,maxNodes:1})+1);visit(child,depth+1);}}
   ancestors.delete(v);
  }
  visit(value);return{bytes,charge:bytes*16+nodes*64+65536};
 }
 function encode(v,depth=0){
  if(depth>64)fail('node_depth');if(types.isProxy(v))fail('plain_definition');if(v&&typeof v==='object'){if(active.has(v))fail('cyclic_definition');if(memo.has(v))return memo.get(v);hold(64);active.add(v);}let node,nodeCharge=128,temporary=0;hold(nodeCharge);
  if(v===null)node=[0];else if(typeof v==='boolean')node=[1,Number(v)];else if(typeof v==='number'&&Number.isFinite(v))node=[2,Object.is(v,-0)?'-0':v];else if(typeof v==='string')node=[3,text(v)];
  else if(Array.isArray(v)){if(v.length>MAX_FEATURES)fail('array_bound');hold(v.length*16);nodeCharge+=v.length*16;node=[4,Array.from({length:v.length},(_,i)=>encode(own(v,String(i)),depth+1))];}
  else if(object(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null)){
   const listed=keysOf(v,256),keys=listed.keys;temporary+=listed.charge;const keyRefsCharge=64+keys.length*16,shapeKeyCharge=4+keys.length*14;hold(keyRefsCharge+shapeKeyCharge);const keyRefs=keys.map(text),shapeKey=JSON.stringify(keyRefs);let shape=shapeMap.get(shapeKey);
   if(shape===undefined){hold(128);shape=shapes.length;shapes.push(keyRefs);shapeMap.set(shapeKey,shape);}else temporary+=keyRefsCharge+shapeKeyCharge;
   hold(keys.length*16);nodeCharge+=keys.length*16;node=[5,shape,keys.map(key=>encode(own(v,key),depth+1))];
  }else fail('plain_definition');
  const keyCharge=node[0]===4?64+node[1].length*14:node[0]===5?64+node[2].length*14:128;hold(keyCharge);const key=JSON.stringify(node);if(!nodeMap.has(key)){if(nodes.length>=MAX_NODES)fail('node_bound');hold(128);nodeMap.set(key,nodes.length);nodes.push(node);}else drop(nodeCharge+keyCharge);const ref=nodeMap.get(key);if(v&&typeof v==='object'){active.delete(v);memo.set(v,ref);}drop(temporary);return ref;
 }
 hold(64+definitions.length*16);const refs=[];for(let i=0;i<definitions.length;i++){const d=own(definitions,String(i));if(!object(d)||typeof own(d,'name')!=='string')fail('definition_name');refs.push(encode(d));}
 const listed=keysOf(schema,200000);hold(128+listed.keys.length*96);const header={};for(const key of listed.keys)if(key!=='definitions')Object.defineProperty(header,key,{value:own(schema,key),enumerable:true});drop(listed.charge);
 const headerProfile=inspectHeader(header);hold(headerProfile.charge);
 const wire={contract:SCHEMA,expandedSchemaHash:expectedSchemaHash,namesHash:null,featureCount:refs.length,header:structuredClone(header),strings,shapes,nodes,definitionRefs:refs};
 hold(nodes.length*96+refs.length*16+strings.length*16+maximumStringLength*12+65536);const expansion=expansionProfile(wire);requireDecodeWorking(wire,expansion,workingBytes);room(expansion.maximumDefinitionWorkBytes+expansion.headerBytes*4+refs.length*16+65536);if(hashPieces(canonical(schema))!==expectedSchemaHash||hashPieces(expandedSchema(wire))!==expectedSchemaHash)fail('expanded_schema_hash');wire.namesHash=namesHash(wire);return{wire,expansion};
}
function schemaWire(wire,workingBytes){
 if(!object(wire)||wire.contract!==SCHEMA||!SHA.test(wire.expandedSchemaHash??'')||!SHA.test(wire.namesHash??'')||!Number.isSafeInteger(wire.featureCount)||wire.featureCount<0||wire.featureCount>MAX_FEATURES||!object(wire.header)||Object.hasOwn(wire.header,'definitions')||wire.header.contract!=='aegis.unified-feature-projection-schema.v1'||!Array.isArray(wire.strings)||wire.strings.length>MAX_NODES||wire.strings.some(s=>typeof s!=='string'||s.length>1024*1024)||!Array.isArray(wire.shapes)||wire.shapes.length>MAX_NODES||!Array.isArray(wire.nodes)||wire.nodes.length>MAX_NODES||!Array.isArray(wire.definitionRefs)||wire.definitionRefs.length!==wire.featureCount)fail('schema_wire');
 for(const shape of wire.shapes)if(!Array.isArray(shape)||shape.length>256||shape.some((ref,i)=>!integer(ref,wire.strings.length)||i>0&&wire.strings[shape[i-1]]>=wire.strings[ref]))fail('shape');
 for(let i=0;i<wire.nodes.length;i++){
  const n=wire.nodes[i];if(!Array.isArray(n)||!integer(n[0],6))fail('node');
  if(n[0]===0&&n.length!==1||n[0]===1&&(n.length!==2||![0,1].includes(n[1]))||n[0]===2&&(n.length!==2||n[1]!=='-0'&&(typeof n[1]!=='number'||!Number.isFinite(n[1])))||n[0]===3&&(n.length!==2||!integer(n[1],wire.strings.length)))fail('primitive_node');
  if(n[0]===4&&(n.length!==2||!Array.isArray(n[1])||n[1].length>MAX_FEATURES||n[1].some(ref=>!integer(ref,i))))fail('array_node');
  if(n[0]===5&&(n.length!==3||!integer(n[1],wire.shapes.length)||!Array.isArray(n[2])||n[2].length!==wire.shapes[n[1]].length||n[2].some(ref=>!integer(ref,i))))fail('object_node');
 }
 for(const ref of wire.definitionRefs)if(!integer(ref,wire.nodes.length))fail('definition_reference');
 const expansion=expansionProfile(wire);requireDecodeWorking(wire,expansion,workingBytes);
 for(const ref of wire.definitionRefs)definitionName(wire,ref);
 if(hashPieces(expandedSchema(wire))!==wire.expandedSchemaHash||namesHash(wire)!==wire.namesHash)fail('expanded_schema_hash');
 return{wire,expansion};
}
function entry(handle){const h=handles.get(handle);if(!h?.record)fail('owned_active_handle');return h;}
function recordHandle(record,lease){const handle=Object.freeze({contract:'aegis.compact-feature-asset.private.v1'});record.refs++;handles.set(handle,{record,lease});return handle;}
function install(record){const lease=record.arena.retainAsset(record.anchor,record.chargedBytes);return lease?recordHandle(record,lease):null;}
export function retainCompactFeatureAsset(handle){const r=entry(handle).record;return install(r);}
export function releaseCompactFeatureAsset(handle){const held=handles.get(handle);if(!held?.record)return false;const r=held.record;held.record=null;held.lease.release();held.lease=null;if(--r.refs===0){r.data=null;if(r.schemaHold)releaseCompactFeatureAsset(r.schemaHold);r.schemaHold=null;}return true;}
export function describeCompactFeatureAsset(handle){const r=entry(handle).record;return Object.freeze({...r.descriptor,chargedBytes:r.chargedBytes,dependencyChargedBytes:r.schemaHold?entry(r.schemaHold).record.chargedBytes:0,activeReferences:r.refs,decodedPageDefinitions:r.decodedPageDefinitions,accounting:'conservative_explicit_estimates_not_measured_heap'});}
function makeRecord(data,c,descriptor,wireBytes,{schemaHold=null}={}){
 const chargedBytes=wireBytes*4+descriptor.featureCount*16+65536;if(!Number.isSafeInteger(chargedBytes)||chargedBytes>c.workingBytes)fail('working_reservation_too_small');
 return{data,arena:c.arena,descriptor:freeze(descriptor),chargedBytes,anchor:Object.freeze({contract:descriptor.contract,hash:descriptor.expandedSchemaHash}),refs:0,decodedPageDefinitions:0,schemaHold};
}
/** Reserve before walking/copying/hashing. null means denied; validation throws. */
export function createCompactFeatureSchema(schema,{expectedSchemaHash,...options}={}){
 const c=config(options),work=c.arena.reserve(c.workingBytes);if(!work)return null;
 try{if(!SHA.test(expectedSchemaHash??''))fail('expected_schema_hash');const {wire,expansion}=factorSchema(schema,expectedSchemaHash,c.workingBytes),wireBytes=measureBoundedJsonBytes(wire,{maxBytes:c.maxWireBytes,maxNodes:16000000});
  const record=makeRecord(freeze(wire),c,{contract:SCHEMA,expandedSchemaHash:expectedSchemaHash,namesHash:wire.namesHash,featureCount:wire.featureCount,wireBytes},wireBytes);record.expansion=expansion;return install(record);
 }finally{work.release();}
}
function vectorWire(record){
 const {values,bitmap}=record.data,buffer=Buffer.allocUnsafe(values.length*8);for(let i=0;i<values.length;i++)buffer.writeDoubleLE(values[i],i*8);
 return{contract:VECTOR,expandedSchemaHash:record.descriptor.expandedSchemaHash,namesHash:record.descriptor.namesHash,featureCount:values.length,valuesFloat64LEHex:buffer.toString('hex'),missingBitmapHex:Buffer.from(bitmap).toString('hex')};
}
export function createCompactFeatureVector(input,options={}){
 const c=config(options),work=c.arena.reserve(c.workingBytes);if(!work)return null;let dependency=null,installed=false;
 try{
  if(!object(input))fail('vector_input');const schemaHandle=own(input,'schemaHandle'),schema=entry(schemaHandle).record;
  if(schema.descriptor.contract!==SCHEMA||schema.arena!==c.arena)fail('schema_owner');const names=own(input,'names'),values=own(input,'values'),missing=own(input,'missing'),n=schema.descriptor.featureCount;
  if((n*16+Math.ceil(n/8)*2+512)*4+n*16+65536>c.workingBytes)fail('working_reservation_too_small');
  if(!Array.isArray(names)||!Array.isArray(values)||!Array.isArray(missing)||[names,values,missing].some(a=>a.length!==n)||hashPieces(canonical(names))!==schema.descriptor.namesHash)fail('vector_order_or_shape');
  const numbers=new Float64Array(n),bitmap=new Uint8Array(Math.ceil(n/8));
  for(let i=0;i<n;i++){const v=own(values,String(i)),m=own(missing,String(i));if(typeof m!=='boolean'||m!==(v===null)||v!==null&&(typeof v!=='number'||!Number.isFinite(v)))fail('vector_value_or_missing');if(m)bitmap[i>>3]|=1<<(i&7);else numbers[i]=v;}
  dependency=retainCompactFeatureAsset(schemaHandle);if(!dependency)return null;
  const wireBytes=names.length*16+bitmap.length*2+512;if(wireBytes>c.maxWireBytes)fail('wire_bound');const record=makeRecord({values:numbers,bitmap},c,{contract:VECTOR,expandedSchemaHash:schema.descriptor.expandedSchemaHash,namesHash:schema.descriptor.namesHash,featureCount:n,wireBytes},wireBytes,{schemaHold:dependency}),handle=install(record);installed=handle!==null;return handle;
 }finally{if(dependency&&!installed)releaseCompactFeatureAsset(dependency);work.release();}
}
function page(offset,limit,count){if(!Number.isSafeInteger(offset)||offset<0||offset>count||!Number.isSafeInteger(limit)||limit<1||limit>1000)fail('page_bound');return Math.min(count,offset+limit);}
function pageReservation(record,offset,end,{vector=false}={}){
 let bytes=record.expansion.headerBytes,nodes=0;
 for(let i=offset;i<end;i++){const cost=record.expansion.definitions[i];bytes=plus(bytes,cost.bytes,MAX_PAGE_BYTES);nodes=plus(nodes,cost.nodes,MAX_PAGE_NODES);if(bytes>MAX_PAGE_BYTES||nodes>MAX_PAGE_NODES)fail('page_expansion_bound');}
 const charge=bytes*4+(nodes+record.expansion.headerNodes)*64+(vector?(end-offset)*32:0)+65536;return record.arena.reserve(charge);
}
function leasedPage(result,lease){Object.defineProperty(result,'release',{value:()=>lease.release(),enumerable:false});return result;}
// Encoding chunks bounds the sink writes, not JSON.stringify's complete scalar
// tokens or vectorWire's temporary byte/hex buffers. Admit those before either
// allocation, using token costs computed when the owned schema was admitted.
function encodingWorkingBytes(record,chunkCodeUnits){
 const scratch=chunkCodeUnits*12+65536;
 if(record.descriptor.contract===VECTOR){const n=record.descriptor.featureCount;return n*72+Math.ceil(n/8)*9+scratch;}
 return record.expansion.maximumTokenBytes*2+record.expansion.headerNodes*16+scratch;
}
export function readCompactSchemaPage(handle,{offset=0,limit=200}={}){
 const r=entry(handle).record;if(r.descriptor.contract!==SCHEMA)fail('schema_handle');const end=page(offset,limit,r.descriptor.featureCount),lease=pageReservation(r,offset,end);if(!lease)return null;
 try{const definitions=[];for(let i=offset;i<end;i++){definitions.push(decodeNode(r.data,r.data.definitionRefs[i]));r.decodedPageDefinitions++;}
  return leasedPage({offset,nextOffset:end<r.descriptor.featureCount?end:null,total:r.descriptor.featureCount,expandedSchemaHash:r.descriptor.expandedSchemaHash,header:structuredClone(r.data.header),definitions},lease);
 }catch(error){lease.release();throw error;}
}
export function readCompactVectorPage(handle,{offset=0,limit=200}={}){
 const r=entry(handle).record;if(r.descriptor.contract!==VECTOR)fail('vector_handle');const end=page(offset,limit,r.descriptor.featureCount),schema=entry(r.schemaHold).record,lease=pageReservation(schema,offset,end,{vector:true});if(!lease)return null;
 try{const names=[],values=[],missing=[];for(let i=offset;i<end;i++){names.push(definitionName(schema.data,schema.data.definitionRefs[i]));const m=Boolean(r.data.bitmap[i>>3]&(1<<(i&7)));missing.push(m);values.push(m?null:r.data.values[i]);}
  return leasedPage({offset,nextOffset:end<r.descriptor.featureCount?end:null,total:r.descriptor.featureCount,names,values,missing,expandedSchemaHash:r.descriptor.expandedSchemaHash},lease);
 }catch(error){lease.release();throw error;}
}
/** Synchronous bounded chunks: an opaque retain pins the asset during callbacks.
 * The returned digest/length binds the exact new wire bytes, not provider truth. */
export function writeCompactFeatureAssetChunks(handle,emit,{chunkCodeUnits=32768,workingBytes=16*1024*1024}={}){
 const r=entry(handle).record;if(typeof emit!=='function'||!Number.isSafeInteger(chunkCodeUnits)||chunkCodeUnits<128||chunkCodeUnits>65536)fail('chunk_sink');
 const c=config({arena:r.arena,workingBytes});if(encodingWorkingBytes(r,chunkCodeUnits)>c.workingBytes)fail('encoding_working_reservation_too_small');const work=c.arena.reserve(workingBytes);if(!work)return null;const hold=retainCompactFeatureAsset(handle);if(!hold){work.release();return null;}
 try{const wire=r.descriptor.contract===SCHEMA?r.data:vectorWire(r),hash=createHash('sha256');let bytes=0,pending='';
  const flush=()=>{if(!pending)return;bytes+=Buffer.byteLength(pending);if(bytes>MAX_BYTES)fail('wire_bound');hash.update(pending);emit(pending);pending='';};
  for(const part of canonical(wire))for(let start=0;start<part.length;){let end=Math.min(part.length,start+chunkCodeUnits-pending.length);if(end<part.length&&part.charCodeAt(end-1)>=0xd800&&part.charCodeAt(end-1)<=0xdbff&&part.charCodeAt(end)>=0xdc00&&part.charCodeAt(end)<=0xdfff)end--;if(end===start){flush();continue;}pending+=part.slice(start,end);start=end;if(pending.length===chunkCodeUnits)flush();}flush();
  return Object.freeze({contract:r.descriptor.contract,sha256:hash.digest('hex'),bytes,expandedSchemaHash:r.descriptor.expandedSchemaHash});
 }finally{releaseCompactFeatureAsset(hold);work.release();}
}
/** New-wire intake only. Both external semantic and exact artifact references
 * are required; a self-rehashed vector receipt is not its own authority. */
export function loadCompactFeatureAsset(receipt,{expectedSchemaHash,expectedArtifactSha256=null,schemaHandle=null,...options}={}){
 const c=config(options),work=c.arena.reserve(c.workingBytes);if(!work)return null;let dependency=null,installed=false;
 try{
  if(!SHA.test(expectedSchemaHash??'')||!SHA.test(expectedArtifactSha256??'')||!object(receipt)||typeof own(receipt,'utf8')!=='string')fail('wire_receipt');const utf8=own(receipt,'utf8');if(utf8.length>c.maxWireBytes)fail('wire_hash_or_bound');const bytes=Buffer.byteLength(utf8);if(bytes>c.maxWireBytes||own(receipt,'bytes')!==bytes)fail('wire_hash_or_bound');const hash=createHash('sha256').update(utf8).digest('hex');
  if(own(receipt,'sha256')!==hash||expectedArtifactSha256!==hash)fail('wire_hash_or_bound');if(bytes*4+65536>c.workingBytes)fail('working_reservation_too_small');const wire=JSON.parse(utf8);
  if(wire.expandedSchemaHash!==expectedSchemaHash)fail('expected_schema_hash');let record;
  if(wire.contract===SCHEMA){const {expansion}=schemaWire(wire,c.workingBytes);record=makeRecord(freeze(wire),c,{contract:SCHEMA,expandedSchemaHash:expectedSchemaHash,namesHash:wire.namesHash,featureCount:wire.featureCount,wireBytes:bytes},bytes);record.expansion=expansion;}
  else if(wire.contract===VECTOR){
   const schema=entry(schemaHandle).record,n=wire.featureCount;
   if(schema.descriptor.contract!==SCHEMA||schema.arena!==c.arena||schema.descriptor.expandedSchemaHash!==expectedSchemaHash||n!==schema.descriptor.featureCount||wire.namesHash!==schema.descriptor.namesHash||typeof wire.valuesFloat64LEHex!=='string'||wire.valuesFloat64LEHex.length!==n*16||!/^[a-f0-9]*$/.test(wire.valuesFloat64LEHex)||typeof wire.missingBitmapHex!=='string'||wire.missingBitmapHex.length!==Math.ceil(n/8)*2||!/^[a-f0-9]*$/.test(wire.missingBitmapHex))fail('vector_wire');
   const raw=Buffer.from(wire.valuesFloat64LEHex,'hex'),numbers=new Float64Array(n),bitmap=new Uint8Array(Buffer.from(wire.missingBitmapHex,'hex'));
   if(n%8&&bitmap.at(-1)>>(n%8))fail('bitmap_padding');for(let i=0;i<n;i++){const value=raw.readDoubleLE(i*8),m=Boolean(bitmap[i>>3]&(1<<(i&7)));if(!Number.isFinite(value)||m&&!Object.is(value,0))fail('vector_wire_value');numbers[i]=value;}
   dependency=retainCompactFeatureAsset(schemaHandle);if(!dependency)return null;record=makeRecord({values:numbers,bitmap},c,{contract:VECTOR,expandedSchemaHash:expectedSchemaHash,namesHash:wire.namesHash,featureCount:n,wireBytes:bytes},bytes,{schemaHold:dependency});
  }else fail('wire_contract');
  const handle=install(record);installed=handle!==null;return handle;
 }finally{if(dependency&&!installed)releaseCompactFeatureAsset(dependency);work.release();}
}
