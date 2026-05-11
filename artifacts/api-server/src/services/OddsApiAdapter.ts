/**
 * Адаптер к The Odds API (https://the-odds-api.com).
 *
 * Подготовлен заранее по запросу пользователя. Реальные запросы к API
 * выполняются ТОЛЬКО когда:
 *   1. В app_settings useBookmakerOdds=true (включено в админке)
 *   2. ENV ODDS_API_KEY задан
 *
 * При отсутствии ключа возвращает {available:false, reason:...} — никаких
 * запросов не делается, чтобы не тратить квоту бесплатно.
 *
 * Без подписки/ключа — это no-op адаптер, безопасный для прода.
 */

import { logger } from '../lib/logger';
import { getAppSettings } from './AppSettings';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const SPORT_KEY = 'esports_dota_2';
const REGIONS = 'eu,us';
const MARKETS = 'h2h,totals,handicap';

export interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    title: string;
    last_update: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number; point?: number }>;
    }>;
  }>;
}

export interface OddsFetchResult {
  available: boolean;
  reason?: string;
  events?: OddsApiEvent[];
  remainingRequests?: number;
  fetchedAt?: string;
}

let lastFetchAt = 0;
let cache: OddsFetchResult | null = null;
const CACHE_TTL_MS = 60_000; // The Odds API: лимит ~500 req/мес — кешируем агрессивно

export async function fetchDota2Odds(force = false): Promise<OddsFetchResult> {
  const settings = await getAppSettings();
  if (!settings.useBookmakerOdds) {
    return { available: false, reason: 'use_bookmaker_odds=false (отключено в админке)' };
  }

  const apiKey = process.env['ODDS_API_KEY'];
  if (!apiKey) {
    return { available: false, reason: 'ODDS_API_KEY не задан в env' };
  }

  // Кеш чтобы не сжигать квоту
  const now = Date.now();
  if (!force && cache?.available && now - lastFetchAt < CACHE_TTL_MS) {
    return cache;
  }

  const url = `${ODDS_API_BASE}/sports/${SPORT_KEY}/odds?apiKey=${apiKey}&regions=${REGIONS}&markets=${MARKETS}&oddsFormat=decimal`;

  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'DotaEdgeAnalyzer/1.0' } });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const events = (await resp.json()) as OddsApiEvent[];
    const remaining = Number(resp.headers.get('x-requests-remaining'));
    cache = {
      available: true,
      events,
      remainingRequests: Number.isFinite(remaining) ? remaining : undefined,
      fetchedAt: new Date().toISOString(),
    };
    lastFetchAt = now;
    logger.info(
      { count: events.length, remaining },
      '[OddsApi] Dota 2 odds fetched',
    );
    return cache;
  } catch (err) {
    logger.warn({ err: String(err) }, '[OddsApi] fetch failed');
    return { available: false, reason: `fetch error: ${String(err)}` };
  }
}

/**
 * Извлечь best (highest) match-winner odds из события для пары команд.
 * Возвращает null, если рынок недоступен.
 */
export function extractBestH2H(
  event: OddsApiEvent,
  team1: string,
  team2: string,
): { odds1: number; odds2: number; bookmaker: string } | null {
  let best: { odds1: number; odds2: number; bookmaker: string } | null = null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t1 = norm(team1);
  const t2 = norm(team2);

  for (const bm of event.bookmakers) {
    const h2h = bm.markets.find(m => m.key === 'h2h');
    if (!h2h) continue;
    let o1: number | null = null;
    let o2: number | null = null;
    for (const out of h2h.outcomes) {
      const n = norm(out.name);
      if (n === t1) o1 = out.price;
      else if (n === t2) o2 = out.price;
    }
    if (o1 && o2) {
      if (!best || o1 + o2 > best.odds1 + best.odds2) {
        best = { odds1: o1, odds2: o2, bookmaker: bm.title };
      }
    }
  }
  return best;
}
