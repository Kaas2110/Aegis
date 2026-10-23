import test from 'node:test';import assert from 'node:assert/strict';
import {computeServingPredictions} from '../artifacts/api-server/src/services/ServingPredictions';
import {totalsLadder} from '../artifacts/api-server/src/services/TotalsDistribution';
import {fixture} from './fixtures/totals-serving';
import type {MatchInput} from '../artifacts/api-server/src/services/AnalyticsEngine';
const input:MatchInput={matchId:'od_8123456789',matchSource:'opendota',status:'live',format:'unknown',team1:{name:'A',teamId:1},team2:{name:'B',teamId:2},liveSnapshot:{gameTimeSeconds:99999} as any};
const at=new Date();
function reset(){
 fixture.feed={data:[{match_id:8123456789}],receivedAt:at.toISOString(),error:null};
 fixture.rows={snapshot:[{r:1,d:2,source:'live',at,gameTime:540,scoreR:10,scoreD:11,lead:1500,buildings:123}],predictions:['kills','duration'].map(target=>({marketType:'live_total_'+target,modelVersion:'live_total_'+target+'-validated',predictedAt:at,features:{__source_received_unix:at.getTime()/1000},modelProbTeam1:Math.log(target==='kills'?51:2400),modelProbTeam2:.2}))};
}
test('actual serving binds totals to latest stored receipt and ignores client clock; reads never call provider',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Unexpected provider call');};
 try{
  reset();const result=await computeServingPredictions(input);assert.equal(result.observedState?.elapsedSeconds,540);
  const dur=result.predictions.find(p=>p.betType==='total_duration')!;assert.equal(dur.distribution?.observedMinimum,540);assert.equal(totalsLadder(dur.distribution!)?.expectedValue,40);
  fixture.rows.snapshot[0]={...fixture.rows.snapshot[0],at:new Date(at.getTime()+1),gameTime:2500};
  assert.equal((await computeServingPredictions(input)).predictions.length,0,'old prediction cannot follow a new snapshot');
  const newAt=fixture.rows.snapshot[0].at;fixture.rows.predictions.forEach((r:any)=>{r.features.__source_received_unix=newAt.getTime()/1000;r.predictedAt=newAt;});
  const next=await computeServingPredictions(input);assert.ok(totalsLadder(next.predictions.find(p=>p.betType==='total_duration')!.distribution!)!.expectedValue>2500/60);
  for(let i=0;i<4;i++)await computeServingPredictions(input);assert.equal(calls,0);
 }finally{globalThis.fetch=original;}
});
test('server missing/stale/error current membership, finished status and invalid telemetry yield no live predictions',async()=>{
 reset();fixture.feed.data=[];assert.equal((await computeServingPredictions(input)).predictions.length,0);
 reset();fixture.feed.error='upstream_temporarily_unavailable';assert.equal((await computeServingPredictions(input)).predictions.length,0);
 reset();fixture.feed.receivedAt='2001-01-01';assert.equal((await computeServingPredictions(input)).predictions.length,0);
 reset();assert.equal((await computeServingPredictions({...input,status:'finished'})).predictions.length,0);
 reset();fixture.rows.snapshot[0].scoreR=null;assert.equal((await computeServingPredictions(input)).predictions.length,0);
 reset();fixture.rows.predictions[0].modelVersion='legacy';assert.equal((await computeServingPredictions(input)).predictions.some(p=>p.betType==='total_kills'),false);
});
