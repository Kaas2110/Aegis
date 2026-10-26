/** Synthetic technical counterexamples only; no provider, fitted model or
 * source-coverage evidence. Root executes under its owned bounded guard. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {bindObservedDynamicSemantics as bind,historicalStatisticRef} from './dynamicSemanticBindings.mjs';
import {bindHistoricalRelationalSemantics as bindHistorical} from './historicalSemanticBindings.mjs';
import {produceFrozenPlayerContext} from './frozenPlayerContext.mjs';
import {fixture,args} from './frozenPlayerContext.fixtures.mjs';
import {NATIVE_LEVEL_REFERENCE_DEFINITION} from './historyCalculationCore.mjs';
import {produceChronologicalResultRatings} from './chronologicalResultRatings.mjs';
import {produceCausalDraftStyleFit} from './causalDraftStyleFit.mjs';
const statistic=(windowDays,definition='test/rawWinFraction')=>({definition,units:'fraction',windowDays,minimumSupport:5});
const environment=()=>({context:{producer:{minimumSupport:5},featurePayload:{players:[{statistics:{formWinFraction30d:statistic(30),recentForm:statistic(30)}}],heroes:[{statistics:{formWinFraction30d:statistic(30)}}],teams:[]}},relational:{profiles:{players:[{side:'radiant',statistics:{formWinFraction30d:statistic(30)}}],heroes:[],teams:[{side:'radiant',statistics:{formWinFraction30d:statistic(30),formWinFraction7d:statistic(7)}}]}}});
const definition=ref=>({inputFields:['nw_sum_diff','retained causal native prefix','providerGameClockSeconds'],historyDefinitions:[ref.key],historicalStatisticRefs:[ref],inputScopes:['current_live','prior_maps'],formulaParameters:{historyKey:ref.key,side:'radiant'}});
test('typed exact team statistic resolves despite same generic template in other populations/windows',()=>{
 const ref=historicalStatisticRef({profileKind:'team',key:'formWinFraction30d',side:'radiant',windowDays:30}),r=bind(definition(ref),environment());
 assert.equal(r.semanticVerification,'authoritative_template');
 const h=r.formulaParameters.historyOperands[0];assert.equal(h.reference.profileKind,'team');assert.equal(h.reference.selector.side,'radiant');assert.equal(h.windowDays,30);
 assert.ok(r.inputBindings.some(p=>p.normalizedField==='relational.teams[selector].statistics.formWinFraction30d'));
 assert.ok(r.dependencyRefs.some(r=>r.kind==='input'&&r.port.selector?.side==='radiant'));
});
test('wrong exact window and template-as-operand never repair an unresolved reference',()=>{
 const ref=historicalStatisticRef({profileKind:'team',key:'formWinFraction30d',side:'radiant',windowDays:7});assert.equal(bind(definition(ref),environment()).semanticVerification,'parameter_binding_required');
 const d={inputFields:['goldPerMinute'],historyDefinitions:['test/rawWinFraction'],inputScopes:['current_live','prior_maps']},r=bind(d,environment());assert.equal(r.semanticVerification,'parameter_binding_required');assert.ok(r.formulaParameters.unboundInputFields.includes('test/rawWinFraction'));
});
test('opaque raw native fields and mechanics remain unqualified after literal transforms',()=>{
 for(const field of ['gold','players.netGoldRaw','players.dynamic.ultimateCooldown','players.dynamic.respawnTimer','players.dynamic.positionX','players.dynamic.hasBuyback']){
  const r=bind({inputFields:[field],inputScopes:['current_live'],formulaParameters:{operator:'literal_product'}},environment());
  assert.equal(r.semanticVerification,'unverified_native_semantics',field);assert.equal(r.sourceMeaningStatus,'opaque_provider');assert.equal(r.candidateDisposition,'diagnostic_only_unqualified_source');assert.equal(r.modelEligibility,'ineligible');
 }
});
test('real literal prior level producer preserves cohort/support/clock/sample scale and never reads final level',()=>{
 const f=fixture();for(const [index,o]of f.native.observations.entries())for(const side of Object.values(o.sides))for(const p of side.players)p.level={missing:false,value:10+index,sourceField:'level'};
 for(const map of f.facts.maps)for(const p of map.players)p.level=30;
 const refs=produceFrozenPlayerContext(args(f)).context.featurePayload.heroMinuteReferences,level=refs.find(r=>r.heroId===1&&r.metric==='native_level');
 assert.equal(level.mean,12);assert.equal(level.scale,Math.sqrt(2.5));assert.equal(level.supportMaps,5);assert.equal(level.minute,15);assert.equal(level.units,'level');assert.equal(level.metricSourceField,'level');assert.equal(level.definition,NATIVE_LEVEL_REFERENCE_DEFINITION);assert.equal(level.latestHistoryAvailabilityAt,'2026-10-21T14:03:00Z');
 f.native.observations[0].sides.radiant.players[0].level.sourceField='final_level';assert.ok(!produceFrozenPlayerContext(args(f)).context.featurePayload.heroMinuteReferences.some(r=>r.heroId===1&&r.metric==='native_level'));
});
test('historical raw selector IDs change row binding while stable selector grammar stays equal',()=>{
 const make=teamId=>bindHistorical({name:'test',supportRef:'c',knownAt:'2026-10-20T00:00:00Z',minimumSupport:5,historyWindowDays:30,formulaParameters:{inputClass:'outcome',operator:'rawWinFraction',selector:{teamId},selectorKind:'team'}},{minimumSupport:5,selectorBindings:{s:{kind:'team',teamId}},support:{c:{selectorRef:'s'}},performanceDefinitions:{},formulaVersion:'test.v1'}),a=make('100'),b=make('200');
 assert.deepEqual(a.parameterClassification.functionParameters,b.parameterClassification.functionParameters);assert.notDeepEqual(a.parameterClassification.rowParameters,b.parameterClassification.rowParameters);assert.deepEqual(a.parameterClassification.classifiedKeys.sort(),Object.keys(a.formulaParameters).sort());assert.deepEqual(a.rowInstanceFieldNames,[]);assert.equal(a.formulaParameters.selector.teamId,'100');
});
test('derived historical profile requires exact emitted edges and rejects generic formula identities',()=>{
 const env={minimumSupport:5,selectorBindings:{},support:{},performanceDefinitions:{},formulaVersion:'test.v1'},d={name:'test.profile',minimumSupport:5,historyWindowDays:30,formulaParameters:{inputClass:'profile',sourceStatistics:[{definition:'test/rawWinFraction',units:'fraction',emittedReferences:['histrel.radiant.team.30d.rawWinFraction']}]}};
 const r=bindHistorical(d,env);assert.deepEqual(r.historyDefinitions,['histrel.radiant.team.30d.rawWinFraction']);assert.ok(r.dependencyRefs.some(ref=>ref.kind==='feature'&&ref.name===r.historyDefinitions[0]));assert.equal(r.semanticVerification,'authoritative_template');delete d.formulaParameters.sourceStatistics[0].emittedReferences;assert.equal(bindHistorical(d,env).semanticVerification,'parameter_binding_required');
});
test('chronological nested current selectors preserve row IDs without fragmenting function grammar',()=>{
 const roster=Array.from({length:10},(_,i)=>({accountId:String(i+1),side:i<5?'radiant':'dire',teamId:i<5?'100':'200'})),args={events:[],roster,historyCutoffAt:'2026-10-25T00:00:00Z',minimumSupport:5,factsPin:{sha256:'a'.repeat(64),bytes:2},populationBasis:'synthetic_empty',formulaVersion:'test.v1'},a=produceChronologicalResultRatings(args),b=produceChronologicalResultRatings({...args,roster:roster.map(p=>({...p,accountId:String(Number(p.accountId)+100),teamId:p.teamId==='100'?'300':'400'}))});
 assert.deepEqual(a.names,b.names);for(let i=0;i<a.definitions.length;i++){assert.deepEqual(a.definitions[i].parameterClassification.functionParameters,b.definitions[i].parameterClassification.functionParameters);assert.notDeepEqual(a.definitions[i].parameterClassification.rowParameters,b.definitions[i].parameterClassification.rowParameters);}
});
test('team-conditioned style inputs use stable exact slots while row selectors retain chosen heroes',()=>{
 const args={side:'radiant',teamId:'100',heroIds:[1,2,3,4,5],teamStatistics:{},heroStatistics:[],historyCutoffAt:'2026-10-25T00:00:00Z'},a=produceCausalDraftStyleFit(args),b=produceCausalDraftStyleFit({...args,teamId:'200',heroIds:[6,7,8,9,10]});
 for(let i=0;i<a.definitions.length;i++){const x=a.definitions[i],y=b.definitions[i];assert.deepEqual(x.inputBindings,y.inputBindings);assert.deepEqual(x.parameterClassification.functionParameters,y.parameterClassification.functionParameters);assert.notDeepEqual(x.parameterClassification.rowParameters,y.parameterClassification.rowParameters);assert.deepEqual(x.historyDefinitions,[]);assert.ok(x.dependencyRefs.every(ref=>ref.kind==='input'||ref.kind==='formulaTemplate'));assert.equal(x.inputBindings.filter(p=>p.normalizedField.startsWith('heroStatistics[')).length,5);}
});
