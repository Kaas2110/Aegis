/** Explicit persistent policies. No name-only process exemption or fit dispatch. */
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,fileHash,fresh,identity,instant,json,localFile,pinned,sha,valueSha} from './evidence.mjs';
const insist=(ok,reason)=>{if(!ok)throw Error(reason);};
const same=(a,b)=>a&&b&&a.pid===b.pid&&String(a.creationTime100ns)===String(b.creationTime100ns);
function localPath(path){insist(typeof path==='string'&&/^[A-Za-z]:[\\/]/.test(path),'local_drive_path_required');let p=resolve(path);while(true){insist(!existsSync(p)||!lstatSync(p).isSymbolicLink(),'policy_reparse_path');const parent=dirname(p);if(parent===p)break;p=parent;}}
const paths=p=>[...p.configurationPins,...p.privateConfigurationPins,...p.sourcePins,...p.processChain.map(x=>x.executable)];
export function servicePolicy(spec,now){
 const p=pinned(spec);
 insist(p.contract==='aegis.persistent-nonfit-service-policy.v1'&&p.approvedBy==='root'&&p.approved===true&&p.active===true&&instant(p.approvedAt)<=instant(now),'persistent_service_policy_unapproved');
 insist(p.role==='non_fit_service'&&p.publicPromotion===false&&p.automaticTraining===false,'persistent_service_scope');
 insist(p.endpoint?.host==='127.0.0.1'&&Number.isSafeInteger(p.endpoint.port)&&p.endpoint.port>0&&p.endpoint.port<65536&&p.endpoint.path==='/diagnostics/training-admission'&&p.endpoint.protocol==='http:','fixed_loopback_admission_endpoint_required');
 insist(p.credential?.kind==='environment'&&p.credential.name==='ML_SERVICE_TOKEN','fixed_environment_credential_required');
 insist(p.runtimeIdentity?.section==='ml'&&isAbsolute(p.runtimeIdentity.path),'semantic_runtime_identity_required');
 insist(Array.isArray(p.processChain)&&p.processChain.length>=1&&p.processChain.length<=4&&p.processChain.every(x=>x.executable&&/^[A-Za-z]:[\\/]/.test(x.observedExecutablePath)&&Array.isArray(x.arguments)&&x.arguments.length>0&&x.arguments.length<=32&&x.arguments.every(a=>typeof a==='string'&&a.length<=512)),'reviewed_process_chain_required');
 insist(Array.isArray(p.configurationPins)&&p.configurationPins.length>0&&p.configurationPins.length<=16&&Array.isArray(p.sourcePins)&&p.sourcePins.length>=2&&p.sourcePins.length<=16&&digest(p.admissionSourceSha256)&&p.sourcePins.some(x=>x.sha256===p.admissionSourceSha256),'reviewed_source_config_pins_required');
 insist(Array.isArray(p.privateConfigurationPins)&&p.privateConfigurationPins.length>0&&p.privateConfigurationPins.length<=4,'private_configuration_pins_required');
 insist(p.collectorSource&&digest(p.collectorSource.sha256),'persistent_collector_pin_required');
 localPath(p.runtimeIdentity.path);
 for(const s of [...paths(p),p.collectorSource]){localPath(s.path);insist(fileHash(s.path,64*1024**2)===s.sha256,'persistent_service_source_or_configuration_changed');}
 return p;
}
export function persistentServices(config,host,now){
 const roles=[];const pins=[];
 for(const spec of config.persistentNonFitServicePolicies??[]){
  const p=servicePolicy(spec,now),rows=(host.serviceAdmissions??[]).filter(x=>x.policySha256===spec.sha256);
  insist(rows.length===1,'fresh_persistent_service_observation_required');const r=rows[0];
  insist(r.contract==='aegis.persistent-service-observation.v1'&&r.verified===true&&fresh(r.receivedAt,now,60000)&&instant(r.startedAt)<=instant(r.receivedAt)&&instant(r.receivedAt)<=instant(host.observedAt),'persistent_service_observation_not_fresh');
  insist(host.processComplete===true&&host.processCensusKind==='post_service_complete_v2'&&instant(r.receivedAt)<=instant(host.processCensusStartedAt)&&instant(host.processCensusStartedAt)<=instant(host.processCensusCompletedAt)&&instant(host.processCensusCompletedAt)<=instant(host.observedAt),'complete_post_service_census_required');
  insist(r.endpoint===`http://127.0.0.1:${p.endpoint.port}/diagnostics/training-admission`&&r.unauthenticatedStatus===401&&r.authenticatedStatus===200,'authenticated_local_admission_required');
  const a=r.response;
  insist(a?.contract==='legacy_http_training_admission.v1'&&a.enabled===false&&['disabled_by_default','disabled_explicitly'].includes(a.reason)&&a.scope==='legacy_http_training_routes_only'&&JSON.stringify([...(a.guardedPaths??[])].sort())===JSON.stringify(['/ml/train','/train'])&&a.sourceSha256===p.admissionSourceSha256,'persistent_service_training_not_closed');
  insist(Array.isArray(r.chainBefore)&&r.chainBefore.length===p.processChain.length&&valueSha(r.chainBefore)===valueSha(r.chainAfter),'service_identity_rotated_during_request');
  for(let i=0;i<r.chainAfter.length;i++){
   const q=r.chainAfter[i],expected=p.processChain[i];
   insist(identity(q)&&q.executablePath===expected.executable.path&&q.observedExecutablePath===expected.observedExecutablePath&&q.canonicalExecutableVerified===true&&q.executableSha256===expected.executable.sha256&&q.argumentsSha256===valueSha(expected.arguments),'service_process_semantic_binding');
   insist((host.processes??[]).filter(x=>x.identityPrecise===true&&same(x,q)&&x.parentPid===q.parentPid).length===1,'service_not_in_current_process_census');
   if(i)insist(q.parentPid===r.chainAfter[i-1].pid&&BigInt(q.creationTime100ns)>=BigInt(r.chainAfter[i-1].creationTime100ns),'service_lineage_invalid');
   roles.push({...identity(q),role:'non_fit_service',persistentPolicySha256:spec.sha256});
  }
  insist(r.listenerPid===r.chainAfter.at(-1).pid&&digest(r.registryBeforeSha256)&&r.registryBeforeSha256===r.registryAfterSha256,'service_listener_or_registry_changed');
  pins.push(spec,...paths(p),p.collectorSource);
 }
 return {roles,pins};
}
export function controlScope(config){return valueSha(Object.fromEntries(['policyId','taskNames','nativeLockPaths','lifecycle','lifecycleRoots','stopEvidencePaths','stopMarkerPaths','executorClaimRoot'].map(k=>[k,config[k]??null])));}
const acknowledgement=x=>valueSha({reason:x.reason,evidencePath:x.evidencePath??null,sha256:x.sha256,terminalSha256:x.terminalSha256??null});
const ackReasons=new Set(['recorded_manual_stop_requires_explicit_resume','started_without_confirmed_exit_or_stop','terminal_receipt_requires_owner_binding_review','task_disabled_unknown_or_stopped']);
export function controlPolicy(spec,config,now){
 const p=pinned(spec);
 insist(p.contract==='aegis.persistent-candidate-control-policy.v1'&&p.approvedBy==='root'&&p.approved===true&&p.active===true&&instant(p.approvedAt)<=instant(now)&&p.policyId===config.policyId&&p.action==='continue_candidates_under_reviewed_controls','persistent_control_unapproved');
 insist(p.publicPromotion===false&&p.automaticRetry===false&&p.automaticResume===false&&p.taskEnablePermission===false&&p.controlScopeSha256===controlScope(config),'persistent_control_scope_changed');
 insist(typeof p.revisionId==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(p.revisionId)&&isAbsolute(p.stateDirectory),'persistent_control_state_required');
 localPath(p.stateDirectory);
 insist(Array.isArray(p.acknowledgedEvidence)&&p.acknowledgedEvidence.length<=256&&p.acknowledgedEvidence.every(x=>ackReasons.has(x.reason)&&typeof x.evidencePath==='string'&&x.evidencePath.length>0&&x.evidencePath.length<=1024&&digest(x.sha256)&&(x.terminalSha256==null||digest(x.terminalSha256))),'exact_reviewed_acknowledgements_required');
 insist(Array.isArray(p.sourcePins)&&p.sourcePins.length>0&&p.sourcePins.length<=16,'control_source_review_required');
 for(const s of p.sourcePins)insist(fileHash(s.path)===s.sha256,'control_policy_source_changed');
 return p;
}
// The journal must be initialized separately by root after reviewing the policy.
// An invalidation is sticky across missing STOP files, restarts and old acknowledgements.
export function loadControlJournal(p,spec,{writerOwnsLock=false}={}){
 insist(existsSync(p.stateDirectory),'control_state_not_initialized');
 insist(writerOwnsLock||!existsSync(join(p.stateDirectory,'CONTROL.lock')),'control_state_writer_or_quarantine');
 const names=readdirSync(p.stateDirectory).filter(n=>n!=='CONTROL.lock');insist(names.length<=10002,'control_state_bound');
 const events=names.filter(n=>/^\d{6}-[a-f0-9]{64}\.json$/.test(n)).sort();
 insist(events.length>0&&events.length<=10000&&names.length===events.length+1&&names.includes('CURRENT.json'),'control_state_inventory_invalid');
 let previous=null,current;
 for(let i=0;i<events.length;i++){
  const name=events[i],path=join(p.stateDirectory,name);localFile(path,65536);const raw=readFileSync(path);current=JSON.parse(raw);
  insist(name===`${String(i).padStart(6,'0')}-${sha(raw)}.json`&&current.contract==='aegis.persistent-control-state.v1'&&current.policySha256===spec.sha256&&current.revisionId===p.revisionId&&current.sequence===i&&current.previousSha256===previous&&typeof current.invalidated==='boolean','control_state_chain_invalid');
  if(i&&current.invalidated===false)insist(previousState.invalidated===false,'control_state_cannot_resume');
  previous=sha(raw);var previousState=current;
 }
 const pointer=json(join(p.stateDirectory,'CURRENT.json'),1024);
 insist(pointer.sha256===previous&&pointer.sequence===events.length-1,'control_state_pointer_invalid');
 insist(JSON.stringify(readdirSync(p.stateDirectory).filter(n=>n!=='CONTROL.lock').sort())===JSON.stringify(names.sort())&&valueSha(json(join(p.stateDirectory,'CURRENT.json'),1024))===valueSha(pointer)&&(writerOwnsLock||!existsSync(join(p.stateDirectory,'CONTROL.lock'))),'control_state_changed_during_read');
 return current;
}
function appendState(p,spec,old,next){
 const state={contract:'aegis.persistent-control-state.v1',policySha256:spec.sha256,revisionId:p.revisionId,sequence:old?old.sequence+1:0,previousSha256:old?valueSha(old):null,...next};
 // Stable bytes make the pointer/hash chain independent of formatting.
 const raw=Buffer.from(__stable(state)),hash=sha(raw);writeFileSync(join(p.stateDirectory,`${String(state.sequence).padStart(6,'0')}-${hash}.json`),raw,{flag:'wx',flush:true});
 const temporary=join(p.stateDirectory,'CURRENT-'+randomUUID()+'.tmp');writeFileSync(temporary,JSON.stringify({sequence:state.sequence,sha256:hash}),{flag:'wx',flush:true});renameSync(temporary,join(p.stateDirectory,'CURRENT.json'));
 return state;
}
// Reuse evidence.stable without exporting a mutable journal signing secret.
import {stable as __stable} from './evidence.mjs';
export function initializeControlJournal(spec,config,now,reviewedHost){
 const p=controlPolicy(spec,config,now);insist(!existsSync(p.stateDirectory),'control_state_already_exists_no_reset');
 insist(reviewedHost.complete===true&&fresh(reviewedHost.observedAt,now),'fresh_reviewed_baseline_host_required');
 mkdirSync(dirname(p.stateDirectory),{recursive:true});mkdirSync(p.stateDirectory,{recursive:false});return appendState(p,spec,null,{at:now,tasks:reviewedHost.tasks??[],invalidated:false,reasons:[]});
}
export function persistentControl(spec,config,host,now,blockers,stops){
 const p=controlPolicy(spec,config,now);insist(existsSync(p.stateDirectory),'control_state_not_initialized');
 const lock=join(p.stateDirectory,'CONTROL.lock'),fd=openSync(lock,'wx');let complete=false;
 try{
 const old=loadControlJournal(p,spec,{writerOwnsLock:true}),known=new Set(p.acknowledgedEvidence.map(acknowledgement));
 const all=[...blockers,...stops.map(s=>({...s,evidencePath:s.path,reason:'recorded_manual_stop_requires_explicit_resume'}))];
 const unresolved=all.filter(x=>x.cannotOverride||!ackReasons.has(x.reason)||!known.has(acknowledgement(x)));
 // Even an acknowledged old disabled snapshot cannot exempt a later observed disable.
 for(const task of host.tasks??[]){const previous=old.tasks.find(x=>x.name===task.name);if(previous?.enabled===true&&task.enabled===false)unresolved.push({reason:'new_task_disable_observed',sha256:valueSha(task),cannotOverride:true});}
 if(old.invalidated)unresolved.push({reason:'persistent_control_previously_invalidated',sha256:valueSha(old),cannotOverride:true});
 const invalidated=unresolved.length>0;
 const sticky=new Set(['active_stop_marker','recorded_manual_stop_requires_explicit_resume','started_without_confirmed_exit_or_stop','terminal_receipt_requires_owner_binding_review','run_directory_without_started_receipt','lifecycle_evidence_invalid','new_task_disable_observed']);
 const latch=old.invalidated||unresolved.some(x=>sticky.has(x.reason)||(x.reason==='task_disabled_unknown_or_stopped'&&(x.task?.enabled===false||[267014,3221225786].includes(x.task?.lastResult))));
 const tasks=(host.tasks??[]).map(t=>typeof t.enabled==='boolean'?t:old.tasks.find(x=>x.name===t.name)??t);
 // No write is needed when nothing changed; repeated observations are still fresh.
 if(!old.invalidated&&(latch||valueSha(old.tasks)!==valueSha(tasks)))appendState(p,spec,old,{at:now,tasks,invalidated:latch,reasons:[...new Set(unresolved.map(x=>x.reason))]});
 complete=true;return {valid:!invalidated,unresolved,controlPolicySha256:spec.sha256,stateDirectory:p.stateDirectory,expiresAt:null};
 }finally{closeSync(fd);if(complete)unlinkSync(lock);} // interrupted/uncertain writes stay blocked for review
}
