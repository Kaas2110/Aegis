import {buildPopularMarkets} from '../artifacts/api-server/src/services/PopularMarkets';
import test from 'node:test';
import assert from 'node:assert/strict';
import {totalsLadder,totalsLine,type TotalsDistribution} from '../artifacts/api-server/src/services/TotalsDistribution';
import {eligibleTotalsModel} from '../artifacts/api-server/src/services/TotalsModelPolicy';
import {selectMapMarket,selectSeriesMarket} from '../artifacts/mobile/lib/matchSemantics';
const kills:TotalsDistribution={kind:'conditional_discrete_lognormal_v1',unit:'kills',logMean:Math.log(51),logStd:.2,logOffset:1,observedMinimum:20};
const duration:TotalsDistribution={kind:'conditional_discrete_lognormal_v1',unit:'seconds',logMean:Math.log(2400),logStd:.24,logOffset:0,observedMinimum:540};
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('duration quantiles/median/lines share minutes once; screenshot values cannot be mislabeled seconds',()=>{
 const a=totalsLadder(duration)!;
 assert.equal(a.displayUnit,'minutes');assert.equal(a.expectedValue,40);assert.ok(a.interval.q25>30&&a.interval.q25<40);assert.ok(a.interval.q75>40&&a.interval.q75<50);
 assert.ok(a.lines.every(l=>l.line>=38.5&&l.line<=41.5));
 const shifted=totalsLadder({...duration,logMean:Math.log(3000)})!;
 assert.ok(shifted.expectedValue>a.expectedValue);assert.notDeepEqual(shifted.lines,a.lines);
});
test('integer equality has push, half-kill lines do not; no lower-than-observed final',()=>{
 const d={...kills,observedMinimum:50};
 const eq=totalsLine(d,50)!;assert.equal(eq.pUnder,0);assert.ok(eq.pPush>0);close(eq.pOver+eq.pPush,1);
 const half=totalsLine(d,50.5)!;assert.equal(half.pPush,0);close(half.pOver+half.pUnder,1);
 assert.equal(totalsLine(d,49.5)!.pOver,1);
});
test('ongoing duration must exceed exact observed clock; finished-at-line probability is separate push',()=>{
 const d={...duration,observedMinimum:2400};
 assert.equal(totalsLine(d,2400)!.pOver,1);assert.equal(totalsLine(d,2400)!.pPush,0);
 assert.ok(totalsLine(d,2401)!.pPush>0);assert.equal(totalsLine(d,2401)!.pUnder,0);
 assert.ok(totalsLadder(d)!.expectedValue>40);assert.ok(totalsLadder(d)!.lines.every(l=>l.line>40));
});
test('all rows are monotone/coherent, with state-dependent centers and no impossible quantiles',()=>{
 for(const [d,states] of [[kills,[0,20,60,90]],[duration,[60,1800,3000,4200]]] as const){
  let median=-1;
  for(const state of states){
   const a=totalsLadder({...d,observedMinimum:state},15)!;
   assert.ok(a.expectedValue>=median);median=a.expectedValue;
   assert.ok(a.interval.q25<=(a.expectedValue)&&a.expectedValue<=a.interval.q75);
   a.lines.forEach((r,i)=>{close(r.pOver+r.pUnder+r.pPush,1);assert.ok(r.pOver>=0&&r.pUnder>=0&&r.pPush>=0);if(i){assert.ok(r.pOver<=a.lines[i-1].pOver);assert.ok(r.pUnder>=a.lines[i-1].pUnder);}});
  }
 }
});
test('invalid scale or numerically unsupported conditioning is unavailable, not a guessed probability',()=>{
 for(const std of [0,-1,NaN,Infinity])assert.equal(totalsLadder({...kills,logStd:std}),null);
 assert.equal(totalsLadder({...kills,observedMinimum:-1}),null);
 assert.equal(totalsLadder({...kills,observedMinimum:1e12}),null);
 assert.equal(totalsLadder({...kills,logMean:Infinity}),null);
});
test('active legacy flags never substitute for audited totals validation and units',()=>{
 const valid={validationStatus:'validated',eligibleForServing:true,validationReport:'fixture.json',totalsContract:{version:'conditional_discrete_lognormal_v1',targetScope:'map',unit:'kills',targetTransform:'log1p',outOfTimeCalibrationValidated:true}};
 assert.equal(eligibleTotalsModel('live_total_kills',valid),true);
 for(const meta of [{},{isActive:true},{...valid,eligibleForServing:false},{...valid,validationReport:''},{...valid,totalsContract:{...valid.totalsContract,unit:'minutes'}},{...valid,totalsContract:{...valid.totalsContract,targetTransform:'log'}}])assert.equal(eligibleTotalsModel('live_total_kills',meta),false);
 assert.equal(eligibleTotalsModel('market_total_kills',valid),false);
});
test('series cards and map details cannot fall back to each other or to a total',()=>{
 const markets=[{type:'total_kills'},{type:'map_winner'},{type:'match_winner'}];
 assert.equal(selectSeriesMarket(markets)?.type,'match_winner');assert.equal(selectMapMarket(markets)?.type,'map_winner');
 assert.equal(selectSeriesMarket(markets.slice(0,2)),undefined);assert.equal(selectMapMarket([{type:'match_winner'}]),undefined);
});

test('fair decimal price accounts for push as a refund',()=>{
 const r=buildPopularMarkets({predictions:[{betType:'total_duration',probTeam1:.4,probTeam2:.5,pPush:.1}]} as any);
 close(r[0].fairOdds!,1.8);assert.equal(r[0].pPush,.1);assert.equal(r[0].recommendation,'Меньше');
});
