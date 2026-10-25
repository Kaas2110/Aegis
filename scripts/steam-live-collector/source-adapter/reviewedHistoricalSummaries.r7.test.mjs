import test from 'node:test';
import assert from 'node:assert/strict';
import {collectReviewedDurationTails,produceReviewedHistoricalSummaries as produce,REVIEWED_HISTORICAL_SUMMARIES_VERSION} from './reviewedHistoricalSummaries.mjs';
import {instantNs} from './causalTime.mjs';

const AT='2026-10-25T10:00:00Z',KNOWN='2026-10-24T10:00:00Z';
const get=(r,name)=>r.values[r.names.indexOf(name)],definition=(r,name)=>r.definitions[r.names.indexOf(name)];
function statistic(value,windowDays=7){return {value,units:'fraction',windowDays,definition:'same_raw_wr_'+windowDays+'d',supportRef:'cohort:test',cohortQualified:true,latestHistoryAvailabilityAt:KNOWN};}
function args(){const profileKeys=['formWinFraction7d','playerHeroWinFraction90d'],players=['radiant','dire'].flatMap(side=>Array.from({length:5},(_,i)=>({side,statistics:{formWinFraction7d:statistic((side==='radiant'?[1,2,3,null,null]:[4,5,null,null,null])[i]),playerHeroWinFraction90d:statistic(i,90)}}))),historyDefinitionNamespace=['radiant','dire'].flatMap(side=>[...Array.from({length:5},(_,i)=>profileKeys.map(key=>`histrel.${side}.slot_${i}.profile.${key}`)).flat(),...[7,30,90].flatMap(w=>['rawWinFraction','smoothedWinFraction','decayedWinFraction','smoothedDecayedWinFraction'].map(op=>`histrel.${side}.team.${w}d.${op}`))]);return {phase:'POST_OR_LIVE',profiles:{players},statistics:{},tailCohorts:[],profileKeys,minimumSupport:3,formulaVersion:'test.formula.v1',historyDefinitionNamespace};}

test('H05/H12 exact finite populations, all25 directed comparisons and population SD have a hand oracle',()=>{
 const r=produce(args()),p='histrel.r7.player_matchup.formWinFraction7d.';
 assert.equal(get(r,'histrel.r7.radiant.player_profile.formWinFraction7d.finiteMemberCount'),3);
 assert.equal(get(r,'histrel.r7.radiant.player_profile.formWinFraction7d.p25'),1.5);
 assert.equal(get(r,'histrel.r7.radiant.player_profile.formWinFraction7d.p50'),2);
 assert.equal(get(r,'histrel.r7.radiant.player_profile.formWinFraction7d.p75'),2.5);
 assert.equal(get(r,p+'availablePairCount'),6);assert.equal(get(r,p+'mean'),-2.5);
 assert.ok(Math.abs(get(r,p+'populationSd')-Math.sqrt(11/12))<1e-14);
 assert.equal(get(r,p+'p25'),-3);assert.equal(get(r,p+'p50'),-2.5);assert.equal(get(r,p+'p75'),-2);
 assert.equal(r.names.filter(n=>n.startsWith(p+'radiant_slot_')).length,25);
 assert.equal(get(r,p+'radiant_slot_0.minus_dire_slot_1'),-4);
 assert.equal(get(r,p+'radiant_slot_4.minus_dire_slot_1'),null);
 const d=definition(r,p+'mean');assert.equal(d.historyWindowDays,7);assert.equal(d.formulaParameters.templateId,REVIEWED_HISTORICAL_SUMMARIES_VERSION);assert.equal(d.semanticVerification,'authoritative_template');assert.equal(d.minimumSupport,3);
});

test('duration tails use inclusive thresholds and exact existing cohort/time support without a future-row repair',()=>{
 const selector={key:'radiant.team',kind:'team',selector:{teamId:'100'},qualified:true},rows=[25,40,80].map((m,i)=>({map:{matchId:String(i+1),ended:instantNs(KNOWN),durationSeconds:m*60},availableAt:KNOWN}));
 const c=collectReviewedDurationTails(rows,{selector,windowDays:7,cutoff:instantNs(AT),minimumSupport:3,supportRef:'team.7d'}),a=args();a.tailCohorts=[c];const r=produce(a);
 assert.equal(get(r,'histrel.r7.tail.radiant.team.7d.ge_25m'),1);assert.equal(get(r,'histrel.r7.tail.radiant.team.7d.ge_30m'),2/3);assert.equal(get(r,'histrel.r7.tail.radiant.team.7d.ge_80m'),1/3);
 const d=definition(r,'histrel.r7.tail.radiant.team.7d.ge_80m');assert.equal(d.historyWindowDays,7);assert.ok(d.inputFields.includes('priorMaps.outcomeKnownAt'));assert.ok(d.inputFields.includes('priorMaps.radiantTeamId'));
 const conditional={...selector,key:'radiant.slot_0.player_hero',kind:'player_hero',selector:{players:[{accountId:'1',heroId:1}],opponents:[{accountId:'6',heroId:6}]}};a.tailCohorts=[collectReviewedDurationTails(rows,{selector:conditional,windowDays:7,cutoff:instantNs(AT),minimumSupport:3,supportRef:'ph.7d'})];const ph=definition(produce(a),'histrel.r7.tail.radiant.slot_0.player_hero.7d.ge_80m');assert.ok(ph.inputFields.includes('priorMaps.players[].heroId'));assert.ok(ph.inputFields.includes('priorMaps.heroesKnownAt'));assert.deepEqual(ph.formulaParameters.selector.opponents,[{accountId:'6',heroId:6}]);
 assert.ok(collectReviewedDurationTails(rows,{selector,windowDays:7,cutoff:instantNs(AT),minimumSupport:5,supportRef:'team.7d'}).values.every(x=>x.value===null));
 assert.throws(()=>collectReviewedDurationTails([...rows,{...rows[0],availableAt:'2026-10-26T00:00:00Z'}],{selector,windowDays:7,cutoff:instantNs(AT),minimumSupport:3}),/duration_cohort_after_cutoff/);
});

test('PRE draft-conditioned counts remain missing; no partial or mismatched-window definition is invented',()=>{
 const a=args();a.phase='PRE';const r=produce(a);assert.equal(get(r,'histrel.r7.radiant.player_profile.playerHeroWinFraction90d.finiteMemberCount'),null);assert.equal(get(r,'histrel.r7.player_matchup.playerHeroWinFraction90d.availablePairCount'),null);
 a.profiles.players[1].statistics.formWinFraction7d.windowDays=30;assert.throws(()=>produce(a),/profile_metric_or_window_mismatch/);
});

test('H02 differences keep raw, Beta, decay and Beta-decay operands distinct',()=>{
 const a=args(),ops=['rawWinFraction','smoothedWinFraction','decayedWinFraction','smoothedDecayedWinFraction'];
 for(const side of ['radiant','dire'])for(const [i,w] of [7,30,90].entries())a.statistics[side+'.team.'+w+'d']=Object.fromEntries(ops.map((op,j)=>[op,statistic(.9-i*.2+j*.01,w)]));
 const r=produce(a);for(const op of ops){assert.ok(Math.abs(get(r,'histrel.r7.radiant.team.form.'+op+'.diff_7d_minus_30d')-.2)<1e-14);const d=definition(r,'histrel.r7.radiant.team.form.'+op+'.diff_7d_minus_30d');assert.equal(d.formulaParameters.sourceOperator,op);assert.deepEqual(d.formulaParameters.windows,[7,30]);}
 a.statistics['radiant.team.7d'].rawWinFraction.cohortQualified=false;assert.equal(get(produce(a),'histrel.r7.radiant.team.form.rawWinFraction.diff_7d_minus_30d'),null);
});
