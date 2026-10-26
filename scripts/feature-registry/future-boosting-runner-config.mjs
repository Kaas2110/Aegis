/** Closed preparation contracts, not executable runners. Distribution metadata
 * does not admit imports, fits, source data, model quality or public outputs. */
import {FEATURE_PREPARATION_MODES,FIXED_LIVE_LANDMARK_SECONDS} from './pinned-dataset-manifest.mjs';
import {digest} from './registry-contract.mjs';
import {measureBoundedJsonBytes,snapshotPlainRecord} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
const HASH=/^[a-f0-9]{64}$/,BACKENDS=['lightgbm','catboost','xgboost'];
const fail=reason=>{throw Error('future_boosting_config:'+reason);};
const keys=(value,expected)=>{const record=snapshotPlainRecord(value,{maxKeys:expected.length});if(Object.keys(record).sort().join(',')!==[...expected].sort().join(','))fail('closed_record');return record;};
const freeze=value=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};
/** The receipt is recorded by a separate metadata-only host command. It is not
 * a capability: config keeps every execution/source/native gate unadmitted. */
export function validateBoostingBackendMetadata(input){
 measureBoundedJsonBytes(input,{maxBytes:16384,maxNodes:1000,maxDepth:4});
 const r=keys(input,['contract','discovery','recordedAt','pythonVersion','platform','backends','nativeImports','fits','providerCalls','runtimeActivation']);
 if(r.contract!=='aegis.boosting-backend-metadata.v1'||r.discovery!=='stdlib_importlib_metadata_only_no_backend_import'||typeof r.recordedAt!=='string'||!Number.isFinite(Date.parse(r.recordedAt))||typeof r.pythonVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(r.pythonVersion)||typeof r.platform!=='string'||!['Windows','Linux','Darwin'].includes(r.platform)||!Array.isArray(r.backends)||r.backends.length!==3||r.nativeImports!==false||r.fits!==0||r.providerCalls!==0||r.runtimeActivation!==false)fail('metadata_receipt');
 const backends=r.backends.map(value=>{const b=keys(value,['name','status','version','importUsability']);if(!BACKENDS.includes(b.name)||!['distribution_found','distribution_not_found','metadata_error'].includes(b.status)||b.importUsability!=='not_tested'||(b.status==='distribution_found'?(typeof b.version!=='string'||b.version.length<1||b.version.length>64):b.version!==null))fail('backend_metadata');return b;});
 if(new Set(backends.map(b=>b.name)).size!==3)fail('backend_metadata');return freeze({...r,backends});
}
/** One descriptor per existing phase/target pair. Totals CDF heads are a named
 * future candidate, not a replacement of the total target by a mean regression.
 * No grid/threshold labels are materialized until training is separately allowed. */
export function createFutureBoostingRunnerConfiguration({backendMetadata,backend='lightgbm',globalSplitSha256,preparedSamplesSha256,profileId,maxThreads=4}={}){
 const metadata=validateBoostingBackendMetadata(backendMetadata);
 if(!BACKENDS.includes(backend)||!HASH.test(globalSplitSha256??'')||!HASH.test(preparedSamplesSha256??'')||typeof profileId!=='string'||profileId.length<1||profileId.length>256||!Number.isInteger(maxThreads)||maxThreads<1||maxThreads>4)fail('configuration');
 const binaryParameters={lightgbm:{objective:'binary',num_threads:maxThreads,feature_fraction:1,feature_fraction_bynode:1,feature_pre_filter:false},catboost:{loss_function:'Logloss',thread_count:maxThreads,rsm:1,task_type:'CPU'},xgboost:{objective:'binary:logistic',nthread:maxThreads,colsample_bytree:1,colsample_bylevel:1,colsample_bynode:1,device:'cpu'}}[backend];
 const runners=FEATURE_PREPARATION_MODES.map(mode=>{
  const series=mode.targetId.startsWith('SERIES_'),live=mode.stateMode==='LIVE'||mode.stateMode==='observed_live',totals=mode.outputKind==='coherent_totals_distribution',units=mode.targetId.endsWith('_DURATION')?'seconds':mode.targetId.endsWith('_KILLS')?'kills':'binary',orientation=series?'nominal_team1_win':totals?null:'radiant_win';
  return{targetId:mode.targetId,stateMode:mode.stateMode,profileId,featurePolicy:'full_qualified_set_before_selection',featureCoordinates:'stable_feature_function_and_producer_compatibility_plus_exact_row_bindings',featureRepresentation:'float64_values_and_explicit_missing_mask',label:{scope:series?'whole_series':'selected_map',units,orientation,quantity:totals?(live?'remaining':'final'):'winner',source:'separate_pinned_target_label_only',futureResultAsFeature:false},
   objective:totals?{family:'discrete_conditional_cdf_via_boosted_binary_threshold_heads',candidateOnly:true,backendParameters:{...binaryParameters},thresholdGrid:'predeclared_from_prior_train_fold_only_not_holdout_or_bookmaker_outcome',thresholdLabels:'remaining_or_final_target <= threshold_in_declared_units',observedOffset:live?'add_exact_current_map_observed_value_to_remaining_distribution':'zero',support:'remaining>=0;final>=current_observed',coherence:'ordered_monotone_cdf_required_after_training',pushProbability:'explicit_mass_at_integer_kill_line',calibration:'prior_train_fold_only; separate_verified_artifact',output:'one_coherent_distribution_then_all_line_probabilities'}:{family:'binary_probability',backendParameters:{...binaryParameters},output:'probability_of_declared_orientation'},
   variants:live?{pooled:'same_profile_with_literal_minute_and_full_features',specialists:{landmarkSeconds:[...FIXED_LIVE_LANDMARK_SECONDS],lateGroup:'80+',oneLateGroupAfter80:true},comparison:'same_eligible_maps_and_landmarks_with_risk_set_counts'}:series?{shared:'format_score_previous_maps_context',stageSpecific:'only_if_support_sufficient; BO1_BO3_BO5_explicit'}:{phaseSpecific:true},
   routing:{surface:series?'main_card':'selected_map_detail',preserveSelectedMapIdentity:!series,currentMapOutcomeCannotChooseSeriesScenario:true},
   admission:{execution:false,sourceProofVerified:false,labelDependenciesVerified:false,nativeBackendVerified:false,adapterImplemented:false,requiredAdapterContract:'aegis.paged-private-proof-boosting-runner.v1',legacyCandidateAdapterCompatible:false}};
 });
 const body={contract:'aegis.future-boosting-runner-configuration.v1',backend,backendMetadata:metadata.backends.find(b=>b.name===backend),metadataReceiptSha256:digest(metadata),globalSplitSha256,preparedSamplesSha256,profileId,maxThreads,runners,
  common:{independentSplitUnit:'global_series_or_linked_component',splitRoles:['train','tune','early_stop','holdout'],sampleWeightPolicy:'one_unit_per_series_then_equal_maps_then_selected_samples_within_stable_estimator_profile_role',perRowLineage:'preserve_all_child_state_OOF_raw_vector_binding_label_pins',learnedCoordinateCompatibility:'not_admitted_without_verified_coordinate_contract',hyperparameters:'future_finite_development_only_search; no_search_started',earlyStopping:'early_stop_role_only_never_holdout',holdout:'locked_not_read_by_preparation',sourcePolicy:'frozen_causal_local_history_plus_one_coherent_current_steam_profile_for_live',sourceAvailability:'required_separate_admission_not_inferred_from_metadata_or_pins',resources:'one_owned_fit_four_threads_at_most_with_explicit_OS_arena_headroom_STOP_lease_required',experiments:{ageDecay:'not_default_future_gated_experiment',patchWeights:'not_default_future_gated_experiment',featureSelection:'after_full_feature_baseline',compressionDimension:'not_fixed_future_gated_experiment'}},
  trainingAdmitted:false,executionAdmitted:false,nativeImports:false,modelFits:0,qualityEvaluationPerformed:false,runtimeActivation:false};
 return freeze({...body,sha256:digest(body)});
}
