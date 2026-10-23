import test from 'node:test';
import assert from 'node:assert/strict';
import { positiveId, openDotaMatchId, supportedPredictions, freshPrediction, predictionCacheKey, probabilityInTeamOrder, validatePredictionInput, knownSeriesFormat, type ServingEvidence } from '../artifacts/api-server/src/services/PredictionContract';
import { resolveTeamFromRows } from '../artifacts/api-server/src/services/TeamIdentity';
import { sameTeamIdentity, orientWinnerOutcomes, unambiguousSourceEvents } from '../artifacts/api-server/src/services/BookmakerMatcher';
import { withCache, clearResponseCache } from '../artifacts/api-server/src/lib/responseCache';
import { applyResolvedTeamIds, analyticsToMarkets, openDotaToMatch, upcomingToMatch, findExactOdds, fetchLiveData, loadMatchForDetail, getCachedMatch, ageSeconds, type EnrichedMatch } from '../artifacts/mobile/services/LiveDataService';
import { extractNumericMatchId, positiveSafeId } from '../artifacts/mobile/lib/matchId';
import type { MatchInput } from '../artifacts/api-server/src/services/AnalyticsEngine';
import { parseMarketPredictionPayload } from '../artifacts/api-server/src/services/MarketPredictionPayload';

const now=Date.now(), at=new Date(now).toISOString();
const input:MatchInput={matchId:'od_8123456789',matchSource:'opendota',status:'prematch',format:'BO3',team1:{name:'Alpha',teamId:1,provider:'opendota'},team2:{name:'Beta',teamId:2,provider:'opendota'},seriesContext:{seriesScore1:0,seriesScore2:0,currentMapNumber:1}};
const estimate={probability:.7,rawProbability:.73,modelVersion:'fixture-v1',predictedAt:at,featuresVersion:1,calibrationMethod:'isotonic'};
const empty:ServingEvidence={map:null,futureMap:null,kills:null,duration:null};
const pred=(i:MatchInput,e:ServingEvidence)=>supportedPredictions(i,e,now);
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
test('map number follows completed series score; contradictory counters cannot price a series',()=>{
 const i={...input,seriesContext:{seriesScore1:1,seriesScore2:1}};
 const result=pred(i,{...empty,map:estimate,futureMap:estimate});
 assert.equal(result.predictions.find(p=>p.betType==='map_winner')?.labelRu,'Победитель карты 3');
 const bad={...i,seriesContext:{...i.seriesContext,currentMapNumber:2}};
 assert.throws(()=>validatePredictionInput(bad),/invalid_prediction_input/);
 assert.equal(pred(bad,{...empty,map:estimate,futureMap:estimate}).predictions.length,0);
});
const teamRows=[{teamId:1,name:'Alpha',tag:'A',rating:1600},{teamId:2,name:'Beta',tag:'B',rating:1500}];

test('fresh computation cannot revive stale source data for live winner or totals',()=>{
 const result=pred({...input,status:'live',format:'unknown'},{...empty,
  map:{...estimate,observedAt:new Date(now-181_000).toISOString()},
  kills:{mean:4,std:.2,observedMinimum:20,logOffset:1,modelVersion:'fixture-kills',predictedAt:at,observedAt:new Date(now-181_000).toISOString()}});
 assert.equal(result.predictions.length,0);
});

test('live map, derived series and totals expire with the oldest required packet',()=>{
 const observedAt=new Date(now-120_000).toISOString();
 const result=pred({...input,status:'live'},{...empty,map:{...estimate,observedAt},futureMap:estimate,
  kills:{mean:4,std:.2,observedMinimum:20,logOffset:1,modelVersion:'fixture-kills',predictedAt:at,observedAt}});
 for(const type of ['map_winner','match_winner','total_kills']) {
   assert.equal(result.predictions.find(p=>p.betType===type)?.expiresAt,new Date(now+60_000).toISOString(),type);
 }
});
const match=upcomingToMatch({id:42,begin_at:at,number_of_games:3,opponents:[{opponent:{id:100,name:'Alpha'}},{opponent:{id:200,name:'Beta'}}]})!;

test('quantile point estimates accept null std; regression distributions require measured positive dispersion',()=>{
 assert.deepEqual(parseMarketPredictionPayload({task_type:'quantile',mean:7.8,std:null}),{task_type:'quantile',mean:7.8,std:0});
 for(const std of [null,undefined,0,-1,NaN,Infinity]) assert.equal(parseMarketPredictionPayload({task_type:'regression',mean:4,std}),null);
 assert.deepEqual(parseMarketPredictionPayload({task_type:'regression',mean:4,std:.2}),{task_type:'regression',mean:4,std:.2});
 assert.equal(parseMarketPredictionPayload({task_type:'classification',calibrated_prob:NaN}),null);
});

test('OD match IDs: only positive canonical OD IDs may query live predictions or summaries',()=>{
 assert.equal(openDotaMatchId(input),8123456789);
 for(const id of ['up_8123456789','pslive_8123456789','od_-42','od_0','od_synth-9','od_01','8123456789']) {
   assert.equal(openDotaMatchId({matchId:id}),null,id); assert.equal(extractNumericMatchId(id),null,id);
 }
 assert.equal(openDotaMatchId({...input,matchSource:'pandascore'}),null);
 assert.equal(positiveId(Number.MAX_SAFE_INTEGER+1),null);
});

test('OD uint64 JSON strings normalize to safe canonical match IDs without accepting synthetic or unsafe identifiers',()=>{
 const od=openDotaToMatch({match_id:'9027674421',source:'opendota'},at);
 assert.equal(od.id,'od_9027674421');assert.equal(od.openDotaMatchId,9027674421);
 for(const value of ['0','01','1e4',' 42','-1','9007199254740993',Infinity]) assert.equal(positiveSafeId(value),null);
 assert.equal(openDotaToMatch({match_id:'9027674421',source:'pandascore',ps_match_id:123},at).openDotaMatchId,undefined);
});
test('PS IDs never collide with OD: unresolved and ambiguous names stay unresolved',()=>{
 assert.equal(resolveTeamFromRows({name:'Unknown',teamId:1,provider:'pandascore'},teamRows).teamId,undefined);
 assert.equal(resolveTeamFromRows({name:'Beta',teamId:1,provider:'pandascore'},teamRows).teamId,2);
 assert.equal(resolveTeamFromRows({name:'Alpha',provider:'pandascore'},[...teamRows,{...teamRows[0],teamId:3}]).teamId,undefined);
 assert.equal(resolveTeamFromRows({name:'Alpha Academy',teamId:1,provider:'pandascore'},teamRows).teamId,undefined);
});
test('prematch map target is forwarded into BO series probability, never inverted',()=>{
 const result=pred(input,{...empty,map:estimate,futureMap:estimate});
 close(result.predictions.find(p=>p.betType==='map_winner')!.probTeam1,.7);
 close(result.predictions.find(p=>p.betType==='match_winner')!.probTeam1,.784);
 const lead=pred({...input,seriesContext:{seriesScore1:1,seriesScore2:0,currentMapNumber:2}},{...empty,map:estimate,futureMap:estimate});
 close(lead.predictions.find(p=>p.betType==='match_winner')!.probTeam1,.91);
});
test('live BO3 combines current-map probability with independent future maps in the correct direction',()=>{
 const r=pred({...input,status:'live',seriesContext:{seriesScore1:1,seriesScore2:0,currentMapNumber:2}},{...empty,map:{...estimate,probability:.8},futureMap:{...estimate,probability:.6}});
 close(r.predictions.find(p=>p.betType==='match_winner')!.probTeam1,.92);
 assert.equal(r.predictions.find(p=>p.betType==='match_winner')!.provenance!.basis,'live_map_and_independent_future_maps');
});

test('unknown series format preserves fresh live map and totals with original provenance, without a series forecast',()=>{
 const unknown:MatchInput={...input,status:'live',format:'unknown',seriesContext:{seriesScore1:1,seriesScore2:1,currentMapNumber:3}};
 validatePredictionInput(unknown);
 assert.equal(knownSeriesFormat(unknown.format),false);
 const result=pred(unknown,{map:estimate,futureMap:estimate,kills:{mean:4,std:.2,modelVersion:'live-kills',predictedAt:at,observedAt:at,observedMinimum:20,logOffset:1},duration:{mean:7.8,std:.1,modelVersion:'live-duration',predictedAt:at,observedAt:at,observedMinimum:540,logOffset:0}});
 assert.deepEqual(result.predictions.map(p=>p.betType),['map_winner','total_kills','total_duration']);
 const map=result.predictions[0];
 assert.equal(map.labelRu,'Победитель карты 3');assert.equal(map.probTeam1,.7);assert.equal(map.modelVersion,estimate.modelVersion);assert.equal(map.generatedAt,at);assert.equal(map.provenance?.basis,'live_snapshot');
 assert.equal(result.unavailableMarkets?.find(p=>p.betType==='match_winner')?.reason,'series_format_unknown');
 assert.equal(pred({...unknown,status:'prematch'},{...empty,map:estimate,futureMap:estimate}).predictions.length,0);
 assert.equal(pred(unknown,{...empty,map:{...estimate,predictedAt:'2001-01-01'}}).predictions.length,0);
 assert.throws(()=>validatePredictionInput({...unknown,format:'BO7' as never}),/invalid_prediction_input/);
});

test('unknown BO mobile feeds still request stored live analytics and do not attach series odds',async()=>{
 const originalFetch=globalThis.fetch;
 const liveDataQuality={eligibleForObservedStatePrediction:true,reason:null,receivedAt:at,lastStateChangeReceivedAt:at,
   stateAgeSeconds:0,declaredBroadcastDelaySeconds:120,measuredEndToEndLatencySeconds:null,eventLatencyVerified:false,meetsVerifiedLiveLatencyPolicy:false};
 const requests:Array<{url:string;body?:any}>=[];
 globalThis.fetch=async(url,init)=>{
   const path=String(url);const body=init?.body?JSON.parse(String(init.body)):undefined;requests.push({url:path,body});
   if(path.endsWith('/matches/live')) return Response.json({noData:false,_field_meta:{fetchedAt:at},sources:[{source:'opendota',data:[{match_id:8123456790,team_id_radiant:1,team_id_dire:2,team_name_radiant:'Alpha',team_name_dire:'Beta',game_time:900,radiant_score:5,dire_score:6,radiant_lead:1234,building_state:0,live_freshness:liveDataQuality}]}]});
   if(path.endsWith('/matches/upcoming')) return Response.json({noData:false,data:[]});
   if(path.endsWith('/odds/dota2')) return Response.json({noData:true,data:[]});
   if(path.endsWith('/analytics/predict')) return Response.json({...pred(body,{...empty,map:estimate,futureMap:estimate}),generatedAt:at,liveDataQuality});
   throw new Error('Unexpected request '+path);
 };
 try {
   const result=await fetchLiveData();
   const unknown=result.liveMatches[0];
   assert.equal(unknown.match.format,'unknown');assert.equal(unknown.match.formatKnown,false);
   assert.equal(unknown.predictionStatus,'ready');assert.deepEqual(unknown.markets.map(m=>m.type),['map_winner']);
   const req=requests.find(r=>r.url.endsWith('/analytics/predict'));
   assert.equal(req?.body.format,'unknown');assert.equal(req?.body.status,'live');
   assert.equal(unknown.markets[0].prediction.ev,null);assert.equal(unknown.markets[0].bestOdds.oddsTeam1,0);assert.equal(unknown.availableBookmakers.length,0);
   assert.equal(requests.some(r=>r.url.includes('/bookmakers/')),false);
 } finally {globalThis.fetch=originalFetch;}
});
test('stored Radiant predictions are inverted only when the requested team pair is reversed',()=>{
 close(probabilityInTeamOrder(.72,'same'),.72);close(probabilityInTeamOrder(.72,'flipped'),.28);
});
test('finished, between-map and completed-series states cannot expose stale model probabilities',()=>{
 for(const status of ['finished','between_maps'] as const) assert.equal(pred({...input,status},{...empty,map:estimate,futureMap:estimate}).predictions.length,0);
 assert.equal(pred({...input,seriesContext:{seriesScore1:2,seriesScore2:0,currentMapNumber:3}},{...empty,map:estimate,futureMap:estimate}).predictions.length,0);
});
test('missing models and stale live rows yield no fake 50/50, totals or first-blood probabilities',()=>{
 assert.equal(pred(input,empty).state,'unavailable'); assert.equal(pred(input,empty).predictions.length,0);
 const stale={...estimate,predictedAt:'2001-01-01T00:00:00Z'};
 const r=pred({...input,status:'live'},{...empty,map:stale});
 assert.equal(r.predictions.length,0);
 assert.equal(r.unavailableMarkets!.find(p=>p.betType==='first_blood')!.reason,'training_target_not_validated');
 assert.equal(freshPrediction('invalid',1000,now),false);
 assert.equal(freshPrediction(new Date(now+60000),1000,now),false);
});
test('totals contract preserves native seconds/offsets and dynamic representative lines',()=>{
 const r=pred({...input,status:'live'},{...empty,kills:{mean:4,std:.2,modelVersion:'kills',predictedAt:at,observedAt:at,observedMinimum:20,logOffset:1},duration:{mean:7.8,std:.1,modelVersion:'duration',predictedAt:at,observedAt:at,observedMinimum:540,logOffset:0}});
 assert.equal(r.predictions.find(p=>p.betType==='total_kills')!.distribution?.logOffset,1);
 assert.equal(r.predictions.find(p=>p.betType==='total_duration')!.distribution?.unit,'seconds');
 assert.ok(!r.predictions.find(p=>p.betType==='total_kills')!.labelRu.includes('52.5'));
});
test('BO1 and deciding maps are series-identical; live prior alone never becomes series forecast',()=>{
 for(const [format,s1,s2] of [['BO1',0,0],['BO3',1,1],['BO5',2,2]] as const){
  const r=pred({...input,status:'live',format,seriesContext:{seriesScore1:s1,seriesScore2:s2,currentMapNumber:s1+s2+1}},{...empty,map:{...estimate,probability:.8},futureMap:{...estimate,probability:.1}});
  close(r.predictions.find(p=>p.betType==='match_winner')!.probTeam1,.8);
 }
 const missing=pred({...input,status:'live'},{...empty,futureMap:estimate});
 assert.equal(missing.predictions.some(p=>p.betType==='match_winner'),false);
});

test('PandaScore live metadata never manufactures scores, buildings or a positive OD match ID',()=>{
 const ps=openDotaToMatch({match_id:-42,team_id_radiant:100,team_id_dire:200,team_name_radiant:'Alpha',team_name_dire:'Beta',source:'pandascore',number_of_games:5},at);
 assert.equal(ps.openDotaMatchId,undefined);assert.equal(ps.source,'pandascore');assert.equal(ps.format,'BO5');assert.equal(ps.liveSnapshot,undefined);assert.equal(ps.team1Side,'unknown');
 assert.equal(match.team1.provider,'pandascore');assert.equal(match.team1.openDotaId,undefined);assert.equal(match.team1Side,'unknown');
});
test('snapshot age remains real and unverified building bit layouts never invent tower or barracks counts',()=>{
 const od=openDotaToMatch({match_id:8123456789,game_time:900,radiant_score:5,dire_score:6,radiant_lead:1234,building_state:0},new Date(now-300000).toISOString());
 assert.ok(od.liveSnapshot!.snapshotAge>=300);assert.equal(od.liveSnapshot!.towersRadiant,null);assert.equal(od.liveSnapshot!.barracksDire,null);
 assert.equal(od.liveSnapshot!.netWorthRadiant-od.liveSnapshot!.netWorthDire,1234);
 const highBits=openDotaToMatch({match_id:8123456799,game_time:900,radiant_score:5,dire_score:6,radiant_lead:1234,building_state:0xffffffff},at);
 assert.equal(highBits.liveSnapshot!.towersDire,null);assert.equal(highBits.liveSnapshot!.barracksRadiant,null);
 assert.equal(ageSeconds(undefined),Infinity);
});

test('observed lineup preserves unknown bans/order and does not synthesize neutral draft scores',()=>{
 const od=openDotaToMatch({match_id:8123456800,draft:{picks:[{heroId:1,heroName:'Anti-Mage',side:'radiant',order:null}],bans:[],bansKnown:false,orderKnown:false,source:'opendota',basis:'observed_live_lineup',fetchedAt:at}},at);
 assert.equal(od.draft?.picks[0].order,null);assert.equal(od.draft?.bansKnown,false);assert.equal(od.draft?.orderKnown,false);
 assert.equal(od.draft?.radiantSynergy,null);assert.equal(od.draft?.direCounter,null);assert.equal(od.draft?.radiantScalingScore,null);assert.equal(od.draft?.direEarlyGameScore,null);
});

test('direct detail cold-load resolves only the exact real feed match, never inventing a missing ID',async()=>{
 const originalFetch=globalThis.fetch;const predictions:any[]=[];let requests=0;
 const id='od_8123456998';assert.equal(getCachedMatch(id),undefined);
 globalThis.fetch=async(url,init)=>{
  requests++;const path=String(url);
  if(path.endsWith('/matches/live')) return Response.json({noData:false,_field_meta:{fetchedAt:at},sources:[{source:'opendota',data:[8123456997,8123456998].map(match_id=>({match_id,team_id_radiant:1,team_id_dire:2,team_name_radiant:'Alpha',team_name_dire:'Beta',game_time:900,radiant_score:5,dire_score:6,radiant_lead:1234}))}]});
  if(path.endsWith('/matches/upcoming') || path.endsWith('/odds/dota2')) return Response.json({noData:false,data:[]});
  if(path.endsWith('/analytics/predict')) {const body=JSON.parse(String(init?.body));predictions.push(body);return Response.json({...pred(body,empty),generatedAt:at});}
  throw new Error('Unexpected request '+path);
 };
 try {
  const detail=await loadMatchForDetail(id);
  assert.equal(detail?.match.id,id);assert.equal(getCachedMatch(id)?.match.id,id);
  assert.equal(predictions.length,1);assert.equal(predictions[0].matchId,id);assert.equal(predictions[0].liveSnapshot.towerLead,null);assert.equal(predictions[0].liveSnapshot.barracksLost,null);assert.equal(predictions[0].draft,undefined);
  assert.equal(await loadMatchForDetail('od_8123456999'),undefined);assert.equal(predictions.length,1);
  const before=requests;assert.equal(await loadMatchForDetail('od_-99'),undefined);assert.equal(requests,before);
 } finally {globalThis.fetch=originalFetch;}
});
test('odds match both teams and event time, reverse the pair, and reject ambiguous matches',()=>{
 const quote={eventId:'x',team1:'Beta',team2:'Alpha',commenceTime:at,bookmakers:[{bookmakerId:'b',bookmakerName:'B',scope:'series' as const,team1Odds:3,team2Odds:1.5,lastUpdate:at}]};
 assert.equal(findExactOdds(match,[{...quote,team1:'Someone'}]),undefined);
 assert.equal(findExactOdds(match,[{...quote,commenceTime:'2001-01-01'}]),undefined);
 assert.equal(findExactOdds(match,[quote,quote]),undefined);
 assert.equal(findExactOdds(match,[quote])!.bookmakers[0].team1Odds,1.5);
 assert.equal(sameTeamIdentity('Alpha Academy','Alpha'),false);
 assert.deepEqual(orientWinnerOutcomes([{description:'Beta',price:{decimal:3}},{description:'Alpha',price:{decimal:1.5}}],'Alpha','Beta'),{team1:1.5,team2:3});
});
test('a bookmaker with two plausible events for the same pair does not silently select the first',()=>{
 assert.deepEqual(unambiguousSourceEvents([{source:'bovada',id:1},{source:'bovada',id:2},{source:'another',id:3}]),[{source:'another',id:3}]);
});
test('series quotes never price map or total markets, and calibration metadata is preserved',()=>{
 const result=pred(input,{...empty,map:estimate,futureMap:estimate,kills:{mean:4,std:.2,modelVersion:'kills',predictedAt:at,observedAt:at,observedMinimum:540,logOffset:0}});
 const analytics={...result,generatedAt:at} as NonNullable<EnrichedMatch['analyticsResult']>;
 const markets=analyticsToMarkets(match,analytics,{eventId:'q',team1:'Alpha',team2:'Beta',commenceTime:at,bookmakers:[{bookmakerId:'b',bookmakerName:'B',scope:'series' as const,team1Odds:2,team2Odds:2,lastUpdate:at}]});
 for(const m of markets.filter(m=>m.type!=='match_winner')) {assert.equal(m.bestOdds.oddsTeam1,0);assert.equal(m.prediction.ev,null);assert.equal(m.prediction.edge,null);}
 const map=markets.find(m=>m.type==='map_winner')!;
 assert.equal(map.prediction.calibratedProbability,.7);assert.equal(map.prediction.rawProbability,.73);assert.equal(map.prediction.calibrationMethod,'isotonic');assert.equal(map.prediction.confidence,null);assert.equal(map.prediction.modelVersion,'fixture-v1');
 assert.equal(map.prediction.provenance!.qualityStatus,'legacy_unvalidated');
});
test('unknown or stale quote time cannot generate EV; expired cached predictions are removed',()=>{
 const result=pred(input,{...empty,map:estimate,futureMap:estimate});
 const analytics={...result,generatedAt:at} as NonNullable<EnrichedMatch['analyticsResult']>;
 const quote={eventId:'q',team1:'Alpha',team2:'Beta',commenceTime:at,bookmakers:[{bookmakerId:'b',bookmakerName:'B',scope:'series' as const,team1Odds:2,team2Odds:2,lastUpdate:'2001-01-01'}]};
 assert.equal(analyticsToMarkets(match,analytics,quote).find(m=>m.type==='match_winner')!.prediction.ev,null);
 analytics.predictions=analytics.predictions.map(p=>({...p,expiresAt:'2001-01-01'}));
 assert.equal(analyticsToMarkets(match,analytics,quote).length,0);
});
test('model change and context change bypass old cache while missing results are immediately retryable',async()=>{
 clearResponseCache(); let calls=0;
 const key1=predictionCacheKey(input,'model-v1'),key2=predictionCacheKey(input,'model-v2');
 assert.notEqual(key1,key2);assert.notEqual(key1,predictionCacheKey({...input,format:'BO5'},'model-v1'));
 await withCache(key1,60000,async()=>++calls); await withCache(key1,60000,async()=>++calls);
 assert.equal(calls,1);await withCache(key2,60000,async()=>++calls);assert.equal(calls,2);
 await withCache('missing-fixture',60000,async()=>++calls,()=>false);await withCache('missing-fixture',60000,async()=>++calls,()=>false);assert.equal(calls,4);
 clearResponseCache();
});

test('drafted current map affects prematch series and both model versions remain in provenance',()=>{
 const result=pred(input,{...empty,map:{...estimate,probability:.8,modelVersion:'draft-current'},futureMap:{...estimate,probability:.6,modelVersion:'future-prior'}});
 const series=result.predictions.find(p=>p.betType==='match_winner')!;
 close(series.probTeam1,.744);assert.equal(series.modelVersion,'draft-current+future-prior+series-forward');
});

test('prematch series expires with the oldest current-map input as well',()=>{
 const old=new Date(now-50_000).toISOString();
 const r=pred(input,{...empty,map:{...estimate,predictedAt:old},futureMap:estimate});
 assert.equal(r.predictions.find(p=>p.betType==='match_winner')!.expiresAt,new Date(now+10_000).toISOString());
});


test('explicit unresolved team IDs clear cached mapping; missing legacy response preserves it',()=>{
 const match={team1:{openDotaId:5017210 as number|undefined},team2:{openDotaId:42 as number|undefined}};
 applyResolvedTeamIds(match,undefined);
 assert.equal(match.team1.openDotaId,5017210);assert.equal(match.team2.openDotaId,42);
 applyResolvedTeamIds(match,{team1Id:null,team2Id:10300669});
 assert.equal(match.team1.openDotaId,undefined);assert.equal(match.team2.openDotaId,10300669);
 applyResolvedTeamIds(match,{team1Id:5017210,team2Id:null});
 assert.equal(match.team1.openDotaId,5017210);assert.equal(match.team2.openDotaId,undefined);
});
