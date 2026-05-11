/**
 * Российские букмекеры — публичные мобильные/web JSON-эндпоинты.
 *
 * 6 источников: Fonbet, Лига Ставок, PARI, BetBoom, 1xStavka, Olimp.bet.
 * Все API — публичные, без ключей. Гео-блокировка для не-РФ IP обходится через PROXY_URL.
 *
 * Управление:
 *   BOOKMAKERS_ENABLED=true   — включить (по умолчанию выключено на Replit/non-RU IP)
 *   PROXY_URL=...             — РФ-прокси если сервер вне РФ
 *
 * При выключенном флаге все эндпоинты возвращают HTTP 503 с понятным JSON-телом
 * (`{ enabled: false, error, hint }`) — UI получает чёткий сигнал «фича отключена»
 * и может отличать его от «временно упало».
 *
 * Покрытие маркетов на 2026-05-11:
 *   - winner: pari, betboom, x1stavka, olimp (4/6). fonbet/liga_stavok — list-only,
 *     winner подтянем при добавлении per-event details endpoint.
 *   - totalKills / totalDuration / firstBlood — типы зарезервированы, маппинг
 *     добавим вместе с EV-merge (отдельная сессия после Wave «B»).
 *
 * ToS: использование этих API находится в серой зоне — пользователь предупреждён.
 */
import { Router, type IRouter } from 'express';
import { getRandomUserAgent } from '../lib/userAgents';

const router: IRouter = Router();

const BOOKMAKERS_ENABLED = process.env['BOOKMAKERS_ENABLED'] === 'true';
const PROXY_URL = process.env['PROXY_URL'] ?? '';

const REQUEST_DELAY_MS = 1500;
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 12_000;

// ---------- Unified shape ----------

export interface UnifiedMarketWinner {
  team1: number;
  team2: number;
}
export interface UnifiedMarketTotal {
  line: number;
  over: number;
  under: number;
}
export interface UnifiedMarketBinary {
  yes: number;
  no: number;
}
export interface UnifiedBookmakerEvent {
  source: string;
  eventId: string;
  team1: string;
  team2: string;
  startsAt: string | null;
  status: 'live' | 'upcoming' | 'unknown';
  markets: {
    winner?: UnifiedMarketWinner;
    totalKills?: UnifiedMarketTotal[];
    totalDuration?: UnifiedMarketTotal[];
    firstBlood?: UnifiedMarketBinary;
  };
  updatedAt: string;
}

interface SourceResponse {
  source: string;
  isMock: boolean;
  events: UnifiedBookmakerEvent[];
  fetchedAt: string;
  error?: string;
  hint?: string;
}

// ---------- Rate limit + cache ----------

const lastRequest: Record<string, number> = {};
const cache: Record<string, { fetchedAt: number; value: SourceResponse }> = {};

function rateLimit(source: string): boolean {
  const now = Date.now();
  if (now - (lastRequest[source] ?? 0) < REQUEST_DELAY_MS) return true;
  lastRequest[source] = now;
  return false;
}

function getCached(source: string): SourceResponse | null {
  const entry = cache[source];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
  return entry.value;
}

function setCached(source: string, value: SourceResponse): void {
  cache[source] = { fetchedAt: Date.now(), value };
}

// ---------- HTTP ----------

async function fetchWithProxy(url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9',
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
        timeout: FETCH_TIMEOUT_MS,
      } as Parameters<typeof nodeFetch>[1]);
      return resp as unknown as Response;
    } catch {
      // fall through
    }
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(tid);
  }
}

// ---------- Helper: extract numeric odds safely ----------

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function dotaStatus(s: unknown): UnifiedBookmakerEvent['status'] {
  if (typeof s !== 'string') return 'unknown';
  const lower = s.toLowerCase();
  if (lower.includes('live') || lower === 'in_play') return 'live';
  if (lower.includes('upcom') || lower.includes('pre') || lower === 'scheduled') return 'upcoming';
  return 'unknown';
}

// ---------- Adapters ----------

async function adapterFonbet(): Promise<SourceResponse> {
  const url = 'https://line34.fonbet.ru/api/v1/line/sport/events?sport=12&count=50';
  const resp = await fetchWithProxy(url, {
    'Origin': 'https://www.fonbet.ru',
    'Referer': 'https://www.fonbet.ru/sports/esports/',
  });
  if (!resp.ok) throw new Error(`Fonbet HTTP ${resp.status}`);
  const raw = (await resp.json()) as {
    events?: Array<{
      id?: number | string;
      name?: string;
      team1?: string;
      team2?: string;
      startTime?: number;
      sportId?: number;
    }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.events ?? [])
    .filter((e) => (e.sportId === 12 || e.sportId === undefined))
    .map((e) => ({
      source: 'fonbet',
      eventId: String(e.id ?? ''),
      team1: e.team1 ?? '',
      team2: e.team2 ?? '',
      startsAt: e.startTime ? new Date(e.startTime * 1000).toISOString() : null,
      status: 'unknown' as const,
      markets: {},
      updatedAt: new Date().toISOString(),
    }))
    .filter((e) => e.team1 && e.team2);
  return { source: 'fonbet', isMock: false, events, fetchedAt: new Date().toISOString() };
}

async function adapterLigaStavok(): Promise<SourceResponse> {
  const url = 'https://line.ligastavok.ru/lsbets/api/v3/line/championships?sportFamilyKind=Esports&take=200';
  const resp = await fetchWithProxy(url, {
    'Origin': 'https://www.ligastavok.ru',
    'Referer': 'https://www.ligastavok.ru/bets/esports/dota',
  });
  if (!resp.ok) throw new Error(`LigaStavok HTTP ${resp.status}`);
  const raw = (await resp.json()) as {
    data?: { events?: Array<{ id?: string; name?: string; team1?: string; team2?: string; startsAt?: string; tournament?: { sport?: string } }> };
  };
  const evList = raw.data?.events ?? [];
  const events: UnifiedBookmakerEvent[] = evList
    .filter((e) => (e.tournament?.sport ?? '').toLowerCase().includes('dota'))
    .map((e) => ({
      source: 'liga_stavok',
      eventId: String(e.id ?? ''),
      team1: e.team1 ?? '',
      team2: e.team2 ?? '',
      startsAt: e.startsAt ?? null,
      status: 'unknown' as const,
      markets: {},
      updatedAt: new Date().toISOString(),
    }))
    .filter((e) => e.team1 && e.team2);
  return { source: 'liga_stavok', isMock: false, events, fetchedAt: new Date().toISOString() };
}

async function adapterPari(): Promise<SourceResponse> {
  // PARI sportId 33 = esports, разделы Dota 2 фильтруем по названию tournament
  const url = 'https://pari.ru/api/v3/line/events?sportId=33&take=200';
  const resp = await fetchWithProxy(url, {
    'Origin': 'https://pari.ru',
    'Referer': 'https://pari.ru/cybersport/dota-2',
  });
  if (!resp.ok) throw new Error(`PARI HTTP ${resp.status}`);
  const raw = (await resp.json()) as {
    events?: Array<{ id?: string; team1?: string; team2?: string; startsAt?: string; tournamentName?: string; markets?: Array<{ name?: string; outcomes?: Array<{ name?: string; coefficient?: number }> }> }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.events ?? [])
    .filter((e) => (e.tournamentName ?? '').toLowerCase().includes('dota'))
    .map((e) => {
      const winnerMarket = (e.markets ?? []).find((m) => (m.name ?? '').toLowerCase() === 'победитель' || (m.name ?? '').toLowerCase() === 'winner');
      const t1 = winnerMarket?.outcomes?.[0]?.coefficient ?? null;
      const t2 = winnerMarket?.outcomes?.[1]?.coefficient ?? null;
      return {
        source: 'pari',
        eventId: String(e.id ?? ''),
        team1: e.team1 ?? '',
        team2: e.team2 ?? '',
        startsAt: e.startsAt ?? null,
        status: 'unknown' as const,
        markets: t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {},
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((e) => e.team1 && e.team2);
  return { source: 'pari', isMock: false, events, fetchedAt: new Date().toISOString() };
}

async function adapterBetBoom(): Promise<SourceResponse> {
  // BetBoom публичный эндпоинт киберспорта
  const url = 'https://betboom.ru/api/v3/sports/40/line?take=200';
  const resp = await fetchWithProxy(url, {
    'Origin': 'https://betboom.ru',
    'Referer': 'https://betboom.ru/sport/cybersport/dota-2',
  });
  if (!resp.ok) throw new Error(`BetBoom HTTP ${resp.status}`);
  const raw = (await resp.json()) as {
    events?: Array<{ id?: string; name?: string; team1?: string; team2?: string; beginAt?: string; sectionName?: string; w1?: number; w2?: number }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.events ?? [])
    .filter((e) => (e.sectionName ?? '').toLowerCase().includes('dota'))
    .map((e) => {
      const t1 = num(e.w1);
      const t2 = num(e.w2);
      return {
        source: 'betboom',
        eventId: String(e.id ?? ''),
        team1: e.team1 ?? '',
        team2: e.team2 ?? '',
        startsAt: e.beginAt ?? null,
        status: 'unknown' as const,
        markets: t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {},
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((e) => e.team1 && e.team2);
  return { source: 'betboom', isMock: false, events, fetchedAt: new Date().toISOString() };
}

async function adapter1xStavka(): Promise<SourceResponse> {
  // 1xStavka LineFeed: sports=1620 = Dota 2 (на стороне 1xstavka это конкретный sportId)
  const url = 'https://1xstavka.ru/LineFeed/Get1x2_VZip?sports=1620&count=200&lng=ru&mode=4&country=1&getEmpty=true';
  const resp = await fetchWithProxy(url, {
    'Origin': 'https://1xstavka.ru',
    'Referer': 'https://1xstavka.ru/line/esports/dota-2/',
  });
  if (!resp.ok) throw new Error(`1xStavka HTTP ${resp.status}`);
  const raw = (await resp.json()) as {
    Value?: Array<{ I?: number; O1?: string; O2?: string; S?: number; E?: Array<{ T?: number; C?: number }> }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.Value ?? [])
    .map((e) => {
      // T=1 — П1, T=3 — П2 в формате 1xstavka
      const t1 = num(e.E?.find((o) => o.T === 1)?.C);
      const t2 = num(e.E?.find((o) => o.T === 3)?.C);
      return {
        source: 'x1stavka',
        eventId: String(e.I ?? ''),
        team1: e.O1 ?? '',
        team2: e.O2 ?? '',
        startsAt: e.S ? new Date(e.S * 1000).toISOString() : null,
        status: 'unknown' as const,
        markets: t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {},
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((e) => e.team1 && e.team2);
  return { source: 'x1stavka', isMock: false, events, fetchedAt: new Date().toISOString() };
}

async function adapterOlimp(): Promise<SourceResponse> {
  // Olimp.bet публичный эндпоинт
  const url = 'https://www.olimp.bet/ru/api/lines/get_events?sport=cybersport&subsport=dota-2&take=200';
  const resp = await fetchWithProxy(url, {
    'Origin': 'https://www.olimp.bet',
    'Referer': 'https://www.olimp.bet/ru/cybersport/dota-2',
  });
  if (!resp.ok) throw new Error(`Olimp HTTP ${resp.status}`);
  const raw = (await resp.json()) as {
    events?: Array<{ id?: string; team1?: string; team2?: string; date?: string; coef1?: number; coef2?: number }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.events ?? [])
    .map((e) => {
      const t1 = num(e.coef1);
      const t2 = num(e.coef2);
      return {
        source: 'olimp',
        eventId: String(e.id ?? ''),
        team1: e.team1 ?? '',
        team2: e.team2 ?? '',
        startsAt: e.date ?? null,
        status: 'unknown' as const,
        markets: t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {},
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((e) => e.team1 && e.team2);
  return { source: 'olimp', isMock: false, events, fetchedAt: new Date().toISOString() };
}

const ADAPTERS: Record<string, () => Promise<SourceResponse>> = {
  fonbet: adapterFonbet,
  liga_stavok: adapterLigaStavok,
  pari: adapterPari,
  betboom: adapterBetBoom,
  x1stavka: adapter1xStavka,
  olimp: adapterOlimp,
};

const SOURCE_NAMES: Record<string, string> = {
  fonbet: 'Fonbet',
  liga_stavok: 'Лига Ставок',
  pari: 'PARI',
  betboom: 'BetBoom',
  x1stavka: '1xStavka',
  olimp: 'Olimp.bet',
};

// ---------- Helpers used by routes ----------

function disabledResponse(source: string): SourceResponse {
  return {
    source,
    isMock: true,
    events: [],
    fetchedAt: new Date().toISOString(),
    error: 'BOOKMAKERS_ENABLED=false',
    hint: 'Букмекерский функционал выключен на этом инстансе. Включите через ENV BOOKMAKERS_ENABLED=true (требуется РФ-IP или PROXY_URL).',
  };
}

async function fetchSource(source: string): Promise<SourceResponse> {
  if (!BOOKMAKERS_ENABLED) return disabledResponse(source);

  const cached = getCached(source);
  if (cached) return cached;

  if (rateLimit(source)) {
    return cached ?? {
      source,
      isMock: true,
      events: [],
      fetchedAt: new Date().toISOString(),
      error: 'rate_limited',
      hint: `Слишком частые запросы к ${SOURCE_NAMES[source] ?? source}. Минимум ${REQUEST_DELAY_MS}мс между запросами.`,
    };
  }

  const adapter = ADAPTERS[source];
  if (!adapter) {
    return {
      source,
      isMock: true,
      events: [],
      fetchedAt: new Date().toISOString(),
      error: `unknown_source:${source}`,
    };
  }

  try {
    const result = await adapter();
    setCached(source, result);
    return result;
  } catch (err) {
    const fail: SourceResponse = {
      source,
      isMock: true,
      events: [],
      fetchedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      hint: PROXY_URL
        ? 'Прокси настроен, но запрос не удался. Проверьте PROXY_URL и доступность букмекера.'
        : 'Установите PROXY_URL для обхода гео-блокировки (РФ-прокси).',
    };
    // даже фейлы кэшируем коротко, чтобы не долбить упавший источник
    setCached(source, fail);
    return fail;
  }
}

// ---------- Routes ----------

router.get('/status', (_req, res) => {
  const sources: Record<string, { name: string; available: boolean; cached: boolean; lastError?: string }> = {};
  for (const id of Object.keys(ADAPTERS)) {
    const cached = cache[id]?.value;
    sources[id] = {
      name: SOURCE_NAMES[id] ?? id,
      available: BOOKMAKERS_ENABLED,
      cached: !!getCached(id),
      ...(cached?.error ? { lastError: cached.error } : {}),
    };
  }
  res.json({
    enabled: BOOKMAKERS_ENABLED,
    proxyConfigured: !!PROXY_URL,
    cacheTtlMs: CACHE_TTL_MS,
    sources,
    note: BOOKMAKERS_ENABLED
      ? 'Букмекерские источники активны. На non-RU IP может потребоваться PROXY_URL.'
      : 'Букмекерский функционал выключен. Установите BOOKMAKERS_ENABLED=true в ENV.',
  });
});

router.get('/all/dota2', async (_req, res) => {
  if (!BOOKMAKERS_ENABLED) {
    res.status(503).json({
      enabled: false,
      error: 'BOOKMAKERS_ENABLED=false',
      hint: 'Букмекерский функционал выключен. Включите через ENV BOOKMAKERS_ENABLED=true.',
    });
    return;
  }
  const results = await Promise.all(Object.keys(ADAPTERS).map((s) => fetchSource(s)));
  res.json({
    enabled: true,
    sources: results,
    fetchedAt: new Date().toISOString(),
  });
});

// Per-source endpoints (sugar). When the feature is disabled, return 503 to match the
// documented contract — клиенты могут отличать «выключено» от «временно упало».
for (const id of Object.keys(ADAPTERS)) {
  router.get(`/${id}/dota2`, async (_req, res) => {
    if (!BOOKMAKERS_ENABLED) {
      res.status(503).json(disabledResponse(id));
      return;
    }
    const result = await fetchSource(id);
    res.json(result);
  });
}

export default router;
