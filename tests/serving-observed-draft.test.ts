import test from 'node:test';
import assert from 'node:assert/strict';
import {computeServingPredictions,resolveServingTeams} from '../artifacts/api-server/src/services/ServingPredictions';
import {annotateLiveState} from '../artifacts/api-server/src/lib/liveStateFreshness';
import {setTeamIdentityRows,setupServingFixture,liveSnapshotsTable,livePredictionJournalTable,predictionsTable} from './fixtures/serving-observed-draft';

function setup(clock:number,options:{delay?:number;wrongTeam?:boolean;wrongClock?:boolean;staleProgress?:boolean;delayedDraft?:boolean;wrongRoster?:boolean;omitLivePrediction?:boolean}={}) {
 const now=Date.now(),at=new Date(now-1000),old=new Date(now-241000).toISOString();
 const players=Array.from({length:10},(_,i)=>({hero_id:i+1,account_id:i+100,team:i<5?0:1}));
 const raw={match_id:100,team_id_radiant:1,team_id_dire:2,game_time:clock,players,
   last_update_time:Math.floor(now/1000),delay:options.delay??120,
   ...(clock>=60?{radiant_score:3,dire_score:2,radiant_lead:0,building_state:0}:{})};
 const storedRaw=structuredClone(raw);
 if(options.wrongRoster)storedRaw.players[0].account_id=999;
 // The earlier packet must carry a marker from its own receipt time, not the future.
 const prior=options.staleProgress||options.delayedDraft?annotateLiveState([
   {...raw,last_update_time:Date.parse(old)/1000,players:options.delayedDraft?[]:raw.players}],null,old):null;
 const data=annotateLiveState([raw],prior,at.toISOString());
 setupServingFixture({data,receivedAt:at.toISOString(),error:null},[
  [liveSnapshotsTable,[{r:options.wrongTeam?3:1,d:2,source:'live',at,gameTime:options.wrongClock?clock-1:clock,
    scoreR:raw.radiant_score??null,scoreD:raw.dire_score??null,lead:raw.radiant_lead??null,buildings:raw.building_state??null,raw:storedRaw}]],
  [predictionsTable,clock>=60&&!options.omitLivePrediction?[{marketType:'live_match_winner',modelVersion:'state-tree',
    predictedAt:new Date(now),modelProbTeam1:.7,features:{__source_received_unix:at.getTime()/1000}}]:[]],
  [livePredictionJournalTable,[{observation:{matchId:100,receivedAt:at,gameTimeSec:clock,phase:clock<0?'post_draft':'live',
    input:{radiantTeamId:1,direTeamId:2,players:players.map(p=>({heroId:p.hero_id,accountId:p.account_id,team:p.team}))},
    availability:{draftComplete:true,outcomeKnownAtCapture:false}},prediction:{producer:'prematch_context',status:'predicted',
      modelVersion:'draft-tree',predictedAt:new Date(now),evidence:{modelHash:'a'.repeat(64)},output:{radiantWinProbability:.65}}}]],
 ]);
}
const input={matchId:'od_100',matchSource:'opendota' as const,status:'prematch' as const,format:'unknown' as const,
 team1:{name:'A',teamId:1},team2:{name:'B',teamId:2}};
test('actual serving route exposes observed boosted draft at -30 and 0 seconds without fake scores',async()=>{
 for(const clock of [-30,0,59]) {
  setup(clock);const result=await computeServingPredictions(input);
  assert.equal(result.predictions.find(p=>p.betType==='map_winner')?.probTeam1,.65);
  assert.equal(result.predictions[0].provenance?.basis,clock<0?'observed_post_draft':'observed_early_live_draft_context');
  assert.equal(result.observedState,undefined);
  assert.equal(result.liveDataQuality?.eventLatencyVerified,false);
  assert.equal(result.predictions.some(p=>p.betType==='match_winner'),false);
 }
});
test('route refuses stale progress, excessive declared delay, mismatched clock/team and post60 draft fallback',async()=>{
 for(const options of [{delay:900},{wrongTeam:true},{wrongClock:true},{staleProgress:true}]){
  setup(-30,options);assert.equal((await computeServingPredictions(input)).predictions.length,0);
 }
 setup(60,{omitLivePrediction:true});assert.equal((await computeServingPredictions(input)).predictions.length,0);
});

test('actual serving route answers immediately when a verified full draft follows a long incomplete draft',async()=>{
 setup(-90,{delayedDraft:true});
 const result=await computeServingPredictions(input);
 assert.equal(result.predictions.find(p=>p.betType==='map_winner')?.probTeam1,.65);
 assert.equal(result.liveDataQuality?.recencyBasis,'observed_complete_draft_with_provider_marker');
 assert.equal(result.liveDataQuality?.eventLatencyVerified,false);
});
test('changed player identity cannot reuse the preceding state prediction during feed/snapshot race',async()=>{
 setup(600);assert.equal((await computeServingPredictions(input)).predictions[0]?.probTeam1,.7);
 setup(600,{wrongRoster:true});assert.equal((await computeServingPredictions(input)).predictions.length,0);
});


test('actual resolver uses history and exposes collision evidence even on early unavailable serving',async()=>{
 setTeamIdentityRows([
  {source:'catalogue',team_id:5017210,name:'Team Resilience',tag:'Resilience',rating:1207.63,last_seen_at:null,matches:0},
  {source:'history',team_id:10207984,name:'Team resilience',tag:null,rating:null,last_seen_at:1785921088,matches:15},
  {source:'history',team_id:10300669,name:'Imperial Power',tag:null,rating:null,last_seen_at:1791792060,matches:3},
 ]);
 setupServingFixture({data:[],receivedAt:new Date().toISOString(),error:null},[]);
 const resolved=await resolveServingTeams({matchId:'up_123',matchSource:'pandascore',status:'live',format:'BO3',
  team1:{name:'Team Resilience',teamId:138494,provider:'pandascore'},team2:{name:'Imperial Power',teamId:5017210,provider:'pandascore'}});
 const result=await computeServingPredictions(resolved);
 assert.equal(result.predictions.length,0);
 assert.deepEqual(result.resolvedTeams,{team1Id:null,team2Id:10300669});
 assert.equal(result.teamIdentity?.team1?.reason,'name_ambiguous');
 assert.equal(result.teamIdentity?.team2?.method,'history_exact_name');
 assert.equal(result.teamIdentity?.team2?.ratingAvailable,false);
});
