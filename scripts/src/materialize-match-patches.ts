import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from '@workspace/db';
import { createPatchResolver, type MatchPatchAssignment } from './lib/match-patch-resolver';
import { loadOfficialReleases, readProviderPatchEvidence } from './lib/patch-assignment-materializer';

// No source API, training or serving calls. This builds additive metadata only.
async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--');
  if (args.some(a => !['--migrate', '--dry-run'].includes(a))) throw new Error('Supported arguments: --migrate, --dry-run');
  const dryRun = args.includes('--dry-run');
  const stateDir = process.env.AEGIS_STATE_DIR;
  if (!stateDir) throw new Error('AEGIS_STATE_DIR is required');
  const calendar = loadOfficialReleases(stateDir);
  const observations = readProviderPatchEvidence(stateDir);
  const resolvePatch = createPatchResolver(calendar.releases, calendar.hash);
  const client = await pool.connect();
  const summary = {event: 'match-patch-materialization', dryRun, calendarHash: calendar.hash,
    catalogObservedAt: calendar.receivedAt, catalogLastCheckedAt: calendar.lastCheckedAt,
    releases: calendar.releases.length, scanned: 0, inferred: 0, confirmed: 0, unresolved: 0,
    uncertain: 0, providerEvidence: 0, providerConflicts: 0, changed: 0, unchanged: 0,
    observationsRead: observations.observations, skippedInvalidStarts: 0,
    byVersion: {} as Record<string, number>, uncertaintyReasons: {} as Record<string, number>,
    providerRawModified: false, trainingModified: false};
  try {
    if (!dryRun && args.includes('--migrate')) await client.query(readFileSync(fileURLToPath(new URL('../../lib/db/migrations/20261004_match_patch_assignments.sql', import.meta.url)), 'utf8'));
    if (!dryRun) {
      const lock = await client.query('SELECT pg_try_advisory_lock(714204, 1) AS acquired');
      if (!lock.rows[0].acquired) { console.log(JSON.stringify({event: summary.event, state: 'skipped', reason: 'materialization_running'})); process.exitCode = 10; return; }
      await client.query(`INSERT INTO dota_patch_calendar_releases
        (calendar_hash,patch_version,source,release_from,release_to,timestamp_precision,observed_at,known_at,knowledge_basis)
        SELECT $1,x.version,x.source,x."releaseFrom",x."releaseTo",x."timestampPrecision",x."observedAt",x."knownAt",x."knowledgeBasis"
        FROM jsonb_to_recordset($2::jsonb) AS x(version text,source text,"releaseFrom" timestamptz,"releaseTo" timestamptz,
          "timestampPrecision" text,"observedAt" timestamptz,"knownAt" timestamptz,"knowledgeBasis" text)
        ON CONFLICT (calendar_hash,patch_version) DO NOTHING`, [calendar.hash, JSON.stringify(calendar.releases)]);
    }
    let after = 0;
    while (true) {
      // Keyset pagination bounds memory and allows newly collected maps next run.
      const batch = await client.query('SELECT match_id,start_time FROM pro_matches WHERE match_id > $1 ORDER BY match_id LIMIT 1000', [after]);
      if (!batch.rows.length) break;
      const assignments: MatchPatchAssignment[] = [];
      for (const row of batch.rows) {
        const id = Number(row.match_id), start = Number(row.start_time); after = id;
        if (!Number.isSafeInteger(start) || start <= 0) { summary.skippedInvalidStarts++; continue; }
        const result = resolvePatch({matchId: id, startTime: start, provider: observations.evidence.get(id)});
        summary.scanned++; assignments.push(result);
        if (result.provenance === 'inferred_by_release_calendar') summary.inferred++;
        else if (result.provenance === 'provider_reported_exact') summary.confirmed++;
        else summary.unresolved++;
        if (result.providerEvidence) summary.providerEvidence++;
        if (result.uncertainty) summary.uncertain++;
        if (result.reasons.some(r => r.includes('conflicts_calendar'))) summary.providerConflicts++;
        const version = result.inferredVersion ?? 'unresolved';
        summary.byVersion[version] = (summary.byVersion[version] ?? 0) + 1;
        for (const reason of result.reasons) summary.uncertaintyReasons[reason] = (summary.uncertaintyReasons[reason] ?? 0) + 1;
      }
      if (!dryRun && assignments.length) {
        const result = await client.query(`INSERT INTO match_patch_assignments
          (match_id,match_start,inferred_version,confirmed_version,provider_base_version,provider_evidence,
           provenance,uncertainty,reasons,candidates,calendar_hash,release_known_at,release_observed_at,
           release_timestamp_precision,inference_basis,resolver_version,input_fingerprint)
          SELECT x."matchId",x."matchStart",x."inferredVersion",x."confirmedVersion",x."providerBaseVersion",x."providerEvidence",
            x.provenance,x.uncertainty,x.reasons,x.candidates,x."calendarHash",x."releaseKnownAt",x."releaseObservedAt",
            x."releaseTimestampPrecision",x."inferenceBasis",x."resolverVersion",x."inputFingerprint"
          FROM jsonb_to_recordset($1::jsonb) AS x("matchId" bigint,"matchStart" timestamptz,"inferredVersion" text,
            "confirmedVersion" text,"providerBaseVersion" text,"providerEvidence" jsonb,provenance text,uncertainty boolean,
            reasons jsonb,candidates jsonb,"calendarHash" text,"releaseKnownAt" timestamptz,"releaseObservedAt" timestamptz,
            "releaseTimestampPrecision" text,"inferenceBasis" text,"resolverVersion" text,"inputFingerprint" text)
          ON CONFLICT (match_id) DO UPDATE SET match_start=excluded.match_start,inferred_version=excluded.inferred_version,
            confirmed_version=excluded.confirmed_version,provider_base_version=excluded.provider_base_version,
            provider_evidence=excluded.provider_evidence,provenance=excluded.provenance,uncertainty=excluded.uncertainty,
            reasons=excluded.reasons,candidates=excluded.candidates,calendar_hash=excluded.calendar_hash,
            release_known_at=excluded.release_known_at,release_observed_at=excluded.release_observed_at,
            release_timestamp_precision=excluded.release_timestamp_precision,inference_basis=excluded.inference_basis,
            resolver_version=excluded.resolver_version,input_fingerprint=excluded.input_fingerprint,assigned_at=now()
          WHERE match_patch_assignments.input_fingerprint IS DISTINCT FROM excluded.input_fingerprint`, [JSON.stringify(assignments)]);
        summary.changed += result.rowCount ?? 0;
        summary.unchanged += assignments.length - (result.rowCount ?? 0);
      }
    }
    console.log(JSON.stringify(summary));
  } finally { if (!dryRun) await client.query('SELECT pg_advisory_unlock(714204, 1)'); client.release(); }
}
main().catch(error => { console.error('[match-patch-materialization]', error instanceof Error ? error.message : 'failed'); process.exitCode = 1; }).finally(() => pool.end());
