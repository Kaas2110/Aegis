/** Quality of an observed state, not measured latency of the actual game event. */
export interface LiveDataQuality {
  eligibleForObservedStatePrediction: boolean;
  reason: string | null;
  receivedAt: string | null;
  lastStateChangeReceivedAt: string | null;
  stateAgeSeconds: number | null;
  declaredBroadcastDelaySeconds: number | null;
  measuredEndToEndLatencySeconds: number | null;
  eventLatencyVerified: boolean;
  meetsVerifiedLiveLatencyPolicy: boolean;
  recencyBasis?: string;
  policy?: { maxEventToReceiptSeconds: number; maxLocalStateAgeSeconds: number };
}

export const LOCAL_STATE_MAX_AGE_SECONDS = 180;
export const EVENT_DELAY_MAX_SECONDS = 300;
const finiteNonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const timestamp = (v: unknown): number | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;

/** JSON may be absent on an older backend. Absence never implies freshness. */
export function readLiveDataQuality(raw: unknown): LiveDataQuality | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const q = raw as Record<string, unknown>;
  const latency = finiteNonnegative(q.measuredEndToEndLatencySeconds) ? q.measuredEndToEndLatencySeconds : null;
  const eventVerified = q.eventLatencyVerified === true && latency !== null;
  const policy = q.policy as Record<string, unknown> | undefined;
  return {
    eligibleForObservedStatePrediction: q.eligibleForObservedStatePrediction === true,
    reason: typeof q.reason === 'string' ? q.reason : null,
    receivedAt: timestamp(q.receivedAt) !== null ? q.receivedAt as string : null,
    lastStateChangeReceivedAt: timestamp(q.lastStateChangeReceivedAt) !== null ? q.lastStateChangeReceivedAt as string : null,
    stateAgeSeconds: finiteNonnegative(q.stateAgeSeconds) ? q.stateAgeSeconds : null,
    declaredBroadcastDelaySeconds: finiteNonnegative(q.declaredBroadcastDelaySeconds) ? q.declaredBroadcastDelaySeconds : null,
    measuredEndToEndLatencySeconds: latency,
    eventLatencyVerified: eventVerified,
    meetsVerifiedLiveLatencyPolicy: eventVerified && q.meetsVerifiedLiveLatencyPolicy === true,
    recencyBasis: typeof q.recencyBasis === 'string' ? q.recencyBasis : undefined,
    policy: policy && finiteNonnegative(policy.maxEventToReceiptSeconds) && finiteNonnegative(policy.maxLocalStateAgeSeconds)
      ? {maxEventToReceiptSeconds: policy.maxEventToReceiptSeconds, maxLocalStateAgeSeconds: policy.maxLocalStateAgeSeconds} : undefined,
  };
}

/** New HTTP responses do not reset state age. The absolute state-change clock ages offline too. */
export function observedStateAge(q: LiveDataQuality | undefined, now = Date.now()): number | null {
  const changed = timestamp(q?.lastStateChangeReceivedAt);
  if (changed === null || changed > now + 5000) return null;
  return Math.max(0, (now - changed) / 1000, q?.stateAgeSeconds ?? 0);
}

export function observedLiveStateEligible(q: LiveDataQuality | undefined, now = Date.now()): boolean {
  const age = observedStateAge(q, now), receipt = timestamp(q?.receivedAt), changed = timestamp(q?.lastStateChangeReceivedAt);
  const maxAge = Math.min(LOCAL_STATE_MAX_AGE_SECONDS, q?.policy?.maxLocalStateAgeSeconds ?? LOCAL_STATE_MAX_AGE_SECONDS);
  const maxDelay = Math.min(EVENT_DELAY_MAX_SECONDS, q?.policy?.maxEventToReceiptSeconds ?? EVENT_DELAY_MAX_SECONDS);
  return q?.eligibleForObservedStatePrediction === true && q.reason === null
    && age !== null && age < maxAge && receipt !== null && changed !== null && changed <= receipt
    && receipt <= now + 5000 && now - receipt < maxAge * 1000
    && (q.declaredBroadcastDelaySeconds === null || q.declaredBroadcastDelaySeconds <= maxDelay);
}

/** Do not infer alignment of bookmaker event time from a recent API response. */
export function liveValueComparisonAllowed(q: LiveDataQuality | undefined, alignmentVerified: unknown, now = Date.now()): boolean {
  return observedLiveStateEligible(q, now) && q?.eventLatencyVerified === true
    && q.meetsVerifiedLiveLatencyPolicy === true && alignmentVerified === true
    && finiteNonnegative(q.measuredEndToEndLatencySeconds)
    && q.measuredEndToEndLatencySeconds <= EVENT_DELAY_MAX_SECONDS;
}

type QualityMatch = {source?: string; status: string; liveDataQuality?: LiveDataQuality};
export function matchStatePredictionEligible(match: QualityMatch, now = Date.now()): boolean {
  return match.status !== 'live' || observedLiveStateEligible(match.liveDataQuality, now);
}

/** Keep a real bookmaker's lines/prices while withholding stale model probabilities. */
export function guardLiveTotals<T extends {
  lineSource?: string; lines: Array<{pOver: number | null; pUnder: number | null; pPush: number | null}>;
  expectedValue: number | null; interval: unknown; projection: unknown;
}>(data: T | null, status: string, q: LiveDataQuality | undefined, now = Date.now()): T | null {
  if (!data || status !== 'live' || observedLiveStateEligible(q, now)) return data;
  const bookmaker = data.lineSource === 'bookmaker';
  return {...data, lines: bookmaker ? data.lines.map(r => ({...r, pOver:null, pUnder:null, pPush:null})) : [],
    expectedValue:null, interval:null, projection:null, confidence:null, liveSource:false,
    unavailable:!bookmaker, unavailableReason:'Прогноз недоступен',
    modelUnavailable:true, modelUnavailableReason:'Прогноз недоступен'};
}
