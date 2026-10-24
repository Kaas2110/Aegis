import test from 'node:test';
import assert from 'node:assert/strict';
import {createUnifiedFeatureProducer,encodeDiagnosticFeatureTrace} from './unifiedFeatureProducer.mjs';
import {createDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {createRetainedReplayFrameProof} from './retainedReplayFrame.mjs';
import {draftArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
const NOW='2026-10-23T12:40:00Z',SOURCE='2026-10-23T12:31:00Z';
const args=draftArgs({accounts:true}),h=createDynamicHistoryProof(args);
function factory(){const[index,familyDocument,targetDocument]=syntheticRegistry();return createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory:Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.mjs',sha256:'a'.repeat(64)}]}]))});}
function input(phase=4){
 const e=draftEntry({accounts:true,time:SOURCE,clock:phase===5?900:0,phase});
 const receiptInput=pinned({version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:'GetLiveLeagueGames/v1',status:'captured_diagnostic',httpStatus:200,diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId:'synthetic-replay-review',requestStartedAt:SOURCE,receivedAt:SOURCE,rawPersistedAt:SOURCE,completedAt:SOURCE,rawSha256:e.rawInput.pin.sha256,rawFile:'raw/'+e.rawInput.pin.sha256+'.body',payloadRef:'journal:'+e.rawInput.pin.sha256,bodyBytes:e.rawInput.pin.bytes});
 return{matchId:args.matchId,decisionAt:NOW,historyProof:h.proof,livePrefixInputs:[e],currentMapNumber:1,retainedReplayProof:createRetainedReplayFrameProof({rawInput:e.rawInput,receiptInput,reconstructedAt:NOW})};
}
const series=at=>pinned({contract:'aegis.series-map-receipts.v1',seriesId:'synthetic-series',bestOf:3,team1Id:'100',team2Id:'200',availableAt:at,completeThroughMapNumber:0,previousMaps:[]});
test('retained postdraft rejects a series receipt first available after the historical frame',()=>{
 const p=factory(),q=input();
 assert.throws(()=>p.generateFeatureBundle({...q,seriesInput:series('2026-10-23T12:31:00.000000001Z')}),/series_future/);
 const b=p.generateFeatureBundle({...q,seriesInput:series(SOURCE)});
 assert.equal(b.decisionAt,NOW);assert.equal(b.featureInputCutoffAt,SOURCE);
 assert.equal(JSON.parse(encodeDiagnosticFeatureTrace(b).utf8).featureInputCutoffAt,SOURCE);
});
test('retained live uses the same source cutoff while actual calculation time remains current',()=>{
 const p=factory(),q=input(5);
 assert.throws(()=>p.generateFeatureBundle({...q,seriesInput:series('2026-10-23T12:35:00Z')}),/series_future/);
 const b=p.generateFeatureBundle({...q,seriesInput:series(SOURCE)});
 assert.equal(b.mode,'LIVE');assert.equal(b.decisionAt,NOW);assert.equal(b.featureInputCutoffAt,SOURCE);
 assert.equal(b.components.series.availableAt,SOURCE);assert.equal(b.recordedPrediction,false);
});
