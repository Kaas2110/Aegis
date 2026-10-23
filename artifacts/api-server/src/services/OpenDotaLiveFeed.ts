import {readProviderFeed, refreshProviderFeed} from './ProviderFeeds';
import {normalizeOpenDotaLiveIds} from '../lib/openDotaLiveIds';
import {liveStateFreshness} from '../lib/liveStateFreshness';
export const LIVE_FEED_TTL_MS = 120_000;
/** Read only: expiry, missing data and user volume never cause an upstream request. */
export async function getOpenDotaLiveFeed() {
  const snapshot = await readProviderFeed('opendota_live');
  if (!snapshot.data || !snapshot.receivedAt) throw new Error(snapshot.error ?? 'background_feed_not_ready');
  const rows=snapshot.data.map(normalizeOpenDotaLiveIds);
  // The read-only UI consumes map objects. Raw durable rows and the collector
  // path remain unfiltered; report omitted non-map rows explicitly to readers.
  const maps=rows.filter((row):row is Record<string,unknown>=>row!==null&&typeof row==='object'&&!Array.isArray(row));
  const malformedRows=rows.length-maps.length;
  return {data:maps.map(row=>({...row,live_freshness:liveStateFreshness(row,snapshot.receivedAt)})),
    receiptDiagnostics:{rawRowCount:rows.length,malformedRowCount:malformedRows,
      reason:malformedRows?'live_packet_not_object':null},
    fetchedAt: new Date(snapshot.receivedAt), error: snapshot.error, attemptedAt: snapshot.attemptedAt};
}
/** Explicit collector operation, used exclusively by LiveWorker. */
export async function refreshOpenDotaLiveFeed() {
  const snapshot = await refreshProviderFeed('opendota_live');
  if (snapshot.error || !snapshot.data || !snapshot.receivedAt) throw new Error(snapshot.error ?? 'background_feed_not_ready');
  return {data: snapshot.data.map(normalizeOpenDotaLiveIds), fetchedAt: new Date(snapshot.receivedAt)};
}
