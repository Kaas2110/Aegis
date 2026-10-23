/** Revalidate one candidate fit immediately before the owned native boundary. */
import {readFileSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_POLICY,plan} from './candidate-planner.mjs';
import {loadLedger} from './planner-store.mjs';
import {officialFromSaved,evaluationReceipts} from './saved-inputs.mjs';
import {fileHash,json,lockDocument,pinned,valueSha} from './evidence.mjs';
import {produceInputs} from './produce-inputs.mjs';
import {controlPolicy,loadControlJournal} from './persistent-policies.mjs';
import {validatePlanIdentity,validateHeadRegistryEntry,canonical} from './head-identity.mjs';
export function selectedHeadBinding(job,registry,data){
 validatePlanIdentity(job);
 if(registry.contract!=='aegis.dynamic-rich-runner-registry.v2'||registry.policyId!==job.policyId)throw Error('versioned_head_registry_required');
 const adapter=validateHeadRegistryEntry(job.family,registry.families[job.family]).find(x=>x.head===job.head)?.adapter;
 if(!data?.ready||adapter?.recipe?.sha256!==job.recipe?.sha256||adapter.recipe?.path!==job.recipe?.path||adapter.source.sha256!==job.adapterSource.sha256||adapter.source.path!==job.adapterSource.path||data.datasetManifestSha256!==job.datasetManifestSha256||data.featureContractSha256!==job.featureContractSha256||data.splitManifestSha256!==job.splitManifestSha256||data.features!==job.stateFeatures)throw Error('selected_adapter_dataset_feature_binding');
 return adapter;
}
export function verifyAdapterDependencies(job){
 const recipe=pinned(job.recipe),deps=recipe.adapterDependencies,root=resolve(dirname(job.adapterSource.path));
 if(!deps||typeof deps!=='object'||Array.isArray(deps)||Object.keys(deps).length<1||Object.keys(deps).length>32)throw Error('explicit_adapter_dependency_inventory');
 for(const [name,pin]of Object.entries(deps)){
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(name)||name.split('/').some(x=>['','.','..'].includes(x))||resolve(pin.path)!==resolve(root,name)||!resolve(pin.path).startsWith(root+sep)||fileHash(pin.path)!==pin.sha256)throw Error('adapter_dependency_path_or_pin');
 }
 return deps;
}
export function gate(job,{producer=produceInputs,reservation=null}={}){
 const identity=validatePlanIdentity(job);
 const c=pinned(job.plannerConfig);if(!c.producerConfig||['manualControl','fitObservation','dataReadiness','runnerBindings'].some(k=>c[k]!=null))throw Error('dynamic_producer_config_required');
 const ledger=loadLedger(c.outputDir),intent=ledger.intents.find(i=>i.intentId===job.intentId);if(!intent)throw Error('saved_intent_missing');
 const observed=producer(c.producerConfig,undefined,intent),now=new Date().toISOString();
 if(reservation){
  const cfg=pinned(c.producerConfig),fit=observed.fitObservation;
  if(reservation.supervisor?.pid!==process.ppid||reservation.reservation!==true||reservation.planSha256!==valueSha(job)||reservation.fitId!==job.fitId||canonical(reservation.identity)!==canonical(identity)||fit.state!=='busy'||fit.ownerVerified!==true||fit.unownedPython.length||fit.owners.some(o=>o.pid!==reservation.supervisor.pid||o.creationTime100ns!==String(reservation.supervisor.creationTime100ns)))throw Error('exclusive_self_reservation_not_verified');
  const ownLocks=fit.locks.filter(l=>l.owner?.pid===reservation.supervisor.pid);if(ownLocks.length!==2)throw Error('both_global_and_local_reservation_required');
  for(const l of ownLocks){const d=lockDocument(l.path).doc;if(d.nonce!==reservation.nonce||d.planSha256!==reservation.planSha256||d.reservation!==true||d.fitId!==job.fitId||canonical(d.identity)!==canonical(identity))throw Error('reservation_lock_binding');}
  // This is permission to use this held reservation, never an idle observation published to the hourly planner.
  observed.fitObservation={...fit,state:'idle',scope:'only this caller owns both exclusive pre-fit reservation locks',reservationVerified:true};
 }
 const report=plan({now,policy:c.policy??DEFAULT_POLICY,official:officialFromSaved(c.stateDir),...ledger,...observed,evaluationReceipts:evaluationReceipts(c.evaluationReceipts??[])});
 if(report.status!=='ready_for_external_dispatch'||report.currentIntentId!==job.intentId||report.policyId!==job.policyId||report.blockedReasons.length)throw Error('candidate_fit_blocked:'+report.blockedReasons.join(','));
 const producers=pinned(c.producerConfig),registry=pinned(producers.runnerRegistry),data=observed.dataReadiness.families[job.family];
 const adapter=selectedHeadBinding(job,registry,data);
 if(job.globalLock!==producers.globalNativeLock||job.localLock!==producers.executorLocalLock||job.claimRoot!==producers.executorClaimRoot||!producers.lifecycleRoots?.includes(dirname(job.outputDir))||JSON.stringify([...(job.stopMarkerPaths??[])].sort())!==JSON.stringify([...(producers.stopMarkerPaths??[])].sort())||JSON.stringify([...(job.competitorLocks??[])].sort())!==JSON.stringify(producers.nativeLockPaths.filter(p=>p!==job.globalLock&&p!==job.localLock).sort())||registry.resourceGuardSha256!==job.resourceGuardSource.sha256)throw Error('shared_lock_stop_and_resource_binding');
 if(fileHash(adapter.source.path)!==adapter.source.sha256)throw Error('adapter_changed');
 verifyAdapterDependencies(job);
 const runtimeGuardPins=[],runtimeRoleExpiries=[];
 for(const spec of producers.nonFitServiceReceipts??[]){const r=pinned(spec);runtimeGuardPins.push(spec,r.serviceConfig,r.authenticatedStatus,...r.reviewedGuardSources);runtimeRoleExpiries.push(r.expiresAt);}
 // Fresh status was established by producer's pinned host collector. Recheck policy/source pins.
 for(const spec of producers.persistentNonFitServicePolicies??[]){const r=pinned(spec);runtimeGuardPins.push(spec,r.collectorSource,...r.configurationPins,...r.privateConfigurationPins,...r.sourcePins,...r.processChain.map(x=>x.executable));}
 const authority=producers.persistentCandidateControlPolicy??producers.manualControlReceipt;
 let manualControlExpiresAt=null,persistentControlState=null;
 if(producers.persistentCandidateControlPolicy){const p=controlPolicy(authority,producers,now);runtimeGuardPins.push(...p.sourcePins);const current=loadControlJournal(p,authority);if(current.invalidated!==false)throw Error('persistent_control_invalidated_after_observation');persistentControlState={directory:p.stateDirectory,policySha256:authority.sha256,revisionId:p.revisionId,validatedSequence:current.sequence,validatedSha256:valueSha(current)};}
 else manualControlExpiresAt=pinned(authority).expiresAt;
 return {status:'READY_FOR_ONE_EXPLICITLY_APPROVED_FIT',identity,fitId:job.fitId,policyId:job.policyId,intentId:job.intentId,family:job.family,fold:job.fold,head:job.head,data,adapter,observationsSha256:valueSha(observed),observedAt:now,manualControlReceipt:authority,manualControlExpiresAt,persistentControlState,persistentServiceIdentities:(observed.fitObservation.nonFitServices??[]).filter(x=>x.persistentPolicySha256).map(x=>({pid:x.pid,creationTime100ns:x.creationTime100ns})),producerConfig:c.producerConfig,runtimeGuardPins,runtimeRoleExpiries,nativeFits:0,publicPromotion:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{if(![3,4].includes(process.argv.length))throw Error('plan_and_optional_held_reservation_required');console.log(JSON.stringify(gate(JSON.parse(readFileSync(process.argv[2],'utf8')),{reservation:process.argv[3]?lockDocument(process.argv[3]).doc:null})));}catch(e){console.error(e.message);process.exitCode=10;}}
