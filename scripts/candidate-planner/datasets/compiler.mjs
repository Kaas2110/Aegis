/** Compile only existing, pinned dynamic family evidence. No feature algebra or fit. */
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {streamedPin,localFile,digest,valueSha,sha} from '../evidence.mjs';
import {FAMILIES,SERIES_HEADS,canonical} from '../head-identity.mjs';
import {instantNs} from '../folds/strict_folds.mjs';
import {verifyBoundManifest} from '../folds/bound.mjs';
const need=(ok,why)=>{if(!ok)throw Error(why);};
const same=(a,b)=>canonical(a)===canonical(b);
const samePin=(a,b)=>a&&b&&resolve(a.path).toLowerCase()===resolve(b.path).toLowerCase()&&a.bytes===b.bytes&&a.sha256===b.sha256;
const pin=path=>{const b=readFileSync(path);return{path:resolve(path),bytes:b.length,sha256:sha(b)};};
function exactKeys(x,keys,reason){need(x&&typeof x==='object'&&!Array.isArray(x)&&same(Object.keys(x).sort(),[...keys].sort()),reason);}
function read(ref,budget,max=32*1024**2){need(ref&&Number.isSafeInteger(ref.bytes)&&ref.bytes<=max,'bounded_metadata_pin_required');streamedPin(ref,budget);localFile(ref.path,max);return JSON.parse(readFileSync(ref.path,'utf8').replace(/^\uFEFF/,''));}
function allPins(list,budget,reason){need(Array.isArray(list)&&list.length>=1&&list.length<=128,reason);for(const p of list)streamedPin(p,budget);}
function ancestors(p){need(typeof p==='string'&&isAbsolute(p),'absolute_new_output_required');let a=dirname(resolve(p));while(true){need(existsSync(a)&&lstatSync(a).isDirectory()&&!lstatSync(a).isSymbolicLink(),'existing_unaliased_output_parent');const up=dirname(a);if(up===a)break;a=up;}}
function targetContract(ref,family,phase,budget){
 const t=read(ref,budget),heads=family==='series_winner'?SERIES_HEADS:['main'];
 need(t.contract==='aegis.rich-family-target.v1'&&t.family===family,'explicit_family_target');exactKeys(t.headTargets,heads,'target_heads_required');exactKeys(t.recipes,heads,'target_recipes_required');
 const totals=family.endsWith('_total'),meaning=family==='series_winner'?'series_winner':family.endsWith('kills_total')?'final_map_kills':family.endsWith('duration_total')?'final_map_duration':'map_winner';
 need(t.familyOutcome?.meaning===meaning&&t.familyOutcome.representation===(totals?'final':'binary')&&(family.endsWith('duration_total')?['seconds','minutes'].includes(t.familyOutcome.unit):t.familyOutcome.unit===(family.endsWith('kills_total')?'kills':'binary')),'family_outcome_units');
 for(const head of heads){const h=t.headTargets[head],r=read(t.recipes[head],budget);need(h?.unit===t.familyOutcome.unit,'head_units');
  if(family==='series_winner')need(h.meaning===(head==='p_current_map'?'map_winner':'series_winner')&&h.representation==='binary'&&h.conditionOnCurrentMapOutcome===(head==='p_current_map'?null:head==='q_series_if_current_won'?'won':'lost'),'conditional_series_target');
  else need(h.meaning===meaning&&h.representation===(totals?(phase==='live'?'remaining':'final'):'binary'),'head_target_phase');
  need(r.backend==='lightgbm'&&r.rounds===256&&r.parameters?.num_threads===4&&r.parameters.feature_fraction===1&&r.parameters.feature_fraction_bynode===1&&r.parameters.feature_pre_filter===false&&r.earlyStopping===false&&r.featurePruning===false&&same(r.target,h),'complete_fixed_recipe_target');
 }return t;
}
function adapterEvidence(ref,bundle,features,rows,target,raw,budget){
 const a=read(ref,budget),heads=bundle.family==='series_winner'?SERIES_HEADS:['main'];
 need(a.contract==='aegis.rich-adapter-dataset.v1'&&a.family===bundle.family&&a.phase===features.phase&&a.TRAINonly===true&&a.outerHoldoutRead===false&&a.featureContractSha256===bundle.featureContract.sha256&&a.splitManifestSha256===bundle.splits.sha256&&a.rawExportSha256===bundle.rawExport.sha256&&a.targetContractSha256===bundle.targetContract.sha256,'adapter_dataset_exact_family_bindings');
 const samples=read(a.sampleRows,budget);need(Array.isArray(samples)&&samples.length>0&&samples.length<=500000,'bounded_sample_rows');const maps=new Map(rows.map(r=>[r.mapId,r])),ids=new Set();
 for(const s of samples){const m=maps.get(s.mapId);need(typeof s.sampleId==='string'&&s.sampleId.length>0&&!ids.has(s.sampleId)&&m,'sample_map_and_unique_identity');ids.add(s.sampleId);
  need(['recorded','historical_reconstruction'].includes(s.timestampBasis)&&instantNs(s.featureKnownAt)<=instantNs(s.predictionAt)&&instantNs(m.predictionAt)<=instantNs(s.predictionAt)&&instantNs(s.predictionAt)<=instantNs(raw.asOf),'sample_causal_known_at');
  need(s.observedAt===null||instantNs(s.observedAt)<=instantNs(s.predictionAt),'sample_observation_after_prediction');
  if(bundle.family==='series_winner'){need(s.seriesId===m.seriesId&&s.observed_context&&typeof s.observed_context==='object','series_observed_context');exactKeys(s.observed_context,['best_of','wins_R','wins_D','need_R','need_D','map_position'],'series_context_no_realized_outcome');}
 }
 exactKeys(a.labels,heads,'adapter_exact_head_labels');for(const head of heads){const l=a.labels[head];need(l&&same(l.target,target.headTargets[head])&&typeof l.targetMeaning==='string'&&l.targetMeaning.length>0,'adapter_label_explicit_target');streamedPin(l.values,budget);}
 need(Array.isArray(a.folds)&&a.folds.length===4&&a.folds.every((f,i)=>f.fold===i),'adapter_four_index_folds');for(const f of a.folds){streamedPin(f.trainIndices,budget);streamedPin(f.validationIndices,budget);}
 need(a.rowCount===samples.length&&a.stateFeatures===features.names.length&&['unit_per_sample','equal_series'].includes(a.weightPolicy)&&!a.weights,'explicit_supported_weight_policy');
 need(a.source?.featureContractSha256===bundle.featureContract.sha256&&a.source.rowCount===samples.length&&a.source.stateFeatures===features.names.length,'full_source_shape_and_columns');
 if(a.source?.kind==='materialized_npy'){need(bundle.matrixFiles.some(p=>samePin(p,a.source.matrix)),'full_materialized_matrix_binding');streamedPin(a.source.matrix,budget);}
 else{need(a.source?.kind==='reviewed_lazy_factory'&&a.source.entryPoint==='open_source'&&a.source.contract==='aegis.rich-feature-source.v1'&&a.source.parameters&&typeof a.source.parameters==='object'&&!Array.isArray(a.source.parameters),'explicit_lazy_source_factory');streamedPin(a.source.module,budget);allPins(a.source.dataFiles,budget,'lazy_source_files');need(a.source.dataFiles.every(p=>bundle.matrixFiles.some(q=>samePin(p,q))),'all_lazy_data_files_bound');}
 return{sampleRows:samples.length,sourceKind:a.source.kind,heads:[...heads],arrayValuesValidated:false,indexValuesValidated:false,featureAlgebraExecuted:false};
}
function patchEvidence(bundle,intent,rows,raw,budget){
 const triggers=intent.triggers.filter(t=>t.kind==='patch');if(!triggers.length){need(bundle.patchAssignments===null||bundle.patchAssignments===undefined,'monthly_patch_assignments_not_required');return{assignments:null,accepted:['confirmed'],counts:{}};}
 const p=read(bundle.patchAssignments,budget),accepted=bundle.acceptedPatchAssignmentKinds??['confirmed'];need(p.contract==='aegis.dynamic-patch-assignments.v1'&&p.family===bundle.family&&Array.isArray(p.assignments),'patch_assignment_contract');
 need(Array.isArray(accepted)&&accepted.length>0&&accepted.length<=2&&new Set(accepted).size===accepted.length&&accepted.every(k=>['confirmed','calendar_inferred'].includes(k)),'explicit_patch_membership_policy');
 const maps=new Map(rows.map(r=>[r.mapId,r])),assigned=new Map();
 for(const a of p.assignments){need(maps.has(a.mapId)&&!assigned.has(a.mapId)&&['confirmed','calendar_inferred','unknown'].includes(a.assignmentKind),'exact_patch_assignment_map');
  need(instantNs(a.sourceKnownAt)<=instantNs(raw.asOf),'patch_source_after_snapshot');
  need(a.assignmentKind==='unknown'?a.patchVersion===null:typeof a.patchVersion==='string'&&/^\d+\.\d+[a-z]?$/.test(a.patchVersion)&&digest(a.sourceSha256),'patch_version_source_evidence');assigned.set(a.mapId,a);
 }need(assigned.size===maps.size,'all_selected_patch_assignments');const counts={};
 for(const t of triggers){need(typeof t.patchVersion==='string'&&/^\d+\.\d+[a-z]?$/.test(t.patchVersion),'explicit_exact_patch_version');counts[t.triggerId]=[...assigned.values()].filter(a=>a.patchVersion===t.patchVersion&&accepted.includes(a.assignmentKind)&&instantNs(maps.get(a.mapId).startTime)>=instantNs(t.releasedAt)).length;need(counts[t.triggerId]>=bundle.minimumNewPatchMaps,'insufficient_new_patch_maps');}
 return{assignments:p,accepted,counts};
}
export function inspectInputs(bundle,now){
 need(bundle?.contract==='aegis.dynamic-family-inputs.v1'&&FAMILIES.includes(bundle.family)&&typeof bundle.policyId==='string'&&digest(bundle.intentId),'family_inputs_contract');
 need(Number.isSafeInteger(bundle.maximumVerificationBytes)&&bundle.maximumVerificationBytes>=1024&&bundle.maximumVerificationBytes<=4*1024**3,'bounded_dataset_verification_budget');
 need(Array.isArray(bundle.stopMarkerPaths)&&bundle.stopMarkerPaths.every(p=>typeof p==='string'&&isAbsolute(p))&&!bundle.stopMarkerPaths.some(p=>existsSync(p)),'manual_stop_or_invalid_paths');
 const budget={remaining:bundle.maximumVerificationBytes,verified:new Set()},at=instantNs(now),intent=read(bundle.intent,budget),body={...intent};delete body.contentHash;
 need(intent.version==='rich-candidate-intent-planner.v1'&&intent.identity?.policyId===bundle.policyId&&intent.intentId===bundle.intentId&&valueSha(intent.identity)===bundle.intentId&&valueSha(body)===intent.contentHash&&same([...intent.identity.families].sort(),[...FAMILIES].sort()),'full_intent_content_identity');
 need(intent.candidateOnly===true&&intent.dispatchEnabled===false&&intent.publicPromotion===false&&instantNs(intent.createdAt)<=at,'candidate_intent_time');
 need(Array.isArray(intent.triggers)&&intent.triggers.length>=1&&intent.triggers.length<=2&&new Set(intent.triggers.map(t=>t.triggerId)).size===intent.triggers.length&&intent.triggers.every(t=>digest(t.triggerId)&&['patch','monthly'].includes(t.kind)&&instantNs(t.dueAt)<=at),'bounded_due_triggers');
 const covered=intent.triggers.map(t=>t.triggerId).sort();need(same([...intent.identity.triggerIds].sort(),covered),'full_coalesced_trigger_identity');
 const raw=read(bundle.rawExport,budget),admission=read(bundle.rawExportAdmission,budget);
 need(raw.contract==='aegis.rich-raw-export.v1'&&raw.complete===true&&raw.partition==='TRAIN'&&raw.providerFetchedDuringTraining===false&&raw.trainable===false&&raw.featureProjectionRequired===true&&raw.actualLive===false&&raw.protectedLabelsRead===0&&same([...raw.coveredTriggerIds].sort(),covered),'admitted_TRAIN_raw_export');
 need(admission.contract==='aegis.intent-raw-export-stage-observation.v1'&&admission.intentId===bundle.intentId&&admission.rawSnapshotVerified===true&&admission.rawStageOnly===true&&samePin(admission.rawExport,bundle.rawExport)&&samePin(admission.sourceManifest,raw.sourceSnapshotManifest)&&same([...admission.coveredTriggerIds].sort(),covered)&&instantNs(admission.sourceAsOf)===instantNs(raw.asOf)&&instantNs(admission.observedAt)<=at,'saved_raw_admission_bound');
 read(raw.sourceSnapshotManifest,budget);allPins(raw.files,budget,'raw_export_files');allPins(bundle.matrixFiles,budget,'actual_matrix_files');
 need(instantNs(intent.createdAt)<=instantNs(raw.asOf)&&intent.triggers.every(t=>instantNs(t.dueAt)<=instantNs(raw.asOf))&&instantNs(raw.asOf)<=instantNs(raw.exportedAt)&&instantNs(raw.exportedAt)<=instantNs(bundle.completedAt)&&instantNs(bundle.completedAt)<=at,'raw_matrix_exact_chronology');
 const features=read(bundle.featureContract,budget),rows=read(bundle.mapRows,budget),component=read(bundle.componentFolds,budget),parity=read(bundle.phaseParity,budget);
 const phase=bundle.family.startsWith('prematch_')?'prematch':bundle.family.startsWith('postdraft_')?'postdraft':bundle.family.startsWith('live_')?'live':'series';
 need(features.contract==='aegis.full-rich-feature-contract.v1'&&features.family===bundle.family&&features.phase===phase&&features.unknownEncoding==='NaN'&&features.prunedFeatures===0&&Array.isArray(features.names)&&features.names.length>0&&features.names.length===features.stateFeatures&&new Set(features.names).size===features.names.length,'full_inventory_phase_contract');
 if(phase==='prematch')need(features.phaseAsOf?.actualSidePermitted===false&&features.phaseAsOf?.actualDraftPermitted===false&&features.phaseAsOf?.unconfirmedRosterPermitted===false,'prematch_future_input_policy');
 need(component.family===bundle.family&&samePin(component.mapRows,bundle.mapRows)&&samePin(component.folds,bundle.splits)&&component.scope.sourceManifestSha256===bundle.rawExport.sha256&&instantNs(component.scope.asOf)===instantNs(raw.asOf),'whole_component_input_identity');
 const folds=verifyBoundManifest(bundle.componentFolds);need(folds.metadataBytesVerified<=budget.remaining,'component_metadata_read_budget');budget.remaining-=folds.metadataBytesVerified;
 need(parity.contract==='aegis.phase-parity.v1'&&parity.family===bundle.family&&parity.featureContractSha256===bundle.featureContract.sha256&&parity.TRAINonly===true&&parity.status==='PASS','existing_phase_parity_required');streamedPin(parity.offlineBytes,budget);streamedPin(parity.servingBytes,budget);need(parity.offlineBytes.bytes===parity.servingBytes.bytes&&parity.offlineBytes.sha256===parity.servingBytes.sha256,'actual_offline_serving_parity_bytes');
 need(Number.isSafeInteger(bundle.minimumNewPatchMaps)&&bundle.minimumNewPatchMaps>=1,'explicit_minimum_new_patch_maps');
 const target=targetContract(bundle.targetContract,bundle.family,phase,budget),adapter=adapterEvidence(bundle.adapterDataset,bundle,features,rows,target,raw,budget),patch=patchEvidence(bundle,intent,rows,raw,budget);
 return{intent,raw,component,features,folds,adapter,patch,covered,verifiedBytes:bundle.maximumVerificationBytes-budget.remaining};
}
function proposal(bundle,r){return{contract:'aegis.dynamic-data-review.v2',family:bundle.family,approved:false,approvedBy:null,approvedAt:null,rawExportSha256:bundle.rawExport.sha256,mapRowsSha256:bundle.mapRows.sha256,splitsSha256:bundle.splits.sha256,featureContractSha256:bundle.featureContract.sha256,phaseParitySha256:bundle.phaseParity.sha256,targetContractSha256:bundle.targetContract.sha256,adapterDatasetSha256:bundle.adapterDataset.sha256,componentFoldsSha256:bundle.componentFolds.sha256,componentIdentityPolicySha256:r.component.scope.componentIdentityPolicySha256,protectionPolicySha256:r.component.scope.protectionPolicySha256,patchAssignmentsSha256:bundle.patchAssignments?.sha256??null,acceptedPatchAssignmentKinds:r.patch.accepted,calendarInferredPatchMembershipReviewed:false,componentMembershipReviewed:false,embargoSeconds:86400,fullInventoryRetained:true,phaseAsOfReviewed:false,purchaseLineage:null,requiredPurchaseLineage:'corrected_v4',proposalOnly:true,fitAuthorized:false,dispatchEnabled:false,publicPromotion:false};}
export function compileDataset(bundle,now){
 const r=inspectInputs(bundle,now),out=resolve(bundle.outputRoot);ancestors(bundle.outputRoot);need(!existsSync(out),'new_dataset_output_required');inspectInputs(bundle,now);need(!bundle.stopMarkerPaths.some(p=>existsSync(p)),'manual_stop_before_dataset_commit');mkdirSync(out);
 const put=(name,doc)=>{const p=join(out,name);writeFileSync(p,JSON.stringify(doc,null,2)+'\n',{flag:'wx',encoding:'utf8'});return pin(p);};
 const review=put('REVIEW-PROPOSAL.json',proposal(bundle,r));
 const manifest={contract:'aegis.dynamic-rich-matrix.v2',family:bundle.family,policyId:bundle.policyId,intentId:bundle.intentId,complete:true,candidateOnly:true,outerHoldoutRead:false,sourceKind:'admitted_dynamic_family_projection',scope:'new_dynamic_TRAIN_inner',completedAt:bundle.completedAt,coveredTriggerIds:r.covered,rawExport:bundle.rawExport,rawExportAdmission:bundle.rawExportAdmission,matrixFiles:bundle.matrixFiles,featureContract:bundle.featureContract,mapRows:bundle.mapRows,splits:bundle.splits,componentFolds:bundle.componentFolds,phaseParity:bundle.phaseParity,targetContract:bundle.targetContract,adapterDataset:bundle.adapterDataset,patchAssignments:bundle.patchAssignments??null,minimumNewPatchMaps:bundle.minimumNewPatchMaps,reviewReceipt:review};
 const manifestPin=put('MANIFEST.json',manifest),complete=put('COMPLETE.json',{contract:'aegis.dynamic-family-compilation.v1',complete:true,manifest:manifestPin,reviewProposal:review,compiledAt:now,family:bundle.family,heads:r.adapter.heads,expectedFamilyNativeFits:r.adapter.heads.length*4,wholeIntentFamilies:8,wholeIntentHeads:10,wholeIntentExpectedNativeFits:40,verifiedBytes:r.verifiedBytes,metadataAndOpaqueBytesVerified:true,arrayValuesValidated:false,indexValuesValidated:false,featureAlgebraExecuted:false,rootReviewRequired:true,ready:false,nativeFits:0,providerCalls:0,fitAuthorized:false,dispatchEnabled:false,publicPromotion:false});
 return{manifest:manifestPin,reviewProposal:review,complete,status:'compiled_pending_independent_review',ready:false,nativeFits:0,providerCalls:0,dispatchEnabled:false,publicPromotion:false};
}
export function verifyDataset(bundle,manifestRef,now){
 const r=inspectInputs(bundle,now),budget={remaining:bundle.maximumVerificationBytes,verified:new Set()},m=read(manifestRef,budget),review=read(m.reviewReceipt,budget);
 need(m.contract==='aegis.dynamic-rich-matrix.v2'&&m.family===bundle.family&&m.policyId===bundle.policyId&&m.intentId===bundle.intentId&&m.complete===true&&m.candidateOnly===true&&m.outerHoldoutRead===false&&m.sourceKind==='admitted_dynamic_family_projection'&&m.scope==='new_dynamic_TRAIN_inner'&&same(m.coveredTriggerIds,r.covered)&&m.completedAt===bundle.completedAt,'compiled_manifest_identity');
 for(const key of ['rawExport','rawExportAdmission','featureContract','mapRows','splits','componentFolds','phaseParity','targetContract','adapterDataset'])need(samePin(m[key],bundle[key]),'compiled_manifest_evidence_binding');
 need(same(m.matrixFiles,bundle.matrixFiles)&&same(m.patchAssignments,bundle.patchAssignments??null)&&m.minimumNewPatchMaps===bundle.minimumNewPatchMaps,'compiled_matrix_and_patch_bindings');
 const p=proposal(bundle,r);for(const[key,value]of Object.entries(p)){if(['approved','approvedBy','approvedAt','proposalOnly','phaseAsOfReviewed','componentMembershipReviewed','calendarInferredPatchMembershipReviewed','purchaseLineage'].includes(key))continue;need(same(review[key],value),'compiled_review_exact_evidence');}
 const approved=review.approved===true&&review.approvedBy==='root'&&review.proposalOnly===false&&review.phaseAsOfReviewed===true&&review.componentMembershipReviewed===true&&review.purchaseLineage==='corrected_v4'&&instantNs(bundle.completedAt)<=instantNs(review.approvedAt)&&instantNs(review.approvedAt)<=instantNs(now)&&(!r.patch.accepted.includes('calendar_inferred')||review.calendarInferredPatchMembershipReviewed===true);
 need(review.approved===false||approved,'invalid_semantic_review_state');
 return{status:approved?'metadata_and_review_verified':'metadata_verified_review_pending',family:bundle.family,coveredTriggerIds:r.covered,heads:r.adapter.heads,verifiedBytes:r.verifiedBytes,ready:approved,featureAlgebraExecuted:false,arrayValuesValidated:false,nativeFits:0,providerCalls:0,fitAuthorized:false,dispatchEnabled:false,publicPromotion:false};
}
