/** Pure projection of committed journal rows; no query, inference, or publication.
 * The caller supplies the installed evidenceHash and pinned observation schema.
 * Keep this additive to the old 268-feature selector: wide uses 600 s, not 420 s.
 */
export const WIDE_HISTORY_POLICY = 'wide.observed-history.600s.v1';
export interface JournalRow {
  id: string; match_id: number; game_time_sec: number | null;
  input_hash: string; schema_hash: string; input: Record<string, unknown>;
  received_at: string; recorded_at: string;
}
type Hash = (value: unknown) => string;
type Player = { team: number; heroId: number; accountId: number };
type State = { match_id: number; clock_seconds: number; radiant_kills: number;
  dire_kills: number; available_at: number };
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const timestamp = (v: unknown): number => {
  if (typeof v !== 'string' || v.length > 64 || !/(Z|[+-]\d\d:\d\d)$/.test(v)) throw Error('journal_timestamp_invalid');
  const fraction = v.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? '';
  if (/[1-9]/.test(fraction.slice(3))) throw Error('journal_submillisecond_precision_unsupported');
  const t = Date.parse(v); if (!Number.isFinite(t)) throw Error('journal_timestamp_invalid'); return t;
};
function verify(row: JournalRow, schema: string, hash: Hash) {
  if (!row || !digest(row.id) || !digest(row.input_hash) || row.schema_hash !== schema
    || !row.input || hash(row.input) !== row.input_hash) throw Error('journal_source_hash_mismatch');
  const received = timestamp(row.received_at), recorded = timestamp(row.recorded_at);
  if (received > recorded || hash({ contract: schema, inputHash: row.input_hash,
    receivedAt: new Date(received).toISOString() }) !== row.id) throw Error('journal_observation_identity_mismatch');
  if (!integer(row.match_id, 1) || row.input.matchId !== row.match_id
    || row.input.gameTimeSec !== row.game_time_sec) throw Error('journal_denormalized_identity_mismatch');
  return { received, recorded };
}
function roster(row: JournalRow): string | null {
  const p = row.input;
  if (!integer(p.radiantTeamId, 1) || !integer(p.direTeamId, 1) || p.radiantTeamId === p.direTeamId
    || !Array.isArray(p.players) || p.players.length !== 10) return null;
  const players = p.players as Player[];
  if (players.some(x => !x || (x.team !== 0 && x.team !== 1) || !integer(x.heroId, 1) || !integer(x.accountId, 1))
    || players.filter(x => x.team === 0).length !== 5 || new Set(players.map(x => x.heroId)).size !== 10
    || new Set(players.map(x => x.accountId)).size !== 10) return null;
  const pairs = players.map(x => [x.team, x.heroId, x.accountId]).sort((a,b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
  return JSON.stringify([p.radiantTeamId, p.direTeamId, pairs]);
}
function state(row: JournalRow, allowPreStart = false): State | null {
  const p = row.input;
  if (!integer(p.gameTimeSec, allowPreStart ? -3600 : 0) || !integer(p.radiantScore) || !integer(p.direScore)
    || p.synthetic === true || p.backfill === true || p.source === 'synthetic' || p.source === 'backfill') return null;
  return { match_id: row.match_id, clock_seconds: p.gameTimeSec,
    radiant_kills: p.radiantScore, dire_kills: p.direScore, available_at: timestamp(row.received_at)/1000 };
}
const order = (a: JournalRow, b: JournalRow) => timestamp(a.received_at)-timestamp(b.received_at)
  || timestamp(a.recorded_at)-timestamp(b.recorded_at) || a.id.localeCompare(b.id, 'en');

/** Source validity is distinct from freshness/outcome/anchor eligibility.
 * Preserve score/clock regressions for the frozen Python trajectory to reset.
 * Never substitute provider radiantLead for net worth or require it here.
 */
export function selectWideHistory(current: JournalRow, candidates: JournalRow[], schema: string, hash: Hash) {
  if (!digest(schema) || candidates.length > 1024) throw Error('wide_history_contract_limit');
  const cutoff = verify(current, schema, hash), c = state(current), identity = roster(current);
  const excluded: { id: string; reason: string }[] = [];
  const diagnostics = { policy: WIDE_HISTORY_POLICY, candidateCount: candidates.length,
    retainedCount: 0, lookbackGameSeconds: 600, maxHistory: 256, truncated: false,
    sourceIdentityConflict: false, regressionSegments: 0, servingEligibilityAssessed: false, excluded };
  if (!c || !identity) return { status: 'unavailable' as const, reason: !c ? 'current_clock_score_invalid' : 'current_draft_identity_missing',
    current: null, history: [], sourceRows: [], diagnostics };
  const eligible: JournalRow[] = [], seen = new Set<string>();
  for (const row of candidates) {
    const t = verify(row, schema, hash);
    let reason: string | null = null;
    if (row.match_id !== current.match_id) reason = 'different_map';
    else if (t.received > cutoff.received || t.recorded > cutoff.recorded) reason = 'after_current_cutoff';
    else if (row.id === current.id || seen.has(row.id)) reason = 'duplicate_observation';
    else if (!roster(row)) reason = 'missing_draft_identity';
    else if (roster(row) !== identity) { reason = 'changed_draft_or_side_identity'; diagnostics.sourceIdentityConflict = true; }
    else if (!state(row,true)) reason = 'invalid_clock_score';
    if (reason) { excluded.push({ id: row.id, reason }); continue; }
    seen.add(row.id);
    eligible.push(row);
  }
  // A changed complete identity requires a new prior anchor, not a silent join.
  if (diagnostics.sourceIdentityConflict) return { status: 'unavailable' as const,
    reason: 'draft_anchor_revalidation_required', current: c, history: [], sourceRows: [], diagnostics };
  // Audit regression witnesses BEFORE applying the game-clock lower bound.
  // Otherwise 600 -> 100 -> 800 at current900 would hide a genuine reset.
  const lower = Math.max(0,c.clock_seconds-600), rawOrdered = eligible.sort(order);
  let rawPrevious: State | null = null;
  for (const row of rawOrdered) {
    const s=state(row,true) as State;
    if (rawPrevious && (s.clock_seconds < rawPrevious.clock_seconds || s.radiant_kills < rawPrevious.radiant_kills
      || s.dire_kills < rawPrevious.dire_kills) && (s.clock_seconds < lower || rawPrevious.clock_seconds < lower))
      return { status: 'unavailable' as const, reason: 'history_regression_crosses_clock_window',
        current: c, history: [], sourceRows: [], diagnostics };
    rawPrevious=s;
  }
  // Detect genuine regressions BEFORE deduplication. A global DISTINCT ON clock
  // can erase the reset witness in 300 -> 600 -> 300 -> 600.
  const sorted: JournalRow[] = [];
  let segment = new Map<number, JournalRow>(), previous: State | null = null;
  const flush = () => { sorted.push(...segment.values()); segment = new Map(); };
  for (const row of rawOrdered) {
    if ((row.game_time_sec as number) < lower) { excluded.push({ id:row.id,reason:'outside_clock_window' }); continue; }
    const s = state(row) as State;
    if (previous && (s.clock_seconds < previous.clock_seconds || s.radiant_kills < previous.radiant_kills
      || s.dire_kills < previous.dire_kills)) { flush(); diagnostics.regressionSegments++; }
    const prior = segment.get(s.clock_seconds);
    if (prior) excluded.push({ id: prior.id, reason: 'superseded_same_clock_within_forward_segment' });
    segment.set(s.clock_seconds,row); previous=s;
  }
  flush();
  if (sorted.length > 256) {
    diagnostics.truncated = true;
    // Do not claim the unchanged formula retained a witnessed reset after
    // removing source rows needed to express it. A wider-query policy is separate.
    if (diagnostics.regressionSegments > 0) return { status: 'unavailable' as const,
      reason: 'history_regression_evidence_exceeds_capacity', current: c, history: [], sourceRows: [], diagnostics };
    for (const row of sorted.splice(0,sorted.length-256)) excluded.push({ id: row.id, reason: 'history_capacity' });
  }
  diagnostics.retainedCount = sorted.length;
  return { status: 'projected' as const, reason: null, current: c,
    history: sorted.map(row => state(row) as State),
    sourceRows: sorted.map(row => ({ id: row.id, inputHash: row.input_hash, schemaHash: row.schema_hash,
      receivedAt: row.received_at, recordedAt: row.recorded_at })), diagnostics };
}
