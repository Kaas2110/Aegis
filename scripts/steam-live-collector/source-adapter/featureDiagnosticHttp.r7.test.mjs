import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {stripTypeScriptTypes} from 'node:module';import {EventEmitter} from 'node:events';
// Execute the actual route body with erased types and ONLY its three module
// dependencies injected. This is request-lifecycle unit evidence, not a socket,
// authentication or deployed-HTTP integration test.
const raw=await readFile(new URL('../../../artifacts/api-server/src/routes/featureDiagnostics.ts',import.meta.url),'utf8');
const stripped=stripTypeScriptTypes(raw,{mode:'strip'}),imports=stripped.split('\n').filter(x=>x.startsWith('import '));assert.equal(imports.length,3);
const source=stripped.split('\n').filter(x=>!x.startsWith('import ')).join('\n');
const injected="const Router=()=>({use(){}}),requireAdminSession=()=>{},featureDiagnosticAdmin={handle:async()=>{throw Error('default_service_not_requested');}};\n";
const {featureDiagnosticsHandler}=await import('data:text/javascript;base64,'+Buffer.from(injected+source).toString('base64'));
function pair(){const req=Object.assign(new EventEmitter(),{method:'GET',url:'/traces/'+ 'a'.repeat(64),aborted:false}),sent=[];const res=Object.assign(new EventEmitter(),{destroyed:false,set(k,v){sent.push(['header',k,v]);},status(n){sent.push(['status',n]);return this;},json(x){sent.push(['body',x]);}});return{req,res,sent};}
test('actual HTTP handler forwards disconnect cancellation and removes both listeners',async()=>{
 for(const event of ['aborted','close']){const {req,res,sent}=pair();let finish,entered,signal;const gate=new Promise(r=>finish=r),started=new Promise(r=>entered=r),handler=featureDiagnosticsHandler({async handle(input){signal=input.signal;assert.equal(input.url,'/admin/feature-diagnostics'+req.url);entered();await gate;return{status:200,headers:{},body:{}};}}),pending=handler(req,res,()=>{});await started;(event==='aborted'?req:res).emit(event);assert.equal(signal.aborted,true);finish();await pending;assert.equal(sent.length,0);assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);}
});
test('normal HTTP completion preserves response and cleans up even after owned-service error',async()=>{
 const {req,res,sent}=pair(),handler=featureDiagnosticsHandler({async handle({signal}){assert.equal(signal.aborted,false);return{status:429,headers:{'Retry-After':'1'},body:{unavailable:true}};}});await handler(req,res,()=>{});assert.deepEqual(sent,[['header','Retry-After','1'],['status',429],['body',{unavailable:true}]]);assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
 const failed=pair(),rejecting=featureDiagnosticsHandler({async handle(){throw Error('owned_failure');}});await assert.rejects(rejecting(failed.req,failed.res,()=>{}),/owned_failure/);assert.equal(failed.req.listenerCount('aborted'),0);assert.equal(failed.res.listenerCount('close'),0);
});
