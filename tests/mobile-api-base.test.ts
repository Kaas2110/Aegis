import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApiUrl, resolveApiOrigin } from '../artifacts/mobile/lib/apiConfig';
import { apiFetch as webFetch } from '../artifacts/mobile/lib/api';
import { apiFetch as nativeFetch } from '../artifacts/mobile/lib/api.native';

test('web defaults to same-origin; native requires an explicitly configured server',()=>{
 assert.equal(buildApiUrl('/api/auth/login',undefined,'web'),'/api/auth/login');
 assert.equal(buildApiUrl('/api/matches/live',' ','web'),'/api/matches/live');
 assert.throws(()=>buildApiUrl('/api/auth/login',undefined,'native'),/api_url_required/);
 assert.throws(()=>resolveApiOrigin(' ','native'),/api_url_required/);
});

test('explicit HTTPS and USB origins normalize once without duplicate API prefixes',()=>{
 for(const platform of ['web','native'] as const) {
  assert.equal(buildApiUrl('/api/teams/tier1?limit=50','https://aegis.example/',platform),'https://aegis.example/api/teams/tier1?limit=50');
  assert.equal(buildApiUrl('/api/matches/live','https://aegis.example/api/',platform),'https://aegis.example/api/matches/live');
  assert.equal(buildApiUrl('/api/auth/login','http://127.0.0.1:8080',platform),'http://127.0.0.1:8080/api/auth/login');
 }
});

test('invalid, secret-bearing and ambiguous base URLs fail closed',()=>{
 for(const url of ['/api','//example.com','file:///tmp/x','javascript:alert(1)','https://u:p@example.com','https://example.com?token=private','https://example.com#fragment','https://example.com/other','not a URL']) {
  for(const platform of ['web','native'] as const) assert.throws(()=>resolveApiOrigin(url,platform),/api_url_invalid/,url);
 }
 for(const path of ['https://other.example/api','//other.example/api','/admin','/api/../admin','/api/auth#x','/api\\auth']) assert.throws(()=>buildApiUrl(path,undefined,'web'),/api_path_invalid/,path);
});

test('web and native transports preserve request options and never send native relative requests',async()=>{
 const previous=process.env.EXPO_PUBLIC_API_URL;const originalFetch=globalThis.fetch;
 const calls:Array<{url:string;init?:RequestInit}>=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({ok:true});};
 try {
  delete process.env.EXPO_PUBLIC_API_URL;
  await webFetch('/api/client-config');
  await assert.rejects(nativeFetch('/api/auth/login'),/api_url_required/);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/client-config');
  process.env.EXPO_PUBLIC_API_URL='http://127.0.0.1:8080';
  const signal=new AbortController().signal;
  const init={method:'POST',headers:{Authorization:'Bearer synthetic-fixture'},body:'{"test":true}',signal};
  await nativeFetch('/api/auth/logout',init);
  assert.equal(calls[1].url,'http://127.0.0.1:8080/api/auth/logout');assert.equal(calls[1].init,init);
  process.env.EXPO_PUBLIC_API_URL='invalid';
  await assert.rejects(webFetch('/api/matches/live'),/api_url_invalid/);assert.equal(calls.length,2);
 } finally {globalThis.fetch=originalFetch;if(previous===undefined)delete process.env.EXPO_PUBLIC_API_URL;else process.env.EXPO_PUBLIC_API_URL=previous;}
});

test('every runtime API request uses the platform-aware transport',()=>{
 const mobile=new URL('../artifacts/mobile/',import.meta.url);
 const violations:string[]=[];
 const visit=(path:string)=>{
  for(const entry of readdirSync(path,{withFileTypes:true})) {
   const next=join(path,entry.name);
   if(entry.isDirectory())visit(next);
   else if(/\.tsx?$/.test(entry.name) && !/^api(?:\.native)?\.ts$/.test(entry.name) && /\bfetch\s*\(/.test(readFileSync(next,'utf8')))violations.push(next);
  }
 };
 for(const dir of ['app','services','components','context','lib']) visit(fileURLToPath(new URL(dir+'/',mobile)));
 assert.deepEqual(violations,[]);
});
