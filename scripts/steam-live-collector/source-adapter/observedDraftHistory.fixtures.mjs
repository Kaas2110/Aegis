import {pinned,fixture,args,roster} from './frozenPlayerContext.fixtures.mjs';
import {qualify} from './heroLateContext.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {DRAFT_METADATA_CONTRACT} from './observedDraftHistory.mjs';
export {pinned,fixture,args,roster};
export function draftEntry({matchId='90001',time='2026-10-23T11:58:00Z',accounts=false,clock=null,phase=null,reverse=false,teams=true,outcome=false,missingHero=false}={}){
 const group=(side)=>roster().filter(p=>p.side===side).map((p,i)=>({hero_id:missingHero&&p.heroId===10?0:p.heroId,account_id:accounts?Number(p.accountId):4294967295}));
 const radiant=group('radiant'),dire=group('dire');if(reverse){radiant.reverse();dire.reverse();}
 const game={match_id:Number(matchId),scoreboard:{radiant:{players:radiant},dire:{players:dire}}};
 if(teams){game.radiant_team={team_id:100};game.dire_team={team_id:200};}
 if(clock!==null)game.scoreboard.duration=clock;if(phase!==null)game.game_state=phase;if(outcome)game.radiant_win=true;
 const rawInput=pinned({result:{games:[game]}},'synthetic-draft-raw.json');
 const capture={endpoint:'GetLiveLeagueGames/v1',httpStatus:200,requestStartedAt:time,receivedAt:time,persistedAt:time,authenticatedAttempt:true};
 const o=normalizeLocalCapture({...capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0];
 const metadataInput=pinned({contract:DRAFT_METADATA_CONTRACT,matchId,observationId:o.observationId,decisionAt:time,capture},'synthetic-draft-metadata.json');
 return{rawInput,metadataInput};
}
export function draftArgs(options={}){
 const f=qualify(fixture()),entry=draftEntry(options),at=JSON.parse(entry.metadataInput.utf8).capture.receivedAt;
 f.target.knownAt=at;f.facts.scope.asOf=at;
 return{matchId:'90001',computedAt:'2026-10-23T12:30:00Z',draftPrefixInputs:[entry],factsInput:pinned(f.facts),nativeInput:pinned(f.native)};
}
export function alignedArgs({explicit=false}={}){
 const a=draftArgs(),facts=JSON.parse(a.factsInput.utf8),native=JSON.parse(a.nativeInput.utf8);
 const profileReviewInput=pinned({contract:'aegis.steam-clock-profile-review.v1',reviewed:true,sourceProfile:'steam.GetLiveLeagueGames.v1.scoreboard',clockField:'scoreboard.duration',clockUnits:'seconds',phaseAbsenceMeaning:'omitted_not_nonlive',reviewedAt:'2026-10-22T00:00:00Z'});
 const inputs=[];native.observations=[];
 for(let i=0;i<facts.maps.length;i++){
  const m=facts.maps[i],time=`2026-10-${17+i}T13:15:03Z`,players=roster().map((p,k)=>({hero_id:p.heroId,account_id:Number(p.accountId),net_worth:5000+k*10+i*100,gold_per_min:400+k+i*10,xp_per_min:500+k+i*10}));
  const rawCaptureInput=pinned({result:{games:[{match_id:Number(m.matchId),...(explicit?{game_state:5}:{}),radiant_team:{team_id:100},dire_team:{team_id:200},scoreboard:{duration:900,radiant:{players:players.slice(0,5)},dire:{players:players.slice(5)}}}]}});
  const capture={endpoint:'GetLiveLeagueGames/v1',httpStatus:200,requestStartedAt:time,receivedAt:time,persistedAt:time,authenticatedAttempt:true};
  const o=normalizeLocalCapture({...capture,body:Buffer.from(rawCaptureInput.utf8),rawSha256:rawCaptureInput.pin.sha256,payloadRef:'journal:'+rawCaptureInput.pin.sha256}).observations[0];
  native.observations.push(o);
  const priorMapInput=pinned({...m,heroes:m.players.map(p=>({heroId:p.heroId,side:p.side})),heroesKnownAt:m.playersKnownAt,durationKnownAt:m.outcomeKnownAt});
  const alignmentInput=pinned({contract:'aegis.native-historical-alignment.v1',purpose:'alignment_only',phaseClassification:'in_progress_reconstructed',matchId:m.matchId,observationId:o.observationId,rawSha256:rawCaptureInput.pin.sha256,sourceProfile:'steam.GetLiveLeagueGames.v1.scoreboard',priorFactsSha256:priorMapInput.pin.sha256,profileReviewSha256:profileReviewInput.pin.sha256,knownAt:'2026-10-22T00:00:00Z'});
  inputs.push({observationInput:pinned(o),rawCaptureInput,priorMapInput,...(explicit?{}:{profileReviewInput,alignmentInput})});
 }
 a.nativeInput=pinned(native);a[explicit?'nativeEvidenceInputs':'nativeAlignmentInputs']=inputs;if(!explicit)a.expectedProfileReviewSha256=profileReviewInput.pin.sha256;
 return a;
}
