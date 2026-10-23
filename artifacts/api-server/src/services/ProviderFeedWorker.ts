import {FEED_INTERVALS, providerFeedIsEnabled, readProviderFeed, refreshProviderFeed, type ProviderFeedKey} from './ProviderFeeds';
import {logger} from '../lib/logger';

// OpenDota live belongs to LiveWorker (120 s active / 600 s idle), not this timer.
const keys: ProviderFeedKey[] = ['pandascore_running','pandascore_upcoming','stratz_live','heroes','hero_stats','odds_api_dota2','odds_api_sports'];
let timer: NodeJS.Timeout | null = null;
let stopped = false;
export function startProviderFeedWorker() {
  if (timer || stopped || process.env.DISABLE_PROVIDER_FEED_WORKER === 'true') return;
  async function tick() {
    try {
      for (const key of keys) {
        if (stopped) break;
        if (!providerFeedIsEnabled(key)) continue;
        const previous = await readProviderFeed(key);
        const last = previous.attemptedAt ? Date.parse(previous.attemptedAt) : 0;
        // Failed reference feeds retry within five minutes; never on a user's request.
        const interval = previous.error && !key.startsWith('odds_api_') ? Math.min(FEED_INTERVALS[key], 300_000) : FEED_INTERVALS[key];
        if (Date.now() - last < interval) continue;
        const result = await refreshProviderFeed(key);
        logger.info({key, receivedAt: result.receivedAt, error: result.error}, '[ProviderFeedWorker] refresh completed');
      }
    } catch (err) { logger.error({err}, '[ProviderFeedWorker] durable store unavailable'); }
    if (!stopped) timer = setTimeout(tick, 30_000);
  }
  timer = setTimeout(tick, 1_000);
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
