/** Exact legacy canonical byte grammar, streamed in bounded chunks. This changes
 * allocation only: object keys sorted, arrays ordered, JSON scalar encoding and
 * even the legacy array-empty/object-undefined distinction are preserved. */
import {createHash} from 'node:crypto';
export function hashCanonicalEvidence(value){
 const hash=createHash('sha256'),parts=[],active=new Set();let chars=0;
 const flush=()=>{if(parts.length){hash.update(parts.join(''));parts.length=0;chars=0;}};
 const push=part=>{if(chars+part.length>65536)flush();if(part.length>65536)hash.update(part);else{parts.push(part);chars+=part.length;}};
 function visit(x,position='root'){
  if(x!==null&&typeof x==='object'){
   if(active.has(x))throw Error('canonical_evidence_hash:cyclic_data');active.add(x);
   try{if(Array.isArray(x)){push('[');for(let i=0;i<x.length;i++){if(i)push(',');if(i in x)visit(x[i],'array');}push(']');}
    else{push('{');const keys=Object.keys(x).sort();for(let i=0;i<keys.length;i++){if(i)push(',');const key=keys[i];push(JSON.stringify(key));push(':');visit(x[key],'object');}push('}');}
   }finally{active.delete(x);}return;
  }
  const scalar=JSON.stringify(x);if(scalar!==undefined)push(scalar);else if(position==='object')push('undefined');else if(position==='root')throw TypeError('canonical_evidence_hash:undefined_root');
 }
 visit(value);flush();return hash.digest('hex');
}
