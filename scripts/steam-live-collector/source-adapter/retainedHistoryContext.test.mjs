import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {draftArgs} from './observedDraftHistory.fixtures.mjs';
import {pinRetainedHistoryJson as pin,deriveHistoricalFactVersion} from './retainedOpenDotaFacts.mjs';
import {createRetainedHistorySourceExport} from './retainedHistorySourceExport.mjs';
import {produceObservedDraftHistory,validateObservedDraftHistory} from './observedDraftHistory.mjs';
import {createDynamicHistoryProof,readDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {qualifyRetainedHistoryCorpus} from './historyCalculationCore.mjs';
function retainedInputs({anonymous=false}={}){
 const a=draftArgs({accounts:true}),versionInputs=[];
 for(let i=0;i<5;i++){
  const p=JSON.parse(pin({match_id:101+i,start_time:Math.floor(Date.UTC(2026,9,17+i,12)/1000),duration:1800+i*300,radiant_win:i%2===0,radiant_score:30,dire_score:20,radiant_team_id:100,dire_team_id:200,players:Array.from({length:10},(_,j)=>({player_slot:j<5?j:128+j-5,hero_id:j+1,account_id:anonymous?null:j+1,gold_per_min:400}))}).utf8),selectedInput=pin({schemaVersion:1,source:'opendota',endpoint:`https://api.opendota.com/api/matches/${101+i}`,matchId:101+i,receivedAt:'2026-10-22T12:00:00Z',availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:createHash('sha256').update(JSON.stringify(p)).digest('hex'),payload:p});
  versionInputs.push(deriveHistoricalFactVersion({selectedInput}).versionInput);
 }
 const source=createRetainedHistorySourceExport({...a,versionInputs,exportedAt:a.computedAt}),body=JSON.parse(source.envelopeInput.utf8);return{...a,factsInput:body.factsInput,nativeInput:body.nativeInput,availabilityBasis:'retained_receipt_reconstruction'};
}
test('shared observed context projects retained-corpus personal/team/hero forms without inventing global scope',()=>{
 const a=retainedInputs(),r=produceObservedDraftHistory(a);assert.equal(r.status,'produced_reconstruction');const p=r.context.featurePayload.players.find(p=>p.accountId==='1');assert.equal(p.values.recentForm,0.6);assert.equal(p.values.heroForm,0.6);assert.equal(p.values.teamForm,0.6);assert.equal(p.values.heroLateTendency,0.6);assert.equal(p.statistics.recentForm.sourcePopulation,'provided_retained_response_corpus_only');assert.equal(p.statistics.heroLateTendency.globalPopulationComplete,false);assert.equal(r.audit.targetHistoryScope.metadataValid,true);assert.equal(r.audit.targetHistoryScope.accountIdsQualified,10);assert.equal(r.context.producer.sourcePopulation.originalHistoricalAvailabilityProven,false);assert.equal(r.context.recordedPrediction,false);
});
test('anonymous retained historical accounts preserve known-hero population while player form stays missing',()=>{
 const r=produceObservedDraftHistory(retainedInputs({anonymous:true})),p=r.context.featurePayload.players[0];assert.equal(p.values.recentForm,null);assert.equal(p.values.heroLateTendency,0.6);assert.equal(p.statistics.heroLateTendency.population,'local_retained_response_known_hero_maps_90d');
});
test('scope and field provenance must qualify; an old SQL row cannot be relabelled retained or recorded',()=>{
 const a=retainedInputs();assert.equal(qualifyRetainedHistoryCorpus(JSON.parse(a.factsInput.utf8),'2026-10-23T11:58:00Z').verified,true);
 assert.throws(()=>produceObservedDraftHistory({...draftArgs(),availabilityBasis:'retained_receipt_reconstruction'}),/retained_source_scope_or_basis/);assert.throws(()=>produceObservedDraftHistory({...a,availabilityBasis:'recorded_input_receipts'}),/retained_source_scope_or_basis/);
 for(const mutate of [f=>f.scope.globalPopulationComplete=true,f=>f.maps[0].availabilityBasis='database_timestamp_reconstruction',f=>f.maps[0].fieldAvailability['/duration'].knownAt='2026-10-23T11:58:00.000000001Z']){const f=JSON.parse(a.factsInput.utf8);mutate(f);assert.throws(()=>produceObservedDraftHistory({...a,factsInput:pin(f)}),/retained_source_scope_or_basis/);}
});
test('retained restart/replay uses actual later computation time and explicit reconstructed decision gate',()=>{
 const a={...retainedInputs(),computedAt:'2026-10-24T12:00:00Z'},made=createDynamicHistoryProof(a);assert.equal(made.context.computedAt,a.computedAt);const past='2026-10-23T12:00:00Z';assert.equal(readDynamicHistoryProof(made.proof,{matchId:a.matchId,decisionAt:past}).accepted,false);assert.equal(readDynamicHistoryProof(made.proof,{matchId:a.matchId,decisionAt:past,readMode:'reconstructed'}).accepted,true);
 const replay=createDynamicHistoryProof(a);assert.equal(replay.context.contentHash,made.context.contentHash);assert.equal(replay.context.recordedPrediction,false);assert.equal(validateObservedDraftHistory(replay.context,{matchId:a.matchId,decisionAt:past,readMode:'reconstructed'}).accepted,true);
});
