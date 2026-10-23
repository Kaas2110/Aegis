/** Saved local inputs only. No provider request or training module import. */
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {isAbsolute,join,basename} from 'node:path';
import {comparePatch,timestamp,hash} from './candidate-planner.mjs';
const SOURCE='https://www.dota2.com/datafeed/patchnoteslist?language=english';
export const bytesHash=b=>createHash('sha256').update(b).digest('hex');
function read(path,max=4*1024**2){if(!isAbsolute(path)||lstatSync(path).isSymbolicLink()||lstatSync(path).size>max)throw Error('bounded_absolute_local_file_required');return readFileSync(path);}
export function readVerified(spec){
 if(!spec)return null;
 const b=read(spec.path);if(bytesHash(b)!==spec.sha256)throw Error('saved_input_pin_changed');const doc=JSON.parse(b);return {...doc,verifiedFileBinding:true,sourceFileSha256:spec.sha256};
}
export function officialFromSaved(stateDir){
 try{
  const checkpointBytes=read(join(stateDir,'valve-patch-catalog-state.json'));const state=JSON.parse(checkpointBytes);const ref=state.snapshot;
  if(state.version!==1||state.source!==SOURCE||state.status!=='succeeded'||!ref||typeof ref.file!=='string'||basename(ref.file)!==ref.file||!/^valve-patches-[\dTZ-]+-[a-f0-9]{64}-[a-f0-9-]{36}\.json$/.test(ref.file))throw Error('invalid_saved_valve_checkpoint');
  const b=read(join(stateDir,ref.file));const s=JSON.parse(b),observed=timestamp(s.receivedAt),known=timestamp(s.observation?.knownAt);
  if(s.version!==1||s.source!==SOURCE||s.identity!=='valve_patch_catalog'||s.calendarOnly!==true||observed===null||known===null||known>observed||timestamp(ref.receivedAt)!==observed||!Array.isArray(s.catalog)||s.catalog.length===0||s.catalog.length>5000)throw Error('invalid_saved_valve_revision');
  const names=new Set();for(const p of s.catalog){comparePatch(p.name,p.name);if(p.id!==undefined||timestamp(p.date)===null||names.has(p.name))throw Error('invalid_saved_valve_catalog');names.add(p.name);}
  const sorted=[...s.catalog].sort((a,b)=>timestamp(a.date)-timestamp(b.date)||comparePatch(a.name,b.name));
  const latest=sorted.filter(p=>timestamp(p.date)<=observed).at(-1);const catalogHash=bytesHash(Buffer.from(JSON.stringify(sorted)));
  if(JSON.stringify(sorted)!==JSON.stringify(s.catalog)||catalogHash!==s.hash||catalogHash!==ref.hash||JSON.stringify(latest)!==JSON.stringify(s.latest)||JSON.stringify(latest)!==JSON.stringify(ref.latest)||JSON.stringify(s.observation)!==JSON.stringify(state.observation)||s.observation.name!==latest.name||s.observation.releasedAt!==latest.date||s.observation.trainingEnabled!==false||s.observation.recommendationOnly!==true||s.observation.requiresDataAndQualityGate!==true)throw Error('saved_valve_binding_mismatch');
  // Existing observer still records its old7-day recommendation. Planner derives
  // a separate48h due time, never rewrites that old evidence or backdates knownAt.
  const oldDue=Math.max(timestamp(latest.date)+7*86400000,known);
  if(s.observation.policy!=='release_plus_7_days_not_before_observation'||timestamp(s.observation.retrainingEligibilityAt)!==oldDue)throw Error('saved_observer_policy_mismatch');
  return {verifiedFileBinding:true,source:'valve',status:'succeeded',version:latest.name,releasedAt:latest.date,firstKnownAt:s.observation.knownAt,snapshotReceivedAt:s.receivedAt,lastSuccessfulReceivedAt:state.lastSuccessfulReceivedAt,catalogHash,snapshotFileSha256:bytesHash(b),checkpointFileSha256:bytesHash(checkpointBytes),originalObserverRecommendationAt:s.observation.retrainingEligibilityAt};
 }catch{return {verifiedFileBinding:false,source:'valve',status:'unavailable',reason:'saved_valve_verification_failed'};}
}
export function evaluationReceipts(specs=[]){
 if(!Array.isArray(specs)||specs.length>1000)throw Error('evaluation_receipt_bound');
 return specs.map(spec=>{
  const r=readVerified(spec);const report=readVerified(r.report),artifact=readVerified(r.artifactManifest),dataset=readVerified(r.datasetManifest);
  if(report.status!=='evaluation_complete'||report.policyId!==r.policyId||report.completedAt!==r.completedAt||report.artifactManifestSha256!==r.artifactManifest.sha256||report.datasetManifestSha256!==r.datasetManifest.sha256||JSON.stringify(report.coveredTriggerIds)!==JSON.stringify(r.coveredTriggerIds)||JSON.stringify(report.families)!==JSON.stringify(r.families)||artifact.candidateOnly!==true||artifact.publicPromotion!==false||dataset.temporalSplitFrozen!==true)throw Error('evaluation_receipt_artifact_binding');
  return {...r,reportSha256:r.report.sha256,artifactManifestSha256:r.artifactManifest.sha256,datasetManifestSha256:r.datasetManifest.sha256,proofScope:'pinned_completed_evaluation_report_and_manifests; not promotion approval'};
 });
}
