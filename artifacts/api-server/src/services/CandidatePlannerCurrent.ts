/** Read-only projection of a saved candidate planner report. No executor imports. */
import {createHash} from 'node:crypto';
import {lstatSync,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';

const VERSION='rich-candidate-intent-planner.v1';
const FAMILIES=['prematch_map_winner','postdraft_map_winner','live_map_winner','prematch_kills_total','prematch_duration_total','live_kills_total','live_duration_total','series_winner'];
const STATUSES=new Set(['blocked','scheduled','ready_for_external_dispatch','evaluating','no_due_intent','pending','evaluation_complete','evaluation_failed','cancelled','superseded']);
const SHA=/^[a-f0-9]{64}$/;
const MAX_AGE_MS=2*60*60*1000;
type Json=Record<string,unknown>;
const record=(value:unknown):value is Json=>!!value&&typeof value==='object'&&!Array.isArray(value);
const time=(value:unknown):number|null=>typeof value==='string'&&/T.*(Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function readBounded(file:string,maxBytes:number):Buffer {
  if(!isAbsolute(file)||lstatSync(file).isSymbolicLink())throw Error('invalid_local_file');
  const fd=openSync(file,'r');
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>maxBytes)throw Error('file_bound');
    const bytes=readFileSync(fd);
    if(bytes.length>maxBytes)throw Error('file_bound');
    return bytes;
  } finally {closeSync(fd);}
}
const nullableDate=(value:unknown)=>value===null||time(value)!==null;
function project(report:unknown,policyId:string) {
  if(!record(report)||report.version!==VERSION||report.policyId!==policyId
    ||report.dispatchEnabled!==false||report.publicPromotion!==false
    ||report.trainingStarted!==false||report.nativeFits!==0
    ||typeof report.status!=='string'||!STATUSES.has(report.status)
    ||time(report.at)===null||!nullableDate(report.nextPatchDueAt)||!nullableDate(report.nextMonthlyDueAt)
    ||!(report.currentIntentId===null||(typeof report.currentIntentId==='string'&&SHA.test(report.currentIntentId)))
    ||!Array.isArray(report.blockedReasons)||report.blockedReasons.length>64
    ||!report.blockedReasons.every(x=>typeof x==='string'&&/^blocked_[a-z0-9_]+(?::[a-z0-9_]+)?$/.test(x)&&x.length<=160)
    ||!['anchored_to_verified_evaluation','blocked_monthly_anchor_unavailable'].includes(String(report.monthlyState)))throw Error('invalid_current');
  const anchor=report.monthlyAnchor;
  if(!(anchor===null||(record(anchor)&&time(anchor.completedAt)!==null&&typeof anchor.reportSha256==='string'&&SHA.test(anchor.reportSha256))))throw Error('invalid_anchor');
  return {recordedAt:report.at as string,recordedStatus:report.status,currentIntentId:report.currentIntentId,
    blockedReasons:report.blockedReasons as string[],monthlyState:report.monthlyState,
    monthlyAnchor:anchor===null?null:{completedAt:(anchor as Json).completedAt,reportSha256:(anchor as Json).reportSha256},
    nextPatchDueAt:report.nextPatchDueAt,nextMonthlyDueAt:report.nextMonthlyDueAt};
}
export function readCandidatePlannerCurrent(env:NodeJS.ProcessEnv=process.env,nowMs=Date.now()) {
  const base={version:VERSION,scope:'candidate_intent_planning_only',dispatchEnabled:false,publicPromotion:false,
    trainingStarted:false,nativeFits:0,families:FAMILIES,maxAgeSeconds:MAX_AGE_MS/1000};
  const blocked=(reason:string,availability='unavailable')=>({...base,status:'blocked',availability,blockedReasons:[reason]});
  const configPath=env.AEGIS_CANDIDATE_PLANNER_CONFIG,configSha=env.AEGIS_CANDIDATE_PLANNER_CONFIG_SHA256;
  if(!configPath||!configSha)return blocked('blocked_planner_config_unavailable');
  let config:Json;
  try {
    if(!SHA.test(configSha))throw Error('config_pin');
    const bytes=readBounded(configPath,1024**2);if(sha(bytes)!==configSha)throw Error('config_pin');
    const raw:unknown=JSON.parse(bytes.toString('utf8'));if(!record(raw))throw Error('config_shape');config=raw;
    if(typeof config.outputDir!=='string'||!isAbsolute(config.outputDir)
      ||typeof config.stateDir!=='string'||!isAbsolute(config.stateDir)
      ||resolve(config.outputDir).toLowerCase()===resolve(config.stateDir).toLowerCase()
      ||!record(config.policy)||config.policy.version!==VERSION||typeof config.policy.policyId!=='string'
      ||config.policy.dispatchEnabled!==false||config.policy.publicPromotion!==false)throw Error('config_shape');
  } catch {return blocked('blocked_planner_config_invalid','invalid');}
  let bytes:Buffer;
  try {bytes=readBounded(join(config.outputDir as string,'CURRENT.json'),4*1024**2);}
  catch {return blocked('blocked_planner_current_unavailable');}
  try {
    const current=project(JSON.parse(bytes.toString('utf8')),(config.policy as Json).policyId as string);
    const at=time(current.recordedAt)!;
    if(!Number.isFinite(nowMs)||at>nowMs)return blocked('blocked_planner_current_invalid','invalid');
    if(nowMs-at>MAX_AGE_MS)return {...base,...current,status:'blocked',availability:'stale',blockedReasons:['blocked_planner_current_stale',...current.blockedReasons]};
    return {...base,...current,status:current.recordedStatus,availability:'available'};
  } catch {return blocked('blocked_planner_current_invalid','invalid');}
}
