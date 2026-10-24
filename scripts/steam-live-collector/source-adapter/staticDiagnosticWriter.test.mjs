import test from 'node:test';import assert from 'node:assert/strict';
import {createStaticDiagnosticWriter} from './staticDiagnosticWriter.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {advanceSeriesHistoryTarget} from './seriesHistoryTarget.mjs';
import {draftArgs,pinned,roster} from './observedDraftHistory.fixtures.mjs';
const AT='2026-10-23T12:40:00Z';
function inputs(maps=0){
 const seriesInput=pinned({contract:'aegis.series-map-receipts.v1',seriesId:'synthetic-series',bestOf:3,team1Id:'100',team2Id:'200',availableAt:maps?'2026-10-23T12:00:00Z':'2026-10-23T11:58:00Z',completeThroughMapNumber:maps,previousMaps:maps?[{mapId:'80001',mapNumber:1,winnerTeamId:'100',availableAt:'2026-10-23T12:00:00Z',finishedAt:'2026-10-23T11:59:00Z',durationSeconds:2400,team1Kills:30,team2Kills:20,team1Heroes:[1,2,3,4,5],team2Heroes:[6,7,8,9,10]}]:[]});
 const identityInput=pinned({contract:'aegis.series-roster-receipt.v1',seriesId:'synthetic-series',team1Id:'100',team2Id:'200',knownAt:maps?'2026-10-23T12:00:00Z':'2026-10-23T11:58:00Z',players:roster().map(p=>({team:p.side==='radiant'?'team1':'team2',accountId:p.accountId}))});
 const target=advanceSeriesHistoryTarget(null,{seriesInput,identityInput,decisionAt:AT}),facts=JSON.parse(draftArgs({accounts:true}).factsInput.utf8);facts.scope.targetHeroIds=[];
 return{seriesInput,seriesHistoryInput:{targetInput:target.targetInput,factsInput:pinned(facts)},decisionAt:AT};
}
test('portable registry and owned writer journal independent series PRE and BETWEEN without map IDs',async()=>{
 const producer=createUnifiedFeatureProducer(),saved=[],journal={writeHistoricalInputs:async()=>({status:'created',reference:{contract:'aegis.static-historical-input-reference.v1',sha256:'a'.repeat(64),bytes:100}}),writeSchema:async({schemaHash})=>({status:'created',schemaHash}),appendTrace:async trace=>{saved.push(JSON.parse(trace.utf8));return{status:'created',sha256:trace.sha256};}};
 assert.equal((await createStaticDiagnosticWriter({producer,journal}).consume({mode:'SERIES_PRE',...inputs()})).reason,'diagnostic_writer_disabled');
 const writer=createStaticDiagnosticWriter({producer,journal,enabled:true,now:()=>AT});
 const pre=await writer.consume({mode:'SERIES_PRE',...inputs()});assert.equal(pre.status,'recorded_diagnostic');assert.deepEqual(pre.targetIds,['SERIES_PRE']);assert.equal(pre.matchId,null);
 const between=await writer.consume({mode:'BETWEEN',...inputs(1)});assert.equal(between.status,'recorded_diagnostic');assert.deepEqual(between.targetIds,['SERIES_BETWEEN']);assert.equal(saved[1].targetBinding.mapOutcome,null);
 assert.ok(saved.every(t=>t.recordedPrediction===false&&t.eligibleForServing===false&&t.timings.featuresReadyAt===AT));
 assert.ok(saved.every(t=>t.historicalInputRef.sha256==='a'.repeat(64)&&t.historicalBindings.factsSha256&&t.historicalBindings.targetSha256));
 const bad=inputs();bad.seriesHistoryInput.targetInput=structuredClone(bad.seriesHistoryInput.targetInput);bad.seriesHistoryInput.targetInput.utf8+=' ';assert.equal((await writer.consume({mode:'SERIES_PRE',...bad})).status,'failed');assert.equal(saved.length,2);
});
