import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { ProductEvent } from '@/types';

const APP_VERSION = '1.0.0-mvp1';
const EVENTS_KEY = '@dea_product_events';
const TECH_LOGS_KEY = '@dea_tech_logs';
const AUDIT_LOGS_KEY = '@dea_audit_logs';
const MAX_STORED_EVENTS = 500;

let currentSessionId = generateId();
let currentAnonymousId = '';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
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
