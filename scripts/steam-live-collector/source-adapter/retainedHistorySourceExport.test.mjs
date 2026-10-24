import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {draftArgs,draftEntry} from './observedDraftHistory.fixtures.mjs';
import {pinRetainedHistoryJson as pin,deriveHistoricalFactVersion} from './retainedOpenDotaFacts.mjs';
import {createRetainedHistorySourceExport as encode,verifyRetainedHistorySourceExport as verify} from './retainedHistorySourceExport.mjs';
import {verifyHistorySourceExport as dispatch} from './historySourceVerifier.mjs';
const T0='2026-10-23T11:57:00Z',T1='2026-10-23T11:58:00.000000001Z',NOW='2026-10-23T12:30:00Z';
function version({time=T0,matchId=101,gpm=500,hero=1}={}){
 const p=JSON.parse(pin({match_id:matchId,start_time:1792660000,duration:1800,radiant_win:true,players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,hero_id:i===0?hero:i+1,account_id:i+1,gold_per_min:gpm}))}).utf8);
 const source={selectedInput:pin({schemaVersion:1,source:'opendota',endpoint:`https://api.opendota.com/api/matches/${matchId}`,matchId,receivedAt:time,availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:createHash('sha256').update(JSON.stringify(p)).digest('hex'),payload:p})};return deriveHistoricalFactVersion(source).versionInput;
}
const options=extra=>({...draftArgs(),exportedAt:NOW,versionInputs:[version()],...extra});
test('retained bridge binds actual source bytes, replays draft and leaves native absence explicit',()=>{
 const e=encode(options()),b=JSON.parse(e.envelopeInput.utf8);assert.equal(e.identity.historyCutoffAt,'2026-10-23T11:58:00Z');assert.equal(e.population.factsUsable,true);assert.equal(e.population.nativeCandidatesPinned,false);assert.equal(e.population.globalPopulationComplete,false);assert.deepEqual(JSON.parse(b.nativeInput.utf8).observations,[]);assert.equal(b.readReceiptInput,null);assert.equal(b.evidencePolicy.availabilityBasis,'retained_collector_response_receipt');assert.equal(b.versionInputs.length,1);
 assert.equal(dispatch(e.envelopeInput,{expectedSourceSnapshotHash:e.sourceSnapshotHash,decisionAt:NOW,matchId:'90001'}).sourceSnapshotHash,e.sourceSnapshotHash);assert.equal(Object.isFrozen(e.identity.selectors.targetHeroIds),true);
});
test('future append and duplicate/input permutations leave frozen export hash unchanged',()=>{
 const a=version(),future=version({time:T1,gpm:999}),first=encode(options({versionInputs:[a]})),next=encode(options({versionInputs:[future,a,a]}));assert.equal(first.sourceSnapshotHash,next.sourceSnapshotHash);assert.equal(next.inputAudit.futureVersionsExcluded,1);
});
test('equal-receipt contradictory versions retain both proofs through bridge normalization',()=>{
 const a=version(),b=version({gpm:700}),e=encode(options({versionInputs:[a,b]})),body=JSON.parse(e.envelopeInput.utf8);assert.equal(body.versionInputs.length,2);assert.equal(JSON.parse(body.factsInput.utf8).maps[0].heroPerformances.length,0);assert.equal(verify(e.envelopeInput).sourceSnapshotHash,e.sourceSnapshotHash);
});
test('late draft identity revision keeps original history cutoff, availability and byte proof',()=>{
 const a=options(),first=encode(a);a.draftPrefixInputs.push(draftEntry({accounts:true,time:'2026-10-23T12:15:00Z'}));const later=encode(a);
 assert.equal(later.identity.historyCutoffAt,first.identity.historyCutoffAt);assert.equal(later.identity.validFrom,'2026-10-23T12:15:00Z');assert.notEqual(later.identity.draftRevisionHash,first.identity.draftRevisionHash);assert.equal(later.identity.selectors.targetAccountIds.length,10);
 assert.throws(()=>verify(later.envelopeInput,{decisionAt:'2026-10-23T12:14:59.999999999Z',readMode:'reconstructed'}),/not_available_at_decision/);assert.throws(()=>verify(first.envelopeInput,{decisionAt:'2026-10-23T12:00:00Z'}),/not_available_at_decision/);
});
test('changed derived facts, raw version values, draft metadata or claimed population fail rebuild verification',()=>{
 const e=encode(options());for(const mutation of [b=>{b.population.factsUsable=false;},b=>{const f=JSON.parse(b.factsInput.utf8);f.maps[0].radiantWon=false;b.factsInput=pin(f);},b=>{const v=JSON.parse(b.versionInputs[0].utf8);v.fields.find(f=>f.path==='/duration').value=1;b.versionInputs[0]=pin(v);},b=>{b.identity.validFrom='2020-01-01T00:00:00Z';}]){
  const b=JSON.parse(e.envelopeInput.utf8);mutation(b);assert.throws(()=>verify(pin(b)),/derived_or_source_tamper|version_not_rederived_from_source/);
 }
});
test('empty retained corpus does not invent successful native population, and completion time is explicit',()=>{
 const e=encode(options({versionInputs:[]})),b=JSON.parse(e.envelopeInput.utf8);assert.deepEqual(JSON.parse(b.factsInput.utf8).maps,[]);assert.equal(e.population.facts,'complete_empty_within_provided_retained_corpus');assert.equal(e.population.allCollectionsComplete,false);
 const a=options();delete a.exportedAt;assert.throws(()=>encode(a),/materialization_times/);
});
test('consumed full source persistence cannot follow its claimed export completion, including +1ns',()=>{
 const selected=JSON.parse(JSON.parse(version().utf8).sourceInputs.selectedInput.utf8),payloadInput=pin(selected.payload);
 const receipt={contract:'opendota_full_decoded_match_json.v1',source:'opendota',sourceEndpoint:'GET_matches_by_id',job:'ingest_parsed',matchId:101,evidenceCohort:'post_match',actualLive:false,terminalStateIndependentlyVerified:false,requestStartedAt:T0,requestTimeMeaning:'bounded_get_operation_start_including_policy_waits_and_retries',receivedAt:T0,receiptTimeMeaning:'collector_json_decode_completed',payloadPersistedAt:'2026-10-23T12:30:00.000000001Z',payloadRepresentation:'full_decoded_json_with_explicit_secret_redaction',providerWireBytesRetained:false,originalWireSha256:null,payloadSha256:payloadInput.pin.sha256,payloadBytes:payloadInput.pin.bytes,payloadFile:`payloads/${payloadInput.pin.sha256}.json.gz`,redactedFields:0,redactedUrlValues:0,originalHistoricalAvailabilityProven:false,selectedObservationFilename:null};
 const v=deriveHistoricalFactVersion({receiptInput:pin(receipt),payloadInput}).versionInput;assert.throws(()=>encode(options({versionInputs:[v]})),/source_persisted_after_export/);
 receipt.payloadPersistedAt=NOW;const at=deriveHistoricalFactVersion({receiptInput:pin(receipt),payloadInput}).versionInput;assert.equal(encode(options({versionInputs:[at]})).population.factsUsable,true);
});
