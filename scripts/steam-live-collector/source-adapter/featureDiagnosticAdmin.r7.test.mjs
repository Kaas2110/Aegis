import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {stripTypeScriptTypes} from 'node:module';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';import {createCompactDiagnosticHostJournal} from './compactDiagnosticHostJournal.mjs';import {createFeatureProjectionCompiler} from './featureProjectionCompiler.mjs';import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';import {validateRegistry,digest} from '../../feature-registry/registry-contract.mjs';
const sourceUrl=new URL('../../../artifacts/api-server/src/services/FeatureDiagnosticAdmin.ts',import.meta.url);
// Execute the actual application module, erasing types only; no replacement
// implementation or mock probabilities. Source has only Node builtin imports.
const source=stripTypeScriptTypes(await readFile(sourceUrl,'utf8'),{mode:'strip'});
const {createFeatureDiagnosticAdminService,loadFeatureDiagnosticModules}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const appRoot=fileURLToPath(new URL('../../../',import.meta.url));
function lease(){let held=false;return createOwnedArtifactWriterLeaseProvider({async acquireExclusive(){if(held)throw Error('busy');held=true;return {async assertHeld(){if(!held)throw Error('lost');},async release(){held=false;}};}});}

test('actual application reader default stays disabled and format requires explicit configuration',async()=>{
 let loads=0;const env={},service=createFeatureDiagnosticAdminService({environment:()=>env,loadModules:async()=>{loads++;throw Error('unexpected');}});
 assert.equal((await service.handle({method:'GET',url:'/admin/feature-diagnostics'})).status,404);
 env.AEGIS_FEATURE_DIAGNOSTICS_ENABLED='1';env.AEGIS_FEATURE_DIAGNOSTICS_DIRECTORY=appRoot;env.AEGIS_FEATURE_DIAGNOSTICS_APP_ROOT=appRoot;env.AEGIS_FEATURE_DIAGNOSTICS_FORMAT='unknown';
 assert.equal((await service.handle({method:'GET',url:'/admin/feature-diagnostics'})).status,503);assert.equal(loads,0);await service.close();
});

test('configuration replacement waits for active IO, suppresses stale result and closes owner once',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aegis-r7-admin-config-'));let finish,entered,closes=0;
 const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{finish=r;});
 const env={AEGIS_FEATURE_DIAGNOSTICS_ENABLED:'1',AEGIS_FEATURE_DIAGNOSTICS_DIRECTORY:directory,AEGIS_FEATURE_DIAGNOSTICS_APP_ROOT:directory};
 const service=createFeatureDiagnosticAdminService({environment:()=>env,loadModules:async()=>({createDiagnosticFeatureJournal(){throw Error('wrong factory');},async openSavedDiagnosticReader({format}){assert.equal(format,'v1');return{journal:{},async close(){closes++;}};},createDiagnosticFeatureReadApi(){return{async handle(){entered();await gate;return{status:200,headers:{},body:{saved:true}};}};}})});
 try{const first=service.handle({method:'GET',url:'/admin/feature-diagnostics'});await started;env.AEGIS_FEATURE_DIAGNOSTICS_ENABLED='0';const disabled=service.handle({method:'GET',url:'/admin/feature-diagnostics'});assert.equal(closes,0);finish();assert.equal((await first).status,503);assert.equal((await disabled).status,404);assert.equal(closes,1);await service.close();assert.equal(closes,1);}finally{finish();await service.close();await rm(directory,{recursive:true,force:true});}
});

test('actual compact host trace survives restart into application factory and bounded admin page',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aegis-r7-admin-compact-')),provider=lease(),arena=createDiagnosticResourceArena({maxBytes:512*1024**2});let writer=null,journal=null,compiler=null,service=null,route=null;
 try{
  writer=await createPersistentArtifactWriter({directory,leaseProvider:provider});journal=createCompactDiagnosticHostJournal({writer,resourceArena:arena,journalOptions:{assetWorkingBytes:16*1024**2,operationWorkingBytes:4*1024**2,maxWireBytes:1024**2}});
  const [index,familyDocument,targetDocument]=syntheticRegistry();compiler=createFeatureProjectionCompiler({registry:validateRegistry(index,familyDocument,targetDocument),registryHash:digest({index,familyDocument,targetDocument}),sourceInventory:{history:{primarySha256:'a'.repeat(64),files:[{path:'synthetic.mjs',sha256:'a'.repeat(64)}]}},sourceProfiles:{history:'synthetic.prior'},resourceArena:arena});
  const block=compiler.normalize({names:['synthetic.r7'],definitions:[{name:'synthetic.r7',familyId:'H01',formula:'synthetic saved-reader test',formulaVersion:'r7',units:'fraction',inputScopes:['prior_maps']}],values:[0.75],masks:[false],schemaHash:'b'.repeat(64)},'history');route=compiler.project([block],'POST_MAP_WIN','POST');block.release();
  const saved=await journal.appendBundle({contract:'aegis.unified-diagnostic-feature-producer.v2',mode:'POST',matchId:'90001',decisionAt:'2026-10-25T12:00:00Z',components:{},routes:[route],eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false});
  await journal.close();journal=null;route.release();route=null;compiler.close();compiler=null;await writer.close();writer=null;assert.equal(arena.status().chargedBytes,0);
  const env={AEGIS_FEATURE_DIAGNOSTICS_ENABLED:'1',AEGIS_FEATURE_DIAGNOSTICS_DIRECTORY:directory,AEGIS_FEATURE_DIAGNOSTICS_APP_ROOT:appRoot,AEGIS_FEATURE_DIAGNOSTICS_FORMAT:'compact_v2',AEGIS_FEATURE_DIAGNOSTICS_PYTHON:process.execPath};
  service=createFeatureDiagnosticAdminService({environment:()=>env,loadModules:async root=>{const modules=await loadFeatureDiagnosticModules(root);return {...modules,openSavedDiagnosticReader:options=>modules.openSavedDiagnosticReader({...options,leaseProvider:provider})};}});
  const url='/admin/feature-diagnostics/traces/'+saved.reference.sha256;
  const summary=await service.handle({method:'GET',url});assert.equal(summary.status,200);assert.equal(summary.body.traceFormat,'compact_v2');assert.equal(summary.body.assetVerification,'metadata_only');
  const page=await service.handle({method:'GET',url:url+'/features/POST_MAP_WIN?limit=1'});assert.equal(page.status,200);assert.equal(page.body.features[0].value,0.75);assert.equal(page.body.eligibleForServing,false);
  env.AEGIS_FEATURE_DIAGNOSTICS_ENABLED='0';assert.equal((await service.handle({method:'GET',url})).status,404);
 }finally{await service?.close();await journal?.close();route?.release();compiler?.close();await writer?.close();await rm(directory,{recursive:true,force:true});}
});

test('actual admin bounds callers before delayed reader initialization, expires waiting and retains one shared owner',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aegis-r7-admin-initial-'));let finish,entered,opens=0,closes=0;const gate=new Promise(r=>finish=r),started=new Promise(r=>entered=r),env={AEGIS_FEATURE_DIAGNOSTICS_ENABLED:'1',AEGIS_FEATURE_DIAGNOSTICS_DIRECTORY:directory,AEGIS_FEATURE_DIAGNOSTICS_APP_ROOT:directory};
 const service=createFeatureDiagnosticAdminService({environment:()=>env,maxInitializationWaitMs:10,loadModules:async()=>{opens++;entered();await gate;return{createDiagnosticFeatureJournal(){return{};},createDiagnosticFeatureReadApi(){return{async handle(){return{status:200,headers:{},body:{}};}};},async openSavedDiagnosticReader(){return{journal:{},close(){closes++;}};}};}});
 try{const first=service.handle({method:'GET',url:'/admin/feature-diagnostics'});await started;const waiting=Array.from({length:3},()=>service.handle({method:'GET',url:'/admin/feature-diagnostics'}));const excess=await service.handle({method:'GET',url:'/admin/feature-diagnostics'});assert.equal(excess.status,429);assert.equal(excess.headers['Retry-After'],'1');for(const r of await Promise.all([first,...waiting]))assert.equal(r.status,429);assert.equal(opens,1);finish();assert.equal((await service.handle({method:'GET',url:'/admin/feature-diagnostics'})).status,200);await service.close();assert.equal(closes,1);}finally{finish();await service.close();await rm(directory,{recursive:true,force:true});}
});

test('actual admin cancellation releases pre-ready caller and disable/re-enable waits for retired owner',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aegis-r7-admin-reenable-'));let finish,entered,closes=0,opens=0;const gate=new Promise(r=>finish=r),started=new Promise(r=>entered=r),env={AEGIS_FEATURE_DIAGNOSTICS_ENABLED:'1',AEGIS_FEATURE_DIAGNOSTICS_DIRECTORY:directory,AEGIS_FEATURE_DIAGNOSTICS_APP_ROOT:directory};
 const service=createFeatureDiagnosticAdminService({environment:()=>env,loadModules:async()=>({createDiagnosticFeatureJournal(){return{};},async openSavedDiagnosticReader(){opens++;if(opens===2)assert.equal(closes,1);return{journal:{},async close(){closes++;}};},createDiagnosticFeatureReadApi(){return{async handle(){if(opens===1){entered();await gate;}return{status:200,headers:{},body:{}};}};}})});
 try{const controller=new AbortController();controller.abort();assert.equal((await service.handle({method:'GET',url:'/',signal:controller.signal})).status,499);assert.equal(opens,0);const first=service.handle({method:'GET',url:'/'});await started;env.AEGIS_FEATURE_DIAGNOSTICS_ENABLED='0';const disabled=service.handle({method:'GET',url:'/'});env.AEGIS_FEATURE_DIAGNOSTICS_ENABLED='1';const next=service.handle({method:'GET',url:'/'});assert.equal(opens,1);finish();assert.equal((await first).status,503);assert.equal((await disabled).status,404);assert.equal((await next).status,200);assert.equal(opens,2);await service.close();assert.equal(closes,2);}finally{finish();await service.close();await rm(directory,{recursive:true,force:true});}
});
