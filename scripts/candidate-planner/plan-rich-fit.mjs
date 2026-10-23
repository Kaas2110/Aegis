/** Compose candidate-only plans; never approve, claim, dispatch or train. */
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {PLAN_CONTRACT,makeFitIdentity,fitId,expectedFitIdentities,validateHeadRegistryEntry,validatePlanIdentity} from './head-identity.mjs';
export function makeSingleFitPlan({identity,registry,readiness,common,outputRoot}){
 const x=makeFitIdentity({policyId:identity.policyId,intentId:identity.intentId,family:identity.family,fold:identity.fold,head:identity.head});
 if(registry?.contract!=='aegis.dynamic-rich-runner-registry.v2'||registry.policyId!==x.policyId)throw Error('versioned_head_registry_required');
 const adapter=validateHeadRegistryEntry(x.family,registry.families?.[x.family]).find(v=>v.head===x.head)?.adapter,data=readiness?.families?.[x.family];
 if(!data?.ready||data.causalLiveParityVerified!==true||data.groupedTemporalSplitVerified!==true)throw Error('verified_family_dataset_required');
 if(!isAbsolute(outputRoot)||!isAbsolute(common?.localLock??'')||![dirname(common.localLock),join(dirname(common.localLock),'runs')].map(x=>resolve(x)).includes(resolve(outputRoot)))throw Error('owned_output_root_required');
 const p={...common,contract:PLAN_CONTRACT,scope:'new_dynamic_candidate_contract',policyId:x.policyId,intentId:x.intentId,family:x.family,fold:x.fold,head:x.head,identity:x,fitId:fitId(x),nativeFits:1,automaticRetry:false,candidateOnly:true,publicPromotion:false,adapterSource:{...adapter.source},recipe:{...adapter.recipe},datasetManifestSha256:data.datasetManifestSha256,featureContractSha256:data.featureContractSha256,splitManifestSha256:data.splitManifestSha256,stateFeatures:data.features,candidateAxisFeatures:x.family.endsWith('_total')?1:0,outputDir:join(outputRoot,fitId(x))};
 validatePlanIdentity(p);return p;
}
export function makeIntentFitPlans({policyId,intentId,registry,readiness,common,outputRoot}){
 const plans=expectedFitIdentities({policyId,intentId}).map(({identity})=>makeSingleFitPlan({identity,registry,readiness,common,outputRoot}));
 return {contract:'aegis.rich.intent-fit-plans.v2',policyId,intentId,expectedNativeFits:40,plans,approvalsProduced:false,claimsProduced:false,trainingStarted:false,dispatchEnabled:false,publicPromotion:false};
}
