import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,lstat,realpath,symlink} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {createRetainedHistoryRevisionStore,REVISION_POINTER_CONTRACT} from './retainedHistoryRevisionStore.mjs';
const KEY='a'.repeat(64),SOURCE='b'.repeat(64),OTHER='c'.repeat(64);
const payload=(source=SOURCE)=>({reference:{contract:'aegis.history-source-export-reference.v1',sha256:source,bytes:1234},sourceSnapshotHash:source});
const sha=x=>createHash('sha256').update(x).digest('hex');
const file=(dir,key=KEY)=>join(dir,key+'.history-revision.json');
async function withRoot(fn){
 const dir=await mkdtemp(join(tmpdir(),'aegis-revision-store-test-'));
 try{return await fn(dir);}finally{const expected=resolve(tmpdir())+sep+'aegis-revision-store-test-';if(!resolve(dir).startsWith(expected)||await realpath(dir)!==resolve(dir))throw Error('test_cleanup_target_not_owned');await rm(dir,{recursive:true,force:true});}
}

test('existing pointer survives restart and prevents a mutable DB/source requery',async()=>withRoot(async dir=>{
 let builds=0,current=SOURCE;const one=await createRetainedHistoryRevisionStore(dir),first=await one.getOrCreate(KEY,async()=>{builds++;return payload(current);});assert.equal(first.created,true);current=OTHER;
 const restarted=await createRetainedHistoryRevisionStore(dir),again=await restarted.getOrCreate(KEY,async()=>{builds++;return payload(current);});assert.equal(again.created,false);assert.equal(builds,1);assert.equal(again.sourceSnapshotHash,SOURCE);assert.deepEqual((await restarted.load(KEY)).reference,payload().reference);
 const body=JSON.parse(await readFile(file(dir),'utf8'));assert.equal(body.contract,REVISION_POINTER_CONTRACT);assert.deepEqual(Object.keys(body).sort(),['contract','key','reference','sourceSnapshotHash','contentHash'].sort());const {contentHash,...without}=body;assert.equal(contentHash,sha(JSON.stringify(without)));assert.ok((await lstat(file(dir))).size<8192);assert.deepEqual((await readdir(dir)),[KEY+'.history-revision.json']);
}));
test('one materialization across simultaneous same-instance and independent-instance callers',async()=>withRoot(async dir=>{
 const stores=await Promise.all(Array.from({length:4},()=>createRetainedHistoryRevisionStore(dir)));let builds=0;
 const builder=async()=>{builds++;await delay(40);return payload();};const rows=await Promise.all(Array.from({length:24},(_,i)=>stores[i%4].getOrCreate(KEY,builder)));assert.equal(builds,1);assert.ok(rows.every(r=>r.sourceSnapshotHash===SOURCE));assert.ok(rows.some(r=>r.created));assert.ok(rows.some(r=>!r.created));assert.equal((await readdir(dir)).filter(n=>n.endsWith('.lock')).length,0);
}));
test('independent Node processes share the filesystem lock and reuse one immutable pointer',async()=>withRoot(async dir=>{
 const moduleUrl=new URL('./retainedHistoryRevisionStore.mjs',import.meta.url).href;
 const script=`import {createRetainedHistoryRevisionStore} from ${JSON.stringify(moduleUrl)};import {appendFile} from 'node:fs/promises';import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';const s=await createRetainedHistoryRevisionStore(${JSON.stringify(dir)});const r=await s.getOrCreate('${KEY}',async()=>{await appendFile(join(${JSON.stringify(dir)},'synthetic-builds.txt'),'built\\n');await delay(40);return ${JSON.stringify(payload())};});process.stdout.write(JSON.stringify(r));`;
 const run=()=>new Promise(resolve=>{const child=spawn(process.execPath,['--input-type=module','--eval',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},10000);child.stdout.on('data',b=>{stdout+=b;if(stdout.length>16384)child.kill();});child.stderr.on('data',b=>{stderr+=b;if(stderr.length>16384)child.kill();});child.on('error',error=>{clearTimeout(timer);resolve({error:error.message});});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut});});});
 const results=await Promise.all(Array.from({length:4},run));assert.ok(results.every(r=>r.code===0&&!r.timedOut),JSON.stringify(results));assert.ok(results.every(r=>JSON.parse(r.stdout).sourceSnapshotHash===SOURCE));assert.equal(await readFile(join(dir,'synthetic-builds.txt'),'utf8'),'built\n');assert.equal((await readdir(dir)).filter(n=>n.endsWith('.lock')).length,0);
}));
test('new key creates a distinct immutable generation without overwriting the old one',async()=>withRoot(async dir=>{
 const s=await createRetainedHistoryRevisionStore(dir);await s.getOrCreate(KEY,async()=>payload());await s.getOrCreate(OTHER,async()=>payload(OTHER));assert.equal((await s.load(KEY)).sourceSnapshotHash,SOURCE);assert.equal((await s.load(OTHER)).sourceSnapshotHash,OTHER);assert.equal((await readdir(dir)).length,2);
}));
test('builder failure releases only its own lock and needs a new explicit request',async()=>withRoot(async dir=>{
 const s=await createRetainedHistoryRevisionStore(dir);let builds=0;await assert.rejects(s.getOrCreate(KEY,async()=>{builds++;throw Error('synthetic read failure');}),/synthetic read failure/);assert.deepEqual(await readdir(dir),[]);await delay(20);assert.equal(builds,1);assert.equal((await s.getOrCreate(KEY,async()=>{builds++;return payload();})).created,true);assert.equal(builds,2);
}));
test('STOP before work or after builder prevents pointer publication',async()=>withRoot(async dir=>{
 let allowed=false,builds=0;const s=await createRetainedHistoryRevisionStore(dir,{shouldContinue:()=>allowed});await assert.rejects(s.getOrCreate(KEY,async()=>{builds++;return payload();}),/manual_stop/);assert.equal(builds,0);assert.deepEqual(await readdir(dir),[]);allowed=true;
 await assert.rejects(s.getOrCreate(KEY,async()=>{builds++;allowed=false;return payload();}),/manual_stop/);assert.deepEqual(await readdir(dir),[]);allowed=true;assert.equal((await s.getOrCreate(KEY,async()=>payload())).created,true);
}));
test('old or ownerless lock is never stolen; monotonic deadline works with a frozen injected clock',async()=>withRoot(async dir=>{
 const lock=join(dir,KEY+'.lock');await mkdir(lock);const original='{"owner":"old unrelated owner","pid":1}\n';await writeFile(join(lock,'OWNER.json'),original);let builds=0;
 const s=await createRetainedHistoryRevisionStore(dir,{deadlineMs:80,now:()=>0}),start=performance.now();await assert.rejects(s.getOrCreate(KEY,async()=>{builds++;return payload();}),/deadline/);assert.ok(performance.now()-start<2000);assert.equal(builds,0);assert.equal(await readFile(join(lock,'OWNER.json'),'utf8'),original);assert.equal((await lstat(lock)).isDirectory(),true);
}));
test('stop while waiting does not delete another process lock',async()=>withRoot(async dir=>{
 const lock=join(dir,KEY+'.lock');await mkdir(lock);await writeFile(join(lock,'OWNER.json'),'other owner');let allowed=true,builds=0;const s=await createRetainedHistoryRevisionStore(dir,{shouldContinue:()=>allowed,deadlineMs:1000}),pending=s.getOrCreate(KEY,async()=>{builds++;return payload();});setTimeout(()=>{allowed=false;},30);await assert.rejects(pending,/manual_stop/);assert.equal(builds,0);assert.equal(await readFile(join(lock,'OWNER.json'),'utf8'),'other owner');
}));
test('an uncooperative builder retains its owned lock until settlement and cannot publish after deadline',async()=>withRoot(async dir=>{
 let release,entered,builds=0;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;}),s=await createRetainedHistoryRevisionStore(dir,{deadlineMs:80});
 const first=s.getOrCreate(KEY,async()=>{builds++;entered();await gate;return payload();});await started;await assert.rejects(first,/deadline/);assert.equal((await lstat(join(dir,KEY+'.lock'))).isDirectory(),true);await assert.rejects(s.getOrCreate(KEY,async()=>{builds++;return payload();}),/deadline/);assert.equal(builds,1);release();
 for(let i=0;i<40&&(await readdir(dir)).length;i++)await delay(5);assert.deepEqual(await readdir(dir),[]);assert.equal(await s.load(KEY),null);
}));
test('external abort after a cooperative builder starts prevents publication',async()=>withRoot(async dir=>{
 const control=new AbortController();let started;const entered=new Promise(r=>{started=r;}),s=await createRetainedHistoryRevisionStore(dir,{signal:control.signal,deadlineMs:1000});const work=s.getOrCreate(KEY,async({signal})=>{started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return payload();});await entered;control.abort();await assert.rejects(work,/manual_stop/);for(let i=0;i<40&&(await readdir(dir)).length;i++)await delay(5);assert.deepEqual(await readdir(dir),[]);
}));
test('tampered pointer and a pointer copied under another key fail without requery',async()=>withRoot(async dir=>{
 const s=await createRetainedHistoryRevisionStore(dir);await s.getOrCreate(KEY,async()=>payload());const original=await readFile(file(dir),'utf8'),body=JSON.parse(original);body.sourceSnapshotHash=OTHER;await writeFile(file(dir),JSON.stringify(body));let builds=0;await assert.rejects(s.getOrCreate(KEY,async()=>{builds++;return payload(OTHER);}),/reference_source_hash_mismatch|pointer_content_hash/);assert.equal(builds,0);await writeFile(file(dir,OTHER),original);await assert.rejects(s.load(OTHER),/pointer_contract_or_identity/);
}));
test('pointer/key/reference bounds reject bodies, unknown fields and oversized files',async()=>withRoot(async dir=>{
 const s=await createRetainedHistoryRevisionStore(dir);assert.throws(()=>s.getOrCreate('../x',async()=>payload()),/key_sha256/);await assert.rejects(s.load(KEY.toUpperCase()),/key_sha256/);await assert.rejects(s.getOrCreate(KEY,async()=>({...payload(),rawBody:'not permitted'})),/builder_reference_only/);assert.deepEqual(await readdir(dir),[]);
 await assert.rejects(s.getOrCreate(KEY,async()=>({reference:{...payload().reference,path:'untrusted file'},sourceSnapshotHash:SOURCE})),/source_reference/);await writeFile(file(dir),' '.repeat(8193));await assert.rejects(s.load(KEY),/file_bound_or_link/);
}));
test('changed ownership nonce prevents publication and preserves the foreign lock',async()=>withRoot(async dir=>{
 const s=await createRetainedHistoryRevisionStore(dir),owner=join(dir,KEY+'.lock','OWNER.json');let foreign;
 await assert.rejects(s.getOrCreate(KEY,async()=>{const current=JSON.parse(await readFile(owner,'utf8'));foreign={...current,nonce:'00000000-0000-0000-0000-000000000000'};await writeFile(owner,JSON.stringify(foreign));return payload();}),/lock_ownership_changed/);assert.deepEqual(JSON.parse(await readFile(owner,'utf8')),foreign);assert.equal(await s.load(KEY),null);
}));
test('atomic publication never overwrites a conflicting existing immutable pointer',async()=>withRoot(async dir=>{
 const s=await createRetainedHistoryRevisionStore(dir);let foreign;
 await assert.rejects(s.getOrCreate(KEY,async()=>{const body={contract:REVISION_POINTER_CONTRACT,key:KEY,reference:payload(OTHER).reference,sourceSnapshotHash:OTHER};foreign=JSON.stringify({...body,contentHash:sha(JSON.stringify(body))})+'\n';await writeFile(file(dir),foreign,{flag:'wx'});return payload();}),/immutable_pointer_conflict/);assert.equal(await readFile(file(dir),'utf8'),foreign);assert.equal((await s.load(KEY)).sourceSnapshotHash,OTHER);assert.ok(!(await readdir(dir)).some(n=>n.endsWith('.tmp')||n.endsWith('.lock')));
}));
test('directory must already exist and all path ancestors must be plain',async()=>withRoot(async dir=>{
 await assert.rejects(createRetainedHistoryRevisionStore('relative'),/configuration/);await assert.rejects(createRetainedHistoryRevisionStore(join(dir,'missing')),/ENOENT/);const plain=join(dir,'file');await writeFile(plain,'x');await assert.rejects(createRetainedHistoryRevisionStore(plain),/plain_directory/);
 const actual=join(dir,'real');await mkdir(actual);const alias=join(dir,'alias');try{await symlink(actual,alias,'junction');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code))return;throw error;}await assert.rejects(createRetainedHistoryRevisionStore(alias),/plain_directory/);
}));
