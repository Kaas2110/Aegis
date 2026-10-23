import {readFileSync} from 'node:fs';
import {pool} from '@workspace/db';
import {logger} from '../lib/logger';
import {evidenceHash} from '../lib/predictionEvidence';
import {observeLivePacket,LIVE_OBSERVATION_SCHEMA_HASH,type LiveObservation} from '../lib/liveObservationContract';
import {HAZARD_PINS,HAZARD_GRID_PROFILE,buildHazardGrid,hazardGridHash,hazardCandidateHash,hazardWireHash,
 hazardPreflight,refusedHazard,runPreparedHazard,type HazardBody,type HazardRequest,type HazardCompletion} from './HazardShadowContract';
export type HazardContext={observation:LiveObservation;snapshotId:number|null};
const nullableBool=(v:unknown):boolean|null=>typeof v==='boolean'?v:null;
const knownOutcomeSql=`(EXISTS(SELECT 1 FROM pro_matches p WHERE p.match_id=$1 AND p.radiant_win IS NOT NULL AND p.duration>0)
 OR EXISTS(SELECT 1 FROM live_journal_outcomes o WHERE o.match_id=$1))`;

/** Durable source + exact candidate/grid/body commit precedes queue and inference. */
export async function prepareHazardShadow(context:HazardContext,store:Pick<typeof pool,'query'|'connect'>=pool):Promise<HazardRequest|null>{
 const o=context.observation;
 if(o.schemaHash!==LIVE_OBSERVATION_SCHEMA_HASH||o.inputHash!==evidenceHash(o.input)
  ||o.id!==evidenceHash({contract:o.schemaHash,inputHash:o.inputHash,receivedAt:o.receivedAt.toISOString()}))throw Error('hazard_source_identity_conflict');
 await store.query(`INSERT INTO live_observation_journal
  (id,match_id,snapshot_id,received_at,recorded_at,game_time_sec,phase,input_hash,schema_hash,input,quality_reasons,availability)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
  [o.id,o.matchId,context.snapshotId,o.receivedAt,o.recordedAt,o.gameTimeSec,o.phase,o.inputHash,o.schemaHash,
   JSON.stringify(o.input),JSON.stringify(o.qualityReasons),JSON.stringify(o.availability)]);
 const client=await store.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  const current=(await client.query('SELECT * FROM live_observation_journal WHERE id=$1',[o.id])).rows[0];
  if(!current||current.input_hash!==o.inputHash||current.input_hash!==evidenceHash(current.input)
   ||current.schema_hash!==LIVE_OBSERVATION_SCHEMA_HASH||Number(current.match_id)!==o.matchId||current.input.matchId!==o.matchId
   ||current.input.gameTimeSec!==current.game_time_sec||current.phase!=='live'||current.game_time_sec<300||current.game_time_sec>4500
   ||current.received_at.toISOString()!==o.receivedAt.toISOString())throw Error('hazard_durable_identity_conflict');
  const capture=nullableBool(current.availability.outcomeKnownAtCapture),lines=buildHazardGrid(current.input),gridHash=hazardGridHash(lines);
  const id=evidenceHash({observationId:o.id,candidateHash:hazardCandidateHash(),gridHash});
  for(let attempt=0;attempt<2;attempt++){
   const known=(await client.query(`SELECT ${knownOutcomeSql} AS known`,[o.matchId])).rows[0]?.known;
   if(typeof known!=='boolean')throw Error('hazard_outcome_check_unknown');
   const body:HazardBody={current:{observationId:current.id,source:'opendota',targetScope:'map',clockUnit:'seconds',
    receivedAt:current.received_at.toISOString(),recordedAt:current.recorded_at.toISOString(),phase:current.phase,
    input:current.input,availability:current.availability,sourceInputHash:current.input_hash,sourceSchemaHash:current.schema_hash},
    expectedMatchId:o.matchId,outcomeKnownAtDispatch:known,lineSource:'own_diagnostic_grid',lines};
   const evidence={contract:'durable_observed_hazard_attempt_v1',sourcePins:HAZARD_PINS,lineProfile:HAZARD_GRID_PROFILE,gridHash,
    sourceObservation:{id:current.id,inputHash:current.input_hash,schemaHash:current.schema_hash},
    sourceAssessment:{availability:current.availability,qualityReasons:current.quality_reasons},
    requestBodyHash:hazardWireHash(body),outcomeKnownAtCapture:capture,
    dispatchTimestampMeaning:'DB statement for durable queue admission; HTTP starts later; completion rechecks outcome',
    originalHistoricalReceiptsProven:false};
   const inserted=await client.query(`WITH outcome_check AS (SELECT ${knownOutcomeSql} AS known)
    INSERT INTO hazard_shadow_requests
    (match_id,id,observation_id,candidate_id,candidate_hash,kills_model_hash,duration_model_hash,phase,game_time_sec,
     line_profile,line_grid_hash,source_input_hash,source_schema_hash,request_body_sha256,
     outcome_known_at_capture,outcome_known_at_dispatch,request_body,evidence)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,known,$16,$17 FROM outcome_check
    WHERE known IS NOT DISTINCT FROM $18::boolean
    ON CONFLICT DO NOTHING RETURNING dispatched_at,outcome_known_at_dispatch`,
    [o.matchId,id,o.id,HAZARD_PINS.candidateId,hazardCandidateHash(),HAZARD_PINS.modelHashes.kills,HAZARD_PINS.modelHashes.duration,
     current.phase,current.game_time_sec,HAZARD_GRID_PROFILE,gridHash,current.input_hash,current.schema_hash,hazardWireHash(body),capture,
     JSON.stringify(body),JSON.stringify(evidence),known]);
   if(inserted.rowCount){await client.query('COMMIT');return {id,body,evidence,outcomeKnownAtCapture:capture,
    outcomeKnownAtDispatch:inserted.rows[0].outcome_known_at_dispatch,dispatchedAt:inserted.rows[0].dispatched_at};}
   if((await client.query('SELECT id FROM hazard_shadow_requests WHERE id=$1',[id])).rowCount){await client.query('COMMIT');return null;}
  }
  throw Error('hazard_outcome_changed_during_dispatch');
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
/** Actual stored checks, never JS truthiness, determine before-outcome status. */
export async function finishHazardShadow(request:HazardRequest,result:HazardCompletion,store:Pick<typeof pool,'query'>=pool):Promise<void>{
 const saved=await store.query(`WITH outcome_check AS (SELECT ${knownOutcomeSql} AS known), checked AS (
  SELECT q.*,o.known,(o.known IS TRUE OR q.outcome_known_at_capture IS TRUE OR q.outcome_known_at_dispatch IS TRUE) AS late,
   (q.outcome_known_at_capture IS NULL OR q.outcome_known_at_dispatch IS NULL OR o.known IS NULL) AS unknown_check
  FROM hazard_shadow_requests q CROSS JOIN outcome_check o WHERE q.id=$2 AND q.match_id=$1)
  INSERT INTO hazard_shadow_results(request_id,status,reason,completed_at,outcome_known_at_finish,before_local_outcome_at_checks,response,response_hash,assessment)
  SELECT $2,CASE WHEN late OR unknown_check THEN 'unavailable' ELSE $3 END,
   CASE WHEN late THEN 'outcome_known_at_finish' WHEN unknown_check THEN 'outcome_availability_unknown' ELSE $4 END,
   $5,known,CASE WHEN unknown_check THEN NULL ELSE ($3='predicted' AND NOT late) END,
   CASE WHEN late OR unknown_check THEN NULL ELSE $6::jsonb END,
   CASE WHEN late OR unknown_check THEN NULL ELSE $7 END,$8 FROM checked
  ON CONFLICT DO NOTHING RETURNING request_id`,[request.body.expectedMatchId,request.id,result.status,result.reason,result.completedAt,
   result.response===null?null:JSON.stringify(result.response),result.response===null?null:evidenceHash(result.response),JSON.stringify(result.assessment)]);
 if(!saved.rowCount&&!(await store.query('SELECT request_id FROM hazard_shadow_results WHERE request_id=$1',[request.id])).rowCount)
  throw Error('hazard_result_not_persisted');
}
async function infer(body:HazardBody):Promise<unknown>{
 let token=process.env.ML_SERVICE_TOKEN?.trim();
 if(!token)try{token=readFileSync('/tmp/aegis_ml_token','utf8').trim();}catch{/* safe refusal */}
 if(!token)throw Error('hazard_service_token_missing');
 try{
  const response=await fetch(`${(process.env.ML_SERVICE_URL??'http://127.0.0.1:8090').replace(/\/$/,'')}/shadow/live-totals-hazard`,{
   method:'POST',headers:{'Content-Type':'application/json','X-ML-Token':token},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  if(response.status===401||response.status===403)throw Error('hazard_service_unauthorized');
  if(!response.ok)throw Error('hazard_service_unavailable');
  const reader=response.body?.getReader();if(!reader)throw Error('hazard_response_contract_rejected');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const row=await reader.read();if(row.done)break;size+=row.value.byteLength;
   if(size>1_048_576){await reader.cancel();throw Error('hazard_response_contract_rejected');}chunks.push(row.value);}}
  finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }catch(error){if(['AbortError','TimeoutError'].includes((error as Error).name))throw Error('hazard_service_timeout');throw error;}
}
export function createHazardQueue(deps:{prepare:(c:HazardContext)=>Promise<HazardRequest|null>;
 infer:(b:HazardBody)=>Promise<unknown>;finish:(r:HazardRequest,c:HazardCompletion)=>Promise<void>;reportFailure:()=>void},
 options:{limit?:number;maxStartsPerMinute?:number;now?:()=>Date}={}){
 const limit=options.limit??16,maxStarts=options.maxStartsPerMinute??30,now=options.now??(()=>new Date());
 if(!Number.isInteger(limit)||limit<1||limit>32||!Number.isInteger(maxStarts)||maxStarts<1||maxStarts>30)throw Error('invalid_hazard_queue_limits');
 const pending:HazardRequest[]=[];let running=false,starts:number[]=[];
 const pump=()=>{
  if(running||!pending.length)return;running=true;const request=pending.shift()!;
  void(async()=>{
   const reason=hazardPreflight(request,now());if(reason){await deps.finish(request,refusedHazard(request,reason,now()));return;}
   const time=now().getTime();starts=starts.filter(t=>time-t<60_000);
   if(starts.length>=maxStarts){await deps.finish(request,refusedHazard(request,'rate_limited',now()));return;}
   starts.push(time);await runPreparedHazard(request,{...deps,now});
  })().catch(()=>deps.reportFailure()).finally(()=>{running=false;pump();});
 };
 return async(contexts:HazardContext[])=>{
  for(const context of contexts){const clock=context.observation.gameTimeSec;if(clock===null||clock<300||clock>4500)continue;
   try{
    const request=await deps.prepare(context);if(!request)continue;
    const reason=hazardPreflight(request,now());
    if(reason)await deps.finish(request,refusedHazard(request,reason,now()));
    else if(pending.length>=limit)await deps.finish(request,refusedHazard(request,'queue_full',now()));
    else{pending.push(request);pump();}
   }catch{deps.reportFailure();}
  }
 };
}
export const enqueueHazardShadow=createHazardQueue({prepare:prepareHazardShadow,infer,finish:finishHazardShadow,
 reportFailure:()=>logger.warn({code:'hazard_attempt_incomplete'},'[HazardShadow] incomplete diagnostic attempt; no quality claim')});

/** Hook once after actual feed receipt, before legacy unchanged-packet dedup. */
export async function enqueueHazardPackets(packets:Record<string,unknown>[],receivedAt:Date,
 queue:typeof enqueueHazardShadow=enqueueHazardShadow,store:Pick<typeof pool,'query'>=pool):Promise<void>{
 const eligible=packets.filter(p=>Number.isSafeInteger(p.match_id)&&Number(p.match_id)>0
  &&Number.isSafeInteger(p.game_time)&&Number(p.game_time)>=300&&Number(p.game_time)<=4500);
 if(!eligible.length)return;
 let known:Set<number>|null=null;
 try{const rows=await store.query(`SELECT DISTINCT match_id FROM (
  SELECT match_id FROM pro_matches WHERE match_id=ANY($1::bigint[]) AND radiant_win IS NOT NULL AND duration>0
  UNION SELECT match_id FROM live_journal_outcomes WHERE match_id=ANY($1::bigint[])) completed`,[eligible.map(p=>p.match_id)]);
  known=new Set(rows.rows.map(r=>Number(r.match_id)));
 }catch{/* unknown capture is retained and can never become false */}
 const contexts:HazardContext[]=[];
 for(const packet of eligible){try{
  const observation=observeLivePacket(packet,receivedAt),capture=known===null?null:known.has(observation.matchId);
  observation.availability={...observation.availability,...{outcomeKnownAtCapture:capture}};
  if(capture===true)observation.qualityReasons.push('outcome_already_known_locally');
  if(capture===null)observation.qualityReasons.push('outcome_availability_not_checked');
  contexts.push({observation,snapshotId:null});
 }catch{logger.warn({code:'hazard_packet_invalid'},'[HazardShadow] invalid packet; other maps continue');}}
 await queue(contexts);
}
