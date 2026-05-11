/**
 * Best-effort парсер коэффициентов с публичного API Pinnacle.
 *
 * ⚠️  ВАЖНО:
 *   - Использование Pinnacle API без официального доступа нарушает их ToS.
 *   - Pinnacle активно блокирует IP, ставит rate-limit, меняет API.
 *   - Это решение временное, на продакшене нужен платный поставщик (The Odds API, OddsJam, BetGenius).
 *
 * Эндпоинт: https://guest.api.arcadia.pinnacle.com/0.1/sports/{sportId}/markets/straight
 *   Dota 2 sport ID: 12 (esports group)
 *
 * Если Pinnacle вернёт 403/401/429 — возвращаем пустой массив, апи отдаёт isMock=true.
 */

import { logger } from '../lib/logger';

const PINNACLE_BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';
const DOTA_LEAGUE_ID = '12'; // E-Sports → Dota 2 находится через /sports/12

// Pinnacle гостевой ключ берём из ENV. Это публично известный guest-ключ их веб-фронта,
// но мы не хардкодим его в репозиторий (compliance). Без ключа эндпоинт вернёт [].
const PINNACLE_GUEST_API_KEY = process.env['PINNACLE_GUEST_API_KEY'] ?? '';

export interface PinnacleMatchOdds {
  externalEventId: string;
  team1Name: string;
  team2Name: string;
  startTime: string;
  league: string;
  odds1: number;
  odds2: number;
  capturedAt: string;
}

interface PinnacleMarket {
  matchupId: number;
  prices?: { designation: string; price: number }[];
  isAlternate?: boolean;
  type?: string;
}

interface PinnacleMatchup {
  id: number;
  type: string;
  status: string;
  parent?: { id: number };
  participants?: { name: string; alignment: string }[];
  startTime: string;
  league: { id: number; name: string };
}

async function pinnacleFetch(path: string): Promise<unknown> {
  if (!PINNACLE_GUEST_API_KEY) {
    throw new Error('PINNACLE_GUEST_API_KEY not configured');
  }
  const url = `${PINNACLE_BASE}${path}`;
  const headers: Record<string, string> = {
    'X-API-Key': PINNACLE_GUEST_API_KEY,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Accept: 'application/json',
    Referer: 'https://www.pinnacle.com/',
    Origin: 'https://www.pinnacle.com',
  };
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`Pinnacle ${path}: HTTP ${resp.status}`);
  }
  return resp.json();
}

/**
 * Получить котировки на матч-винеры всех Dota-матчей.
 * Возвращает [] при любой ошибке (логируется).
 */
export async function fetchPinnacleDotaOdds(): Promise<PinnacleMatchOdds[]> {
  try {
    // 1. Загружаем все matchups для Dota 2 (sport 12).
    //    Pinnacle структурирует: leagues -> matchups -> markets.
    const matchups = (await pinnacleFetch(
      `/sports/${DOTA_LEAGUE_ID}/matchups?withSpecials=false&brandId=0`,
    )) as PinnacleMatchup[];

    if (!Array.isArray(matchups)) return [];

    // Только основные исходы (не over/under, не handicap)
    const mainMatchups = matchups.filter(
      m =>
        m.type === 'matchup' &&
        m.parent == null &&
        Array.isArray(m.participants) &&
        m.participants.length === 2,
    );

    if (mainMatchups.length === 0) return [];

    // 2. Загружаем рынки на эти matchups
    const markets = (await pinnacleFetch(
      `/sports/${DOTA_LEAGUE_ID}/markets/straight?primaryOnly=true`,
    )) as PinnacleMarket[];

    const moneylineByMatchup = new Map<number, { odds1?: number; odds2?: number }>();
    for (const m of markets) {
      if (m.type !== 'moneyline' || m.isAlternate) continue;
      if (!m.prices || m.prices.length < 2) continue;
      const home = m.prices.find(p => p.designation === 'home');
      const away = m.prices.find(p => p.designation === 'away');
      if (!home || !away) continue;
      moneylineByMatchup.set(m.matchupId, {
        odds1: home.price > 0 ? home.price : undefined,
        odds2: away.price > 0 ? away.price : undefined,
      });
    }

    const out: PinnacleMatchOdds[] = [];
    const now = new Date().toISOString();
    for (const matchup of mainMatchups) {
      const ml = moneylineByMatchup.get(matchup.id);
      if (!ml || !ml.odds1 || !ml.odds2) continue;
      const home = matchup.participants!.find(p => p.alignment === 'home');
      const away = matchup.participants!.find(p => p.alignment === 'away');
      if (!home || !away) continue;
      out.push({
        externalEventId: String(matchup.id),
        team1Name: home.name,
        team2Name: away.name,
        startTime: matchup.startTime,
        league: matchup.league.name,
        odds1: ml.odds1,
        odds2: ml.odds2,
        capturedAt: now,
      });
    }

    logger.info({ count: out.length }, '[Pinnacle] fetched odds');
    return out;
  } catch (err) {
    logger.warn({ err: String(err) }, '[Pinnacle] fetch failed (это нормально — Pinnacle нестабилен без auth)');
    return [];
  }
}
