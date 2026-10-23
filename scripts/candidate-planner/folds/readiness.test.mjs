import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyGroupedSplits,observeReadiness,observeBindings} from '../readiness.mjs';
import {CONTRACT,verifyComponentFolds} from './strict_folds.mjs';
const H='a'.repeat(64),iso=s=>new Date(Date.UTC(2025,0,1)+s*1000).toISOString();
const clone=x=>JSON.parse(JSON.stringify(x));
// Synthetic metadata only: fixture matrices are never fit or admitted for production.
function fixture(){
 const componentMembers=[];
 for(let c=0;c<5;c++)for(let n=0;n<2;n++){
  const t=c*4*86400+n*3600;
  componentMembers.push({mapId:`m${c}${n}`,seriesId:`s${c}${n}`,componentId:`c${c}`,partition:'TRAIN',startTime:iso(t),predictionAt:iso(t-3600),endTime:iso(t+1800),labelAvailability:{at:iso(t+2100),kind:'historical_end_plus_300_reconstruction',sourceRevisionKnownAt:iso(25*86400),basis:'map_end',basisEndTime:iso(t+1800)}});
 }
 const mapRows=componentMembers.map(({mapId,seriesId,componentId,partition,startTime,predictionAt})=>({mapId,seriesId,componentId,partition,startTime,predictionAt,featureKnownAt:predictionAt}));
 const folds=Array.from({length:4},(_,i)=>({fold:i,trainMapIds:mapRows.filter(r=>Number(r.componentId.slice(1))<=i).map(r=>r.mapId),validationMapIds:mapRows.filter(r=>r.componentId===`c${i+1}`).map(r=>r.mapId)}));
 return {contract:CONTRACT,family:'prematch_map_winner',scope:{scopeId:'synthetic-only',asOf:iso(30*86400),sourceManifestSha256:H,componentIdentityPolicySha256:H,protectionPolicySha256:H,membershipCompleteness:'complete_within_pinned_scope'},componentMembers,mapRows,folds};
}
const verify=x=>verifyGroupedSplits(x.mapRows,x.folds,x);
test('installed API refuses former two-argument weak verifier',()=>{
 const x=fixture();assert.throws(()=>verifyGroupedSplits(x.mapRows,x.folds),/complete_component_evidence_required/);
});
test('installed API retains full component accounting',()=>{
 const x=fixture(),r=verify(x);assert.equal(r.length,4);assert.equal(r[0].trainUniverseMembers,2);
});
test('different series cannot split the same component',()=>{
 const x=fixture();x.folds[0].trainMapIds=['m00'];x.folds[0].validationMapIds=['m01'];assert.throws(()=>verify(x),/whole_component_crossed_fold/);
});
test('one-hour gap formerly accepted is refused',()=>{
 const x=fixture();for(const r of x.componentMembers.filter(r=>r.componentId==='c0'))r.labelAvailability={...r.labelAvailability,at:iso(4*86400-7200),kind:'recorded_label_receipt'};
 assert.throws(()=>verify(x),/whole_component_24h_embargo/);
});
test('24 hours exactly accepted; one nanosecond less refused',()=>{
 const x=fixture();for(const r of x.componentMembers.filter(r=>r.componentId==='c0'))r.labelAvailability={...r.labelAvailability,at:iso(3*86400-3600),kind:'recorded_label_receipt'};
 assert.equal(verify(x)[0].gapNanoseconds,'86400000000000');
 x.componentMembers[0].labelAvailability.at=x.componentMembers[0].labelAvailability.at.replace('.000Z','.000000001Z');
 assert.throws(()=>verify(x),/whole_component_24h_embargo/);
});
test('omitted members still control label availability and validation origin',()=>{
 const x=fixture(),hidden=clone(x.componentMembers[0]);hidden.mapId='hidden';hidden.seriesId='hidden';hidden.labelAvailability={...hidden.labelAvailability,at:iso(4*86400-3600),kind:'recorded_label_receipt'};x.componentMembers.push(hidden);
 assert.throws(()=>verify(x),/whole_component_24h_embargo/);
});
function integration(t,mutate=()=>{}){
 const dir=mkdtempSync(join(tmpdir(),'aegis-readiness-v2-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let counter=0;
 const pin=value=>{const bytes=Buffer.from(JSON.stringify(value)),path=join(dir,`${counter++}.json`);writeFileSync(path,bytes);return{path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};};
 const x=fixture(),matrix=pin({fixtureOnly:true}),rawExport=pin({contract:'aegis.rich-raw-export.v1',complete:true,partition:'TRAIN',providerFetchedDuringTraining:false,exportedAt:iso(30*86400),asOf:iso(30*86400),files:[matrix]});
 x.scope.sourceManifestSha256=rawExport.sha256;
 const mapRows=pin(x.mapRows),splits=pin(x.folds);
 const featureContract=pin({contract:'aegis.full-rich-feature-contract.v1',family:x.family,phase:'prematch',names:['fixtureOnly'],stateFeatures:1,prunedFeatures:0,unknownEncoding:'NaN',phaseAsOf:{actualSidePermitted:false,actualDraftPermitted:false,unconfirmedRosterPermitted:false}});
 const bytes=pin([1]);const phaseParity=pin({contract:'aegis.phase-parity.v1',family:x.family,featureContractSha256:featureContract.sha256,TRAINonly:true,status:'PASS',offlineBytes:bytes,servingBytes:bytes});
 const componentDoc={contract:'aegis.whole-component-fold-manifest.v2',family:x.family,scope:x.scope,componentMembers:pin(x.componentMembers),mapRows,folds:splits,candidateOnly:true,fitAuthorized:false,dispatchEnabled:false,publicPromotion:false};
 const context={x,pin,componentDoc,rawExport,mapRows,splits};mutate(context);
 const componentFolds=pin(componentDoc);
 const reviewDoc={contract:'aegis.dynamic-data-review.v2',approved:true,approvedBy:'root',family:x.family,featureContractSha256:featureContract.sha256,rawExportSha256:rawExport.sha256,mapRowsSha256:mapRows.sha256,splitsSha256:splits.sha256,phaseParitySha256:phaseParity.sha256,componentFoldsSha256:componentFolds.sha256,componentIdentityPolicySha256:x.scope.componentIdentityPolicySha256,protectionPolicySha256:x.scope.protectionPolicySha256,componentMembershipReviewed:true,embargoSeconds:86400,fullInventoryRetained:true,phaseAsOfReviewed:true,purchaseLineage:'corrected_v4',approvedAt:iso(31*86400)};
 if(context.reviewMutation)context.reviewMutation(reviewDoc);
 const doc={contract:'aegis.dynamic-rich-matrix.v2',family:x.family,scope:'new_dynamic_candidate_contract',complete:true,candidateOnly:true,outerHoldoutRead:false,completedAt:iso(31*86400),coveredTriggerIds:['monthly-test'],rawExport,matrixFiles:[matrix],mapRows,splits,featureContract,phaseParity,componentFolds,reviewReceipt:pin(reviewDoc),minimumNewPatchMaps:1};
 if(context.matrixMutation)context.matrixMutation(doc);
 return observeReadiness({maximumVerificationBytes:10000000,dataFamilies:{[x.family]:{dynamicManifest:pin(doc)}}},context.intent??{triggers:[{triggerId:'monthly-test',kind:'monthly',dueAt:iso(29*86400)}]},iso(32*86400)).families[x.family];
}
test('actual readiness path verifies bound component manifest and remains candidate-only',t=>{
 const r=integration(t);assert.equal(r.ready,true);assert.equal(r.embargoSeconds,86400);assert.match(r.componentFoldManifestSha256,/^[a-f0-9]{64}$/);assert.equal(r.folds[0].trainUniverseMembers,2);
});
test('legacy matrix cannot bypass installed v2 guard',t=>{
 const r=integration(t,c=>c.matrixMutation=m=>{m.contract='aegis.dynamic-rich-matrix.v1';});assert.equal(r.ready,false);assert.match(r.reasons[0],/dynamic_matrix_v2_contract_required/);
});
test('same component violation rejected through real readiness path',t=>{
 const r=integration(t,c=>{const fs=clone(c.x.folds);fs[0].trainMapIds=['m00'];fs[0].validationMapIds=['m01'];c.componentDoc.folds=c.splits=c.pin(fs);});
 assert.equal(r.ready,false);assert.match(r.reasons[0],/whole_component_crossed_fold/);
});
test('substituted split evidence cannot attest another matrix',t=>{
 const r=integration(t,c=>{c.componentDoc.mapRows=c.pin([{notTheMatrix:true}]);});assert.equal(r.ready,false);
});
test('unreviewed component membership and legacy review rejected',t=>{
 const a=integration(t,c=>c.reviewMutation=r=>{r.componentMembershipReviewed=false;});assert.equal(a.ready,false);assert.match(a.reasons[0],/explicit_dynamic_data_review_v2_required/);
 const b=integration(t,c=>c.reviewMutation=r=>{r.contract='aegis.dynamic-data-review.v1';});assert.equal(b.ready,false);
});
test('review pins actual component policy and raw export',t=>{
 const a=integration(t,c=>c.reviewMutation=r=>{r.protectionPolicySha256='b'.repeat(64);});assert.equal(a.ready,false);
 const b=integration(t,c=>{c.componentDoc.scope={...c.x.scope,sourceManifestSha256:'c'.repeat(64)};});assert.equal(b.ready,false);assert.match(b.reasons[0],/component_fold_matrix_binding_mismatch/);
});
test('strict verifier does not authorize dispatch or claim historical receipts',()=>{
 const r=verifyComponentFolds(fixture());assert.equal(r.fitAuthorized,false);assert.equal(r.dispatchEnabled,false);assert.equal(r.historicalReceiptTruthClaim,false);
});
test('component asOf must match exact raw-export scope',t=>{
 const r=integration(t,c=>{c.componentDoc.scope={...c.x.scope,asOf:c.x.scope.asOf.replace('.000Z','.000000001Z')};});assert.equal(r.ready,false);assert.match(r.reasons[0],/dynamic_data_exact_chronology_required/);
});
test('semantic review cannot predate completed matrix even by one nanosecond',t=>{
 const r=integration(t,c=>c.matrixMutation=m=>{m.completedAt=m.completedAt.replace('.000Z','.000000001Z');});assert.equal(r.ready,false);assert.match(r.reasons[0],/dynamic_data_exact_chronology_required/);
});
function patchFixture(c,kind='confirmed',reviewCalendar=false){
 c.intent={triggers:[{triggerId:'monthly-test',kind:'patch',patchVersion:'7.41f',releasedAt:iso(0),dueAt:iso(29*86400)}]};
 const assignments=c.pin({contract:'aegis.dynamic-patch-assignments.v1',family:c.x.family,assignments:c.x.mapRows.map(r=>({mapId:r.mapId,patchVersion:'7.41f',assignmentKind:kind,sourceKnownAt:iso(28*86400),sourceSha256:H}))});
 c.matrixMutation=m=>{m.patchAssignments=assignments;};
 c.reviewMutation=r=>{r.patchAssignmentsSha256=assignments.sha256;r.acceptedPatchAssignmentKinds=[kind];r.calendarInferredPatchMembershipReviewed=reviewCalendar;};
}
test('exact-letter patch coverage is separate from strict map metadata',t=>{
 const r=integration(t,c=>patchFixture(c));assert.equal(r.ready,true);assert.equal(r.patchCoverage.counts[0].maps,10);assert.equal(r.patchCoverage.counts[0].knownHistoricalFeatureClaim,false);
});
test('calendar-inferred membership requires explicit semantic review',t=>{
 const a=integration(t,c=>patchFixture(c,'calendar_inferred'));assert.equal(a.ready,false);assert.match(a.reasons[0],/explicit_patch_membership_review_required/);
 const b=integration(t,c=>patchFixture(c,'calendar_inferred',true));assert.equal(b.ready,true);
});
test('missing assignment pin does not silently zero-count valid patch data',t=>{
 const r=integration(t,c=>{patchFixture(c);c.matrixMutation=()=>{};});assert.equal(r.ready,false);assert.match(r.reasons[0],/separate_patch_assignments_required/);
});
const families=['prematch_map_winner','postdraft_map_winner','live_map_winner','prematch_kills_total','prematch_duration_total','live_kills_total','live_duration_total','series_winner'];
const seriesHeads=['p_current_map','q_series_if_current_won','q_series_if_current_lost'];
function bindingFixture(t,mutate=()=>{}){
 const dir=mkdtempSync(join(tmpdir(),'aegis-head-bindings-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let n=0;
 const pin=value=>{const b=Buffer.from(JSON.stringify(value)),path=join(dir,`${n++}.json`);writeFileSync(path,b);return{path,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};};
 const source=pin({testFixtureOnly:true}),recipe=pin({backend:'lightgbm',rounds:256,parameters:{num_threads:4,feature_fraction:1,feature_fraction_bynode:1,feature_pre_filter:false},earlyStopping:false,featurePruning:false});
 const adapter={scope:'new_dynamic_candidate_contract',singleFit:true,entryPoint:'fit_one',contract:'aegis.rich-fit-adapter.v2',backend:'lightgbm-lazyColumnSample',source,recipe};
 const registry={contract:'aegis.dynamic-rich-runner-registry.v2',approved:true,approvedBy:'root',policyId:'fixture-policy',approvedAt:iso(31*86400),expiresAt:iso(33*86400),resourceGuardSha256:H,families:Object.fromEntries(families.map(f=>[f,{heads:Object.fromEntries((f==='series_winner'?seriesHeads:['main']).map(h=>[h,clone(adapter)]))}]))};
 mutate(registry);
 return observeBindings({policyId:'fixture-policy',runnerRegistry:pin(registry)},{families:Object.fromEntries(families.map(f=>[f,{ready:true,featureContractSha256:H}]))},iso(32*86400));
}
test('real runner-binding path exposes ten distinct heads and forty fits',t=>{
 const r=bindingFixture(t);assert.equal(r.status,'approved_dynamic_rich_runner');assert.equal(r.headCount,10);assert.equal(r.expectedNativeFits,40);assert.equal(r.dispatchEnabled,false);assert.equal(r.publicPromotion,false);
});
test('legacy single series entry cannot hide three fits',t=>{
 const r=bindingFixture(t,r=>{r.families.series_winner=clone(r.families.live_map_winner);});assert.equal(r.status,'unavailable');
});
test('unrecognized extra head and old registry contract refused',t=>{
 const a=bindingFixture(t,r=>{r.families.series_winner.heads.extra=clone(r.families.series_winner.heads.p_current_map);});assert.equal(a.status,'unavailable');
 const b=bindingFixture(t,r=>{r.contract='aegis.dynamic-rich-runner-registry.v1';});assert.equal(b.status,'unavailable');
});
