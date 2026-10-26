/** Small actual factory metadata tests; synthetic technical inputs only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {produceReviewedHistoricalSummaries as produce,collectReviewedDurationTails} from './reviewedHistoricalSummaries.mjs';
import {orientSeriesRelationalDefinition} from './historicalRelationalFeatures.mjs';
import {instantNs} from './causalTime.mjs';
import {auditTypedFeatureDependencies as audit} from '../../feature-registry/typed-feature-dependencies.mjs';
import {compileFeatureFunctionContract} from './featureFunctionContract.mjs';
const KNOWN='2026-10-24T10:00:00Z',AT='2026-10-25T10:00:00Z',H='a'.repeat(64),OPS=['rawWinFraction','smoothedWinFraction','decayedWinFraction','smoothedDecayedWinFraction'],KEYS=['formWinFraction7d','playerHeroWinFraction90d'];
const port={normalizedField:'fixture.priorFacts',rawField:'fixture.priorFacts',sourceProfile:'synthetic_technical_fixture',sourceKind:'synthetic_fact',units:'fraction',availabilityPolicy:'synthetic fixture is prior to the cutoff; no actual source attestation'};
function fixture(teamId='100'){
 const primary=[],statistics={},stat=(value,w)=>({value,units:'fraction',windowDays:w,definition:'fixture.statistic-formula/'+w+'d',supportRef:'cohort:fixture',cohortQualified:true,latestHistoryAvailabilityAt:KNOWN});
 const players=[];
 for(const side of ['radiant','dire'])for(let i=0;i<5;i++)players.push({side,statistics:Object.fromEntries(KEYS.map((key,j)=>[key,stat((i+1)/10,j?90:7)]))});
 const profiles={players};
 for(const side of ['radiant','dire']){
  for(let i=0;i<5;i++)for(const key of KEYS)primary.push(`histrel.${side}.slot_${i}.profile.${key}`);
  for(const w of [7,30,90]){statistics[side+'.team.'+w+'d']=Object.fromEntries(OPS.map((op,i)=>[op,{...stat(.6+i/100,w),definition:'fixture.'+op+'/'+w+'d'}]));for(const op of OPS)primary.push(`histrel.${side}.team.${w}d.${op}`);}
 }
 const selector={key:'radiant.team',kind:'team',selector:{teamId},qualified:true},rows=[25,40,80].map((minutes,i)=>({map:{matchId:String(i+1),ended:instantNs(KNOWN),durationSeconds:minutes*60},availableAt:KNOWN})),tailCohorts=[collectReviewedDurationTails(rows,{selector,windowDays:7,cutoff:instantNs(AT),minimumSupport:3,supportRef:'radiant.team.7d'})];
 const args={phase:'POST_OR_LIVE',profiles,statistics,tailCohorts,profileKeys:KEYS,minimumSupport:3,formulaVersion:'fixture.actual-constructor.v1',historyDefinitionNamespace:primary},leaves=primary.map(name=>({name,familyId:'H02',formula:'explicit synthetic prior-statistic leaf',formulaVersion:'fixture.v1',units:'fraction',historyDefinitions:[],inputScopes:['prior_completed_maps'],dependencyRefs:[{kind:'input',port}]}));
 return{args,leaves};
}
const compiled=definitions=>definitions.map(d=>({...d,id:'history:'+d.name}));
const contract=definitions=>compileFeatureFunctionContract({definitions,targetId:'POST_MAP_WIN',stateMode:'POST',registryHash:H,sourceInventory:{history:{primarySha256:H}}});

test('every reviewed numeric constructor has exact typed ports or same-generator operands and complete classification',()=>{
 const f=fixture(),r=produce(f.args),defs=compiled([...f.leaves,...r.definitions]),receipt=audit({definitions:defs});
 assert.equal(r.definitions.length,106);assert.equal(receipt.declarationGapCount,0);assert.equal(receipt.transitivelyIneligibleDefinitions,0);assert.equal(receipt.trainingAdmitted,false);assert.equal(contract(defs).generalized,true);
 for(const d of r.definitions){assert.ok(d.dependencyRefs.length,d.name);assert.deepEqual([...d.parameterClassification.classifiedKeys].sort(),Object.keys(d.formulaParameters).sort());assert.deepEqual(d.dependencyRefs.filter(r=>r.kind==='feature').map(r=>r.name),d.historyDefinitions);}
 const byName=new Map(r.definitions.map(d=>[d.name,d]));
 const tail=byName.get('histrel.r7.tail.radiant.team.7d.ge_25m');assert.ok(tail.dependencyRefs.some(r=>r.kind==='input'&&r.port.normalizedField==='priorMaps.durationSeconds'));assert.ok(tail.dependencyRefs.some(r=>r.kind==='input'&&r.port.normalizedField==='currentSelector.teamId'));
 const diff=byName.get('histrel.r7.radiant.team.form.rawWinFraction.diff_7d_minus_30d');assert.deepEqual(diff.dependencyRefs.filter(r=>r.kind==='feature').map(r=>r.name),['histrel.radiant.team.7d.rawWinFraction','histrel.radiant.team.30d.rawWinFraction']);
 assert.equal(byName.get('histrel.r7.radiant.player_profile.formWinFraction7d.p25').historyDefinitions.length,5);
 assert.equal(byName.get('histrel.r7.player_matchup.formWinFraction7d.radiant_slot_0.minus_dire_slot_1').historyDefinitions.length,2);
 assert.equal(byName.get('histrel.r7.player_matchup.formWinFraction7d.mean').historyDefinitions.length,25);
});

test('missing exact emitted operands and template-only replacements cannot repair a derived declaration',()=>{
 const f=fixture(),r=produce(f.args),removed=f.leaves[0].name,defs=compiled([...f.leaves.filter(d=>d.name!==removed),...r.definitions]),missing=audit({definitions:defs});
 assert.ok(missing.declarationGapCount>0);assert.ok(missing.declarationGaps.some(g=>g.reason==='missing_exact_emitted_feature:history:'+removed));assert.ok(missing.transitivelyIneligibleDefinitions>0);
 const bad=r.definitions.map(d=>d.name==='histrel.r7.radiant.player_profile.formWinFraction7d.p25'?{...d,dependencyRefs:[{kind:'formulaTemplate',templateId:d.historyDefinitions[0]}]}:d);
 assert.ok(audit({definitions:compiled([...f.leaves,...bad])}).declarationGaps.some(g=>g.reason.startsWith('untyped_legacy_history_operand:')));
 const incomplete=produce({...f.args,historyDefinitionNamespace:[]});assert.ok(incomplete.definitions.some(d=>d.semanticVerification==='parameter_binding_required'));assert.ok(audit({definitions:compiled([...f.leaves,...incomplete.definitions])}).transitivelyIneligibleDefinitions>0);
});

test('actual tail selector IDs change row bindings while fixed thresholds and derived slot semantics stay functions',()=>{
 const a=fixture('100'),b=fixture('200'),ra=produce(a.args),rb=produce(b.args),ca=contract(compiled([...a.leaves,...ra.definitions])),cb=contract(compiled([...b.leaves,...rb.definitions]));
 assert.deepEqual(ra.names,rb.names);assert.deepEqual(ra.values,rb.values);assert.equal(ca.generalized,true);assert.equal(cb.generalized,true);assert.equal(ca.sha256,cb.sha256);assert.notEqual(ca.rowParameterBindingsSha256,cb.rowParameterBindingsSha256);
 const tail=ra.definitions.find(d=>d.name==='histrel.r7.tail.radiant.team.7d.ge_25m');assert.equal(tail.parameterClassification.rowParameters.selector.teamId,'100');assert.deepEqual(tail.parameterClassification.functionParameters.selector.teamId,{kind:'current_identity_binding',field:'teamId'});assert.equal(tail.parameterClassification.functionParameters.thresholdMinutes,25);
});

test('series orientation remaps only exact known emitted operands to the seriesHistory namespace',()=>{
 const a='histrel.radiant.team.7d.rawWinFraction',b='histrel.dire.team.7d.rawWinFraction',n='histrel.r7.team.radiant_minus_dire',baseNames=new Set([a,b,n]),leaf=name=>({name,formula:'fixture leaf',formulaVersion:'fixture.v1',units:'fraction',historyDefinitions:[],dependencyRefs:[{kind:'input',port}]}),d={name:n,formula:'a-b',formulaVersion:'fixture.v1',units:'fraction',historyDefinitions:[a,b],inputFields:[a,b],inputBindings:[{...port,normalizedField:a,sourceKind:'derived_prior_statistic'}],formulaParameters:{sourceStatistics:[{emittedReferences:[a,b],emittedOperandUnits:{[a]:'fraction',[b]:'fraction'}}]},dependencyRefs:[{kind:'feature',component:'history',name:a},{kind:'feature',component:'history',name:b},{kind:'formulaTemplate',templateId:'fixture.generic-formula'}]};
 const oriented=[leaf(a),leaf(b),d].map(x=>orientSeriesRelationalDefinition(x,{baseNames,phase:'SERIES_PRE'})),defs=oriented.map(x=>({...x,id:'seriesHistory:'+x.name}));
 assert.equal(audit({definitions:defs}).declarationGapCount,0);const out=oriented[2];assert.ok(out.dependencyRefs.filter(r=>r.kind==='feature').every(r=>r.component==='seriesHistory'&&r.name.startsWith('series_history.')));assert.deepEqual(out.formulaParameters.sourceStatistics[0].emittedReferences,out.historyDefinitions);assert.deepEqual(Object.keys(out.formulaParameters.sourceStatistics[0].emittedOperandUnits),out.historyDefinitions);assert.equal(out.dependencyRefs.at(-1).templateId,'fixture.generic-formula');
 const unknown='histrel.radiant.team.7d.looks_similar_but_not_emitted',bad=orientSeriesRelationalDefinition({...d,historyDefinitions:[unknown],dependencyRefs:[{kind:'feature',component:'history',name:unknown}]},{baseNames,phase:'SERIES_PRE'});assert.equal(bad.dependencyRefs[0].component,'history');assert.equal(bad.dependencyRefs[0].name,unknown);assert.ok(audit({definitions:[{...bad,id:'seriesHistory:'+bad.name}]}).declarationGapCount>0);
});
