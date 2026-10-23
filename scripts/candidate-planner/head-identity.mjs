/** Pure v2 identities and result metadata. No IO, claims, fits or activation. */
import {createHash}from'node:crypto';
export const IDENTITY_CONTRACT='aegis.rich-fit-identity.v2';
export const RESULT_CONTRACT='aegis.rich-fit-result.v2';
export const APPROVAL_CONTRACT='aegis.single-fit-root-approval.v2';
export const PLAN_CONTRACT='aegis.rich.single-fit-plan.v2';
export const ADAPTER_CONTRACT='aegis.rich-fit-adapter.v2';
export const FAMILIES=Object.freeze(['prematch_map_winner','postdraft_map_winner','live_map_winner','prematch_kills_total','prematch_duration_total','live_kills_total','live_duration_total','series_winner']);
export const SERIES_HEADS=Object.freeze(['p_current_map','q_series_if_current_won','q_series_if_current_lost']);
export const BINDING_KEYS=Object.freeze(['planSha256','approvalSha256','recipeSha256','datasetManifestSha256','featureContractSha256','splitManifestSha256']);
const RESULT_KEYS=['contract','status','identity','fitId','bindings','nativeFits','trees','stateFeatures','candidateAxisFeatures','featureCount','fullInventoryRetained','serializedParity','noOuterHoldout','candidateOnly','publicPromotion','artifacts'];
const need=(ok,reason)=>{if(!ok)throw Error(reason);};
const id=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001f]/.test(v);
const digest=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
function object(value,keys,reason){
 need(value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,reason);
 const ds=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(ds);
 need(own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k))&&Object.values(ds).every(d=>'value'in d&&d.enumerable),reason);
 return value;
}
function list(value,count,reason){
 need(Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length===count,reason);
 const ds=Object.getOwnPropertyDescriptors(value);
 need(Reflect.ownKeys(ds).length===count+1&&Reflect.ownKeys(ds).every(k=>k==='length'||/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<count&&'value'in ds[k]),reason);
 return value;
}
/** Canonical UTF8 JSON: lexicographic object keys, no undefined/accessors/nonfinite. */
export function canonical(value){
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'){need(Number.isFinite(value),'canonical_finite_number_required');return JSON.stringify(value);}
 if(Array.isArray(value)){list(value,value.length,'canonical_plain_array_required');return '['+value.map(canonical).join(',')+']';}
 need(value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,'canonical_plain_object_required');
 const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
 need(keys.every(k=>typeof k==='string')&&Object.values(ds).every(d=>'value'in d&&d.enumerable),'canonical_plain_object_required');
 return '{'+keys.sort().map(k=>JSON.stringify(k)+':'+canonical(ds[k].value)).join(',')+'}';
}
export const valueSha=value=>createHash('sha256').update(canonical(value),'utf8').digest('hex');
export function makeFitIdentity(fields){
 object(fields,['policyId','intentId','family','fold','head'],'identity_fields_required');
 need(id(fields.policyId)&&id(fields.intentId)&&FAMILIES.includes(fields.family)&&Number.isInteger(fields.fold)&&fields.fold>=0&&fields.fold<4,'family_fold_identity_invalid');
 need(fields.family==='series_winner'?SERIES_HEADS.includes(fields.head):fields.head==='main','explicit_family_head_required');
 return {contract:IDENTITY_CONTRACT,policyId:fields.policyId,intentId:fields.intentId,family:fields.family,fold:fields.fold,head:fields.head};
}
function identity(value){
 object(value,['contract','policyId','intentId','family','fold','head'],'versioned_identity_required');
 need(value.contract===IDENTITY_CONTRACT,'versioned_identity_required');
 return makeFitIdentity({policyId:value.policyId,intentId:value.intentId,family:value.family,fold:value.fold,head:value.head});
}
export function fitId(value){return valueSha(identity(value));}
/** This exact stable order is convenience only; set membership is authoritative. */
export function expectedFitIdentities(scope){
 object(scope,['policyId','intentId'],'identity_scope_required');
 const out=[];
 for(const family of FAMILIES)for(let fold=0;fold<4;fold++)for(const head of family==='series_winner'?SERIES_HEADS:['main']){
  const x=makeFitIdentity({...scope,family,fold,head});out.push({identity:x,fitId:fitId(x)});
 }
 return out;
}
function bindings(value){
 object(value,BINDING_KEYS,'six_exact_binding_hashes_required');
 need(BINDING_KEYS.every(k=>digest(value[k])),'six_exact_binding_hashes_required');return value;
}
function featureContract(expected){
 need(Number.isSafeInteger(expected.stateFeatures)&&expected.stateFeatures>0&&expected.stateFeatures<=1000000,'full_state_feature_count_required');
 const axis=expected.identity.family.endsWith('_total')?1:0;
 need(expected.candidateAxisFeatures===axis,'family_axis_count_required');
}
function expectation(value){
 object(value,['identity','bindings','stateFeatures','candidateAxisFeatures'],'exact_fit_expectation_required');
 identity(value.identity);bindings(value.bindings);featureContract(value);return value;
}
function artifacts(value){
 need(value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,'artifact_hashes_required');
 const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
 need(keys.length>0&&keys.length<=128,'bounded_artifact_hashes_required');
 need(keys.every(k=>typeof k==='string'&&/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,255}$/.test(k)&&!k.split('/').some(p=>p==='.'||p==='..'||!p)&&'value'in ds[k]&&ds[k].enumerable&&digest(ds[k].value)),'relative_artifact_hashes_required');
 return value;
}
export function validateFitResult(result,expected){
 expectation(expected);
 object(result,RESULT_KEYS,'exact_v2_fit_result_required');
 need(result.contract===RESULT_CONTRACT&&result.status==='fit_complete','v2_fit_complete_required');
 const actualId=fitId(result.identity),wantedId=fitId(expected.identity);
 need(result.fitId===actualId&&actualId===wantedId,'fit_identity_mismatch');
 bindings(result.bindings);need(BINDING_KEYS.every(k=>result.bindings[k]===expected.bindings[k]),'fit_source_binding_mismatch');
 need(result.nativeFits===1&&result.trees===256,'exactly_one_native_256_tree_fit_required');
 need(result.stateFeatures===expected.stateFeatures&&result.candidateAxisFeatures===expected.candidateAxisFeatures&&result.featureCount===expected.stateFeatures+expected.candidateAxisFeatures,'full_state_and_axis_inventory_mismatch');
 need(result.fullInventoryRetained===true&&result.serializedParity===true&&result.noOuterHoldout===true&&result.candidateOnly===true&&result.publicPromotion===false,'candidate_full_inventory_parity_required');
 artifacts(result.artifacts);
 return {contract:'aegis.rich-fit-result-metadata-verification.v2',status:'single_fit_metadata_verified',identity:identity(result.identity),fitId:actualId,bindings:{...result.bindings},nativeFits:1,stateFeatures:result.stateFeatures,candidateAxisFeatures:result.candidateAxisFeatures,featureCount:result.featureCount,artifactFileBytesVerified:false,evaluationVerified:false,resourceClosureVerified:false,dispatchEnabled:false,publicPromotion:false};
}
export function validateFitApproval(approval,expected,nowUnix){
 object(expected,['identity','planSha256'],'approval_expectation_required');identity(expected.identity);
 object(approval,['contract','approved','approvedBy','identity','fitId','planSha256','nativeFits','automaticRetry','publicPromotion','expiresAtUnix'],'exact_v2_one_fit_approval_required');
 need(approval.contract===APPROVAL_CONTRACT&&approval.approved===true&&approval.approvedBy==='root'&&approval.nativeFits===1&&approval.automaticRetry===false&&approval.publicPromotion===false,'explicit_one_head_root_approval_required');
 need(digest(expected.planSha256)&&approval.planSha256===expected.planSha256&&approval.fitId===fitId(expected.identity)&&fitId(approval.identity)===approval.fitId,'approval_head_or_plan_mismatch');
 need(Number.isFinite(nowUnix)&&Number.isFinite(approval.expiresAtUnix)&&approval.expiresAtUnix>nowUnix&&approval.expiresAtUnix<=nowUnix+86400,'bounded_unexpired_approval_required');
 return {fitId:approval.fitId,claimKey:approval.fitId,automaticRetry:false,fitAuthorizedByThisVerifier:false};
}
export function verifyCompleteFitSet(results,options){
 object(options,['policyId','intentId','expectations'],'complete_intent_scope_required');
 const wanted=expectedFitIdentities({policyId:options.policyId,intentId:options.intentId}),ids=new Set(wanted.map(x=>x.fitId)),expectations=new Map(),familyBindings=new Map();
 for(const x of list(options.expectations,40,'forty_fit_expectations_required')){
  expectation(x);const key=fitId(x.identity);need(ids.has(key)&&!expectations.has(key),'unexpected_or_duplicate_expectation');
  const shared=canonical({datasetManifestSha256:x.bindings.datasetManifestSha256,featureContractSha256:x.bindings.featureContractSha256,splitManifestSha256:x.bindings.splitManifestSha256,stateFeatures:x.stateFeatures,candidateAxisFeatures:x.candidateAxisFeatures});
  need(!familyBindings.has(x.identity.family)||familyBindings.get(x.identity.family)===shared,'family_dataset_features_or_folds_changed_between_heads');
  familyBindings.set(x.identity.family,shared);expectations.set(key,x);
 }
 const seen=new Set(),verified=[];
 for(const r of list(results,40,'forty_one_fit_results_required')){
  object(r,RESULT_KEYS,'exact_v2_fit_result_required');
  const key=fitId(r.identity);need(ids.has(key)&&!seen.has(key),'unexpected_or_duplicate_fit_result');seen.add(key);verified.push(validateFitResult(r,expectations.get(key)));
 }
 return {contract:'aegis.rich-intent-fit-set-metadata.v2',status:'forty_fit_result_metadata_verified',policyId:options.policyId,intentId:options.intentId,families:[...FAMILIES],fits:40,seriesHeads:[...SERIES_HEADS],fitIds:[...seen].sort(),artifactFileBytesVerified:false,evaluationVerified:false,datasetsVerified:false,resourceClosureVerified:false,wholeIntentReceiptProduced:false,monthlyAnchorCreated:false,dispatchEnabled:false,publicPromotion:false};
}
export function validatePlanIdentity(plan){
 need(plan?.contract===PLAN_CONTRACT&&plan.scope==='new_dynamic_candidate_contract'&&plan.candidateOnly===true&&plan.publicPromotion===false&&plan.nativeFits===1&&plan.automaticRetry===false,'versioned_single_head_plan_required');
 const made=makeFitIdentity({policyId:plan.policyId,intentId:plan.intentId,family:plan.family,fold:plan.fold,head:plan.head});
 need(canonical(plan.identity)===canonical(made)&&plan.fitId===fitId(made),'plan_head_identity_mismatch');
 featureContract({identity:made,stateFeatures:plan.stateFeatures,candidateAxisFeatures:plan.candidateAxisFeatures});
 need(['datasetManifestSha256','featureContractSha256','splitManifestSha256'].every(k=>digest(plan[k])),'plan_dataset_feature_split_hashes_required');
 return made;
}
export function validateHeadRegistryEntry(family,entry){
 need(FAMILIES.includes(family),'registry_family_unknown');object(entry,['heads'],'explicit_head_registry_entry_required');
 const names=family==='series_winner'?[...SERIES_HEADS]:['main'];object(entry.heads,names,'exact_family_head_inventory_required');
 return names.map(head=>{
  const adapter=entry.heads[head];
  need(adapter&&adapter.scope==='new_dynamic_candidate_contract'&&adapter.singleFit===true&&adapter.entryPoint==='fit_one'&&adapter.contract===ADAPTER_CONTRACT&&adapter.backend==='lightgbm-lazyColumnSample','versioned_single_head_adapter_required');
  for(const key of ['source','recipe'])need(adapter[key]&&typeof adapter[key].path==='string'&&adapter[key].path.length>0&&digest(adapter[key].sha256),'head_source_recipe_descriptor_required');
  return {head,adapter};
 });
}
export function expectedResultForPlan(plan,planSha256,approvalSha256){
 const identity=validatePlanIdentity(plan);need(digest(planSha256)&&digest(approvalSha256)&&digest(plan.recipe?.sha256),'plan_approval_recipe_hashes_required');
 return {identity,bindings:{planSha256,approvalSha256,recipeSha256:plan.recipe.sha256,datasetManifestSha256:plan.datasetManifestSha256,featureContractSha256:plan.featureContractSha256,splitManifestSha256:plan.splitManifestSha256},stateFeatures:plan.stateFeatures,candidateAxisFeatures:plan.candidateAxisFeatures};
}
