import test from 'node:test';import assert from 'node:assert/strict';
import {createFeatureDiagnosticsRouter} from './featureDiagnostics';
import loginRouter from './adminAuth';

function response(resolve:(value:unknown)=>void){return{code:200,headers:{} as Record<string,string>,cookies:{} as Record<string,string>,status(n:number){this.code=n;return this;},set(k:string,v:string){this.headers[k]=v;return this;},cookie(k:string,v:string){this.cookies[k]=v;return this;},json(body:unknown){resolve({code:this.code,body,headers:this.headers,cookies:this.cookies});return this;}};}
function request(router:unknown,input:Record<string,unknown>){return new Promise<any>((resolve,reject)=>{const res=response(resolve);(router as any).handle({method:'GET',url:'/',headers:{},...input},res,(error:unknown)=>error?reject(error):resolve({code:404}));});}
test('real requireAdminSession blocks diagnostics before saved reader access',async()=>{
 const original=process.env.ADMIN_TOKEN;process.env.ADMIN_TOKEN='synthetic-test-admin-token';let reads=0;
 try{const router=createFeatureDiagnosticsRouter({handle:async()=>{reads++;return{status:200,headers:{},body:{}};}});
  const unauth=await request(router,{url:'/traces/'+ 'a'.repeat(64)});assert.equal(unauth.code,401);assert.equal(reads,0);
  const forged=await request(router,{url:'/traces/'+ 'a'.repeat(64),cookies:{aegis_admin_session:'unissued-session'}});assert.equal(forged.code,401);assert.equal(reads,0);
 }finally{if(original===undefined)delete process.env.ADMIN_TOKEN;else process.env.ADMIN_TOKEN=original;}
});
test('a real issued session reaches the compact saved reader and preserves no-store headers',async()=>{
 const original=process.env.ADMIN_TOKEN;process.env.ADMIN_TOKEN='synthetic-test-admin-token';let reads=0;
 try{
  const login=await request(loginRouter,{method:'POST',url:'/login',ip:'synthetic-feature-route',body:{token:process.env.ADMIN_TOKEN}});assert.equal(login.code,200);
  const router=createFeatureDiagnosticsRouter({handle:async input=>{reads++;assert.equal(input.url,'/admin/feature-diagnostics/traces/'+ 'a'.repeat(64));return{status:200,headers:{'Cache-Control':'no-store'},body:{diagnosticOnly:true,recordedPrediction:false}};}});
  const result=await request(router,{url:'/traces/'+ 'a'.repeat(64),cookies:login.cookies});assert.equal(result.code,200);assert.equal(result.headers['Cache-Control'],'no-store');assert.equal(reads,1);assert.equal(result.body.recordedPrediction,false);
 }finally{if(original===undefined)delete process.env.ADMIN_TOKEN;else process.env.ADMIN_TOKEN=original;}
});
