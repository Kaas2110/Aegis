import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as shared from './e1-features.mjs';
import * as legacy from './fixtures/e1-features.pr11.oracle.ts';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const builders=['buildE1PrematchFeatures','buildE1KillsFeatures','buildE1DurationFeatures','buildE1FbFeatures','buildE1LiveTotalsFeatures'] as const;
function inputs(){
 const rosters:legacy.TeamRostersMap=new Map([[1,[{accountId:11,gamesPlayed:4,wins:2,isCurrent:true},{accountId:12,gamesPlayed:3,wins:1,isCurrent:false}]]]);
 const pool:legacy.TeamHeroPoolMap=new Map([[1,new Map([[1,{games:2,wins:1}],[2,{games:8,wins:6}],[3,{games:0,wins:0}]])]]);
 const totals:legacy.PlayerTotalsMap=new Map([[11,new Map([['gold_per_min',{n:2,sum:1200,avg:600}],['xp_per_min',{n:2,sum:1600,avg:800}],['kills',{n:2,sum:12,avg:6}],['assists',{n:2,sum:16,avg:8}],['deaths',{n:2,sum:0,avg:0}]])],[12,new Map([['gold_per_min',{n:0,sum:0,avg:900}],['xp_per_min',{n:2,sum:800,avg:400}],['kills',{n:2,sum:8,avg:4}],['deaths',{n:2,sum:2,avg:1}]])]]);
 const counts:legacy.PlayerCountsMap=new Map([[11,{laneRoleClarity:.75}],[12,{laneRoleClarity:.5}]]);
 const wlPro:legacy.PlayerWlProMap=new Map([[11,{win:4,lose:0,winrate:1}],[12,{win:3,lose:2,winrate:.6}]]);
 const benchmarks:legacy.HeroBenchmarksMap=new Map([[1,new Map([['kills_per_min',{median:.3,std:.1}],['hero_damage_per_min',{median:900,std:50}]])],[2,new Map([['kills_per_min',{median:.7,std:.2}],['hero_damage_per_min',{median:1200,std:60}]])]]);
 const itemPop:legacy.HeroItemPopularityMap=new Map([[1,{lateShare:.5,earlyAggression:.2}],[2,{lateShare:.1,earlyAggression:.8}]]);
 return {radiantTeamId:1,direTeamId:2,radiantPicks:[1,2,1,999],direPicks:[2,999],radiantAccountIds:[11,12,0,-1,11] as number[]|null|undefined,direAccountIds:undefined as number[]|null|undefined,rosters,pool,totals,counts,wlPro,benchmarks,itemPop};
}
const compare=(args:ReturnType<typeof inputs>)=>{for(const key of builders)assert.deepEqual(shared[key](args),legacy[key](args),key);};

test('legacy oracle is exact pinned PR11 pure source with no DB imports',async()=>{
 const text=await readFile(new URL('./fixtures/e1-features.pr11.oracle.ts',import.meta.url),'utf8');assert.equal(sha(text),'f4bf29b4acbbb78fb14e7ca1281d829bcbdb51bc794406e06801256a71f5ebb1');assert.doesNotMatch(text,/from ['"](?:@workspace\/db|drizzle-orm)/);
 for(const key of Object.keys(legacy) as Array<keyof typeof legacy>)if(typeof legacy[key]!=='function')assert.deepEqual(shared[key],legacy[key],key);
 assert.deepEqual(Object.keys(shared).sort(),Object.keys(legacy).sort());
});

test('prematch preserves ordered slots, repeated IDs, conditional support and neutral defaults',()=>{
 const args=inputs();compare(args);const values=shared.buildE1PrematchFeatures(args);
 assert.equal(values.length,18);assert.equal(values[0],3/5);assert.equal(values[2],2/5);assert.equal(values[7],.5);assert.equal(values[8],600);assert.equal(values[10],2000/3);assert.equal(values[12],32/3);assert.equal(values[14],.6);assert.equal(values[16],2/3);
 assert.deepEqual(shared.buildE1KillsFeatures(args),[.3+.7+.3+.7,900+1200+900+1200]);
 assert.deepEqual(shared.buildE1DurationFeatures(args),[.5+.1+.5,.1,.2+.8+.2,.8]);
});

test('empty/null inputs and unknown heroes retain legacy zeros and .5 defaults',()=>{
 const args=inputs();args.radiantAccountIds=null;args.radiantPicks=[];args.direPicks=[888];args.rosters.clear();args.pool.clear();args.totals.clear();args.counts.clear();args.wlPro.clear();args.benchmarks.clear();args.itemPop.clear();compare(args);
 assert.deepEqual(shared.buildE1PrematchFeatures(args),[0,0,0,0,0,0,.5,.5,0,0,0,0,0,0,.5,.5,0,0]);assert.deepEqual(shared.buildE1LiveTotalsFeatures(args),[0,0]);
});

test('binary64 addition remains radiant-then-dire and does not sort or deduplicate picks',()=>{
 const args=inputs();args.radiantPicks=[1,2];args.direPicks=[3];args.benchmarks=new Map([[1,new Map([['kills_per_min',{median:1e16,std:0}]])],[2,new Map([['kills_per_min',{median:1,std:0}]])],[3,new Map([['kills_per_min',{median:-1e16,std:0}]])]]);compare(args);assert.equal(shared.buildE1KillsFeatures(args)[0],0);
 args.radiantPicks=[1,3];args.direPicks=[2];compare(args);assert.equal(shared.buildE1KillsFeatures(args)[0],1);
});

test('side orientation preserves pair slots and asymmetric map inputs',()=>{
 const args=inputs(),before=shared.buildE1PrematchFeatures(args),swapped={...args,radiantTeamId:args.direTeamId,direTeamId:args.radiantTeamId,radiantPicks:args.direPicks,direPicks:args.radiantPicks,radiantAccountIds:args.direAccountIds,direAccountIds:args.radiantAccountIds};compare(swapped);const after=shared.buildE1PrematchFeatures(swapped);for(let i=0;i<before.length;i+=2){assert.equal(after[i],before[i+1]);assert.equal(after[i+1],before[i]);}
});

test('deterministic mixed cohorts preserve every previous builder exactly',()=>{
 let seed=23;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 for(let sample=0;sample<80;sample++){
  const args=inputs();args.radiantPicks=Array.from({length:5},()=>1+Math.floor(next()*5));args.direPicks=Array.from({length:5},()=>1+Math.floor(next()*5));args.radiantAccountIds=Array.from({length:5},()=>10+Math.floor(next()*5));args.direAccountIds=Array.from({length:5},()=>10+Math.floor(next()*5));
  for(let hero=1;hero<=5;hero++){if(next()>.25)args.benchmarks.set(hero,new Map([['kills_per_min',{median:next(),std:next()}],['hero_damage_per_min',{median:next()*2000,std:next()}]]));if(next()>.25)args.itemPop.set(hero,{lateShare:next(),earlyAggression:next()});}
  compare(args);
 }
});

test('compatibility wrappers retain exact old DB loader bodies and resolve one pure module',async()=>{
 const paths=['../../scripts/src/lib/e1-features.ts','../../artifacts/api-server/src/lib/e1-features.ts'];
 for(const path of paths){const url=new URL(path,import.meta.url),text=await readFile(url,'utf8'),body=text.slice(text.indexOf('export async function loadTeamRostersMap')).trimEnd();assert.equal(sha(body),'f90ffc3db342a43fdb1fcf93f3e957e4e7077d28ff7832727dc2184382e86ce1');const match=text.match(/export \* from '([^']+)';/);assert.ok(match);assert.equal(new URL(match[1],url).href,new URL('./e1-features.mjs',import.meta.url).href);}
});
