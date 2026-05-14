import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { ProductEvent } from '@/types';

const APP_VERSION = '1.0.0-mvp1';
const EVENTS_KEY = '@dea_product_events';
const TECH_LOGS_KEY = '@dea_tech_logs';
const AUDIT_LOGS_KEY = '@dea_audit_logs';
const UPLOAD_QUEUE_KEY = '@dea_log_upload_queue';
const MAX_STORED_EVENTS = 500;
const MAX_UPLOAD_QUEUE = 1000;
const UPLOAD_INTERVAL_MS = 30_000;
const UPLOAD_BATCH_SIZE = 50;

let currentSessionId = generateId();
let currentAnonymousId = '';
let uploadTimer: ReturnType<typeof setInterval> | null = null;
let apiBaseUrl: string = '';

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
export function startLogUploader(baseUrl: string = ''): void {
  apiBaseUrl = baseUrl.replace(/\/$/, '');
  if (uploadTimer) return;
  uploadTimer = setInterval(() => {
    flushLogQueue().catch(() => { /* silent */ });
  }, UPLOAD_INTERVAL_MS);
}

async function enqueueForUpload(payload: Record<string, unknown>): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(UPLOAD_QUEUE_KEY);
    const queue: Record<string, unknown>[] = raw ? JSON.parse(raw) : [];
    queue.push(payload);
    if (queue.length > MAX_UPLOAD_QUEUE) queue.splice(0, queue.length - MAX_UPLOAD_QUEUE);
    await AsyncStorage.setItem(UPLOAD_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // silent
  }
}

async function flushLogQueue(): Promise<void> {
  // apiBaseUrl='' → relative '/api/client-logs' (works on web/Expo through proxy).
  const raw = await AsyncStorage.getItem(UPLOAD_QUEUE_KEY);
  const queue: Record<string, unknown>[] = raw ? JSON.parse(raw) : [];
  if (queue.length === 0) return;

  const batch = queue.slice(0, UPLOAD_BATCH_SIZE);
  const remaining = queue.slice(UPLOAD_BATCH_SIZE);
  // Сразу удаляем батч из очереди, чтобы при параллельном вызове не отправить
  // его дважды. Если POST упадёт — вернём обратно в начало.
  await AsyncStorage.setItem(UPLOAD_QUEUE_KEY, JSON.stringify(remaining));

  try {
    const resp = await fetch(`${apiBaseUrl}/api/client-logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: batch,
        appVersion: APP_VERSION,
        platform: Platform.OS,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch {
    // Возвращаем батч обратно в очередь (в начало).
    try {
      const raw2 = await AsyncStorage.getItem(UPLOAD_QUEUE_KEY);
      const cur: Record<string, unknown>[] = raw2 ? JSON.parse(raw2) : [];
      const merged = [...batch, ...cur].slice(0, MAX_UPLOAD_QUEUE);
      await AsyncStorage.setItem(UPLOAD_QUEUE_KEY, JSON.stringify(merged));
    } catch { /* silent */ }
  }
}

export async function initLogger(): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem('@dea_anon_id');
    if (stored) {
      currentAnonymousId = stored;
    } else {
      currentAnonymousId = 'anon_' + generateId();
      await AsyncStorage.setItem('@dea_anon_id', currentAnonymousId);
    }
    currentSessionId = 'sess_' + generateId();
  } catch {
    currentAnonymousId = 'anon_' + generateId();
  }
}

export async function logProductEvent(
  eventName: string,
  screenName: string,
  properties?: Record<string, unknown>
): Promise<void> {
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

  try {
    const raw = await AsyncStorage.getItem(EVENTS_KEY);
    const events: ProductEvent[] = raw ? JSON.parse(raw) : [];
    events.push(event);
    if (events.length > MAX_STORED_EVENTS) events.splice(0, events.length - MAX_STORED_EVENTS);
    await AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch {
    // silent fail - logging should never crash the app
  }
  void enqueueForUpload({
    type: 'product',
    eventName,
    screenName,
    timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp),
    sessionId: currentSessionId,
    anonymousId: currentAnonymousId,
    properties,
  });
}

export async function logTechnicalEvent(
  category: string,
  message: string,
  details?: Record<string, unknown>
): Promise<void> {
  const entry = {
    logId: 'tech_' + generateId(),
    category,
    message,
    timestamp: new Date().toISOString(),
    sessionId: currentSessionId,
    platform: Platform.OS,
    details,
  };

  try {
    const raw = await AsyncStorage.getItem(TECH_LOGS_KEY);
    const logs: typeof entry[] = raw ? JSON.parse(raw) : [];
    logs.push(entry);
    if (logs.length > MAX_STORED_EVENTS) logs.splice(0, logs.length - MAX_STORED_EVENTS);
    await AsyncStorage.setItem(TECH_LOGS_KEY, JSON.stringify(logs));
  } catch {
    // silent fail
  }
  void enqueueForUpload({
    type: 'technical',
    category,
    message,
    timestamp: entry.timestamp,
    sessionId: currentSessionId,
    anonymousId: currentAnonymousId,
    details,
  });
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
  const entry = { ...audit, timestamp: new Date().toISOString(), sessionId: currentSessionId };

  try {
    const raw = await AsyncStorage.getItem(AUDIT_LOGS_KEY);
    const logs: typeof entry[] = raw ? JSON.parse(raw) : [];
    logs.push(entry);
    if (logs.length > MAX_STORED_EVENTS) logs.splice(0, logs.length - MAX_STORED_EVENTS);
    await AsyncStorage.setItem(AUDIT_LOGS_KEY, JSON.stringify(logs));
  } catch {
    // silent fail
  }
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
