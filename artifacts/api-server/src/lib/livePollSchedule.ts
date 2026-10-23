export const DEFAULT_LIVE_INTERVAL_MS = 120_000;
export const DEFAULT_IDLE_INTERVAL_MS = 600_000;
export const MAX_LIVE_BACKOFF_MS = 600_000;
export type LivePollMode = 'unknown' | 'live' | 'idle';

/** Unknown is not a successful empty feed: it must not select the cold idle interval. */
export function livePollMode(lastSuccessfulCount: number | null): LivePollMode {
  return lastSuccessfulCount === null ? 'unknown' : lastSuccessfulCount > 0 ? 'live' : 'idle';
}
export function livePollBaseIntervalMs(lastSuccessfulCount: number | null,
  liveMs = DEFAULT_LIVE_INTERVAL_MS, idleMs = DEFAULT_IDLE_INTERVAL_MS): number {
  const mode = livePollMode(lastSuccessfulCount);
  const configured = mode === 'idle' ? idleMs : liveMs;
  const fallback = mode === 'idle' ? DEFAULT_IDLE_INTERVAL_MS : DEFAULT_LIVE_INTERVAL_MS;
  return Math.max(Number.isFinite(configured) && configured > 0 ? configured : fallback, DEFAULT_LIVE_INTERVAL_MS);
}
export function livePollFailureBackoffMs(previous: number): number {
  return Math.min(Math.max(previous, DEFAULT_LIVE_INTERVAL_MS) * 2, MAX_LIVE_BACKOFF_MS);
}
export function livePollNextDelayMs(baseMs: number, backoffMs: number): number {
  return Math.max(baseMs, backoffMs);
}


/** Poll cadence is independent of state freshness and inference admission.
 * An incomplete, paused, stale or malformed identified map can still be running.
 * Only a local result or a valid past provider deactivation closes a candidate.
 * Conflicting duplicate packets stay active unless a local outcome is known.
 */
export function livePollActivity(
  candidates:ReadonlyArray<{matchId:number;deactivateTime?:unknown}>,
  knownFinishedIds:ReadonlySet<number>,receivedAtMs:number,
) {
  const byMap=new Map<number,boolean>();
  for(const candidate of candidates){
    const ended=candidate.deactivateTime;
    const inactive=typeof ended==='number'&&Number.isSafeInteger(ended)&&ended>0
      &&Number.isFinite(receivedAtMs)&&ended<=receivedAtMs/1000;
    byMap.set(candidate.matchId,(byMap.get(candidate.matchId)??false)||!inactive);
  }
  const activeMatchIds:number[]=[];
  let knownFinishedMaps=0,providerInactiveMaps=0;
  for(const [id,possiblyActive] of byMap){
    if(knownFinishedIds.has(id))knownFinishedMaps++;
    else if(possiblyActive)activeMatchIds.push(id);
    else providerInactiveMaps++;
  }
  return {activeMatchIds,identifiedMaps:byMap.size,knownFinishedMaps,providerInactiveMaps};
}
