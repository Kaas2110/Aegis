import { Router, type IRouter } from 'express';
import { getRandomUserAgent } from '../lib/userAgents';
import { getApiKey } from '../services/ApiKeysService';

const router: IRouter = Router();

// Pinnacle scraper удалён 2026-05-16 (T11 cleanup): на Replit-IP сайт даёт
// 403 + требует guest API key. Эндпоинт оставлен как stub чтобы старые клиенты
// не падали на 404; возвращает пустой массив. Если когда-нибудь дойдут руки до
// PINNACLE_GUEST_API_KEY — вернуть нормальный fetch.
router.get('/pinnacle/dota2', (_req, res) => {
  res.json({
    noData: true,
    source: 'pinnacle',
    warning: 'Pinnacle отключён (T11 cleanup, см. docs/changelog.md). Используйте Bovada через /api/bookmakers.',
    data: [],
  });
});

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

async function fetchWithProxy(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
    ...(options.headers as Record<string, string> ?? {}),
  };

  const proxyUrl = getApiKey('PROXY_URL');
  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      const { default: nodeFetch } = await import('node-fetch');
      const agent = new HttpsProxyAgent(proxyUrl);
      const resp = await nodeFetch(url, { ...options, headers, agent } as Parameters<typeof nodeFetch>[1]);
      return resp as unknown as Response;
    } catch {
      // Fall through to regular fetch
    }
  }

  return fetch(url, { ...options, headers });
}

router.get('/dota2', async (req, res) => {
  const oddsApiKey = getApiKey('ODDS_API_KEY');
  if (!oddsApiKey) {
    res.status(503).json({
      error: 'ODDS_API_KEY не настроен',
      hint: 'Добавьте ODDS_API_KEY в переменные окружения. Получить ключ: https://the-odds-api.com',
      noData: true,
      data: [],
    });
    return;
  }

  try {
    const url = new URL(`${ODDS_API_BASE}/sports/esports_dota2/odds/`);
    url.searchParams.set('apiKey', oddsApiKey);
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
      noData: false,
      data: data.map(transformOddsApiEvent),
      meta: { requestsRemaining: remaining, requestsUsed: used },
    });
  } catch (err) {
    req.log.error({ err }, 'The Odds API error');
    res.status(503).json({
      error: 'Ошибка получения коэффициентов',
      noData: true,
      data: [],
    });
  }
});

router.get('/sports', async (req, res) => {
  const oddsApiKey = getApiKey('ODDS_API_KEY');
  if (!oddsApiKey) {
    res.json({ error: 'ODDS_API_KEY не настроен', sports: [] });
    return;
  }

  try {
    const url = `${ODDS_API_BASE}/sports/?apiKey=${oddsApiKey}`;
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

export default router;
