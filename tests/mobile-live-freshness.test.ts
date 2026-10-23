import test from 'node:test';
import assert from 'node:assert/strict';
import {readLiveDataQuality,observedStateAge,observedLiveStateEligible,liveValueComparisonAllowed,guardLiveTotals} from '../artifacts/mobile/lib/liveFreshness';
import type {LiveDataQuality} from '../artifacts/mobile/lib/liveFreshness';
import {openDotaToMatch,analyticsToMarkets} from '../artifacts/mobile/services/LiveDataService';
const t=Date.parse('2026-10-04T12:00:00Z');
const iso=(n:number)=>new Date(n).toISOString();
const quality=(overrides:Partial<LiveDataQuality>={}):LiveDataQuality=>({eligibleForObservedStatePrediction:true,reason:null,
  receivedAt:iso(t),lastStateChangeReceivedAt:iso(t),stateAgeSeconds:0,declaredBroadcastDelaySeconds:120,
  measuredEndToEndLatencySeconds:null,eventLatencyVerified:false,meetsVerifiedLiveLatencyPolicy:false,...overrides});

test('receipt refresh cannot reset state age; aging also works offline at exact 180s boundary',()=>{
  const q=quality({receivedAt:iso(t+175_000)});
  assert.equal(observedStateAge(q,t+180_000),180);
  assert.equal(observedLiveStateEligible(q,t+179_999),true);
  assert.equal(observedLiveStateEligible(q,t+180_000),false);
});
test('unknown and invalid clocks stay unknown rather than becoming a fresh zero',()=>{
  assert.equal(observedStateAge(undefined,t),null);
  assert.equal(observedLiveStateEligible(undefined,t),false);
  assert.equal(observedLiveStateEligible(quality({lastStateChangeReceivedAt:iso(t+6000)}),t),false);
  assert.equal(observedLiveStateEligible(quality({receivedAt:iso(t-1000)}),t),false);
  assert.equal(observedLiveStateEligible(readLiveDataQuality({eligibleForObservedStatePrediction:true,stateAgeSeconds:0}),t),false);
});
test('declared delay is distinct from measured delay and cannot certify EV',()=>{
  assert.equal(observedLiveStateEligible(quality({declaredBroadcastDelaySeconds:301}),t),false);
  assert.equal(observedLiveStateEligible(quality({declaredBroadcastDelaySeconds:300}),t),true);
  assert.equal(liveValueComparisonAllowed(quality(),true,t),false);
  assert.equal(readLiveDataQuality({...quality(),eventLatencyVerified:true,meetsVerifiedLiveLatencyPolicy:true})!.eventLatencyVerified,false);
  const verified=quality({measuredEndToEndLatencySeconds:60,eventLatencyVerified:true,meetsVerifiedLiveLatencyPolicy:true});
  assert.equal(liveValueComparisonAllowed(verified,undefined,t),false);
  assert.equal(liveValueComparisonAllowed(verified,true,t),true);
});
test('stale totals retain exact bookmaker lines and prices but no model probability',()=>{
  const q=quality({eligibleForObservedStatePrediction:false,reason:'upstream_state_not_progressing'});
  const data={lineSource:'bookmaker',expectedValue:54,interval:{q25:40,q75:60},projection:{current:10},
    lines:[{line:53.5,pOver:.6,pUnder:.4,pPush:0,oddsOver:1.8,oddsUnder:2.1}]};
  const result=guardLiveTotals(data,'live',q,t)!;
  assert.equal(result.lines[0].line,53.5);assert.equal(result.lines[0].oddsOver,1.8);
  assert.equal(result.lines[0].pOver,null);assert.equal(result.lines[0].pPush,null);
  assert.equal(result.interval,null);assert.equal(result.projection,null);assert.equal(result.expectedValue,null);
  assert.equal(data.lines[0].pOver,.6);
  assert.deepEqual(guardLiveTotals({...data,lineSource:'model'},'live',q,t)!.lines,[]);
  assert.equal(guardLiveTotals(data,'prematch',q,t),data);
});
test('real mobile converter uses the state-change clock, preserves missingness, and never rebrands HTTP time',tctx=>{
  tctx.mock.method(Date,'now',()=>t+120_000);
  const match=openDotaToMatch({match_id:'123',team_id_radiant:1,team_id_dire:2,game_time:300,radiant_score:0,dire_score:0,radiant_lead:0,
    live_freshness:quality({receivedAt:iso(t+120_000)})},iso(t+120_000));
  assert.equal(match.liveSnapshot?.snapshotAge,120);
  assert.equal(match.liveSnapshot?.radiantKills,0);
  assert.equal(match.liveDataQuality?.measuredEndToEndLatencySeconds,null);
  const missing=openDotaToMatch({match_id:'123',live_freshness:quality()});
  assert.equal(missing.liveSnapshot,undefined);assert.equal(missing.currentMap,undefined);
  const oldServer=openDotaToMatch({match_id:'123',game_time:300,radiant_score:0,dire_score:0,radiant_lead:0},iso(t+120_000));
  assert.equal(oldServer.liveSnapshot?.snapshotAge,Infinity);
});
test('live markets preserve odds and model probability but disable unaligned EV; prematch behavior stays',tctx=>{
  tctx.mock.method(Date,'now',()=>t);
  const match=openDotaToMatch({match_id:123,team_id_radiant:1,team_id_dire:2,game_time:300,radiant_score:1,dire_score:0,radiant_lead:0,series_type:0,live_freshness:quality()});
  const analytics={modelVersion:'test',generatedAt:iso(t),liveDataQuality:quality(),predictions:[{betType:'map_winner',labelRu:'Карта 1',probTeam1:.6,probTeam2:.4,confidence:null,edge:1,ev:1,generatedAt:iso(t),expiresAt:iso(t+120_000),modelVersion:'test',mainFactors:[]}]};
  const odds={eventId:'123',team1:'A',team2:'B',commenceTime:iso(t),bookmakers:[{bookmakerId:'pari',bookmakerName:'PARI',team1Odds:2,team2Odds:1.8,lastUpdate:iso(t),expiresAt:iso(t+120_000),scope:'map' as const,mapNumber:1}]};
  const live=analyticsToMarkets(match,analytics,odds,'pari');
  assert.equal(live.length,1);assert.equal(live[0].prediction.modelProbability,.6);assert.equal(live[0].bestOdds.oddsTeam1,2);
  assert.equal(live[0].prediction.edge,null);assert.equal(live[0].prediction.ev,null);
  const pre=analyticsToMarkets({...match,status:'prematch',startTime:new Date(t+3_600_000)},analytics,odds,'pari');
  assert.ok(pre[0].prediction.ev!>.19);
  assert.deepEqual(analyticsToMarkets({...match,liveDataQuality:quality({eligibleForObservedStatePrediction:false,reason:'state_stale'})},analytics,odds),[]);
  assert.deepEqual(analyticsToMarkets(match,{...analytics,liveDataQuality:undefined},odds),[]);
});
