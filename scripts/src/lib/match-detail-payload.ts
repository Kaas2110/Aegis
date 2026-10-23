import { extractParsedPayload, validParsedPlayers } from './parsed-payload';

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> =>
    row !== null && typeof row === 'object' && !Array.isArray(row)) : [];
}

export function prepareMatchDetail(value: unknown, matchId: number) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid match detail object');
  const detail = value as Record<string, unknown>;
  if (detail.match_id !== matchId) throw new Error('Provider returned a different match ID');
  const actions = records(detail.picks_bans).filter(p => (p.team === 0 || p.team === 1)
    && Number.isSafeInteger(p.hero_id) && Number(p.hero_id) > 0 && Number.isSafeInteger(p.order));
  const picks = actions.filter(p => p.is_pick === true).sort((a, b) => Number(a.order) - Number(b.order));
  const radiantPicks = picks.filter(p => p.team === 0).map(p => Number(p.hero_id));
  const direPicks = picks.filter(p => p.team === 1).map(p => Number(p.hero_id));
  const validDraft = radiantPicks.length === 5 && direPicks.length === 5 && new Set([...radiantPicks, ...direPicks]).size === 10;
  const players = validParsedPlayers(detail.players) ?? [];
  const accounts = (heroes: number[], radiant: boolean) => heroes.map(hero => {
    const player = players.find(p => p.hero_id === hero && (Number(p.player_slot) < 128) === radiant);
    const id = player?.account_id;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id < 4294967295 ? id : 0;
  });
  return {
    draft: validDraft ? { radiantPicks, direPicks,
      radiantBans: actions.filter(p => p.is_pick === false && p.team === 0).map(p => Number(p.hero_id)),
      direBans: actions.filter(p => p.is_pick === false && p.team === 1).map(p => Number(p.hero_id)),
      radiantAccountIds: accounts(radiantPicks, true), direAccountIds: accounts(direPicks, false) } : null,
    parsed: extractParsedPayload(detail),
    firstBloodTime: Number.isSafeInteger(detail.first_blood_time) ? Number(detail.first_blood_time) : null,
  };
}
