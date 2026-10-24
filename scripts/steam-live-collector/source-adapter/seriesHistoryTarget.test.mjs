import test from 'node:test';import assert from 'node:assert/strict';
import {advanceSeriesHistoryTarget} from './seriesHistoryTarget.mjs';
import {produceSeriesHistoricalRelationalFeatures} from './historicalRelationalFeatures.mjs';
import {draftArgs,pinned,roster} from './observedDraftHistory.fixtures.mjs';
const at='2026-10-23T12:40:00Z';
const series=({maps=0,reverse=false,known='2026-10-23T11:58:00Z'}={})=>pinned({contract:'aegis.series-map-receipts.v1',seriesId:'s1',bestOf:3,team1Id:reverse?'200':'100',team2Id:reverse?'100':'200',availableAt:known,completeThroughMapNumber:maps,previousMaps:Array.from({length:maps},(_,i)=>({mapId:String(80001+i),mapNumber:i+1,winnerTeamId:i===0?'100':'200',availableAt:known,finishedAt:i===0?'2026-10-23T11:20:00Z':'2026-10-23T12:10:00Z',durationSeconds:2400,team1Kills:30,team2Kills:20,team1Heroes:[1,2,3,4,5],team2Heroes:[6,7,8,9,10]}))});
const identity=({reverse=false,known='2026-10-23T11:58:00Z',anonymous=false}={})=>pinned({contract:'aegis.series-roster-receipt.v1',seriesId:'s1',team1Id:reverse?'200':'100',team2Id:reverse?'100':'200',knownAt:known,players:anonymous?[]:roster().map(p=>({team:(p.side==='radiant')!==reverse?'team1':'team2',accountId:p.accountId}))});
const build=(options={})=>advanceSeriesHistoryTarget(null,{seriesInput:series(options),identityInput:identity(options),decisionAt:at});
test('series PRE works without a current map ID, sides, heroes or live packet',()=>{
 const t=build(),args=draftArgs({accounts:true}),facts=JSON.parse(args.factsInput.utf8);facts.scope.targetHeroIds=[];
 const b=produceSeriesHistoricalRelationalFeatures({targetInput:t.targetInput,factsInput:pinned(facts),decisionAt:at,minimumSupport:3});
 assert.equal(t.target.phase,'SERIES_PRE');assert.equal(b.matchId,null);assert.equal(b.team1Id,'100');assert.ok(b.names.length>0);assert.ok(b.names.every(n=>!n.includes('radiant')&&!n.includes('dire')));assert.ok(b.definitions.every(d=>!d.inputScopes.includes('current_draft')&&!d.inputScopes.includes('current_live')));assert.equal(b.eligibleForTraining,false);
 assert.equal(b.values[b.names.indexOf('series_history.team1.team.90d.rawWinFraction')],3/5);
 const reversed=build({reverse:true}),c=produceSeriesHistoricalRelationalFeatures({targetInput:reversed.targetInput,factsInput:pinned(facts),decisionAt:at,minimumSupport:3});assert.equal(c.values[c.names.indexOf('series_history.team1.team.90d.rawWinFraction')],2/5);
});
test('late roster disclosure preserves first transition cutoff and cannot redact known players',()=>{
 const a=build({anonymous:true}),b=advanceSeriesHistoryTarget(a.targetInput,{seriesInput:series({known:'2026-10-23T12:00:00Z'}),identityInput:identity({known:'2026-10-23T12:00:00Z'}),decisionAt:at});
 assert.equal(b.target.historyCutoffAt,a.target.historyCutoffAt);assert.equal(b.target.validFrom,'2026-10-23T12:00:00Z');assert.equal(b.target.identityRevision,1);
 assert.throws(()=>advanceSeriesHistoryTarget(b.targetInput,{seriesInput:series({known:'2026-10-23T12:01:00Z'}),identityInput:identity({anonymous:true,known:'2026-10-23T12:01:00Z'}),decisionAt:at}),/known_roster_change/);
});
test('between-map transition gets its own cutoff and cannot regress to an earlier series state',()=>{
 const a=build(),b=advanceSeriesHistoryTarget(a.targetInput,{seriesInput:series({maps:1,known:'2026-10-23T12:00:00Z'}),identityInput:identity({known:'2026-10-23T12:00:00Z'}),decisionAt:at});
 assert.equal(b.target.phase,'SERIES_BETWEEN');assert.equal(b.target.historyCutoffAt,'2026-10-23T12:00:00Z');assert.notEqual(b.target.transitionId,a.target.transitionId);
 assert.throws(()=>advanceSeriesHistoryTarget(b.targetInput,{seriesInput:series({known:'2026-10-23T12:01:00Z'}),identityInput:identity({known:'2026-10-23T12:01:00Z'}),decisionAt:at}),/transition_regression/);
});
test('current heroes, forged target pins and future roster receipt are rejected',()=>{
 const a=build(),args=draftArgs(),t={...a.target,heroes:[1,2,3]};
 assert.throws(()=>produceSeriesHistoricalRelationalFeatures({targetInput:pinned(t),factsInput:args.factsInput,decisionAt:at}),/target_contract/);
 assert.throws(()=>produceSeriesHistoricalRelationalFeatures({targetInput:{...a.targetInput,utf8:a.targetInput.utf8+' '},factsInput:args.factsInput,decisionAt:at}),/target_pin/);
 assert.throws(()=>build({known:'2026-10-23T12:40:00.000000001Z'}));
});

test('a later transition cannot move the received series clock backwards',()=>{
 const a=build({known:'2026-10-23T12:30:00Z'});
 assert.throws(()=>advanceSeriesHistoryTarget(a.targetInput,{seriesInput:series({maps:1,known:'2026-10-23T12:00:00Z'}),identityInput:identity({known:'2026-10-23T12:40:00Z'}),decisionAt:at}),/series_history_receipt_regression/);
});

test('same-transition receipt watermark advances without moving the frozen cutoff',()=>{
 const a=build(),b=advanceSeriesHistoryTarget(a.targetInput,{seriesInput:series({known:'2026-10-23T12:10:00Z'}),identityInput:identity(),decisionAt:at});
 assert.equal(b.target.historyCutoffAt,a.target.historyCutoffAt);
 assert.equal(b.target.lastSeriesReceiptAt,'2026-10-23T12:10:00Z');
 assert.throws(()=>advanceSeriesHistoryTarget(b.targetInput,{seriesInput:series({known:'2026-10-23T12:05:00Z'}),identityInput:identity(),decisionAt:at}),/series_history_receipt_regression/);
});

test('unchanged cached roster stays valid through a newly observed inter-map transition',()=>{
 const a=build(),b=advanceSeriesHistoryTarget(a.targetInput,{seriesInput:series({maps:1,known:'2026-10-23T12:00:00Z'}),identityInput:identity(),decisionAt:at});
 assert.equal(b.target.historyCutoffAt,'2026-10-23T12:00:00Z');
 assert.equal(b.target.validFrom,'2026-10-23T12:00:00Z');
 assert.equal(b.target.identityKnownAt,a.target.identityKnownAt);
 const args=draftArgs({accounts:true});assert.ok(produceSeriesHistoricalRelationalFeatures({targetInput:b.targetInput,factsInput:args.factsInput,decisionAt:at,minimumSupport:3}).names.length>0);
});

test('changed roster disclosure cannot claim an earlier identity receipt',()=>{
 const a=build({anonymous:true,known:'2026-10-23T12:10:00Z'});
 assert.throws(()=>advanceSeriesHistoryTarget(a.targetInput,{seriesInput:series({known:'2026-10-23T12:20:00Z'}),identityInput:identity({known:'2026-10-23T12:00:00Z'}),decisionAt:at}),/identity_receipt_regression/);
 const args=draftArgs(),future=pinned({...a.target,lastSeriesReceiptAt:'2026-10-23T12:40:00.000000001Z'});
 assert.throws(()=>produceSeriesHistoricalRelationalFeatures({targetInput:future,factsInput:args.factsInput,decisionAt:at}),/target_times/);
});
