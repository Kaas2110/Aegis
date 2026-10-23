import { readFileSync } from 'node:fs';
import { pool } from '@workspace/db';
import { logger } from '../lib/logger';
import { evidenceHash } from '../lib/predictionEvidence';
import type { LiveJournalContext } from './LivePredictionJournal';
import { selectWinnerHistory } from './liveWinnerHistoryPolicy';
import { boundedResponseText, httpFailure, ShadowDiagnosticError } from './liveWinnerShadowDiagnostics';
import {
  WINNER_SHADOW, WINNER_SHADOW_CANDIDATE_HASH, runLiveWinnerShadow,
  type ObservationEnvelope, type ShadowBody, type ShadowRequest, type ShadowCompletion,
} from './LiveWinnerShadowContract';

// Read-only labels. No provider requests are made by this module.
const knownOutcomeSql = `(EXISTS(SELECT 1 FROM pro_matches p WHERE p.match_id=$1
  AND p.radiant_win IS NOT NULL AND p.duration>0)
  OR EXISTS(SELECT 1 FROM live_journal_outcomes o WHERE o.match_id=$1))`;

function envelope(row: { id: string; received_at: Date; recorded_at: Date; input: Record<string, unknown> }): ObservationEnvelope {
  return { observationId: row.id, source: 'opendota', targetScope: 'map', clockUnit: 'seconds', scoreUnit: 'kills',
    receivedAt: row.received_at.toISOString(), recordedAt: row.recorded_at.toISOString(), input: row.input };
}

export async function prepareLiveWinnerShadow(context: LiveJournalContext, sqlPool: Pick<typeof pool,'query'|'connect'> = pool): Promise<ShadowRequest | null> {
  const o = context.observation;
  // Persist only the input. Legacy success/refusal rows are flushed by their own
  // producer later; inserting defaults here would mask real legacy predictions.
  await sqlPool.query(`INSERT INTO live_observation_journal
    (id,match_id,snapshot_id,received_at,recorded_at,game_time_sec,phase,input_hash,schema_hash,input,quality_reasons,availability)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
    [o.id,o.matchId,context.snapshotId,o.receivedAt,o.recordedAt,o.gameTimeSec,o.phase,o.inputHash,o.schemaHash,
      JSON.stringify(o.input),JSON.stringify(o.qualityReasons),JSON.stringify(o.availability)]);
  const client = await sqlPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    // This SELECT sees only committed input rows; recorded_at by itself is NOT
    // evidence of a durable insert because legacy observation times are app times.
    const current = (await client.query(`SELECT * FROM live_observation_journal WHERE id=$1`, [o.id])).rows[0];
    if (!current || current.input_hash !== o.inputHash || Number(current.match_id) !== o.matchId)
      throw new Error('shadow_observation_identity_conflict');
    const history = (await client.query(`SELECT * FROM (
      SELECT DISTINCT ON(game_time_sec) * FROM live_observation_journal
      WHERE match_id=$1 AND id<>$2 AND received_at<=$3 AND recorded_at<=$4
        AND game_time_sec >= greatest(0,$5::integer-420)
      ORDER BY game_time_sec,received_at DESC,recorded_at DESC,id DESC) previous_clocks
      ORDER BY received_at DESC,recorded_at DESC,id DESC LIMIT 256`,
      [o.matchId,o.id,current.received_at,current.recorded_at,current.game_time_sec])).rows.reverse();
    const selected=selectWinnerHistory(envelope(current),history.map(envelope),o.matchId);
    const body: ShadowBody = { current: envelope(current), history: selected.history, expectedMatchId: o.matchId };
    const requestId = evidenceHash({ observationId: o.id, candidateHash: WINNER_SHADOW_CANDIDATE_HASH() });
    const evidence = {
      contract: 'durable_observed_shadow_attempt_v1', requestBodyHash: evidenceHash(body),
      sourceObservation: { id: current.id, inputHash: current.input_hash, schemaHash: current.schema_hash },
      history: history.map(h => ({ id: h.id, inputHash: h.input_hash, schemaHash: h.schema_hash })),
      historySelection: 'visible DB rows; same map; latest per game clock; lower clock bound current-420; receipt/recorded cutoff; max256; forward monotone priors; current regression resets trajectory',
      inputHistoryPolicy:selected.diagnostics,
      sourceAssessment: { availability: current.availability, qualityReasons: current.quality_reasons },
      outcomeKnownAtCapture: current.availability.outcomeKnownAtCapture ?? null,
      sourcePins: WINNER_SHADOW,
    };
    const inserted = await client.query(`INSERT INTO live_shadow_requests
      (match_id,id,observation_id,candidate_id,candidate_hash,model_hash,outcome_known_at_dispatch,request_body,evidence)
      VALUES($1,$2,$3,$4,$5,$6,${knownOutcomeSql},$7,$8)
      ON CONFLICT DO NOTHING RETURNING dispatched_at,outcome_known_at_dispatch`,
      [o.matchId,requestId,o.id,WINNER_SHADOW.candidateId,WINNER_SHADOW_CANDIDATE_HASH(),WINNER_SHADOW.modelSha256,
        JSON.stringify(body),JSON.stringify(evidence)]);
    await client.query('COMMIT');
    if (!inserted.rowCount) return null;
    return { id: requestId, body, evidence, dispatchedAt: inserted.rows[0].dispatched_at,
      outcomeKnownAtDispatch: inserted.rows[0].outcome_known_at_dispatch };
  } catch (err) {
    await client.query('ROLLBACK'); throw err;
  } finally { client.release(); }
}

export async function finishLiveWinnerShadow(request: ShadowRequest, result: ShadowCompletion, sqlPool: Pick<typeof pool,'query'> = pool): Promise<void> {
  // One statement pins the visible outcome check to the result insert snapshot.
  // It does not assert that no outcome could commit concurrently afterwards.
  await sqlPool.query(`WITH outcome_check AS (SELECT ${knownOutcomeSql} AS known),
    disclosure AS (SELECT q.id,known,
      (known IS FALSE AND q.outcome_known_at_dispatch IS FALSE
        AND coalesce(q.evidence->'outcomeKnownAtCapture'='false'::jsonb,false)) IS TRUE AS allowed
      FROM outcome_check,live_shadow_requests q WHERE q.id=$2)
    INSERT INTO live_shadow_results(request_id,status,reason,completed_at,outcome_known_at_finish,
      before_local_outcome_at_checks,response,assessment)
    SELECT $2,CASE WHEN $3='predicted' AND NOT allowed THEN 'unavailable' ELSE $3 END,
      CASE WHEN $3='predicted' AND NOT allowed
        THEN CASE WHEN known IS TRUE THEN 'shadow_outcome_known_at_finish' ELSE 'shadow_outcome_status_unverified' END ELSE $4 END,
      $5,known,($3='predicted' AND allowed),CASE WHEN allowed THEN $6::jsonb ELSE NULL END,
      jsonb_set($7::jsonb,'{outcomeDisclosureAllowedAtFinish}',to_jsonb(allowed))
    FROM disclosure
    ON CONFLICT DO NOTHING`,
    [request.body.expectedMatchId,request.id,result.status,result.reason,result.completedAt,
      result.response === null ? null : JSON.stringify(result.response),JSON.stringify(result.assessment)]);
}

async function infer(body: ShadowBody): Promise<unknown> {
  let token = process.env.ML_SERVICE_TOKEN?.trim();
  if (!token) try { token = readFileSync('/tmp/aegis_ml_token','utf8').trim(); } catch { /* unavailable */ }
  if (!token) throw new Error('shadow_service_token_missing');
  try {
    const response = await fetch(`${(process.env.ML_SERVICE_URL ?? 'http://localhost:8090').replace(/\/$/,'')}/shadow/live-winner`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ML-Token': token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    if(!response.ok){const body=await boundedResponseText(response,8192);throw httpFailure(response.status,body.text,body.truncated);}
    // A fixed 268-feature local response is small. Do not journal arbitrary pages.
    const responseBody=await boundedResponseText(response,512_000);
    if(responseBody.truncated)throw new ShadowDiagnosticError('shadow_response_contract_rejected',{predicate:'response_body_limit_exceeded',httpStatus:response.status});
    try{return JSON.parse(responseBody.text);}catch{throw new ShadowDiagnosticError('shadow_response_contract_rejected',{predicate:'response_json_invalid',httpStatus:response.status});}
  } catch (err) {
    if (['TimeoutError','AbortError'].includes((err as Error).name)) throw new Error('shadow_service_timeout');
    throw err;
  }
}

const pending: LiveJournalContext[] = [];
let running = 0;
/** Fire-and-forget diagnostic work: independent of legacy models and UI response time. */
export function enqueueLiveWinnerShadow(contexts: LiveJournalContext[]): void {
  const accepted = contexts.slice(0, Math.max(0,128-pending.length));
  pending.push(...accepted);
  if (accepted.length !== contexts.length)
    logger.warn({ dropped: contexts.length-accepted.length }, '[LiveWinnerShadow] queue full; missing results remain unavailable');
  pump();
}
function pump(): void {
  while (running < 1 && pending.length) {
    const context = pending.shift()!; running++;
    void runLiveWinnerShadow(context, { prepare: prepareLiveWinnerShadow, infer, finish: finishLiveWinnerShadow }).catch(err => {
      // Do not expose auth, SQL parameters or payloads through exception strings.
      logger.warn({ code: (err as { code?: string }).code ?? 'shadow_journal_failed', matchId: context.observation.matchId },
        '[LiveWinnerShadow] attempt incomplete; no success or freshness claim');
    }).finally(() => { running--; pump(); });
  }
}
