import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {runRetainedDiagnosticHost,HOST_CONTRACT} from './retainedDiagnosticHost.mjs';
import {createRetainedDiagnosticHostPorts} from './retainedDiagnosticBootstrap.mjs';
import {draftEntry} from './observedDraftHistory.fixtures.mjs';
import {createAppendOnlyHistoryFactStore} from './appendOnlyHistoryFactStore.mjs';
import {pinRetainedHistoryJson} from './retainedOpenDotaFacts.mjs';
import {createHash} from 'node:crypto';
test('actual opt-in host writes a feature-only trace from retained raw and restores it after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aegis-real-ports-host-'));
 try{
  const archive=join(root,'archive'),facts=join(root,'facts'),stateDirectory=join(root,'state');await mkdir(archive);await mkdir(join(archive,'observations'));await mkdir(join(archive,'raw'));await mkdir(facts);
  const factStore=await createAppendOnlyHistoryFactStore(facts);
  for(let i=0;i<5;i++){
   const matchId=80001+i,receivedAt='2026-10-22T12:00:00Z',payload={match_id:matchId,start_time:Math.floor(Date.parse('2026-10-20T10:00:00Z')/1000)+i*3600,duration:2400,radiant_win:i%2===0,radiant_score:30,dire_score:20,radiant_team_id:100,dire_team_id:200,players:Array.from({length:10},(_,n)=>({player_slot:n<5?n:128+n-5,hero_id:n+1,account_id:n+1,gold_per_min:400,xp_per_min:500,kills:5,deaths:2,assists:8}))};
   const normalizedPayload=JSON.parse(pinRetainedHistoryJson(payload).utf8);
   const envelope={schemaVersion:1,source:'opendota',matchId,endpoint:'https://api.opendota.com/api/matches/'+matchId,availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',receivedAt,payload:normalizedPayload,payloadSha256:createHash('sha256').update(JSON.stringify(normalizedPayload)).digest('hex')};
   await factStore.append({selectedInput:pinRetainedHistoryJson(envelope)});
  }
  const e=draftEntry({accounts:true,clock:0,phase:4}),m=JSON.parse(e.metadataInput.utf8),requestId='1792750000000-00000000-0000-0000-0000-000000000001';
  const receipt={version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:'GetLiveLeagueGames/v1',httpStatus:200,status:'captured_diagnostic',diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId,requestStartedAt:m.capture.requestStartedAt,receivedAt:m.capture.receivedAt,rawPersistedAt:m.capture.persistedAt,completedAt:m.capture.persistedAt,rawSha256:e.rawInput.pin.sha256,rawFile:'raw/'+e.rawInput.pin.sha256+'.body',payloadRef:'journal:'+e.rawInput.pin.sha256,bodyBytes:e.rawInput.pin.bytes};
  await writeFile(join(archive,'raw',e.rawInput.pin.sha256+'.body'),e.rawInput.utf8);await writeFile(join(archive,'observations',requestId+'.json'),JSON.stringify(receipt));
  const config={contract:HOST_CONTRACT,enabled:true,archive,stateDirectory,historyFactDirectory:facts,historyProfileSha256:'a'.repeat(64),stopFiles:[join(root,'STOP')],limits:{maxRunMs:120000}};
  const options={pipelineFactory:createRetainedDiagnosticHostPorts,now:()=> '2026-10-23T12:40:00Z'};
  const first=await runRetainedDiagnosticHost(config,options);assert.equal(first.status,'completed',JSON.stringify(first));assert.equal(first.successfulMapTraceReferences,1);
  const saved=JSON.parse(await readFile(join(stateDirectory,'HOST-PROGRESS.json'),'utf8')),hash=saved.processed[0].traceRefsByMap['90001'];assert.match(hash,/^[a-f0-9]{64}$/);
  const trace=JSON.parse(await readFile(join(stateDirectory,'journal/traces',hash+'.json'),'utf8'));assert.equal(trace.recordedPrediction,false);assert.equal(trace.eligibleForTraining,false);assert.equal(trace.eligibleForServing,false);
  const restarted=await runRetainedDiagnosticHost(config,options);assert.equal(restarted.status,'completed',JSON.stringify(restarted));assert.equal(restarted.replayed,1);assert.equal(restarted.consumed,0);assert.equal((await readdir(join(stateDirectory,'journal/traces'))).filter(n=>n.endsWith('.json')).length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
