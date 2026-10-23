import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {advanceObservedDraft,draftHash,createDraftCaptureProof} from './observedDraft.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
const receipt='2026-10-23T12:00:00.000000001Z';
const proofs=new WeakMap();
function fixture({time=receipt,clock=0,accounts=false,phase=null,changeHero=false,outcome=false}={}){
 const side=(name,start,team)=>({team_id:team});
 const players=(start)=>Array.from({length:5},(_,i)=>({hero_id:i+start,account_id:accounts?i+start:4294967295}));
 const scoreboard={radiant:{players:players(1)},dire:{players:players(6)}};
 if(clock!==null)scoreboard.duration=clock;
 const game={match_id:90001,radiant_team:side('radiant',1,100),dire_team:side('dire',6,200),scoreboard};
 if(phase!==null)game.game_state=phase;
 if(outcome)game.radiant_win=true;
 if(changeHero)game.scoreboard.dire.players[4].hero_id=11;
 const body=Buffer.from(JSON.stringify({result:{games:[game]}})),hash=createHash('sha256').update(body).digest('hex');
 const input={body,rawSha256:hash,payloadRef:'journal:'+hash,endpoint:'GetLiveLeagueGames/v1',requestStartedAt:time,receivedAt:time,persistedAt:time,httpStatus:200,authenticatedAttempt:true};
 const o=normalizeLocalCapture(input).observations[0];proofs.set(o,createDraftCaptureProof(input));return o;
}
const run=(old,o,extra={})=>advanceObservedDraft(old,o,{decisionAt:o.source.capture.receivedAt,prefixBasis:'recorded_from_collector_start',captureProof:proofs.get(o),...extra});
test('ten heroes trigger despite all anonymous accounts and absent phase/start metadata',()=>{
 const o=fixture(),raw=JSON.stringify(o),r=run(null,o);
 assert.equal(r.status,'observed_draft_diagnostic');assert.equal(r.state.historyCutoffAt,receipt);
 assert.equal(r.state.identity.players.filter(p=>p.accountId===null).length,10);
 assert.equal(r.state.postdraftZeroMinuteCohortEligible,true);assert.equal(JSON.stringify(o),raw);
 assert.equal(o.dynamic.phase.missing,true);assert.equal(r.eligibleForServing,false);
});
test('late first positive clock is never backdated into zero-minute cohort',()=>{
 const r=run(null,fixture({clock:1200}));
 assert.equal(r.state.firstObservationCohort,'late_first_observation');assert.equal(r.state.postdraftZeroMinuteCohortEligible,false);
});
test('clock absent stays unknown, not observed zero on a later frame',()=>{
 const first=run(null,fixture({clock:null}));
 const next=run(first.state,fixture({time:'2026-10-23T12:00:01Z',clock:30}));
 assert.equal(next.state.firstClock,null);assert.equal(next.state.postdraftZeroMinuteCohortEligible,false);
});
test('late account disclosure creates identity version while preserving original cutoff',()=>{
 const first=run(null,fixture());const next=run(first.state,fixture({time:'2026-10-23T12:00:03Z',clock:3,accounts:true}));
 assert.equal(next.state.revision,1);assert.equal(next.state.historyCutoffAt,receipt);
 assert.equal(next.state.validFrom,'2026-10-23T12:00:03Z');assert.equal(first.state.identity.players[0].accountId,null);
 assert.equal(next.state.changeReason,'account_identity_disclosed');
});
test('draft changes without correction evidence are blocked',()=>{
 const first=run(null,fixture());assert.equal(run(first.state,fixture({time:'2026-10-23T12:01:00Z',changeHero:true})).reason,'draft_identity_correction_evidence_required');
});
test('array order does not change draft/roster identity',()=>{
 const o=fixture({accounts:true}),r=run(null,o);
 for(const side of ['radiant','dire'])o.sides[side].players.reverse();
 assert.equal(run(null,o).state.identity.rosterHash,r.state.identity.rosterHash);
});
test('future one-nanosecond receipt is rejected',()=>{
 const o=fixture();assert.equal(run(null,o,{decisionAt:'2026-10-23T12:00:00Z'}).reason,'draft_receipt_after_decision');
});
test('terminal packet and source mutation cannot create postdraft route',()=>{
 assert.equal(run(null,fixture({phase:6})).reason,'draft_terminal_or_invalid_phase');
 const o=fixture();o.source.rawPacket.scoreboard.duration=999;
 assert.equal(run(null,o).reason,'draft_source_hash_mismatch');
});
test('prefix uncertainty stays explicit and stale receipt cannot rewrite state',()=>{
 const first=run(null,fixture(),{prefixBasis:'unknown_prefix'});
 assert.equal(first.state.postdraftZeroMinuteCohortEligible,false);
 const r=run(first.state,fixture({time:'2026-10-23T11:59:59Z'}));
 assert.equal(r.reason,'draft_receipt_rewind');assert.deepEqual(r.state,first.state);
});
test('duplicate heroes/accounts and wrong side do not pass admission',()=>{
 for(const mutate of [o=>o.sides.dire.players[4].identity.heroId='1',o=>o.sides.dire.players[4].identity.accountId='1',o=>o.sides.dire.players[4].identity.side='radiant']){
  const o=fixture({accounts:true});mutate(o);
  assert.equal(run(null,o).reason,'draft_admission_projection_mismatch');
 }
});
test('raw-pinned phase and clock cannot be overridden by derived-field mutation',()=>{
 const terminal=fixture({phase:7});terminal.dynamic.phase={...terminal.dynamic.phase,value:5};
 assert.equal(run(null,terminal).reason,'draft_admission_projection_mismatch');
 const late=fixture({clock:1200});late.providerGameClockSeconds.value=0;
 assert.equal(run(null,late).reason,'draft_admission_projection_mismatch');
 const o=fixture();assert.equal(run(null,o,{captureProof:{...proofs.get(o)}}).reason,'verified_raw_capture_required');
});
test('raw outcome marker cannot be erased from normalized admission notes',()=>{
 const o=fixture({outcome:true});o.sourceQualityReasons=o.sourceQualityReasons.filter(x=>x!=='outcome_marker_present');
 assert.equal(run(null,o).reason,'draft_admission_projection_mismatch');
});
test('state corruption is detected before reuse',()=>{
 const first=run(null,fixture());first.state.historyCutoffAt='2026-10-24T00:00:00Z';
 assert.throws(()=>run(first.state,fixture()),/draft_state_hash/);
});
