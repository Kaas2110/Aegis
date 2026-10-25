import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSeriesRouteContextStore} from './seriesRouteContextStore.mjs';
import {createDiagnosticFeatureReadApi} from './diagnosticFeatureReadApi.mjs';
import {createRetainedDiagnosticHostPorts} from './retainedDiagnosticBootstrap.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {TARGET_IDS} from '../../feature-registry/registry-contract.mjs';
const AT='2026-10-24T13:00:00Z',url='/admin/feature-diagnostics/series/series%3A7/routes';
const hash=x=>createHash('sha256').update(x).digest('hex');
function series(count=0){const utf8=JSON.stringify({contract:'aegis.series-map-receipts.v1',seriesId:'series:7',team1Id:'100',team2Id:'200',bestOf:3,availableAt:'2026-10-24T12:00:00Z',completeThroughMapNumber:count,previousMaps:count?[{mapId:'101',mapNumber:1,winnerTeamId:'100',durationSeconds:1800,team1Kills:30,team2Kills:20,finishedAt:'2026-10-24T11:30:00Z',availableAt:'2026-10-24T11:31:00Z',team1Heroes:[1,2,3,4,5],team2Heroes:[6,7,8,9,10]}]:[]});return{utf8,pin:{path:'synthetic-series',bytes:Buffer.byteLength(utf8),sha256:hash(utf8)}};}
function fixture(){const objects=new Map(),storage={async commit({kind,utf8,expectedSha256}){objects.set(kind+':'+expectedSha256,utf8);return{kind,sha256:expectedSha256,bytes:Buffer.byteLength(utf8)};},async read(ref){return objects.get(ref.kind+':'+ref.sha256);}};let allowed=true;const store=createSeriesRouteContextStore({storage,now:()=>AT,shouldContinue:()=>allowed});return{store,stop(){allowed=false;}};}
const journal={loadTrace:async()=>{throw Error('unused');},loadSchema:async()=>{throw Error('unused');}};

test('API final owned-series fence rejects revision changes or STOP while router IO is pending',async()=>{
 for(const change of ['revision','stop']){const f=fixture();await f.store.commitContext({seriesInput:series(),phase:'SERIES_PRE'});let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const targetRouter={async read(){entered();await gate;return{seriesId:'series:7',main:{status:'unavailable'},detail:{status:'unavailable'}};}},api=createDiagnosticFeatureReadApi({journal,enabled:true,now:()=>AT,targetRouter,resolveRouteContext:input=>f.store.resolve(input),isCurrentRouteContext:context=>f.store.isCurrentContext(context)});
  const pending=api.handle({url});await started;if(change==='revision')await f.store.commitContext({seriesInput:series(),phase:'PRE',currentMap:{mapId:'101',mapNumber:1}});else f.stop();release();const response=await pending;assert.equal(response.status,503);assert.equal(response.body.error,'diagnostic_evidence_unavailable');
 }
});

test('API accepts only request-scoped numeric map selection and never caller state, path or time',async()=>{
 const f=fixture();await f.store.commitContext({seriesInput:series(1),phase:'PRE',currentMap:{mapId:'102',mapNumber:2}});const seen=[],api=createDiagnosticFeatureReadApi({journal,enabled:true,now:()=>AT,resolveRouteContext:input=>f.store.resolve(input),isCurrentRouteContext:context=>f.store.isCurrentContext(context),targetRouter:{async read(context){seen.push(context.selection);return{seriesId:'series:7',selection:context.selection};}}});
 assert.equal((await api.handle({url:url+'?mapId=101'})).status,200);assert.equal((await api.handle({url})).status,200);assert.deepEqual(seen,[{kind:'manual',mapId:'101'},{kind:'entry'}]);assert.deepEqual(f.store.resolve({seriesId:'series:7'}).selection,{kind:'entry'});
 for(const query of ['mapId=0','mapId=-1','mapId=101&mapId=102','mapId=101&decisionAt=2000','mapId=../file','source=C:/private','seriesTraceSha256='+ 'a'.repeat(64)])assert.equal((await api.handle({url:url+'?'+query})).status,400);
 assert.equal(seen.length,2);assert.equal((await api.handle({url:url+'?mapId=999'})).status,503);
});

test('asynchronous or caller-cloned context authority fails without route work',async()=>{
 const f=fixture();await f.store.commitContext({seriesInput:series(),phase:'SERIES_PRE'});let reads=0;const targetRouter={async read(){reads++;return{seriesId:'series:7'};}};
 const asyncFence=createDiagnosticFeatureReadApi({journal,enabled:true,targetRouter,resolveRouteContext:input=>f.store.resolve(input),isCurrentRouteContext:async()=>true});assert.equal((await asyncFence.handle({url})).status,503);
 const cloned=createDiagnosticFeatureReadApi({journal,enabled:true,targetRouter,resolveRouteContext:input=>structuredClone(f.store.resolve(input)),isCurrentRouteContext:context=>f.store.isCurrentContext(context)});assert.equal((await cloned.handle({url})).status,503);assert.equal(reads,0);
});

test('optional bootstrap series port routes previous-map actuals without enabling forecasts or a listener',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aegis-series-bootstrap-r5-'));
 try{const stateDirectory=join(root,'state'),historyFactDirectory=join(root,'facts');await mkdir(stateDirectory);await mkdir(historyFactDirectory);const f=fixture();await f.store.commitContext({seriesInput:series(1),phase:'PRE',currentMap:{mapId:'102',mapNumber:2}});
  const config={stateDirectory,historyFactDirectory,historyProfileSha256:'a'.repeat(64),materializationGeneration:'synthetic-r5-series',pipelineLimits:{}},targetDocument=syntheticRegistry()[2],expectedSchemaHashes=Object.fromEntries(TARGET_IDS.map(id=>[id,['a'.repeat(64)]])),ports=await createRetainedDiagnosticHostPorts({config,shouldContinue:()=>true,signal:null,now:()=>AT,onTraceIntent:async()=>{},seriesRouting:{contextStore:f.store,targetDocument,expectedSchemaHashes}});
  const previous=await ports.readApi.handle({url:url+'?mapId=101'});assert.equal(previous.status,200);assert.equal(previous.body.detail.status,'actual_result');assert.equal(previous.body.detail.winnerTeamId,'100');assert.deepEqual(previous.body.detail.heroes.team1,[1,2,3,4,5]);assert.equal(previous.body.detail.recordedPrediction,false);assert.equal(previous.body.main.status,'unavailable');
  const current=await ports.readApi.handle({url});assert.equal(current.status,200);assert.equal(current.body.selectedMapId,'102');assert.equal(current.body.detail.status,'unavailable');assert.equal(current.body.detail.displayText,'Прогноз недоступен');
 }finally{await rm(root,{recursive:true,force:true});}
});
