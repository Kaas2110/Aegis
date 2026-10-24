import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pinRetainedHistoryJson as pin,readRetainedOpenDotaResponse,deriveHistoricalFactVersion as derive,verifyHistoricalFactVersion,selectHistoricalFactVersions as select,exportHistoricalFactsFromVersions as exported} from './retainedOpenDotaFacts.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const T0='2026-10-01T12:00:00.000000000Z',T1='2026-10-01T12:10:00.000000000Z',T2='2026-10-01T12:20:00.000000000Z';
const payload=(match_id=101)=>({match_id,start_time:1790850000,duration:1800,radiant_win:true,radiant_score:20,dire_score:10,radiant_team_id:10,dire_team_id:20,players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,hero_id:i+1,account_id:1000+i,kills:2,gold_per_min:400}))});
function selected(data,receivedAt=T0){const p=JSON.parse(pin(data).utf8);return{selectedInput:pin({schemaVersion:1,source:'opendota',endpoint:`https://api.opendota.com/api/matches/${p.match_id}`,matchId:p.match_id,receivedAt,availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:sha(JSON.stringify(p)),payload:p})};}
function full(data,receivedAt=T0){const payloadInput=pin(data),r={contract:'opendota_full_decoded_match_json.v1',source:'opendota',sourceEndpoint:'GET_matches_by_id',job:'ingest_parsed',matchId:data.match_id,evidenceCohort:'post_match',actualLive:false,terminalStateIndependentlyVerified:false,requestStartedAt:'2026-10-01T11:59:00Z',requestTimeMeaning:'bounded_get_operation_start_including_policy_waits_and_retries',receivedAt,receiptTimeMeaning:'collector_json_decode_completed',payloadPersistedAt:T1,payloadRepresentation:'full_decoded_json_with_explicit_secret_redaction',providerWireBytesRetained:false,originalWireSha256:null,payloadSha256:payloadInput.pin.sha256,payloadBytes:payloadInput.pin.bytes,payloadFile:`payloads/${payloadInput.pin.sha256}.json.gz`,redactedFields:0,redactedUrlValues:0,originalHistoricalAvailabilityProven:false,selectedObservationFilename:null};return{receiptInput:pin(r),payloadInput};}
const version=(data,at)=>derive(selected(data,at)).versionInput;
const output=(versions,cutoff=T1)=>exported({versionInputs:versions,targetMapId:'999',historyCutoffAt:cutoff});
const maps=x=>JSON.parse(x.factsInput.utf8).maps;

test('selected envelope proves exact retained bytes and keeps unknown persistence explicit',()=>{
 const r=readRetainedOpenDotaResponse(selected(payload()));assert.equal(r.source.matchId,'101');assert.equal(r.source.receivedAt,T0);assert.equal(r.source.payloadPersistedAt,null);assert.equal(r.source.originalHistoricalAvailabilityProven,false);assert.equal(r.source.trustScope,'local_collector_receipt_assertion');assert.equal(Object.isFrozen(r.payload.players[0]),true);
 assert.throws(()=>readRetainedOpenDotaResponse({payloadInput:pin(payload())}),/source_inputs_contract/);
 const bad=selected(payload());const envelope=JSON.parse(bad.selectedInput.utf8);envelope.payload.duration=60;assert.throws(()=>readRetainedOpenDotaResponse({selectedInput:pin(envelope)}),/selected_receipt_contract/);
});
test('full retained body binds receipt hash, decode receipt and persistence independently',()=>{
 const r=readRetainedOpenDotaResponse(full(payload()));assert.equal(r.source.payloadPersistedAt,T1);assert.equal(r.source.persistenceTimeKnown,true);assert.equal(r.source.providerWireBytesRetained,false);
 const x=full(payload());x.payloadInput=pin({...payload(),radiant_win:false});assert.throws(()=>readRetainedOpenDotaResponse(x),/full_receipt_contract/);
 const y=full(payload());const receipt=JSON.parse(y.receiptInput.utf8);receipt.payloadPersistedAt='2026-10-01T11:00:00Z';y.receiptInput=pin(receipt);assert.throws(()=>readRetainedOpenDotaResponse(y),/full_receipt_chronology/);
});
test('receipt availability is never invented from event end or bare provider body',()=>{
 const v=version(payload(),T1);assert.equal(maps(output([v],T0)).length,0);assert.equal(maps(output([v],T1)).length,1);
 const bad=payload();bad.start_time=1791000000;assert.equal(maps(output([version(bad,T0)])).length,0);
});
test('current map and exactly future +1ns receipt are excluded',()=>{
 const current=version(payload(999),T0),future=version(payload(102),'2026-10-01T12:10:00.000000001Z'),now=version(payload(),T1);
 const x=output([current,future,now]);assert.deepEqual(maps(x).map(x=>x.matchId),['101']);assert.equal(x.audit.currentMapExcluded,1);assert.equal(x.audit.futureVersionsExcluded,1);
});
test('latest field is chosen by receipt independent of append/arrival order; later merged fields cannot move earlier',()=>{
 const old=payload(),fresh=payload();delete old.players[0].gold_per_min;fresh.players[0].gold_per_min=900;
 const a=version(old,T0),b=version(fresh,T1);assert.equal(maps(output([a,b],T0))[0].heroPerformances.find(p=>p.heroId===1).metrics.gpm,null);
 const x=output([a,b]),y=output([b,a]);assert.equal(x.factsInput.pin.sha256,y.factsInput.pin.sha256);const p=maps(x)[0].heroPerformances.find(p=>p.heroId===1);assert.equal(p.metrics.gpm,900);assert.equal(p.metricAvailability.gpm,T1);
});
test('absent later field preserves past value; explicit null invalidates it at its own receipt',()=>{
 const first=payload(),missing=payload(),redacted=payload();delete missing.players[0].gold_per_min;redacted.players[0].gold_per_min=null;
 const a=version(first,T0),b=version(missing,T1),c=version(redacted,T2);
 const metric=vs=>maps(output(vs,T2))[0].heroPerformances.find(p=>p.heroId===1).metrics.gpm;
 assert.equal(metric([a,b]),400);assert.equal(metric([a,b,c]),null);assert.equal(maps(output([a,b,c],T1))[0].heroPerformances.find(p=>p.heroId===1).metrics.gpm,400);
});
test('known hero remains usable anonymously; account disclosure cannot attribute an old anonymous metric',()=>{
 const a=payload(),b=payload();a.players[0].account_id=null;delete b.players[0].gold_per_min;
 const v0=version(a,T0),v1=version(b,T1),early=maps(output([v0,v1],T0))[0],late=maps(output([v0,v1]))[0];
 assert.equal(early.heroes.length,10);assert.equal(early.players.length,9);assert.equal(early.heroPerformances.find(p=>p.heroId===1).accountId,null);assert.equal(late.players.length,10);assert.equal(late.heroPerformances.find(p=>p.heroId===1).metrics.gpm,null);assert.equal(late.playersKnownAt,T1);
});
test('hero replacement cannot inherit old account or performance; duplicate slots and heroes rejected',()=>{
 const a=payload(),b=payload();b.players[0]={player_slot:0,hero_id:100};const m=maps(output([version(a,T0),version(b,T1)]))[0];
 assert.ok(m.heroes.some(p=>p.heroId===100));assert.ok(!m.players.some(p=>p.accountId==='1000'));assert.ok(!m.heroPerformances.some(p=>p.heroId===100));
 const duplicate=payload();duplicate.players[1].player_slot=0;assert.throws(()=>version(duplicate,T0),/roster_slot_conflict/);const heroDuplicate=payload();heroDuplicate.players[1].hero_id=1;assert.throws(()=>version(heroDuplicate,T0),/roster_hero_conflict/);
});
test('equal-time contradictions stay unavailable with deterministic order-independent provenance',()=>{
 const a=payload(),b=payload();b.players[0].gold_per_min=700;const x=version(a,T0),y=version(b,T0);
 const one=select({versionInputs:[x,y],targetMapId:'999',historyCutoffAt:T1}),two=select({versionInputs:[y,x],targetMapId:'999',historyCutoffAt:T1});
 assert.deepEqual(one.fields,two.fields);assert.equal(one.fields.find(f=>f.path==='/players/0/gold_per_min').status,'conflicting_receipt');assert.equal(one.audit.conflictingFields,1);
});
test('A to B to A identity revisions cannot resurrect metric values from a previous identity epoch',()=>{
 const a=payload(),b=payload(),c=payload();b.players[0]={player_slot:0,hero_id:100,account_id:5000};delete c.players[0].gold_per_min;
 const v=[version(a,T0),version(b,T1),version(c,T2)],m=maps(output(v,T2))[0];assert.equal(m.heroPerformances.find(p=>p.heroId===1).metrics.gpm,null);assert.equal(m.identityContinuity.find(p=>p.playerSlot===0).heroBarrierAt,T1);
 const d=payload();d.players[0].account_id=5000;const accountOnly=maps(output([version(a,T0),version(d,T1),version(c,T2)],T2))[0];assert.equal(accountOnly.heroPerformances.find(p=>p.heroId===1).metrics.gpm,null);
});
test('later-only score inputs conservatively gate compatibility facts while preserving actual outcome receipt',()=>{
 const a=payload(),b=payload();delete a.radiant_score;delete a.dire_score;const m=maps(output([version(a,T0),version(b,T1)]))[0];assert.equal(m.outcomeObservedAt,T1); // same result is observed again at t1
 const c=payload();delete c.radiant_win;const n=maps(output([version(a,T0),version(c,T1)]))[0];assert.equal(n.outcomeObservedAt,T0);assert.equal(n.outcomeKnownAt,T1);assert.equal(n.fieldAvailability['/radiant_score'].knownAt,T1);
});
test('future append leaves earlier facts bytes and used source-version binding unchanged',()=>{
 const a=version(payload(),T0),b=payload();b.radiant_win=false;b.players[0].gold_per_min=999;
 const before=output([a]),after=output([a,version(b,T2)]);assert.equal(before.factsInput.utf8,after.factsInput.utf8);assert.deepEqual(before.bindings,after.bindings);
});
test('derived values cannot be forged even with a matching new envelope digest',()=>{
 const good=version(payload(),T0),bad=JSON.parse(good.utf8);bad.fields.find(f=>f.path==='/duration').value=100;
 assert.throws(()=>verifyHistoricalFactVersion(pin(bad)),/version_not_rederived_from_source/);
 const r=JSON.parse(good.utf8);r.source.receivedAt='2020-01-01T00:00:00Z';assert.throws(()=>verifyHistoricalFactVersion(pin(r)),/version_not_rederived_from_source/);
});
test('clock arrays cannot splice across receipts and final net worth never becomes an old trajectory',()=>{
 const a=payload(),b=payload();Object.assign(a.players[0],{times:[0,60],gold_t:[100,200],networth_t:[600,800]});Object.assign(b.players[0],{gold_t:[900,1000],net_worth:9999});
 const x=select({versionInputs:[version(a,T0),version(b,T1)],targetMapId:'999',historyCutoffAt:T1});const f=x.fields.find(f=>f.path==='/players/0/clock_series');assert.equal(f.knownAt,T0);assert.deepEqual(f.value.networth_t,[600,800]);assert.deepEqual(f.value.gold_t,[100,200]);
});
test('scope remains a local retained corpus and rejects an invented complete SQL population claim',()=>{
 const v=version(payload(),T0),x=output([v]),scope=JSON.parse(x.factsInput.utf8).scope;assert.equal(scope.globalPopulationComplete,false);assert.equal(scope.sourceUniverse,'locally_retained_opendota_responses');assert.equal(x.audit.independentFieldAvailabilityAttested,false);
 assert.throws(()=>exported({versionInputs:[v],targetMapId:'999',historyCutoffAt:T1,scope:{sourceUniverse:'local_pro_matches_join_match_parsed',completeWithinSource:true}}),/scope_contract/);
});
test('exact offset-aware nanoseconds and source-input byte bounds govern replay',()=>{
 const one=version(payload(),'2026-10-01T15:10:00.000000001+03:00');assert.equal(maps(output([one],T1)).length,0);
 const v=version(payload(),T0);const bad={...v,pin:{...v.pin,bytes:v.pin.bytes-1}};assert.throws(()=>output([bad]),/input_bytes/);
});
