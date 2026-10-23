import {readFileSync} from 'node:fs';
import {bindWideSourceFreshness,assertWideSourceFreshness,wideSourceCompletionWindow,type WideSourceFreshness,WIDE_FRESHNESS_REASONS,WIDE_FRESHNESS_POLICY_VERSION,WIDE_FRESHNESS_EVIDENCE_CONTRACT} from './WideSourceFreshness';
import {join} from 'node:path';
import {JournalOutbox} from '../lib/journalOutbox';
import {pool} from '@workspace/db';
import {logger} from '../lib/logger';
import {stableJson,evidenceHash} from '../lib/predictionEvidence';
import {observeLivePacket} from '../lib/liveObservationContract';
import {readWideObservation} from './wide-observed-v1/reader';
import {readWideObservationV2} from './wide-observed-v2/reader_v2';
import {WIDE_PINS as P,WIDE_FLAGS,WIDE_BODY_LIMIT} from './WideShadowPins';
import {checkedBinding,checkedResponse,hashBytes,preflight,record,type Json,type WideAttempt,type WideDispatch,type WideBody} from './WideShadowContract';
import {wideSession,SESSION_REASONS,type WideSession,type SessionPermit} from './WideShadowSession';

type Store=Pick<typeof pool,'query'|'connect'>;
const bool=(v:unknown):boolean|null=>typeof v==='boolean'?v:null;
export const OUTCOME_SQL=`(EXISTS(SELECT 1 FROM pro_matches p WHERE p.match_id=$1 AND p.radiant_win IS NOT NULL AND p.duration>0)
 OR EXISTS(SELECT 1 FROM live_journal_outcomes o WHERE o.match_id=$1))`;
const assessment=(extra:Json={})=>({...WIDE_FLAGS,measuredEndToEndLatencySeconds:null,policy:'wide.diagnostic.committed-requests.v1',freshnessPolicyVersion:WIDE_FRESHNESS_POLICY_VERSION,freshnessEvidenceContract:WIDE_FRESHNESS_EVIDENCE_CONTRACT,...extra});
const processStartedAt=new Date();
const asDate=(v:unknown)=>v instanceof Date?v:new Date(String(v));
function attemptRow(r:Json):WideAttempt{return {id:r.id,observationId:r.observation_id,matchId:Number(r.match_id),clock:r.game_time_sec,
 operation:r.operation,receivedAt:asDate(r.received_at),recordedAt:asDate(r.recorded_at),capture:bool(r.outcome_known_at_capture),
 sourceInputHash:r.source_input_hash,sourceSchemaHash:r.source_schema_hash,createdAt:asDate(r.created_at)};}

export async function prepareWideObservation(o:ReturnType<typeof observeLivePacket>,store:Store=pool):Promise<WideAttempt|null>{
 if(o.schemaHash!==P.sourceSchemaSha256||o.inputHash!==evidenceHash(o.input)
  ||o.id!==evidenceHash({contract:o.schemaHash,inputHash:o.inputHash,receivedAt:o.receivedAt.toISOString()}))throw Error('wide_original_source_binding');
 const client=await store.connect();let transaction=false;
 try{await client.query('BEGIN');transaction=true;
 await client.query("SET LOCAL statement_timeout='3000ms'");
 await client.query(`INSERT INTO live_observation_journal
  (id,match_id,snapshot_id,received_at,recorded_at,game_time_sec,phase,input_hash,schema_hash,input,quality_reasons,availability)
  VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
 [o.id,o.matchId,o.receivedAt,o.recordedAt,o.gameTimeSec,o.phase,o.inputHash,o.schemaHash,JSON.stringify(o.input),JSON.stringify(o.qualityReasons),JSON.stringify(o.availability)]);
 const id=evidenceHash({observationId:o.id,candidateManifestSha256:P.candidateManifestSha256});
 const result=await client.query(`WITH current AS (SELECT * FROM live_observation_journal WHERE id=$1), inserted AS (
 INSERT INTO wide_shadow_attempts(id,observation_id,match_id,candidate_hash,model_hash,operation,game_time_sec,
  source_input_hash,source_schema_hash,outcome_known_at_capture,evidence)
 SELECT $2,id,match_id,$3,$4,CASE WHEN game_time_sec BETWEEN -3600 AND 59 THEN 'anchor'
  WHEN game_time_sec BETWEEN 300 AND 6600 THEN 'predict' ELSE 'unsupported' END,game_time_sec,input_hash,schema_hash,
  CASE WHEN availability->'outcomeKnownAtCapture'='true'::jsonb THEN true
   WHEN availability->'outcomeKnownAtCapture'='false'::jsonb THEN false ELSE null END,$5 FROM current
 WHERE input_hash=$6 AND schema_hash=$7 AND match_id=$8 AND received_at=$9
 ON CONFLICT DO NOTHING RETURNING *)
 SELECT inserted.*,current.received_at,current.recorded_at FROM inserted JOIN current ON current.id=inserted.observation_id`,
 [o.id,id,P.candidateManifestSha256,P.modelSha256,JSON.stringify(assessment({pins:P,source:'committed_live_observation',noProviderCalls:true})),
  o.inputHash,o.schemaHash,o.matchId,o.receivedAt]);
 if(result.rows.length){await client.query('COMMIT');transaction=false;return attemptRow(result.rows[0]);}
 // Existing attempts are durable dedup; a conflicting original observation is an error.
 if((await client.query('SELECT id FROM wide_shadow_attempts WHERE id=$1',[id])).rowCount){await client.query('COMMIT');transaction=false;return null;}
 throw Error('wide_durable_source_conflict');
 }catch(error){if(transaction)try{await client.query('ROLLBACK');}catch{/* original safe error retained */}throw error;}
 finally{client.release();}
}

export async function finishWide(a:WideAttempt,status:'anchor_ready'|'predicted'|'unavailable',reason:string|null,
 response:Json|null,store:Store=pool,sourceFreshness?:WideSourceFreshness):Promise<void>{
 const responseHash=response===null?null:evidenceHash(response);
 let sourceWindow:ReturnType<typeof wideSourceCompletionWindow>|null=null;
 if(status!=='unavailable'&&sourceFreshness&&sourceFreshness.observationId===a.observationId
   &&sourceFreshness.matchId===a.matchId&&sourceFreshness.sourceInputHash===a.sourceInputHash){
  try{sourceWindow=wideSourceCompletionWindow(sourceFreshness);}catch{/* explicit missing-gate refusal below */}}
 await store.query(`WITH checks AS (SELECT ${OUTCOME_SQL} AS known,clock_timestamp() AS finished), facts AS (
 SELECT a.*,d.outcome_known_at_read,d.outcome_known_at_dispatch,c.known,c.finished,
  (a.outcome_known_at_capture IS FALSE AND d.outcome_known_at_read IS FALSE
    AND d.outcome_known_at_dispatch IS FALSE AND c.known IS FALSE) AS safe,
  (a.outcome_known_at_capture IS NULL OR d.outcome_known_at_read IS NULL
    OR d.outcome_known_at_dispatch IS NULL OR c.known IS NULL) AS unknown_check,
  (j.received_at<=j.recorded_at AND j.recorded_at<=c.finished AND c.finished-j.received_at<=interval '180 seconds') AS fresh,
  ($8::timestamptz IS NOT NULL AND c.finished<$8::timestamptz
    AND ($9::timestamptz IS NULL OR c.finished<=$9::timestamptz)) AS source_fresh
 FROM wide_shadow_attempts a JOIN live_observation_journal j ON j.id=a.observation_id
 LEFT JOIN wide_shadow_dispatches d ON d.attempt_id=a.id CROSS JOIN checks c WHERE a.id=$2
 ), verdict AS (SELECT *,($3 IN('anchor_ready','predicted') AND safe AND fresh AND source_fresh) AS success FROM facts)
 INSERT INTO wide_shadow_results(attempt_id,status,reason,completed_at,outcome_known_at_finish,
  before_local_outcome_at_checks,response,response_hash,assessment)
 SELECT $2,CASE WHEN success THEN $3 ELSE 'unavailable' END,
  CASE WHEN success THEN NULL WHEN $3='unavailable' THEN $4 WHEN NOT fresh THEN 'wide_stale_at_finish'
   WHEN NOT source_fresh THEN CASE WHEN $8::timestamptz IS NULL THEN 'wide_source_quality_gate_missing' ELSE 'wide_source_quality_expired_at_finish' END
   WHEN known IS TRUE THEN 'wide_outcome_known_at_finish' ELSE 'wide_outcome_unverified_at_finish' END,
  finished,known,CASE WHEN unknown_check THEN NULL ELSE safe END,
  CASE WHEN success THEN $5::jsonb ELSE NULL END,CASE WHEN success THEN $6 ELSE NULL END,$7 FROM verdict
 ON CONFLICT DO NOTHING`,[a.matchId,a.id,status,reason??'wide_unavailable',response===null?null:JSON.stringify(response),responseHash,
  JSON.stringify(assessment({candidateManifestSha256:P.candidateManifestSha256,originalReason:reason,receiptGuardSeconds:180,
    sourceFreshnessCompletionWindow:sourceWindow})),sourceWindow?.validBefore??null,sourceWindow?.validThrough??null]);
}

export async function reconcileWideInterrupted(store:Store=pool,startedAt=processStartedAt):Promise<number>{
 if(!Number.isFinite(startedAt.getTime()))throw Error('wide_invalid_startup_clock');
 const rows=(await store.query(`SELECT a.*,j.received_at,j.recorded_at FROM wide_shadow_attempts a
 JOIN live_observation_journal j ON j.id=a.observation_id LEFT JOIN wide_shadow_results r ON r.attempt_id=a.id
 WHERE a.candidate_hash=$1 AND a.created_at<$2 AND r.attempt_id IS NULL ORDER BY a.created_at LIMIT 256`,
 [P.candidateManifestSha256,startedAt])).rows;
 for(const r of rows)await finishWide(attemptRow(r),'unavailable','wide_interrupted_before_completion',null,store);
 return rows.length;
}

export async function wideHttp(path:string,bodyText?:string,timeoutMs=15_000):Promise<unknown>{
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>15000)throw Error('wide_session_expired');
 let token=process.env.ML_SERVICE_TOKEN?.trim();
 if(!token)try{token=readFileSync('/tmp/aegis_ml_token','utf8').trim();}catch{/* unavailable */}
 if(!token)throw Error('wide_ml_token_missing');
 if(bodyText!==undefined&&Buffer.byteLength(bodyText)>WIDE_BODY_LIMIT)throw Error('wide_request_size');
 const response=await fetch(`${(process.env.ML_SERVICE_URL??'http://127.0.0.1:8090').replace(/\/$/,'')}${path}`,{
  method:bodyText===undefined?'GET':'POST',headers:{'X-ML-Token':token,'Content-Type':'application/json'},
  body:bodyText,signal:AbortSignal.timeout(timeoutMs)});
 if(!response.ok)throw Error(response.status===401||response.status===403?'wide_ml_unauthorized':response.status===429?'wide_ml_busy':'wide_ml_unavailable');
 const reader=response.body?.getReader();if(!reader)throw Error('wide_ml_empty_response');
 const parts:Uint8Array[]=[];let bytes=0;
 try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;
  if(bytes>WIDE_BODY_LIMIT){await reader.cancel();throw Error('wide_response_size');}parts.push(next.value);}}
 finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function dispatchWide(a:WideAttempt,store:Store=pool,http=wideHttp,clock=()=>new Date(),session:WideSession=wideSession):Promise<WideDispatch>{
 const initial=preflight(a,clock());if(initial)throw Error(initial);
 const admission=session.check(a.receivedAt);
 const evidence={stableJson,evidenceHash};
 const reader=a.operation==='anchor'?await readWideObservation(store,a.observationId,P.sourceSchemaSha256,evidence):
  await readWideObservationV2(store,a.observationId,P.sourceSchemaSha256,evidence,
   checkedBinding(await http(`/shadow/wide/anchor-binding/${a.matchId}`,undefined,
    Math.min(15000,admission.expiresAtMs-clock().getTime())),a.matchId));
 const now=clock();const failure=preflight(a,now);if(failure)throw Error(failure);
 const sourceFreshness=bindWideSourceFreshness(reader,now);
 const body:WideBody={operation:a.operation as 'anchor'|'predict',dispatchId:a.id,expectedMatchId:a.matchId,
  candidateManifestSha256:P.candidateManifestSha256,outcomeKnownAtDispatch:false,reader};
 const bodyText=JSON.stringify(body),bodySha256=hashBytes(bodyText);
 if(Buffer.byteLength(bodyText)>WIDE_BODY_LIMIT)throw Error('wide_request_size');
 // Persistent reservation is consumed BEFORE SQL and HTTP, including uncertain failures.
 session.reserve(a.id,bodySha256,Buffer.byteLength(bodyText));
 session.check(a.receivedAt);
 // False in the wire body is permitted ONLY if confirmed by this INSERT snapshot.
 // If a label appeared after the reader transaction, no dispatch/HTTP is emitted.
 const inserted=await store.query(`WITH check_outcome AS (SELECT ${OUTCOME_SQL} AS known)
 INSERT INTO wide_shadow_dispatches(attempt_id,outcome_known_at_read,outcome_known_at_dispatch,
  request_body,request_body_sha256,reader_provenance)
 SELECT $2,false,known,$3,$4,$5 FROM check_outcome WHERE known IS FALSE
 ON CONFLICT DO NOTHING RETURNING dispatched_at,outcome_known_at_dispatch`,
 [a.matchId,a.id,bodyText,bodySha256,JSON.stringify(reader.provenance)]);
 if(inserted.rows.length!==1)throw Error('wide_dispatch_outcome_changed_or_duplicate');
 return {attempt:a,body,bodyText,bodySha256,dispatchedAt:asDate(inserted.rows[0].dispatched_at),outcomeKnownAtDispatch:bool(inserted.rows[0].outcome_known_at_dispatch),sourceFreshness};
}

const SAFE_REASONS=new Set(['wide_observation_stale_or_future','wide_outcome_already_known','wide_capture_outcome_unknown',
 'wide_source_schema_changed','wide_phase_unsupported','wide_anchor_binding_unavailable','wide_response_contract_rejected',
 'wide_completion_stale_or_outcome_unknown','wide_dispatch_outcome_changed_or_duplicate','wide_request_size',
 'wide_ml_token_missing','wide_ml_unauthorized','wide_ml_busy','wide_ml_unavailable','wide_ml_empty_response','wide_response_size',
 'wide_reader_capture_outcome_not_false','wide_reader_outcome_known_or_unverified_at_read','wide_reader_history_query_truncated',
 'wide_reader_stored_anchor_not_available_before_current','wide_reader_verified_stored_anchor_required']);
const safeError=(e:unknown)=>e instanceof Error&&(SAFE_REASONS.has(e.message)||SESSION_REASONS.has(e.message)||WIDE_FRESHNESS_REASONS.has(e.message))?e.message:'wide_dispatch_or_inference_unavailable';
export function createWideDispatcher(deps:{prepare:typeof prepareWideObservation;dispatch:typeof dispatchWide;finish:typeof finishWide;
 http:typeof wideHttp;clock:()=>Date;report:()=>void;delay:(ms:number)=>Promise<void>;session:WideSession},limit=32){
 if(!Number.isSafeInteger(limit)||limit<1||limit>32)throw Error('wide_queue_limit');
 const pending:WideAttempt[]=[];let running=false,stopped=false,nextAt=0;
 const finish=async(a:WideAttempt,s:'anchor_ready'|'predicted'|'unavailable',reason:string|null,r:Json|null,sourceFreshness?:WideSourceFreshness)=>{
  try{await deps.finish(a,s,reason,r,undefined,sourceFreshness);}catch{deps.report();}
 };
 const pump=()=>{if(stopped||running||!pending.length)return;running=true;const a=pending.shift()!;
  void(async()=>{try{
   const failure=preflight(a,deps.clock());if(failure){await finish(a,'unavailable',failure,null);return;}
   const wait=Math.max(0,nextAt-deps.clock().getTime());if(wait)await deps.delay(wait);
   if(stopped){await finish(a,'unavailable','wide_shutdown',null);return;}
   deps.session.check(a.receivedAt);
   nextAt=deps.clock().getTime()+1000;
   const d=await deps.dispatch(a);const recheck=preflight(a,deps.clock());
   if(recheck||stopped){await finish(a,'unavailable',recheck??'wide_shutdown',null);return;}
   const permit=deps.session.check(a.receivedAt),remaining=permit.expiresAtMs-deps.clock().getTime();
   if(remaining<=0)throw Error('wide_session_expired');
   assertWideSourceFreshness(d.sourceFreshness,deps.clock());
   const response=checkedResponse(await deps.http('/shadow/wide/observation',d.bodyText,Math.min(15000,remaining)),d,deps.clock());
   if(response.status==='unavailable')await finish(a,'unavailable',response.reason,null);
   else {assertWideSourceFreshness(d.sourceFreshness,deps.clock());
    await finish(a,response.status==='anchor_ready'?'anchor_ready':'predicted',null,response,d.sourceFreshness);}
  }catch(error){await finish(a,'unavailable',safeError(error),null);}})().finally(()=>{running=false;pump();});};
 return {async enqueue(observations:Array<ReturnType<typeof observeLivePacket>>){
  for(const o of observations){const a=await deps.prepare(o);if(!a)continue;
   if(stopped||pending.length>=limit)await finish(a,'unavailable',stopped?'wide_shutdown':'wide_queue_full',null);
   else{pending.push(a);pump();}}
 },async stop(){stopped=true;for(const a of pending.splice(0))await finish(a,'unavailable','wide_shutdown',null);},
 status:()=>({running:running?1:0,pending:pending.length,limit,maxConcurrency:1,minimumDispatchIntervalMs:1000,stopped})};
}
let incompleteAttempts=0;
const runtime=createWideDispatcher({prepare:prepareWideObservation,dispatch:dispatchWide,finish:finishWide,http:wideHttp,
 session:wideSession,
 clock:()=>new Date(),delay:ms=>new Promise(resolve=>setTimeout(resolve,ms)),report:()=>{incompleteAttempts++;logger.warn({code:'wide_attempt_incomplete'},'[WideShadow] durable attempt incomplete');}});
export function makeWideOutboxBatch(observations:Array<ReturnType<typeof observeLivePacket>>,createdAt=new Date(),permit:SessionPermit):Json{
 if(!Number.isFinite(createdAt.getTime())||observations.length>256)throw Error('wide_outbox_batch_invalid');
 const batch=JSON.parse(JSON.stringify({version:2,createdAt:createdAt.toISOString(),candidateManifestSha256:P.candidateManifestSha256,
  sessionId:permit.sessionId,specSha256:permit.specSha256,observations}));
 if(Buffer.byteLength(stableJson(batch))>WIDE_BODY_LIMIT)throw Error('wide_outbox_batch_size');return batch;
}
export async function consumeWideOutbox(raw:unknown,deps:{prepare:typeof prepareWideObservation;finish:typeof finishWide;
 enqueue:(observations:Array<ReturnType<typeof observeLivePacket>>)=>Promise<void>;session:WideSession},startedAt=processStartedAt):Promise<void>{
 if(!record(raw)||raw.version!==2||raw.candidateManifestSha256!==P.candidateManifestSha256||!Array.isArray(raw.observations)
  ||raw.observations.length>256||typeof raw.createdAt!=='string'||!Number.isFinite(Date.parse(raw.createdAt))
  ||!Number.isFinite(startedAt.getTime())||Buffer.byteLength(stableJson(raw))>WIDE_BODY_LIMIT)throw Error('wide_outbox_batch_invalid');
 const status=deps.session.status();
 if(raw.sessionId!==status.sessionId||raw.specSha256!==status.specSha256)throw Error('wide_session_binding');
 deps.session.admitted(evidenceHash(raw),Buffer.byteLength(stableJson(raw)));
 const observations=raw.observations.map((o:Json)=>({...o,receivedAt:asDate(o.receivedAt),recordedAt:asDate(o.recordedAt)})) as Array<ReturnType<typeof observeLivePacket>>;
 // Old process receipts are evidence only: never manufacture a retrospective anchor or replay inference.
 let refusal:string|null=Date.parse(raw.createdAt)<startedAt.getTime()?'wide_ingress_recovered_after_restart':null;
 if(!refusal)try{deps.session.check();}catch(e){refusal=safeError(e);}
 if(refusal){
  for(const o of observations){const a=await deps.prepare(o);if(a)await deps.finish(a,'unavailable',refusal,null);}
 }else await deps.enqueue(observations);
}
type WideOutbox=Pick<JournalOutbox,'enqueue'|'drain'>;
export function createWideIngress(deps:{session:WideSession;store:Store;clock:()=>Date;enabled:()=>boolean;
 outbox:(sessionId:string)=>WideOutbox;reconcile:()=>Promise<number>;consume:(raw:unknown)=>Promise<void>}) {
 let recovery:Promise<void>|null=null,recoveryState='not_started',lastIngressFailure:string|null=null;
 let lastIngressCompletedAt:string|null=null,tail:Promise<void>=Promise.resolve(),waiting=0;
 const run=async(packets:Record<string,unknown>[],receivedAt:Date)=>{
  if(!deps.enabled())return;
  const state=deps.session.status();
  if(typeof state.sessionId!=='string'||!['open','closed'].includes(String(state.status))){lastIngressFailure='wide_session_unavailable';return;}
  // Recovery finishes existing attempts; it never permits a new inference.
  if(!recovery){recoveryState='running';recovery=(async()=>{for(let n=0;n<16;n++){
   if(await deps.reconcile()<256){recoveryState='ready';return;}}throw Error('wide_recovery_more_than_bound');})();}
  try{await recovery;}catch{recoveryState='failed';lastIngressFailure='wide_recovery_incomplete';return;}
  const outbox=deps.outbox(state.sessionId);
  let permit:SessionPermit|null=null;
  try{permit=deps.session.check(receivedAt);}catch(e){lastIngressFailure=safeError(e);}
  try{
   if(permit){
    if(packets.length>256)throw Error('wide_outbox_batch_invalid');
    const valid=packets.filter(p=>Number.isSafeInteger(p.match_id)&&Number(p.match_id)>0);
    let known:Set<number>|null=null;
    try{const rows=await deps.store.query(`SELECT DISTINCT match_id FROM (
     SELECT match_id FROM pro_matches WHERE match_id=ANY($1::bigint[]) AND radiant_win IS NOT NULL AND duration>0
     UNION SELECT match_id FROM live_journal_outcomes WHERE match_id=ANY($1::bigint[])) completed`,[valid.map(p=>p.match_id)]);
     known=new Set(rows.rows.map(r=>Number(r.match_id)));}catch{/* unknown stays null */}
    const observations=[];
    for(const packet of valid){try{const o=observeLivePacket(packet,receivedAt,deps.clock()),captured=known===null?null:known.has(o.matchId);
     o.availability={...o.availability,...{outcomeKnownAtCapture:captured}};
     if(captured!==false)o.qualityReasons.push(captured===true?'outcome_already_known_locally':'outcome_availability_not_checked');
     observations.push(o);}catch{lastIngressFailure='wide_packet_invalid';}}
    if(observations.length){
     // Recheck after async DB read; reserve bounded raw bytes before filesystem/SQL writes.
     deps.session.check(receivedAt);
     const batch=makeWideOutboxBatch(observations,deps.clock(),permit);
     deps.session.admit(evidenceHash(batch),Buffer.byteLength(stableJson(batch)));
     await outbox.enqueue(batch);
    }
   }
   // Bounded earlier admitted batches may be finished even when new ingress is closed.
   await outbox.drain(deps.consume,20);
   if(permit)lastIngressFailure=null;
   lastIngressCompletedAt=deps.clock().toISOString();
  }catch(e){lastIngressFailure=SESSION_REASONS.has(safeError(e))?safeError(e):'wide_ingress_outbox_incomplete';}
 };
 return {enqueue(packets:Record<string,unknown>[],receivedAt:Date):Promise<void>{
  if(!deps.enabled())return Promise.resolve();
  // One natural LiveWorker caller; bounded serialization prevents concurrent drains.
  if(waiting>=2){lastIngressFailure='wide_ingress_busy';return Promise.resolve();}
  waiting++;const task=tail.then(()=>run(packets,receivedAt));
  tail=task.catch(()=>{lastIngressFailure='wide_ingress_outbox_incomplete';}).finally(()=>{waiting--;});return tail;
 },status:()=>({recoveryState,lastIngressFailure,lastIngressCompletedAt,ingressQueued:waiting})};
}
const ingress=createWideIngress({session:wideSession,store:pool,clock:()=>new Date(),
 enabled:()=>process.env.AEGIS_WIDE_SHADOW_ENABLED==='1',reconcile:()=>reconcileWideInterrupted(),
 outbox:sessionId=>new JournalOutbox(join(process.env.AEGIS_STATE_DIR??'','wide-shadow',sessionId)),
 consume:raw=>consumeWideOutbox(raw,{prepare:prepareWideObservation,finish:finishWide,enqueue:runtime.enqueue,session:wideSession})});
export const wideShadowStatus=()=>({enabled:process.env.AEGIS_WIDE_SHADOW_ENABLED==='1',pins:P,...runtime.status(),
 ...ingress.status(),session:wideSession.status(),incompleteAttempts,...WIDE_FLAGS});
export const stopWideShadow=()=>runtime.stop();
export const enqueueWidePackets=(packets:Record<string,unknown>[],receivedAt:Date)=>ingress.enqueue(packets,receivedAt);
