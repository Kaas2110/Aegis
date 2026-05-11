import { Router, type IRouter } from 'express';
import { getRandomUserAgent } from '../lib/userAgents';
import { fetchPinnacleDotaOdds } from '../services/PinnacleScraper';
import { db, oddsSnapshotsTable } from '@workspace/db';

const router: IRouter = Router();

let pinnacleCache: { data: unknown[]; fetchedAt: number } = { data: [], fetchedAt: 0 };
const PINNACLE_CACHE_MS = 60_000;

router.get('/pinnacle/dota2', async (req, res) => {
  // Кеш на минуту чтобы не спамить Pinnacle
  if (Date.now() - pinnacleCache.fetchedAt < PINNACLE_CACHE_MS && pinnacleCache.data.length > 0) {
    res.json({
      isMock: false,
      source: 'pinnacle',
      cached: true,
      data: pinnacleCache.data,
    });
    return;
  }

  try {
    const odds = await fetchPinnacleDotaOdds();
    pinnacleCache = { data: odds, fetchedAt: Date.now() };

    // Параллельно пишем снапшоты в БД для бэктеста (best-effort, ошибки игнорируем)
    if (odds.length > 0) {
      try {
        await db.insert(oddsSnapshotsTable).values(
          odds.map(o => ({
            bookmaker: 'pinnacle',
            externalEventId: o.externalEventId,
            team1Name: o.team1Name,
            team2Name: o.team2Name,
            marketType: 'match_winner',
            odds1: o.odds1,
            odds2: o.odds2,
          })),
        );
      } catch (err) {
        req.log.warn({ err }, 'pinnacle snapshot insert failed (non-fatal)');
      }
    }

    res.json({
      isMock: odds.length === 0,
      source: 'pinnacle',
      warning: 'Парсер Pinnacle — best-effort, может не работать. На продакшене нужен платный поставщик.',
      data: odds,
    });
  } catch (err) {
    req.log.error({ err }, 'Pinnacle scraper error');
    res.status(503).json({ error: 'Pinnacle недоступен', isMock: true, data: [] });
  }
});

const ODDS_API_KEY = process.env['ODDS_API_KEY'] ?? '';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const PROXY_URL = process.env['PROXY_URL'] ?? '';

async function fetchWithProxy(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
    ...(options.headers as Record<string, string> ?? {}),
  };

  if (PROXY_URL) {
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      const { default: nodeFetch } = await import('node-fetch');
      const agent = new HttpsProxyAgent(PROXY_URL);
      const resp = await nodeFetch(url, { ...options, headers, agent } as Parameters<typeof nodeFetch>[1]);
      return resp as unknown as Response;
    } catch {
      // Fall through to regular fetch
    }
  }

  return fetch(url, { ...options, headers });
}

router.get('/dota2', async (req, res) => {
  if (!ODDS_API_KEY) {
    res.status(503).json({
      error: 'ODDS_API_KEY не настроен',
      hint: 'Добавьте ODDS_API_KEY в переменные окружения. Получить ключ: https://the-odds-api.com',
      isMock: true,
      data: getMockOdds(),
    });
    return;
  }

  try {
    const url = new URL(`${ODDS_API_BASE}/sports/esports_dota2/odds/`);
    url.searchParams.set('apiKey', ODDS_API_KEY);
    url.searchParams.set('regions', 'eu,us,uk');
    url.searchParams.set('markets', 'h2h');
    url.searchParams.set('oddsFormat', 'decimal');
    url.searchParams.set('dateFormat', 'iso');

    const resp = await fetchWithProxy(url.toString());
    if (!resp.ok) {
      throw new Error(`The Odds API: HTTP ${resp.status}`);
    }

    const data = await resp.json() as OddsApiResponse[];

    const remaining = resp.headers.get('x-requests-remaining');
    const used = resp.headers.get('x-requests-used');

    res.json({
      isMock: false,
      data: data.map(transformOddsApiEvent),
      meta: { requestsRemaining: remaining, requestsUsed: used },
    });
  } catch (err) {
    req.log.error({ err }, 'The Odds API error');
    res.status(503).json({
      error: 'Ошибка получения коэффициентов',
      isMock: true,
      data: getMockOdds(),
    });
  }
});

router.get('/sports', async (req, res) => {
  if (!ODDS_API_KEY) {
    res.json({ error: 'ODDS_API_KEY не настроен', sports: [] });
    return;
  }

  try {
    const url = `${ODDS_API_BASE}/sports/?apiKey=${ODDS_API_KEY}`;
    const resp = await fetchWithProxy(url);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    req.log.error({ err }, 'Sports fetch error');
    res.status(503).json({ error: 'Ошибка', sports: [] });
  }
});

interface OddsApiResponse {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: {
    key: string;
    title: string;
    last_update: string;
    markets: {
      key: string;
      last_update: string;
      outcomes: { name: string; price: number }[];
    }[];
  }[];
}

interface NormalizedOdds {
  eventId: string;
  sportKey: string;
  team1: string;
  team2: string;
  commenceTime: string;
  bookmakers: {
    bookmakerId: string;
    bookmakerName: string;
    team1Odds: number;
    team2Odds: number;
    lastUpdate: string;
  }[];
}

function transformOddsApiEvent(ev: OddsApiResponse): NormalizedOdds {
  return {
    eventId: ev.id,
    sportKey: ev.sport_key,
    team1: ev.home_team,
    team2: ev.away_team,
    commenceTime: ev.commence_time,
    bookmakers: ev.bookmakers.flatMap(bk =>
      bk.markets
        .filter(m => m.key === 'h2h')
        .map(m => {
          const t1 = m.outcomes.find(o => o.name === ev.home_team)?.price ?? 2.0;
          const t2 = m.outcomes.find(o => o.name === ev.away_team)?.price ?? 2.0;
          return {
            bookmakerId: bk.key,
            bookmakerName: bk.title,
            team1Odds: t1,
            team2Odds: t2,
            lastUpdate: m.last_update,
          };
        })
    ),
  };
}

function getMockOdds(): NormalizedOdds[] {
  return [
    {
      eventId: 'mock_m1',
      sportKey: 'esports_dota2',
      team1: 'Team Liquid',
      team2: 'Team Falcons',
      commenceTime: new Date().toISOString(),
      bookmakers: [
        { bookmakerId: 'fonbet', bookmakerName: 'Fonbet', team1Odds: 2.15, team2Odds: 1.72, lastUpdate: new Date().toISOString() },
        { bookmakerId: 'betfair', bookmakerName: 'Betfair', team1Odds: 2.20, team2Odds: 1.68, lastUpdate: new Date().toISOString() },
        { bookmakerId: 'betboom', bookmakerName: 'BetBoom', team1Odds: 2.08, team2Odds: 1.78, lastUpdate: new Date().toISOString() },
      ],
    },
  ];
}

export default router;
