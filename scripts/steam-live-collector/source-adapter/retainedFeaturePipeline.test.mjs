import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {draftArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {createRetainedHistoryRevisionStore} from './retainedHistoryRevisionStore.mjs';
import {createHistorySourceExportStore} from './historySourceExportStore.mjs';
import {createDiagnosticFeatureJournal} from './diagnosticFeatureJournal.mjs';
import {createRetainedFeaturePipeline,readCommittedSteamCapture} from './retainedFeaturePipeline.mjs';
import {createDiagnosticFeatureReadApi} from './diagnosticFeatureReadApi.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
const NOW='2026-10-23T12:40:00Z';
// Explicit fixture-only capacity; producer and pipeline share the same8GiB
// arena. Production defaults and the root-owned9GiB OS tree guard stay unchanged.
const producerArenas=new WeakMap();
function producer(){const[index,familyDocument,targetDocument]=syntheticRegistry(),sourceInventory=Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.mjs',sha256:'a'.repeat(64)}]}])),resourceArena=createDiagnosticResourceArena({maxBytes:8*1024**3}),result=createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory,resourceArena});producerArenas.set(result,resourceArena);return result;}
function db(){let queries=0,flip=false;const a=draftArgs({accounts:true}),rows=JSON.parse(a.factsInput.utf8).maps.map(m=>({...m,players:m.players.map((p,i)=>({account_id:Number(p.accountId),hero_id:Number(p.heroId),player_slot:p.side==='radiant'?i%5:128+i%5,historical_performance:{gold_per_min:400,xp_per_min:500,hero_damage:12000}}))}));return{get queries(){return queries;},setFlip(v){flip=v;},async query(sql){queries++;const copy=structuredClone(sql.includes('FROM pro_matches')?rows:[]);if(flip&&copy.length)copy[0].radiantWon=!copy[0].radiantWon;return{rows:copy}}};}
function capture(entry){const m=JSON.parse(entry.metadataInput.utf8),requestId=String(Date.parse(m.capture.receivedAt))+'-'+randomUUID();return{rawInput:entry.rawInput,receiptInput:pinned({version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:'GetLiveLeagueGames/v1',httpStatus:200,status:'captured_diagnostic',diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId,requestStartedAt:m.capture.requestStartedAt,receivedAt:m.capture.receivedAt,rawPersistedAt:m.capture.persistedAt,completedAt:m.capture.persistedAt,rawSha256:entry.rawInput.pin.sha256,rawFile:'raw/'+entry.rawInput.pin.sha256+'.body',payloadRef:'journal:'+entry.rawInput.pin.sha256,bodyBytes:entry.rawInput.pin.bytes})};}
function replaceCaptureBody(input,body,{httpStatus=200,status='captured_diagnostic'}={}){const rawInput=pinned(body),r=JSON.parse(input.receiptInput.utf8);return{rawInput,receiptInput:pinned({...r,httpStatus,status,rawSha256:rawInput.pin.sha256,rawFile:'raw/'+rawInput.pin.sha256+'.body',payloadRef:'journal:'+rawInput.pin.sha256,bodyBytes:rawInput.pin.bytes})};}

test('queued newer committed terminal source revokes old issuance before its execution starts',()=>fixture(async({makePipeline,sourceStore,journal})=>{
 let entered,finish,hold=false;const enteredTrace=new Promise(r=>{entered=r;}),gate=new Promise(r=>{finish=r;}),append=journal.appendTrace;
 const ownedJournal={...journal,async appendTrace(trace){if(hold){entered();await gate;}return append(trace);}};
 const p=makePipeline({db:db(),producer:producer(),sourceStore,featureJournal:ownedJournal,now:()=> '2026-10-23T12:32:00Z'});
 assert.equal((await p.consumeCapture(capture(draftEntry({accounts:true})))).results[0].status,'recorded_diagnostic');
 hold=true;const old=p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:31:00Z',clock:900,phase:5})));
 await enteredTrace;
 const newer=p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:31:30Z',clock:930,phase:6})));
 assert.equal(p.readLiveEligibility({matchId:'90001'}).eligibleForRetainingForecast,false);
 assert.equal(p.readLiveEligibility({matchId:'90001'}).reason,'newer_committed_source_pending');
 finish();const first=await old;assert.equal(first.results[0].traceCommitted,true);assert.equal(first.results[0].stateAdvanced,false);
 assert.notEqual(first.results[0].status,'recorded_diagnostic');
 assert.equal((await newer).results[0].status,'source_closed');assert.equal(p.readLiveEligibility({matchId:'90001'}).eligibleForRetainingForecast,false);p.close();
}));
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'aegis-retained-features-')),owned=[];try{const sources=join(root,'sources'),revisionDirectory=join(root,'revisions');await mkdir(sources);await mkdir(revisionDirectory);const historyRevisions=await createRetainedHistoryRevisionStore(revisionDirectory);const makePipeline=options=>{const pipeline=createRetainedFeaturePipeline({historyRevisions,historyProfileSha256:'b'.repeat(64),resourceArena:producerArenas.get(options.producer),...options});owned.push({pipeline,producer:options.producer});return pipeline;};await fn({root,revisionDirectory,makePipeline,sourceStore:await createHistorySourceExportStore(sources),journal:createDiagnosticFeatureJournal({directory:join(root,'journal')})});}finally{for(const o of owned){o.pipeline.close();o.producer.close();}await rm(root,{recursive:true,force:true});}}
test('committed retained bytes flow through one history export, actual producer and durable trace',()=>fixture(async({root,revisionDirectory,makePipeline,sourceStore,journal})=>{
 const a=capture(draftEntry({accounts:true})),archive=join(root,'archive');await mkdir(join(archive,'observations'),{recursive:true});await mkdir(join(archive,'raw'));const r=JSON.parse(a.receiptInput.utf8),file=r.requestId+'.json';await writeFile(join(archive,'observations',file),a.receiptInput.utf8);await writeFile(join(archive,'raw',r.rawSha256+'.body'),a.rawInput.utf8);
 const fromDisk=await readCommittedSteamCapture({archive,receiptFile:file}),database=db(),pipeline=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:journal,now:()=>NOW});
 const first=await pipeline.consumeCapture(fromDisk);assert.equal(first.results[0].status,'recorded_diagnostic',JSON.stringify(first.results[0]));assert.equal(first.results[0].mode,'POST');assert.equal(database.queries,2);
 const second=await pipeline.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:31:00Z',clock:900,phase:5})));assert.equal(second.results[0].status,'recorded_diagnostic',JSON.stringify(second.results[0]));assert.equal(second.results[0].mode,'LIVE');assert.equal(database.queries,2);assert.equal((await readdir(join(root,'sources'))).length,1);
 const t=await journal.loadTrace(second.results[0].traceSha256);assert.equal(t.mode,'LIVE');assert.equal(t.historyCutoffAt,'2026-10-23T11:58:00Z');assert.equal(t.recordedPrediction,false);assert.equal(first.materializationBasis,'current_local_reconstruction_not_original_prediction');
 const duplicate=await pipeline.consumeCapture(fromDisk);assert.equal(duplicate.reusedReceipt,true);assert.equal(duplicate.results[0].stateAdvanced,false);assert.equal(database.queries,2);
 const restarted=createDiagnosticFeatureJournal({directory:join(root,'journal')});assert.equal((await restarted.loadTrace(second.results[0].traceSha256)).mode,'LIVE');
 database.setFlip(true);const rebuilt=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:restarted,now:()=>NOW,historyRevisions:await createRetainedHistoryRevisionStore(revisionDirectory)}),again=await rebuilt.consumeCapture(fromDisk);assert.equal(again.results[0].status,'recorded_diagnostic');assert.equal(database.queries,2);assert.equal((await restarted.loadTrace(again.results[0].traceSha256)).sourceSnapshotHash,(await journal.loadTrace(first.results[0].traceSha256)).sourceSnapshotHash);
 await writeFile(join(archive,'raw',r.rawSha256+'.body'),'{}');await assert.rejects(readCommittedSteamCapture({archive,receiptFile:file}),/committed_raw_hash/);
}));
test('old retained capture cannot poison accepted prefix; later valid capture uses same t0',()=>fixture(async({makePipeline,sourceStore,journal})=>{
 const database=db(),p=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:journal,now:()=>NOW});
 const first=await p.consumeCapture(capture(draftEntry({accounts:true})));assert.equal(first.results[0].status,'recorded_diagnostic');
 const older=await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T11:57:00Z'})));assert.equal(older.results[0].reason,'out_of_order_retained_capture');
 const next=await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:02:00Z'})));assert.equal(next.results[0].status,'recorded_diagnostic');assert.equal(database.queries,2);
}));
test('stop after source commit prevents heavy proof, generation and feature writes',()=>fixture(async({makePipeline,sourceStore,journal})=>{
 let allowed=true,writes=0;const database=db(),store={load:(...args)=>sourceStore.load(...args),async put(e){const r=await sourceStore.put(e);allowed=false;return r;}},j={writeSchema(){writes++;throw Error('unexpected');},appendTrace(){writes++;throw Error('unexpected');}};
 const p=makePipeline({db:database,producer:producer(),sourceStore:store,featureJournal:j,now:()=>NOW,shouldContinue:()=>allowed});const r=await p.consumeCapture(capture(draftEntry({accounts:true})));assert.equal(r.reason,'manual_stop_after_source_commit');assert.equal(writes,0);assert.equal(p.status().consumer.recorded,0);
}));
test('manual pause, extra metadata and unsuccessful source receipt do not read history',()=>fixture(async({makePipeline,sourceStore,journal})=>{
 const database=db(),p=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:journal,now:()=>NOW}),a=capture(draftEntry({accounts:true}));
 a.rawInput.pin.extra='x'.repeat(10000);assert.equal((await p.consumeCapture(a)).reason,'capture_input_bound');assert.equal(database.queries,0);
 const b=capture(draftEntry({accounts:true})),body=JSON.parse(b.receiptInput.utf8);body.status='degraded';b.receiptInput=pinned(body);assert.equal((await p.consumeCapture(b)).reason,'capture_pin_or_contract');assert.equal(database.queries,0);
 const stopped=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:journal,shouldContinue:()=>false});assert.equal((await stopped.consumeCapture(b)).reason,'manual_stop_or_abort');
}));
test('archive child junctions cannot redirect raw reads outside the named archive',()=>fixture(async({root})=>{
 const archive=join(root,'junction-archive'),elsewhere=join(root,'elsewhere');await mkdir(archive);await mkdir(join(archive,'observations'));await mkdir(elsewhere);await symlink(elsewhere,join(archive,'raw'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(readCommittedSteamCapture({archive,receiptFile:'1792756680000-00000000-0000-0000-0000-000000000000.json'}),/archive_directory/);
}));

test('explicit map release rebuilds state from original prefix instead of reusing an old receipt only',()=>fixture(async({makePipeline,sourceStore,journal})=>{
 const database=db(),p=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:journal,now:()=>NOW}),c=capture(draftEntry({accounts:true}));
 const a=await p.consumeCapture(c);assert.equal(a.results[0].status,'recorded_diagnostic');assert.equal(p.forgetMap('90001').released,true);
 const b=await p.consumeCapture(c);assert.equal(b.reusedReceipt,undefined);assert.equal(b.results[0].stateAdvanced,true);assert.equal(database.queries,2);assert.equal((await journal.loadTrace(a.results[0].traceSha256)).sourceSnapshotHash,(await journal.loadTrace(b.results[0].traceSha256)).sourceSnapshotHash);
}));

test('live read expires at five minutes without collection, and repeated clocks do not issue new traces',()=>fixture(async({makePipeline,sourceStore,journal})=>{
 // A retained trace materialized at12:40 cannot be a current artifact at12:36.
 // Positive read fixtures must follow the actual materialization timestamp.
 let materializedAt='2026-10-23T12:31:01Z';
 const database=db(),p=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:journal,now:()=>materializedAt});
 await p.consumeCapture(capture(draftEntry({accounts:true})));
 const first=await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:31:00Z',clock:900,phase:5})));
 assert.equal(first.results[0].status,'recorded_diagnostic');
 const atBoundary=p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:36:00Z'});
 assert.equal(atBoundary.eligibleForRetainingForecast,true);assert.equal(atBoundary.lastTraceSha256,first.results[0].traceSha256);
 assert.equal(p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:36:00.000000001Z'}).eligibleForRetainingForecast,false);
 let readAt='2026-10-23T12:36:00Z';const reader=createDiagnosticFeatureReadApi({journal,enabled:true,now:()=>readAt,readLiveEligibility:input=>p.readLiveEligibility(input)});
 const url='/admin/feature-diagnostics/traces/'+first.results[0].traceSha256;
 assert.equal((await reader.handle({url})).body.currentLiveEligibility.eligibleForRetainingForecast,true);
 readAt='2026-10-23T12:36:00.000000001Z';assert.equal((await reader.handle({url})).body.currentLiveEligibility.eligibleForRetainingForecast,false);
 materializedAt='2026-10-23T12:32:01Z';
 const repeated=await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:32:00Z',clock:900,phase:5})));
 assert.equal(repeated.results[0].status,'retained_state_diagnostic');assert.equal(repeated.results[0].traceSha256,first.results[0].traceSha256);
 assert.equal(p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:36:01Z'}).eligibleForRetainingForecast,false);
 assert.equal(p.status().consumer.recorded,2);assert.equal(database.queries,2);
 materializedAt='2026-10-23T12:33:00.500Z';
 const advanced=await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:33:00Z',clock:950,phase:5})));
 assert.equal(advanced.results[0].status,'recorded_diagnostic');assert.equal(p.status().consumer.recorded,3);
 const current=p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:33:01Z'});
 assert.equal(current.eligibleForRetainingForecast,true);assert.equal(current.lastTraceSha256,advanced.results[0].traceSha256);
 const older=await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:30:30Z',clock:850,phase:5})));
 assert.equal(older.results[0].reason,'out_of_order_retained_capture');
 const afterOld=p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:33:02Z'});
 assert.equal(afterOld.eligibleForRetainingForecast,true);assert.equal(afterOld.stateView.lastConfirmedAt,current.stateView.lastConfirmedAt);assert.equal(afterOld.lastTraceSha256,current.lastTraceSha256);
}));
test('absent-phase repeated clocks resume through actual pipeline with unchanged historical cutoff',()=>fixture(async({makePipeline,sourceStore,journal})=>{
 const database=db(),p=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:journal,now:()=>NOW});
 const frame=(time,clock)=>capture(draftEntry({accounts:true,time,clock,phase:null}));
 const first=await p.consumeCapture(frame('2026-10-23T12:30:00Z',600));assert.equal(first.results[0].mode,'POST');
 const advanced=await p.consumeCapture(frame('2026-10-23T12:31:00Z',660));assert.equal(advanced.results[0].status,'recorded_diagnostic');assert.equal(advanced.results[0].mode,'LIVE');
 const repeated=await p.consumeCapture(frame('2026-10-23T12:32:59Z',660));assert.equal(repeated.results[0].status,'retained_state_diagnostic');assert.equal(repeated.results[0].traceSha256,advanced.results[0].traceSha256);
 const resumed=await p.consumeCapture(frame('2026-10-23T12:33:00Z',780));assert.equal(resumed.results[0].status,'recorded_diagnostic');assert.equal(resumed.results[0].mode,'LIVE');assert.notEqual(resumed.results[0].traceSha256,advanced.results[0].traceSha256);
 const original=await journal.loadTrace(first.results[0].traceSha256),latest=await journal.loadTrace(resumed.results[0].traceSha256);assert.equal(latest.historyCutoffAt,original.historyCutoffAt);assert.equal(latest.historyCutoffAt,'2026-10-23T12:30:00Z');assert.equal(database.queries,2);assert.equal(p.status().consumer.recorded,3);
 const exact=p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:38:00Z'});assert.equal(exact.eligibleForRetainingForecast,true);assert.equal(exact.lastTraceSha256,resumed.results[0].traceSha256);assert.equal(p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:38:00.000000001Z'}).eligibleForRetainingForecast,false);
}));

for(const gap of ['HTTP500','HTTP500_EMPTY','empty_list','missing_map'])test('classified '+gap+' preserves the original live trace and 300-second deadline, not a permanent pending fence',()=>fixture(async({makePipeline,sourceStore,journal})=>{
 let materializedAt='2026-10-23T12:31:01Z';const database=db(),p=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:journal,now:()=>materializedAt});
 await p.consumeCapture(capture(draftEntry({accounts:true})));
 const live=await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:31:00Z',clock:900,phase:5}))),trace=live.results[0].traceSha256;
 assert.equal(live.results[0].status,'recorded_diagnostic');const before=p.readLiveEligibility({matchId:'90001'}),issued=p.status().consumer.recorded;
 materializedAt='2026-10-23T12:31:31Z';const raw=gap==='HTTP500'?{error:'synthetic provider failure'}:gap==='HTTP500_EMPTY'?'':gap==='empty_list'?{result:{games:[]}}:JSON.parse(draftEntry({matchId:'90002',accounts:true,time:'2026-10-23T12:31:30Z',clock:930,phase:5}).rawInput.utf8);
 const next=replaceCaptureBody(capture(draftEntry({accounts:true,time:'2026-10-23T12:31:30Z',clock:930,phase:5})),raw,gap.startsWith('HTTP500')?{httpStatus:500,status:'degraded'}:{});
 const result=await p.consumeCapture(next);assert.notEqual(result.status,'failed');assert.equal(p.status().pending,0);
 const retained=p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:35:59Z'});
 assert.equal(retained.eligibleForRetainingForecast,true);assert.equal(retained.lastTraceSha256,trace);assert.equal(retained.stateView.observationId,before.stateView.observationId);assert.equal(retained.stateView.lastConfirmedAt,before.stateView.lastConfirmedAt);assert.equal(retained.stateView.expiresAt,before.stateView.expiresAt);assert.notEqual(retained.reason,'newer_committed_source_pending');
 assert.equal(p.status().tracked.find(x=>x.matchId==='90001').classifiedSourceHead.key,p.status().admittedSourceHead);
 const expired=p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:36:01Z'});assert.equal(expired.eligibleForRetainingForecast,false);assert.equal(expired.reason,'eligible_state_expired');
 if(gap!=='missing_map')assert.equal(p.status().consumer.recorded,issued,'a gap cannot generate another vector');
 p.close();
}));

test('classified integrity rejection is not an ordinary retained gap',()=>fixture(async({makePipeline,sourceStore,journal})=>{
 let materializedAt='2026-10-23T12:31:01Z';const p=makePipeline({db:db(),producer:producer(),sourceStore,featureJournal:journal,now:()=>materializedAt});await p.consumeCapture(capture(draftEntry({accounts:true})));await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:31:00Z',clock:900,phase:5})));
 materializedAt='2026-10-23T12:31:31Z';const invalid=capture(draftEntry({accounts:true,time:'2026-10-23T12:31:30Z',clock:930,phase:5})),r=JSON.parse(invalid.receiptInput.utf8);invalid.receiptInput=pinned({...r,bodyBytes:r.bodyBytes+1});assert.equal((await p.consumeCapture(invalid)).reason,'capture_pin_or_contract');
 const denied=p.readLiveEligibility({matchId:'90001'});assert.equal(denied.eligibleForRetainingForecast,false);assert.equal(denied.reason,'invalid_committed_source_contract');assert.notEqual(denied.reason,'newer_committed_source_pending');p.close();
}));

test('one aggregate response classifies an absent tracked map separately from a progressing present map',()=>fixture(async({makePipeline,sourceStore,journal})=>{
 let materializedAt='2026-10-23T12:31:01Z';const p=makePipeline({db:db(),producer:producer(),sourceStore,featureJournal:journal,now:()=>materializedAt});
 function pair(time,clock=null,phase=null){const a=capture(draftEntry({accounts:true,time,clock,phase})),first=JSON.parse(a.rawInput.utf8).result.games[0],second=JSON.parse(draftEntry({matchId:'90002',accounts:true,time,clock,phase}).rawInput.utf8).result.games[0];return replaceCaptureBody(a,{result:{games:[first,second]}});}
 await p.consumeCapture(pair('2026-10-23T11:58:00Z'));const live=await p.consumeCapture(pair('2026-10-23T12:31:00Z',900,5));assert.ok(live.results.every(x=>x.status==='recorded_diagnostic'));
 const old=p.readLiveEligibility({matchId:'90001'}),presentBefore=p.readLiveEligibility({matchId:'90002'});materializedAt='2026-10-23T12:31:31Z';const response=await p.consumeCapture(capture(draftEntry({matchId:'90002',accounts:true,time:'2026-10-23T12:31:30Z',clock:930,phase:5})));assert.equal(response.results[0].status,'recorded_diagnostic');
 const absent=p.readLiveEligibility({matchId:'90001'}),present=p.readLiveEligibility({matchId:'90002'});assert.equal(absent.eligibleForRetainingForecast,true);assert.equal(absent.lastTraceSha256,old.lastTraceSha256);assert.equal(absent.stateView.lastConfirmedAt,old.stateView.lastConfirmedAt);assert.equal(present.eligibleForRetainingForecast,true);assert.equal(present.stateView.lastConfirmedAt,'2026-10-23T12:31:30Z');assert.notEqual(present.lastTraceSha256,presentBefore.lastTraceSha256);assert.ok(p.status().tracked.every(x=>x.classifiedSourceHead.key===p.status().admittedSourceHead));p.close();
}));
