import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsentLogStore, UPLOAD_QUEUE_KEY, type LogStorage } from '../artifacts/mobile/services/logging/ConsentLogStore';

function memoryStorage() {
 const values=new Map<string,string>();const operations:string[]=[];
 const storage:LogStorage={
  async getItem(key){operations.push('get:'+key);return values.get(key)??null;},
  async setItem(key,value){operations.push('set:'+key);values.set(key,value);},
  async removeItem(key){operations.push('remove:'+key);values.delete(key);},
 };
 return {values,operations,storage};
}
function deferred<T=void>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

test('before consent is loaded, product/technical/audit events neither read storage nor send requests',async()=>{
 const mem=memoryStorage();const store=new ConsentLogStore(mem.storage);let sent=0,identity=0;
 await store.guarded(async()=>{identity++;});
 for(const key of ['product','technical','audit']) await store.append(key,{event:'auth-or-other'},{type:key});
 await store.flush(async()=>{sent++;});
 assert.equal(identity,0);assert.equal(sent,0);assert.deepEqual(mem.operations,[]);
});

test('explicitly absent consent clears a previous pending queue without starting uploads',async()=>{
 const mem=memoryStorage();mem.values.set(UPLOAD_QUEUE_KEY,'[{"old":true}]');
 const store=new ConsentLogStore(mem.storage);await store.setConsent(false);
 await store.append('product',{event:'user_login'},{event:'user_login'});
 let sent=0;await store.flush(async()=>{sent++;});
 assert.equal(sent,0);assert.equal(mem.values.has(UPLOAD_QUEUE_KEY),false);assert.equal(mem.values.has('product'),false);
});

test('enabled consent writes concurrent events without losses and sends a single batch',async()=>{
 const mem=memoryStorage();const store=new ConsentLogStore(mem.storage);await store.setConsent(true);
 await Promise.all(Array.from({length:20},(_,id)=>store.append('product',{id},{id})));
 assert.equal(JSON.parse(mem.values.get('product')!).length,20);
 let batches:unknown[][]=[];await store.flush(async events=>{batches.push(events);});
 assert.equal(batches.length,1);assert.equal(batches[0].length,20);assert.deepEqual(JSON.parse(mem.values.get(UPLOAD_QUEUE_KEY)!),[]);
});

test('revocation during a pending storage read suppresses the old write and clears queue afterwards',async()=>{
 const mem=memoryStorage(),started=deferred(),resume=deferred<string|null>();
 const store=new ConsentLogStore({...mem.storage,async getItem(key){if(key==='product'){started.resolve();return resume.promise;}return mem.storage.getItem(key);}});
 await store.setConsent(true);const write=store.append('product',{id:1},{id:1});await started.promise;
 const revoke=store.setConsent(false);resume.resolve(null);await Promise.all([write,revoke]);
 assert.equal(mem.values.has('product'),false);assert.equal(mem.values.has(UPLOAD_QUEUE_KEY),false);
});

test('revocation aborts an in-flight upload and its failure cannot resurrect the pending queue',async()=>{
 const mem=memoryStorage();const store=new ConsentLogStore(mem.storage);await store.setConsent(true);
 await store.append('product',{id:1},{id:1});const started=deferred<AbortSignal>();
 const flush=store.flush(async(_events,signal)=>{started.resolve(signal);await new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));});
 const signal=await started.promise;await store.setConsent(false);await flush;
 assert.equal(signal.aborted,true);assert.equal(mem.values.has(UPLOAD_QUEUE_KEY),false);
 await store.setConsent(true);let sent=0;await store.flush(async()=>{sent++;});assert.equal(sent,0);
});

test('a transient failure retries only while the original consent stays active',async()=>{
 const mem=memoryStorage();const store=new ConsentLogStore(mem.storage);await store.setConsent(true);await store.append('product',{id:1},{id:1});
 await store.flush(async()=>{throw new Error('offline');});assert.equal(JSON.parse(mem.values.get(UPLOAD_QUEUE_KEY)!).length,1);
 let sent=0;await store.flush(async()=>{sent++;});assert.equal(sent,1);assert.deepEqual(JSON.parse(mem.values.get(UPLOAD_QUEUE_KEY)!),[]);
});

test('failed queue cleanup remains closed until revocation cleanup succeeds, even after opt-in',async()=>{
 const mem=memoryStorage();let fail=false;
 const store=new ConsentLogStore({...mem.storage,async removeItem(key){if(fail)throw new Error('storage unavailable');await mem.storage.removeItem(key);}});
 await store.setConsent(true);await store.append('product',{id:1},{id:1});fail=true;
 await assert.rejects(store.setConsent(false));await assert.rejects(store.setConsent(true));assert.equal(store.isEnabled(),false);
 let sent=0;await store.flush(async()=>{sent++;});assert.equal(sent,0);
 fail=false;await store.setConsent(true);await store.flush(async()=>{sent++;});assert.equal(sent,0);assert.equal(mem.values.has(UPLOAD_QUEUE_KEY),false);
});
