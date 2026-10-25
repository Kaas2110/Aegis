import test from 'node:test';
import assert from 'node:assert/strict';
import {createPinnedDatasetManifest as build,selectFixedMinuteLandmarks as select,FIXED_LIVE_LANDMARK_SECONDS} from './pinned-dataset-manifest.mjs';
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const date=day=>'2026-10-'+String(day).padStart(2,'0')+'T00:00:00Z';
const policy={historyWindowPolicy:'frozen explicit 30/90 day windows',patchPolicy:'exact letter patch recorded; no inferred weighting',snapshotWeightPolicy:'equal map then series weight declared before fitting',collectionAvailabilityPolicy:'complete series and collected labels available before split end',aggregateFitPolicy:'eligible_past_train_only',childPredictionPolicy:'chronological_out_of_fold_version_bound',holdoutPolicy:'inspected_holdout_is_not_untouched',refreshPolicy:'reuse_pinned_sources_no_automatic_refresh'};
function fixture(){return{datasetId:'synthetic-frozen-v1',createdAt:date(25),sourcePins:[{id:'source',sha256:A,bytes:100,provenance:'observed_live',availableAt:date(24)}],featureSchemas:[{id:'schema',sha256:B,bytes:100,schemaSha256:C,targetId:'LIVE_MAP_WIN',stateMode:'LIVE',columns:[{id:'history:map_count',semanticRole:'predictor',inputScopes:['prior_maps']}]}],labelTables:[{id:'labels',sha256:D,bytes:100,targetIds:['LIVE_MAP_WIN'],inputEligible:false}],splits:['train','tune','early_stop','holdout'].map((role,i)=>({role,startAt:date(1+i*5),endAt:date(6+i*5)})),series:[{seriesId:'series1',componentId:'component1',mapIds:['map1','map2'],predictionStartAt:date(1),startAt:date(2),endAt:date(3),availableAt:date(4),splitRole:'train'}],rows:[{rowId:'frame1',seriesId:'series1',mapId:'map1',targetId:'LIVE_MAP_WIN',stateMode:'LIVE',decisionAt:'2026-10-02T00:10:00Z',historyCutoffAt:date(2),historicalAvailability:{basis:'retained_as_of',maxKnownAt:date(1)},eventAt:'2026-10-02T00:09:59Z',inputKnownAt:'2026-10-02T00:09:59.1Z',collectedAt:'2026-10-02T00:09:59.2Z',materializedAt:date(24),replayHorizonAt:null,originalAvailability:'confirmed',provenance:'observed_live',sourcePinId:'source',schemaSha256:C,inputSha256:B,labelTableId:'labels',labelRowId:'result-map1'}],policy};}
const mutate=fn=>{const x=fixture();fn(x);return x;};
test('full dataset columns require exact new schema profile while legacy and aggregate metadata bounds remain',()=>{
 const x=fixture();x.featureSchemas[0].columns=Array.from({length:150001},(_,i)=>({id:'history:capacity_'+i,semanticRole:'predictor',inputScopes:['prior_maps']}));assert.throws(()=>build(x),/feature_schema/);
 Object.assign(x.featureSchemas[0],{schemaContract:'aegis.unified-feature-projection-schema.v2',capacityProfile:'R7_FULL300K'});const manifest=build(x);assert.equal(manifest.contract,'aegis.pinned-dataset-manifest.v2');assert.equal(manifest.capacityProfile,'R7_FULL300K');assert.equal(manifest.featureSchemas[0].columns.length,150001);assert.equal(manifest.sourceAvailabilityAttested,false);assert.equal(manifest.trainingAdmitted,false);
 const mismatch=fixture();Object.assign(mismatch.featureSchemas[0],{schemaContract:'aegis.unified-feature-projection-schema.v1',capacityProfile:'R7_FULL300K'});assert.throws(()=>build(mismatch),/legacy_profile_must_be_absent/);
 x.featureSchemas[0].columns=Array(300001);assert.throws(()=>build(x),/feature_schema/);
 const mixed=fixture();Object.assign(mixed.featureSchemas[0],{schemaContract:'aegis.unified-feature-projection-schema.v2',capacityProfile:'R7_FULL300K'});mixed.rows[0].inputKnownAt='2026-10-02T00:10:00.000000001Z';assert.throws(()=>build(mixed),/observed_availability/);
});
test('frozen manifest keeps whole series/maps and labels separate; makes no training/source claim',()=>{
 const x=fixture(),m=build(x);assert.equal(m.assignments[0].role,'train');assert.deepEqual(m.assignments[0].mapIds,['map1','map2']);assert.equal(m.counts.provenance.observed_live,1);assert.equal(m.trainingAdmitted,false);assert.equal(m.prospectiveCoverageAttested,false);assert.equal(m.qualityEvaluationPerformed,false);assert.equal(m.liveLandmarks.gameSeconds.length,16);x.series[0].mapIds.push('caller-change');assert.deepEqual(m.assignments[0].mapIds,['map1','map2']);assert.ok(Object.isFrozen(m.rows[0]));
});
test('series spanning a split or with future collection availability must be explicitly purged',()=>{
 assert.throws(()=>build(mutate(x=>x.series[0].endAt=date(7))),/series_times|crosses_split/);assert.throws(()=>build(mutate(x=>x.series[0].availableAt=date(7))),/crosses_split/);
 const x=mutate(x=>Object.assign(x.series[0],{endAt:date(7),availableAt:date(8),splitRole:'purged',purgeReason:'crosses_frozen_train_tune_boundary'}));assert.equal(build(x).counts.roles.purged,1);assert.throws(()=>build(mutate(x=>x.series[0].splitRole='purged')),/purge_reason/);
});
test('legitimate SERIES_PRE and PRE_MAP decisions precede actual series play under an explicit frozen prediction boundary',()=>{
 for(const targetId of ['PRE_MAP_WIN','SERIES_PRE']){
  const x=fixture(),stateMode=targetId==='SERIES_PRE'?'SERIES_PRE':'PRE';Object.assign(x.featureSchemas[0],{targetId,stateMode});x.labelTables[0].targetIds=[targetId];Object.assign(x.rows[0],{targetId,stateMode,mapId:targetId==='SERIES_PRE'?null:'map1',decisionAt:'2026-10-01T00:10:00Z',historyCutoffAt:date(1),eventAt:'2026-10-01T00:09:59Z',inputKnownAt:'2026-10-01T00:09:59.1Z',collectedAt:'2026-10-01T00:09:59.2Z'});
  const m=build(x);assert.equal(m.rows[0].decisionAt,'2026-10-01T00:10:00Z');assert.equal(m.assignments[0].role,'train');x.series[0].predictionStartAt='2026-10-01T00:11:00Z';assert.throws(()=>build(x),/row_future_or_materialization/);
 }
 assert.throws(()=>build(mutate(x=>x.series[0].predictionStartAt='2026-09-30T23:59:59Z')),/series_crosses_split/);
});
test('linked series, maps and row assignments cannot be split across roles or series',()=>{
 assert.throws(()=>build(mutate(x=>x.series.push({seriesId:'series2',componentId:'component1',mapIds:['map3'],predictionStartAt:date(6),startAt:date(7),endAt:date(8),availableAt:date(9),splitRole:'tune'}))),/linked_component_split/);
 assert.throws(()=>build(mutate(x=>x.series.push({seriesId:'series2',componentId:'component2',mapIds:['map1'],predictionStartAt:date(6),startAt:date(7),endAt:date(8),availableAt:date(9),splitRole:'tune'}))),/map_cross_series/);
 assert.throws(()=>build(mutate(x=>x.rows[0].mapId='outside')),/row_bindings/);assert.throws(()=>build(mutate(x=>x.rows[0].splitRole='holdout')),/row_unrecognized/);
});
test('label payloads/current-map-label scopes and same feature-label bytes are rejected',()=>{
 assert.throws(()=>build(mutate(x=>x.rows[0].winner=1)),/label_payload/);assert.throws(()=>build(mutate(x=>x.featureSchemas[0].columns[0].inputScopes=['current_map_label'])),/label_input_isolation/);assert.throws(()=>build(mutate(x=>x.featureSchemas[0].targetId='PRE_MAP_WIN')),/label_input_isolation|row_bindings|feature_schema/);assert.throws(()=>build(mutate(x=>x.labelTables[0].sha256=B)),/label_table_isolation/);assert.throws(()=>build(mutate(x=>x.rows[0].inputSha256=D)),/row_bindings/);
});
test('observed versus retrospective rows remain distinct; future horizons and fabricated original availability fail',()=>{
 assert.throws(()=>build(mutate(x=>x.rows[0].inputKnownAt='2026-10-02T00:10:00.000000001Z')),/observed_availability/);assert.throws(()=>build(mutate(x=>x.rows[0].eventAt='2026-10-02T00:10:00.000000001Z')),/row_future/);
 const x=fixture();Object.assign(x.sourcePins[0],{provenance:'retrospective_reconstruction'});Object.assign(x.rows[0],{provenance:'retrospective_reconstruction',originalAvailability:'unknown',inputKnownAt:null,replayHorizonAt:'2026-10-02T00:09:59Z'});const m=build(x);assert.equal(m.counts.provenance.retrospective_reconstruction,1);assert.equal(m.counts.provenance.observed_live,0);x.rows[0].replayHorizonAt='2026-10-02T00:10:01Z';assert.throws(()=>build(x),/replay_provenance/);
});
test('previously inspected holdout stays disclosed and separate tune/early-stop roles are mandatory',()=>{
 const x=fixture();x.series.push({seriesId:'holdout-series',componentId:'holdout-component',mapIds:['map3'],predictionStartAt:date(16),startAt:date(17),endAt:date(18),availableAt:date(19),splitRole:'holdout',holdoutInspected:true});const m=build(x);assert.equal(m.counts.inspectedHoldoutSeries,1);assert.equal(m.assignments[1].untouchedHoldout,false);assert.throws(()=>build(mutate(x=>x.splits[2].role='tune')),/split_roles/);assert.throws(()=>build(mutate(x=>x.splits[1].startAt=date(5))),/split_chronology/);
});
test('history cutoff evidence remains separate from observed-current provenance and late t1 cannot move t0',()=>{
 assert.throws(()=>build(mutate(x=>x.rows[0].historicalAvailability.maxKnownAt='2026-10-02T00:00:00.000000001Z')),/history_after_frozen_cutoff/);
 const x=mutate(x=>x.rows[0].historicalAvailability={basis:'reconstruction_only',maxKnownAt:null}),m=build(x);assert.equal(m.counts.provenance.observed_live,1);assert.equal(m.counts.historicalAvailability.reconstruction_only,1);assert.equal(m.sourceAvailabilityAttested,false);x.rows[0].historicalAvailability.maxKnownAt=date(1);assert.throws(()=>build(x),/history_original_availability_unknown/);
});
test('label row identities and every label table hash stay isolated from feature rows',()=>{
 assert.throws(()=>build(mutate(x=>x.rows.push({...x.rows[0],rowId:'frame2',mapId:'map2'}))),/label_cross_target_identity/);
 const x=fixture();x.labelTables.push({...x.labelTables[0],id:'other-labels',sha256:'e'.repeat(64)});x.rows[0].inputSha256='e'.repeat(64);assert.throws(()=>build(x),/row_bindings/);
});
function landmarkFixture(){const labels=[...FIXED_LIVE_LANDMARK_SECONDS.map(x=>String(x/60)),'80+'];const decisions=Object.fromEntries(labels.map((l,i)=>[l,'2026-10-02T'+(i<11?'00:':'01:')+String(i<11?(i+1)*5:(i-11)*5).padStart(2,'0')+':00Z']));const epoch=Object.fromEntries(labels.map(l=>[l,'source-epoch-1']));return{maps:[{mapId:'map1',seriesId:'series1',endedGameSecond:null,decisionAtByLandmark:decisions,activeSourceEpochByLandmark:epoch},{mapId:'map2',seriesId:'series2',endedGameSecond:200,decisionAtByLandmark:{},activeSourceEpochByLandmark:{}}],observations:[{observationId:'past',mapId:'map1',seriesId:'series1',sourceEpoch:'source-epoch-1',sequence:0,barrier:false,gameSecond:295,availableAt:'2026-10-02T00:04:56Z',sourceStateAt:'2026-10-02T00:04:55Z',status:'eligible',provenance:'observed_live'},{observationId:'future-game',mapId:'map1',seriesId:'series1',sourceEpoch:'source-epoch-1',sequence:1,barrier:false,gameSecond:301,availableAt:'2026-10-02T00:04:58Z',sourceStateAt:'2026-10-02T00:04:57Z',status:'eligible',provenance:'observed_live'},{observationId:'future-receipt',mapId:'map1',seriesId:'series1',sourceEpoch:'source-epoch-1',sequence:2,barrier:false,gameSecond:299,availableAt:'2026-10-02T00:05:00.000000001Z',sourceStateAt:'2026-10-02T00:04:59Z',status:'eligible',provenance:'observed_live'}],policy:{maximumGameAgeSeconds:30,maximumSourceStateAgeSeconds:30,overflowAnchorSeconds:5100}};}
test('fixed landmarks select last past and available frame; future frames never win by proximity',()=>{
 const out=select(landmarkFixture()),five=out.selections.find(r=>r.mapId==='map1'&&r.landmark==='5');assert.equal(five.observationId,'past');assert.equal(out.summary.length,17);assert.equal(out.summary[0].atRiskMaps,1);assert.equal(out.summary[0].endedBeforeOrAt,1);assert.equal(out.summary[0].observedSelectedMaps,1);assert.equal(out.summary[1].missingMaps,1);assert.equal(out.summary[1].atRiskMaps,1);assert.equal(out.prospectiveCoverageAttested,false);
});
test('missing/error/stale slots stay in denominator and repeated receipts do not renew source-state age',()=>{
 const x=landmarkFixture();x.observations=[{...x.observations[0],observationId:'repeat',gameSecond:299,availableAt:'2026-10-02T00:04:59Z',sourceStateAt:'2026-10-02T00:01:00Z'}];let out=select(x);assert.equal(out.summary[0].atRiskMaps,1);assert.equal(out.summary[0].selectedMaps,0);assert.equal(out.summary[0].missingMaps,1);
 x.observations[0].sourceStateAt=null;out=select(x);assert.equal(out.selections.find(r=>r.mapId==='map1'&&r.landmark==='5').reason,'source_state_age_unknown');
});
test('80+ anchor/age policies are frozen explicitly and source/series mismatches fail',()=>{
 const x=landmarkFixture();delete x.policy.overflowAnchorSeconds;assert.throws(()=>select(x),/landmark_policy/);const y=landmarkFixture();y.observations[0].seriesId='wrong';assert.throws(()=>select(y),/landmark_series/);const z=landmarkFixture();z.observations[0].sourceStateAt='2026-10-02T00:05:01Z';assert.throws(()=>select(z),/landmark_state_future/);
});
test('later error/stale/identity/continuity evidence blocks fallback; fresh qualified evidence can recover after a nonterminal barrier',()=>{
 for(const status of ['missing','error','stale']){
  const x=landmarkFixture();x.observations=[x.observations[0],{...x.observations[0],observationId:'barrier',sequence:1,gameSecond:299,availableAt:'2026-10-02T00:04:58Z',sourceStateAt:null,status,barrier:true}];let out=select(x),r=out.selections.find(r=>r.mapId==='map1'&&r.landmark==='5');assert.equal(r.observationId,null,status);assert.equal(r.reason,'source_barrier_blocks_older_observations',status);assert.equal(out.summary[0].atRiskMaps,1);
  x.observations.push({...x.observations[0],observationId:'requalified',sequence:2,gameSecond:299,availableAt:'2026-10-02T00:04:59Z',sourceStateAt:'2026-10-02T00:04:59Z'});out=select(x);r=out.selections.find(r=>r.mapId==='map1'&&r.landmark==='5');assert.equal(r.observationId,'requalified',status);
 }
});
test('identity/continuity require a new declared epoch and terminal/STOP never recover through a later frame',()=>{
 for(const status of ['identity_barrier','continuity_barrier','terminal','stop']){
  const x=landmarkFixture();x.observations=[x.observations[0],{...x.observations[0],observationId:'barrier',sequence:1,gameSecond:298,availableAt:'2026-10-02T00:04:58Z',sourceStateAt:null,status,barrier:true},{...x.observations[0],observationId:'later',sequence:2,gameSecond:299,availableAt:'2026-10-02T00:04:59Z',sourceStateAt:'2026-10-02T00:04:59Z'}];let out=select(x),r=out.selections.find(r=>r.mapId==='map1'&&r.landmark==='5');assert.equal(r.observationId,null,status);
  x.observations[2].sourceEpoch='source-epoch-2';x.maps[0].activeSourceEpochByLandmark['5']='source-epoch-2';out=select(x);r=out.selections.find(r=>r.mapId==='map1'&&r.landmark==='5');if(status==='terminal'||status==='stop'){assert.equal(r.observationId,null,status);assert.equal(r.reason,'source_terminal_or_stop_barrier');}else assert.equal(r.observationId,'later',status);
 }
});
test('active source epoch fences identity changes and malformed event order cannot renew availability',()=>{
 const x=landmarkFixture();x.observations=[x.observations[0],{...x.observations[0],observationId:'new-epoch',sourceEpoch:'source-epoch-2',sequence:1,gameSecond:299,availableAt:'2026-10-02T00:04:58Z',sourceStateAt:'2026-10-02T00:04:58Z'}];let out=select(x),r=out.selections.find(r=>r.mapId==='map1'&&r.landmark==='5');assert.equal(r.observationId,null);assert.equal(r.reason,'active_source_epoch_not_confirmed');x.maps[0].activeSourceEpochByLandmark['5']='source-epoch-2';out=select(x);assert.equal(out.selections.find(r=>r.mapId==='map1'&&r.landmark==='5').observationId,'new-epoch');
 x.observations.push({...x.observations[0],observationId:'old-epoch-reused',sequence:2,availableAt:'2026-10-02T00:04:59Z'});assert.throws(()=>select(x),/landmark_epoch_reuse/);
 const y=landmarkFixture();y.observations[1].sequence=0;assert.throws(()=>select(y),/landmark_event_order/);const z=landmarkFixture();z.maps[0].decisionAtByLandmark['10']=z.maps[0].decisionAtByLandmark['5'];assert.throws(()=>select(z),/landmark_decision_order/);
});
