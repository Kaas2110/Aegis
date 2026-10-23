import test from 'node:test';import assert from 'node:assert/strict';
import {selectWinnerHistory,WINNER_HISTORY_POLICY_HASH} from './liveWinnerHistoryPolicy';
import type {ObservationEnvelope} from './LiveWinnerShadowContract';
function row(id:number,clock:number,r=5,d=3):ObservationEnvelope {
 const stamp=new Date(Date.UTC(2026,9,13,0,0,id)).toISOString();
 return{observationId:id.toString(16).padStart(64,'0'),source:'opendota',targetScope:'map',clockUnit:'seconds',scoreUnit:'kills',
 receivedAt:stamp,recordedAt:stamp,input:{matchId:123,radiantTeamId:1,direTeamId:2,gameTimeSec:clock,radiantScore:r,direScore:d,radiantLead:0,players:[]}};
}
test('monotone prior feature inputs remain identical and deeply unmodified',()=>{
 const c=row(10,700,10,8),h=[row(1,350),row(2,450,6,4),row(3,550,8,7)];const before=JSON.stringify({c,h});
 const selected=selectWinnerHistory(c,h,123);assert.deepEqual(selected.history,h);assert.equal(JSON.stringify({c,h}),before);
 assert.equal(selected.diagnostics.normalTrainingEligibility,true);assert.deepEqual(selected.diagnostics.qualityReasons,[]);
 assert.match(WINNER_HISTORY_POLICY_HASH,/^[a-f0-9]{64}$/);
});
test('clock-regressed prior is excluded in original receipt order, never reordered',()=>{
 const c=row(10,1204,15,23),h=[row(1,1000,10,10),row(2,1144,13,18),row(3,1084,14,19)];
 const selected=selectWinnerHistory(c,h,123);assert.deepEqual(selected.history,h.slice(0,2));
 assert.equal(selected.diagnostics.excluded[0].reason,'prior_clock_or_score_regressed');
});
test('score-regressed prior does not create negative kill slopes',()=>{
 const h=[row(1,400,8,3),row(2,500,7,4),row(3,600,9,5)],c=row(10,700,10,6);
 assert.deepEqual(selectWinnerHistory(c,h,123).history,[h[0],h[2]]);
});
test('current clock regression resets entire trajectory, explicitly outside normal training eligibility',()=>{
 const c=row(10,500,10,8),selected=selectWinnerHistory(c,[row(1,400),row(2,600,9,7)],123);
 assert.deepEqual(selected.history,[]);assert.equal(selected.diagnostics.normalTrainingEligibility,false);
 assert.ok(selected.diagnostics.qualityReasons.includes('current_clock_regression'));
 assert.equal(selected.diagnostics.excluded.length,2);assert.equal(c.input.gameTimeSec,500);
});
test('current score regression resets history without rewriting current counts',()=>{
 const c=row(10,700,8,8),selected=selectWinnerHistory(c,[row(1,400),row(2,600,9,7)],123);
 assert.deepEqual(selected.history,[]);assert.ok(selected.diagnostics.qualityReasons.includes('current_score_regression'));
 assert.equal(c.input.radiantScore,8);
});
test('future receipt/recorded rows never affect selected historical features',()=>{
 const c=row(10,700,10,8),h=[row(1,400),row(2,500,6,4)];const expected=selectWinnerHistory(c,h,123).history;
 const future=row(11,650,9,7),lateRecorded=row(3,600,9,7);lateRecorded.recordedAt=future.recordedAt;
 assert.deepEqual(selectWinnerHistory(c,[...h,future,lateRecorded],123).history,expected);
 future.input.gameTimeSec=99999;future.input.radiantScore=99999;
 assert.deepEqual(selectWinnerHistory(c,[...h,future],123).history,expected);
});
test('invalid, synthetic, duplicate and other-side histories are excluded without mutation',()=>{
 const c=row(10,700,10,8),first=row(1,400),invalid=row(2,450),synthetic=row(3,500),side=row(4,600);
 invalid.input.radiantScore=null;synthetic.input.synthetic=true;side.input.direTeamId=3;
 const result=selectWinnerHistory(c,[first,first,invalid,synthetic,side],123);
 assert.deepEqual(result.history,[first]);assert.equal(result.diagnostics.excluded.length,4);
});
test('history limit rejects, missing current stays invalid instead of guessed zeros',()=>{
 assert.throws(()=>selectWinnerHistory(row(10,700),Array(257).fill(row(1,400)),123),/history_limit/);
 const c=row(10,700);c.input.radiantLead=null;const s=selectWinnerHistory(c,[row(1,400)],123);
 assert.deepEqual(s.history,[]);assert.equal(s.diagnostics.normalTrainingEligibility,false);assert.equal(c.input.radiantLead,null);
});
test('future duplicate cannot poison seen set and remove a valid past observation',()=>{
 const c=row(10,700,10,8),past=row(1,400),future=structuredClone(past);
 future.receivedAt=row(11,600).receivedAt;future.recordedAt=future.receivedAt;
 const baseline=selectWinnerHistory(c,[past],123).history;
 assert.deepEqual(selectWinnerHistory(c,[future,past],123).history,baseline);
 future.input.radiantScore=99999;
 assert.deepEqual(selectWinnerHistory(c,[future,past],123).history,baseline);
});
