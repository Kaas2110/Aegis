/**
 * Сервис для чтения/записи глобальных настроек приложения.
 * Single-row таблица app_settings (id=1). При первом обращении строка создаётся
 * с дефолтами. Используется in-memory кешированием для быстрого доступа из
 * горячих путей (популярные рынки, /api/odds/* и т.д.).
 *
 * featureFlags: независимые булевы per-tier per-feature.
 *   { win_probability: { free: false, basic: false, premium: true } }
 * Каждый тир задаётся независимо — нет каскада «минимального тира».
 */

import { db, appSettingsTable, type AppSettings } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger';

export type SubscriptionTier = 'free' | 'basic' | 'premium';
export type MonetizationMode = 'freemium' | 'tiered';

export const FEATURE_KEYS = [
  'win_probability',
  'market_predictions',
  'draft_analysis',
  'backtest',
  'alerts_edge',
  'live_predictions',
] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];

export interface TierAccess {
  free: boolean;
  basic: boolean;
  premium: boolean;
}

export const DEFAULT_TIER_ACCESS: TierAccess = { free: false, basic: false, premium: true };

export const DEFAULT_FEATURE_FLAGS: Record<FeatureKey, TierAccess> = {
  win_probability:    { free: false, basic: false, premium: true },
  market_predictions: { free: false, basic: false, premium: true },
  draft_analysis:     { free: false, basic: false, premium: true },
  backtest:           { free: false, basic: false, premium: true },
  alerts_edge:        { free: false, basic: false, premium: true },
  live_predictions:   { free: false, basic: false, premium: true },
};

export const FEATURE_CATALOG: Array<{ key: FeatureKey; label: string; description: string }> = [
  { key: 'win_probability',    label: 'Вероятность победы',  description: 'Прогноз вероятности победы команды на карточке матча' },
  { key: 'market_predictions', label: 'Рынки прогнозов',     description: 'Первая кровь, тоталы убийств, длительность, форы и т.д.' },
  { key: 'draft_analysis',     label: 'Анализ драфта',       description: 'Разбор пиков и банов, влияние на исход матча' },
  { key: 'backtest',           label: 'Бэктест',             description: 'Историческая equity-кривая и KPI стратегии' },
  { key: 'alerts_edge',        label: 'Алерты по edge',      description: 'Push-уведомления по minConfidence' },
  { key: 'live_predictions',   label: 'Live прогнозы',       description: 'Обновляемые в реальном времени прогнозы по live матчам' },
];

/** Нормализует raw JSON из БД → строгий Record<FeatureKey, TierAccess>.
 *  Поддерживает обратную совместимость: если в БД лежит старый формат
 *  { key: 'premium' } — конвертирует в { free: false, basic: false, premium: true }. */
export function normalizeFeatureFlags(raw: unknown): Record<FeatureKey, TierAccess> {
  const out: Record<FeatureKey, TierAccess> = structuredClone(DEFAULT_FEATURE_FLAGS);
  if (!raw || typeof raw !== 'object') return out;

  const obj = raw as Record<string, unknown>;
  for (const k of FEATURE_KEYS) {
    const v = obj[k];
    if (!v) continue;

    if (typeof v === 'string') {
      // Legacy format: minTier string → convert to independent flags
      const all: TierAccess = { free: false, basic: false, premium: false };
      if (v === 'free')    { all.free = true; all.basic = true; all.premium = true; }
      if (v === 'basic')   { all.basic = true; all.premium = true; }
      if (v === 'premium') { all.premium = true; }
      out[k] = all;
    } else if (typeof v === 'object' && v !== null) {
      const ta = v as Record<string, unknown>;
      out[k] = {
        free:    ta['free']    === true,
        basic:   ta['basic']   === true,
        premium: ta['premium'] === true,
      };
    }
  }
  return out;
}

/**
 * В freemium режиме тира `basic` не существует. Если basic включён для фичи,
 * также включаем premium (пользователь не сможет купить Basic, поэтому доступ
 * basic = доступ premium в freemium). Это не влияет на хранение — только на
 * данные, возвращаемые клиенту через /api/config/monetization.
 */
export function canonicalizeFlagsForMode(
  flags: Record<FeatureKey, TierAccess>,
  mode: MonetizationMode,
): Record<FeatureKey, TierAccess> {
  if (mode !== 'freemium') return flags;
  const out = structuredClone(flags);
  for (const k of FEATURE_KEYS) {
    if (out[k].basic) out[k].premium = true;
  }
  return out;
}

const DEFAULTS: Omit<AppSettings, 'updatedAt'> = {
  id: 1,
  useBookmakerOdds: false,
  liveSnapshotPruneDays: 7,
  trainWindowDays: 365,
  trainMaxPatches: 4,
  trainMinSamples: 1000,
  monetizationMode: 'freemium',
  featureFlags: DEFAULT_FEATURE_FLAGS,
  notes: null,
};

let cache: AppSettings | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000;

export async function getAppSettings(force = false): Promise<AppSettings> {
  const now = Date.now();
  if (!force && cache && now - cacheLoadedAt < CACHE_TTL_MS) return cache;

  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.id, 1))
    .limit(1);

  if (rows.length === 0) {
    await db.insert(appSettingsTable).values(DEFAULTS).onConflictDoNothing();
    const fresh = await db.select().from(appSettingsTable).where(eq(appSettingsTable.id, 1)).limit(1);
    cache = fresh[0] ?? { ...DEFAULTS, updatedAt: new Date() };
  } else {
    cache = rows[0]!;
  }
  cacheLoadedAt = now;
  return cache;
}

export async function updateAppSettings(
  patch: Partial<Pick<AppSettings,
    | 'useBookmakerOdds'
    | 'liveSnapshotPruneDays'
    | 'trainWindowDays'
    | 'trainMaxPatches'
    | 'trainMinSamples'
    | 'monetizationMode'
    | 'featureFlags'
    | 'notes'
  >>,
): Promise<AppSettings> {
  await getAppSettings();
  await db
    .update(appSettingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(appSettingsTable.id, 1));
  cache = null;
  const fresh = await getAppSettings(true);
  logger.info({ patch, settings: fresh }, '[AppSettings] updated');
  return fresh;
}

export function invalidateAppSettingsCache(): void {
  cache = null;
}
