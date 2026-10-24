import test from 'node:test';
import assert from 'node:assert/strict';
import {draftArgs,pinned,roster} from './observedDraftHistory.fixtures.mjs';
import {advanceSeriesHistoryTarget} from './seriesHistoryTarget.mjs';
import {produceSeriesHistoricalRelationalFeatures} from './historicalRelationalFeatures.mjs';
const at='2026-10-23T12:30:00Z',cutoff='2026-10-23T11:58:00Z';
function build(seriesId='s1'){
 const seriesInput=pinned({contract:'aegis.series-map-receipts.v1',seriesId,bestOf:3,team1Id:'100',team2Id:'200',availableAt:cutoff,completeThroughMapNumber:0,previousMaps:[]});
 const identityInput=pinned({contract:'aegis.series-roster-receipt.v1',seriesId,team1Id:'100',team2Id:'200',knownAt:cutoff,players:roster().map(p=>({team:p.side==='radiant'?'team1':'team2',accountId:p.accountId}))});
 return advanceSeriesHistoryTarget(null,{seriesInput,identityInput,decisionAt:at});
}
const consume=targetInput=>produceSeriesHistoricalRelationalFeatures({targetInput,factsInput:draftArgs().factsInput,decisionAt:at,minimumSupport:3});
test('independent series history validates canonical transition identity and stage',()=>{
 const t=build().target;
 for(const patch of [{transitionId:'other:after:0'},{transitionId:'s1:after:1'},{transitionId:'s1:after:00'},{transitionId:'s1:after:-1'},{phase:'SERIES_BETWEEN'},{phase:'SERIES_BETWEEN',transitionId:'s1:after:5'}])assert.throws(()=>consume(pinned({...t,...patch})),/series_history_transition_contract/);
 for(const count of [1,2,3,4])assert.equal(consume(pinned({...t,phase:'SERIES_BETWEEN',transitionId:`s1:after:${count}`})).phase,'SERIES_BETWEEN');
});
test('maximum valid series ID remains consumable after canonical transition suffix is added',()=>{
 const t=build('a'.repeat(128));assert.equal(t.target.transitionId.length,136);
 assert.equal(consume(t.targetInput).seriesId,'a'.repeat(128));
});
