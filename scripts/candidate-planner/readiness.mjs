/** Inspect existing artifacts separately from new-trigger matrix readiness. */
import {existsSync} from 'node:fs';
import {FAMILIES,comparePatch} from './candidate-planner.mjs';
import {child,digest,fileHash,instant,json,pinned,streamedPin,valueSha} from './evidence.mjs';
import {CONTRACT as COMPONENT_CONTRACT,verifyComponentFolds,instantNs} from './folds/strict_folds.mjs';
import {verifyBoundManifest} from './folds/bound.mjs';
import {resolve} from 'node:path';
import {validateHeadRegistryEntry} from './head-identity.mjs';
export function verifyGroupedSplits(rows,folds,componentEvidence){
 if(!componentEvidence)throw Error('complete_component_evidence_required');
 return verifyComponentFolds({contract:COMPONENT_CONTRACT,family:componentEvidence.family,
  scope:componentEvidence.scope,componentMembers:componentEvidence.componentMembers,
  mapRows:rows,folds}).folds;
}
const samePin=(a,b)=>a&&b&&a.sha256===b.sha256&&a.bytes===b.bytes&&resolve(a.path)===resolve(b.path);
function verifyPatchCoverage(m,rows,intent,review,exportMeta,budget){
 const triggers=intent.triggers.filter(t=>t.kind==='patch');if(!triggers.length)return null;
 if(!m.patchAssignments)throw Error('separate_patch_assignments_required');
 streamedPin(m.patchAssignments,budget);const doc=pinned(m.patchAssignments);
 if(doc.contract!=='aegis.dynamic-patch-assignments.v1'||doc.family!==m.family||!Array.isArray(doc.assignments)||doc.assignments.length!==rows.length)throw Error('patch_assignment_contract');
 const allowed=review.acceptedPatchAssignmentKinds;
 if(review.patchAssignmentsSha256!==m.patchAssignments.sha256||!Array.isArray(allowed)||!allowed.length||new Set(allowed).size!==allowed.length||allowed.some(k=>!['confirmed','calendar_inferred'].includes(k))||allowed.includes('calendar_inferred')&&review.calendarInferredPatchMembershipReviewed!==true)throw Error('explicit_patch_membership_review_required');
 const selected=new Map(rows.map(r=>[r.mapId,r])),assignments=new Map();
 for(const a of doc.assignments){
  if(!a||!selected.has(a.mapId)||assignments.has(a.mapId)||!['confirmed','calendar_inferred','unknown'].includes(a.assignmentKind))throw Error('patch_assignment_membership');
  if(a.assignmentKind==='unknown'){
   if(a.patchVersion!==null||a.sourceKnownAt!==null||a.sourceSha256!==null)throw Error('unknown_patch_must_remain_unknown');
  }else{
   comparePatch(a.patchVersion,a.patchVersion);
   if(!digest(a.sourceSha256)||instantNs(a.sourceKnownAt)>instantNs(exportMeta.asOf))throw Error('patch_source_after_export_or_unpinned');
  }
  assignments.set(a.mapId,a);
 }
 const counts=[];
 for(const trigger of triggers){
  const count=rows.filter(r=>{const a=assignments.get(r.mapId);return a.patchVersion===trigger.patchVersion&&allowed.includes(a.assignmentKind)&&instantNs(r.startTime)>=instantNs(trigger.releasedAt);}).length;
  if(count<m.minimumNewPatchMaps)throw Error('new_patch_TRAIN_coverage_below_policy');
  counts.push({triggerId:trigger.triggerId,patchVersion:trigger.patchVersion,maps:count,acceptedAssignmentKinds:[...allowed],membershipOnly:true,knownHistoricalFeatureClaim:false});
 }
 return {patchAssignmentsSha256:m.patchAssignments.sha256,counts};
}
function dynamicReady(spec,family,intent,now,budget){
 const m=pinned(spec);if(m.contract!=='aegis.dynamic-rich-matrix.v2'||m.family!==family||m.complete!==true||m.candidateOnly!==true||m.outerHoldoutRead!==false||instant(m.completedAt)>instant(now))throw Error('dynamic_matrix_v2_contract_required');
 if(m.scope==='full_frozen_TRAIN_inner'||m.sourceKind==='frozen_research_replay')throw Error('frozen_TRAIN_is_not_dynamic_trigger_data');
 if(!intent||!Array.isArray(intent.triggers)||!intent.triggers.length||JSON.stringify([...m.coveredTriggerIds].sort())!==JSON.stringify(intent.triggers.map(t=>t.triggerId).sort()))throw Error('intent_trigger_data_binding');
 if(!m.rawExport||!m.matrixFiles?.length||m.matrixFiles.length>128)throw Error('export_and_matrix_files_required');
 const exportMeta=pinned(m.rawExport);if(exportMeta.contract!=='aegis.rich-raw-export.v1'||exportMeta.complete!==true||exportMeta.partition!=='TRAIN'||exportMeta.providerFetchedDuringTraining!==false||instant(exportMeta.exportedAt)>instant(now))throw Error('raw_export_contract');
 for(const t of intent.triggers){if(instant(exportMeta.asOf)<instant(t.dueAt))throw Error('export_predates_trigger_due');}
 if(!Array.isArray(exportMeta.files)||!exportMeta.files.length||exportMeta.files.length>128)throw Error('raw_export_files_required');
 for(const file of [...exportMeta.files,...m.matrixFiles])streamedPin(file,budget);
 const rows=pinned(m.mapRows),folds=pinned(m.splits),features=pinned(m.featureContract),parity=pinned(m.phaseParity),review=pinned(m.reviewReceipt);
 if(features.contract!=='aegis.full-rich-feature-contract.v1'||features.family!==family||!Array.isArray(features.names)||!features.names.length||new Set(features.names).size!==features.names.length||features.names.length!==features.stateFeatures||features.prunedFeatures!==0)throw Error('complete_feature_inventory_required');
 const phase=family.startsWith('prematch_')?'prematch':family.startsWith('postdraft_')?'postdraft':family.startsWith('live_')?'live':'series';
 if(features.phase!==phase||features.unknownEncoding!=='NaN')throw Error('family_phase_and_unknown_contract');
 if(phase==='prematch'&&(features.phaseAsOf?.actualSidePermitted!==false||features.phaseAsOf?.actualDraftPermitted!==false||features.phaseAsOf?.unconfirmedRosterPermitted!==false))throw Error('prematch_forbidden_inputs_not_excluded');
 if(parity.contract!=='aegis.phase-parity.v1'||parity.family!==family||parity.featureContractSha256!==m.featureContract.sha256||parity.TRAINonly!==true||parity.status!=='PASS'||!parity.offlineBytes||!parity.servingBytes)throw Error('phase_parity_evidence_required');
 streamedPin(parity.offlineBytes,budget);streamedPin(parity.servingBytes,budget);if(parity.offlineBytes.sha256!==parity.servingBytes.sha256||parity.offlineBytes.bytes!==parity.servingBytes.bytes)throw Error('offline_serving_fixture_bytes_differ');
 if(!m.componentFolds)throw Error('complete_component_fold_manifest_required');
 const componentManifest=pinned(m.componentFolds),componentVerification=verifyBoundManifest(m.componentFolds);
 if(componentVerification.family!==family||!samePin(componentManifest.mapRows,m.mapRows)||!samePin(componentManifest.folds,m.splits)||componentVerification.bindings.sourceManifestSha256!==m.rawExport.sha256)throw Error('component_fold_matrix_binding_mismatch');
 if(instantNs(componentManifest.scope.asOf)!==instantNs(exportMeta.asOf)||instantNs(exportMeta.asOf)>instantNs(exportMeta.exportedAt)||instantNs(exportMeta.exportedAt)>instantNs(m.completedAt)||instantNs(m.completedAt)>instantNs(review.approvedAt)||instantNs(review.approvedAt)>instantNs(now))throw Error('dynamic_data_exact_chronology_required');
 if(componentVerification.metadataBytesVerified>budget.remaining)throw Error('component_metadata_verification_budget');
 budget.remaining-=componentVerification.metadataBytesVerified;
 const counts=componentVerification.folds;
 const minNew=m.minimumNewPatchMaps;if(!Number.isSafeInteger(minNew)||minNew<1)throw Error('explicit_new_patch_minimum_required');
 const patchCoverage=verifyPatchCoverage(m,rows,intent,review,exportMeta,budget);
 if(review.contract!=='aegis.dynamic-data-review.v2'||review.approved!==true||review.approvedBy!=='root'||review.family!==family||review.featureContractSha256!==m.featureContract.sha256||review.rawExportSha256!==m.rawExport.sha256||review.mapRowsSha256!==m.mapRows.sha256||review.splitsSha256!==m.splits.sha256||review.phaseParitySha256!==m.phaseParity.sha256||review.componentFoldsSha256!==m.componentFolds.sha256||review.componentIdentityPolicySha256!==componentVerification.bindings.componentIdentityPolicySha256||review.protectionPolicySha256!==componentVerification.bindings.protectionPolicySha256||review.componentMembershipReviewed!==true||review.embargoSeconds!==86400||review.fullInventoryRetained!==true||review.phaseAsOfReviewed!==true||review.purchaseLineage!=='corrected_v4'||instant(review.approvedAt)>instant(now))throw Error('explicit_dynamic_data_review_v2_required');
 return {ready:true,datasetManifestSha256:spec.sha256,splitManifestSha256:m.splits.sha256,featureContractSha256:m.featureContract.sha256,componentFoldManifestSha256:m.componentFolds.sha256,componentIdentityPolicySha256:componentVerification.bindings.componentIdentityPolicySha256,protectionPolicySha256:componentVerification.bindings.protectionPolicySha256,embargoSeconds:componentVerification.embargoSeconds,causalLiveParityVerified:true,groupedTemporalSplitVerified:true,folds:counts,patchCoverage,features:features.names.length,coveredTriggerIds:m.coveredTriggerIds,phase:features.phase,scope:'new_trigger_dynamic_TRAIN_candidate_only'};
}
export function observeReadiness(config,intent,now){
 const families={},budget={remaining:config.maximumVerificationBytes??2147483648,verified:new Set()};
 if(!Number.isSafeInteger(budget.remaining)||budget.remaining<1||budget.remaining>4294967296)throw Error('bounded_verification_bytes_required');
 for(const family of FAMILIES){
  const c=config.dataFamilies?.[family]??{},available=[];
  for(const spec of c.availableFrozenArtifacts??[]){
   try{const d=pinned(spec);available.push({manifestSha256:spec.sha256,complete:d.complete===true,scope:d.scope??'recorded_research_artifact',features:d.features??d.stateFeatures??null,prospectiveReceiptValidated:d.prospectiveReceiptValidated===true,matrixBytesVerified:0,claim:'manifest identity only; not new-trigger data readiness'});}catch{available.push({manifestSha256:spec.sha256,status:'invalid_or_changed'});}
  }
  try{if(!c.dynamicManifest)throw Error('dynamic_raw_export_matrix_and_phase_review_missing');families[family]={...dynamicReady(c.dynamicManifest,family,intent,now,budget),availableFrozenArtifacts:available};}
  catch(error){families[family]={ready:false,reasons:[error.message],availableFrozenArtifacts:available};}
 }
 return {contract:'aegis.dynamic-data-readiness.v1',observedAt:now,verifiedFileBinding:true,families,verifiedMatrixAndFixtureBytes:(config.maximumVerificationBytes??2147483648)-budget.remaining,monthlyAnchorCreated:false,nativeFits:0};
}
export function observeBindings(config,readiness,now){
 try{
  const r=pinned(config.runnerRegistry),families=[],heads=[];
  if(r.contract!=='aegis.dynamic-rich-runner-registry.v2'||r.approvedBy!=='root'||r.approved!==true||r.policyId!==config.policyId||instant(r.approvedAt)>instant(now)||instant(r.expiresAt)<=instant(now))throw Error('approved_registry_v2_missing_or_expired');
  for(const f of FAMILIES){
   if(!readiness.families[f].ready)throw Error('dynamic_family_data_missing:'+f);
   for(const {head,adapter:x} of validateHeadRegistryEntry(f,r.families?.[f])){
    if(fileHash(x.source.path)!==x.source.sha256)throw Error('adapter_source_pin');
    const recipe=pinned(x.recipe);
    if(recipe.backend!=='lightgbm'||recipe.rounds!==256||recipe.parameters?.num_threads!==4||recipe.parameters?.feature_fraction!==1||recipe.parameters?.feature_fraction_bynode!==1||recipe.parameters?.feature_pre_filter!==false||recipe.earlyStopping!==false||recipe.featurePruning!==false)throw Error('fixed_rich_recipe_required');
    heads.push({family:f,head,sourceSha256:x.source.sha256,recipeSha256:x.recipe.sha256});
   }
   families.push(f);
  }
  if(heads.length!==10)throw Error('ten_distinct_family_heads_required');
  return {contract:'aegis.dynamic-runner-binding.v2',verifiedFileBinding:true,status:'approved_dynamic_rich_runner',policyId:config.policyId,approvedAt:r.approvedAt,expiresAt:r.expiresAt,dispatchEnabled:false,publicPromotion:false,runnerManifestSha256:config.runnerRegistry.sha256,featureContractSha256:valueSha(Object.fromEntries(families.map(f=>[f,readiness.families[f].featureContractSha256]))),resourceGuardSha256:r.resourceGuardSha256,families,heads,headCount:heads.length,expectedNativeFits:heads.length*4,scope:'new_dynamic_candidate_contract',oneNativeFit:true,threads:4,rssLimitBytes:16000000000,minimumFreeBytes:4294967296};
 }catch(error){return {verifiedFileBinding:true,status:'unavailable',reason:error.message,dispatchEnabled:false,publicPromotion:false};}
}
