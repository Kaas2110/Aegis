import test from 'node:test';import assert from 'node:assert/strict';
import {analyticsToMarkets,bookmakerResponseToOdds,rebuildMarketsForBookmaker,upcomingToMatch,openDotaToMatch,type EnrichedMatch,type OddsData} from '../artifacts/mobile/services/LiveDataService';
import {resolveLadderIdentity,bookmakerTotalsResponse,serveBookmakerTotals,uniqueBookmakerEvent} from '../artifacts/api-server/src/services/BookmakerTotalsLadder';
import {totalsLadder,totalsLine,type TotalsDistribution} from '../artifacts/api-server/src/services/TotalsDistribution';
import {expireTotalsAt} from '../artifacts/mobile/lib/totalsExpiry';
const now=Date.now(),at=new Date(now).toISOString(),future=new Date(now+60_000).toISOString();
const match={...upcomingToMatch({id:7,begin_at:future,number_of_games:3,opponents:[{opponent:{id:1,name:'Alpha'}},{opponent:{id:2,name:'Beta'}}]})!,currentMapNumber:2};
const analytics:any={generatedAt:at,modelVersion:'fixture',predictions:['match_winner','map_winner','total_kills'].map(betType=>({betType,labelRu:betType,probTeam1:.6,probTeam2:.4,confidence:null,generatedAt:at,expiresAt:future,modelVersion:'fixture',mainFactors:[]}))};
const source=(id:string,prices=[2,3,4])=>({source:id,scope:'series',eventId:'event-'+id,receivedAt:at,expiresAt:future,markets:{winner:{team1:prices[0],team2:2},mapWinners:[{map:1,team1:prices[1],team2:2},{map:2,team1:prices[2],team2:2}]}});
const odds=()=>bookmakerResponseToOdds(match,{found:true,sources:[source('bovada'),source('fonbet',[5,6,7])]})!;
test('explicit selected bookmaker without data never substitutes another source, including rebuild cache',()=>{
 const available=odds();
 for(const id of ['pari','no_bookmaker','none']){
  const markets=analyticsToMarkets(match,analytics,available,id);assert.ok(markets.every(m=>m.bestOdds.oddsTeam1===0&&m.prediction.ev===null&&m.prediction.edge===null),id);
  const enriched:EnrichedMatch={match,analyticsResult:analytics,markets:analyticsToMarkets(match,analytics,available),predictionStatus:'ready',availableBookmakers:[],oddsData:available};
  assert.ok(rebuildMarketsForBookmaker(enriched,id).every(m=>m.bestOdds.bookmakerId==='no_bookmaker'));
 }
 assert.equal(analyticsToMarkets(match,analytics,available,'fonbet').find(m=>m.type==='match_winner')!.bestOdds.oddsTeam1,5);
});
test('series and map1/map2 prices remain separate, orienting sides never changes scope',()=>{
 const m2=analyticsToMarkets(match,analytics,odds(),'bovada');
 assert.equal(m2.find(m=>m.type==='match_winner')!.bestOdds.oddsTeam1,2);
 assert.equal(m2.find(m=>m.type==='map_winner')!.bestOdds.oddsTeam1,4);
 assert.equal(m2.find(m=>m.type==='total_kills')!.bestOdds.oddsTeam1,0);
 assert.equal(analyticsToMarkets({...match,currentMapNumber:1},analytics,odds(),'bovada').find(m=>m.type==='map_winner')!.bestOdds.oddsTeam1,3);
 assert.equal(analyticsToMarkets({...match,currentMapNumber:3},analytics,odds(),'bovada').find(m=>m.type==='map_winner')!.bestOdds.oddsTeam1,0);
});
test('unknown scope, duplicate source events, missing side and stale source cannot manufacture a price',()=>{
 assert.equal(bookmakerResponseToOdds(match,{found:true,sources:[{...source('bovada'),scope:undefined}]}),undefined);
 assert.equal(bookmakerResponseToOdds(match,{found:true,sources:[source('bovada'),source('bovada')]}),undefined);
 const bad=source('bovada');bad.markets.winner.team2=NaN;
 const out=analyticsToMarkets(match,analytics,bookmakerResponseToOdds(match,{found:true,sources:[bad]}),'bovada');
 assert.equal(out.find(m=>m.type==='match_winner')!.bestOdds.oddsTeam1,0);
 assert.equal(bookmakerResponseToOdds(match,{found:true,sources:[{...source('bovada'),error:'upstream'}]}),undefined);
 const old={...odds(),bookmakers:odds().bookmakers.map(b=>({...b,lastUpdate:'2001-01-01',expiresAt:future}))};
 assert.ok(analyticsToMarkets(match,analytics,old,'bovada').every(m=>m.bestOdds.oddsTeam1===0));
});
test('OD map activation never becomes series identity without explicit verified PS series time',()=>{
 assert.equal(openDotaToMatch({match_id:8123456789,activate_time:now/1000},at).seriesStartsAt,undefined);
 assert.equal(openDotaToMatch({match_id:8123456789,activate_time:now/1000,series_start_time:at,series_identity_verified:false},at).seriesStartsAt,undefined);
 assert.equal(openDotaToMatch({match_id:8123456789,series_start_time:at,series_identity_verified:true},at).seriesStartsAt,at);
});
const feed=(data:any[])=>({data,receivedAt:at,attemptedAt:at,error:null});
const ps={id:7,begin_at:new Date(now-3600_000).toISOString(),number_of_games:3,opponents:[{opponent:{id:1,name:'Alpha'}},{opponent:{id:2,name:'Beta'}}],games:[{position:1,status:'finished',winner:{id:1}},{position:2,status:'running',begin_at:new Date(now-540_000).toISOString()}]};
const feeds={od:feed([{match_id:8123456789,team_name_radiant:'Alpha',team_name_dire:'Beta',team_id_radiant:1,team_id_dire:2,activate_time:(now-540_000)/1000}]),running:feed([ps]),upcoming:feed([])};
const identity=()=>resolveLadderIdentity('od_8123456789',feeds,now)!;
const distribution:TotalsDistribution={kind:'conditional_discrete_lognormal_v1',unit:'kills',logMean:Math.log(51),logStd:.2,logOffset:1,observedMinimum:20};
const result:any={generatedAt:at,predictions:[{betType:'total_kills',distribution,expiresAt:future,modelVersion:'validated-fixture'}]};
const event:any={source:'bovada',eventId:'b-1',team1:'Alpha',team2:'Beta',scope:'series',startsAt:ps.begin_at,status:'live',updatedAt:at,receivedAt:at,expiresAt:new Date(now+195_000).toISOString(),markets:{totalKills:[
 {line:44.5,over:2.12,under:1.7,scope:'map',map:2,unit:'kills',settlement:'integer_push'},
 {line:62.5,over:4.22,under:1.18,scope:'map',map:2,unit:'kills',settlement:'integer_push'},
]}};
test('selected bookmaker owns the exact grid; model probabilities are evaluated on those native lines',()=>{
 const own=totalsLadder(distribution)!;const b=bookmakerTotalsResponse('kills',identity(),'bovada',event,result);
 assert.deepEqual(b.lines.map(r=>r.line),[44.5,62.5]);assert.notDeepEqual(b.lines.map(r=>r.line),own.lines.map(r=>r.line));
 assert.equal(b.lines[0].pOver,totalsLine(distribution,44.5)!.pOver);assert.equal(b.lines[1].oddsOver,4.22);assert.equal(b.lines.length,2);
});
test('no model/unknown settlement keeps real bookmaker odds with null probabilities; missing price is never synthesized',()=>{
 const noModel=bookmakerTotalsResponse('kills',identity(),'bovada',event);
 assert.deepEqual(noModel.lines.map(r=>r.pOver),[null,null]);assert.equal(noModel.lines[0].oddsOver,2.12);assert.equal(noModel.unavailable,false);
 const unknown={...event,markets:{totalKills:[{...event.markets.totalKills[0],settlement:undefined,under:undefined}]}};
 const b=bookmakerTotalsResponse('kills',identity(),'bovada',unknown,result);
 assert.equal(b.lines[0].pOver,null);assert.equal(b.lines[0].oddsUnder,null);assert.equal(b.lines[0].oddsOver,2.12);
 const expired=bookmakerTotalsResponse('kills',identity(),'bovada',event,{...result,predictions:result.predictions.map((p:any)=>({...p,expiresAt:'2001-01-01'}))});assert.equal(expired.lines[0].pOver,null);
});
test('wrong map/scope/unit never enters the chosen grid; duplicate exact line is ambiguous',()=>{
 for(const change of [{map:1},{scope:'series'},{unit:'minutes'}]){
  const b=bookmakerTotalsResponse('kills',identity(),'bovada',{...event,markets:{totalKills:event.markets.totalKills.map((r:any)=>({...r,...change}))}},result);
  assert.deepEqual(b.lines,[]);assert.equal(b.unavailable,true);
 }
 assert.equal(bookmakerTotalsResponse('kills',identity(),'bovada',{...event,markets:{totalKills:[event.markets.totalKills[0],event.markets.totalKills[0]]}},result).lines.length,0);
 assert.equal(uniqueBookmakerEvent(identity(),'pari',[event]),null);assert.equal(uniqueBookmakerEvent(identity(),'bovada',[event,event]),null);
});
test('server identities reject stale feeds, old OD map, ambiguous PS series and missing PS instead of guessing',()=>{
 assert.equal(identity().mapNumber,2);
 assert.equal(resolveLadderIdentity('od_8123456789',{...feeds,running:feed([])},now),null);
 assert.equal(resolveLadderIdentity('od_8123456789',{...feeds,running:feed([ps,ps])},now),null);
 assert.equal(resolveLadderIdentity('od_8123456789',{...feeds,running:{...feeds.running,receivedAt:'2001-01-01'}},now),null);
 assert.equal(resolveLadderIdentity('od_8123456789',{...feeds,od:feed([{...(feeds.od.data[0] as any),activate_time:(now-4000_000)/1000}])},now),null);
});
test('selected-source orchestration is read-only and never falls back to another bookmaker',async()=>{
 let provider=0,predict=0;const fetched:string[]=[];const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{provider++;throw new Error('upstream');};
 try{
  const r=await serveBookmakerTotals({type:'kills',eventId:'od_8123456789',bookmakerId:'pari'},{readFeed:async n=>n==='opendota_live'?feeds.od:n==='pandascore_running'?feeds.running:feeds.upcoming,readEvents:async id=>{fetched.push(id);return [event];},predict:async()=>{predict++;return result;}});
  assert.deepEqual(r.lines,[]);assert.deepEqual(fetched,['pari']);assert.equal(provider,0);assert.equal(predict,0);
 }finally{globalThis.fetch=oldFetch;}
});
test('5-second model expiry clears probabilities and interval while 195-second quote remains valid',()=>{
 const value={expectedValue:50,interval:{q25:40,q75:60},projection:{},expiresAt:new Date(now+195000).toISOString(),probabilityExpiresAt:new Date(now+5000).toISOString(),lines:[{line:44.5,pOver:.6,pUnder:.4,pPush:0,oddsOver:2.12,oddsUnder:1.7}]};
 const expired=expireTotalsAt(value,now+6000)!;assert.equal(expired.lines[0].pOver,null);assert.equal(expired.lines[0].oddsOver,2.12);assert.equal(expired.expectedValue,null);assert.equal(expired.interval,null);assert.equal(expired.projection,null);
 assert.equal(expireTotalsAt(value,now+195000)!.lines.length,0);
});

test('bookmaker duration lines stay exact in minutes; model evaluates integer seconds with push',()=>{
 const duration:TotalsDistribution={...distribution,unit:'seconds',logMean:Math.log(2400),logOffset:0,observedMinimum:540};
 const durationResult:any={...result,predictions:[{betType:'total_duration',distribution:duration,expiresAt:future,modelVersion:'fixture'}]};
 const quotes={...event,markets:{totalDuration:[{line:40.05,over:1.987,under:1.825,scope:'map',map:2,unit:'minutes',settlement:'integer_push'}]}};
 const response=bookmakerTotalsResponse('duration',identity(),'bovada',quotes,durationResult);
 assert.equal(response.lines[0].line,40.05);assert.equal(response.lines[0].oddsOver,1.987);
 assert.equal(response.lines[0].pOver,totalsLine(duration,2403)!.pOver);assert.ok(response.lines[0].pPush!>0);
 assert.deepEqual(bookmakerTotalsResponse('duration',identity(),'pari',quotes,durationResult).lines,[]);
});

test('legacy cached markets without analytics cannot retain another bookmaker after selection',()=>{
 const enriched:EnrichedMatch={match,markets:analyticsToMarkets(match,analytics,odds(),'bovada'),predictionStatus:'ready',availableBookmakers:[]};
 assert.ok(rebuildMarketsForBookmaker(enriched,'pari').every(m=>m.bestOdds.bookmakerId==='no_bookmaker'&&m.prediction.ev===null));
});


test('one bookmaker series cannot serve two PS series of the same pair within its time window',()=>{
 const first={...ps,id:101,begin_at:new Date(now+30*60_000).toISOString(),games:[]};
 const second={...first,id:102,begin_at:new Date(now+120*60_000).toISOString(),opponents:[...first.opponents].reverse()};
 const snapshots={running:feed([]),upcoming:feed([first,second])};
 const quote={...event,startsAt:first.begin_at,status:'upcoming'};
 for(const id of [101,102]){
  const identity=resolveLadderIdentity('up_'+id,snapshots,now)!;
  assert.ok(identity);assert.equal(uniqueBookmakerEvent(identity,'bovada',[quote]),null);
 }
 // The window is relative to the actual bookmaker event, not to our first series.
 const edge={...first,id:103,begin_at:new Date(now+240*60_000).toISOString()};
 const edgeQuote={...quote,startsAt:new Date(now+140*60_000).toISOString()};
 assert.equal(uniqueBookmakerEvent(resolveLadderIdentity('up_101',{running:feed([]),upcoming:feed([first,edge])},now)!,'bovada',[edgeQuote]),null);
 const distant={...second,begin_at:new Date(now+240*60_000).toISOString()};
 assert.equal(uniqueBookmakerEvent(resolveLadderIdentity('up_101',{running:feed([]),upcoming:feed([first,distant])},now)!,'bovada',[quote]),quote);
});

test('reverse uniqueness includes running and upcoming feeds; identical cross-feed series is deduplicated',()=>{
 const next={...ps,id:8,begin_at:new Date(now+30*60_000).toISOString(),games:[]};
 const conflict={...feeds,upcoming:feed([next])};
 assert.equal(uniqueBookmakerEvent(resolveLadderIdentity('pslive_7',conflict,now)!,'bovada',[event]),null);
 const duplicate={...feeds,upcoming:feed([ps])};
 assert.equal(uniqueBookmakerEvent(resolveLadderIdentity('pslive_7',duplicate,now)!,'bovada',[event]),event);
 const stale={...feeds,upcoming:{...feeds.upcoming,receivedAt:'2001-01-01'}};
 assert.equal(uniqueBookmakerEvent(resolveLadderIdentity('pslive_7',stale,now)!,'bovada',[event]),null);
 const contradiction={...feeds,upcoming:feed([{...ps,begin_at:new Date(now).toISOString()}])};
 assert.equal(uniqueBookmakerEvent(resolveLadderIdentity('pslive_7',contradiction,now)!,'bovada',[event]),null);
});
