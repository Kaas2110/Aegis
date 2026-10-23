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

export type IntegrationCategory = 'data-source' | 'odds-feed' | 'network' | 'bookmaker';

export interface IntegrationDescriptor {
  envName: string;
  label: string;
  description: string;
  /** Ссылка на страницу получения ключа / партнёрской программы. */
  docUrl: string;
  /** Краткая инструкция как получить ключ (1-2 предложения). */
  howToGet: string;
  category: IntegrationCategory;
  /** Чувствительные ключи маскируются; PROXY_URL — нет (URL это не секрет). */
  sensitive: boolean;
}

export const KNOWN_INTEGRATIONS: IntegrationDescriptor[] = [
  // ─── Источники данных ─────────────────────────────────────────────────────
  {
    envName: 'STRATZ_TOKEN',
    label: 'Stratz API',
    description: 'Основной источник picks/bans, account_ids и hero-stats (Captains Mode). 250 req/min / 20k req/day на токен. Поддерживается пул через запятую: tok1,tok2,tok3 — лимиты на токен суммируются (×N throughput).',
    docUrl: 'https://stratz.com/api',
    howToGet: 'Войдите через Steam на stratz.com → раздел API → «Generate Token». Укажите один основной токен. Aegis отправляет обязательный User-Agent: STRATZ_API и соблюдает общий локальный лимит запросов.',
    category: 'data-source',
    sensitive: true,
  },
  {
    envName: 'PANDASCORE_API_KEY',
    label: 'PandaScore',
    description: 'Расписание pro-матчей (`/matches/upcoming`). Без ключа upcoming показывает мок.',
    docUrl: 'https://app.pandascore.co/signup',
    howToGet: 'Зарегистрируйтесь на pandascore.co → войдите в Dashboard → раздел «API» → скопируйте ключ. Бесплатный план: 100 req/час.',
    category: 'data-source',
    sensitive: true,
  },
  // ─── Котировки / коэффициенты ─────────────────────────────────────────────
  {
    envName: 'ODDS_API_KEY',
    label: 'The Odds API',
    description: 'Агрегатор букмекерских коэффициентов (h2h Dota 2). Бесплатный план ~500 req/мес.',
    docUrl: 'https://the-odds-api.com/#get-access',
    howToGet: 'Перейдите на the-odds-api.com → «Get Access» → зарегистрируйтесь → ключ появится в Dashboard. Бесплатный план: 500 запросов/месяц.',
    category: 'odds-feed',
    sensitive: true,
  },
  {
    envName: 'PINNACLE_GUEST_API_KEY',
    label: 'Pinnacle (guest)',
    description: 'Публичный guest-ключ Pinnacle web (исп. в `services/PinnacleScraper.ts`). Best-effort.',
    docUrl: 'https://www.pinnacle.com',
    howToGet: 'Официального API нет. Гостевой ключ извлекается из DevTools: откройте pinnacle.com → Network → найдите запросы к api.pinnacle.com → заголовок X-API-Key.',
    category: 'odds-feed',
    sensitive: true,
  },
  // ─── Букмекеры (RU) — партнёрские API ────────────────────────────────────
  {
    envName: 'FONBET_API_KEY',
    label: 'Fonbet',
    description: 'Букмекер (RU). Публичный mobile API работает без ключа. Партнёрский API с ключом даёт live-линию и историю ставок.',
    docUrl: 'https://partner.fon.bet',
    howToGet: 'Перейдите на partner.fon.bet → «Стать партнёром» → оставьте заявку. После одобрения получите API-ключ в личном кабинете партнёра.',
    category: 'bookmaker',
    sensitive: true,
  },
  {
    envName: 'LIGASTAVOK_API_KEY',
    label: 'Лига Ставок',
    description: 'Букмекер (RU). Публичный web JSON API работает без ключа. Партнёрский API — расширенная линия.',
    docUrl: 'https://partner.ligastavok.ru',
    howToGet: 'Перейдите на partner.ligastavok.ru → «Подключиться» → заполните форму. Ключ выдаётся после подписания договора.',
    category: 'bookmaker',
    sensitive: true,
  },
  {
    envName: 'PARI_API_KEY',
    label: 'PARI',
    description: 'Букмекер (RU). Публичный web JSON API работает без ключа.',
    docUrl: 'https://pari.ru/partners',
    howToGet: 'Перейдите в раздел «Партнёрам» на pari.ru → подайте заявку на подключение партнёрского API.',
    category: 'bookmaker',
    sensitive: true,
  },
  {
    envName: 'BETBOOM_API_KEY',
    label: 'BetBoom',
    description: 'Букмекер (RU). Публичный web JSON API работает без ключа.',
    docUrl: 'https://betboom.ru/partners',
    howToGet: 'Перейдите на betboom.ru → «Партнёрам» → зарегистрируйтесь как партнёр. API-ключ доступен после верификации.',
    category: 'bookmaker',
    sensitive: true,
  },
  {
    envName: 'X1STAVKA_API_KEY',
    label: '1xStavka',
    description: 'Букмекер (RU). Публичный mobile API работает без ключа.',
    docUrl: 'https://1xstavka.ru/partners',
    howToGet: 'Перейдите на 1xstavka.ru → «Партнёрская программа» → оставьте заявку. API-ключ — в кабинете после одобрения.',
    category: 'bookmaker',
    sensitive: true,
  },
  {
    envName: 'OLIMP_API_KEY',
    label: 'Olimp.bet',
    description: 'Букмекер (RU). Публичный web JSON API работает без ключа.',
    docUrl: 'https://www.olimp.bet/partners',
    howToGet: 'Перейдите на olimp.bet → «Партнёрам» → зарегистрируйте аккаунт партнёра. Ключ выдаётся менеджером.',
    category: 'bookmaker',
    sensitive: true,
  },
  // ─── Сетевая инфраструктура ───────────────────────────────────────────────
  {
    envName: 'PROXY_URL',
    label: 'Outbound proxy',
    description: 'РФ-прокси для гео-блокированных букмекеров и (опционально) The Odds API. Формат `http(s)://user:pass@host:port`.',
    docUrl: 'https://2ip.ru/proxy/',
    howToGet: 'Любой RU-прокси: купите у провайдера (например, proxys.io, proxy6.net) или используйте свой VPS в РФ с squid/3proxy. Формат: http://user:pass@host:port.',
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

/** Primary STRATZ token only. Additional accounts never multiply the budget. */
export function getStratzToken(): string {
  return getApiKey('STRATZ_TOKEN').split(',')[0]!.trim();
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
