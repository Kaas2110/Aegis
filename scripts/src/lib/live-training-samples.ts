export interface LiveSampleTime {
  matchId: number;
  gameTimeSec: number;
  source: string;
}

/** Pick at most one real observation per match/time even if windows overlap. */
export function selectLiveBucketSnapshots<T extends LiveSampleTime>(rows: T[], centersMin: readonly number[], toleranceSec = 180): T[] {
  const byMatch = new Map<number, T[]>();
  for (const row of rows) {
    if (row.source !== 'live' || !Number.isFinite(row.gameTimeSec) || row.gameTimeSec < 60) continue;
    const list = byMatch.get(row.matchId) ?? [];
    list.push(row);
    byMatch.set(row.matchId, list);
  }
  const out: T[] = [];
  for (const list of byMatch.values()) {
    list.sort((a, b) => a.gameTimeSec - b.gameTimeSec);
    const selectedTimes = new Set<number>();
    for (const center of centersMin) {
      let best: T | undefined;
      let bestDistance = Infinity;
      for (const row of list) {
        const distance = Math.abs(row.gameTimeSec - center * 60);
        if (distance < bestDistance) { best = row; bestDistance = distance; }
      }
      if (best && bestDistance <= toleranceSec && !selectedTimes.has(best.gameTimeSec)) {
        selectedTimes.add(best.gameTimeSec);
        out.push(best);
      }
    }
  }
  return out.sort((a, b) => a.matchId - b.matchId || a.gameTimeSec - b.gameTimeSec);
}
