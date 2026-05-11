/**
 * Scraper для российских букмекеров с anti-blocking.
 * Использует публичные JSON API мобильных приложений с ротацией User-Agent.
 * Для обхода блокировок по IP: установите PROXY_URL в переменные окружения.
 *
 * Поддерживаемые источники:
 * - Fonbet (api.fonbet.ru)
 * - Лига Ставок (mobile API)
 *
 * Примечание: использование этих API на стороне сервера для агрегации данных
 * находится в серой зоне ToS. Не используйте для автоматических ставок.
 */

import { Router, type IRouter } from 'express';
import { getRandomUserAgent } from '../lib/userAgents';

const router: IRouter = Router();

const PROXY_URL = process.env['PROXY_URL'] ?? '';
const REQUEST_DELAY_MS = 3000;

const rateLimits: Record<string, number> = {};

function isRateLimited(source: string): boolean {
  const last = rateLimits[source] ?? 0;
  return Date.now() - last < REQUEST_DELAY_MS;
}

function markRequest(source: string): void {
  rateLimits[source] = Date.now();
}

async function fetchWithAntiBlock(url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': 'https://www.fonbet.ru',
    'Referer': 'https://www.fonbet.ru/',
    'Cache-Control': 'no-cache',
    'X-Requested-With': 'XMLHttpRequest',
    ...extraHeaders,
  };

  if (PROXY_URL) {
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      const { default: nodeFetch } = await import('node-fetch');
      const agent = new HttpsProxyAgent(PROXY_URL);
      const resp = await nodeFetch(url, {
        headers,
        agent,
        timeout: 12000,
      } as Parameters<typeof nodeFetch>[1]);
      return resp as unknown as Response;
    } catch {
      // fall through to regular fetch
    }
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 12000);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(tid);
  }
}

router.get('/fonbet/dota2', async (req, res) => {
  if (isRateLimited('fonbet')) {
    res.status(429).json({ error: 'Слишком частые запросы к Fonbet', retryAfterMs: REQUEST_DELAY_MS });
    return;
  }
  markRequest('fonbet');

  try {
    const lineUrl = 'https://line34.fonbet.ru/api/v1/line/sport/events?sport=12&count=50';
    const resp = await fetchWithAntiBlock(lineUrl, {
      'Origin': 'https://www.fonbet.ru',
      'Referer': 'https://www.fonbet.ru/sports/esports/',
    });

    if (!resp.ok) throw new Error(`Fonbet: HTTP ${resp.status}`);

    const raw = await resp.text();
    const data = JSON.parse(raw) as unknown;

    res.json({ source: 'fonbet', isMock: false, data });
  } catch (err) {
    res.json({
      source: 'fonbet',
      isMock: true,
      error: String(err),
      hint: PROXY_URL ? 'Прокси настроен, но запрос не удался. Возможно, требуется другой прокси.' : 'Установите PROXY_URL для обхода гео-блокировки.',
      data: getMockFonbetEvents(),
    });
  }
});

router.get('/ligastavok/dota2', async (req, res) => {
  if (isRateLimited('ligastavok')) {
    res.status(429).json({ error: 'Слишком частые запросы к Лига Ставок', retryAfterMs: REQUEST_DELAY_MS });
    return;
  }
  markRequest('ligastavok');

  try {
    const url = 'https://api.ligastavok.ru/v3/sports/esports/events?status=live&sportId=12';
    const resp = await fetchWithAntiBlock(url, {
      'Origin': 'https://www.ligastavok.ru',
      'Referer': 'https://www.ligastavok.ru/bets/esports/dota',
      'Authorization': 'Bearer public',
    });

    if (!resp.ok) throw new Error(`Лига Ставок: HTTP ${resp.status}`);
    const data = await resp.json() as unknown;
    res.json({ source: 'liga_stavok', isMock: false, data });
  } catch (err) {
    res.json({
      source: 'liga_stavok',
      isMock: true,
      error: String(err),
      hint: 'Установите PROXY_URL=http://user:pass@proxy:port для обхода блокировки.',
      data: getMockLigaStavokEvents(),
    });
  }
});

router.get('/status', (_req, res) => {
  res.json({
    proxyConfigured: !!PROXY_URL,
    sources: {
      fonbet: { available: true, rateLimited: isRateLimited('fonbet'), antiBlockingEnabled: true },
      liga_stavok: { available: true, rateLimited: isRateLimited('ligastavok'), antiBlockingEnabled: true },
      betboom: { available: false, note: 'Требует авторизацию через мобильное приложение' },
      pari: { available: false, note: 'API не документирован' },
    },
    proxyFormats: [
      'http://user:pass@host:port',
      'socks5://user:pass@host:port',
    ],
    note: 'Добавьте PROXY_URL в переменные окружения для обхода гео-блокировки',
  });
});

function getMockFonbetEvents() {
  return [
    {
      id: 'fonbet_m1',
      name: 'Team Liquid — Team Falcons',
      sport: 'Dota 2',
      status: 'live',
      markets: {
        match_winner: { team1: 2.15, team2: 1.72 },
        map1_winner: { team1: 2.10, team2: 1.75 },
      },
      updatedAt: new Date().toISOString(),
    },
  ];
}

function getMockLigaStavokEvents() {
  return [
    {
      id: 'ls_m1',
      eventName: 'Team Liquid vs Team Falcons',
      sport: 'Dota 2',
      status: 'live',
      odds: { w1: 2.08, w2: 1.80 },
      updatedAt: new Date().toISOString(),
    },
  ];
}

export default router;
