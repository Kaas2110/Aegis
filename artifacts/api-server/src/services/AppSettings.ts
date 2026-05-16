/**
 * Сервис для чтения/записи глобальных настроек приложения.
 * Single-row таблица app_settings (id=1). При первом обращении строка создаётся
 * с дефолтами. Используется in-memory кешированием для быстрого доступа из
 * горячих путей (популярные рынки, /api/odds/* и т.д.).
 */

import { db, appSettingsTable, type AppSettings } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger';

const DEFAULTS: Omit<AppSettings, 'updatedAt'> = {
  id: 1,
  useBookmakerOdds: false,
  liveSnapshotPruneDays: 7,
  trainWindowDays: 365,
  trainMaxPatches: 4,
  trainMinSamples: 1000,
  notes: null,
  monetizationMode: null,
  featureFlags: null,
  storeSettings: null,
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
