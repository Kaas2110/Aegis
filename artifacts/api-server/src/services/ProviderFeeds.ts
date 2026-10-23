import {pool} from '@workspace/db';
import {openDotaBackgroundFetch, openDotaLiveFetch, OdQuotaExhaustedError} from '@workspace/db/opendota';
import {createBackgroundFeed, type FeedSnapshot} from '../lib/backgroundFeed';
import {fetchStratzLiveListObserved} from '../lib/stratzLiveList';
import {writeStratzLiveListEvidence} from '../lib/stratzLiveListEvidence';
import {getApiKey} from './ApiKeysService';
import {annotateLiveState} from '../lib/liveStateFreshness';
import {logger} from '../lib/logger';
import {ProviderFeedHttpError, ProviderFeedPayloadError, ProviderFeedQuotaError} from '../lib/providerFeedError';

export type ProviderFeedKey = 'opendota_live' | 'pandascore_running' | 'pandascore_upcoming' | 'stratz_live' | 'heroes' | 'hero_stats' | 'odds_api_dota2' | 'odds_api_sports';
export const FEED_INTERVALS: Record<ProviderFeedKey, number> = {
  opendota_live: 120_000, pandascore_running: 120_000, pandascore_upcoming: 300_000,
  stratz_live: 120_000, heroes: 86_400_000, hero_stats: 3_600_000,
  odds_api_dota2: 3_600_000, odds_api_sports: 86_400_000,
};
const keys = Object.keys(FEED_INTERVALS) as ProviderFeedKey[];
// This separate paid-quota integration is never enabled merely by opening a page.
export function providerFeedIsEnabled(key: ProviderFeedKey): boolean {
  return !key.startsWith('odds_api_') || (process.env.ODDS_API_BACKGROUND_ENABLED === 'true' && Boolean(getApiKey('ODDS_API_KEY')));
}
async function jsonArray(url: string, provider: 'od' | 'live' | 'ps') {
  const headers: Record<string,string> = {'User-Agent':'DotaEdgeAnalyzer/1.0','Accept':'application/json'};
  if (provider === 'ps') {
    const token = getApiKey('PANDASCORE_API_KEY');
    if (!token) throw new Error('PandaScore key unavailable');
    headers.Authorization = 'Bearer ' + token;
  }
  let response: Response;
  try {
    response = await (provider === 'live' ? openDotaLiveFetch : provider === 'od' ? openDotaBackgroundFetch : fetch)(url, {headers, signal: AbortSignal.timeout(20_000)});
  } catch (error) {
    if (error instanceof OdQuotaExhaustedError) {
      if (error.reason === 'upstream_429') throw new ProviderFeedHttpError(429);
      if (error.reason === 'upstream_403') throw new ProviderFeedHttpError(403);
      throw new ProviderFeedQuotaError();
    }
    throw error;
  }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ProviderFeedHttpError(response.status); }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new ProviderFeedPayloadError();
  return data;
}
async function collect(key: ProviderFeedKey): Promise<unknown[]> {
  if (!providerFeedIsEnabled(key)) throw new Error('Background source disabled');
  switch(key) {
    case 'odds_api_dota2':
    case 'odds_api_sports': {
      const url = new URL(key === 'odds_api_dota2' ? 'https://api.the-odds-api.com/v4/sports/esports_dota2/odds/' : 'https://api.the-odds-api.com/v4/sports/');
      url.searchParams.set('apiKey', getApiKey('ODDS_API_KEY')!);
      if (key === 'odds_api_dota2') {
        url.searchParams.set('regions','eu,us,uk');url.searchParams.set('markets','h2h');
        url.searchParams.set('oddsFormat','decimal');url.searchParams.set('dateFormat','iso');
      }
      const response = await fetch(url, {signal: AbortSignal.timeout(20_000)});
      if (!response.ok) {await response.body?.cancel().catch(()=>{});throw new ProviderFeedHttpError(response.status);}
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new ProviderFeedPayloadError();
      return data;
    }
    case 'opendota_live': return jsonArray('https://api.opendota.com/api/live', 'live');
    case 'heroes': return jsonArray('https://api.opendota.com/api/heroes', 'od');
    case 'hero_stats': return jsonArray('https://api.opendota.com/api/heroStats', 'od');
    case 'pandascore_running': return jsonArray('https://api.pandascore.co/dota2/matches/running?page[size]=20', 'ps');
    case 'pandascore_upcoming': return jsonArray('https://api.pandascore.co/dota2/matches/upcoming?page[size]=20&sort=begin_at&filter[status]=not_started', 'ps');
    case 'stratz_live': {
      const token = getApiKey('STRATZ_TOKEN');
      if (!token) throw new Error('STRATZ key unavailable');
      const observation=await fetchStratzLiveListObserved(token);
      try {
        await writeStratzLiveListEvidence((text,values)=>pool.query(text,values),observation.evidence);
      } catch {
        // Keep the existing public feed functional, but never report durable evidence success.
        // No retry: the upstream call already consumed its shared quota reservation.
        logger.warn({key,reason:'stratz_list_evidence_persist_failed',observationId:observation.evidence.id},'[ProviderFeed] evidence unavailable');
      }
      return observation.matches;
    }
  }
}
const feeds = new Map(keys.map(key => [key, createBackgroundFeed<unknown[]>({
  async load() {
    const result = await pool.query('SELECT payload, received_at, attempted_at, last_error FROM provider_feed_snapshots WHERE key=$1', [key]);
    const row = result.rows[0];
    return row ? {data: row.payload, receivedAt: row.received_at?.toISOString() ?? null, attemptedAt: row.attempted_at?.toISOString() ?? null, error: row.last_error} : null;
  },
  async save(value) {
    await pool.query(
      'INSERT INTO provider_feed_snapshots(key,payload,received_at,attempted_at,last_error) VALUES($1,$2,$3,$4,$5) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,received_at=excluded.received_at,attempted_at=excluded.attempted_at,last_error=excluded.last_error',
      [key, JSON.stringify(value.data), value.receivedAt, value.attemptedAt, value.error]);
  },
}, () => collect(key), Date.now, (data,previous,receivedAt)=>
  key==='opendota_live'?annotateLiveState(data,previous,receivedAt):data,
  error=>logger.warn({key,...error}, '[ProviderFeed] refresh failed'))]));
export function readProviderFeed(key: ProviderFeedKey): Promise<FeedSnapshot<unknown[]>> { return feeds.get(key)!.read(); }
/** Worker entry point. Never call from an HTTP request handler. */
export function refreshProviderFeed(key: ProviderFeedKey): Promise<FeedSnapshot<unknown[]>> { return feeds.get(key)!.refresh(); }
