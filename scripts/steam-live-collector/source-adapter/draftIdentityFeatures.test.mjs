import test from 'node:test';import assert from 'node:assert/strict';
import {createDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {draftArgs,draftEntry} from './observedDraftHistory.fixtures.mjs';
import {produceDraftIdentityFeatures} from './draftIdentityFeatures.mjs';
import {auditTypedFeatureDependencies} from '../../feature-registry/typed-feature-dependencies.mjs';
const at='2026-10-23T12:40:00Z';
const get=(b,n)=>b.values[b.names.indexOf('draft_identity.hero.'+n)];
test('confirmed draft produces nominal hero-side main effects, including structural zeros',()=>{
 const a=draftArgs({accounts:true}),h=createDynamicHistoryProof(a),b=produceDraftIdentityFeatures({historyProof:h.proof,matchId:a.matchId,decisionAt:at});
 assert.equal(b.names.length,1500);assert.equal(b.values.filter((v,i)=>b.names[i].endsWith('.picked')&&v===1).length,10);
 for(const p of h.context.draftState.identity.players){assert.equal(get(b,p.heroId+'.picked'),1);assert.equal(get(b,p.heroId+'.side_sign'),p.side==='radiant'?1:-1);}
 assert.equal(get(b,'250.picked'),0);assert.equal(get(b,'250.side_sign'),0);assert.ok(b.masks.every(x=>x===0));assert.ok(b.definitions.every(x=>x.inputScopes.includes('current_draft')&&!x.allowedTargets.includes('PRE_MAP_WIN')));
 assert.equal(b.eligibleForServing,false);assert.equal(b.eligibleForTraining,false);
 for(const d of b.definitions){assert.deepEqual(d.parameterClassification.functionParameters,d.formulaParameters);assert.deepEqual(d.parameterClassification.rowParameters,{});assert.deepEqual([...d.parameterClassification.classifiedKeys].sort(),Object.keys(d.formulaParameters).sort());assert.equal(d.parameterClassification.functionParameters.hero,Number(d.name.split('.')[2]));assert.deepEqual(d.dependencyRefs.filter(r=>r.kind==='input').map(r=>r.port),d.inputBindings);assert.ok(d.dependencyRefs.some(r=>r.kind==='input'&&r.port.normalizedField==='draftState.identity.players[].side'));}
 const closure=auditTypedFeatureDependencies({definitions:b.definitions.map(d=>({...d,id:'draft:'+d.name}))});assert.equal(closure.declarationGapCount,0);assert.equal(closure.transitivelyIneligibleDefinitions,0);assert.equal(closure.trainingAdmitted,false);
});
test('late account disclosure affects only the later revision without moving the history cutoff',()=>{
 const a=draftArgs({accounts:false}),h=createDynamicHistoryProof(a),b=produceDraftIdentityFeatures({historyProof:h.proof,matchId:a.matchId,decisionAt:at});
 const c=createDynamicHistoryProof({...a,draftPrefixInputs:[...a.draftPrefixInputs,draftEntry({accounts:true,time:'2026-10-23T12:01:00Z'})]}),d=produceDraftIdentityFeatures({historyProof:c.proof,matchId:a.matchId,decisionAt:at});
 assert.equal(b.values.filter((v,i)=>b.names[i].endsWith('selected_account_known')&&v===1).length,0);assert.equal(d.values.filter((v,i)=>d.names[i].endsWith('selected_account_known')&&v===1).length,10);assert.equal(b.historyCutoffAt,d.historyCutoffAt);assert.notEqual(b.rosterHash,d.rosterHash);assert.equal(b.schemaHash,d.schemaHash);
});
test('cloned proof, wrong map and decision before actual identity validity do not produce draft features',()=>{
 const a=draftArgs({accounts:true}),h=createDynamicHistoryProof(a),run=x=>produceDraftIdentityFeatures({historyProof:h.proof,matchId:a.matchId,decisionAt:at,...x});
 assert.throws(()=>run({historyProof:structuredClone(h.proof)}),/token_required/);assert.throws(()=>run({matchId:'99999'}));assert.throws(()=>run({decisionAt:'2026-10-23T11:57:59.999999999Z'}));
});
test('R7 draft semantics bind the same hero/axis and raw identity operands as the value loop',()=>{
 const a=draftArgs({accounts:false}),h=createDynamicHistoryProof(a),b=produceDraftIdentityFeatures({historyProof:h.proof,matchId:a.matchId,decisionAt:at}),i=b.names.indexOf('draft_identity.hero.250.side_sign'),d=b.definitions[i];
 assert.equal(b.values[i],0);assert.equal(d.formulaParameters.hero,250);assert.equal(d.formulaParameters.axis,'side_sign');assert.equal(d.minimumSupport,0);assert.match(d.rolePolicy,/not farm roles/);assert.equal(d.semanticVerification,'authoritative_template');assert.ok(d.inputBindings.some(x=>x.rawField.endsWith('.hero_id')));assert.ok(d.inputBindings.every(x=>x.availabilityPolicy.includes('receipt')||x.availabilityPolicy.includes('receivedAt')));
});
