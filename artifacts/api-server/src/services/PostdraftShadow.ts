import {readFileSync} from 'node:fs';
import {pool} from '@workspace/db';
import {logger} from '../lib/logger';
import {evidenceHash} from '../lib/predictionEvidence';
import {LIVE_OBSERVATION_SCHEMA_HASH,observeLivePacket} from '../lib/liveObservationContract';
import type {LiveJournalContext} from './LivePredictionJournal';
import {POSTDRAFT_PINS,postdraftCandidateHash,postdraftWireHash,postdraftPreflight,refusedPostdraft,
  runPreparedPostdraft,type PostdraftBody,type PostdraftRequest,type PostdraftCompletion} from './PostdraftShadowContract';

const knownOutcomeSql=`(EXISTS(SELECT 1 FROM pro_matches p WHERE p.match_id=$1 AND p.radiant_win IS NOT NULL AND p.duration>0)
 OR EXISTS(SELECT 1 FROM live_journal_outcomes o WHERE o.match_id=$1))`;
const nullableBool=(value:unknown):boolean|null=>typeof value==='boolean'?value:null;
type PostdraftContext=Pick<LiveJournalContext,'observation'>&{snapshotId:number|null};

/** The source input commits before the immutable candidate attempt and inference. */
export async function preparePostdraftShadow(context:PostdraftContext,store:Pick<typeof pool,'query'|'connect'>=pool):Promise<PostdraftRequest|null>{
  const o=context.observation;
  if(o.schemaHash!==LIVE_OBSERVATION_SCHEMA_HASH||o.inputHash!==evidenceHash(o.input)
    ||o.id!==evidenceHash({contract:o.schemaHash,inputHash:o.inputHash,receivedAt:o.receivedAt.toISOString()}))
    throw new Error('postdraft_source_identity_conflict');
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
      ||current.schema_hash!==LIVE_OBSERVATION_SCHEMA_HASH||Number(current.match_id)!==o.matchId
      ||current.input.matchId!==o.matchId||current.input.gameTimeSec!==current.game_time_sec
      ||current.received_at.toISOString()!==o.receivedAt.toISOString()||current.phase!==o.phase)
      throw new Error('postdraft_durable_identity_conflict');
    const id=evidenceHash({observationId:o.id,candidateHash:postdraftCandidateHash()});
    const capture=nullableBool(current.availability.outcomeKnownAtCapture);
    const fingerprint=evidenceHash({radiantTeamId:current.input.radiantTeamId,direTeamId:current.input.direTeamId,
      players:current.input.players});
    // Bind the known-outcome value to the same INSERT statement as its body.
    // One bounded retry handles a result committed between preliminary check and INSERT.
    for(let attempt=0;attempt<2;attempt++){
      const outcome=(await client.query(`SELECT ${knownOutcomeSql} AS known`,[o.matchId])).rows[0]?.known;
      if(typeof outcome!=='boolean')throw new Error('postdraft_outcome_check_unknown');
      const body:PostdraftBody={current:{observationId:current.id,source:'opendota',targetScope:'map',clockUnit:'seconds',
        receivedAt:current.received_at.toISOString(),recordedAt:current.recorded_at.toISOString(),phase:current.phase,
        input:current.input,availability:current.availability,sourceInputHash:current.input_hash,sourceSchemaHash:current.schema_hash},
        expectedMatchId:o.matchId,outcomeKnownAtDispatch:outcome};
      const evidence={contract:'durable_observed_postdraft_attempt_v1',sourceObservation:{id:current.id,inputHash:current.input_hash,schemaHash:current.schema_hash},
        sourceAssessment:{availability:current.availability,qualityReasons:current.quality_reasons},
        outcomeKnownAtCapture:capture,requestBodyHash:postdraftWireHash(body),sourcePins:POSTDRAFT_PINS,
        historySelection:'authenticated future-only cache; exact snapshot and builtAt retained with response',
        originalHistoricalReceiptsProven:false};
      const inserted=await client.query(`WITH outcome_check AS (SELECT ${knownOutcomeSql} AS known)
        INSERT INTO postdraft_shadow_requests
        (match_id,id,observation_id,candidate_id,candidate_hash,model_hash,phase,game_time_sec,draft_fingerprint,
         source_input_hash,source_schema_hash,request_body_sha256,outcome_known_at_capture,outcome_known_at_dispatch,request_body,evidence)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,known,$14,$15 FROM outcome_check
        WHERE known IS NOT DISTINCT FROM $16::boolean
        ON CONFLICT DO NOTHING RETURNING dispatched_at,outcome_known_at_dispatch`,
        [o.matchId,id,o.id,POSTDRAFT_PINS.candidateId,postdraftCandidateHash(),POSTDRAFT_PINS.modelSha256,
          current.phase,current.game_time_sec,fingerprint,current.input_hash,current.schema_hash,postdraftWireHash(body),capture,
          JSON.stringify(body),JSON.stringify(evidence),outcome]);
      if(inserted.rowCount){await client.query('COMMIT');return {id,body,evidence,outcomeKnownAtCapture:capture,
        dispatchedAt:inserted.rows[0].dispatched_at,outcomeKnownAtDispatch:inserted.rows[0].outcome_known_at_dispatch};}
      if((await client.query('SELECT id FROM postdraft_shadow_requests WHERE id=$1',[id])).rowCount){await client.query('COMMIT');return null;}
    }
    throw new Error('postdraft_outcome_changed_during_dispatch');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}

/** Race with a newly available outcome yields a nullable refusal, never a late success. */
export async function finishPostdraftShadow(request:PostdraftRequest,result:PostdraftCompletion,store:Pick<typeof pool,'query'>=pool):Promise<void>{
  await store.query(`WITH outcome_check AS (SELECT ${knownOutcomeSql} AS known), checked AS (
    SELECT q.*,o.known, (o.known IS TRUE OR q.outcome_known_at_capture IS TRUE OR q.outcome_known_at_dispatch IS TRUE) AS late,
      (q.outcome_known_at_capture IS NULL OR q.outcome_known_at_dispatch IS NULL OR o.known IS NULL) AS unknown_check
    FROM postdraft_shadow_requests q CROSS JOIN outcome_check o WHERE q.id=$2)
    INSERT INTO postdraft_shadow_results(request_id,status,reason,completed_at,outcome_known_at_finish,before_local_outcome_at_checks,response,assessment)
    SELECT $2,CASE WHEN late OR unknown_check THEN 'unavailable' ELSE $3 END,
      CASE WHEN late THEN 'outcome_known_at_finish' WHEN unknown_check THEN 'outcome_availability_unknown' ELSE $4 END,
      $5,known,CASE WHEN unknown_check THEN NULL ELSE ($3='predicted' AND NOT late) END,
      CASE WHEN late OR unknown_check THEN NULL ELSE $6::jsonb END,$7 FROM checked
    ON CONFLICT DO NOTHING`,[request.body.expectedMatchId,request.id,result.status,result.reason,result.completedAt,
      result.response===null?null:JSON.stringify(result.response),JSON.stringify(result.assessment)]);
}

async function infer(body:PostdraftBody):Promise<unknown>{
  let token=process.env.ML_SERVICE_TOKEN?.trim();
  if(!token)try{token=readFileSync('/tmp/aegis_ml_token','utf8').trim();}catch{/* unavailable */}
  if(!token)throw new Error('postdraft_service_token_missing');
  try{
    const response=await fetch(`${(process.env.ML_SERVICE_URL??'http://127.0.0.1:8090').replace(/\/$/,'')}/shadow/postdraft`,{
      method:'POST',headers:{'Content-Type':'application/json','X-ML-Token':token},body:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
    if(response.status===401||response.status===403)throw new Error('postdraft_service_unauthorized');
    if(!response.ok)throw new Error('postdraft_service_unavailable');
    const reader=response.body?.getReader();if(!reader)throw new Error('postdraft_response_contract_rejected');
    const pieces:Uint8Array[]=[];let size=0;
    try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;
      if(size>1_572_864){await reader.cancel();throw new Error('postdraft_response_contract_rejected');}pieces.push(chunk.value);}}
    finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(pieces).toString('utf8'));
  }catch(error){if(['TimeoutError','AbortError'].includes((error as Error).name))throw new Error('postdraft_service_timeout');throw error;}
}

export function createPostdraftQueue(deps:{prepare:(c:PostdraftContext)=>Promise<PostdraftRequest|null>;
 infer:(b:PostdraftBody)=>Promise<unknown>;finish:(r:PostdraftRequest,c:PostdraftCompletion)=>Promise<void>;
 reportFailure:()=>void},limit=32){
  const pending:PostdraftRequest[]=[];let running=false;
  const pump=()=>{if(running||!pending.length)return;running=true;const request=pending.shift()!;
    void runPreparedPostdraft(request,deps).catch(()=>deps.reportFailure()).finally(()=>{running=false;pump();});};
  return async(contexts:PostdraftContext[])=>{
    for(const context of contexts){const clock=context.observation.gameTimeSec;
      if(clock===null||clock < -3600||clock>=60)continue;
      try{const request=await deps.prepare(context);if(!request)continue;
        const reason=postdraftPreflight(request);
        if(reason)await deps.finish(request,refusedPostdraft(request,reason));
        else if(pending.length>=limit)await deps.finish(request,refusedPostdraft(request,'queue_full'));
        else{pending.push(request);pump();}
      }catch{deps.reportFailure();}
    }
  };
}
export const enqueuePostdraftShadow=createPostdraftQueue({prepare:preparePostdraftShadow,infer,finish:finishPostdraftShadow,
  reportFailure:()=>logger.warn({code:'postdraft_attempt_incomplete'},'[PostdraftShadow] attempt incomplete; no quality claim')});

/** Every actually received draft packet has a new receipt, even if game clock paused.
 * Do not depend on legacy changed-packet dedup: cache may become ready in between.
 * No additional provider request and no synthetic legacy snapshot is created.
 */
export async function enqueuePostdraftPackets(packets:Record<string,unknown>[],receivedAt:Date,
  queue:typeof enqueuePostdraftShadow=enqueuePostdraftShadow,store:Pick<typeof pool,'query'>=pool):Promise<void>{
  const eligible=packets.filter(p=>Number.isSafeInteger(p.match_id)&&Number(p.match_id)>0
    &&Number.isSafeInteger(p.game_time)&&Number(p.game_time)>=-3600&&Number(p.game_time)<60);
  if(!eligible.length)return;
  let known:Set<number>|null=null;
  try{const rows=await store.query(`SELECT DISTINCT match_id FROM (
    SELECT match_id FROM pro_matches WHERE match_id=ANY($1::bigint[]) AND radiant_win IS NOT NULL AND duration>0
    UNION SELECT match_id FROM live_journal_outcomes WHERE match_id=ANY($1::bigint[])) completed`,[eligible.map(p=>p.match_id)]);
    known=new Set(rows.rows.map(r=>Number(r.match_id)));
  }catch{/* preserve unknown capture; prepare must still record the refusal if DB recovers */}
  const contexts:PostdraftContext[]=[];
  for(const packet of eligible){try{
    const observation=observeLivePacket(packet,receivedAt);
    const captured=known===null?null:known.has(observation.matchId);
    observation.availability={...observation.availability,...{outcomeKnownAtCapture:captured}};
    if(captured===true)observation.qualityReasons.push('outcome_already_known_locally');
    if(captured===null)observation.qualityReasons.push('outcome_availability_not_checked');
    contexts.push({observation,snapshotId:null});
  }catch{logger.warn({code:'postdraft_packet_invalid'},'[PostdraftShadow] invalid early packet; other matches continue');}}
  await queue(contexts);
}
