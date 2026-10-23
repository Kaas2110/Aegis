/** Offline verified result assembly. No evaluation, monthly anchor or dispatch. */
import {dirname,resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {localFile,streamedPin,child,digest,instant} from '../evidence.mjs';
import {canonical,expectedResultForPlan,validateFitResult,validateFitApproval,verifyCompleteFitSet} from '../head-identity.mjs';
const need=(ok,why)=>{if(!ok)throw Error(why);};
function document(pin,budget){streamedPin(pin,budget);localFile(pin.path,8*1024**2);return JSON.parse(readFileSync(pin.path,'utf8').replace(/^\uFEFF/,''));}
function linked(root,name,sha256,budget){const path=child(root,name),s=localFile(path,8*1024**2);return document({path,bytes:s.size,sha256},budget);}
function closure(c,r,entry,p,budget){
 need(c?.contract==='aegis.single-native-fit-closure.v1'&&c.fitId===r.fitId&&canonical(c.identity)===canonical(r.identity)&&c.resultSha256===entry.result.sha256,'result_resource_closure_binding');
 need(c.nativeFits===1&&c.exitCode===0&&c.exitObserved===true&&c.monitoringValid===true&&c.familyCleanupConfirmed===true&&c.ownershipLocksRetained===false&&c.forcedTermination===false&&c.automaticRetry===false&&c.threads===4,'successful_single_fit_closure_required');
 need(Number.isFinite(c.peakAggregateRssBytes)&&c.peakAggregateRssBytes>0&&c.peakAggregateRssBytes<16000000000&&Number.isFinite(c.minimumAvailableBytes)&&c.minimumAvailableBytes>=4294967296,'closed_fit_resource_bounds');
 const start=instant(c.startedAt),end=instant(c.endedAt);need(end>=start,'closed_fit_chronology');
 const root=dirname(entry.result.path),resource=linked(root,'RESOURCE.json',c.resourceSha256,budget),exit=linked(root,'EXIT.json',c.exitSha256,budget),started=linked(root,'STARTED.json',exit.startedSha256,budget);
 need(started.startedAt===c.startedAt&&started.fitId===r.fitId&&canonical(started.identity)===canonical(r.identity)&&started.planSha256===entry.plan.sha256&&started.approvalSha256===entry.approval.sha256&&started.automaticRetry===false,'closed_fit_start_binding');
 need(exit.fitId===r.fitId&&canonical(exit.identity)===canonical(r.identity)&&exit.exitCode===0&&exit.ownershipLocksRetained===false&&exit.automaticRetry===false&&exit.nextStageStarted===false,'closed_fit_exit_binding');
 need(resource.returncode===0&&resource.exit_code_observed===true&&resource.monitoring_valid===true&&resource.family_cleanup_confirmed===true&&resource.forced_termination_requested===false&&!resource.stop_reason&&resource.peak_aggregate_rss_bytes===c.peakAggregateRssBytes&&resource.minimum_available_bytes===c.minimumAvailableBytes,'closed_fit_resource_record_binding');
 need(resolve(p.outputDir)===resolve(root),'closed_fit_output_binding');return start/1000;
}
export function aggregateFitResults({policyId,intentId,entries,maximumVerificationBytes}){
 need(Array.isArray(entries)&&entries.length===40,'forty_closed_fit_entries_required');
 need(Number.isSafeInteger(maximumVerificationBytes)&&maximumVerificationBytes>0&&maximumVerificationBytes<=64*1024**3,'bounded_verification_budget_required');
 const budget={remaining:maximumVerificationBytes,verified:new Set()},results=[],expectations=[],fits={};
 for(const entry of entries){
  const p=document(entry.plan,budget),a=document(entry.approval,budget),r=document(entry.result,budget),c=document(entry.closure,budget),expected=expectedResultForPlan(p,entry.plan.sha256,entry.approval.sha256);
  validateFitResult(r,expected);need(!fits[r.fitId],'duplicate_closed_fit');
  const startedAt=closure(c,r,entry,p,budget);validateFitApproval(a,{identity:p.identity,planSha256:entry.plan.sha256},startedAt);
  const artifactFiles={};
  for(const [name,sha256] of Object.entries(r.artifacts)){
   need(digest(sha256),'artifact_hash_required');const path=child(dirname(entry.result.path),name),stat=localFile(path,budget.remaining),pin={path,bytes:stat.size,sha256};streamedPin(pin,budget);artifactFiles[name]=pin;
  }
  fits[r.fitId]={result:entry.result,closure:entry.closure,artifactFiles};results.push(r);expectations.push(expected);
 }
 const metadata=verifyCompleteFitSet(results,{policyId,intentId,expectations});
 return {contract:'aegis.rich.closed-fit-set.v2',status:'forty_closed_fits_verified',policyId,intentId,expectedNativeFits:40,metadata,fits,artifactFileBytesVerified:true,resourceClosureVerified:true,evaluationVerified:false,datasetsVerified:false,sourceFileBytesVerified:false,verifiedBytes:maximumVerificationBytes-budget.remaining,wholeIntentReceiptProduced:false,monthlyAnchorCreated:false,dispatchEnabled:false,publicPromotion:false};
}
