/** One upstream read serves both the collector and every connected UI. */
export interface LiveFeedSnapshot {
  data: Record<string, unknown>[];
  fetchedAt: Date;
}

export function createLiveFeedCache(
  read: () => Promise<unknown>,
  now: () => number = Date.now,
  ttlMs = 120_000,
  failureCooldownMs = 30_000,
) {
  let cached: LiveFeedSnapshot | undefined;
  let pending: Promise<LiveFeedSnapshot> | undefined;
  let failedUntil = 0;
  let lastError: Error | undefined;
  return async (): Promise<LiveFeedSnapshot> => {
    const time = now();
    if (cached && time - cached.fetchedAt.getTime() < ttlMs) return cached;
    if (pending) return pending;
    if (failedUntil > time) throw lastError;
    pending = (async () => {
      try {
        const payload = await read();
        if (!Array.isArray(payload) || payload.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
          throw new Error('OpenDota live returned an invalid payload');
        }
        cached = {data: payload, fetchedAt: new Date(now())};
        failedUntil = 0;
        lastError = undefined;
        return cached;
      } catch {
        lastError = new Error('OpenDota live is temporarily unavailable');
        failedUntil = now() + failureCooldownMs;
        // Never relabel an old snapshot as freshly received after an error.
        throw lastError;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
