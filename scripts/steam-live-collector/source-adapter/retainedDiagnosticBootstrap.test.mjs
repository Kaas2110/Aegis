import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readdir,lstat} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {createRetainedDiagnosticHostPorts} from './retainedDiagnosticBootstrap.mjs';
import {createDiagnosticFeatureJournal} from './diagnosticFeatureJournal.mjs';
import {digest} from '../../feature-registry/registry-contract.mjs';
import {draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {createAppendOnlyHistoryFactStore} from './appendOnlyHistoryFactStore.mjs';
import {pinRetainedHistoryJson} from './retainedOpenDotaFacts.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';
import {createDiagnosticResourceConfiguration,RICH_DIAGNOSTIC_RESOURCE_PROFILE} from './diagnosticResourceConfiguration.mjs';

test('full capacity requires explicit compact storage before any configured filesystem access',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aegis-bootstrap-capacity-policy-')),stateDirectory=join(root,'state-not-created'),historyFactDirectory=join(root,'facts-not-created');let configurationReads=0,hostCallbacks=0;
 try{
  const config={historyProfileSha256:'a'.repeat(64),materializationGeneration:'synthetic-capacity-policy',pipelineLimits:{}};
  for(const [name,value]of [['stateDirectory',stateDirectory],['historyFactDirectory',historyFactDirectory]])Object.defineProperty(config,name,{enumerable:true,get(){configurationReads++;return value;}});
  await assert.rejects(createRetainedDiagnosticHostPorts({config,compactStorage:null,producerOptions:{projectionOptions:{capacityProfile:'R7_FULL300K',maxSchemas:1}},shouldContinue:()=>{hostCallbacks++;return true;},signal:null,now:()=>{hostCallbacks++;return '2026-10-25T12:00:00Z';},onTraceIntent:async()=>{hostCallbacks++;}}),/retained_diagnostic_bootstrap:full_capacity_requires_explicit_compact_storage/);
  assert.equal(configurationReads,0);assert.equal(hostCallbacks,0);assert.deepEqual(await readdir(root),[]);
  for(const directory of [stateDirectory,historyFactDirectory])await assert.rejects(lstat(directory),error=>error.code==='ENOENT');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('pending recovery distinguishes an absent trace from a committed trace with missing schema evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aegis-bootstrap-recovery-'));
 try{
  const stateDirectory=join(root,'state'),historyFactDirectory=join(root,'facts');await mkdir(stateDirectory);await mkdir(historyFactDirectory);
  const config={stateDirectory,historyFactDirectory,historyProfileSha256:'a'.repeat(64),materializationGeneration:'synthetic-review',pipelineLimits:{}};
  const ports=await createRetainedDiagnosticHostPorts({config,shouldContinue:()=>true,signal:null,now:()=> '2026-10-24T12:00:00Z',onTraceIntent:async()=>{}});
  assert.equal(await ports.hasCommittedTrace('a'.repeat(64)),false);
  const schema={contract:'aegis.unified-feature-projection-schema.v1',targetId:'LIVE_MAP_WIN',stateMode:'LIVE',definitions:[{name:'synthetic.one'}]},schemaHash=digest(schema),vector={namesHash:digest(['synthetic.one']),values:[1],missing:[false]},vectorRef=digest(vector);
  const body={contract:'aegis.diagnostic-feature-trace.v1',routes:[{targetId:'LIVE_MAP_WIN',stateMode:'LIVE',schemaRef:{sha256:schemaHash,featureCount:1},featureCount:1,vectorRef}],vectors:{[vectorRef]:vector},eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false},utf8=JSON.stringify(body),trace={contract:body.contract,utf8,bytes:Buffer.byteLength(utf8),sha256:createHash('sha256').update(utf8).digest('hex')};
  const journal=createDiagnosticFeatureJournal({directory:join(stateDirectory,'journal')});await journal.writeSchema({schemaHash,schema});await journal.appendTrace(trace);
  assert.equal(await ports.hasCommittedTrace(trace.sha256),true);
  await rm(join(stateDirectory,'journal','schemas',schemaHash+'.json'));
  await assert.rejects(()=>ports.hasCommittedTrace(trace.sha256),/ENOENT/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('manual stop observed during intent persistence prevents the subsequent trace commit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aegis-bootstrap-intent-stop-'));let ports=null,writer=null;
 try{
  const stateDirectory=join(root,'state'),historyFactDirectory=join(root,'facts');await mkdir(stateDirectory);await mkdir(historyFactDirectory);
  const config={stateDirectory,historyFactDirectory,historyProfileSha256:'a'.repeat(64),materializationGeneration:'synthetic-stop-review',pipelineLimits:{}};
  const factStore=await createAppendOnlyHistoryFactStore(historyFactDirectory);
  for(let i=0;i<5;i++){
   const matchId=80001+i,payload={match_id:matchId,start_time:Math.floor(Date.parse('2026-10-20T10:00:00Z')/1000)+i*3600,duration:2400,radiant_win:i%2===0,radiant_score:30,dire_score:20,radiant_team_id:100,dire_team_id:200,players:Array.from({length:10},(_,n)=>({player_slot:n<5?n:128+n-5,hero_id:n+1,account_id:n+1,gold_per_min:400,xp_per_min:500,kills:5,deaths:2,assists:8}))};
   const normalizedPayload=JSON.parse(pinRetainedHistoryJson(payload).utf8),envelope={schemaVersion:1,source:'opendota',matchId,endpoint:'https://api.opendota.com/api/matches/'+matchId,availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',receivedAt:'2026-10-22T12:00:00Z',payload:normalizedPayload,payloadSha256:createHash('sha256').update(JSON.stringify(normalizedPayload)).digest('hex')};await factStore.append({selectedInput:pinRetainedHistoryJson(envelope)});
  }
  let stopped=false,intents=0;
  // This regression targets the current rich intent/STOP boundary. The legacy
  // default remains2GiB and must not be enlarged merely to fit rich fixtures.
  const directory=join(root,'compact');await mkdir(directory);let held=false;const provider=createOwnedArtifactWriterLeaseProvider({async acquireExclusive(){assert.equal(held,false);held=true;return{async assertHeld(){assert.equal(held,true);},async release(){held=false;}};}});writer=await createPersistentArtifactWriter({directory,leaseProvider:provider});const resources=createDiagnosticResourceConfiguration({profile:RICH_DIAGNOSTIC_RESOURCE_PROFILE});
  ports=await createRetainedDiagnosticHostPorts({config,shouldContinue:()=>!stopped,signal:null,now:()=> '2026-10-24T12:00:00Z',onTraceIntent:async()=>{intents++;await Promise.resolve();stopped=true;},compactStorage:{writer},resourceConfiguration:resources});
  const entry=draftEntry({accounts:true,clock:0,phase:4}),metadata=JSON.parse(entry.metadataInput.utf8),at=metadata.capture.receivedAt;
  const receipt={version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:'GetLiveLeagueGames/v1',httpStatus:200,status:'captured_diagnostic',diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId:'1792750000000-00000000-0000-0000-0000-000000000001',requestStartedAt:at,receivedAt:at,rawPersistedAt:at,completedAt:at,rawSha256:entry.rawInput.pin.sha256,rawFile:'raw/'+entry.rawInput.pin.sha256+'.body',payloadRef:'journal:'+entry.rawInput.pin.sha256,bodyBytes:entry.rawInput.pin.bytes};
  const output=await ports.pipeline.consumeCapture({rawInput:entry.rawInput,receiptInput:pinned(receipt)});
  assert.equal(intents,1,JSON.stringify(output));
  const traces=await writer.listCommitted({kind:'compact-feature-trace-v2'});assert.deepEqual(traces,[]);
  assert.equal(output.results?.some(row=>row.traceCommitted===true),false);
 }finally{await ports?.close();await writer?.close();await rm(root,{recursive:true,force:true});}
});
