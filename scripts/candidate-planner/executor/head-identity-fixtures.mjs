/** Synthetic fixtures only. No models, observations or real fit claims. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {FAMILIES,SERIES_HEADS,expectedResultForPlan} from '../head-identity.mjs';
import {makeIntentFitPlans} from '../plan-rich-fit.mjs';
const H='a'.repeat(64),scope={policyId:'policy-\u03b1',intentId:'intent-\u0434\u043e\u0442\u0430'},clone=x=>structuredClone(x),hash=b=>createHash('sha256').update(b).digest('hex');
function registry(){return {contract:'aegis.dynamic-rich-runner-registry.v2',policyId:scope.policyId,families:Object.fromEntries(FAMILIES.map(f=>[f,{heads:Object.fromEntries((f==='series_winner'?SERIES_HEADS:['main']).map(head=>[head,{scope:'new_dynamic_candidate_contract',singleFit:true,entryPoint:'fit_one',contract:'aegis.rich-fit-adapter.v2',backend:'lightgbm-lazyColumnSample',source:{path:join(tmpdir(),`${head}.py`),sha256:H},recipe:{path:join(tmpdir(),`${head}.json`),sha256:H}}]))}]))};}
function plans(root){const readiness={families:Object.fromEntries(FAMILIES.map(f=>[f,{ready:true,causalLiveParityVerified:true,groupedTemporalSplitVerified:true,datasetManifestSha256:H,featureContractSha256:H,splitManifestSha256:H,features:3426}]))};return makeIntentFitPlans({...scope,registry:registry(),readiness,common:{localLock:join(root,'executor.lock'),claimRoot:join(root,'claims'),resources:{threads:4,rssLimitBytes:16000000000,minimumFreeBytes:4294967296,concurrentFits:1}},outputRoot:join(root,'runs')});}
function approval(p,sha=H){return {contract:'aegis.single-fit-root-approval.v2',approved:true,approvedBy:'root',identity:p.identity,fitId:p.fitId,planSha256:sha,nativeFits:1,automaticRetry:false,publicPromotion:false,expiresAtUnix:1792717200};}
function result(p,e,artifact=H){return {contract:'aegis.rich-fit-result.v2',status:'fit_complete',identity:p.identity,fitId:p.fitId,bindings:e.bindings,nativeFits:1,trees:256,stateFeatures:p.stateFeatures,candidateAxisFeatures:p.candidateAxisFeatures,featureCount:p.stateFeatures+p.candidateAxisFeatures,fullInventoryRetained:true,serializedParity:true,noOuterHoldout:true,candidateOnly:true,publicPromotion:false,artifacts:{'model.txt':artifact}};}
function temp(t){const p=mkdtempSync(join(tmpdir(),'aegis-head-v2-'));t.after(()=>{assert.ok(resolve(p).startsWith(resolve(tmpdir())+'\\aegis-head-v2-')||resolve(p).startsWith(resolve(tmpdir())+'/aegis-head-v2-'));rmSync(p,{recursive:true,force:true});});return p;}
function put(path,value){const b=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));mkdirSync(dirname(path),{recursive:true});writeFileSync(path,b);return {path,bytes:b.length,sha256:hash(b)};}
function completed(t){const root=temp(t),bundle=plans(root),entries=[];for(const p of bundle.plans){
 const dir=p.outputDir,plan=put(join(dir,'plan.json'),p),ap=approval(p,plan.sha256),approvalPin=put(join(dir,'approval.json'),ap),artifact=put(join(dir,'model.txt'),Buffer.from('candidate artifact')),e=expectedResultForPlan(p,plan.sha256,approvalPin.sha256),r=result(p,e,artifact.sha256),resultPin=put(join(dir,'DONE.json'),r),startedAt=new Date((ap.expiresAtUnix-300)*1000).toISOString(),endedAt=new Date((ap.expiresAtUnix-200)*1000).toISOString();
 const started=put(join(dir,'STARTED.json'),{identity:p.identity,fitId:p.fitId,planSha256:plan.sha256,approvalSha256:approvalPin.sha256,startedAt,automaticRetry:false});
 const resource=put(join(dir,'RESOURCE.json'),{returncode:0,exit_code_observed:true,monitoring_valid:true,family_cleanup_confirmed:true,forced_termination_requested:false,stop_reason:null,peak_aggregate_rss_bytes:1000000,minimum_available_bytes:8000000000});
 const exit=put(join(dir,'EXIT.json'),{identity:p.identity,fitId:p.fitId,startedSha256:started.sha256,exitCode:0,ownershipLocksRetained:false,automaticRetry:false,nextStageStarted:false});
 const c={contract:'aegis.single-native-fit-closure.v1',identity:p.identity,fitId:p.fitId,resultSha256:resultPin.sha256,resourceSha256:resource.sha256,exitSha256:exit.sha256,nativeFits:1,exitCode:0,exitObserved:true,monitoringValid:true,familyCleanupConfirmed:true,ownershipLocksRetained:false,forcedTermination:false,automaticRetry:false,threads:4,peakAggregateRssBytes:1000000,minimumAvailableBytes:8000000000,startedAt,endedAt};
 entries.push({plan,approval:approvalPin,result:resultPin,closure:put(join(dir,'CLOSED-FIT.json'),c)});
 }return {...scope,entries,maximumVerificationBytes:10000000};}

export {H,scope,clone,plans,registry,approval,result,temp,put,completed};
