/**
 * Per-process resolver для ключей внешних API. Сначала ищет override в
 * `api_key_overrides` (управляется из admin-web), при отсутствии — берёт
 * значение из `process.env`. Кэширует загрузку всей таблицы на 30 секунд,
 * чтобы хот-пути (`/api/odds`, `/api/matches`, букмекеры) не били БД на
 * каждый запрос.
 *
 * Источник правды для списка интеграций — `KNOWN_INTEGRATIONS`. Добавление
 * нового ключа требует только записи здесь и обращения через `getApiKey()`.
 */

import { db, apiKeyOverridesTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger';

export type IntegrationCategory = 'data-source' | 'odds-feed' | 'network';

export interface IntegrationDescriptor {
  envName: string;
  label: string;
  description: string;
  docUrl: string;
  category: IntegrationCategory;
  /** Чувствительные ключи маскируются; PROXY_URL — нет (URL это не секрет). */
  sensitive: boolean;
}

export const KNOWN_INTEGRATIONS: IntegrationDescriptor[] = [
  {
    envName: 'ODDS_API_KEY',
    label: 'The Odds API',
    description: 'Агрегатор букмекерских коэффициентов (h2h Dota 2). Бесплатный план ~500 req/мес.',
    docUrl: 'https://the-odds-api.com',
    category: 'odds-feed',
    sensitive: true,
  },
  {
    envName: 'STRATZ_TOKEN',
    label: 'Stratz API',
    description: 'Альтернативный источник live-матчей (дополняет OpenDota). Bearer-токен.',
    docUrl: 'https://stratz.com/api',
    category: 'data-source',
    sensitive: true,
  },
  {
    envName: 'PANDASCORE_API_KEY',
    label: 'PandaScore',
    description: 'Расписание pro-матчей (`/matches/upcoming`). Без ключа upcoming показывает мок.',
    docUrl: 'https://pandascore.co',
    category: 'data-source',
    sensitive: true,
  },
  {
    envName: 'PINNACLE_GUEST_API_KEY',
    label: 'Pinnacle (guest)',
    description: 'Публичный guest-ключ Pinnacle web (исп. в `services/PinnacleScraper.ts`). Best-effort.',
    docUrl: 'https://www.pinnacle.com',
    category: 'odds-feed',
    sensitive: true,
  },
  {
    envName: 'PROXY_URL',
    label: 'Outbound proxy',
    description: 'РФ-прокси для гео-блокированных букмекеров и (опционально) The Odds API. Формат `http(s)://user:pass@host:port`.',
    docUrl: 'https://docs.replit.com',
    category: 'network',
    sensitive: false,
  },
];

interface OverrideRow {
  envName: string;
  value: string;
  updatedAt: Date;
}

const CACHE_TTL_MS = 30_000;
let cache: Map<string, OverrideRow> | null = null;
let cacheLoadedAt = 0;

async function loadOverrides(force = false): Promise<Map<string, OverrideRow>> {
  const now = Date.now();
  if (!force && cache && now - cacheLoadedAt < CACHE_TTL_MS) return cache;
  try {
    const rows = await db.select().from(apiKeyOverridesTable);
    cache = new Map(rows.map((r) => [r.envName, r]));
    cacheLoadedAt = now;
  } catch (err) {
    logger.warn({ err: String(err) }, '[ApiKeys] failed to load overrides; falling back to env only');
    cache = cache ?? new Map();
    cacheLoadedAt = now;
  }
  return cache;
}

export function invalidateApiKeysCache(): void {
  cache = null;
  cacheLoadedAt = 0;
}

/**
 * Возвращает значение ключа: override из БД, иначе process.env, иначе пустая строка.
 * Синхронный API (читает кеш). При первом обращении за процесс кеш пуст —
 * вернёт ENV-значение, а параллельный `primeApiKeysCache()` подгрузит overrides.
 */
export function getApiKey(envName: string): string {
  const override = cache?.get(envName)?.value;
  if (override && override.length > 0) return override;
  return process.env[envName] ?? '';
}

/** Прогревает кеш на старте api-server. Не fatal при ошибке. */
export async function primeApiKeysCache(): Promise<void> {
  await loadOverrides(true);
}

export interface IntegrationStatus extends IntegrationDescriptor {
  configured: boolean;
  source: 'override' | 'env' | 'none';
  /** Маскированный preview значения (последние 4 символа) для sensitive=true. */
  preview: string | null;
  overrideUpdatedAt: string | null;
}

export async function listIntegrations(): Promise<IntegrationStatus[]> {
  const overrides = await loadOverrides();
  return KNOWN_INTEGRATIONS.map((meta) => {
    const override = overrides.get(meta.envName);
    const overrideValue = override?.value && override.value.length > 0 ? override.value : null;
    const envValue = process.env[meta.envName];
    const effective = overrideValue ?? (envValue && envValue.length > 0 ? envValue : null);
    const source: IntegrationStatus['source'] = overrideValue ? 'override' : effective ? 'env' : 'none';
    let preview: string | null = null;
    if (effective) {
      if (meta.sensitive) {
        const tail = effective.slice(-4);
        preview = effective.length <= 4 ? '••••' : `••••${tail}`;
      } else {
        preview = effective.length > 60 ? `${effective.slice(0, 57)}…` : effective;
      }
    }
    return {
      ...meta,
      configured: !!effective,
      source,
      preview,
      overrideUpdatedAt: override ? override.updatedAt.toISOString() : null,
    };
  });
}

/**
 * Установить override. Пустая строка / null → удалить override (вернуться к ENV).
 * Возвращает обновлённый статус интеграции.
 */
export async function setIntegrationOverride(
  envName: string,
  rawValue: string | null,
): Promise<IntegrationStatus> {
  const meta = KNOWN_INTEGRATIONS.find((m) => m.envName === envName);
  if (!meta) {
    throw new Error(`unknown integration: ${envName}`);
  }
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (trimmed.length === 0) {
    await db.delete(apiKeyOverridesTable).where(eq(apiKeyOverridesTable.envName, envName));
    logger.info({ envName }, '[ApiKeys] override cleared');
  } else {
    if (trimmed.length > 4096) {
      throw new Error('value too long (max 4096 chars)');
    }
    await db
      .insert(apiKeyOverridesTable)
      .values({ envName, value: trimmed, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: apiKeyOverridesTable.envName,
        set: { value: trimmed, updatedAt: new Date() },
      });
    logger.info({ envName, length: trimmed.length }, '[ApiKeys] override set');
  }
  invalidateApiKeysCache();
  await loadOverrides(true);
  const all = await listIntegrations();
  const found = all.find((i) => i.envName === envName);
  if (!found) throw new Error('integration disappeared after update');
  return found;
}
