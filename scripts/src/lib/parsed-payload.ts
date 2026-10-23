/** Preserve provider observations, including their original time axis.
 * gold_t is earned gold, not an inferred live net-worth series.
 * networth_t is an optional, validated provider observation. Schema 3 remains
 * the core compatibility contract; its presence is never implied by that version.
 */
export const PARSED_PAYLOAD_SCHEMA_VERSION = 3;

type RecordValue = Record<string, unknown>;
const ARRAY_FIELDS = [
  'times', 'gold_t', 'xp_t', 'lh_t', 'dn_t', 'kills_log', 'buyback_log',
  'purchase_log', 'obs_log', 'sen_log', 'obs_left_log', 'sen_left_log',
  'runes_log', 'connection_log', 'neutral_tokens_log', 'neutral_item_history',
  'ability_upgrades_arr',
] as const;
const SCALAR_FIELDS = ['account_id', 'lane_role', 'is_roaming'] as const;
const PERFORMANCE_FIELDS = ['gold_per_min','xp_per_min','last_hits','denies','kills','deaths','assists',
  'hero_damage','tower_damage','hero_healing','obs_placed','sen_placed','observer_kills','sentry_kills','net_worth','level','total_gold','total_xp'] as const;
const CLOCK_FIELDS = ['times', 'gold_t', 'xp_t', 'lh_t', 'dn_t', 'networth_t'] as const;
const SLOTS = new Set([0, 1, 2, 3, 4, 128, 129, 130, 131, 132]);

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

/** Only the provider's own complete series on its own explicit clock is valid.
 * No aliases, final net_worth, inferred timestamps, or cross-refresh alignment.
 * Missing, empty and invalid series remain unavailable (null); observed zero is data.
 */
function networthSeries(player: RecordValue): number[] | null {
  const times = player.times;
  const values = player.networth_t;
  if (!Array.isArray(times) || !Array.isArray(values) || times.length === 0
    || values.length !== times.length) return null;
  for (let i = 0; i < times.length; i++) {
    if (!Number.isSafeInteger(times[i]) || (i > 0 && times[i] <= times[i - 1])
      || !Number.isSafeInteger(values[i]) || values[i] < 0) return null;
  }
  // Net worth may decrease (buybacks, deaths, item sales); monotonicity is not required.
  return values.slice() as number[];
}

export function validParsedPlayers(value: unknown): RecordValue[] | null {
  if (!Array.isArray(value) || value.length !== 10) return null;
  const players = value.map(record);
  if (players.some(p => !p || typeof p.player_slot !== 'number' || !SLOTS.has(p.player_slot)
    || !Number.isSafeInteger(p.hero_id) || Number(p.hero_id) <= 0)) return null;
  const valid = players as RecordValue[];
  if (new Set(valid.map(p => p.player_slot)).size !== 10) return null;
  return valid.sort((a, b) => Number(a.player_slot) - Number(b.player_slot));
}

export function pickParsedPlayer(player: RecordValue): RecordValue {
  return {
    player_slot: player.player_slot, hero_id: player.hero_id,
    ...Object.fromEntries(SCALAR_FIELDS.map(key => [key, player[key] ?? null])),
    ...Object.fromEntries(PERFORMANCE_FIELDS.map(key => [key,
      typeof player[key]==='number' && Number.isFinite(player[key]) && Number(player[key])>=0 ? player[key] : null])),
    ...Object.fromEntries(ARRAY_FIELDS.map(key => [key, Array.isArray(player[key]) ? player[key] : null])),
    networth_t: networthSeries(player),
  };
}

export interface ParsedPayload {
  odVersion: number;
  payloadSchemaVersion: number;
  players: RecordValue[];
  objectives: unknown[] | null;
  teamfights: unknown[] | null;
  draftTimings: unknown[] | null;
}

export function extractParsedPayload(detail: unknown): ParsedPayload | null {
  const data = record(detail);
  if (!data || !Number.isSafeInteger(data.version) || Number(data.version) < 0) return null;
  const players = validParsedPlayers(data.players);
  if (!players) return null;
  // A parsed response with missing optional arrays is still useful. It must
  // not be discarded merely because picks_bans or gold_t are absent.
  return { odVersion: Number(data.version), payloadSchemaVersion: PARSED_PAYLOAD_SCHEMA_VERSION,
    players: players.map(pickParsedPlayer),
    objectives: Array.isArray(data.objectives) ? data.objectives : null,
    teamfights: Array.isArray(data.teamfights) ? data.teamfights : null,
    draftTimings: Array.isArray(data.draft_timings) ? data.draft_timings : null };
}

export function mergeParsedPayload(previous: {
  players?: unknown; objectives?: unknown; teamfights?: unknown; draftTimings?: unknown;
} | null, incoming: ParsedPayload): ParsedPayload {
  const oldPlayers = validParsedPlayers(previous?.players);
  const bySlot = new Map(oldPlayers?.map(p => [p.player_slot, p]) ?? []);
  const players = incoming.players.map(rawPlayer => {
    const player: RecordValue = { ...rawPlayer, networth_t: networthSeries(rawPlayer) };
    const old = bySlot.get(player.player_slot);
    if (!old || old.hero_id !== player.hero_id) return player;
    const merged = { ...old, ...Object.fromEntries(Object.entries(player).filter(([, value]) => value !== null)) };
    // Time-aligned arrays are an indivisible observation. Never attach newly
    // received gold_t to an older times array (or vice versa).
    const hasNewClock = Array.isArray(player.times) && player.times.length > 0;
    const hasOldClock = Array.isArray(old.times) && old.times.length > 0;
    const source = hasNewClock ? player : hasOldClock ? old : null;
    for (const key of CLOCK_FIELDS) {
      merged[key] = key === 'networth_t'
        ? source ? networthSeries(source) : null
        : source ? source[key] ?? null : player[key] ?? old[key] ?? null;
    }
    return merged;
  });
  return { ...incoming, players,
    objectives: incoming.objectives ?? (Array.isArray(previous?.objectives) ? previous.objectives : null),
    teamfights: incoming.teamfights ?? (Array.isArray(previous?.teamfights) ? previous.teamfights : null),
    draftTimings: incoming.draftTimings ?? (Array.isArray(previous?.draftTimings) ? previous.draftTimings : null) };
}
