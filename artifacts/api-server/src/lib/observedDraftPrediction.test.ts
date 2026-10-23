import test from 'node:test';
import assert from 'node:assert/strict';
import {selectObservedDraftPrediction} from './observedDraftPrediction';
const now=Date.parse('2026-10-04T12:00:00Z');
function fixture(clock=-30){
  const players=Array.from({length:10},(_,i)=>({hero_id:i+1,account_id:i+100,team:i<5?0:1}));
  const packet={match_id:100,team_id_radiant:1,team_id_dire:2,game_time:clock,players};
  const rows=[{observation:{matchId:100,receivedAt:new Date(now-1000),gameTimeSec:clock,phase:clock<0?'post_draft':'live',
    input:{radiantTeamId:1,direTeamId:2,players:players.map(p=>({heroId:p.hero_id,accountId:p.account_id,team:p.team}))},
    availability:{draftComplete:true,outcomeKnownAtCapture:false}},prediction:{producer:'prematch_context',status:'predicted',
      modelVersion:'tree-draft',predictedAt:new Date(now),evidence:{modelHash:'a'.repeat(64)},output:{radiantWinProbability:.65}}}];
  return {packet,rows,active:[{version:'tree-draft',hash:'a'.repeat(64),featuresVersion:2}]};
}
test('full observed draft has a forecast before the horn without synthetic live statistics',()=>{
  const f=fixture();const p=selectObservedDraftPrediction(f.packet,f.rows,f.active,'same',now);
  assert.equal(p?.probability,.65);assert.equal(p?.basis,'observed_post_draft');
});
test('early live context has explicit basis; 60s requires a state model',()=>{
  const f=fixture(59);assert.equal(selectObservedDraftPrediction(f.packet,f.rows,f.active,'same',now)?.basis,'observed_early_live_draft_context');
  const late=fixture(60);assert.equal(selectObservedDraftPrediction(late.packet,late.rows,late.active,'same',now),null);
});
test('wrong map, changed heroes, stale input, inactive artifact and known outcome cannot be reused',()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{f.packet.match_id=101;},
    (f:ReturnType<typeof fixture>)=>{f.packet.team_id_radiant=0;},
    (f:ReturnType<typeof fixture>)=>{f.packet.team_id_dire=1;},
    (f:ReturnType<typeof fixture>)=>{f.packet.players[0].hero_id=15;},
    (f:ReturnType<typeof fixture>)=>{f.rows[0].observation.receivedAt=new Date(now-200_000);},
    (f:ReturnType<typeof fixture>)=>{f.active[0].hash='b'.repeat(64);},
    (f:ReturnType<typeof fixture>)=>{f.active[0].featuresVersion=1;},
    (f:ReturnType<typeof fixture>)=>{f.rows[0].observation.availability.outcomeKnownAtCapture=true;},
  ]){const f=fixture();mutate(f);assert.equal(selectObservedDraftPrediction(f.packet,f.rows,f.active,'same',now),null);}
});
test('orientation is applied once and unavailable telemetry is not turned into zero',()=>{
  const f=fixture();assert.equal(selectObservedDraftPrediction(f.packet,f.rows,f.active,'flipped',now)?.probability,.35);
  assert.equal('radiant_score' in f.packet,false);
});
