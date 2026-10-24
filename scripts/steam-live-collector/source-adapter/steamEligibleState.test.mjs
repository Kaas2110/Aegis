import test from 'node:test';
import assert from 'node:assert/strict';
import {draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {advanceSteamProgressionAdmission} from './steamProgressionAdmission.mjs';
import {advanceSteamEligibleState as advance,readSteamEligibleState as read,STEAM_PAUSE_CAPABILITY} from './steamEligibleState.mjs';
import {readSteamReceiptFreshness,STEAM_RECEIPT_FRESHNESS_SECONDS} from './steamPhasePolicy.mjs';
const T='2026-10-23T12:30:00Z',U='2026-10-23T12:32:00Z',MAP='90001';
function entry({time=T,clock=600,phase=5,mutate=null,status=200,body=null,accounts=true,teams=true}={}){
 const e=draftEntry({time,clock,phase,accounts,teams,matchId:MAP}),raw=JSON.parse(e.rawInput.utf8);if(mutate)mutate(raw);
 const rawInput=body===null?pinned(raw):{utf8:body,pin:{...pinned(raw).pin,bytes:Buffer.byteLength(body),sha256:null}};
 if(body!==null){const {createHash}=testCrypto;rawInput.pin.sha256=createHash('sha256').update(body).digest('hex');}
 return{rawInput,receiptInput:pinned({version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:'GetLiveLeagueGames/v1',httpStatus:status,status:status===200?'captured_diagnostic':'http_error',diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId:'synthetic-'+time,requestStartedAt:time,receivedAt:time,rawPersistedAt:time,completedAt:time,rawSha256:rawInput.pin.sha256,rawFile:'raw/'+rawInput.pin.sha256+'.body',payloadRef:'journal:'+rawInput.pin.sha256,bodyBytes:rawInput.pin.bytes})};
}
import * as testCrypto from 'node:crypto';
const step=(e,previous=null,decisionAt=JSON.parse(e.receiptInput.utf8).completedAt,extra={})=>advance(previous,{retainedEntry:e,matchId:MAP,decisionAt,...extra});
const check=(r,decisionAt)=>read(r.nextPrivateToken,{matchId:MAP,decisionAt});
test('first coherent explicit live state qualifies, while source latency remains unproved',()=>{
 const a=step(entry());assert.equal(a.confirmationRenewed,true);assert.equal(a.mayGenerateNewVector,true);assert.equal(a.stateView.lastConfirmedAt,T);assert.equal(a.stateView.lastClockAdvanceAt,null);assert.equal(a.eligibleForServing,false);assert.equal(a.recordedPrediction,false);assert.equal(a.stateView.pauseEvidenceStatus,'unavailable_source_evidence');
});
for(const [at,eligible]of [['2026-10-23T12:35:00Z',true],['2026-10-23T12:35:00.000000001Z',false]])test('read-time silent-source300s boundary '+at,()=>{
 const a=step(entry());const r=check(a,at);assert.equal(r.eligibleForRetainingForecast,eligible);assert.equal(r.mayGenerateNewVector,false);assert.equal(r.stateView.lastConfirmedAt,T);assert.equal(r.userMessage,eligible?null:'Прогноз недоступен');
});
test('fresh HTTP receipts and phase5 do not renew stationary state or duplicate prediction',()=>{
 const first=entry(),second=entry({time:U});assert.equal(first.rawInput.pin.sha256,second.rawInput.pin.sha256);assert.notEqual(first.receiptInput.pin.sha256,second.receiptInput.pin.sha256);
 const a=step(first),b=step(second,a.nextPrivateToken);assert.equal(b.stateView.classification,'unknown_repeated');assert.equal(b.stateView.lastHttpReceiptAt,U);assert.equal(b.stateView.lastConfirmedAt,T);assert.equal(b.stateView.observationId,a.stateView.observationId);assert.equal(b.confirmationRenewed,false);assert.equal(b.mayGenerateNewVector,false);
 const c=step(entry({time:'2026-10-23T12:34:00Z'}),b.nextPrivateToken),d=step(entry({time:'2026-10-23T12:36:00Z'}),c.nextPrivateToken);assert.equal(c.eligibleForRetainingForecast,true);assert.equal(d.eligibleForRetainingForecast,false);assert.equal(d.stateView.lastConfirmedAt,T);
});
test('exact committed capture duplicate is idempotent; different same-time receipt remains a barrier',()=>{
 const e=entry(),a=step(e),b=step(e,a.nextPrivateToken,U);assert.equal(b.eligibleForRetainingForecast,true);assert.equal(b.confirmationRenewed,false);assert.equal(b.mayGenerateNewVector,false);assert.equal(b.stateView.lastConfirmedAt,T);assert.equal(check(b,'2026-10-23T12:35:00.000000001Z').eligibleForRetainingForecast,false);
 const changed={...e,receiptInput:pinned({...JSON.parse(e.receiptInput.utf8),requestId:'different-receipt-same-time'})};assert.equal(step(changed,a.nextPrivateToken).eligibleForRetainingForecast,false);
});
test('monotone account/team disclosure resets windows but only advancing admitted state renews',()=>{
 const a=step(entry({accounts:false,teams:false})),b=step(entry({time:U,accounts:true,teams:true}),a.nextPrivateToken);assert.equal(b.eligibleForRetainingForecast,true);assert.equal(b.confirmationRenewed,false);assert.equal(b.resetDynamicWindows,true);assert.equal(b.stateView.identityHash,a.stateView.identityHash);assert.equal(b.stateView.lastConfirmedAt,T);
 const c=step(entry({time:'2026-10-23T12:34:00Z',clock:720,accounts:true,teams:true}),b.nextPrivateToken);assert.equal(c.confirmationRenewed,true);assert.notEqual(c.stateView.identityHash,a.stateView.identityHash);assert.equal(c.stateView.maximumClockSeconds,720);
 const replaced=step(entry({time:'2026-10-23T12:36:00Z',clock:840,mutate:r=>{r.result.games[0].scoreboard.radiant.players[0].account_id=9999;}}),c.nextPrivateToken);assert.equal(replaced.eligibleForRetainingForecast,false);assert.equal(replaced.stateView.maximumClockSeconds,720);
 const retracted=step(entry({time:'2026-10-23T12:36:00Z',clock:840,accounts:false}),c.nextPrivateToken);assert.equal(retracted.eligibleForRetainingForecast,false);
});
test('different native economy at stationary clocks is still unconfirmed freshness',()=>{
 const a=step(entry()),b=step(entry({time:U,mutate:r=>{r.result.games[0].scoreboard.radiant.players[0].gold_per_min=999;}}),a.nextPrivateToken);assert.equal(b.confirmationRenewed,false);assert.equal(b.stateView.lastConfirmedAt,T);assert.equal(b.stateView.reason,'stationary_state_pause_unconfirmed');
});
test('caller pause booleans, public summaries, clones and forged restore cannot mint authority',()=>{
 const a=step(entry());assert.equal(STEAM_PAUSE_CAPABILITY.canMintConfirmedPause,false);
 for(const token of [a.stateView,structuredClone(a.nextPrivateToken),{contract:a.nextPrivateToken.contract}])assert.equal(read(token,{matchId:MAP,decisionAt:U}).eligibleForRetainingForecast,false);
 const fake=advance(a.nextPrivateToken,{matchId:MAP,decisionAt:U,confirmedPaused:true});assert.equal(fake.eligibleForRetainingForecast,false);assert.equal(fake.reason,'unsupported_source_confirmation_input');
});
test('no proven pause field: added raw paused/is_paused fields cannot renew qualification',()=>{
 const a=step(entry()),b=step(entry({time:U,mutate:r=>{r.result.games[0].paused=true;r.result.games[0].is_paused=true;r.result.games[0].timestamp=1792758720;}}),a.nextPrivateToken);assert.equal(b.confirmationRenewed,false);assert.equal(b.stateView.classification,'unknown_repeated');assert.equal(b.stateView.lastConfirmedAt,T);
});
test('resumed real clock renews and retains exact new reference',()=>{
 const a=step(entry()),b=step(entry({time:U}),a.nextPrivateToken),c=step(entry({time:'2026-10-23T12:34:00Z',clock:720}),b.nextPrivateToken);assert.equal(c.confirmationRenewed,true);assert.equal(c.mayGenerateNewVector,true);assert.equal(c.stateView.lastConfirmedAt,'2026-10-23T12:34:00Z');assert.equal(c.stateView.lastClockAdvanceAt,c.stateView.lastConfirmedAt);assert.equal(c.resetDynamicWindows,true);
});
test('clock plausibility uses the time attached to the qualified clock, not an intervening HTTP repeat',()=>{
 const a=step(entry()),repeat=step(entry({time:'2026-10-23T12:31:59Z',clock:600}),a.nextPrivateToken),resumed=step(entry({time:U,clock:720}),repeat.nextPrivateToken);assert.equal(resumed.confirmationRenewed,true);assert.equal(resumed.eligibleForRetainingForecast,true);assert.equal(resumed.stateView.lastConfirmedAt,U);assert.equal(resumed.stateView.maximumClockSeconds,720);
});
test('absent phase needs owned progression proof for initial and advancing admission',()=>{
 const a=entry({phase:null}),b=entry({phase:null,time:U,clock:720});assert.equal(step(a).eligibleForRetainingForecast,false);
 const admitted=advanceSteamProgressionAdmission(null,{matchId:MAP,decisionAt:U,retainedPrefixInputs:[a,b]});assert.equal(admitted.status,'admitted_diagnostic');
 const r=step(b,null,U,{progressionProof:admitted.privateProof});assert.equal(r.confirmationRenewed,true);assert.equal(r.stateView.lastConfirmedAt,U);
 const repeated=step(entry({phase:null,time:'2026-10-23T12:34:00Z',clock:720}),r.nextPrivateToken);assert.equal(repeated.confirmationRenewed,false);assert.equal(repeated.eligibleForRetainingForecast,true);assert.equal(repeated.stateView.lastConfirmedAt,U);assert.equal(check(repeated,'2026-10-23T12:37:00.000000001Z').eligibleForRetainingForecast,false);
});
test('confirmed terminal and raw completion marker close immediately despite fresh receipt',()=>{
 for(const terminal of [entry({time:U,clock:720,phase:6}),entry({time:U,clock:720,mutate:r=>{r.result.games[0].finished=false;}})]){
  const a=step(entry()),b=step(terminal,a.nextPrivateToken);assert.equal(b.eligibleForRetainingForecast,false);assert.equal(b.stateView.terminal,true);assert.equal(step(entry({time:'2026-10-23T12:34:00Z',clock:840}),b.nextPrivateToken).eligibleForRetainingForecast,false);
 }
});
test('identity change and clock rewind invalidate immediately without weakening watermarks',()=>{
 for(const bad of [entry({time:U,clock:599}),entry({time:U,clock:720,mutate:r=>{r.result.games[0].radiant_team.team_id=101;}})]){
  const a=step(entry()),b=step(bad,a.nextPrivateToken);assert.equal(b.eligibleForRetainingForecast,false);assert.equal(b.resetDynamicWindows,true);assert.equal(b.stateView.maximumClockSeconds,600);
 }
 const a=step(entry());assert.equal(read(a.nextPrivateToken,{matchId:'90002',decisionAt:U}).eligibleForRetainingForecast,false);assert.equal(advance(a.nextPrivateToken,{matchId:'90002',decisionAt:U}).nextPrivateToken,null);
});
test('manual STOP invalidates, source_gap alone keeps original fixed deadline',()=>{
 const a=step(entry()),stop=advance(a.nextPrivateToken,{matchId:MAP,decisionAt:U,stopped:true});assert.equal(stop.eligibleForRetainingForecast,false);assert.equal(stop.stateView.maximumClockSeconds,600);
 const gap=advance(a.nextPrivateToken,{matchId:MAP,decisionAt:U,barrier:'source_gap'});assert.equal(gap.eligibleForRetainingForecast,true);assert.equal(gap.stateView.lastConfirmedAt,T);assert.equal(gap.resetDynamicWindows,true);assert.equal(check(gap,'2026-10-23T12:35:00.000000001Z').eligibleForRetainingForecast,false);
});
test('error/missing-map response does not renew and committed receipt chronology is retained',()=>{
 const a=step(entry());for(const e of [entry({time:U,status:500,body:'<html>down</html>'}),entry({time:U,mutate:r=>{r.result.games=[];}})]){
  const b=step(e,a.nextPrivateToken);assert.equal(b.eligibleForRetainingForecast,true);assert.equal(b.stateView.lastHttpReceiptAt,U);assert.equal(b.stateView.lastConfirmedAt,T);assert.equal(b.confirmationRenewed,false);assert.equal(step(entry({time:'2026-10-23T12:31:00Z',clock:660}),b.nextPrivateToken).eligibleForRetainingForecast,false);
 }
});
test('tampered source, future capture and implausible advance do not renew',()=>{
 const a=step(entry()),bad=entry({time:U,clock:720});bad.rawInput.utf8+=' ';assert.equal(step(bad,a.nextPrivateToken).eligibleForRetainingForecast,false);
 assert.equal(step(entry({time:U,clock:720}),a.nextPrivateToken,T).eligibleForRetainingForecast,false);
 assert.equal(step(entry({time:U,clock:751}),a.nextPrivateToken).eligibleForRetainingForecast,false);
});
test('restart replays original evidence: no reconstructed receipt or age reset',()=>{
 const first=entry(),next=entry({time:U,clock:720}),a=step(first),b=step(next,a.nextPrivateToken),restartedA=step(first),restartedB=step(next,restartedA.nextPrivateToken);assert.deepEqual(b.stateView,restartedB.stateView);
 assert.equal(check(restartedB,'2026-10-23T12:37:00Z').eligibleForRetainingForecast,true);assert.equal(check(restartedB,'2026-10-23T12:37:00.000000001Z').eligibleForRetainingForecast,false);
 const oldAtToday=step(first,null,'2026-10-24T12:30:00Z');assert.equal(oldAtToday.eligibleForRetainingForecast,false);assert.equal(oldAtToday.confirmationRenewed,false);assert.equal(read(a.nextPrivateToken,{matchId:MAP,decisionAt:'2026-10-24T12:30:00Z'}).eligibleForRetainingForecast,false);
});
test('receipt gate300s is necessary but separate from180s absent-phase proof lease',()=>{
 assert.equal(STEAM_RECEIPT_FRESHNESS_SECONDS,300);const a=step(entry()),o={source:{capture:{receivedAt:T}}};assert.equal(readSteamReceiptFreshness(o,{decisionAt:'2026-10-23T12:35:00Z'}).accepted,true);assert.equal(readSteamReceiptFreshness(o,{decisionAt:'2026-10-23T12:35:00.000000001Z'}).accepted,false);assert.equal(check(a,'2026-10-23T12:34:00Z').eligibleForRetainingForecast,true);
});
