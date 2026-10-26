import test from 'node:test';
import assert from 'node:assert/strict';
import {coherentFivePlayerDistribution as distribution,produceCoherentEconomyContextFeatures as produce,FORMULA_VERSION,readCoherentEconomyDefinitionPoolStatus} from './coherentEconomyContextFeatures.mjs';
import {draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {advanceSteamFeatureBundle} from './steamFeatureBundle.mjs';
import {legacyCounterpartForDynamicFeature} from './observedDraftFeatureBundle.mjs';
const AT='2026-10-23T12:31:00Z',BEFORE='2026-10-23T11:58:00Z',PROFILE='steam.GetLiveLeagueGames.v1.scoreboard';
function observation({accounts=true,uniform=false,time=AT,clock=600,offset=0}={}){
 const entry=draftEntry({time,clock,accounts,phase:5}),raw=JSON.parse(entry.rawInput.utf8),m=JSON.parse(entry.metadataInput.utf8);
 for(const side of ['radiant','dire'])for(const[pIndex,p]of raw.result.games[0].scoreboard[side].players.entries()){const x=(uniform?3:side==='radiant'?pIndex+1:5-pIndex)+offset;Object.assign(p,{net_worth:x,gold_per_min:10*x,xp_per_min:20*x,gold:0,level:1});}raw.result.games[0].scoreboard.roshan_respawn_timer=0;
 const input=pinned(raw);return normalizeLocalCapture({...m.capture,body:Buffer.from(input.utf8),rawSha256:input.pin.sha256,payloadRef:'journal:'+input.pin.sha256}).observations[0];
}
const qualified=(values)=>({values,statistics:Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value,definition:'synthetic.reviewed.'+k,minimumSupport:5,supportMaps:5,cohortQualified:true,latestHistoryAvailabilityAt:'2026-10-22T00:00:00Z'}]))});
function history(o){
 const context={contract:'aegis.frozen-team-style-context.v3',contentHash:'a'.repeat(64),matchId:o.matchId,historyCutoffAt:BEFORE,validFrom:BEFORE,computedAt:'2026-10-23T12:00:00Z',featurePayload:{players:[],heroes:[],teams:[]}};
 for(const side of ['radiant','dire']){context.featurePayload.teams.push({side,teamId:o.sides[side].teamId,...qualified({teamForm:.6,aggression:1,lateTendency:.4})});for(const p of o.sides[side].players){const x=p.identity;if(x.accountId!==null)context.featurePayload.players.push({accountId:x.accountId,heroId:Number(x.heroId),side,teamId:x.teamId,...qualified({recentForm:.5,heroForm:.25})});context.featurePayload.heroes.push({heroId:Number(x.heroId),side,teamId:x.teamId,...qualified({heroLateTendency:.8})});}}
 const relational={contract:'aegis.historical-relational-features.v1',matchId:o.matchId,originalHistoryContentHash:context.contentHash,historyCutoffAt:BEFORE,validFrom:BEFORE,decisionAt:'2026-10-23T12:00:00Z',profiles:{teams:['radiant','dire'].map(side=>({side,teamId:o.sides[side].teamId,...qualified({meanDurationSeconds90d:200,winMeanDurationSeconds90d:100,late40Fraction90d:.5,meanOwnKillsPerMinute90d:1})}))}};
 return{context,relational};
}
const run=(o,options={})=>{const h=history(o);return produce({observation:o,historyContext:h.context,relationalContext:h.relational,decisionAt:o.source.capture.receivedAt,...options});};
const get=(r,name)=>r.features.find(x=>x.name==='draft_live.coherent_economy.'+name)?.value;
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
test('R7 formula parameters/raw bindings are exact while runtime historical support is not silently pinned',()=>{
 const r=run(observation()),literal=r.features.find(x=>x.name.endsWith('economic_rank.native_gpm.2.radiant.native_value.base')),historical=r.features.find(x=>x.name.endsWith('hero.1.native_nw.minus_opponent_mean.recentForm'));
 assert.equal(literal.definition.formulaParameters.rank,2);assert.equal(literal.definition.formulaParameters.metric,'native_gpm');assert.equal(literal.definition.formulaParameters.variant,'base');assert.ok(literal.definition.inputBindings.some(x=>x.rawField.endsWith('.gold_per_min')));assert.equal(literal.definition.semanticVerification,'authoritative_template');
 assert.equal(historical.definition.formulaParameters.hero,1);assert.equal(historical.definition.semanticVerification,'parameter_binding_required');assert.equal(historical.definition.minimumSupport,null);assert.equal(historical.definition.formulaParameters.historicalOperands[0].definition,'aegis.player_win_fraction_30d.v1');assert.match(historical.definition.formulaParameters.historicalOperands[0].minimumSupportField,/statistics.recentForm.minimumSupport$/);assert.equal(historical.definition.formulaParameters.historicalOperands[0].definitionBindingVerifiedByConsumer,false);assert.equal(historical.value,-1);
});
test('five-player distribution matches hand-calculable [1,2,3,4,5]',()=>{
 const xs=[1,2,3,4,5],d=distribution(xs);assert.deepEqual(xs,[1,2,3,4,5]);close(d.top1_share,1/3);close(d.top2_share,.6);close(d.hhi,11/45);close(d.gini,4/15);close(d.shannon_entropy,-xs.reduce((a,x)=>a+(x/15)*Math.log(x/15),0));assert.equal(d.range,4);
});
test('uniform, zero, negative sentinel and missing are distinct cases',()=>{
 const u=distribution([3,3,3,3,3]);close(u.hhi,.2);close(u.shannon_entropy,Math.log(5));assert.equal(u.gini,0);assert.equal(u.range,0);
 const z=distribution([0,0,0,0,0]);assert.equal(z.range,0);for(const k of ['top1_share','top2_share','hhi','gini','shannon_entropy'])assert.equal(z[k],null);
 assert.equal(distribution([1,2,3,4,null]),null);assert.equal(distribution([1,2,3,4,-1]),null);assert.equal(distribution([1,2,3,4]),null);
});
test('hero comparisons, minute products and frozen form products are hand calculable',()=>{
 const r=run(observation());assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.base'),-2);assert.equal(get(r,'hero.1.native_nw.minus_opponent_max.base'),-4);close(get(r,'hero.1.native_nw.ratio_opponent_mean.base'),1/3);close(get(r,'hero.1.native_nw.opponent_midrank.base'),.1);close(get(r,'hero.1.native_nw.z_vs_opponent.base'),-Math.sqrt(2));close(get(r,'hero.1.native_nw.own_share_minus_opponent_top1.base'),-4/15);
 assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.minute_product'),-20);assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.recentForm'),-1);assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.heroForm'),-.5);close(get(r,'hero.1.native_nw.minus_opponent_mean.opponentHeroLateMean'),-1.6);assert.equal(get(r,'hero.6.native_nw.minus_opponent_mean.base'),-2);
 assert.equal(get(r,'hero.1.native_gpm.minus_opponent_mean.base'),-20);assert.equal(get(r,'hero.1.native_xpm.minus_opponent_mean.base'),-40);
});
test('economic ranks compare observed resources and never imply farm positions',()=>{
 const r=run(observation());assert.equal(get(r,'economic_rank.native_nw.1.radiant.native_value.base'),5);close(get(r,'economic_rank.native_nw.1.radiant.team_share.base'),1/3);assert.equal(get(r,'economic_rank.native_nw.1.radiant.minus_opponent_same_rank.base'),0);assert.equal(get(r,'economic_rank.native_nw.1.radiant.ratio_opponent_same_rank.base'),1);assert.equal(get(r,'economic_rank.native_nw.1.radiant.native_value.recentForm'),2.5);
 assert.ok(r.features.filter(f=>f.name.includes('.economic_rank.')).every(f=>f.definition.formula.includes('economic rank is not farm role')));
});
test('legacy top-share/HHI/rank arithmetic is mapped explicitly without an unconditional alias',()=>{
 const a=legacyCounterpartForDynamicFeature('draft_live.coherent_economy.team.radiant.native_gpm.top1_share.base');assert.equal(a.name,'native_economy.team.radiant.native_gpm.top_share');assert.match(a.relationship,/not unconditional alias/);
 assert.equal(legacyCounterpartForDynamicFeature('draft_live.coherent_economy.economic_rank.native_nw.1.radiant.native_value.base').name,'native_economy.economic_rank.native_nw.1.radiant.native_nw.value');assert.equal(legacyCounterpartForDynamicFeature('draft_live.coherent_economy.economic_rank.native_xpm.1.radiant.native_value.base'),null);
});
test('all player/history array permutations preserve every value and definition',()=>{
 const a=observation({uniform:true}),h=history(a),r=run(a),b=structuredClone(a);for(const side of ['radiant','dire'])b.sides[side].players.reverse();h.context.featurePayload.players.reverse();h.context.featurePayload.heroes.reverse();h.context.featurePayload.teams.reverse();h.relational.profiles.teams.reverse();const other=produce({observation:b,historyContext:h.context,relationalContext:h.relational,decisionAt:AT});assert.deepEqual(other.features,r.features);
});
test('anonymous accounts retain resources and hero/team history while personal history stays missing',()=>{
 const r=run(observation({accounts:false}));assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.base'),-2);assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.recentForm'),null);assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.heroForm'),null);close(get(r,'hero.1.native_nw.minus_opponent_mean.heroLateTendency'),-1.6);assert.equal(r.audit.roleInference,false);assert.equal(r.audit.weightedStrengthScore,false);
});
test('missing operand affects only features that actually need it',()=>{
 const o=observation();o.sides.radiant.players[4].netWorth={missing:true,value:null};const r=run(o);
 assert.equal(get(r,'team.radiant.native_nw.top1_share.base'),null);assert.equal(get(r,'hero.1.native_nw.own_share_minus_opponent_top1.base'),null);assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.base'),-2);assert.equal(get(r,'hero.6.native_nw.minus_opponent_mean.base'),null);assert.equal(get(r,'hero.1.native_gpm.minus_opponent_mean.base'),-20);
});
test('future context, delayed statistics and unsupported cohort cannot repair missing history',()=>{
 const o=observation(),h=history(o);h.context.validFrom='2026-10-23T12:31:00.000000001Z';let r=produce({observation:o,historyContext:h.context,relationalContext:h.relational,decisionAt:AT});assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.recentForm'),null);assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.base'),-2);
 const h2=history(o);h2.context.featurePayload.players[0].statistics.recentForm.latestHistoryAvailabilityAt='2026-10-23T12:00:00Z';h2.context.featurePayload.heroes[0].statistics.heroLateTendency.supportMaps=4;r=produce({observation:o,historyContext:h2.context,relationalContext:h2.relational,decisionAt:AT});assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.recentForm'),null);assert.equal(get(r,'hero.1.native_nw.minus_opponent_mean.heroLateTendency'),null);
});
test('qualified native objective interactions use confirmed evidence; literal zero timer does not qualify',()=>{
 const o=observation(),rules={contract:'aegis.roshan-rules.v1',version:'synthetic.v1',evidenceRef:'synthetic:rules',patch:'synthetic',sourceProfile:PROFILE,knownAt:'2026-10-23T12:00:00Z',respawnMinimumSeconds:480,respawnMaximumSeconds:660,aegisLifetimeSeconds:300,aegisItemId:117};
 const event={matchId:o.matchId,sourceProfile:PROFILE,id:'death',evidenceRef:'synthetic:event',confirmed:true,kind:'roshan_death',gameTimeSeconds:590,knownAt:'2026-10-23T12:30:00Z',side:'radiant'};
 const native=advanceSteamFeatureBundle(null,o,{patch:'synthetic',rules,events:[event]}),r=run(o,{nativeBundle:native});close(get(r,'objective.roshan_elapsed_since_confirmed_death.radiant.native_nw.hhi.base'),10*11/45);close(get(r,'objective.roshan_elapsed_since_confirmed_death.radiant.native_nw.hhi.winMeanDurationSeconds90d'),10*11/45*100);assert.equal(get(r,'objective.roshan_elapsed_since_confirmed_death.hero.1.current_native_nw.base'),10);assert.equal(get(r,'objective.roshan_confirmed_countdown_seconds.radiant.native_nw.hhi.base'),null);
 const noEvidence=run(o,{nativeBundle:advanceSteamFeatureBundle(null,o)});assert.equal(get(noEvidence,'objective.roshan_elapsed_since_confirmed_death.radiant.native_nw.hhi.base'),null);assert.equal(get(noEvidence,'objective.roshan_dead.radiant.native_nw.hhi.base'),null);
});
test('a future or different native frame never supplies objective operands for this observation',()=>{
 const o=observation(),foreign=advanceSteamFeatureBundle(null,observation({time:'2026-10-23T12:33:00Z',clock:720})),r=run(o,{nativeBundle:foreign});assert.equal(r.audit.objectiveObservationBindingAccepted,false);assert.ok(r.features.filter(f=>f.name.includes('.objective.')&&!f.name.includes('.hero.250.')).some(f=>f.value===null));assert.equal(get(r,'team.radiant.native_nw.range.base'),4);
});
test('future processing leaves prior results and recomputed prefix unchanged',()=>{
 const o=observation(),a=run(o),before=structuredClone(a);run(observation({time:'2026-10-23T12:33:00Z',clock:720,offset:1000}));assert.deepEqual(a,before);assert.deepEqual(run(o),before);
});
test('fixed semantic width, explicit formula version, unique names and no helper temporal state',()=>{
 const r=run(observation());assert.equal(r.features.length,38790);assert.equal(new Set(r.features.map(f=>f.name)).size,38790);assert.ok(r.features.every(f=>f.definition.formulaVersion===FORMULA_VERSION&&f.definition.formula&&f.definition.inputScopes.includes('current_live')));assert.equal(r.audit.temporalStateRows,0);assert.equal(r.eligibleForServing,false);assert.equal(r.eligibleForTraining,false);
 const o=observation();o.sides.radiant.players.pop();assert.equal(run(o).status,'blocked');
});
test('helper definition pool shares immutable formulas while recomputing current values',()=>{
 const a=run(observation()),b=run(observation({offset:100}));assert.equal(a.features[0].definition,b.features[0].definition);assert.equal(Object.isFrozen(a.features[0].definition.inputFields),true);assert.throws(()=>{b.features[0].definition.formula='forged';});assert.notEqual(get(a,'team.radiant.native_nw.top1_share.base'),get(b,'team.radiant.native_nw.top1_share.base'));assert.equal(readCoherentEconomyDefinitionPoolStatus().semanticsCount,1);assert.equal(readCoherentEconomyDefinitionPoolStatus().maximumSemantics,1);
});
test('rank selection changes when only another candidate basis value changes, even with unchanged selected scalar',()=>{
 const a=observation(),h=history(a),b=structuredClone(a);
 for(const [hero,form]of [[1,.1],[5,.9]]){const p=h.context.featurePayload.players.find(p=>p.heroId===hero);p.values.recentForm=form;p.statistics.recentForm.value=form;}
 // Hero5 remains5; hero1 rises1->5, so the exact numeric-hero tie chooses hero1.
 // Both selected native values are5 and ALL form/GPM/XPM operands are unchanged.
 b.sides.radiant.players.find(p=>Number(p.identity.heroId)===1).netWorth.value=5;
 const args=o=>({observation:o,historyContext:h.context,relationalContext:h.relational,decisionAt:AT}),before=produce(args(a)),after=produce(args(b)),name='economic_rank.native_nw.1.radiant.native_value.recentForm';
 assert.equal(get(before,'economic_rank.native_nw.1.radiant.native_value.base'),5);assert.equal(get(after,'economic_rank.native_nw.1.radiant.native_value.base'),5);close(get(before,name),4.5);close(get(after,name),.5);
 assert.deepEqual(a.sides.radiant.players.map(p=>p.goldPerMinute),b.sides.radiant.players.map(p=>p.goldPerMinute));assert.deepEqual(a.sides.radiant.players.map(p=>p.experiencePerMinute),b.sides.radiant.players.map(p=>p.experiencePerMinute));
 const d=after.features.find(f=>f.name==='draft_live.coherent_economy.'+name).definition;assert.ok(d.inputFields.includes('sides.players.netWorth'));assert.ok(d.inputFields.includes('sides.players.identity.heroId'));assert.ok(d.inputFields.includes('sides.players.identity.accountId'));
});
test('only a changed clock changes rank minute products while base resources and history stay fixed',()=>{
 const a=observation({clock:600}),b=structuredClone(a);b.providerGameClockSeconds.value=1200;const h=history(a),args=o=>({observation:o,historyContext:h.context,relationalContext:h.relational,decisionAt:AT}),before=produce(args(a)),after=produce(args(b)),name='economic_rank.native_nw.1.radiant.native_value.minute_product';
 assert.deepEqual(a.sides,b.sides);assert.equal(get(before,'economic_rank.native_nw.1.radiant.native_value.base'),5);assert.equal(get(after,'economic_rank.native_nw.1.radiant.native_value.base'),5);assert.equal(get(before,name),50);assert.equal(get(after,name),100);
 const d=after.features.find(f=>f.name==='draft_live.coherent_economy.'+name).definition;assert.ok(d.inputFields.includes('providerGameClockSeconds'));assert.ok(d.inputBindings.some(port=>port.rawField==='result.games[*].scoreboard.duration'));
});
