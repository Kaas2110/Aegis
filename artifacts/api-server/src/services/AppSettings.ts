/**
 * Сервис для чтения/записи глобальных настроек приложения.
 * Single-row таблица app_settings (id=1). При первом обращении строка создаётся
 * с дефолтами. Используется in-memory кешированием для быстрого доступа из
 * горячих путей (популярные рынки, /api/odds/* и т.д.).
 */

import { db, appSettingsTable, type AppSettings } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { setOdRuntimeConfig } from '../lib/openDotaUrl';

const DEFAULTS: Omit<AppSettings, 'updatedAt'> = {
  id: 1,
  useBookmakerOdds: true,
  liveSnapshotPruneDays: 7,
  trainWindowDays: 365,
  trainMaxPatches: 4,
  trainMinSamples: 1000,
  minTeamRating: 1200,
  liveWorkerLiveSec: 30,
  liveWorkerIdleSec: 300,
  liveWorkerUpcomingWindowMin: 10,
  bookmakerLiveSec: 180,
  bookmakerUpcomingSec: 30,
  bookmakerIdleSec: 3600,
  schedulerTickHours: 24,
  mobilePollLiveSec: 60,
  mobilePollIdleSec: 120,
  opendotaPremium: null,
  odDailyLimit: 3000,
  notes: null,
  promoFieldEnabled: false,
  refRedirectUrl: null,
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
  // Пуш runtime-конфига OpenDota в sync-хелпер (hot-reload тогла из админки).
  setOdRuntimeConfig({ premium: cache.opendotaPremium, dailyLimit: cache.odDailyLimit });
  return cache;
}

export async function updateAppSettings(
  patch: Partial<Pick<AppSettings,
    | 'useBookmakerOdds'
    | 'liveSnapshotPruneDays'
    | 'trainWindowDays'
    | 'trainMaxPatches'
    | 'trainMinSamples'
    | 'minTeamRating'
    | 'liveWorkerLiveSec'
    | 'liveWorkerIdleSec'
    | 'liveWorkerUpcomingWindowMin'
    | 'bookmakerLiveSec'
    | 'bookmakerUpcomingSec'
    | 'bookmakerIdleSec'
    | 'schedulerTickHours'
    | 'mobilePollLiveSec'
    | 'mobilePollIdleSec'
    | 'opendotaPremium'
    | 'odDailyLimit'
    | 'notes'
    | 'promoFieldEnabled'
    | 'refRedirectUrl'
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
