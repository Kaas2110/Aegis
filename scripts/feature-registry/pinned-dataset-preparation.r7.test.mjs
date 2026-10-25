import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeaturePreparationPlan as prepare,assignChronologicalSeriesSplits as assign,createLearnedStateTrainingBinding as stateBinding,FEATURE_PREPARATION_MODES,FEATURE_PREPARATION_LIMITS,FIXED_LIVE_LANDMARK_SECONDS} from './pinned-dataset-manifest.mjs';
const H=letter=>letter.repeat(64),A=H('a'),B=H('b'),C=H('c'),D=H('d'),E=H('e'),F=H('f');
const day=n=>'2026-10-'+String(n).padStart(2,'0')+'T00:00:00Z';
const policy={historyWindowPolicy:'frozen prior cohort',patchPolicy:'exact recorded patch',snapshotWeightPolicy:'equal series then map then selected sample',collectionAvailabilityPolicy:'labels before frozen split end',aggregateFitPolicy:'eligible_past_train_only',childPredictionPolicy:'chronological_out_of_fold_version_bound',holdoutPolicy:'inspected_holdout_is_not_untouched',refreshPolicy:'reuse_pinned_sources_no_automatic_refresh'};
function fixture(){
 const series=[{seriesId:'s1',componentId:'c1',mapIds:['m1','m2'],predictionStartAt:day(1),startAt:day(2),endAt:day(3),availableAt:'2026-10-03T01:00:00Z'}];
 const row={rowId:'r1',seriesId:'s1',mapId:'m1',targetId:'PRE_MAP_WIN',stateMode:'PRE',decisionAt:'2026-10-01T00:01:00Z',historyCutoffAt:day(1),historicalAvailability:{basis:'synthetic',maxKnownAt:null},eventAt:day(1),inputKnownAt:null,collectedAt:day(24),materializedAt:'2026-10-24T00:00:01Z',replayHorizonAt:null,originalAvailability:'synthetic',provenance:'synthetic',sourcePinId:'source',schemaSha256:C,inputSha256:B,labelTableId:'labels',labelRowId:'label-m1'};
 const dataset={datasetId:'synthetic-preparation',createdAt:day(25),sourcePins:[{id:'source',sha256:A,bytes:100,provenance:'synthetic',availableAt:day(24)}],featureSchemas:[{id:'schema',sha256:B,bytes:100,schemaSha256:C,targetId:'PRE_MAP_WIN',stateMode:'PRE',columns:[{id:'history',semanticRole:'predictor',inputScopes:['prior_maps']}]}],labelTables:[{id:'labels',sha256:D,bytes:100,targetIds:['PRE_MAP_WIN'],inputEligible:false}],splits:['train','tune','early_stop','holdout'].map((role,i)=>({role,startAt:day(1+i*5),endAt:day(6+i*5)})),series,rows:[row],policy};
 return {dataset,profiles:[{id:'synthetic-profile',currentSource:'synthetic',historyBasis:'synthetic',sourcePinIds:['source']}],rowProfiles:[{rowId:'r1',profileId:'synthetic-profile',observationId:null}]};
}
function addRow(input,overrides){const row={...structuredClone(input.dataset.rows[0]),...overrides};input.dataset.rows.push(row);input.rowProfiles.push({rowId:row.rowId,profileId:'synthetic-profile',observationId:null});return row;}

test('preparation has twelve logical tasks/thirteen modes while every execution gate stays closed',()=>{
 const input=fixture(),out=prepare(input);assert.equal(FEATURE_PREPARATION_MODES.length,13);assert.equal(new Set(out.modes.map(m=>m.logicalTask)).size,12);assert.deepEqual(out.modes.filter(m=>m.targetId==='SERIES_LIVE').map(m=>m.stateMode),['observed_postdraft','observed_live']);assert.equal(out.modes.find(m=>m.targetId==='PRE_MAP_WIN').sampleCount,1);assert.equal(out.modes.find(m=>m.targetId==='LIVE_KILLS').sampleCount,0);assert.equal(out.trainingAdmitted,false);assert.equal(out.qualityEvaluationPerformed,false);assert.equal(out.sourceAvailabilityAttested,false);assert.equal(out.runnerPolicy.fits,0);assert.equal(out.runnerPolicy.modelScores,0);assert.ok(out.requiredGates.includes('actual_private_source_and_feature_proof_verification'));assert.equal(out.sourceAudit[0].privateProofVerification,'required_not_performed');assert.ok(Object.isFrozen(out.samples[0]));
 input.dataset.rows[0].rowId='caller-change';assert.equal(out.samples[0].rowId,'r1');
});

test('whole linked component crosses no split even when one series alone fits',()=>{
 const x=fixture();x.dataset.series.push({seriesId:'s2',componentId:'c1',mapIds:['m3'],predictionStartAt:day(6),startAt:day(7),endAt:day(8),availableAt:day(9)});
 const series=assign({series:x.dataset.series,splits:x.dataset.splits,createdAt:x.dataset.createdAt});assert.deepEqual(series.map(s=>s.splitRole),['purged','purged']);const out=prepare(x);assert.equal(out.samples.length,0);assert.equal(out.excluded[0].reason,'series_component_purged');assert.equal(out.manifest.assignments.length,2);
 x.dataset.series[0].splitRole='train';assert.throws(()=>prepare(x),/declared_split_mismatch/);
});

test('grouping and frozen boundaries reject random frame roles and cross-map identity',()=>{
 const x=fixture();x.dataset.rows[0].splitRole='holdout';assert.throws(()=>prepare(x),/row_unrecognized/);
 const y=fixture();y.dataset.series.push({...structuredClone(y.dataset.series[0]),seriesId:'s2',componentId:'c2'});assert.throws(()=>prepare(y),/map_cross_series/);
 const z=fixture();z.dataset.splits.reverse();assert.throws(()=>prepare(z),/split_chronology/);
});

test('long maps and repeated frames cannot increase series mass',()=>{
 const x=fixture();addRow(x,{rowId:'r2'});addRow(x,{rowId:'r3'});addRow(x,{rowId:'r4',mapId:'m2',labelRowId:'label-m2'});const out=prepare(x),byMap=new Map();for(const row of out.samples)byMap.set(row.mapId,(byMap.get(row.mapId)??0)+row.weight);assert.equal(out.samples.length,4);assert.equal(byMap.get('m1'),.5);assert.equal(byMap.get('m2'),.5);assert.equal(out.samples.find(r=>r.rowId==='r4').weight,.5);assert.equal(out.samples.find(r=>r.rowId==='r1').weight,1/6);
});

test('source modalities and historical reconstruction stay in separate declared profiles',()=>{
 const x=fixture(),observed=x.dataset.rows[0];Object.assign(x.dataset.sourcePins[0],{provenance:'observed_live'});Object.assign(observed,{provenance:'observed_live',originalAvailability:'confirmed',inputKnownAt:'2026-10-01T00:00:00.1Z',collectedAt:'2026-10-01T00:00:00.2Z',historicalAvailability:{basis:'retained_as_of',maxKnownAt:day(1)}});x.profiles=[{id:'steam',currentSource:'retained_steam_observed',historyBasis:'retained_as_of',sourcePinIds:['source']}];x.rowProfiles[0].profileId='steam';
 const rebuilt={...structuredClone(observed),rowId:'rebuilt',sourcePinId:'replay-source',provenance:'retrospective_reconstruction',originalAvailability:'unknown',inputKnownAt:null,collectedAt:day(24),replayHorizonAt:observed.decisionAt,historicalAvailability:{basis:'reconstruction_only',maxKnownAt:null}};x.dataset.rows.push(rebuilt);x.dataset.sourcePins.push({id:'replay-source',sha256:E,bytes:100,provenance:'retrospective_reconstruction',availableAt:day(24)});x.profiles.push({id:'opendota',currentSource:'opendota_retrospective',historyBasis:'reconstruction_only',sourcePinIds:['replay-source']});x.rowProfiles.push({rowId:'rebuilt',profileId:'opendota',observationId:null});
 const out=prepare(x);assert.deepEqual(out.samples.map(r=>r.profileId),['steam','opendota']);assert.equal(out.sourceAudit.every(r=>!r.pinnedBytesVerified),true);x.rowProfiles[1].profileId='steam';assert.throws(()=>prepare(x),/row_profile_binding/);
});

function liveFixture(){
 const x=fixture(),anchors=[...FIXED_LIVE_LANDMARK_SECONDS.map(s=>({label:String(s/60),game:s})),{label:'80+',game:5100}],iso=seconds=>new Date(Date.parse(day(2))+seconds*1000).toISOString();
 Object.assign(x.dataset.featureSchemas[0],{targetId:'LIVE_MAP_WIN',stateMode:'LIVE'});x.dataset.labelTables[0].targetIds=['LIVE_MAP_WIN'];
 Object.assign(x.dataset.rows[0],{targetId:'LIVE_MAP_WIN',stateMode:'LIVE',decisionAt:iso(299),eventAt:iso(297),historyCutoffAt:day(2)});x.rowProfiles[0].observationId='past';
 addRow(x,{rowId:'future-nearest',decisionAt:iso(301),eventAt:iso(300)});x.rowProfiles[1].observationId='future';
 x.landmarks={policy:{maximumGameAgeSeconds:2,maximumSourceStateAgeSeconds:10,overflowAnchorSeconds:5100},maps:[{mapId:'m1',seriesId:'s1',endedGameSecond:null,decisionAtByLandmark:Object.fromEntries(anchors.map(a=>[a.label,iso(a.game)])),activeSourceEpochByLandmark:Object.fromEntries(anchors.map(a=>[a.label,'epoch']))},{mapId:'m2',seriesId:'s1',endedGameSecond:100,decisionAtByLandmark:{},activeSourceEpochByLandmark:{}}],observations:[{observationId:'past',mapId:'m1',seriesId:'s1',gameSecond:299,status:'eligible',provenance:'synthetic',sourceEpoch:'epoch',sequence:0,barrier:false,availableAt:iso(298),sourceStateAt:iso(298)},{observationId:'future',mapId:'m1',seriesId:'s1',gameSecond:301,status:'eligible',provenance:'synthetic',sourceEpoch:'epoch',sequence:1,barrier:false,availableAt:iso(300.5),sourceStateAt:iso(300.5)}]};return x;
}

test('actual preparation consumes past-only landmark selections and keeps early-ended/missing risk sets',()=>{
 const x=liveFixture(),out=prepare(x);assert.equal(out.samples.length,1);assert.equal(out.samples[0].rowId,'r1');assert.equal(out.samples[0].landmark,'5');assert.ok(out.excluded.some(r=>r.rowId==='future-nearest'));const first=out.landmarks.summary[0],later=out.landmarks.summary[1];assert.equal(first.totalMaps,2);assert.equal(first.atRiskMaps,1);assert.equal(first.endedBeforeOrAt,1);assert.equal(first.selectedMaps,1);assert.equal(later.missingMaps,1);assert.equal(out.landmarks.summary.at(-1).label,'80+');assert.equal(out.landmarks.summary.at(-1).missingMaps,1);
});

test('a newer source STOP blocks prepared sample rather than shrinking denominator',()=>{
 const x=liveFixture();x.landmarks.observations.push({...x.landmarks.observations[0],observationId:'stop',sequence:2,status:'stop',barrier:true,availableAt:'2026-10-02T00:04:59.9Z',sourceStateAt:'2026-10-02T00:04:59.9Z'});x.landmarks.observations[1].availableAt='2026-10-02T00:04:59.5Z';x.landmarks.observations[1].sourceStateAt=x.landmarks.observations[1].availableAt;const out=prepare(x);assert.equal(out.samples.length,0);assert.equal(out.landmarks.summary[0].atRiskMaps,1);assert.equal(out.landmarks.summary[0].missingMaps,1);
});

test('live joins reject a row for another map/series, missing binding and absent age policy',()=>{
 const x=liveFixture();x.landmarks.observations[0].mapId='m2';assert.throws(()=>prepare(x),/row_live_observation_lineage/);
 const y=liveFixture();y.rowProfiles.pop();assert.throws(()=>prepare(y),/row_profile_missing/);
 const z=liveFixture();delete z.landmarks.policy.maximumGameAgeSeconds;assert.throws(()=>prepare(z),/landmark_policy/);
});

function learnedFixture(kind='target_encoding'){
 const x=fixture();x.dataset.series.push({seriesId:'s2',componentId:'c2',mapIds:['m3'],predictionStartAt:day(4),startAt:day(4),endAt:day(5),availableAt:'2026-10-05T01:00:00Z'});const row=addRow(x,{rowId:'application',seriesId:'s2',mapId:'m3',decisionAt:'2026-10-04T00:01:00Z',eventAt:day(4),historyCutoffAt:day(4),labelRowId:'label-m3',schemaSha256:H('1')});
 x.learnedStates=[{stateId:'state',kind,version:'frozen-v1',profileId:'synthetic-profile',projectionSha256:F,statePin:{id:'state-bytes',sha256:E,bytes:100},foldId:'forward-fold-1',trainingSeriesIds:['s1'],applicationSeriesIds:['s2'],fitCutoffAt:'2026-10-03T12:00:00Z',fittedAt:day(24),availableAt:day(24)}];
 const series=assign({series:x.dataset.series,splits:x.dataset.splits,createdAt:x.dataset.createdAt}),binding=stateBinding({series,state:x.learnedStates[0],createdAt:x.dataset.createdAt,dataset:x.dataset,rowProfiles:x.rowProfiles});
 x.dataset.featureSchemas.push({...structuredClone(x.dataset.featureSchemas[0]),id:'derived-schema',schemaSha256:row.schemaSha256,columns:[{id:'learned',semanticRole:'predictor',inputScopes:['prior_maps'],learnedStatePolicy:'TRAIN_fold_cohort_pinned',learnedStateBinding:binding}]});
 x.rowStateBindings=[{rowId:row.rowId,columnId:kind==='child_prediction'?'learned':null,stateId:'state',predictionPin:kind==='child_prediction'?{id:'prediction-bytes',sha256:H('2'),bytes:100}:null,predictedAt:kind==='child_prediction'?day(24):null}];return x;
}

test('learned state binds exact past TRAIN cohort, forward fold and grouped transform reference',()=>{
 const x=learnedFixture(),out=prepare(x);assert.equal(out.stateBindings.length,1);assert.equal(out.rowStateBindings[0].columnId,null);assert.equal(out.trainingAdmitted,false);assert.ok(out.requiredGates.includes('label_timing_and_fold_artifact_verification'));assert.equal(out.sourceAudit.every(r=>!r.originalPredictionTimingClaimed),true);
});

test('learned lineage rejects own series/component, future labels, non-TRAIN fitting and missing pins',()=>{
 const self=learnedFixture();self.learnedStates[0].trainingSeriesIds=['s2'];assert.throws(()=>prepare(self),/learned_state_train_only|learned_state_oof/);
 const linked=learnedFixture();linked.dataset.series[1].componentId='c1';assert.throws(()=>prepare(linked),/learned_state_oof/);
 const future=learnedFixture();future.dataset.series[0].availableAt=day(5);assert.throws(()=>prepare(future),/learned_state_train_only/);
 const nontrain=learnedFixture();nontrain.dataset.series[0].predictionStartAt=day(6);nontrain.dataset.series[0].startAt=day(7);nontrain.dataset.series[0].endAt=day(8);nontrain.dataset.series[0].availableAt=day(9);assert.throws(()=>prepare(nontrain),/row_future_or_materialization|learned_state_train_only/);
 const missing=learnedFixture();missing.rowStateBindings=[];assert.throws(()=>prepare(missing),/row_learned_state_missing/);
 const pin=structuredClone(learnedFixture());pin.dataset.featureSchemas[1].columns[0].learnedStateBinding.foldSha256='bad';assert.throws(()=>prepare(pin),/learned_column_binding/);
});

test('declared TRAIN input/label pin corrections invalidate old learned cohort binding',()=>{
 const x=learnedFixture();x.dataset.rows[0].inputSha256=H('3');assert.throws(()=>prepare(x),/row_learned_state_missing/);
 const y=learnedFixture();y.dataset.labelTables[0].sha256=H('4');assert.throws(()=>prepare(y),/row_learned_state_missing/);
});

test('child prediction requires exact column, prior state availability and separate prediction artifact',()=>{
 const x=learnedFixture('child_prediction');assert.equal(prepare(x).rowStateBindings[0].columnId,'learned');x.rowStateBindings[0].predictionPin.sha256=D;assert.throws(()=>prepare(x),/child_prediction_lineage/);
 const y=learnedFixture('child_prediction');y.rowStateBindings[0].predictedAt=day(23);assert.throws(()=>prepare(y),/child_prediction_lineage/);
 const z=learnedFixture('child_prediction');z.rowStateBindings[0].columnId=null;assert.throws(()=>prepare(z),/row_state_column_scope/);
});

test('separate exact projections retain separate weights and oversized sample expansion refuses',()=>{
 const x=fixture();x.dataset.featureSchemas.push({...structuredClone(x.dataset.featureSchemas[0]),id:'schema2',schemaSha256:H('5')});addRow(x,{rowId:'other-schema',schemaSha256:H('5')});const out=prepare(x);assert.deepEqual(out.samples.map(r=>r.weight),[1,1]);assert.notEqual(out.samples[0].schemaSha256,out.samples[1].schemaSha256);
 const y=liveFixture();y.dataset.limits={maxRows:2};y.landmarks.policy.maximumGameAgeSeconds=6000;y.landmarks.policy.maximumSourceStateAgeSeconds=6000;assert.throws(()=>prepare(y),/preparation_sample_bound/);
});

test('preparation metadata is admitted before clone/hash and never invokes accessor or Proxy code',()=>{
 const x=fixture();let touched=0;Object.defineProperty(x.dataset.policy,'snapshotWeightPolicy',{enumerable:true,get(){touched++;return'forbidden';}});assert.throws(()=>prepare(x),/preparation_plain_metadata/);assert.equal(touched,0);
 const y=fixture();y.dataset.policy.historyWindowPolicy='x'.repeat(FEATURE_PREPARATION_LIMITS.maxScalarCharacters+1);assert.throws(()=>prepare(y),/preparation_metadata_bound/);
 const z=fixture();z.dataset.policy=new Proxy(z.dataset.policy,{ownKeys(){touched++;throw Error('proxy_trap');}});assert.throws(()=>prepare(z),/preparation_plain_metadata/);assert.equal(touched,0);
});
