function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function isPlayerSlot(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && ((value >= 0 && value <= 4) || (value >= 128 && value <= 132));
}

/**
 * Require the explicit FIRSTBLOOD objective and corroborating killer event.
 * No winner proxy, fuzzy timestamp matching, or guessing from an ambiguous slot.
 * Negative/zero game time is valid: first blood can occur before the horn.
 */
export function firstBloodRadiantLabel(objectives: unknown, players: unknown): 0 | 1 | null {
  if (!Array.isArray(objectives) || !Array.isArray(players)) return null;
  const events = objectives.map(record).filter(event => event?.type === 'CHAT_MESSAGE_FIRSTBLOOD');
  if (events.length !== 1) return null;
  const event = events[0]!;
  const slot = event.player_slot;
  const time = event.time;
  if (!isPlayerSlot(slot) || typeof time !== 'number' || !Number.isFinite(time)) return null;
  // OpenDota's ordinary slot is 0..9, unlike player_slot's 0..4/128..132.
  if (event.slot != null && event.slot !== (slot < 128 ? slot : slot - 123)) return null;
  const matchingPlayers = players.map(record).filter(player => player?.player_slot === slot);
  if (matchingPlayers.length !== 1) return null;
  const logs = matchingPlayers[0]!.kills_log;
  if (!Array.isArray(logs) || !logs.some(value => record(value)?.time === time)) return null;
  return slot < 128 ? 1 : 0;
}
