import test from 'node:test';
import assert from 'node:assert/strict';
import {produceHistoricalRelationalFeatures,producePrematchHistoricalRelationalFeatures,validateHistoricalRelationalFeatures,HISTORICAL_PLAYER_PROFILE_KEYS,HISTORICAL_TEAM_PROFILE_KEYS,HISTORICAL_HERO_PROFILE_KEYS,historicalRelationalHash} from './historicalRelationalFeatures.mjs';
import {draftArgs,pinned} from './observedDraftHistory.fixtures.mjs';
import {produceObservedDraftHistory} from './observedDraftHistory.mjs';
import {PERFORMANCE_CONTRACT,PERFORMANCE_FIELDS} from './historicalPerformanceFields.mjs';

function fixture({mutateFacts=null,mutateArgs=null,accounts=true,minimumSupport=3}={}){
 const args=draftArgs({accounts});
 const facts=JSON.parse(args.factsInput.utf8);
 // Synthetic explicit side/hero facts remain meaningful without public accounts.
 for(const m of facts.maps){m.heroes=m.players.map(p=>({heroId:p.heroId,side:p.side}));m.heroesKnownAt=m.playersKnownAt;}
 if(mutateFacts)mutateFacts(facts);
 if(facts.scope)facts.scope.rowCount=facts.maps.length;
 args.factsInput=pinned(facts);
 if(mutateArgs)mutateArgs(args);
 const produced=produceObservedDraftHistory({...args,minimumSupport});
 assert.ok(produced.context,produced.reason);
 const input={historyContext:produced.context,factsInput:args.factsInput,matchId:args.matchId,decisionAt:args.computedAt,minimumSupport};
 return{args,facts,input,component:produceHistoricalRelationalFeatures(input)};
}
const value=(x,name)=>{const i=x.names.indexOf(name);assert.notEqual(i,-1,name);return x.values[i];};
const stat=(x,key)=>x.profiles.players[0].statistics[key];

test('hand-checkable raw/smoothed rates, duration, kills, effective count and support',()=>{
 const {component:c}=fixture();
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.supportMaps'),5);
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.rawWinFraction'),3/5);
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.smoothedWinFraction'),13/25);
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.meanDurationSeconds'),2520);
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.durationP25Seconds'),2460);
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.durationP75Seconds'),2580);
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.durationSampleSdSeconds'),Math.sqrt(9000));
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.meanTotalKills'),54);
 assert.equal(c.profiles.teams[0].values.meanOwnKillsPerMinute90d,(30/40+31/41+32/42+33/43+34/44)/5);
 const e=value(c,'histrel.radiant.slot_0.player.90d.effectiveCount');assert.ok(e>4.9&&e<=5);
 assert.equal(c.profiles.players[0].values.playerHeroVsSelfWinFraction90d,0);
 assert.equal(c.profiles.teams[0].values.winMeanDurationSeconds90d,2520);
 assert.equal(c.profiles.teams[0].values.lossMeanDurationSeconds90d,null); // only two losses, below support=3
});

test('all ordered descriptors and masked values have stable semantic metadata',()=>{
 const {component:c}=fixture();
 assert.ok(c.names.length>20000);
 assert.equal(new Set(c.names).size,c.names.length);
 assert.equal(c.definitions.length,c.names.length);
 c.definitions.forEach((d,i)=>{assert.equal(d.name,c.names[i]);assert.ok(d.familyId&&d.formula&&d.formulaVersion&&d.units);assert.equal(d.inputScopes[0],'prior_completed_maps');assert.ok(['current_identity','current_draft'].includes(d.inputScopes[1]));assert.equal(c.masks[i],Number(c.values[i]===null));});
 assert.equal(c.eligibleForServing,false);assert.equal(c.eligibleForTraining,false);assert.equal(c.recordedPrediction,false);
 assert.ok(c.pendingFamilies.some(p=>p.familyId==='H08'));
 assert.ok(c.familyCoverage.every(p=>p.notWholeFamily===true));
 assert.equal(c.definitions.find(d=>d.name==='histrel.radiant.player_profile.formWinFraction7d.mean').historyWindowDays,7);
 assert.equal(c.definitions.find(d=>d.name==='histrel.radiant.slot_0.profile.formWinFraction7d').familyId,'H05');
});

test('schema and feature order are stable under prior-map and raw-player permutation',()=>{
 const a=fixture().component,b=fixture({mutateFacts:f=>{f.maps.reverse();for(const m of f.maps){m.players.reverse();m.heroes.reverse();}}}).component;
 assert.deepEqual(b.names,a.names);assert.deepEqual(b.values,a.values);assert.deepEqual(b.masks,a.masks);assert.equal(b.schemaHash,a.schemaHash);
 assert.notEqual(b.factsSha256,a.factsSha256);
});

test('future +1ns outcome is excluded without changing any past numeric value',()=>{
 const a=fixture().component,b=fixture({mutateFacts:f=>{const m=structuredClone(f.maps[0]);m.matchId='888';m.outcomeKnownAt='2026-10-23T11:58:00.000000001Z';m.playersKnownAt=m.outcomeKnownAt;m.heroesKnownAt=m.outcomeKnownAt;f.maps.push(m);}}).component;
 assert.deepEqual(b.values,a.values);assert.equal(b.schemaHash,a.schemaHash);assert.equal(b.audit.futureOutcomeExcluded,1);
});

test('facts available exactly at t0 are eligible, +1ns roster is not',()=>{
 const a=fixture({mutateFacts:f=>{for(const m of f.maps){m.playersKnownAt='2026-10-23T11:58:00Z';m.heroesKnownAt=m.playersKnownAt;}}}).component;
 const b=fixture({mutateFacts:f=>{for(const m of f.maps)m.playersKnownAt='2026-10-23T11:58:00.000000001Z';}}).component;
 assert.equal(value(a,'histrel.radiant.slot_0.player.90d.supportMaps'),5);
 assert.equal(value(b,'histrel.radiant.slot_0.player.90d.supportMaps'),0);
 assert.equal(value(b,'histrel.radiant.slot_0.player.90d.rawWinFraction'),null);
 assert.equal(value(b,'histrel.radiant.slot_0.hero.90d.rawWinFraction'),3/5);
});

test('unknown current accounts leave personal history missing but hero/team history valid',()=>{
 const c=fixture({accounts:false}).component;
 assert.equal(c.profiles.players.length,10);assert.equal(c.profiles.players[0].accountId,null);
 assert.equal(c.profiles.players[0].values.formWinFraction90d,null);
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.supportMaps'),null);
 assert.equal(c.profiles.heroes[0].values.formWinFraction90d,3/5);
 assert.equal(c.profiles.teams[0].values.formWinFraction90d,3/5);
});

test('anonymous prior players do not erase known hero-population history',()=>{
 const c=fixture({mutateFacts:f=>{for(const m of f.maps)m.players=[];}}).component;
 assert.equal(c.profiles.players[0].values.formWinFraction90d,null);
 assert.equal(c.profiles.heroes[0].values.formWinFraction90d,3/5);
 assert.equal(value(c,'histrel.radiant.pair_0_1.hero_pair.90d.supportMaps'),5);
 assert.equal(value(c,'histrel.radiant.pair_0_1.ally_players.90d.supportMaps'),0);
});

test('ally players, exact player-hero pair and ally-hero triplet use different cohorts',()=>{
 const c=fixture({mutateFacts:f=>{
  const p=f.maps[0].players.find(p=>p.accountId==='2');p.heroId=12;
  f.maps[0].heroes=f.maps[0].players.map(p=>({heroId:p.heroId,side:p.side}));
 }}).component;
 assert.equal(value(c,'histrel.radiant.pair_0_1.ally_players.90d.supportMaps'),5);
 assert.equal(value(c,'histrel.radiant.pair_0_1.exact_player_hero_pair.90d.supportMaps'),4);
 assert.equal(value(c,'histrel.radiant.pair_0_1.a.player_hero_ally_player.90d.supportMaps'),5);
 assert.equal(value(c,'histrel.radiant.pair_0_1.a.player_hero_ally_hero.90d.supportMaps'),4);
 assert.equal(value(c,'histrel.radiant.triple_0_1_2.hero_triple.90d.supportMaps'),4);
 assert.equal(value(c,'histrel.radiant.triple_0_1_2.exact_player_hero_triple.90d.supportMaps'),4);
});

test('counter cohorts require opponents on opposite sides, not same-map co-occurrence',()=>{
 const c=fixture({mutateFacts:f=>{
  const m=f.maps[0],a=m.players.find(p=>p.heroId===2),b=m.players.find(p=>p.heroId===6);a.side='dire';b.side='radiant';m.heroes=m.players.map(p=>({heroId:p.heroId,side:p.side}));
 }}).component;
 assert.equal(value(c,'histrel.counter_0_0.heroes.90d.supportMaps'),4);
 assert.equal(value(c,'histrel.counter_0_0.players.90d.supportMaps'),4);
 assert.equal(value(c,'histrel.counter_0_1.heroes.90d.supportMaps'),5);
});

test('missing kills do not invent zero kills or alter outcome support',()=>{
 const c=fixture({mutateFacts:f=>{f.maps[0].radiantKills=null;f.maps[1].direKills=null;}}).component;
 assert.equal(value(c,'histrel.radiant.team.90d.supportMaps'),5);
 assert.equal(value(c,'histrel.radiant.team.90d.meanTotalKills'),56);
 assert.equal(c.profiles.teams[0].statistics.meanTotalKills90d.supportMaps,3);
 assert.equal(c.profiles.teams[0].statistics.meanOwnKillsPerMinute90d.supportMaps,4);
});

test('low support masks rates/distributions while preserving observed support and uncertainty',()=>{
 const c=fixture({minimumSupport:6}).component;
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.supportMaps'),5);
 assert.equal(value(c,'histrel.radiant.slot_0.player.90d.rawWinFraction'),null);
 assert.equal(stat(c,'formWinFraction90d').reason,'below_minimum_support');
 assert.ok(value(c,'histrel.radiant.slot_0.player.90d.effectiveCount')>0);
});

test('incomplete or mismatched selector scope cannot masquerade as full player history',()=>{
 const a=fixture({mutateFacts:f=>{f.scope.targetAccountIds=['9'];}}).component;
 assert.equal(a.profiles.players[0].values.formWinFraction90d,null);
 assert.equal(a.profiles.heroes[0].values.formWinFraction90d,3/5);
 const b=fixture({mutateFacts:f=>{f.scope.truncated=true;}}).component;
 assert.equal(b.profiles.teams[0].values.formWinFraction90d,null);
 assert.ok(b.profiles.players.every(p=>Object.values(p.values).every(v=>v===null)));
});

test('current map and duplicate prior-map rows are blocked',()=>{
 assert.throws(()=>fixture({mutateFacts:f=>f.maps.push({...f.maps[0],matchId:'90001'})}),/current_map/);
 assert.throws(()=>fixture({mutateFacts:f=>f.maps.push(structuredClone(f.maps[0]))}),/duplicate_map/);
});

test('actual facts bytes must match the context pin and hash corruption is rejected',()=>{
 const {input}=fixture();const other=JSON.parse(input.factsInput.utf8);other.maps[0].durationSeconds=9999;
 assert.throws(()=>produceHistoricalRelationalFeatures({...input,factsInput:pinned(other)}),/facts_context_binding/);
 const corrupt=structuredClone(input.factsInput);corrupt.utf8=corrupt.utf8.replace('2400','2401');assert.throws(()=>produceHistoricalRelationalFeatures({...input,factsInput:corrupt}),/input_pin/);
 const context=structuredClone(input.historyContext);context.featurePayload.players[0].values.recentForm=1;
 assert.throws(()=>produceHistoricalRelationalFeatures({...input,historyContext:context}),/content_hash/);
});

test('all profile-key exports have a statistic with exact numeric value and units',()=>{
 const c=fixture().component;
 for(const [collection,keys]of [['players',HISTORICAL_PLAYER_PROFILE_KEYS],['teams',HISTORICAL_TEAM_PROFILE_KEYS],['heroes',HISTORICAL_HERO_PROFILE_KEYS]])for(const p of c.profiles[collection]){
  assert.deepEqual(Object.keys(p.values).sort(),[...keys].sort());
  for(const key of keys){const s=p.statistics[key];assert.equal(s.value,p.values[key]);assert.ok(s.definition&&s.units&&s.minimumSupport===3);assert.ok(Number.isInteger(s.supportMaps));}
 }
});

test('semantic validator verifies integrity but explicitly does not authenticate receipts',()=>{
 const {input,component:c}=fixture();const result=validateHistoricalRelationalFeatures(c,{matchId:input.matchId,decisionAt:input.decisionAt,historyContext:input.historyContext});
 assert.equal(result.accepted,true);assert.match(result.reason,/not_receipt/);
 const bad=structuredClone(c);bad.values[0]=13;assert.equal(validateHistoricalRelationalFeatures(bad,{matchId:input.matchId,decisionAt:input.decisionAt}).accepted,false);
 const rehashed=structuredClone(c);rehashed.masks[0]=1;const {contentHash,...body}=rehashed;rehashed.contentHash=historicalRelationalHash(body);
 assert.equal(validateHistoricalRelationalFeatures(rehashed,{matchId:input.matchId,decisionAt:input.decisionAt}).reason,'relational_component_vector');
 const changed=structuredClone(c);changed.definitions[0].units='invented';const {contentHash:ignored,...changedBody}=changed;changed.contentHash=historicalRelationalHash(changedBody);
 assert.equal(validateHistoricalRelationalFeatures(changed,{matchId:input.matchId,decisionAt:input.decisionAt}).reason,'relational_component_schema_hash');
 const future=structuredClone(c);future.definitions[0].knownAt='2026-10-23T11:58:00.000000001Z';const {contentHash:ignore2,...futureBody}=future;future.contentHash=historicalRelationalHash(futureBody);
 assert.equal(validateHistoricalRelationalFeatures(future,{matchId:input.matchId,decisionAt:input.decisionAt}).reason,'relational_component_descriptor_or_future');
});

function addPerformance(f){
 for(const [i,m]of f.maps.entries())m.heroPerformances=m.heroes.map(h=>({contract:PERFORMANCE_CONTRACT,sourceProfile:'opendota.completed-map.parsed-player',sourceFields:PERFORMANCE_FIELDS,accountId:m.players.find(p=>p.heroId===h.heroId)?.accountId??null,heroId:h.heroId,side:h.side,knownAt:m.playersKnownAt,metrics:{gpm:400+i*10+h.heroId,xpm:500+i*10+h.heroId,kills:10+i,deaths:2,assists:10,lastHits:200,denies:10,heroDamage:20000+i*1000,towerDamage:4000,heroHealing:1000,level:25,netWorth:15000+i*1000,goldSpent:null,totalGold:22000,totalXp:30000,observerWardsPlaced:5,sentryWardsPlaced:8,observerWardsKilled:3,sentryWardsKilled:2}}));
}

function retainedPrematch({mutate=null}={}){
 const args=draftArgs({accounts:true}),facts=JSON.parse(args.factsInput.utf8),cutoff='2026-10-23T11:58:00Z';
 for(const m of facts.maps){m.heroes=m.players.map(p=>({heroId:p.heroId,side:p.side}));m.heroesKnownAt=m.playersKnownAt;}
 addPerformance(facts);
 facts.scope={contract:'aegis.retained-history-selection-scope.v1',sourceUniverse:'locally_retained_opendota_responses',selection:'provided_version_inputs_only',asOf:cutoff,completeWithinProvidedInputs:true,globalPopulationComplete:false,truncated:false,rowCount:facts.maps.length};
 for(const m of facts.maps){
  m.availabilityBasis='retained_collector_response_receipt';m.sourceVersionSetSha256='a'.repeat(64);
  for(const p of m.heroPerformances){p.sourceProfile='opendota.completed-map.retained-response-player';p.availabilityBasis='retained_collector_response_receipt';p.metricAvailability={};p.metricSources={};for(const [key,value]of Object.entries(p.metrics))if(value!==null){p.metricAvailability[key]=p.knownAt;p.metricSources[key]='a'.repeat(64);}}
 }
 if(mutate)mutate(facts);
 const targetInput=pinned({contract:'aegis.prematch-history-target.v1',matchId:args.matchId,knownAt:cutoff,historyCutoffAt:cutoff,teams:{radiant:'100',dire:'200'},players:[]});
 // Team historical metrics remain meaningful without invented current heroes.
 return producePrematchHistoricalRelationalFeatures({targetInput,factsInput:pinned(facts),decisionAt:'2026-10-23T12:30:00Z',minimumSupport:3});
}

test('retained native performance is admitted only with explicit bounded scope and source provenance',()=>{
 const c=retainedPrematch();
 assert.equal(c.audit.populationBasis,'bounded_provided_retained_corpus_not_global');
 assert.equal(c.profiles.teams[0].values.meanPast_gpm90d,423);
 assert.throws(()=>retainedPrematch({mutate:f=>{f.scope.sourceUniverse='local_pro_matches_join_match_parsed';}}),/performance_identity_or_source_contract/);
 assert.throws(()=>retainedPrematch({mutate:f=>{delete f.maps[0].sourceVersionSetSha256;}}),/performance_identity_or_source_contract/);
 assert.throws(()=>retainedPrematch({mutate:f=>{f.maps[0].heroPerformances[0].sourceProfile='unreviewed-profile';}}),/performance_identity_or_source_contract/);
 assert.throws(()=>retainedPrematch({mutate:f=>{f.maps[0].heroPerformances[0].metricSources.gpm='not-a-pin';}}),/retained_performance_provenance/);
});

test('retained future performance remains missing and cannot borrow earlier field timestamps',()=>{
 const c=retainedPrematch({mutate:f=>{for(const m of f.maps)m.heroPerformances[0].knownAt='2026-10-23T11:58:00.000000001Z';}});
 assert.equal(c.profiles.teams[0].values.meanPast_gpm90d,null);assert.equal(c.audit.unavailablePerformanceRows,5);
 assert.throws(()=>retainedPrematch({mutate:f=>{f.maps[0].heroPerformances[0].metricAvailability.gpm='2026-10-23T11:58:00.000000001Z';}}),/retained_performance_provenance/);
});

test('native prior-player scalar means, hero normalization and efficiency are distinct',()=>{
 const c=fixture({mutateFacts:addPerformance}).component;
 assert.equal(c.profiles.players[0].values.playerMeanPast_gpm90d,421);
 assert.equal(c.profiles.players[0].values.playerHeroMeanPast_gpm90d,421);
 assert.equal(c.profiles.players[0].values.heroMeanPast_gpm90d,421);
 assert.equal(c.profiles.players[0].values.playerHeroVsSelfPast_gpm90d,0);
 assert.equal(c.profiles.players[0].values.playerHeroPopulationZPast_gpm90d,0);
 assert.equal(c.profiles.players[0].values.playerMeanPast_netWorth90d,17000);
 assert.equal(c.profiles.players[0].values.playerMeanPast_totalGold90d,22000);
 assert.notEqual(c.profiles.players[0].values.playerMeanPast_gpm90d,c.profiles.players[0].values.playerMeanPast_netWorth90d/(2520/60));
 assert.equal(c.profiles.players[0].values.playerMeanPast_goldSpent90d,null);
 assert.equal(c.profiles.players[0].values.playerMeanPast_kda90d,11);
 assert.equal(c.profiles.teams[0].values.meanPast_gpm90d,423);
 assert.ok(c.profiles.players[0].values.playerMeanPast_heroDamagePerGpm90d>1);
});

test('hero population includes anonymous players while personal metrics stay missing',()=>{
 const c=fixture({mutateFacts:f=>{addPerformance(f);for(const m of f.maps){m.players=[];for(const p of m.heroPerformances)p.accountId=null;}}}).component;
 assert.equal(c.profiles.heroes[0].values.meanPast_gpm90d,421);
 assert.equal(c.profiles.players[0].values.playerMeanPast_gpm90d,null);
 assert.equal(c.profiles.teams[0].values.meanPast_gpm90d,423);
});

test('player-hero performance is compared with a broader population across other players',()=>{
 const c=fixture({mutateFacts:f=>{
  addPerformance(f);const extra=f.maps.map(m=>{const x=structuredClone(m);x.matchId=String(Number(x.matchId)+1000);x.players=x.players.filter(p=>p.heroId!==1);const p=x.heroPerformances.find(p=>p.heroId===1);p.accountId=null;p.metrics.gpm+=400;return x;});f.maps.push(...extra);
 }}).component;
 assert.equal(c.profiles.players[0].values.playerHeroMeanPast_gpm90d,421);
 assert.equal(c.profiles.players[0].values.heroMeanPast_gpm90d,621);
 assert.equal(c.profiles.players[0].values.playerHeroVsPopulationPast_gpm90d,-200);
 assert.equal(c.profiles.players[0].statistics.heroMeanPast_gpm90d.supportMaps,10);
 assert.equal(c.profiles.players[0].statistics.playerHeroMeanPast_gpm90d.supportMaps,5);
 assert.ok(c.profiles.players[0].values.playerHeroPopulationZPast_gpm90d<0);
 const ref=c.profiles.players[0].statistics.heroMeanPast_gpm90d.supportRef;
 assert.equal(c.supportRows[c.support[ref].sourceRowsRef].supportMaps,10);
});

test('native metric time +1ns, zero and unknown have different meanings',()=>{
 const c=fixture({mutateFacts:f=>{addPerformance(f);for(const m of f.maps){m.heroPerformances.find(p=>p.heroId===1).knownAt='2026-10-23T11:58:00.000000001Z';m.heroPerformances.find(p=>p.heroId===2).metrics.heroHealing=0;}}}).component;
 assert.equal(c.profiles.players[0].values.playerMeanPast_gpm90d,null);
 assert.equal(c.profiles.players[1].values.playerMeanPast_heroHealing90d,0);
 assert.equal(c.profiles.players[1].values.playerMeanPast_goldSpent90d,null);
 assert.equal(c.profiles.teams[0].values.meanPast_gpm90d,null); // five-player team mean cannot silently become four-player
 assert.equal(c.audit.unavailablePerformanceRows,5);
});

test('performance identity conflicts and numeric strings are blocked',()=>{
 assert.throws(()=>fixture({mutateFacts:f=>{addPerformance(f);f.maps[0].heroPerformances[0].accountId='99';}}),/performance_account_conflict/);
 assert.throws(()=>fixture({mutateFacts:f=>{addPerformance(f);f.maps[0].heroPerformances[0].metrics.gpm='800';}}),/performance_native_metric/);
 assert.throws(()=>fixture({mutateFacts:f=>{addPerformance(f);f.maps[0].heroPerformances.push(structuredClone(f.maps[0].heroPerformances[0]));}}),/performance_bound/);
});

function prematchFixture({mutateTarget=null,mutateFacts=null}={}){
 const base=fixture({mutateFacts}),target={contract:'aegis.prematch-history-target.v1',matchId:'90001',knownAt:'2026-10-23T11:58:00Z',historyCutoffAt:'2026-10-23T11:58:00Z',teams:{radiant:'100',dire:'200'},players:base.input.historyContext.draftState.identity.players.map(p=>({...p,heroId:null}))};
 if(mutateTarget)mutateTarget(target);
 const args={targetInput:pinned(target),factsInput:base.input.factsInput,decisionAt:'2026-10-23T12:30:00Z',minimumSupport:3};
 return{args,target,component:producePrematchHistoricalRelationalFeatures(args)};
}

test('PRE uses overall historical players/teams/allies and no current draft',()=>{
 const c=prematchFixture({mutateFacts:addPerformance}).component;
 assert.equal(c.phase,'PRE');assert.equal(c.originalHistoryContentHash,null);assert.equal(c.prematchTargetBinding.contract,'aegis.prematch-history-target.v1');
 assert.equal(c.profiles.players[0].heroId,null);
 assert.equal(c.profiles.players[0].values.formWinFraction90d,3/5);
 assert.equal(c.profiles.players[0].values.playerMeanPast_gpm90d,421);
 assert.equal(value(c,'histrel.radiant.pair_0_1.ally_players.90d.rawWinFraction'),3/5);
 for(const [i,d]of c.definitions.entries())if(d.inputScopes.includes('current_draft')){assert.equal(c.values[i],null,d.name);assert.equal(c.masks[i],1,d.name);}
 assert.match(c.availabilityBasis,/not_authenticated/);
});

test('PRE rejects actual current heroes, draft fields, future identities and duplicate accounts',()=>{
 assert.throws(()=>prematchFixture({mutateTarget:t=>t.players[0].heroId=1}),/current_hero_forbidden/);
 assert.throws(()=>prematchFixture({mutateTarget:t=>t.currentDraft={}}),/target_contract/);
 assert.throws(()=>prematchFixture({mutateTarget:t=>t.knownAt='2026-10-23T12:30:00.000000001Z'}),/target_times/);
 assert.throws(()=>prematchFixture({mutateTarget:t=>t.players[1].accountId=t.players[0].accountId}),/duplicate/);
});

test('PRE partial/anonymous roster keeps team form and stable sorting after player reorder',()=>{
 const a=prematchFixture({mutateTarget:t=>t.players=t.players.filter(p=>['1','6'].includes(p.accountId))}).component;
 assert.equal(a.profiles.players.length,10);assert.equal(a.profiles.players[0].accountId,'1');assert.equal(a.profiles.players[1].accountId,null);
 assert.equal(a.profiles.teams[0].values.formWinFraction90d,3/5);
 const b=prematchFixture({mutateTarget:t=>t.players.reverse()}).component,c=prematchFixture().component;
 assert.deepEqual(b.values,c.values);assert.equal(b.schemaHash,c.schemaHash);
});

test('support evidence is shared without removing exact map/time provenance',()=>{
 const c=fixture({mutateFacts:addPerformance}).component;
 assert.ok(Object.keys(c.support).length>1000);assert.ok(Object.keys(c.supportRows).length<10);
 for(const s of Object.values(c.support)){const rows=c.supportRows[s.sourceRowsRef];assert.ok(rows);assert.equal(rows.supportMaps,s.supportMaps);assert.equal(rows.mapIds.length,s.supportMaps);assert.equal(rows.availability.length,s.supportMaps);}
});
