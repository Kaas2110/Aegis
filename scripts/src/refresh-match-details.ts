/** One public OpenDota GET supplies both draft and available replay data.
 * Bounded 1..30 matches, shared quota gate, no replay-request POST or fallback.
 * Recent unparsed maps and transient errors use bounded outcome-specific retries.
 * Local persistence retries resume from an immutable response without another GET.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { archiveFetch } from './lib/archive-fetch.js';
import { db, proMatchesTable, matchDraftsTable, matchParsedTable } from '@workspace/db';
import { sql, eq } from 'drizzle-orm';
import { fetchJsonGet, OpenDotaGetError } from './lib/fetchJsonGet.js';
import { prepareMatchDetail } from './lib/match-detail-payload.js';
import { mergeParsedPayload, PARSED_PAYLOAD_SCHEMA_VERSION } from './lib/parsed-payload.js';
import { readRawMatchResponse, retainRawMatchResponse } from './lib/raw-match-response.js';
import { makeMatchObservation, planMatchObservationFile, readMatchObservation, writeMatchObservation } from './lib/match-observation.js';
import { coolingMatchIds, completedDetailAttempt, detailRetryAt, detailLimit, DETAIL_COOLDOWN_MS, isPersistenceRetry,
  openDetailRefreshCheckpoint, schemaUpgradeRetryIds, selectDetailRefresh } from './lib/detail-refresh-state.js';

export async function refreshMatchDetails(options: {archive?: boolean; limit?: number; concurrency?: number; maxDurationMs?: number} = {}) {
  const archive=options.archive===true;
  const limit=detailLimit(options.limit??12,archive?1000:30);
  const concurrency=options.concurrency??1;
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>2)throw new Error('concurrency must be 1..2');
  const deadline=Date.now()+Math.min(600_000,Math.max(30_000,options.maxDurationMs??480_000));
  const checkpoint = openDetailRefreshCheckpoint(process.env.AEGIS_STATE_DIR);
  try {
    const now = Date.now();
    // One bound parameter per array, even after many months of checkpoints.
    const integerArray = (values: number[]) => sql`${`{${values.join(',')}}`}::bigint[]`;
    // Backward-compatible local migration: only unresolved legacy entries need
    // match ages. No extra provider calls and no checkpoint reset.
    const missingAges = Object.entries(checkpoint.state.attempts).filter(([, attempt]) =>
      attempt.matchStartTime === undefined && (attempt.outcome === 'draft_only' || attempt.outcome === 'unavailable')).map(([id]) => Number(id));
    if (missingAges.length) {
      const ages = await db.execute(sql`SELECT match_id, start_time FROM pro_matches WHERE match_id = ANY(${integerArray(missingAges)})`);
      for (const row of ages.rows) checkpoint.state.attempts[String(row.match_id)].matchStartTime = Number(row.start_time);
      checkpoint.save();
    }
    const cooling = integerArray(coolingMatchIds(checkpoint.state, now));
    const persistenceRetries = integerArray(Object.entries(checkpoint.state.attempts).filter(([, attempt]) => isPersistenceRetry(attempt)).map(([id]) => Number(id)));
    const tried = integerArray(Object.keys(checkpoint.state.attempts).map(Number));
    const upgradeRetries = integerArray(archive ? schemaUpgradeRetryIds(checkpoint.state, PARSED_PAYLOAD_SCHEMA_VERSION) : []);
    const schemaUpgrade = sql`(p.match_id IS NOT NULL AND p.payload_schema_version < ${PARSED_PAYLOAD_SCHEMA_VERSION} AND m.match_id = ANY(${upgradeRetries}))`;
    const missingParsed = archive ? sql`(p.match_id IS NULL OR p.payload_schema_version < ${PARSED_PAYLOAD_SCHEMA_VERSION})` : sql`(p.match_id IS NULL)`;
    const missingDraft = sql`(d.match_id IS NULL
      OR jsonb_array_length(CASE WHEN jsonb_typeof(d.radiant_picks)='array' THEN d.radiant_picks ELSE '[]'::jsonb END) <> 5
      OR jsonb_array_length(CASE WHEN jsonb_typeof(d.dire_picks)='array' THEN d.dire_picks ELSE '[]'::jsonb END) <> 5)`;
    // Resume local persistence first, then recent/untouched gaps and expired retries.
    // Cooldown IDs are excluded before LIMIT so an unavailable prefix cannot
    // starve older missing data. State retains old attempts to ensure progress.
    const candidates = await db.execute(sql`SELECT m.match_id, m.start_time,
      ${missingDraft} AS "missingDraft", ${missingParsed} AS "missingParsed", ${schemaUpgrade} AS "schemaUpgrade"
      FROM pro_matches m LEFT JOIN match_drafts d USING(match_id)
      LEFT JOIN match_parsed p USING(match_id)
      WHERE (${missingDraft} OR ${missingParsed}) AND m.duration > 600
        AND (NOT (m.match_id = ANY(${cooling})) OR ${schemaUpgrade})
      ORDER BY CASE WHEN m.match_id = ANY(${persistenceRetries}) THEN -1 WHEN ${schemaUpgrade} OR m.start_time >= ${Math.floor((now - DETAIL_COOLDOWN_MS) / 1000)} THEN 0
        WHEN m.match_id = ANY(${tried}) THEN 2 ELSE 1 END, m.start_time DESC, m.match_id DESC
      LIMIT ${limit * 4}`);
    const selected = selectDetailRefresh(candidates.rows.map(row => ({ matchId: Number(row.match_id),
      startTime: Number(row.start_time), missingDraft: row.missingDraft === true,
      missingParsed: row.missingParsed === true, schemaUpgrade: row.schemaUpgrade === true })), checkpoint.state, now, limit,archive?1000:30,archive?PARSED_PAYLOAD_SCHEMA_VERSION:0);
    let drafts = 0, parsed = 0;
    let cursor=0,stop=false;
    const worker=async()=>{while(!stop&&cursor<selected.length&&Date.now()<deadline){
      const {matchId, startTime}=selected[cursor++];
      const key = String(matchId);
      const previousAttempt = checkpoint.state.attempts[key];
      // Persist the destination BEFORE network I/O. After publication, a restart
      // can merge this exact response without charging another provider request.
      const attemptedAt = new Date();
      const observationFile = isPersistenceRetry(previousAttempt) && previousAttempt?.observationFile
        ? previousAttempt.observationFile
        : planMatchObservationFile(process.env.AEGIS_STATE_DIR, matchId, attemptedAt);
      const retryOutcome = previousAttempt && ['parsed', 'draft_only', 'unavailable', 'error'].includes(previousAttempt.outcome)
        ? previousAttempt.outcome as 'parsed' | 'draft_only' | 'unavailable' | 'error' : previousAttempt?.retryOutcome;
      checkpoint.state.attempts[key] = { ...previousAttempt, at: attemptedAt.getTime(), outcome: 'pending', observationFile, matchStartTime: startTime, retryOutcome };
      checkpoint.save();
      let localPersistence = true;
      try {
        let observation = readMatchObservation(process.env.AEGIS_STATE_DIR, observationFile, matchId);
        if (!observation) {
          // Recover only a newly retained full response for this exact planned
          // attempt. Old selected receipts are not reloaded or enriched.
          const retained = readRawMatchResponse(process.env.AEGIS_STATE_DIR, observationFile, matchId);
          let detail: unknown;
          let receivedAt: Date;
          if (retained) {
            detail = retained.payload;
            receivedAt = new Date(retained.receipt.receivedAt);
          } else {
            localPersistence = false;
            const requestStartedAt = new Date();
            detail = await fetchJsonGet<unknown>(`https://api.opendota.com/api/matches/${matchId}`,
              { timeoutMs: 30_000, minDelayMs: 1500, ...(archive?{fetchImpl:archiveFetch}:{}) });
            receivedAt = new Date();
            localPersistence = true;
            // Separate full decoded JSON before the existing selected whitelist.
            // Additive retention failure never triggers an extra provider GET.
            const raw = retainRawMatchResponse(process.env.AEGIS_STATE_DIR, detail,
              { matchId, job: 'refresh_match_details', requestStartedAt, receivedAt, observationFile });
            if (raw.status === 'not_retained') console.warn(`[raw-match-json] ${matchId}: ${raw.reason}`);
          }
          observation = makeMatchObservation(detail, matchId, receivedAt);
          writeMatchObservation(process.env.AEGIS_STATE_DIR, observation, observationFile);
        }
        const receivedAt = new Date(observation.receivedAt);
        const parts = prepareMatchDetail(observation.payload, matchId);
        await db.transaction(async tx => {
          if (parts.draft) {
            await tx.insert(matchDraftsTable).values({ matchId, ...parts.draft, fetchedAt: receivedAt })
              .onConflictDoUpdate({ target: matchDraftsTable.matchId, set: { ...parts.draft, fetchedAt: receivedAt },
                // A replay-only refresh must not replace a complete existing
                // draft/roster with missing account IDs from a partial response.
                setWhere: sql`jsonb_array_length(CASE WHEN jsonb_typeof(${matchDraftsTable.radiantPicks})='array' THEN ${matchDraftsTable.radiantPicks} ELSE '[]'::jsonb END) <> 5
                  OR jsonb_array_length(CASE WHEN jsonb_typeof(${matchDraftsTable.direPicks})='array' THEN ${matchDraftsTable.direPicks} ELSE '[]'::jsonb END) <> 5` });
          }
          if (parts.parsed) {
            const existing = await tx.select().from(matchParsedTable).where(eq(matchParsedTable.matchId, matchId)).limit(1);
            const payload = mergeParsedPayload(existing[0] ?? null, parts.parsed);
            await tx.insert(matchParsedTable).values({ matchId, ...payload, parsedAt: receivedAt })
              .onConflictDoUpdate({ target: matchParsedTable.matchId, set: { ...payload, parsedAt: receivedAt } });
            await tx.update(proMatchesTable).set({ isParsed: true, parsedAt: receivedAt }).where(eq(proMatchesTable.matchId, matchId));
          }
          if (parts.firstBloodTime !== null) await tx.update(proMatchesTable)
            .set({ firstBloodTime: parts.firstBloodTime }).where(eq(proMatchesTable.matchId, matchId));
        });
        drafts += Number(parts.draft !== null);
        parsed += Number(parts.parsed !== null);
        checkpoint.state.attempts[key] = completedDetailAttempt(previousAttempt, parts.parsed ? 'parsed' : parts.draft ? 'draft_only' : 'unavailable', Date.now(), startTime);
        if (parts.parsed) checkpoint.state.attempts[key].payloadSchemaVersion = parts.parsed.payloadSchemaVersion;
        delete checkpoint.state.attempts[key].observationFile;
        checkpoint.save();
        console.log(`[refresh-detail] ${matchId}: draft=${!!parts.draft} replay=${!!parts.parsed}; next eligible ${new Date(detailRetryAt(checkpoint.state.attempts[key])).toISOString()} if still missing`);
      } catch (error) {
        if ((error as { code?: string } | null)?.code === 'OD_DEFERRED') {
          // No useful match response was received; the shared ledger already
          // controls the retry time. Do not impose a seven-day replay cooldown.
          if (previousAttempt) checkpoint.state.attempts[key] = previousAttempt;
          else delete checkpoint.state.attempts[key];
        } else if (localPersistence) {
          checkpoint.state.attempts[key] = { ...previousAttempt, at: attemptedAt.getTime(), outcome: 'persistence_retry', observationFile, matchStartTime: startTime, retryOutcome };
        } else {
          checkpoint.state.attempts[key] = completedDetailAttempt(previousAttempt, 'error', Date.now(), startTime,
            error instanceof OpenDotaGetError ? { retryable: error.retryable, retryAfterMs: error.retryAfterMs } : { retryable: false, retryAfterMs: null });
        }
        checkpoint.save();
        stop=true;throw error;
      }
    }};
    const outcomes=await Promise.allSettled(Array.from({length:concurrency},worker));
    const failed=outcomes.find((r):r is PromiseRejectedResult=>r.status==='rejected');
    if(failed)throw failed.reason;
    console.log(JSON.stringify({ selected: selected.length, attempted:cursor, drafts, parsed, retryPolicy: 'outcome_backoff_v2', archive }));
  } finally { checkpoint.release(); }
}

if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) refreshMatchDetails({limit:detailLimit(process.argv[2]??12)}).then(() => process.exit(0)).catch(error => {
  console.error('[refresh-detail] stopped:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
