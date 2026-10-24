import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {draftArgs,pinned} from './observedDraftHistory.fixtures.mjs';
import {produceObservedDraftHistory} from './observedDraftHistory.mjs';
import {produceHistoricalRelationalFeatures} from './historicalRelationalFeatures.mjs';
import {deriveHistoricalFactVersion,exportHistoricalFactsFromVersions,pinRetainedHistoryJson as pin} from './retainedOpenDotaFacts.mjs';

function features(change=()=>{}){
 const args=draftArgs({accounts:true}),facts=JSON.parse(args.factsInput.utf8);
 for(const m of facts.maps){m.heroes=m.players.map(p=>({heroId:p.heroId,side:p.side}));m.heroesKnownAt=m.playersKnownAt;}
 change(facts);args.factsInput=pinned(facts);
 const context=produceObservedDraftHistory({...args,minimumSupport:3}).context;
 assert.ok(context);
 return produceHistoricalRelationalFeatures({historyContext:context,factsInput:args.factsInput,matchId:args.matchId,decisionAt:args.computedAt,minimumSupport:3});
}
const value=(c,n)=>c.values[c.names.indexOf(n)];
const row=(c,n)=>c.definitions[c.names.indexOf(n)];
const prefix='histrel.radiant.slot_0.player.90d.';
test('refreshing an unchanged old loss cannot reorder the latest played outcome streak',()=>{
 const a=features(),b=features(f=>{for(const k of ['outcomeKnownAt','playersKnownAt','heroesKnownAt'])f.maps[1][k]='2026-10-23T11:00:00Z';});
 assert.equal(value(a,prefix+'trailingOutcomeStreak'),1);
 assert.equal(value(b,prefix+'trailingOutcomeStreak'),1);
 assert.deepEqual(b.values,a.values);
 assert.equal(row(b,prefix+'trailingOutcomeStreak').knownAt,'2026-10-23T11:00:00Z');
});
test('decay weights use elapsed time since played map, while availability still gates future receipts',()=>{
 const c=features(),cutoff=Date.parse(c.historyCutoffAt),ended=Array.from({length:5},(_,i)=>Date.parse(`2026-10-${17+i}T13:45:00Z`));
 const w=ended.map(t=>2**(-(cutoff-t)/(86400000*90))),sw=w.reduce((a,b)=>a+b,0),wins=w.filter((_,i)=>i%2===0).reduce((a,b)=>a+b,0);
 assert.ok(Math.abs(value(c,prefix+'decayedWinFraction')-wins/sw)<1e-14);
 assert.ok(Math.abs(value(c,prefix+'smoothedDecayedWinFraction')-(wins+10)/(sw+20))<1e-14);
 assert.ok(row(c,prefix+'effectiveCount').formula.includes('endedAt'));
 const future=features(f=>{for(const k of ['outcomeKnownAt','playersKnownAt','heroesKnownAt'])f.maps[4][k]='2026-10-23T11:58:00.000000001Z';});
 assert.equal(value(future,prefix+'supportMaps'),4);
 assert.equal(value(future,prefix+'trailingOutcomeStreak'),-1);
});
function retainedFacts({refreshOutcomeOnly=false}={}){
 const versions=[];
 for(let i=0;i<5;i++){
  const data=JSON.parse(pin({match_id:101+i,start_time:Math.floor(Date.UTC(2026,9,17+i,12)/1000),duration:1800,radiant_win:i%2===0,radiant_team_id:100,dire_team_id:200,players:Array.from({length:10},(_,j)=>({player_slot:j<5?j:128+j-5,hero_id:j+1,account_id:j+1,gold_per_min:400}))}).utf8);
  const selectedInput=pin({schemaVersion:1,source:'opendota',endpoint:`https://api.opendota.com/api/matches/${data.match_id}`,matchId:data.match_id,receivedAt:'2026-10-22T12:00:00Z',availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:createHash('sha256').update(JSON.stringify(data)).digest('hex'),payload:data});
  versions.push(deriveHistoricalFactVersion({selectedInput}).versionInput);
  if(refreshOutcomeOnly&&i===0){
   const refreshed=JSON.parse(selectedInput.utf8);delete refreshed.payload.players;
   refreshed.receivedAt='2026-10-23T11:50:00Z';refreshed.payloadSha256=createHash('sha256').update(JSON.stringify(refreshed.payload)).digest('hex');
   versions.push(deriveHistoricalFactVersion({selectedInput:pin(refreshed)}).versionInput);
  }
 }
 return exportHistoricalFactsFromVersions({versionInputs:versions,targetMapId:'90001',historyCutoffAt:'2026-10-23T11:58:00Z'}).factsInput;
}
test('retained local-corpus support never claims professional or global source population',()=>{
 const a=draftArgs({accounts:true}),factsInput=retainedFacts(),context=produceObservedDraftHistory({...a,factsInput,availabilityBasis:'retained_receipt_reconstruction',minimumSupport:3}).context;
 const c=produceHistoricalRelationalFeatures({historyContext:context,factsInput,matchId:a.matchId,decisionAt:a.computedAt,minimumSupport:3});
 assert.equal(c.audit.populationBasis,'bounded_provided_retained_corpus_not_global');
 for(const s of Object.values(c.support))if(s.population)assert.equal(s.population,'provided_retained_response_known_identity_maps');
});

test('outcome-only refresh preserves previously observed roster with combined dependency availability',()=>{
 const args=draftArgs({accounts:true}),factsInput=retainedFacts({refreshOutcomeOnly:true}),maps=JSON.parse(factsInput.utf8).maps,m=maps.find(m=>m.matchId==='101');
 assert.equal(m.players.length,10);assert.equal(m.playersKnownAt,'2026-10-23T11:50:00Z');
 assert.equal(m.outcomeKnownAt,'2026-10-23T11:50:00Z');assert.equal(m.fieldAvailability['/players/0/account_id'].knownAt,'2026-10-22T12:00:00Z');
 const made=produceObservedDraftHistory({...args,factsInput,availabilityBasis:'retained_receipt_reconstruction',minimumSupport:3});
 assert.equal(made.context.featurePayload.players.find(p=>p.accountId==='1').statistics.recentForm.supportMaps,5);
 assert.equal(made.context.featurePayload.players.find(p=>p.accountId==='1').values.recentForm,0.6);
 const c=produceHistoricalRelationalFeatures({historyContext:made.context,factsInput,matchId:args.matchId,decisionAt:args.computedAt,minimumSupport:3});
 assert.equal(value(c,prefix+'supportMaps'),5);assert.equal(value(c,prefix+'trailingOutcomeStreak'),1);
});
