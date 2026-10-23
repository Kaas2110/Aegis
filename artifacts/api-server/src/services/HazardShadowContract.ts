import {createHash} from 'node:crypto';
import {evidenceHash} from '../lib/predictionEvidence';
import {LIVE_OBSERVATION_SCHEMA_HASH} from '../lib/liveObservationContract';
import {HAZARD_PINS,HAZARD_FEATURE_NAMES,HAZARD_TEMPERATURES,HAZARD_GRID_PROFILE,HAZARD_LEVELS} from './HazardShadowPins';
export {HAZARD_PINS,HAZARD_FEATURE_NAMES,HAZARD_GRID_PROFILE};
export type HazardLine={target:'kills'|'duration';line:number;unit:'kills'|'seconds';settlement?:'exact_seconds'};
export type HazardBody={current:{observationId:string;source:'opendota';targetScope:'map';clockUnit:'seconds';
 receivedAt:string;recordedAt:string;phase:string;input:Record<string,unknown>;availability:Record<string,unknown>;
 sourceInputHash:string;sourceSchemaHash:string};expectedMatchId:number;outcomeKnownAtDispatch:boolean|null;
 lineSource:'own_diagnostic_grid';lines:HazardLine[]};
export type HazardRequest={id:string;body:HazardBody;dispatchedAt:Date;outcomeKnownAtCapture:boolean|null;
 outcomeKnownAtDispatch:boolean|null;evidence:Record<string,unknown>};
export type HazardCompletion={status:'predicted'|'unavailable'|'error';reason:string|null;completedAt:Date;
 response:Record<string,unknown>|null;assessment:Record<string,unknown>};
export const hazardCandidateHash=()=>evidenceHash(HAZARD_PINS);
export const hazardWireHash=(body:HazardBody)=>createHash('sha256').update(JSON.stringify(body)).digest('hex');
export const hazardGridHash=(lines:HazardLine[])=>evidenceHash({profile:HAZARD_GRID_PROFILE,lines});
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
const integer=(x:unknown,min=0):x is number=>finite(x)&&Number.isSafeInteger(x)&&x>=min;
const hex=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const stamp=(x:unknown)=>typeof x==='string'?Date.parse(x):NaN;
const validDate=(x:unknown):x is Date=>x instanceof Date&&Number.isFinite(x.getTime());
const same=(a:unknown,b:unknown)=>{try{return evidenceHash(a)===evidenceHash(b);}catch{return false;}};
const fail=():never=>{throw new Error('hazard_response_contract_rejected');};
const near=(a:number,b:number,tolerance=1e-10)=>Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(a),Math.abs(b));
const FALSE_FLAGS=['active','eligibleForServing','eligibleForPromotion','eligibleForQualityClaims',
 'eligibleForProspectiveEvaluation','prospectiveValidated','eventLatencyVerified','meetsVerifiedLiveLatencyPolicy','coverage95Validated'];
const DIAGNOSTIC_FALSE=['eligibleForServing','eligibleForPromotion','eligibleForQualityClaims','latencyValidated',
 'calibrationQualityValidated','bookmakerSettlementValidated','interpolatedClockQualityValidated','active','originalLiveReceiptVerified'];
const REASONS=new Set(['outcome_already_known','outcome_availability_unknown','observed_source_contract_required',
 'source_schema_mismatch','source_hash_required','synthetic_or_backfill_observation','invalid_observation_time',
 'future_or_inverted_observation_time','observation_stale','map_identity_mismatch','ongoing_live_phase_required',
 'clock_outside_300_4500_seconds','radiant_score_required','dire_score_required','own_diagnostic_grid_required',
 'observed_complete_draft_required','draft_incomplete','draft_hero_identity_invalid','draft_sides_invalid',
 'at_most_128_lines_required','hazard_busy','hazard_package_unavailable','hazard_resource_unavailable',
 'hazard_inference_unavailable','observation_stale_at_completion']);

/** Keep unknown sides/heroes unknown: complete unique 5+5 draft is mandatory. */
export function hazardDraft(input:Record<string,unknown>):Array<{heroId:number;team:number}>|null{
 const players=input.players;
 if(!Array.isArray(players)||players.length!==10||players.some(p=>!record(p)))return null;
 if(players.some(p=>!integer(p.heroId,1)||p.heroId>250||!integer(p.team)||p.team>1)
  ||new Set(players.map(p=>p.heroId)).size!==10||players.filter(p=>p.team===0).length!==5)return null;
 return players.map(p=>({heroId:p.heroId as number,team:p.team as number})).sort((a,b)=>a.team-b.team||a.heroId-b.heroId);
}
export function expandedHazardVector(input:Record<string,unknown>):number[]{
 const players=hazardDraft(input);if(!players)return fail();
 const r=input.radiantScore as number,d=input.direScore as number,minutes=(input.gameTimeSec as number)/60;
 const signed=Array<number>(250).fill(0);for(const p of players)signed[p.heroId-1]=p.team===0?1:-1;
 return [d,minutes,r-d,(r+d)/minutes,r,r+d,...signed,...signed.map(Math.abs),
  ...signed.map(v=>v*minutes),...signed.map(v=>v*(r+d))].map(Math.fround);
}

/** Fixed diagnostic offsets only. This is neither the public UI grid nor odds. */
export function buildHazardGrid(input:Record<string,unknown>):HazardLine[]{
 const clock=input.gameTimeSec,r=input.radiantScore,d=input.direScore;
 if(!integer(clock,300)||clock>4500||!integer(r)||!integer(d)||!Number.isSafeInteger(r+d+121))return [];
 return [...[0,0.5,5.5,10.5,20.5,40.5,60.5,120.5,121].map(offset=>({target:'kills' as const,line:r+d+offset,unit:'kills' as const})),
  ...[0,60,300,600,900,1200,1800,3600,5400,5401].map(offset=>({target:'duration' as const,line:clock+offset,unit:'seconds' as const,settlement:'exact_seconds' as const}))];
}
export function hazardPreflight(request:HazardRequest,now=new Date()):string|null{
 if(!validDate(now))return 'invalid_local_clock';
 if(!validDate(request.dispatchedAt)||request.dispatchedAt.getTime()>now.getTime()+100)return 'invalid_dispatch_time';
 const b=request.body,c=b.current,p=c.input;
 if(Buffer.byteLength(JSON.stringify(b),'utf8')>262144)return 'request_body_too_large';
 if(request.outcomeKnownAtCapture===true||request.outcomeKnownAtDispatch===true)return 'outcome_already_known';
 if(request.outcomeKnownAtCapture!==false||request.outcomeKnownAtDispatch!==false
   ||c.availability.outcomeKnownAtCapture!==false||b.outcomeKnownAtDispatch!==false)return 'outcome_availability_unknown';
 if(c.sourceSchemaHash!==LIVE_OBSERVATION_SCHEMA_HASH||c.sourceInputHash!==evidenceHash(p))return 'source_hash_mismatch';
 if(c.observationId!==evidenceHash({contract:c.sourceSchemaHash,inputHash:c.sourceInputHash,receivedAt:c.receivedAt}))return 'source_identity_mismatch';
 if(c.source!=='opendota'||c.targetScope!=='map'||c.clockUnit!=='seconds'||c.phase!=='live')return 'observed_source_contract_required';
 if(!integer(b.expectedMatchId,1)||p.matchId!==b.expectedMatchId)return 'map_identity_mismatch';
 for(const part of [c as unknown as Record<string,unknown>,p,c.availability])
  if(part.synthetic===true||part.backfill===true||part.reconstructed===true||['synthetic','backfill','reconstructed'].includes(String(part.source)))return 'synthetic_or_backfill_observation';
 const receipt=stamp(c.receivedAt),recorded=stamp(c.recordedAt);
 if(!Number.isFinite(receipt)||!Number.isFinite(recorded)||receipt>recorded||recorded>now.getTime()
   ||now.getTime()-receipt>=180000)return 'observation_stale_or_future';
 if(!integer(p.gameTimeSec,300)||p.gameTimeSec>4500)return 'clock_outside_300_4500_seconds';
 if(!integer(p.radiantScore))return 'radiant_score_required';
 if(!integer(p.direScore))return 'dire_score_required';
 if(c.availability.draftComplete!==true)return 'observed_complete_draft_required';
 if(!hazardDraft(p))return 'draft_incomplete';
 if(!Number.isSafeInteger(p.radiantScore+p.direScore+121))return 'observed_score_outside_safe_grid';
 if(b.lineSource!=='own_diagnostic_grid'||!same(b.lines,buildHazardGrid(p)))return 'diagnostic_grid_mismatch';
 return null;
}
export function hazardVectorHash(values:number[]):string{
 const bytes=Buffer.alloc(values.length*4);values.forEach((v,i)=>bytes.writeFloatLE(v,i*4));return createHash('sha256').update(bytes).digest('hex');
}
function checkQuantiles(raw:unknown,lo:number,hi:number):Array<number|null>{
 if(!Array.isArray(raw)||raw.length!==7)return fail();let last=lo,tail=false;
 for(const v of raw){if(v===null){tail=true;continue;}if(tail||!integer(v,lo)||v>hi||v<last)return fail();last=v;}
 return raw as Array<number|null>;
}
function checkMass(raw:unknown,residual:number,lo:number){
 if(!record(raw)||raw.available!==true||raw.reason!==null||raw.resolvedByObservedLowerBound!==(residual<lo)
  ||!record(raw.probabilities)||!record(raw.logProbabilities)||!record(raw.structurallyImpossible))return fail();
 const p=raw.probabilities,logs=raw.logProbabilities,impossible=raw.structurallyImpossible;
 if(!same(Object.keys(p).sort(),['pOver','pPush','pUnder'])||!same(Object.keys(logs).sort(),['over','push','under'])
   ||!same(Object.keys(impossible).sort(),['over','push','under']))return fail();
 const expected={under:Math.ceil(residual)-1<lo,push:!Number.isInteger(residual)||residual<lo,over:false};
 let sum=0;
 for(const [name,pname] of [['under','pUnder'],['push','pPush'],['over','pOver']] as const){
  const prob=p[pname],log=logs[name];if(!finite(prob)||prob<0||prob>1||impossible[name]!==expected[name])return fail();
  if(expected[name]){if(prob!==0||log!==null)return fail();}
  else if(!finite(log)||log>1e-12||!near(Math.exp(log),prob,1e-12))return fail();
  sum+=prob;
 }
 if(!near(sum,1,1e-9)||residual<lo&&(p.pOver!==1||p.pUnder!==0||p.pPush!==0))return fail();
 return p as {pUnder:number;pPush:number;pOver:number};
}

/** Checks structure and invariants against actual request; does not refit/reprice. */
export function checkedHazardResponse(raw:unknown,request:HazardRequest,completedAt=new Date()):Record<string,unknown>{
 if(!validDate(completedAt)||!validDate(request.dispatchedAt))return fail();
 if(!record(raw))return fail();evidenceHash(raw);
 for(const [key,value] of Object.entries(HAZARD_PINS))if(!same(raw[key],value))return fail();
 const b=request.body,c=b.current,p=c.input,computed=stamp(raw.computedAt);
 if(raw.executionMode!=='runtime_shadow'||raw.target!=='map_live_totals'||raw.targetScope!=='map'||raw.phase!=='live'
  ||raw.observationId!==c.observationId||raw.matchId!==b.expectedMatchId||raw.sourceInputHash!==c.sourceInputHash
  ||raw.sourceSchemaHash!==c.sourceSchemaHash||raw.requestBodySha256!==hazardWireHash(b)||raw.lineSource!=='own_diagnostic_grid'
  ||stamp(raw.receivedAt)!==stamp(c.receivedAt)||stamp(raw.recordedAt)!==stamp(c.recordedAt)||!Number.isFinite(computed)
  ||computed+100<Math.max(stamp(c.recordedAt),request.dispatchedAt.getTime())||computed>completedAt.getTime()+100
  ||!same(raw.featureNames,HAZARD_FEATURE_NAMES)||FALSE_FLAGS.some(k=>raw[k]!==false)
  ||raw.measuredEndToEndLatencySeconds!==null)return fail();
 if(raw.status==='unavailable'){
  if(typeof raw.reason!=='string'||!REASONS.has(raw.reason)||raw.diagnostic!==null)return fail();return raw;
 }
 if(raw.status!=='shadow_predicted'||raw.reason!==null||!record(raw.diagnostic)||completedAt.getTime()-stamp(c.receivedAt)>=180000)return fail();
 const d=raw.diagnostic,r=p.radiantScore as number,di=p.direScore as number,clock=p.gameTimeSec as number;
 if(!integer(r)||!integer(di)||!integer(clock,300)||clock>4500)return fail();
 const players=hazardDraft(p);if(!players||c.availability.draftComplete!==true)return fail();
 const state={matchId:b.expectedMatchId,phase:'live',gameTimeSec:clock,radiantScore:r,direScore:di,players};
 const vector=expandedHazardVector(p);
 // Consumed state uses only ASCII keys and integers, so Python canonical JSON
 // equals this hash. Full Python float-bearing responseSha256 is provenance only.
 if(d.contract!=='hazard-totals-diagnostic-v1'||d.available!==true||d.scope!=='map'||d.matchId!==b.expectedMatchId
  ||d.diagnosticOnly!==true||d.manifestSha256!==HAZARD_PINS.featureBundleSha256||d.calibrationSha256!==HAZARD_PINS.calibrationSha256
  ||DIAGNOSTIC_FALSE.some(k=>d[k]!==false)||d.publicProbabilities!==null||!same(d.observedInput,state)
  ||d.observedInputSha256!==evidenceHash(state)||!same(d.featureNames,HAZARD_FEATURE_NAMES)||!same(d.featureVector,vector)
  ||d.featureStorageDtype!=='float32'||d.featureVectorSha256!==hazardVectorHash(vector)
  ||d.clockOnTrainingCheckpoint!==(clock%300===0)||!hex(d.responseSha256)
  ||!Number.isFinite(stamp(d.computedAt))||stamp(d.computedAt)+100<request.dispatchedAt.getTime()||stamp(d.computedAt)>computed+100
  ||!Array.isArray(d.limitations)||d.limitations.some(x=>typeof x!=='string'||x.length>1000)
  ||!record(d.totals)||!same(Object.keys(d.totals).sort(),['duration','kills']))return fail();
 for(const target of ['kills','duration'] as const){
  const t=d.totals[target],lo=target==='kills'?0:1,hi=target==='kills'?120:5400,offset=target==='kills'?r+di:clock;
  if(!record(t)||t.variant!=='draft1006'||t.selectedByValidation!==false||t.unit!==(target==='kills'?'kills':'seconds')
   ||t.modelSha256!==HAZARD_PINS.modelHashes[target]||t.temperature!==HAZARD_TEMPERATURES[target]||!hex(t.rawLogitsSha256)
   ||!same(t.quantileLevels,HAZARD_LEVELS)||!same(t.remainingSupport,[lo,hi])||t.tailAboveRemaining!==hi
   ||t.tailAllocatedToLastBin!==false||!finite(t.tailProbability)||t.tailProbability<0||t.tailProbability>1
   ||!finite(t.tailLogProbability)||t.tailLogProbability>0||!near(Math.exp(t.tailLogProbability),t.tailProbability,1e-12))return fail();
  checkQuantiles(t.rawRemainingQuantiles,lo,hi);const remaining=checkQuantiles(t.calibratedRemainingQuantiles,lo,hi);
  if(!same(t.calibratedFinalQuantiles,remaining.map(q=>q===null?null:offset+q)))return fail();
  for(let i=0;i<7;i++)if(remaining[i]===null&&HAZARD_LEVELS[i]<1-t.tailProbability-1e-10
    ||remaining[i]!==null&&HAZARD_LEVELS[i]>1-t.tailProbability+1e-10)return fail();
  if(target==='kills'){if(t.finalMinutes!==null)return fail();}
  else if(!same(t.finalMinutes,remaining.map(q=>q===null?null:(offset+q)/60)))return fail();
 }
 if(!Array.isArray(d.lineDiagnostics)||d.lineDiagnostics.length!==b.lines.length)return fail();
 const prior=new Map<string,Array<{line:number;pUnder:number;pOver:number}>>();
 for(let i=0;i<b.lines.length;i++){
  const spec=b.lines[i],line=d.lineDiagnostics[i],offset=spec.target==='kills'?r+di:clock,
    lo=spec.target==='kills'?0:1,hi=spec.target==='kills'?120:5400,residual=spec.line-offset;
  if(!record(line)||line.target!==spec.target||line.line!==spec.line||line.unit!==spec.unit||line.residualLine!==residual
    ||line.diagnosticOnly!==true||line.eligibleForServing!==false||line.probabilitiesArePublic!==false)return fail();
  const outside=Math.floor(residual)>hi||Math.ceil(residual)-1>hi;
  if(outside){if(line.available!==false||line.reason!=='residual_support_exceeded'||line.raw!==null||line.calibrated!==null)return fail();continue;}
  if(line.available!==true||line.reason!==null||line.basis!==(residual<lo?'observed_lower_bound':'one_discrete_hazard_distribution'))return fail();
  for(const key of ['raw','calibrated']){
   const probabilities=checkMass(line[key],residual,lo),group=spec.target+key,rows=prior.get(group)??[];
   if(key==='calibrated'&&Math.floor(residual)===hi){
    // At the last supported threshold Over is exactly the unallocated tail.
    // Compare logs absolutely too: a tiny probability must not hide a 2x error
    // inside an absolute probability tolerance or floating-point underflow.
    const mass=line[key] as {logProbabilities:{over:number}},total=d.totals[spec.target] as Record<string,unknown>;
    if(!near(probabilities.pOver,total.tailProbability as number,1e-12)
     ||Math.abs(mass.logProbabilities.over-(total.tailLogProbability as number))>1e-9)return fail();
   }
   rows.push({line:spec.line,pUnder:probabilities.pUnder,pOver:probabilities.pOver});prior.set(group,rows);
  }
 }
 for(const rows of prior.values()){
  rows.sort((a,b)=>a.line-b.line);for(let i=1;i<rows.length;i++)
   if(rows[i].pUnder+1e-10<rows[i-1].pUnder||rows[i].pOver>rows[i-1].pOver+1e-10)return fail();
 }
 return raw;
}
export function hazardAssessment(request:HazardRequest,at:Date){
 if(!validDate(at))throw Error('invalid_hazard_completion_time');
 return {
 executionMode:'runtime_shadow',targetScope:'map',modelPhase:'live',lineProfile:HAZARD_GRID_PROFILE,
 ...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false])),measuredEndToEndLatencySeconds:null,
 receiptToCompletionSeconds:(at.getTime()-stamp(request.body.current.receivedAt))/1000,
 sourceAssessment:request.evidence.sourceAssessment??null,
 outcomeCheckMeaning:'local DB capture/dispatch/finish checks; not authoritative event time',
 sourceResponseHashMeaning:'Python responseSha256 retained as source fingerprint; response_hash is independently computed TS evidence hash',
};}
export const refusedHazard=(request:HazardRequest,reason:string,at=new Date()):HazardCompletion=>({
 status:'unavailable',reason,completedAt:at,response:null,assessment:hazardAssessment(request,at)});
export async function runPreparedHazard(request:HazardRequest,deps:{infer:(b:HazardBody)=>Promise<unknown>;
 finish:(r:HazardRequest,c:HazardCompletion)=>Promise<void>;now?:()=>Date}){
 const now=deps.now??(()=>new Date()),preflight=hazardPreflight(request,now());
 if(preflight){await deps.finish(request,refusedHazard(request,preflight,now()));return;}
 let at:Date,response:Record<string,unknown>|null=null,status:HazardCompletion['status']='error',reason:string|null='hazard_inference_failed';
 try{const raw=await deps.infer(request.body);at=now();response=checkedHazardResponse(raw,request,at);
  status=response.status==='shadow_predicted'?'predicted':'unavailable';reason=status==='predicted'?null:String(response.reason);
 }catch(error){at=now();const message=(error as Error).message;
  if(['hazard_response_contract_rejected','hazard_service_timeout','hazard_service_unauthorized','hazard_service_unavailable','hazard_service_token_missing'].includes(message))reason=message;}
 await deps.finish(request,{status,reason,completedAt:at,response,assessment:hazardAssessment(request,at)});
}
