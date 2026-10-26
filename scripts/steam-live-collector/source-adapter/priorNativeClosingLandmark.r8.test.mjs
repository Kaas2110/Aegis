/** Synthetic raw-replay prior-map fixtures, not real-data source coverage. */
import test from 'node:test';import assert from 'node:assert/strict';
import {alignedArgs,pinned} from './observedDraftHistory.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {produceObservedDraftHistory} from './observedDraftHistory.mjs';
import {produceHistoricalRelationalFeatures} from './historicalRelationalFeatures.mjs';
function input({clock=600,durationReceipts=true,lead=5000,earlyFinish=false}={}){
 const a=alignedArgs({explicit:true}),facts=JSON.parse(a.factsInput.utf8),observations=[];
 for(const [index,e]of a.nativeEvidenceInputs.entries()){
  const raw=JSON.parse(e.rawCaptureInput.utf8),game=raw.result.games[0],old=JSON.parse(e.observationInput.utf8),capture=old.source.capture;game.scoreboard.duration=earlyFinish?590:clock;
  for(const side of ['radiant','dire'])for(const p of game.scoreboard[side].players)p.net_worth=5000+(side==='radiant'?lead/5:0)+index;
  const rawCaptureInput=pinned(raw),o=normalizeLocalCapture({...capture,body:Buffer.from(rawCaptureInput.utf8),rawSha256:rawCaptureInput.pin.sha256,payloadRef:'journal:'+rawCaptureInput.pin.sha256}).observations[0];
  if(durationReceipts)facts.maps[index].durationKnownAt=facts.maps[index].outcomeKnownAt;
  if(earlyFinish)facts.maps[index].durationSeconds=600;
  const prior={...JSON.parse(e.priorMapInput.utf8),durationSeconds:facts.maps[index].durationSeconds};
  a.nativeEvidenceInputs[index]={observationInput:pinned(o),rawCaptureInput,priorMapInput:pinned(prior)};observations.push(o);
 }
 a.factsInput=pinned(facts);a.nativeInput=pinned({contract:'aegis.pinned-native-economy-observations.v1',observations});return a;
}
function reference(result,side='radiant',condition='lead_at_least_1000'){return result.context.featurePayload.closingLandmarkReferences.find(ref=>ref.side===side&&ref.landmarkSeconds===600&&ref.condition===condition);}
test('S05 prior90d landmark support/remaining time and opposite-team recovery use the same actual source state',()=>{
 const r=produceObservedDraftHistory(input({clock:590})),lead=reference(r),deficit=reference(r,'dire','deficit_at_most_minus_1000');
 assert.equal(lead.supportMaps,5);assert.equal(lead.values.winFraction,.6);assert.equal(deficit.values.winFraction,.4);assert.equal(lead.values.meanRemainingDurationSeconds,1920);assert.equal(lead.values.remainingDurationP25Seconds,1860);assert.equal(lead.values.remainingDurationMedianSeconds,1920);assert.equal(lead.values.remainingDurationP75Seconds,1980);assert.equal(lead.values.meanAnchorLagSeconds,10);assert.equal(lead.minimumSupport,5);assert.equal(lead.sourceObservations[0].gameClockSeconds,590);assert.equal(lead.sourceObservations[0].remainingDurationFromLandmarkSeconds,1800);assert.ok(r.context.dependencies.some(d=>d.kind==='static_reference'&&d.referenceType==='prior_duration_fact'));
});
test('S05 absent duration timestamps, future anchors, insufficient lead and already-ended maps do not create risk-set labels',()=>{
 for(const options of [{durationReceipts:false},{clock:601},{lead:999},{earlyFinish:true}]){const r=produceObservedDraftHistory(input(options)),ref=reference(r);assert.equal(ref.supportMaps,0,JSON.stringify(options));assert.equal(ref.values.meanRemainingDurationSeconds,null);}
});
test('S05 an explicit future duration receipt or conflicting raw state never becomes a qualified historical feature',()=>{
 const a=input(),facts=JSON.parse(a.factsInput.utf8);facts.maps[0].durationKnownAt='2026-10-23T11:58:00.000000001Z';a.factsInput=pinned(facts);const r=produceObservedDraftHistory(a),ref=reference(r);assert.equal(ref.supportMaps,4);assert.equal(ref.values.meanRemainingDurationSeconds,null);
 const b=input(),n=JSON.parse(b.nativeInput.utf8);n.observations[0].sides.radiant.players[0].netWorth.value++;b.nativeInput=pinned(n);b.nativeEvidenceInputs[0].observationInput=pinned(n.observations[0]);assert.throws(()=>produceObservedDraftHistory(b),/raw_normalized_evidence_mismatch/);
});
test('S05 actual historical factory appends all96 columns with exact units/current-team selection and no current outcome edge',()=>{
 const a=input(),history=produceObservedDraftHistory(a),r=produceHistoricalRelationalFeatures({historyContext:history.context,factsInput:a.factsInput,matchId:a.matchId,decisionAt:a.computedAt,minimumSupport:5}),defs=r.definitions.filter(d=>d.familyId==='S05');assert.equal(defs.length,96);const name='histrel.radiant.closing_landmark.600s.lead_at_least_1000.meanRemainingDurationSeconds',at=r.names.indexOf(name);assert.equal(r.values[at],1920);assert.equal(r.definitions[at].units,'seconds');assert.deepEqual(r.definitions[at].historyDefinitions,[]);assert.equal(r.definitions[at].parameterClassification.rowParameters.currentTeamId,'100');assert.ok(r.definitions[at].inputBindings.every(port=>!port.normalizedField.includes('currentOutcome')));
});
