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
const NOW='2026-10-23T12:40:00Z';
function producer(){const[index,familyDocument,targetDocument]=syntheticRegistry(),sourceInventory=Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.mjs',sha256:'a'.repeat(64)}]}]));return createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory});}
function db(){let queries=0,flip=false;const a=draftArgs({accounts:true}),rows=JSON.parse(a.factsInput.utf8).maps.map(m=>({...m,players:m.players.map((p,i)=>({account_id:Number(p.accountId),hero_id:Number(p.heroId),player_slot:p.side==='radiant'?i%5:128+i%5,historical_performance:{gold_per_min:400,xp_per_min:500,hero_damage:12000}}))}));return{get queries(){return queries;},setFlip(v){flip=v;},async query(sql){queries++;const copy=structuredClone(sql.includes('FROM pro_matches')?rows:[]);if(flip&&copy.length)copy[0].radiantWon=!copy[0].radiantWon;return{rows:copy}}};}
function capture(entry){const m=JSON.parse(entry.metadataInput.utf8),requestId=String(Date.parse(m.capture.receivedAt))+'-'+randomUUID();return{rawInput:entry.rawInput,receiptInput:pinned({version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:'GetLiveLeagueGames/v1',httpStatus:200,status:'captured_diagnostic',diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId,requestStartedAt:m.capture.requestStartedAt,receivedAt:m.capture.receivedAt,rawPersistedAt:m.capture.persistedAt,completedAt:m.capture.persistedAt,rawSha256:entry.rawInput.pin.sha256,rawFile:'raw/'+entry.rawInput.pin.sha256+'.body',payloadRef:'journal:'+entry.rawInput.pin.sha256,bodyBytes:entry.rawInput.pin.bytes})};}
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'aegis-retained-features-'));try{const sources=join(root,'sources'),revisionDirectory=join(root,'revisions');await mkdir(sources);await mkdir(revisionDirectory);const historyRevisions=await createRetainedHistoryRevisionStore(revisionDirectory);const makePipeline=options=>createRetainedFeaturePipeline({historyRevisions,historyProfileSha256:'b'.repeat(64),...options});await fn({root,revisionDirectory,makePipeline,sourceStore:await createHistorySourceExportStore(sources),journal:createDiagnosticFeatureJournal({directory:join(root,'journal')})});}finally{await rm(root,{recursive:true,force:true});}}
test('committed retained bytes flow through one history export, actual producer and durable trace',()=>fixture(async({root,revisionDirectory,makePipeline,sourceStore,journal})=>{
 const a=capture(draftEntry({accounts:true})),archive=join(root,'archive');await mkdir(join(archive,'observations'),{recursive:true});await mkdir(join(archive,'raw'));const r=JSON.parse(a.receiptInput.utf8),file=r.requestId+'.json';await writeFile(join(archive,'observations',file),a.receiptInput.utf8);await writeFile(join(archive,'raw',r.rawSha256+'.body'),a.rawInput.utf8);
 const fromDisk=await readCommittedSteamCapture({archive,receiptFile:file}),database=db(),pipeline=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:journal,now:()=>NOW});
 const first=await pipeline.consumeCapture(fromDisk);assert.equal(first.results[0].status,'recorded_diagnostic');assert.equal(first.results[0].mode,'POST');assert.equal(database.queries,2);
 const second=await pipeline.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:31:00Z',clock:900,phase:5})));assert.equal(second.results[0].status,'recorded_diagnostic');assert.equal(second.results[0].mode,'LIVE');assert.equal(database.queries,2);assert.equal((await readdir(join(root,'sources'))).length,1);
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
 const database=db(),p=makePipeline({db:database,producer:producer(),sourceStore,featureJournal:journal,now:()=>NOW});
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
 const repeated=await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:32:00Z',clock:900,phase:5})));
 assert.equal(repeated.results[0].status,'retained_state_diagnostic');assert.equal(repeated.results[0].traceSha256,first.results[0].traceSha256);
 assert.equal(p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:36:01Z'}).eligibleForRetainingForecast,false);
 assert.equal(p.status().consumer.recorded,2);assert.equal(database.queries,2);
 const advanced=await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:33:00Z',clock:950,phase:5})));
 assert.equal(advanced.results[0].status,'recorded_diagnostic');assert.equal(p.status().consumer.recorded,3);
 const current=p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:33:01Z'});
 assert.equal(current.eligibleForRetainingForecast,true);assert.equal(current.lastTraceSha256,advanced.results[0].traceSha256);
 const older=await p.consumeCapture(capture(draftEntry({accounts:true,time:'2026-10-23T12:30:30Z',clock:850,phase:5})));
 assert.equal(older.results[0].reason,'out_of_order_retained_capture');
 const afterOld=p.readLiveEligibility({matchId:'90001',decisionAt:'2026-10-23T12:33:02Z'});
 assert.equal(afterOld.eligibleForRetainingForecast,true);assert.equal(afterOld.stateView.lastConfirmedAt,current.stateView.lastConfirmedAt);assert.equal(afterOld.lastTraceSha256,current.lastTraceSha256);
}));
