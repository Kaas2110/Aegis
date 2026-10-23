import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBovada, parseFonbetLine, parseOlimp} from '../artifacts/api-server/src/services/BookmakerParsers';
import {matchBookmakerEvents, orientBookmakerMarkets, sameTeamIdentity, verifiedRunningSeriesIdentity} from '../artifacts/api-server/src/services/BookmakerMatcher';

const receipt='2026-10-03T20:55:00.000Z';
const winner=(period='Game',status='O')=>({description:'Moneyline',status,period:{description:period},outcomes:[
 {description:'Beta',status:'O',price:{decimal:'2.05'}},{description:'Alpha',status:'O',price:{decimal:'1.8'}},
]});
const fixture=(markets:any[])=>[{path:[{link:'/esports/dota-2'}],events:[{id:1,status:'U',live:true,startTime:1791054000000,
 competitors:[{name:'Alpha'},{name:'Beta'}],displayGroups:[{markets}]}]}];
test('Bovada respects outcome labels, open status, live map and totals scope',()=>{
 const raw=fixture([winner(),winner('Live Map 2'),winner('Map 1','S'),
 {description:'Under/Over Kills',status:'O',period:{description:'Live Map 2'},outcomes:[
  {description:'Under',type:'U',status:'O',price:{handicap:'45.5',decimal:'1.9'}},
  {description:'Over',type:'O',status:'O',price:{handicap:'45.5',decimal:'2.0'}},
 ]}]);
 const [event]=parseBovada(raw,receipt);
 assert.equal(event.status,'live');assert.deepEqual(event.markets.winner,{team1:1.8,team2:2.05});
 assert.deepEqual(event.markets.mapWinners,[{map:2,team1:1.8,team2:2.05}]);
 assert.deepEqual(event.markets.totalKills,[{scope:'map',map:2,unit:'kills',line:45.5,over:2,under:1.9}]);
 assert.equal(event.receivedAt,receipt);
});
test('Bovada rejects other esports, invalid prices and mismatched total lines',()=>{
 assert.throws(()=>parseBovada([{unexpected:[]}],receipt),/schema_changed/);
 const raw=fixture([{description:'Under/Over Kills',status:'O',period:{description:'Map 1'},outcomes:[
  {type:'O',status:'O',price:{handicap:'45.5',decimal:'1.8'}},{type:'U',status:'O',price:{handicap:'46.5',decimal:'1.9'}},
 ]}]);
 assert.deepEqual(parseBovada(raw,receipt),[]);
 const cs=fixture([winner()]);cs[0].path[0].link='/esports/cs2';assert.deepEqual(parseBovada(cs,receipt),[]);
 const bad=fixture([winner()]);bad[0].events[0].displayGroups[0].markets[0].outcomes[0].price.decimal='1';
 assert.deepEqual(parseBovada(bad,receipt),[]);
});
test('Bovada matches map suffixes and explicit competitor IDs from the public feed',()=>{
 const raw=fixture([winner('Map 2')]);
 raw[0].events[0].displayGroups[0].markets[0].outcomes[0].description='Beta - Map 2';
 raw[0].events[0].displayGroups[0].markets[0].outcomes[1].description='Alpha - Map 2';
 assert.equal(parseBovada(raw,receipt)[0].markets.mapWinners?.[0].team1,1.8);
});
test('Fonbet/PARI filter Dota league, attach child map, never guess totals from numeric IDs',()=>{
 const raw={sports:[{id:9,name:'Dota 2. BLAST Slam Bo3'},{id:10,name:'CS2'}],events:[
  {id:1,sportId:9,level:1,team1:'Alpha',team2:'Beta',startTime:1791054000,place:'line'},
  {id:2,sportId:9,parentId:1,level:2,name:'1-я карта'},
  {id:3,sportId:10,level:1,team1:'Alpha',team2:'Beta',startTime:1791054000},
 ],customFactors:[{e:1,factors:[{f:921,v:1.8},{f:923,v:2.05},{f:930,v:1.9,pt:'113.5'}]},{e:2,factors:[{f:921,v:1.7},{f:923,v:2.2}]}]};
 for(const source of ['fonbet','pari'] as const){const events=parseFonbetLine(raw,source,receipt);
 assert.equal(events.length,1);assert.equal(events[0].source,source);assert.equal(events[0].markets.mapWinners?.[0].map,1);
 assert.equal(events[0].markets.totalKills,undefined);assert.equal(events[0].status,'upcoming');}
});
test('Olimp separates kills, minutes, maps and Roshan/individual totals',()=>{
 const outcome=(groupName:string,marketId:number,name:string,param:string,p:string)=>({groupName,marketId,unprocessedName:name,param,probability:p});
 const body=[{operationId:'LINE_EVENTS_GET_SOME',payload:{id:'1',competitionName:'Dota 2. BLAST Slam',state:'OPEN',team1Name:'Alpha',team2Name:'Beta',startDateTime:1791054000,outcomes:[
  {...outcome('Основные',2,'Alpha','','1.8'),shortName:'П1'},
  {...outcome('Основные',2,'Beta','','2.05'),shortName:'П2'},
  outcome('Карта 1',12,'Тотал Карты 1 (45.5) бол','45.5','1.9'),outcome('Карта 1',12,'Тотал Карты 1 (45.5) мен','45.5','1.95'),
  outcome('Карта 1: Продолжительность в мин.',1202,'Тотал (43) бол','43','1.8'),outcome('Карта 1: Продолжительность в мин.',1202,'Тотал (43) мен','43','2.0'),
  outcome('Карта 1: Тотал убитых Рошанов',1200,'Тотал (2.5) бол','2.5','1.8'),outcome('Карта 1: Тотал убитых Рошанов',1200,'Тотал (2.5) мен','2.5','2.0'),
 ]}}];
 const [event]=parseOlimp(body,false,receipt);assert.equal(event.markets.totalKills?.length,1);
 assert.equal(event.markets.totalDuration?.[0].unit,'minutes');assert.equal(event.markets.totalDuration?.[0].map,1);
 body[0].payload.state='PAUSED';assert.deepEqual(parseOlimp(body,false,receipt),[]);
});
test('matching requires unambiguous pair and time; orientation preserves all map metadata',()=>{
 const [event]=parseBovada(fixture([winner(),winner('Map 2')]),receipt);
 event.markets.correctScore=[{score:'2-1',price:3}];
 const reversed=orientBookmakerMarkets(event.markets,true);
 assert.equal(reversed.mapWinners?.[0].team1,2.05);assert.equal(reversed.correctScore?.[0].score,'1-2');
 const match={matchId:'p1',team1Name:'Alpha',team2Name:'Beta',startsAt:event.startsAt,isLive:true};
 assert.equal(matchBookmakerEvents([match],[event]).length,1);
 assert.deepEqual(matchBookmakerEvents([{...match,startsAt:null}],[event]),[]);
 assert.deepEqual(matchBookmakerEvents([{...match,startsAt:'invalid'}],[event]),[]);
 assert.deepEqual(matchBookmakerEvents([{...match,scope:'map'}],[event]),[]);
 assert.deepEqual(matchBookmakerEvents([match],[event,{...event,eventId:'other'}]),[]);
 assert.deepEqual(matchBookmakerEvents([match,{...match,matchId:'doubleheader'}],[event]),[]);
 assert.equal(sameTeamIdentity('ex Team Spirit','Team Spirit'),false);
 assert.equal(sameTeamIdentity('NAVI Junior','Natus Vincere'),false);
});
test('series start is sourced only from a unique recent PandaScore series',()=>{
 const ps={id:91,begin_at:receipt,opponents:[{opponent:{name:'Beta'}},{opponent:{name:'Alpha'}}]};
 const now=Date.parse(receipt)+1000;
 assert.deepEqual(verifiedRunningSeriesIdentity('Alpha','Beta',[ps],now),{id:91,startsAt:receipt});
 assert.equal(verifiedRunningSeriesIdentity('Alpha','Beta',[ps,{...ps,id:92}],now),null);
 assert.equal(verifiedRunningSeriesIdentity('Alpha Academy','Beta',[ps],now),null);
 assert.equal(verifiedRunningSeriesIdentity('Alpha','Beta',[{...ps,begin_at:'invalid'}],now),null);
 assert.equal(verifiedRunningSeriesIdentity('Alpha','Beta',[ps],now+24*3600000),null);
});
