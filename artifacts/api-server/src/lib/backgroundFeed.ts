
import {classifyProviderFeedError, type SafeProviderFeedError} from './providerFeedError';
export interface FeedSnapshot<T> {
  data: T | null;
  receivedAt: string | null;
  attemptedAt: string | null;
  error: string | null;
}
export interface FeedStore<T> {
  load(): Promise<FeedSnapshot<T> | null>;
  save(value: FeedSnapshot<T>): Promise<void>;
}
/** Reading (even after expiry) never invokes the collector. Only a worker may refresh. */
export function createBackgroundFeed<T>(store: FeedStore<T>, collect: () => Promise<T>, now = Date.now,
  transform: (data:T,previous:T|null,receivedAt:string)=>T = data=>data,
  onError?: (error: SafeProviderFeedError) => void) {
  let value: FeedSnapshot<T> | null = null;
  let loading: Promise<void> | null = null;
  let running: Promise<FeedSnapshot<T>> | null = null;
  async function hydrate() {
    if (!loading) loading = store.load().then(v => { value = v; }).catch(err => { loading = null; throw err; });
    await loading;
  }
  async function read(): Promise<FeedSnapshot<T>> {
    await hydrate();
    return structuredClone(value ?? {data: null, receivedAt: null, attemptedAt: null, error: 'background_feed_not_ready'});
  }
  async function refresh(): Promise<FeedSnapshot<T>> {
    if (running) return running;
    running = (async () => {
      await hydrate(); // Do not consume quota when the durable store is unavailable.
      const attemptedAt = new Date(now()).toISOString();
      let next: FeedSnapshot<T>;
      try {
        const data = await collect();
        const receivedAt=new Date(now()).toISOString();
        next = {data:transform(data,value?.data??null,receivedAt), receivedAt, attemptedAt, error: null};
      } catch (error) {
        // A diagnostics sink must never change retained data or turn failure into success.
        try { onError?.(classifyProviderFeedError(error)); } catch { /* Diagnostics only. */ }
        // Never replace a valid snapshot with an invented empty success or leak a token in errors.
        next = {...(value ?? {data: null, receivedAt: null}), attemptedAt, error: 'upstream_temporarily_unavailable'};
      }
      await store.save(next);
      value = next;
      return structuredClone(next);
    })().finally(() => { running = null; });
    return running;
  }
  return {read, refresh};
}
export function feedIsStale(snapshot: FeedSnapshot<unknown>, maxAgeMs: number, now = Date.now()): boolean {
  return snapshot.receivedAt === null || now - Date.parse(snapshot.receivedAt) >= maxAgeMs || snapshot.error !== null;
}
