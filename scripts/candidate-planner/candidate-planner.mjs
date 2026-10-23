/** Pure candidate-intent planner. Never starts a process, trains or activates. */
import {createHash} from 'node:crypto';
export const VERSION='rich-candidate-intent-planner.v1';
export const FAMILIES=['prematch_map_winner','postdraft_map_winner','live_map_winner','prematch_kills_total','prematch_duration_total','live_kills_total','live_duration_total','series_winner'];
export const DEFAULT_POLICY={version:VERSION,policyId:'aegis-rich-candidates-48h-30d-v1',patchDelayHours:48,monthlyPeriodDays:30,officialMaxAgeHours:48,evidenceMaxAgeSeconds:300,families:FAMILIES,dispatchEnabled:false,publicPromotion:false};
export const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(x=>stable(x)??'null').join(',')+']':'{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
export const hash=v=>createHash('sha256').update(stable(v)).digest('hex');
export const timestamp=v=>typeof v==='string'&&/T.*(Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
const positive=v=>Number.isSafeInteger(v)&&v>0;
const digest=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const iso=v=>new Date(v).toISOString();
export function comparePatch(a,b){
 const parts=v=>{if(typeof v!=='string'||! /^[1-9][0-9]{0,2}\.[0-9]{2}[a-z]?$/.test(v))throw Error('invalid_letter_patch');const [major,tail]=v.split('.');return[Number(major),Number(tail.slice(0,2)),tail.length===3?tail.charCodeAt(2)-96:0];};
 const x=parts(a),y=parts(b);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];
}
function validatePolicy(p){
 if(p.version!==VERSION||typeof p.policyId!=='string'||!p.policyId||p.dispatchEnabled!==false||p.publicPromotion!==false)throw Error('candidate_only_policy_required');
 if(!positive(p.patchDelayHours)||p.patchDelayHours>720||!positive(p.monthlyPeriodDays)||p.monthlyPeriodDays>366||!positive(p.officialMaxAgeHours)||p.officialMaxAgeHours>168||!positive(p.evidenceMaxAgeSeconds)||p.evidenceMaxAgeSeconds>3600)throw Error('policy_limits_invalid');
 if(!Array.isArray(p.families)||stable([...p.families].sort())!==stable([...FAMILIES].sort()))throw Error('all_required_model_families_required');
}
const fresh=(at,now,seconds)=>timestamp(at)!==null&&timestamp(at)<=now&&now-timestamp(at)<=seconds*1000;
function receiptValid(r,p,now){return r?.verifiedFileBinding===true&&r?.status==='evaluation_complete'&&r?.policyId===p.policyId&&digest(r.reportSha256)&&digest(r.artifactManifestSha256)&&digest(r.datasetManifestSha256)&&timestamp(r.completedAt)!==null&&timestamp(r.verifiedAt)!==null&&timestamp(r.completedAt)<=timestamp(r.verifiedAt)&&timestamp(r.verifiedAt)<=now&&Array.isArray(r.families)&&p.families.every(f=>r.families.includes(f))&&Array.isArray(r.coveredTriggerIds)&&r.coveredTriggerIds.every(digest);}
function bindingReasons(bindings,p,now){
 if(!bindings?.verifiedFileBinding||bindings.status!=='approved_dynamic_rich_runner'||bindings.policyId!==p.policyId)return ['blocked_runner_binding_unavailable'];
 if(timestamp(bindings.approvedAt)===null||timestamp(bindings.approvedAt)>now||timestamp(bindings.expiresAt)===null||timestamp(bindings.expiresAt)<=now||bindings.dispatchEnabled!==false||bindings.publicPromotion!==false)return ['blocked_runner_binding_invalid_or_expired'];
 if(!digest(bindings.runnerManifestSha256)||!digest(bindings.featureContractSha256)||!digest(bindings.resourceGuardSha256)||!Array.isArray(bindings.families)||!p.families.every(f=>bindings.families.includes(f))||bindings.scope!=='new_dynamic_candidate_contract'||bindings.oneNativeFit!==true||bindings.threads!==4||bindings.rssLimitBytes!==16000000000||bindings.minimumFreeBytes!==4294967296)return ['blocked_runner_binding_invalid_or_incomplete'];
 return [];
}
function blockers(inputs,p,now,sourceProblem){
 const reasons=[...(inputs.inputValidationProblems??[])];
 if(inputs.manualControl?.paused===true)reasons.push('blocked_manual_pause');
 else if(inputs.manualControl?.paused!==false||inputs.manualControl?.verifiedFileBinding!==true)reasons.push('blocked_manual_control_unknown');
 if(sourceProblem)reasons.push(sourceProblem);
 const fit=inputs.fitObservation;
 if(fit?.state==='busy'&&fresh(fit.observedAt,now,p.evidenceMaxAgeSeconds)&&fit.ownerVerified===true)reasons.push('blocked_native_fit_busy');
 else if(fit?.state!=='idle'||fit.ownerVerified!==true||!fresh(fit?.observedAt,now,p.evidenceMaxAgeSeconds))reasons.push('blocked_fit_owner_unverified');
 const d=inputs.dataReadiness;
 if(!d?.verifiedFileBinding||!fresh(d.observedAt,now,p.evidenceMaxAgeSeconds))reasons.push('blocked_data_readiness_unverified');
 else for(const f of p.families){const x=d.families?.[f];if(x?.ready!==true||!digest(x.datasetManifestSha256)||!digest(x.splitManifestSha256)||!digest(x.featureContractSha256)||x.causalLiveParityVerified!==true||x.groupedTemporalSplitVerified!==true)reasons.push('blocked_data_not_ready:'+f);}
 reasons.push(...bindingReasons(inputs.runnerBindings,p,now));return [...new Set(reasons)].sort();
}
/** Inputs are offline verified snapshots. All lifecycle state remains explicit. */
export function plan(inputs){
 const p=inputs.policy??DEFAULT_POLICY;validatePolicy(p);const now=timestamp(inputs.now);if(now===null)throw Error('valid_explicit_now_required');
 const existing=inputs.intents??[],states=inputs.intentStates??{};
 if(!Array.isArray(existing)||existing.length>10000)throw Error('bounded_intent_inventory_required');
 const maxSeen=Math.max(0,...existing.map(i=>timestamp(i.createdAt)??Infinity),...Object.values(states).map(s=>timestamp(s.observedAt)??Infinity));
 if(now<maxSeen)throw Error('planner_clock_moved_backwards');
 const receipts=(inputs.evaluationReceipts??[]).filter(r=>receiptValid(r,p,now)).sort((a,b)=>timestamp(a.completedAt)-timestamp(b.completedAt)||a.reportSha256.localeCompare(b.reportSha256));
 const last=receipts.at(-1),covered=new Set(receipts.flatMap(r=>r.coveredTriggerIds));let sourceProblem=null;let patch=null;const o=inputs.official;
 if(o?.verifiedFileBinding!==true||o.source!=='valve'||o.status!=='succeeded')sourceProblem='blocked_patch_source_unverified';
 else if(timestamp(o.lastSuccessfulReceivedAt)===null||timestamp(o.lastSuccessfulReceivedAt)>now||now-timestamp(o.lastSuccessfulReceivedAt)>p.officialMaxAgeHours*3600000)sourceProblem='blocked_patch_source_stale';
 else {
  const release=timestamp(o.releasedAt),known=timestamp(o.firstKnownAt),observed=timestamp(o.snapshotReceivedAt);
  try{comparePatch(o.version,o.version);}catch{sourceProblem='blocked_patch_version_invalid';}
  if(release===null||known===null||observed===null||release>known||release>observed||known>observed||observed>timestamp(o.lastSuccessfulReceivedAt)||!digest(o.catalogHash)||!digest(o.snapshotFileSha256))sourceProblem='blocked_patch_source_clock_or_hash';
  if(!sourceProblem){
   const previousPatches=existing.flatMap(i=>i.triggers).filter(t=>t.kind==='patch');
   if(previousPatches.some(t=>comparePatch(t.patchVersion,o.version)>0))sourceProblem='blocked_patch_catalog_regressed';
   else if(previousPatches.some(t=>t.patchVersion===o.version&&(t.releasedAt!==o.releasedAt||timestamp(t.firstKnownAt)!==known)))sourceProblem='blocked_patch_same_version_identity_changed';
   else patch={kind:'patch',patchVersion:o.version,releasedAt:o.releasedAt,firstKnownAt:o.firstKnownAt,dueAt:iso(Math.max(release+p.patchDelayHours*3600000,known)),sourceCatalogHash:o.catalogHash,sourceRevisionFileSha256:o.snapshotFileSha256};
  }
 }
 if(patch)patch.triggerId=hash({version:VERSION,policyId:p.policyId,kind:'patch',patchVersion:patch.patchVersion,releasedAt:patch.releasedAt,firstKnownAt:patch.firstKnownAt});
 let monthly=null;
 if(last){monthly={kind:'monthly',anchorEvaluationReportSha256:last.reportSha256,anchorCompletedAt:last.completedAt,dueAt:iso(timestamp(last.completedAt)+p.monthlyPeriodDays*86400000)};monthly.triggerId=hash({version:VERSION,policyId:p.policyId,kind:'monthly',anchor:last.reportSha256});}
 const triggers=[patch,monthly].filter(t=>t&&!covered.has(t.triggerId));
 const due=triggers.filter(t=>timestamp(t.dueAt)<=now);const future=triggers.filter(t=>timestamp(t.dueAt)>now);
 // If monthly is already due while a newer patch is still cooling down, coalesce
 // and wait for that patch's due time rather than requesting two adjacent fits.
 const actionTriggers=due.length?(due.some(t=>t.kind==='monthly')&&patch&&!covered.has(patch.triggerId)?[...due.filter(t=>t.kind!=='patch'),patch]:due):future.length?[future.sort((a,b)=>timestamp(a.dueAt)-timestamp(b.dueAt))[0]]:[];
 const reasonCodes=blockers(inputs,p,now,sourceProblem);const newIntents=[],transitions=[];let chosen=null;
 if(actionTriggers.length){
  const ordered=[...actionTriggers].sort((a,b)=>a.triggerId.localeCompare(b.triggerId));const identity={version:VERSION,policyId:p.policyId,families:p.families,triggerIds:ordered.map(t=>t.triggerId)};const intentId=hash(identity);chosen=existing.find(i=>i.intentId===intentId)??{intentId,identity,createdAt:inputs.now,triggers:ordered,candidateOnly:true,dispatchEnabled:false,publicPromotion:false};
  if(!existing.some(i=>i.intentId===intentId))newIntents.push(chosen);
  const finalState=states[intentId]?.state;const pending=!['evaluation_complete','evaluation_failed','cancelled','superseded'].includes(finalState);
  if(pending&&finalState!=='evaluating'){
   const at=Math.max(...ordered.map(t=>timestamp(t.dueAt)));const state=now<at?'scheduled':reasonCodes.length?'blocked':'ready_for_external_dispatch';
   transitions.push({intentId,state,reasonCodes:state==='scheduled'?['waiting_due_time']:reasonCodes,nextEligibleAt:iso(at),observedAt:inputs.now});
  }
  // Newer full letter patches and coalesced due monthly triggers replace only
  // unstarted intents. An active/partial candidate is NEVER killed/replayed here.
  for(const prior of existing){
   if(prior.intentId===intentId||prior.identity?.policyId!==p.policyId)continue;
   const state=states[prior.intentId]?.state??'pending';if(['evaluating','evaluation_complete','evaluation_failed','cancelled','superseded'].includes(state))continue;
   const olderPatch=patch&&prior.triggers.some(t=>t.kind==='patch'&&comparePatch(t.patchVersion,patch.patchVersion)<0);
   const supersededAnchor=last&&prior.triggers.some(t=>t.kind==='monthly'&&t.anchorEvaluationReportSha256!==last.reportSha256);
   const sameDueSubset=prior.triggers.every(t=>ordered.some(x=>x.triggerId===t.triggerId));
   if(olderPatch||supersededAnchor||sameDueSubset)transitions.push({intentId:prior.intentId,state:'superseded',supersededBy:intentId,reasonCodes:[olderPatch?'newer_letter_patch':supersededAnchor?'new_successful_evaluation_anchor':'coalesced_due_triggers'],observedAt:inputs.now});
  }
 }
 const stateShape=t=>({...t,observedAt:undefined,eventId:undefined,previousEventId:undefined});
 const accepted=transitions.filter(t=>{const old=states[t.intentId];return !old||stable(stateShape(old))!==stable(stateShape(t));}).map(t=>({...t,previousEventId:states[t.intentId]?.eventId??null}));
 return {version:VERSION,at:inputs.now,policyId:p.policyId,newIntents,transitions:accepted,currentIntentId:chosen?.intentId??null,status:chosen?(states[chosen.intentId]?.state==='evaluating'?'evaluating':transitions.find(t=>t.intentId===chosen.intentId)?.state??states[chosen.intentId]?.state??'pending'):'no_due_intent',blockedReasons:reasonCodes,monthlyAnchor:last?{completedAt:last.completedAt,reportSha256:last.reportSha256}:null,monthlyState:last?'anchored_to_verified_evaluation':'blocked_monthly_anchor_unavailable',nextPatchDueAt:patch?.dueAt??null,nextMonthlyDueAt:monthly?.dueAt??null,invalidEvaluationReceiptCount:(inputs.evaluationReceipts??[]).length-receipts.length,trainingStarted:false,nativeFits:0,publicPromotion:false,dispatchEnabled:false};
}
