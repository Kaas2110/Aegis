/** Bounded local evidence. No provider, database or training imports. */
import {createHash} from 'node:crypto';
import {closeSync,existsSync,lstatSync,openSync,readFileSync,readSync} from 'node:fs';
import {dirname,isAbsolute,resolve,sep} from 'node:path';
export const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
export const valueSha=v=>sha(Buffer.from(stable(v)));
export function localFile(path,max=8*1024**2){
 if(!isAbsolute(path))throw Error('absolute_local_path_required');
 let cursor=resolve(path);while(true){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw Error('reparse_path_rejected');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
 const stat=lstatSync(path);if(!stat.isFile()||stat.size>max)throw Error('local_file_bound');return stat;
}
export function json(path,max){localFile(path,max);return JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));}
export function pinned(spec,max){if(!spec||!digest(spec.sha256))throw Error('pinned_descriptor_required');localFile(spec.path,max);const b=readFileSync(spec.path);if(sha(b)!==spec.sha256)throw Error('evidence_pin_changed');return JSON.parse(b.toString('utf8').replace(/^\uFEFF/,''));}
export function fileHash(path,max=8*1024**2){localFile(path,max);return sha(readFileSync(path));}
export function streamedPin(spec,budget){
 if(!spec||!digest(spec.sha256)||!Number.isSafeInteger(spec.bytes)||spec.bytes<0)throw Error('file_pin_required');
 const key=spec.path+'|'+spec.sha256+'|'+spec.bytes;if(budget.verified?.has(key))return spec.sha256;
 const stat=localFile(spec.path,budget.remaining);if(stat.size!==spec.bytes)throw Error('file_size_changed');budget.remaining-=stat.size;
 const fd=openSync(spec.path,'r'),h=createHash('sha256'),b=Buffer.alloc(1024**2);try{for(let n;(n=readSync(fd,b,0,b.length,null))>0;)h.update(b.subarray(0,n));}finally{closeSync(fd);}
 if(h.digest('hex')!==spec.sha256)throw Error('file_pin_changed');budget.verified?.add(key);return spec.sha256;
}
export function child(root,relative){const p=resolve(root,relative);if(!p.startsWith(resolve(root)+sep))throw Error('relative_file_escaped');return p;}
export function instant(s){const x=typeof s==='string'&&/T.*(Z|[+-]\d\d:\d\d)$/.test(s)?Date.parse(s):NaN;if(!Number.isFinite(x))throw Error('UTC_instant_required');return x;}
export function fresh(at,now,max=300000){try{return instant(at)<=instant(now)&&instant(now)-instant(at)<=max;}catch{return false;}}
export function lockDocument(path){
 localFile(path,65536);const b=readFileSync(path); // Preserve Win32 FILETIME beyond JS Number precision.
 const doc=JSON.parse(b.toString('utf8').replace(/("creationTime100ns"\s*:\s*)(\d{16,})/g,'$1"$2"'));
 return {doc,sha256:sha(b)};
}
export const identity=x=>x&&Number.isSafeInteger(x.pid)&&x.pid>0&&/^\d{16,20}$/.test(String(x.creationTime100ns))?{pid:x.pid,creationTime100ns:String(x.creationTime100ns)}:null;
