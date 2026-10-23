/** Derive manual permission and fit ownership from current host + local receipts. */
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileHash,fresh,identity,instant,json,lockDocument,pinned,sha,valueSha} from './evidence.mjs';
import {persistentControl,persistentServices} from './persistent-policies.mjs';
const same=(a,b)=>a&&b&&a.pid===b.pid&&a.creationTime100ns===b.creationTime100ns;
export function observeFit(config,host,now){
 const reasons=[],locks=[],owners=[],claimedLaunchers=[],nonFitServices=[];const processes=host.processes??[];
 if(host.contract!=='aegis.host-observation.v1'||host.processComplete!==true||!fresh(host.observedAt,now)||instant(host.startedAt)>instant(host.observedAt))reasons.push('host_inventory_incomplete_or_stale');
 if(!Array.isArray(processes)||processes.length>4096||processes.some(p=>!identity(p)))reasons.push('process_identity_invalid');
 for(const path of config.nativeLockPaths??[]){
  if(!existsSync(path))continue;
  try{
   const {doc,sha256}=lockDocument(path);const owner=identity(doc.supervisor??doc.owner??doc);const live=owner&&processes.some(p=>p.identityPrecise===true&&same(identity(p),owner));locks.push({path,sha256,owner,live});
   if(!live)reasons.push('native_lock_owner_missing_or_reused');else{
    owners.push(owner);let child=processes.find(p=>same(identity(p),owner));
    for(const claim of doc.launchers??[]){const parent=identity(claim),found=parent&&processes.find(p=>p.identityPrecise===true&&same(identity(p),parent));if(!found||child.parentPid!==found.pid||BigInt(found.creationTime100ns)>BigInt(child.creationTime100ns)){reasons.push('launcher_ancestry_unverified');break;}claimedLaunchers.push(parent);child=found;}
   }
  }
  catch{reasons.push('native_lock_unreadable');}
 }
 const descendant=p=>{const seen=new Set();for(let n=0;n<64&&p&&!seen.has(p.pid);n++){if(owners.some(o=>same(o,identity(p))))return true;seen.add(p.pid);const parent=processes.find(x=>x.pid===p.parentPid);if(parent&&BigInt(parent.creationTime100ns)>BigInt(p.creationTime100ns))return false;p=parent;}return false;};
 for(const spec of config.nonFitServiceReceipts??[]){
  try{
   const receipt=pinned(spec);
   if(receipt.contract!=='aegis.root-nonfit-service.v1'||receipt.approvedBy!=='root'||receipt.approved!==true||receipt.role!=='non_fit_service'||receipt.nativeTrainingDisabled!==true||receipt.legacyTrainingDisabled!==true||instant(receipt.issuedAt)>instant(now)||instant(receipt.expiresAt)<=instant(now)||instant(receipt.expiresAt)-instant(receipt.issuedAt)>86400000||!Array.isArray(receipt.identities)||!receipt.identities.length||receipt.identities.length>16||!receipt.serviceConfig||!receipt.authenticatedStatus||!Array.isArray(receipt.reviewedGuardSources)||!receipt.reviewedGuardSources.length)throw Error('nonfit_service_review_contract');
   const status=pinned(receipt.authenticatedStatus);
   const admission=status.response;
   if(status.contract!=='aegis.authenticated-training-admission-observation.v1'||status.authenticationVerified!==true||!fresh(status.receivedAt,receipt.issuedAt)||!receipt.identities.some(x=>same(identity(x),identity(status.serviceIdentity)))||admission?.contract!=='legacy_http_training_admission.v1'||admission.enabled!==false||admission.scope!=='legacy_http_training_routes_only'||JSON.stringify([...(admission.guardedPaths??[])].sort())!==JSON.stringify(['/ml/train','/train'])||!receipt.reviewedGuardSources.some(x=>x.sha256===admission.sourceSha256))throw Error('authenticated_training_admission_not_closed');
   if(fileHash(receipt.serviceConfig.path)!==receipt.serviceConfig.sha256)throw Error('nonfit_service_config_changed');
   for(const source of receipt.reviewedGuardSources)if(fileHash(source.path)!==source.sha256)throw Error('nonfit_service_guard_source_changed');
   for(const claim of receipt.identities){const exact=identity(claim);if(!exact||!processes.some(p=>p.identityPrecise===true&&same(identity(p),exact)))throw Error('nonfit_service_identity_changed');nonFitServices.push({...exact,role:receipt.role,receiptSha256:spec.sha256});}
  }catch{reasons.push('nonfit_service_receipt_unverified');}
 }
 try{nonFitServices.push(...persistentServices(config,host,now).roles);}catch{reasons.push('persistent_nonfit_service_policy_unverified');}
 const unownedPython=processes.filter(p=>p.isPython===true&&!descendant(p)&&!claimedLaunchers.some(x=>same(identity(p),x))&&!nonFitServices.some(x=>same(identity(p),x)));
 // A foreign Python process may be a native fit. Absence of a known lock alone is not idle permission.
 if(unownedPython.length)reasons.push('unowned_python_process_requires_review');
 const fatal=reasons.filter(r=>r!=='unowned_python_process_requires_review');
 const state=fatal.length?'unknown':owners.length?'busy':unownedPython.length?'unknown':'idle';
 return {contract:'aegis.fit-owner-observation.v1',observedAt:host.observedAt,state,ownerVerified:state==='busy'||state==='idle',verifiedFileBinding:true,locks,owners,claimedLaunchers,nonFitServices,unownedPython:unownedPython.map(identity),reasons,hostSha256:valueSha(host),scope:'complete process census plus configured native locks and explicit root-reviewed non-fit identities; no process mutation'};
}
export function observeManual(config,host,now){
 const blockers=[],lifecycle=[],stops=[];const processes=host.processes??[];
 if(host.complete!==true||!fresh(host.observedAt,now))blockers.push({reason:'host_observation_unavailable',sha256:valueSha(host)});
 for(const path of config.stopEvidencePaths??[]){if(!existsSync(path))continue;try{stops.push({path,sha256:fileHash(path)});}catch{blockers.push({reason:'stop_evidence_unreadable',sha256:sha(Buffer.from(path))});}}
 for(const path of config.stopMarkerPaths??[]){if(existsSync(path))blockers.push({reason:'active_stop_marker',sha256:sha(Buffer.from(path)),cannotOverride:true});}
 const lifecycleItems=[...(config.lifecycle??[])];
 for(const root of config.lifecycleRoots??[]){
  if(!existsSync(root))continue;const entries=readdirSync(root,{withFileTypes:true});if(entries.length>1000)throw Error('lifecycle_directory_bound');
  for(const entry of entries)if(entry.isDirectory()&&!entry.isSymbolicLink()){
   const started=join(root,entry.name,'STARTED.json');if(!existsSync(started))blockers.push({reason:'run_directory_without_started_receipt',sha256:sha(Buffer.from(started))});
   lifecycleItems.push({started,exit:join(root,entry.name,'EXIT.json')});
  }
 }
 if(lifecycleItems.length>1128)throw Error('lifecycle_inventory_bound');
 for(const item of lifecycleItems){
  if(!existsSync(item.started))continue;
  try{
   const start=json(item.started),startSha256=fileHash(item.started);const owner=identity(start.supervisor??start.ownerIdentity??start.owner?.supervisor);
   // Legacy wrapper receipts use DateTime ticks; preserve exact creation identity by converting to FILETIME.
   const wrapper=start.owner;const ticks=wrapper?.ownerStartTimeTicks;
   const actualOwner=owner??(ticks&&Number.isSafeInteger(wrapper.ownerPid)?{pid:wrapper.ownerPid,creationTime100ns:String(BigInt(ticks)-504911232000000000n)}:null);
   const active=actualOwner&&processes.some(p=>p.identityPrecise===true&&same(identity(p),actualOwner));let terminal=null,terminalSha256=null;
   if(item.exit&&existsSync(item.exit)){terminal=json(item.exit);terminalSha256=fileHash(item.exit);}
   const bound=terminal&&((terminal.startedSha256===startSha256)||(start.runId&&terminal.runId===start.runId))&&Number.isInteger(terminal.exitCode)&&terminal.exitCode===0;
   const row={started:item.started,startSha256,terminalSha256,active:!!active,terminalBound:!!bound};lifecycle.push(row);
   if(!active&&!bound)blockers.push({reason:terminal?'terminal_receipt_requires_owner_binding_review':'started_without_confirmed_exit_or_stop',evidencePath:item.started,sha256:startSha256,terminalSha256});
  }catch{blockers.push({reason:'lifecycle_evidence_invalid',sha256:sha(Buffer.from(item.started))});}
 }
 for(const task of host.tasks??[]){
  if(task.enabled!==true||task.state==='Unknown'||[267014,3221225786].includes(task.lastResult))blockers.push({reason:'task_disabled_unknown_or_stopped',evidencePath:'task:'+task.name,sha256:valueSha(task),task,cannotOverride:task.enabled==null||task.state==='Unknown'});
 }
 if(config.persistentCandidateControlPolicy){
  let result;
  try{if(config.manualControlReceipt)throw Error('mixed_control_authority');result=persistentControl(config.persistentCandidateControlPolicy,config,host,now,blockers,stops);}
  catch{result={valid:false,unresolved:[{reason:'persistent_control_policy_or_state_unverified'}]};}
  return {contract:'aegis.manual-control-observation.v1',observedAt:host.observedAt,paused:!result.valid,verifiedFileBinding:true,reasons:result.unresolved.map(x=>x.reason),unresolved:result.unresolved,stopEvidence:stops,lifecycle,controlReceiptSha256:result.controlPolicySha256??null,controlAuthorityKind:'persistent_reviewed_policy',controlStateDirectory:result.stateDirectory??null,taskReadyIsPermission:false,automaticRetry:false,automaticResume:false,publicPromotion:false};
 }
 let control=null;try{if(config.manualControlReceipt)control=pinned(config.manualControlReceipt);}catch{blockers.push({reason:'manual_control_pin_invalid',sha256:config.manualControlReceipt?.sha256??'invalid'});}
 const valid=control?.contract==='aegis.explicit-candidate-control.v1'&&control.approvedBy==='root'&&control.approved===true&&control.policyId===config.policyId&&control.action==='resume_candidates'&&instant(control.issuedAt)<=instant(now)&&instant(control.expiresAt)>instant(now)&&instant(control.expiresAt)-instant(control.issuedAt)<=86400000;
 const resolved=new Set(valid?control.resolvedEvidenceSha256??[]:[]);
 const unresolved=blockers.filter(x=>x.cannotOverride||!resolved.has(x.sha256));
 const unacknowledgedStops=stops.filter(s=>!resolved.has(s.sha256));
 const reasons=[...unresolved.map(x=>x.reason),...unacknowledgedStops.map(()=> 'recorded_manual_stop_requires_explicit_resume'),...(!valid?['explicit_resume_receipt_missing_or_invalid']:[])];
 return {contract:'aegis.manual-control-observation.v1',observedAt:host.observedAt,paused:reasons.length!==0,verifiedFileBinding:true,reasons:[...new Set(reasons)],unresolved,stopEvidence:stops,lifecycle,controlReceiptSha256:valid?config.manualControlReceipt.sha256:null,taskReadyIsPermission:false,automaticRetry:false,publicPromotion:false};
}
