import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { ProductEvent } from '@/types';
import { apiFetch } from '../../lib/api';
import { ConsentLogStore } from './ConsentLogStore';

const APP_VERSION = '1.0.0-mvp1';
const EVENTS_KEY = '@dea_product_events';
const TECH_LOGS_KEY = '@dea_tech_logs';
const AUDIT_LOGS_KEY = '@dea_audit_logs';
const UPLOAD_INTERVAL_MS = 30_000;
const consentStore = new ConsentLogStore(AsyncStorage);

let currentSessionId = '';
let currentAnonymousId = '';
let uploadTimer: ReturnType<typeof setInterval> | null = null;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

/**
 * Запускает фоновую отправку логов на сервер (POST /api/client-logs).
 * Каждые 30s пытается слить до 50 событий из очереди в `AsyncStorage`.
 * Если бэкенд отвечает не-2xx — события возвращаются в очередь, чтобы при
 * следующем интервале попробовать снова. На проде даёт единый поток логов
 * (server pino + mobile events) для дебага.
 */
export function startLogUploader(): void {
  if (!consentStore.isEnabled() || uploadTimer) return;
  uploadTimer = setInterval(() => {
    flushLogQueue().catch(() => { /* silent */ });
  }, UPLOAD_INTERVAL_MS);
}

export function stopLogUploader(): void {
  if (uploadTimer) clearInterval(uploadTimer);
  uploadTimer = null;
}

export async function setAnalyticsConsent(enabled: boolean): Promise<void> {
  // Revocation takes effect synchronously, before storage cleanup finishes.
  const changed = consentStore.setConsent(enabled === true);
  if (!enabled) stopLogUploader();
  await changed.catch(()=>{});
  if (enabled && consentStore.isEnabled()) {
    await initLogger();
    startLogUploader();
  }
}

async function flushLogQueue(): Promise<void> {
  await consentStore.flush(async(batch,signal)=>{
    const resp = await apiFetch('/api/client-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        events: batch,
        appVersion: APP_VERSION,
        platform: Platform.OS,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  });
}

export async function initLogger(): Promise<void> {
  try {
   await consentStore.guarded(async current=>{
    const stored = await AsyncStorage.getItem('@dea_anon_id');
    if (!current()) return;
    if (stored) {
      currentAnonymousId = stored;
    } else {
      currentAnonymousId = 'anon_' + generateId();
      await AsyncStorage.setItem('@dea_anon_id', currentAnonymousId);
    }
    currentSessionId = 'sess_' + generateId();
   });
  } catch {
    if (consentStore.isEnabled()) currentAnonymousId = 'anon_' + generateId();
  }
}

export async function logProductEvent(
  eventName: string,
  screenName: string,
  properties?: Record<string, unknown>
): Promise<void> {
  if (!consentStore.isEnabled()) return;
  const event: ProductEvent = {
    eventId: 'evt_' + generateId(),
    eventName,
    anonymousId: currentAnonymousId,
    sessionId: currentSessionId,
    timestamp: new Date(),
    screenName,
    appVersion: APP_VERSION,
    platform: Platform.OS,
    locale: 'ru',
    correlationId: 'corr_' + generateId(),
    matchId: properties?.matchId as string | undefined,
    marketId: properties?.marketId as string | undefined,
    predictionId: properties?.predictionId as string | undefined,
    modelVersion: properties?.modelVersion as string | undefined,
    minOddsFilter: properties?.minOddsFilter as number | undefined,
    minEdgeFilter: properties?.minEdgeFilter as number | undefined,
    minConfidenceFilter: properties?.minConfidenceFilter as number | undefined,
    properties,
  };

  await consentStore.append(EVENTS_KEY,event,{
    type: 'product',
    eventName,
    screenName,
    timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp),
    sessionId: currentSessionId,
    anonymousId: currentAnonymousId,
    properties,
  }).catch(()=>{});
}

export async function logTechnicalEvent(
  category: string,
  message: string,
  details?: Record<string, unknown>
): Promise<void> {
  if (!consentStore.isEnabled()) return;
  const entry = {
    logId: 'tech_' + generateId(),
    category,
    message,
    timestamp: new Date().toISOString(),
    sessionId: currentSessionId,
    platform: Platform.OS,
    details,
  };

  await consentStore.append(TECH_LOGS_KEY,entry,{
    type: 'technical',
    category,
    message,
    timestamp: entry.timestamp,
    sessionId: currentSessionId,
    anonymousId: currentAnonymousId,
    details,
  }).catch(()=>{});
}

export async function logPredictionAudit(audit: {
  predictionId: string;
  matchId: string;
  marketType: string;
  sourceSnapshotId: string;
  featureSnapshotId: string;
  modelVersion: string;
  rawProbability: number;
  calibratedProbability: number;
  marketProbability: number;
  edge: number;
  ev: number;
  confidence: number;
  inputFeaturesJson: Record<string, unknown>;
  explanationJson: Record<string, unknown>;
}): Promise<void> {
  if (!consentStore.isEnabled()) return;
  const entry = { ...audit, timestamp: new Date().toISOString(), sessionId: currentSessionId };
  await consentStore.append(AUDIT_LOGS_KEY,entry).catch(()=>{});
}

export async function getStoredProductEvents(): Promise<ProductEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(EVENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function getStoredTechnicalLogs(): Promise<unknown[]> {
  try {
    const raw = await AsyncStorage.getItem(TECH_LOGS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function getStoredAuditLogs(): Promise<unknown[]> {
  try {
    const raw = await AsyncStorage.getItem(AUDIT_LOGS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
