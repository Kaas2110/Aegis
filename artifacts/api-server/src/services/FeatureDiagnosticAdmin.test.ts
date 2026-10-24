import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createFeatureDiagnosticAdminService} from './FeatureDiagnosticAdmin';

test('feature diagnostics are disabled by default before any module or journal read',async()=>{
 let imports=0;const service=createFeatureDiagnosticAdminService({environment:()=>({}),loadModules:async()=>{imports++;throw Error('must not import');}});
 assert.equal((await service.handle({method:'GET',url:'/admin/feature-diagnostics/traces/'+ 'a'.repeat(64)})).status,404);assert.equal(imports,0);
});
test('enabled configuration is explicit and generic errors expose no directory or exception',async()=>{
 let imports=0;const service=createFeatureDiagnosticAdminService({environment:()=>({AEGIS_FEATURE_DIAGNOSTICS_ENABLED:'1',AEGIS_FEATURE_DIAGNOSTICS_DIRECTORY:'relative'}),loadModules:async()=>{imports++;throw Error('private path');}});
 const r=await service.handle({method:'GET',url:'/admin/feature-diagnostics'});assert.equal(r.status,503);assert.equal(imports,0);assert.ok(!JSON.stringify(r).includes('private path'));
});
test('configured saved reader receives only method and bounded URL; directories are operator-owned',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aegis-admin-feature-'));let loaded=0,handled=0;
 try{
  const env={AEGIS_FEATURE_DIAGNOSTICS_ENABLED:'1',AEGIS_FEATURE_DIAGNOSTICS_DIRECTORY:directory,AEGIS_FEATURE_DIAGNOSTICS_APP_ROOT:directory};
  const service=createFeatureDiagnosticAdminService({environment:()=>env,loadModules:async root=>{loaded++;assert.equal(root,directory);return{createDiagnosticFeatureJournal:({directory:dir})=>{assert.equal(dir,directory);return{savedOnly:true};},createDiagnosticFeatureReadApi:options=>{assert.equal(options.enabled,true);assert.equal(options.basePath,'/admin/feature-diagnostics');return{handle:async input=>{handled++;return{status:200,headers:{'Cache-Control':'no-store'},body:{method:input.method,url:input.url,recordedPrediction:false}};}};}};}});
  const url='/admin/feature-diagnostics/traces/'+ 'a'.repeat(64)+'/features/LIVE_MAP_WIN?offset=0&limit=5';
  assert.equal((await service.handle({method:'GET',url})).status,200);assert.equal((await service.handle({method:'GET',url})).status,200);assert.equal(loaded,1);assert.equal(handled,2);
  assert.equal((await service.handle({method:'GET',url:'x'.repeat(2049)})).status,400);assert.equal(handled,2);
  env.AEGIS_FEATURE_DIAGNOSTICS_ENABLED='0';assert.equal((await service.handle({method:'GET',url})).status,404);assert.equal(handled,2);
 }finally{await rm(directory,{recursive:true,force:true});}
});
