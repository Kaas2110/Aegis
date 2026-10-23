import {createHash} from 'node:crypto';
import {evidenceHash} from '../lib/predictionEvidence';
import {LIVE_OBSERVATION_SCHEMA_HASH} from '../lib/liveObservationContract';
import {POSTDRAFT_PINS,POSTDRAFT_FEATURE_NAMES} from './PostdraftShadowPins';

export {POSTDRAFT_PINS,POSTDRAFT_FEATURE_NAMES};
export const postdraftCandidateHash=()=>evidenceHash(POSTDRAFT_PINS);
export const postdraftWireHash=(body:PostdraftBody)=>createHash('sha256').update(JSON.stringify(body)).digest('hex');
export type PostdraftBody={current:{observationId:string;source:'opendota';targetScope:'map';clockUnit:'seconds';
  receivedAt:string;recordedAt:string;phase:string;input:Record<string,unknown>;availability:Record<string,unknown>;
  sourceInputHash:string;sourceSchemaHash:string};expectedMatchId:number;outcomeKnownAtDispatch:boolean|null};
export type PostdraftRequest={id:string;body:PostdraftBody;dispatchedAt:Date;
  outcomeKnownAtDispatch:boolean|null;outcomeKnownAtCapture:boolean|null;evidence:Record<string,unknown>};
export type PostdraftCompletion={status:'predicted'|'unavailable'|'error';reason:string|null;completedAt:Date;
  response:Record<string,unknown>|null;assessment:Record<string,unknown>};
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
const hex=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const stamp=(x:unknown)=>typeof x==='string'?Date.parse(x):NaN;
const failure=()=>{throw new Error('postdraft_response_contract_rejected');};

/** Rejections remain durable attempts; they never become an imputed input vector. */
export function postdraftPreflight(request:PostdraftRequest,now=new Date()):string|null {
  const body=request.body,c=body.current,p=c.input,clock=p.gameTimeSec;
  if(request.outcomeKnownAtDispatch===true||request.outcomeKnownAtCapture===true)return 'outcome_already_known';
  if(request.outcomeKnownAtDispatch!==false||request.outcomeKnownAtCapture!==false)return 'outcome_availability_unknown';
  if(c.sourceSchemaHash!==LIVE_OBSERVATION_SCHEMA_HASH||c.sourceInputHash!==evidenceHash(p))return 'source_hash_mismatch';
  const received=stamp(c.receivedAt),recorded=stamp(c.recordedAt);
  if(!Number.isFinite(received)||!Number.isFinite(recorded)||received>recorded||recorded>now.getTime()
    ||now.getTime()-received>=180_000||received>now.getTime())return 'observation_stale_or_future';
  if(!Number.isSafeInteger(clock)||Number(clock)<-3600||Number(clock)>=60)return 'outside_postdraft_phase';
  if(c.availability.draftComplete!==true)return 'draft_not_complete';
  const players=p.players;
  if(!Array.isArray(players)||players.length!==10||players.some(v=>!record(v)
    ||!Number.isSafeInteger(v.heroId)||Number(v.heroId)<1||Number(v.heroId)>250
    ||!Number.isSafeInteger(v.accountId)||Number(v.accountId)<1||Number(v.accountId)>=4294967295
    ||(v.team!==0&&v.team!==1)))return 'complete_supported_roster_required';
  if(players.filter(v=>v.team===0).length!==5||new Set(players.map(v=>v.heroId)).size!==10
    ||new Set(players.map(v=>v.accountId)).size!==10)return 'invalid_observed_roster';
  if(!Number.isSafeInteger(p.radiantTeamId)||!Number.isSafeInteger(p.direTeamId)
    ||Number(p.radiantTeamId)<=0||Number(p.direTeamId)<=0||p.radiantTeamId===p.direTeamId
    ||p.matchId!==body.expectedMatchId)return 'invalid_map_identity';
  if(c.phase!==(Number(clock)<0?'post_draft':'live'))return 'phase_mismatch';
  return null;
}

/** numpy float32 little-endian with canonical quiet NaN; independent vector hash. */
export function postdraftVectorHash(values:readonly (number|null)[]):string {
  const bytes=Buffer.alloc(values.length*4);
  values.forEach((v,i)=>v===null?bytes.writeUInt32LE(0x7fc00000,i*4):bytes.writeFloatLE(v,i*4));
  return createHash('sha256').update(bytes).digest('hex');
}

export function checkedPostdraftResponse(raw:unknown,request:PostdraftRequest,completedAt=new Date()):Record<string,unknown>{
  if(!record(raw))return failure();
  evidenceHash(raw);
  for(const [key,value] of Object.entries(POSTDRAFT_PINS))if(raw[key]!==value)return failure();
  const c=request.body.current;
  if(raw.executionMode!=='runtime_shadow'||raw.target!=='map_radiant_win'||raw.targetScope!=='map'
    ||raw.observationId!==c.observationId||raw.matchId!==request.body.expectedMatchId
    ||raw.requestBodySha256!==postdraftWireHash(request.body)
    ||stamp(raw.receivedAt)!==stamp(c.receivedAt)||stamp(raw.recordedAt)!==stamp(c.recordedAt)
    ||!Number.isFinite(stamp(raw.computedAt))
    ||stamp(raw.computedAt)+100<Math.max(stamp(c.recordedAt),request.dispatchedAt.getTime())
    ||stamp(raw.computedAt)>completedAt.getTime()+100)return failure();
  for(const key of ['active','eligibleForServing','eligibleForPromotion','prospectiveValidated','eventLatencyVerified','meetsVerifiedLiveLatencyPolicy'])
    if(raw[key]!==false)return failure();
  if(raw.calibratedProbability!==null||raw.measuredEndToEndLatencySeconds!==null||!record(raw.cache))return failure();
  if(raw.status==='unavailable'){
    if(typeof raw.reason!=='string'||!/^[-a-zA-Z0-9_:]{1,200}$/.test(raw.reason)||raw.rawProbability!==null
      ||raw.featureValues!==null||raw.missingMask!==null)return failure();
    return raw;
  }
  const values=raw.featureValues,masks=raw.missingMask,names=raw.featureNames,cache=raw.cache;
  if(raw.status!=='shadow_predicted'||raw.reason!==null||!finite(raw.rawProbability)||raw.rawProbability<0||raw.rawProbability>1
    ||!hex(raw.inputHash)||raw.historyManifestSha256!==cache.historyManifestSha256
    ||raw.phase!==(Number(c.input.gameTimeSec)<0?'postdraft':'early_live_draft_context')
    ||raw.featureDtype!=='float32'||!Array.isArray(values)||!Array.isArray(masks)||!Array.isArray(names)
    ||values.length!==6668||masks.length!==6668||names.length!==6668
    ||names.some((n,i)=>n!==POSTDRAFT_FEATURE_NAMES[i])
    ||values.some((v,i)=>typeof masks[i]!=='boolean'||(v===null)!==masks[i]
      ||(v!==null&&(!finite(v)||!Number.isFinite(Math.fround(v))||Math.fround(v)!==v)))
    ||raw.featureVectorHash!==postdraftVectorHash(values as (number|null)[]))return failure();
  const cutoff=stamp(cache.snapshotCutoff),built=stamp(cache.builtAt),received=stamp(c.receivedAt);
  if(cache.state!=='ready'||!hex(cache.rawSnapshotSha256)||!hex(cache.referenceSha256)||!hex(cache.historyManifestSha256)
    ||!Number.isFinite(cutoff)||!Number.isFinite(built)||cutoff>built||built>received
    ||completedAt.getTime()-cutoff>86_400_000||completedAt.getTime()-received>=180_000)return failure();
  return raw;
}

export function postdraftAssessment(request:PostdraftRequest,completedAt:Date){return {
  executionMode:'runtime_shadow',targetScope:'map',modelPhase:'postdraft',eligibleForServing:false,eligibleForPromotion:false,
  eligibleForProspectiveEvaluation:false,prospectiveValidated:false,eventLatencyVerified:false,
  meetsVerifiedLiveLatencyPolicy:false,measuredEndToEndLatencySeconds:null,
  receiptToCompletionSeconds:(completedAt.getTime()-stamp(request.body.current.receivedAt))/1000,
  sourceAssessment:request.evidence.sourceAssessment??null,
  outcomeCheckMeaning:'local DB snapshots at capture/dispatch/finish, not authoritative game event time',
};}
export function refusedPostdraft(request:PostdraftRequest,reason:string,now=new Date()):PostdraftCompletion{
  return {status:'unavailable',reason,completedAt:now,response:null,assessment:postdraftAssessment(request,now)};
}
export async function runPreparedPostdraft(request:PostdraftRequest,deps:{infer:(body:PostdraftBody)=>Promise<unknown>;
  finish:(request:PostdraftRequest,result:PostdraftCompletion)=>Promise<void>;now?:()=>Date}):Promise<void>{
  const now=deps.now??(()=>new Date()),preflight=postdraftPreflight(request,now());
  if(preflight){await deps.finish(request,refusedPostdraft(request,preflight,now()));return;}
  let completedAt:Date,status:PostdraftCompletion['status']='error',reason:string|null='postdraft_inference_failed';
  let response:Record<string,unknown>|null=null;
  try{const raw=await deps.infer(request.body);completedAt=now();response=checkedPostdraftResponse(raw,request,completedAt);
    status=response.status==='shadow_predicted'?'predicted':'unavailable';reason=status==='predicted'?null:String(response.reason);
  }catch(error){completedAt=now();const message=(error as Error).message;
    if(['postdraft_response_contract_rejected','postdraft_service_timeout','postdraft_service_unauthorized',
      'postdraft_service_unavailable','postdraft_service_token_missing'].includes(message))reason=message;
  }
  await deps.finish(request,{status,reason,completedAt,response,assessment:postdraftAssessment(request,completedAt)});
}
