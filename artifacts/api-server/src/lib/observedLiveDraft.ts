/** A live roster proves selected heroes, not ban history or draft chronology. */
export function observedLiveDraft(raw: Record<string, unknown>, names: Map<number,string>, fetchedAt: string) {
  if (raw.between_maps === true || !Array.isArray(raw.players)) return null;
  const players = raw.players as Record<string, unknown>[];
  if (players.length !== 10 || players.some(p => !p || !Number.isSafeInteger(p.hero_id)
      || Number(p.hero_id) <= 0 || (p.team !== 0 && p.team !== 1))) return null;
  if (new Set(players.map(p=>p.hero_id)).size !== 10 || players.filter(p=>p.team===0).length !== 5) return null;
  return {
    picks: players.map(p=>({heroId:Number(p.hero_id),heroName:names.get(Number(p.hero_id))??`Hero #${p.hero_id}`,
      side:p.team===0?'radiant' as const:'dire' as const,order:null})),
    bans: [], source:'opendota' as const, fetchedAt,
    orderKnown:false, bansKnown:false, basis:'observed_live_lineup' as const,
  };
}
