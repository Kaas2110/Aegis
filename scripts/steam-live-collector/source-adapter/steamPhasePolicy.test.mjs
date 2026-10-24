import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySteamObservationPhase as classify} from './steamPhasePolicy.mjs';
const receipt='2026-10-20T12:00:00.000000001Z';
function observation(phase=5,clock=900){return {
 contract:'steam-live-scoreboard-candidate.v1',matchId:'100',observationId:'a'.repeat(64),sourceQualityReasons:[],
 source:{capture:{endpoint:'GetLiveLeagueGames/v1',receivedAt:receipt,rawSha256:'b'.repeat(64)},rawPacket:{}},
 providerGameClockSeconds:{missing:clock===null,value:clock},
 dynamic:{contract:'steam-glg-dynamic-observation.v1',sourceProfile:'steam.GetLiveLeagueGames.v1.scoreboard',phase:phase===null?{status:'absent',missing:true,value:null,rawValue:null}:{status:'observed',missing:false,value:phase,rawValue:phase}},
 sides:Object.fromEntries(['radiant','dire'].map((side,s)=>[side,{teamId:String(10+s),players:Array.from({length:5},(_,i)=>({identity:{side,teamId:String(10+s),heroId:String(s*5+i+1),accountId:String(s*5+i+100)}}))}]))
};}
test('explicit phase5 with nonnegative clock is a diagnostic live state only',()=>{
 const o=observation(),r=classify(o,{decisionAt:receipt});assert.equal(r.classification,'observed_live');assert.equal(r.dynamicDiagnosticAllowed,true);assert.equal(r.staticDraftDiagnosticAllowed,false);assert.equal(r.provenance.rawSha256,o.source.capture.rawSha256);assert.equal(r.eligibleForServing,false);assert.equal(r.provenance.providerEventTimeProven,false);
});
test('absent phase plus positive or zero clock is never LIVE or early POST cohort',()=>{
 for(const clock of [0,900,6000]){const r=classify(observation(null,clock));assert.equal(r.classification,'unclassified_static_draft_only');assert.equal(r.dynamicDiagnosticAllowed,false);assert.equal(r.staticDraftDiagnosticAllowed,true);assert.equal(r.cohort,'unknown_or_late_not_early_postdraft');assert.equal(r.clock,clock);}
});
test('phase5 lacking usable live clock is blocked without static fallback',()=>{
 for(const clock of [null,-1]){const r=classify(observation(5,clock));assert.equal(r.reason,'explicit_live_phase_requires_nonnegative_clock');assert.equal(r.staticDraftDiagnosticAllowed,false);assert.equal(r.dynamicDiagnosticAllowed,false);}
});
test('explicit draft phases retain known full draft despite clock, without inferred live',()=>{
 for(const phase of [2,3,4]){const r=classify(observation(phase,800));assert.equal(r.classification,'observed_postdraft');assert.equal(r.dynamicDiagnosticAllowed,false);assert.equal(r.staticDraftDiagnosticAllowed,true);}
});
test('postgame blocks even with incomplete roster; disconnect does not invent finish',()=>{
 const o=observation(6);o.sides.radiant.players=[];const r=classify(o);assert.equal(r.classification,'observed_post_game');assert.equal(r.terminal,true);assert.equal(r.outcomeKnown,false);assert.equal(r.staticDraftDiagnosticAllowed,false);
 const disconnect=classify(observation(7));assert.equal(disconnect.classification,'blocked');assert.equal(disconnect.terminal,false);
});
test('outcome marker presence blocks without reading a winner',()=>{
 const o=observation();o.sourceQualityReasons.push('outcome_marker_present');o.source.rawPacket.radiant_win=false;
 const r=classify(o);assert.equal(r.terminal,true);assert.equal(r.outcomeKnown,false);assert.equal(r.dynamicDiagnosticAllowed,false);assert.equal(r.staticDraftDiagnosticAllowed,false);assert.ok(r.provenance.outcomeIndicatorNames.includes('radiant_win'));
});
test('unclassified raw completion marker false/empty is blocked, never claimed finished',()=>{
 for(const v of [false,'',0,null]){const o=observation();o.source.rawPacket.finished=v;const r=classify(o);assert.equal(r.reason,'raw_completion_indicator_unclassified');assert.equal(r.terminal,false);assert.equal(r.outcomeKnown,false);assert.equal(r.staticDraftDiagnosticAllowed,false);}
});
test('invalid or inconsistent phase representation never falls back',()=>{
 for(const mutation of [p=>{p.status='invalid';},p=>{p.rawValue=6;},p=>{p.missing=true;},p=>{p.value=14;}]){const o=observation();mutation(o.dynamic.phase);const r=classify(o);assert.equal(r.reason,'phase_encoding_invalid');assert.equal(r.staticDraftDiagnosticAllowed,false);}
});
test('unknown accounts keep a known draft; duplicate heroes/accounts/conflicting sides block',()=>{
 const hidden=observation();hidden.sides.radiant.players[0].identity.accountId=null;assert.equal(classify(hidden).dynamicDiagnosticAllowed,true);assert.equal(classify(hidden).identity.knownAccounts,9);
 for(const mutate of [o=>{o.sides.dire.players[0].identity.heroId='1';},o=>{o.sides.dire.players[0].identity.accountId='100';},o=>{o.sides.dire.players[0].identity.side='radiant';}]){const o=observation();mutate(o);const r=classify(o);assert.equal(r.reason,'complete_coherent_draft_required');assert.equal(r.dynamicDiagnosticAllowed,false);assert.equal(r.staticDraftDiagnosticAllowed,false);}
});
test('receipt one nanosecond after decision is rejected',()=>{
 const r=classify(observation(),{decisionAt:'2026-10-20T12:00:00Z'});assert.equal(r.reason,'observation_receipt_after_or_invalid_decision');assert.equal(r.staticDraftDiagnosticAllowed,false);
});
test('other endpoint/source profile cannot reuse GLG schema',()=>{
 const o=observation();o.dynamic.sourceProfile='steam.GetRealtimeStats.v1.terse';assert.equal(classify(o).reason,'normalized_source_profile_or_identity_invalid');
});
test('classification preserves the input and explicitly disclaims byte authentication',()=>{
 const o=observation(null,500),before=structuredClone(o),r=classify(o);assert.deepEqual(o,before);assert.equal(r.provenance.sourceBytesAuthenticatedHere,false);assert.equal(r.phase.clockDoesNotProvePhase,true);
});
