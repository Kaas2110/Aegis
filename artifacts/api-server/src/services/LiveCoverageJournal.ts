import {randomUUID,createHash} from 'node:crypto';
import {pool} from '@workspace/db';
import {logger} from '../lib/logger';
import {CoverageOutbox} from '../lib/coverageOutbox';
import {applyCoverageOperation,emptyCoverageState,COVERAGE_POLICY,type CoverageOperation,type CoverageState,
  type PollTicket,type PacketSummary} from '../lib/liveCoverageContract';
import {liveStateFreshness,liveStateHash} from '../lib/liveStateFreshness';
import {safeOpenDotaId} from '../lib/openDotaLiveIds';
import {classifyProviderFeedError} from '../lib/providerFeedError';

const runId=randomUUID();let outbox:CoverageOutbox|null=null;
const getOutbox=()=>outbox??(outbox=new CoverageOutbox(process.env.AEGIS_STATE_DIR??''));
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
export type PollCapture={ticket:PollTicket,attemptedAt:number|null,receivedAt:number|null,
  packets:PacketSummary[],sourceOutcome:CoverageOperation['sourceOutcome'],errorCategory:CoverageOperation['errorCategory'],
  diagnosticStatus?:CoverageOperation['diagnosticStatus'],finished?:boolean};

/** Single append-only operation and derived events are atomic with their state cursor. */
export async function persistCoverageOperation(op:CoverageOperation):Promise<void>{
  const client=await pool.connect();
  try{await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('aegis-live-coverage-v1',0))");
    if((await client.query('SELECT id FROM live_coverage_operations WHERE id=$1',[op.id])).rowCount){await client.query('COMMIT');return;}
    await client.query("INSERT INTO live_coverage_state(id,state) VALUES('opendota_live',$1) ON CONFLICT DO NOTHING",[JSON.stringify(emptyCoverageState())]);
    const record=(await client.query("SELECT state, floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms FROM live_coverage_state WHERE id='opendota_live' FOR UPDATE")).rows[0];
    const state=record.state as CoverageState;
    const ids=[...new Set([...Object.values(state.scopes).map(s=>s.matchId),...(op.packets??[]).map(p=>p.matchId).filter((v):v is number=>v!==null)])];
    const known=ids.length?(await client.query('SELECT match_id FROM pro_matches WHERE match_id=ANY($1::bigint[]) AND radiant_win IS NOT NULL AND duration>0',[ids])).rows:[];
    const result=applyCoverageOperation(state,op,{databaseNow:Number(record.now_ms),knownOutcomeIds:known.map((r:{match_id:string|number})=>Number(r.match_id))});
    await client.query('INSERT INTO live_coverage_operations(id,sequence,occurred_at,operation) VALUES($1,$2,to_timestamp($3::double precision/1000),$4)',[op.id,op.sequence,op.at,JSON.stringify(op)]);
    if(result.events.length)await client.query(`INSERT INTO live_coverage_events(id,operation_id,kind,occurred_at,scope_id,poll_id,match_id,detail)
      SELECT x.id,$1,x.kind,to_timestamp(x."occurredAt"::double precision/1000),x."scopeId",x."pollId",x."matchId",x.detail
      FROM jsonb_to_recordset($2::jsonb) AS x(id text,kind text,"occurredAt" bigint,"scopeId" text,"pollId" text,"matchId" bigint,detail jsonb)`,[op.id,JSON.stringify(result.events)]);
    await client.query("UPDATE live_coverage_state SET state=$1,updated_at=clock_timestamp() WHERE id='opendota_live'",[JSON.stringify(result.state)]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
async function append(raw:Omit<CoverageOperation,'sequence'>):Promise<void>{
  try{const queue=getOutbox();await queue.enqueue(raw);
    void queue.drain(persistCoverageOperation).catch(()=>logger.error({code:'coverage_db_drain_failed'},'[LiveCoverage] durable operations pending; denominator incomplete until recovered'));
  }catch{logger.error({code:'coverage_durable_write_failed',policy:COVERAGE_POLICY.version},'[LiveCoverage] coverage evidence may be lost; never claim complete coverage');}
}
/** Called before setTimeout; only local fsync is awaited, never a provider or DB. */
export async function planLiveCoverage(delayMs:number,mode:PollTicket['mode'],cause:PollTicket['cause']):Promise<PollCapture>{
  const plannedAt=Date.now(),ticket:PollTicket={id:randomUUID(),runId,plannedAt,dueAt:plannedAt+delayMs,delayMs,mode,cause};
  await append({id:randomUUID(),kind:'plan',at:plannedAt,ticket});
  return {ticket,attemptedAt:null,receivedAt:null,packets:[],sourceOutcome:'not_attempted',errorCategory:null};
}
export function captureCoverageFeed(capture:PollCapture,raw:unknown[],receivedAt:Date):void{
  // Diagnostics never modify provider packets, deduplication, predictions, or polling cadence.
  try {
  const received=receivedAt.getTime();
  if(raw.length>COVERAGE_POLICY.maxPackets)throw new Error('coverage_packet_limit');
  const packets:PacketSummary[]=raw.map(value=>{
    if(value===null||typeof value!=='object'||Array.isArray(value)){
      // One summary per received row, including an unidentifiable non-map row.
      // Null identity is unknown, never a fabricated map or denominator member.
      // Raw provider payload remains durable in provider_feed_snapshots.
      return {matchId:null,radiantTeamId:null,direTeamId:null,gameTime:null,
        radiantScore:null,direScore:null,
        packetHash:createHash('sha256').update(JSON.stringify({kind:'live_packet_not_object',type:typeof value,raw:value})).digest('hex'),
        state6FieldsComplete:false,passesLocalSourceGuard:false,
        freshnessReason:'live_packet_not_object',declaredDelaySeconds:null};
    }
    const p=value as Record<string,unknown>;
    const clock=number(p.game_time),r=number(p.radiant_score),d=number(p.dire_score);
    const fresh=liveStateFreshness(p,receivedAt.toISOString(),received);
    return {matchId:safeOpenDotaId(p.match_id)??null,radiantTeamId:safeOpenDotaId(p.team_id_radiant)??null,direTeamId:safeOpenDotaId(p.team_id_dire)??null,
      gameTime:clock,radiantScore:r,direScore:d,packetHash:liveStateHash(p),
      state6FieldsComplete:clock!==null&&clock>0&&r!==null&&Number.isInteger(r)&&r>=0&&d!==null&&Number.isInteger(d)&&d>=0,
      passesLocalSourceGuard:fresh.eligibleForObservedStatePrediction,freshnessReason:fresh.reason,declaredDelaySeconds:fresh.declaredBroadcastDelaySeconds};
  });
  capture.receivedAt=received;capture.packets=packets;
  capture.sourceOutcome=raw.length===0?'empty':packets.some(p=>p.matchId&&p.radiantTeamId&&p.direTeamId&&p.radiantTeamId!==p.direTeamId)?'success':'no_eligible_maps';
  } catch {
    // Evidence failure is separate from the provider or model result; keep the
    // real acquisition successful, but explicitly reject this diagnostic input.
    capture.receivedAt=receivedAt.getTime();capture.packets=[];capture.sourceOutcome=raw.length?'success':'empty';
    capture.diagnosticStatus='packet_summary_failed';
    capture.errorCategory='invalid_payload';
    logger.error({code:'coverage_packet_capture_failed'},'[LiveCoverage] received packet could not be summarized');
  }
}
export function captureCoverageFailure(capture:PollCapture,error:unknown):void{
  capture.sourceOutcome='error';capture.receivedAt=null;capture.packets=[];capture.errorCategory=classifyProviderFeedError(error).category;
}
export async function finishLiveCoverage(capture:PollCapture,workerOutcome:NonNullable<CoverageOperation['workerOutcome']>):Promise<void>{
  if(capture.finished)return;capture.finished=true;
  await append({id:randomUUID(),kind:'poll',at:Date.now(),ticket:capture.ticket,attemptedAt:capture.attemptedAt,
    receivedAt:capture.receivedAt,packets:capture.packets,sourceOutcome:capture.sourceOutcome,
    workerOutcome,errorCategory:capture.errorCategory,diagnosticStatus:capture.diagnosticStatus??'ok'});
}
