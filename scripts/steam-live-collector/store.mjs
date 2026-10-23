/** Private local Steam diagnostic archive; never edits existing provider/ML tables. */
import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,existsSync,lstatSync,rmSync,rmdirSync} from 'node:fs';
import {join,resolve,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export const VERSION='steam-live-diagnostic-collector.v1';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const iso=ms=>new Date(ms).toISOString();
export function boundedFile(path,max=1024**2){if(!isAbsolute(path)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()||lstatSync(path).size>max)throw Error('local_file_bound');const b=readFileSync(path);if(b.length>max)throw Error('local_file_bound');return b;}
function safe(root,rel){const p=resolve(root,rel);if(!p.startsWith(resolve(root)+sep))throw Error('archive_path');let cursor=p;while(cursor.length>=resolve(root).length){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw Error('archive_reparse_point');if(cursor===resolve(root))break;cursor=resolve(cursor,'..');}return p;}
export function atomic(root,name,value){const target=safe(root,name),tmp=target+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});renameSync(tmp,target);}
export function immutable(root,rel,bytes){const p=safe(root,rel);try{writeFileSync(p,bytes,{flag:'wx',mode:0o600,flush:true});}catch(e){if(e.code!=='EEXIST'||!readFileSync(p).equals(Buffer.from(bytes)))throw Error('immutable_archive_conflict');}}
export function openArchive(root,owner,at){
 if(!isAbsolute(root))throw Error('absolute_archive_required');mkdirSync(root,{recursive:true});safe(root,'STATE.json');
 const lock=safe(root,'request.lock');try{mkdirSync(lock);}catch(e){if(e.code==='EEXIST')throw Error('collector_lock_requires_manual_review');throw e;}
 const nonce=randomUUID();try{writeFileSync(join(lock,'owner.json'),JSON.stringify({version:VERSION,nonce,pid:process.pid,sessionOwner:owner,acquiredAt:iso(at)})+'\n',{flag:'wx',mode:0o600,flush:true});}catch(e){throw Error('collector_lock_owner_write_failed');}
 for(const dir of ['raw','requests','observations','normalized'])mkdirSync(safe(root,dir),{recursive:true});
 return {nonce,release(){const p=join(lock,'owner.json');const saved=JSON.parse(readFileSync(p));if(saved.nonce!==nonce)throw Error('collector_lock_owner_changed');rmSync(p);rmdirSync(lock);}};
}
export function loadState(root){
 const p=safe(root,'STATE.json');if(!existsSync(p)){
  if(readdirSync(join(root,'requests')).length)throw Error('quota_ledger_missing_with_reservations');
  return {version:VERSION,dayCounts:{},lastAttemptAt:null,nextAttemptAt:null,lastSuccessfulAt:null,lastGamesCount:null,consecutiveFailures:0,authBlocked403:false,lastRawSha256:null};
 }
 const s=JSON.parse(boundedFile(p));if(s.version!==VERSION||!s.dayCounts||Array.isArray(s.dayCounts)||Object.keys(s.dayCounts).length>400||!Number.isSafeInteger(s.consecutiveFailures)||s.consecutiveFailures<0||typeof s.authBlocked403!=='boolean')throw Error('invalid_quota_ledger');
 for(const [day,count]of Object.entries(s.dayCounts))if(!/^\d{4}-\d\d-\d\d$/.test(day)||!Number.isSafeInteger(count)||count<0||count>1000)throw Error('invalid_quota_ledger');
 for(const key of ['lastAttemptAt','nextAttemptAt','lastSuccessfulAt'])if(s[key]!==null&&(!Number.isFinite(Date.parse(s[key]))||typeof s[key]!=='string'))throw Error('invalid_quota_ledger');
 if(!(s.lastGamesCount===null||(Number.isSafeInteger(s.lastGamesCount)&&s.lastGamesCount>=0&&s.lastGamesCount<=512)))throw Error('invalid_quota_ledger');
 return s;
}
export function reserve(root,state,at){
 const day=iso(at).slice(0,10),folder=safe(root,'requests/'+day);mkdirSync(folder,{recursive:true});
 const names=readdirSync(folder);if(names.length!==Number(state.dayCounts[day]??0)||names.length>=1000||names.some(n=>!/^\d{13}-[a-f0-9-]{36}\.json$/.test(n)))throw Error(names.length>=1000?'daily_quota_exhausted':'quota_reservation_ledger_mismatch');
 if(Object.keys(state.dayCounts).length>=400&&!Object.hasOwn(state.dayCounts,day))throw Error('quota_day_inventory_requires_manual_archive');
 const requestId=String(at)+'-'+randomUUID();immutable(root,'requests/'+day+'/'+requestId+'.json',Buffer.from(JSON.stringify({version:VERSION,requestId,requestedAt:iso(at),endpoint:'GetLiveLeagueGames/v1',reservationUnit:1,diagnosticOnly:true})+'\n'));
 state.dayCounts[day]=names.length+1;state.lastAttemptAt=iso(at);state.nextAttemptAt=iso(at+120000);atomic(root,'STATE.json',state);return requestId;
}
