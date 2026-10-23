import type { AnalyticsResult, MatchInput } from './AnalyticsEngine';
import { openDotaMatchId, positiveId } from './PredictionContract';

/** Only metadata is returned. Outcome values never enter a prediction request. */
export const SERVING_OUTCOME_SQL = `WITH latest_live_identity AS (
 SELECT radiant_team_id::text AS radiant_team_id,dire_team_id::text AS dire_team_id
 FROM live_snapshots WHERE match_id=$1 AND source='live'
 ORDER BY captured_at DESC,id DESC LIMIT 1
)
SELECT
 (EXISTS(SELECT 1 FROM pro_matches p WHERE p.match_id=$1
   AND p.radiant_win IS NOT NULL AND p.duration>0)
 OR EXISTS(SELECT 1 FROM live_journal_outcomes o WHERE o.match_id=$1)) AS known,
 (SELECT radiant_team_id FROM latest_live_identity) AS radiant_team_id,
 (SELECT dire_team_id FROM latest_live_identity) AS dire_team_id`;

export interface ServingOutcomeClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}
export interface ServingOutcomePool {
  connect(): Promise<ServingOutcomeClient>;
}
export type ServingOutcomeMetadata = {
  known: boolean;
  radiantTeamId: number | null;
  direTeamId: number | null;
};
export type ServingOutcomeRefusal =
  | 'map_identity_unresolved'
  | 'map_outcome_check_unavailable'
  | 'map_outcome_already_known'
  | 'map_outcome_known_before_response'
  | 'map_team_identity_unconfirmed'
  | 'map_team_identity_changed_before_response';

/** Separate transactions before/after calculation: no long-lived stale snapshot. */
export async function readServingOutcomeMetadata(
  pool: ServingOutcomePool,
  matchId: number,
): Promise<ServingOutcomeMetadata | null> {
  if (positiveId(matchId) !== matchId) return null;
  let client: ServingOutcomeClient | undefined;
  let begun = false;
  let destroy = false;
  let verdict: ServingOutcomeMetadata | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    begun = true;
    await client.query("SET LOCAL statement_timeout='2000ms'");
    await client.query("SET LOCAL lock_timeout='500ms'");
    const result = await client.query(SERVING_OUTCOME_SQL, [matchId]);
    const row = result.rows[0];
    if (result.rows.length === 1 && row && typeof row.known === 'boolean') {
      verdict = {
        known: row.known,
        radiantTeamId: positiveId(row.radiant_team_id),
        direTeamId: positiveId(row.dire_team_id),
      };
    }
  } catch {
    verdict = null;
  } finally {
    if (client) {
      if (begun) {
        try { await client.query('ROLLBACK'); } catch { verdict = null; destroy = true; }
      }
      try { client.release(destroy); } catch { verdict = null; }
    }
  }
  return verdict;
}

function unavailable(input: MatchInput): AnalyticsResult {
  return {
    matchId: input.matchId, team1Name: input.team1.name, team2Name: input.team2.name,
    predictions: [], featureVector: null, generatedAt: new Date().toISOString(),
    modelVersion: 'unavailable', state: 'unavailable',
    unavailableMarkets: [{ betType: 'all', reason: 'Прогноз недоступен' }],
    resolvedTeams: { team1Id: positiveId(input.team1.teamId), team2Id: positiveId(input.team2.teamId) },
    teamIdentity: { team1: input.team1.identity ?? null, team2: input.team2.identity ?? null },
  };
}

function matchesTeams(meta: ServingOutcomeMetadata, input: MatchInput): boolean {
  const a = positiveId(input.team1.teamId), b = positiveId(input.team2.teamId);
  const r = meta.radiantTeamId, d = meta.direTeamId;
  return a !== null && b !== null && a !== b && r !== null && d !== null && r !== d
    && ((a === r && b === d) || (a === d && b === r));
}

/**
 * Wrap the real computation/result acquisition; do not cache the guard verdict.
 * Real OD map IDs are parsed by the existing namespace-aware contract. Bare
 * PandaScore/numeric IDs never become OD IDs here. A team-vs-team hypothetical
 * prematch with no real map ID preserves its existing path and series semantics.
 */
export async function guardServingMapOutcome(
  pool: ServingOutcomePool,
  input: MatchInput,
  compute: () => Promise<AnalyticsResult>,
  onRefusal: (reason: ServingOutcomeRefusal) => void,
): Promise<AnalyticsResult> {
  const refuse = (reason: ServingOutcomeRefusal): AnalyticsResult => {
    try { onRefusal(reason); } catch { /* Logging cannot enable a refused prediction. */ }
    return unavailable(input);
  };
  const matchId = openDotaMatchId(input);
  if (matchId === null) {
    const claimsMap = input.matchSource === 'opendota' || /^od_/.test(String(input.matchId));
    if (claimsMap || input.status === 'live' || input.liveSnapshot)
      return refuse('map_identity_unresolved');
    return compute();
  }
  const before = await readServingOutcomeMetadata(pool, matchId);
  if (before === null) return refuse('map_outcome_check_unavailable');
  if (before.known) return refuse('map_outcome_already_known');
  if (!matchesTeams(before, input)) return refuse('map_team_identity_unconfirmed');
  const result = await compute();
  const after = await readServingOutcomeMetadata(pool, matchId);
  if (after === null) return refuse('map_outcome_check_unavailable');
  if (after.known) return refuse('map_outcome_known_before_response');
  if (!matchesTeams(after, input)
    || after.radiantTeamId !== before.radiantTeamId || after.direTeamId !== before.direTeamId)
    return refuse('map_team_identity_changed_before_response');
  return result;
}
