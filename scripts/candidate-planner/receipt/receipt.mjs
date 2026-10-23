/** Assemble completed candidate evidence. Never trains, dispatches or approves quality. */
import {createHash} from 'node:crypto';
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,readSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {verifyBoundManifest} from '../folds/bound.mjs';
import {instantNs} from '../folds/strict_folds.mjs';
export const FAMILIES=['prematch_map_winner','postdraft_map_winner','live_map_winner','prematch_kills_total','prematch_duration_total','live_kills_total','live_duration_total','series_winner'];
export const SERIES_HEADS=['p_current_map','q_series_if_current_won','q_series_if_current_lost'];
export const stable=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(stable).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const need=(x,r)=>{if(!x)throw Error(r);};
const same=(a,b)=>stable(a)===stable(b);
export const instant=instantNs;
export function fitIdentity(policyId,intentId,family,fold,head){
 need(typeof policyId==='string'&&policyId.length>0&&digest(intentId)&&FAMILIES.includes(family)&&Number.isSafeInteger(fold)&&fold>=0&&fold<4,'bounded_fit_identity');
 need((family==='series_winner'?SERIES_HEADS:['main']).includes(head),'exact_family_head');
 return {contract:'aegis.rich-fit-identity.v2',policyId,intentId,family,fold,head};
}
export const fitId=x=>sha(Buffer.from(stable(fitIdentity(x.policyId,x.intentId,x.family,x.fold,x.head))));
export function expectedFits(policyId,intentId){return FAMILIES.flatMap(f=>Array.from({length:4},(_,fold)=>(f==='series_winner'?SERIES_HEADS:['main']).map(head=>fitIdentity(policyId,intentId,f,fold,head))).flat());}
function file(path,max){
 need(isAbsolute(path),'absolute_file_required');let p=resolve(path);
 while(true){if(existsSync(p))need(!lstatSync(p).isSymbolicLink(),'reparse_path_rejected');const parent=dirname(p);if(p===parent)break;p=parent;}
 const st=lstatSync(path);need(st.isFile()&&st.size<=max,'bounded_regular_file_required');return st;
}
export function descriptor(path){const b=readFileSync(path);return {path:resolve(path),bytes:b.length,sha256:sha(b)};}
function pinned(ref,state,{json=true,max=8*1024**2}={}){
 need(ref&&digest(ref.sha256)&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0,'exact_evidence_descriptor');
 const key=ref.path+'|'+ref.sha256+'|'+ref.bytes;
 if(state.cache.has(key))return state.cache.get(key);
 need(ref.bytes<=max&&ref.bytes<=state.remaining,'evidence_read_budget');const st=file(ref.path,Math.min(max,state.remaining));need(st.size===ref.bytes,'evidence_size_changed');
 state.remaining-=st.size;const h=createHash('sha256');let b;
 if(json){b=readFileSync(ref.path);h.update(b);}else{const fd=openSync(ref.path,'r'),chunk=Buffer.alloc(1024**2);try{for(let n;(n=readSync(fd,chunk,0,chunk.length,null))>0;)h.update(chunk.subarray(0,n));}finally{closeSync(fd);}}
 need(h.digest('hex')===ref.sha256,'evidence_hash_changed');const value=json?JSON.parse(b.toString('utf8').replace(/^\uFEFF/,'')):true;
 state.cache.set(key,value);state.refs.push({...ref,json});return value;
}
function exactKeys(o,keys,reason){need(o&&typeof o==='object'&&!Array.isArray(o)&&same(Object.keys(o).sort(),[...keys].sort()),reason);}
const pins=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,v.sha256]));
function metrics(x,family){
 const required=family.endsWith('_total')?['mae','nll','interval90Coverage','meanWidth90']:['accuracy','brier','logloss'];
 need(x&&typeof x==='object'&&!Array.isArray(x)&&required.every(k=>typeof x[k]==='number'&&Number.isFinite(x[k])&&x[k]>=0),'event_specific_finite_metrics_required');
 if(family.endsWith('_total'))need(x.interval90Coverage<=1,'coverage_probability_range');else need(x.accuracy<=1&&x.brier<=1,'winner_metric_probability_range');
}
export function review(config,now){
 need(config?.contract==='aegis.whole-intent-receipt-config.v1'&&typeof config.policyId==='string'&&digest(config.intentId),'whole_intent_config');
 const at=instant(now);need(Number.isSafeInteger(config.maximumVerificationBytes)&&config.maximumVerificationBytes>=1024&&config.maximumVerificationBytes<=4*1024**3,'bounded_verification_budget');
 const state={remaining:config.maximumVerificationBytes,cache:new Map(),refs:[]};
 const intent=pinned(config.intent,state),body={...intent};delete body.contentHash;
 need(intent.version==='rich-candidate-intent-planner.v1'&&intent.intentId===config.intentId&&intent.identity?.policyId===config.policyId&&sha(Buffer.from(stable(intent.identity)))===config.intentId&&sha(Buffer.from(stable(body)))===intent.contentHash,'immutable_intent_binding');
 need(intent.candidateOnly===true&&intent.dispatchEnabled===false&&intent.publicPromotion===false&&same([...intent.identity.families].sort(),[...FAMILIES].sort()),'candidate_all_eight_intent');
 need(Array.isArray(intent.triggers)&&intent.triggers.length>=1&&intent.triggers.length<=2&&intent.triggers.every(t=>digest(t.triggerId)&&instant(t.dueAt)<=at)&&new Set(intent.triggers.map(t=>t.triggerId)).size===intent.triggers.length,'due_unique_trigger_identity');
 const covered=intent.triggers.map(t=>t.triggerId).sort();need(same([...intent.identity.triggerIds].sort(),covered),'no_dropped_intent_trigger');
 need(instant(intent.createdAt)<=at,'intent_in_future');
 exactKeys(config.datasets,FAMILIES,'all_eight_dataset_refs');
 const datasets={},datasetPins={};
 for(const family of FAMILIES){
  const m=pinned(config.datasets[family],state);datasetPins[family]=config.datasets[family].sha256;
  need(m.contract==='aegis.dynamic-rich-matrix.v2'&&m.family===family&&m.complete===true&&m.candidateOnly===true&&m.outerHoldoutRead===false&&m.sourceKind!=='frozen_research_replay'&&m.scope!=='full_frozen_TRAIN_inner','new_dynamic_family_dataset');
  need(Array.isArray(m.coveredTriggerIds)&&same([...m.coveredTriggerIds].sort(),covered)&&instant(m.completedAt)<=at,'dataset_full_trigger_coverage');
  const raw=pinned(m.rawExport,state),feature=pinned(m.featureContract,state,{max:32*1024**2}),splits=pinned(m.splits,state),rows=pinned(m.mapRows,state),parity=pinned(m.phaseParity,state),semantic=pinned(m.reviewReceipt,state),target=pinned(m.targetContract,state);
  need(raw.contract==='aegis.rich-raw-export.v1'&&raw.complete===true&&raw.partition==='TRAIN'&&raw.providerFetchedDuringTraining===false&&instant(raw.asOf)<=instant(raw.exportedAt)&&instant(raw.exportedAt)<=instant(m.completedAt)&&intent.triggers.every(t=>instant(t.dueAt)<=instant(raw.asOf))&&same([...raw.coveredTriggerIds].sort(),covered)&&Array.isArray(raw.files)&&raw.files.length>=1&&raw.files.length<=128,'real_raw_export_provenance_and_chronology');
  for(const ref of raw.files)pinned(ref,state,{json:false,max:2*1024**3});
  need(Array.isArray(m.matrixFiles)&&m.matrixFiles.length>=1&&m.matrixFiles.length<=128,'actual_family_matrix_files_required');
  for(const ref of m.matrixFiles)pinned(ref,state,{json:false,max:2*1024**3});
  need(feature.contract==='aegis.full-rich-feature-contract.v1'&&feature.family===family&&feature.unknownEncoding==='NaN'&&feature.prunedFeatures===0&&Array.isArray(feature.names)&&feature.names.length>0&&feature.names.length===feature.stateFeatures&&new Set(feature.names).size===feature.names.length,'full_family_feature_inventory');
  need(Array.isArray(rows)&&rows.length>0&&rows.length<=100000&&Array.isArray(splits)&&splits.length===4,'four_frozen_family_folds');
  const component=pinned(m.componentFolds,state);
  const samePin=(a,b)=>a&&b&&resolve(a.path).toLowerCase()===resolve(b.path).toLowerCase()&&a.bytes===b.bytes&&a.sha256===b.sha256;
  need(component.family===family&&samePin(component.mapRows,m.mapRows)&&samePin(component.folds,m.splits)&&component.scope?.sourceManifestSha256===m.rawExport.sha256,'component_family_source_rows_and_folds_bound');
  need(instant(component.scope.asOf)===instant(raw.asOf),'component_scope_raw_asof_identity');
  pinned(component.componentMembers,state,{max:32*1024**2});
  const splitProof=verifyBoundManifest(m.componentFolds);need(splitProof.status==='metadata_verified'&&splitProof.family===family&&splitProof.embargoSeconds===86400,'whole_component_splits_verified');
  need(parity.contract==='aegis.phase-parity.v1'&&parity.family===family&&parity.status==='PASS'&&parity.TRAINonly===true&&parity.featureContractSha256===m.featureContract.sha256,'family_phase_parity_required');
  pinned(parity.offlineBytes,state,{json:false,max:32*1024**2});pinned(parity.servingBytes,state,{json:false,max:32*1024**2});need(parity.offlineBytes.sha256===parity.servingBytes.sha256&&parity.offlineBytes.bytes===parity.servingBytes.bytes,'phase_parity_actual_bytes_differ');
  const phase=family.startsWith('prematch_')?'prematch':family.startsWith('postdraft_')?'postdraft':family.startsWith('live_')?'live':'series';need(feature.phase===phase,'family_feature_phase');
  if(phase==='prematch')need(feature.phaseAsOf?.actualSidePermitted===false&&feature.phaseAsOf?.actualDraftPermitted===false&&feature.phaseAsOf?.unconfirmedRosterPermitted===false,'prematch_forbidden_input_policy');
  const heads=family==='series_winner'?SERIES_HEADS:['main'];
  need(target.contract==='aegis.rich-family-target.v1'&&target.family===family,'explicit_family_target_contract');exactKeys(target.headTargets,heads,'head_target_inventory');exactKeys(target.recipes,heads,'head_recipe_inventory');
  const expectedMeaning=family==='series_winner'?'series_winner':family.endsWith('kills_total')?'final_map_kills':family.endsWith('duration_total')?'final_map_duration':'map_winner';
  need(target.familyOutcome?.meaning===expectedMeaning&&target.familyOutcome.representation===(family.endsWith('_total')?'final':'binary')&&(family.endsWith('duration_total')?['seconds','minutes'].includes(target.familyOutcome.unit):target.familyOutcome.unit===(family.endsWith('kills_total')?'kills':'binary')),'explicit_final_family_target_units');
  for(const head of heads){const spec=target.headTargets[head],recipe=pinned(target.recipes[head],state);need(spec&&spec.unit===target.familyOutcome.unit&&['final','remaining','binary'].includes(spec.representation),'explicit_head_target_units');if(family==='series_winner')need(spec.meaning===(head==='p_current_map'?'map_winner':'series_winner')&&spec.representation==='binary'&&spec.conditionOnCurrentMapOutcome===(head==='p_current_map'?null:head==='q_series_if_current_won'?'won':'lost'),'series_head_target_condition');else need(spec.meaning===expectedMeaning&&spec.representation===(family.endsWith('_total')?(phase==='live'?'remaining':'final'):'binary'),'phase_head_target_representation');need(recipe.backend==='lightgbm'&&recipe.rounds===256&&recipe.parameters?.num_threads===4&&recipe.parameters.feature_fraction===1&&recipe.parameters.feature_fraction_bynode===1&&recipe.parameters.feature_pre_filter===false&&recipe.earlyStopping===false&&recipe.featurePruning===false&&same(recipe.target,spec),'reviewed_head_recipe_target_binding');}
  need(semantic.contract==='aegis.dynamic-data-review.v2'&&semantic.family===family&&semantic.approved===true&&semantic.approvedBy==='root'&&digest(semantic.rawExportSha256)&&semantic.rawExportSha256===m.rawExport.sha256&&semantic.mapRowsSha256===m.mapRows.sha256&&semantic.splitsSha256===m.splits.sha256&&semantic.featureContractSha256===m.featureContract.sha256&&semantic.phaseParitySha256===m.phaseParity.sha256&&semantic.targetContractSha256===m.targetContract.sha256&&semantic.fullInventoryRetained===true&&semantic.phaseAsOfReviewed===true&&semantic.purchaseLineage==='corrected_v4'&&instant(semantic.approvedAt)<=at,'family_explicit_semantic_review');
  need(semantic.componentFoldsSha256===m.componentFolds.sha256&&semantic.componentIdentityPolicySha256===component.scope.componentIdentityPolicySha256&&semantic.protectionPolicySha256===component.scope.protectionPolicySha256&&semantic.componentMembershipReviewed===true&&semantic.embargoSeconds===86400,'review_component_membership_and_policy_pins');
  // Exact component folds and parity bytes are checked above. Independent
  // semantic review must also bind them; these checks do not approve model quality.
  need(instant(m.completedAt)<=instant(semantic.approvedAt),'semantic_review_before_dataset_completed');
  datasets[family]={manifest:m,features:feature.stateFeatures,semanticApprovedAt:semantic.approvedAt,target};
 }
 const expected=expectedFits(config.policyId,config.intentId),keys=expected.map(fitId);
 need(keys.length===40&&new Set(keys).size===40,'expected_forty_head_fits');
 exactKeys(config.fits,keys,'all_forty_fit_closures_required');
 const results={},evaluations={},closures={},models={},intervals=[],summaries=[];
 for(const identity of expected){
  const key=fitId(identity),refs=config.fits[key];exactKeys(refs,['result','evaluation','closure','artifactFiles'],'fit_result_evaluation_closure_refs');
  const r=pinned(refs.result,state),e=pinned(refs.evaluation,state),c=pinned(refs.closure,state),d=datasets[identity.family];
  need(r.contract==='aegis.rich-fit-result.v2'&&r.status==='fit_complete'&&same(r.identity,identity)&&r.fitId===key&&r.nativeFits===1&&r.trees===256&&r.stateFeatures===d.features&&r.candidateAxisFeatures===(identity.family.endsWith('_total')?1:0)&&r.featureCount===r.stateFeatures+r.candidateAxisFeatures&&r.fullInventoryRetained===true&&r.serializedParity===true&&r.noOuterHoldout===true&&r.candidateOnly===true&&r.publicPromotion===false,'one_head_native_full_fit_result');
  need(r.bindings&&['planSha256','approvalSha256','recipeSha256'].every(k=>digest(r.bindings[k]))&&r.bindings.datasetManifestSha256===config.datasets[identity.family].sha256&&r.bindings.featureContractSha256===d.manifest.featureContract.sha256&&r.bindings.splitManifestSha256===d.manifest.splits.sha256,'fit_exact_dataset_recipe_bindings');
  need(r.bindings.recipeSha256===d.target.recipes[identity.head].sha256,'exact_reviewed_head_recipe');
  need(e.contract==='aegis.rich-fit-evaluation.v1'&&e.complete===true&&e.candidateOnly===true&&e.publicPromotion===false&&e.fitId===key&&e.fitBindingsSha256===sha(Buffer.from(stable(r.bindings)))&&e.modelArtifactsSha256===sha(Buffer.from(stable(r.artifacts)))&&e.datasetManifestSha256===r.bindings.datasetManifestSha256&&e.splitManifestSha256===r.bindings.splitManifestSha256&&e.fold===identity.fold&&e.family===identity.family&&e.head===identity.head&&e.scope==='new_dynamic_TRAIN_candidate_only'&&instant(e.completedAt)<=at,'separate_completed_fit_evaluation');
  need(Number.isSafeInteger(e.validationMaps)&&e.validationMaps>0&&Number.isSafeInteger(e.validationGroups)&&e.validationGroups>0&&e.validationGroups<=e.validationMaps&&e.repeatedFramesIndependent===false&&e.outerHoldoutRead===false&&typeof e.metrics==='object'&&e.metrics!==null&&!Array.isArray(e.metrics),'evaluation_support_and_scope');
  metrics(e.metrics,identity.family);
  need(e.targetContractSha256===d.manifest.targetContract.sha256&&same(e.target,d.target.headTargets[identity.head]),'evaluation_target_units_and_representation');
  need(c.contract==='aegis.single-native-fit-closure.v1'&&c.fitId===key&&c.resultSha256===refs.result.sha256&&c.nativeFits===1&&c.exitCode===0&&c.exitObserved===true&&c.monitoringValid===true&&c.familyCleanupConfirmed===true&&c.ownershipLocksRetained===false&&c.forcedTermination===false&&c.automaticRetry===false&&c.threads===4&&Number.isFinite(c.peakAggregateRssBytes)&&c.peakAggregateRssBytes>0&&c.peakAggregateRssBytes<16000000000&&Number.isFinite(c.minimumAvailableBytes)&&c.minimumAvailableBytes>=4294967296,'actual_single_fit_successful_resource_closure');
  const from=instant(c.startedAt),to=instant(c.endedAt);need(instant(intent.createdAt)<=from&&instant(d.manifest.completedAt)<=from&&instant(d.semanticApprovedAt)<=from&&from<to&&to<=at&&to<=instant(e.completedAt),'fit_closure_chronology');intervals.push({key,from,to});
  need(r.artifacts&&typeof r.artifacts==='object'&&!Array.isArray(r.artifacts)&&Object.keys(r.artifacts).length>=2&&Object.keys(r.artifacts).length<=64,'fit_artifact_inventory');
  exactKeys(refs.artifactFiles,Object.keys(r.artifacts),'all_fit_artifact_file_bindings');
  for(const [name,artifactHash] of Object.entries(r.artifacts)){need(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,255}$/.test(name)&&!name.split('/').some(p=>p==='.'||p==='..'||!p)&&digest(artifactHash),'relative_artifact_name_and_hash');const pin=refs.artifactFiles[name];need(pin?.sha256===artifactHash,'fit_artifact_descriptor_binding');pinned(pin,state,{json:false,max:1024**3});models[key+'/'+name]=pin;}
  results[key]=refs.result.sha256;evaluations[key]=refs.evaluation.sha256;closures[key]=refs.closure.sha256;
  summaries.push({fitId:key,identity,validationMaps:e.validationMaps,validationGroups:e.validationGroups,metrics:e.metrics,evaluation:refs.evaluation,completedAt:e.completedAt});
 }
 intervals.sort((a,b)=>a.from<b.from?-1:a.from>b.from?1:0);for(let i=1;i<intervals.length;i++)need(intervals[i].from>=intervals[i-1].to,'native_fit_intervals_overlap');
 exactKeys(config.familyEvaluations,FAMILIES,'all_eight_assembled_family_evaluations');
 const familyReports={};
 for(const family of FAMILIES){
  const e=pinned(config.familyEvaluations[family],state),familyIds=expected.filter(i=>i.family===family).map(fitId).sort();
  need(e.contract==='aegis.rich-family-evaluation.v1'&&e.complete===true&&e.family===family&&e.intentId===config.intentId&&e.datasetManifestSha256===config.datasets[family].sha256&&same([...e.fitIds].sort(),familyIds)&&same(e.evaluationPins,Object.fromEntries(familyIds.map(k=>[k,evaluations[k]])))&&e.outerHoldoutRead===false&&e.repeatedFramesIndependent===false&&e.foldsFrozen===true&&e.wholeComponentUncertainty===true&&digest(e.predictionAssemblySha256)&&instant(e.completedAt)<=at,'assembled_family_evaluation_required');
  if(family==='series_winner')need(e.bothConditionalBranchesEvaluated===true&&e.futureActualCurrentOutcomeUsed===false,'series_both_branches_not_three_isolated_head_scores');
  need(summaries.filter(s=>s.identity.family===family).every(s=>instant(s.completedAt)<=instant(e.completedAt)),'family_evaluation_before_its_fits_evaluated');
  metrics(e.metrics,family);familyReports[family]=e;
  need(e.targetContractSha256===datasets[family].manifest.targetContract.sha256&&same(e.target,datasets[family].target.familyOutcome),'assembled_family_final_target_units');
 }
 const approval=pinned(config.reviewReceipt,state);
 need(approval.contract==='aegis.whole-intent-evaluation-review.v1'&&approval.approved===true&&approval.approvedBy==='root'&&approval.intentId===config.intentId&&approval.policyId===config.policyId&&approval.intentSha256===config.intent.sha256&&same(approval.datasetPins,datasetPins)&&same(approval.resultPins,results)&&same(approval.evaluationPins,evaluations)&&same(approval.closurePins,closures)&&same(approval.familyEvaluationPins,pins(config.familyEvaluations))&&approval.expectedNativeFits===40&&approval.fullInventoryRetained===true&&approval.wholeComponent24hSplitsVerified===true&&approval.phaseParityVerified===true&&approval.allFamilyEvaluationsReviewed===true&&approval.noOuterHoldout===true&&approval.publicPromotion===false&&instant(approval.approvedAt)<=at,'explicit_whole_intent_root_review_not_fit_or_export_anchor');
 need(Object.values(familyReports).every(e=>instant(e.completedAt)<=instant(approval.approvedAt)),'whole_review_before_family_evaluation');
 need(!config.stopMarkerPaths?.some(p=>existsSync(p)),'manual_stop_no_receipt');
 const completedAt=Object.values(familyReports).reduce((last,e)=>instant(e.completedAt)>instant(last)?e.completedAt:last,Object.values(familyReports)[0].completedAt);
 return {intent,covered,datasetPins,results,evaluations,closures,models,summaries,familyReports,state,completedAt};
}
export function writeReceipt(config,now){
 const r=review(config,now),out=resolve(config.outputRoot);need(isAbsolute(config.outputRoot)&&!existsSync(out),'new_absolute_receipt_output');
 let parent=dirname(out);while(true){need(existsSync(parent)&&!lstatSync(parent).isSymbolicLink(),'output_parent_reparse_or_missing');const up=dirname(parent);if(up===parent)break;parent=up;}
 return commit(config,now,r,out);
}
function commit(config,now,r,out){
 const outputParent=lstatSync(dirname(out));need(outputParent.isDirectory()&&!outputParent.isSymbolicLink(),'existing_regular_output_parent');
 for(const ref of r.state.refs)need(!resolve(ref.path).startsWith(out+sep)&&resolve(ref.path)!==out,'outputs_separate_from_inputs');
 // Revalidate file identities before publishing. No source/control is rewritten.
 const recheck={remaining:config.maximumVerificationBytes,cache:new Map(),refs:[]};for(const {json,...ref} of r.state.refs)pinned(ref,recheck,{json,max:json?32*1024**2:2*1024**3});
 need(!config.stopMarkerPaths?.some(p=>existsSync(p)),'manual_stop_before_receipt');mkdirSync(out);
 const put=(name,doc)=>{const p=join(out,name);writeFileSync(p,JSON.stringify(JSON.parse(stable(doc)),null,2)+'\n',{flag:'wx',encoding:'utf8'});return descriptor(p);};
 const datasets=put('DATASET-MANIFEST.json',{contract:'aegis.whole-intent-datasets.v1',intentId:config.intentId,temporalSplitFrozen:true,candidateOnly:true,publicPromotion:false,datasets:config.datasets,wholeComponent24hSplitsReviewed:true,phaseParityReviewed:true,reviewReceipt:config.reviewReceipt});
 const artifacts=put('ARTIFACT-MANIFEST.json',{contract:'aegis.whole-intent-artifacts.v1',intentId:config.intentId,candidateOnly:true,publicPromotion:false,nativeFits:40,fitResults:r.results,evaluations:r.evaluations,closures:r.closures,files:r.models});
 const report=put('REPORT.json',{contract:'aegis.whole-intent-evaluation-report.v1',status:'evaluation_complete',policyId:config.policyId,intentId:config.intentId,completedAt:r.completedAt,families:FAMILIES,coveredTriggerIds:r.covered,artifactManifestSha256:artifacts.sha256,datasetManifestSha256:datasets.sha256,nativeFits:40,newNativeFitsByWriter:0,modelLoads:0,providerCalls:0,folds:[0,1,2,3],fitSummaries:r.summaries,familyReports:r.familyReports,qualityApproved:false,deploymentApproved:false,independentHoldoutEvaluated:false,publicPromotion:false,metricsCombinedAcrossDifferentEvents:false});
 const receipt=put('EVALUATION-RECEIPT.json',{contract:'aegis.whole-intent-evaluation-receipt.v1',status:'evaluation_complete',policyId:config.policyId,intentId:config.intentId,completedAt:r.completedAt,verifiedAt:now,families:FAMILIES,coveredTriggerIds:r.covered,report,artifactManifest:artifacts,datasetManifest:datasets,candidateOnly:true,publicPromotion:false,qualityApproved:false,monthlyAnchorEligible:true,anchorMeaning:'all_eight_candidate_evaluations_completed_not_quality_or_deployment_approval'});
 const complete=put('COMPLETE.json',{contract:'aegis.whole-intent-receipt-complete.v1',complete:true,receipt,report,artifactManifest:artifacts,datasetManifest:datasets,reviewReceipt:config.reviewReceipt,nativeFits:40,newNativeFits:0,publicPromotion:false});
 return {receipt,complete};
}
