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
 * Реальность с не-РФ IP (Replit): все 6 источников блочат гео либо через DNS
 * (line.ligastavok.ru / line34.fonbet.ru не резолвятся), либо через Cloudflare
 * (1xstavka 403), либо отдают HTML-челлендж главной страницы вместо JSON.
 * **Без `PROXY_URL` (РФ-прокси) бэк не получит данные.** Это не баг кода —
 * это фундаментальное ограничение площадки. Для диагностики на проде есть
 * admin-эндпоинт `POST /api/admin/bookmakers/probe` — делает по 1 запросу
 * и возвращает HTTP-код, content-type, размер, latency и первые байты.
 *
 * ToS: использование этих API находится в серой зоне — пользователь предупреждён.
 */
import { Router, type IRouter } from 'express';
import { getRandomUserAgent } from '../lib/userAgents';
import { getApiKey } from '../services/ApiKeysService';

const router: IRouter = Router();

const BOOKMAKERS_ENABLED = process.env['BOOKMAKERS_ENABLED'] === 'true';
// PROXY_URL резолвится динамически через `getApiKey('PROXY_URL')` (см. ниже).

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

  const proxyUrl = getApiKey('PROXY_URL');
  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      const { default: nodeFetch } = await import('node-fetch');
      const agent = new HttpsProxyAgent(proxyUrl);
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

// URL-ы держим в отдельной таблице, чтобы probe-эндпоинт мог дёргать ровно тот
// же URL что и адаптер (без парсинга).
const SOURCE_URLS: Record<string, string> = {
  fonbet: 'https://line34.fonbet.ru/api/v1/line/sport/events?sport=12&count=50',
  liga_stavok:
    'https://line.ligastavok.ru/lsbets/api/v3/line/championships?sportFamilyKind=Esports&take=200',
  pari: 'https://pari.ru/api/v3/line/events?sportId=33&take=200',
  betboom: 'https://betboom.ru/api/v3/sports/40/line?take=200',
  x1stavka:
    'https://1xstavka.ru/LineFeed/Get1x2_VZip?sports=1620&count=200&lng=ru&mode=4&country=1&getEmpty=true',
  olimp: 'https://www.olimp.bet/ru/api/lines/get_events?sport=cybersport&subsport=dota-2&take=200',
};

const SOURCE_REFERERS: Record<string, { Origin: string; Referer: string }> = {
  fonbet: { Origin: 'https://www.fonbet.ru', Referer: 'https://www.fonbet.ru/sports/esports/' },
  liga_stavok: {
    Origin: 'https://www.ligastavok.ru',
    Referer: 'https://www.ligastavok.ru/bets/esports/dota',
  },
  pari: { Origin: 'https://pari.ru', Referer: 'https://pari.ru/cybersport/dota-2' },
  betboom: { Origin: 'https://betboom.ru', Referer: 'https://betboom.ru/sport/cybersport/dota-2' },
  x1stavka: {
    Origin: 'https://1xstavka.ru',
    Referer: 'https://1xstavka.ru/line/esports/dota-2/',
  },
  olimp: {
    Origin: 'https://www.olimp.bet',
    Referer: 'https://www.olimp.bet/ru/cybersport/dota-2',
  },
};

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

export const KNOWN_SOURCE_IDS = Object.keys(ADAPTERS);
export function getSourceName(id: string): string {
  return SOURCE_NAMES[id] ?? id;
}

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
      hint: getApiKey('PROXY_URL')
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
  const sources: Record<
    string,
    {
      name: string;
      available: boolean;
      cached: boolean;
      lastFetchedAt?: string;
      eventsCount?: number;
      lastError?: string;
    }
  > = {};
  for (const id of Object.keys(ADAPTERS)) {
    const cached = cache[id]?.value;
    sources[id] = {
      name: SOURCE_NAMES[id] ?? id,
      available: BOOKMAKERS_ENABLED,
      cached: !!getCached(id),
      ...(cached?.fetchedAt ? { lastFetchedAt: cached.fetchedAt } : {}),
      ...(cached ? { eventsCount: cached.events.length } : {}),
      ...(cached?.error ? { lastError: cached.error } : {}),
    };
  }
  res.json({
    enabled: BOOKMAKERS_ENABLED,
    proxyConfigured: !!getApiKey('PROXY_URL'),
    cacheTtlMs: CACHE_TTL_MS,
    sources,
    note: BOOKMAKERS_ENABLED
      ? 'Букмекерские источники активны. На non-RU IP может потребоваться PROXY_URL.'
      : 'Букмекерский функционал выключен. Установите BOOKMAKERS_ENABLED=true в ENV.',
  });
});

// ---------- Unified merge ----------
// Нормализуем имя команды для дедупликации: убираем кавычки/тире/пробелы,
// приводим к нижнему регистру. Простая эвристика, для EV-merge с pro_matches
// будет более строгий matcher (по teamId), но для UI-агрегатора достаточно.
function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`""«»]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function pairKey(team1: string, team2: string): string {
  const a = normalizeTeamName(team1);
  const b = normalizeTeamName(team2);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

interface MergedEvent {
  team1: string;
  team2: string;
  startsAt: string | null;
  sources: Array<{
    source: string;
    eventId: string;
    winner?: UnifiedMarketWinner;
  }>;
  bestWinner?: { team1: { source: string; odds: number }; team2: { source: string; odds: number } };
}

router.get('/merged/dota2', async (_req, res) => {
  if (!BOOKMAKERS_ENABLED) {
    res.status(503).json({
      enabled: false,
      error: 'BOOKMAKERS_ENABLED=false',
      hint: 'Букмекерский функционал выключен.',
    });
    return;
  }
  const all = await Promise.all(Object.keys(ADAPTERS).map((s) => fetchSource(s)));
  const byPair = new Map<string, MergedEvent>();
  for (const src of all) {
    if (!src.events.length) continue;
    for (const ev of src.events) {
      const orientation = normalizeTeamName(ev.team1) < normalizeTeamName(ev.team2);
      const key = pairKey(ev.team1, ev.team2);
      const team1 = orientation ? ev.team1 : ev.team2;
      const team2 = orientation ? ev.team2 : ev.team1;
      const winner = ev.markets.winner
        ? orientation
          ? ev.markets.winner
          : { team1: ev.markets.winner.team2, team2: ev.markets.winner.team1 }
        : undefined;
      let merged = byPair.get(key);
      if (!merged) {
        merged = { team1, team2, startsAt: ev.startsAt, sources: [] };
        byPair.set(key, merged);
      }
      merged.sources.push({ source: ev.source, eventId: ev.eventId, ...(winner ? { winner } : {}) });
      if (winner) {
        const cur = merged.bestWinner;
        if (!cur || winner.team1 > cur.team1.odds) {
          merged.bestWinner = {
            team1: { source: ev.source, odds: winner.team1 },
            team2: cur?.team2 ?? { source: ev.source, odds: winner.team2 },
          };
        }
        if (!cur || winner.team2 > (merged.bestWinner?.team2.odds ?? 0)) {
          merged.bestWinner = {
            team1: merged.bestWinner?.team1 ?? { source: ev.source, odds: winner.team1 },
            team2: { source: ev.source, odds: winner.team2 },
          };
        }
      }
    }
  }
  res.json({
    enabled: true,
    fetchedAt: new Date().toISOString(),
    count: byPair.size,
    events: Array.from(byPair.values()),
  });
});

// ---------- Probe (admin-only diagnostic) ----------
// Делает 1 сырой запрос к источнику, не кэширует ответ, возвращает диагностику.
// Используется admin-роутом /api/admin/bookmakers/probe для троблшутинга прода.
const probeRateLimit: Record<string, number> = {};
const PROBE_MIN_INTERVAL_MS = 30_000;

export interface SourceProbeResult {
  source: string;
  name: string;
  url: string;
  ok: boolean;
  httpStatus: number | null;
  contentType: string | null;
  bodySize: number | null;
  latencyMs: number;
  proxyUsed: boolean;
  bodyPreview: string;
  error?: string;
  rateLimited?: boolean;
}

export async function probeSource(id: string): Promise<SourceProbeResult> {
  const url = SOURCE_URLS[id];
  const name = getSourceName(id);
  if (!url) {
    return {
      source: id,
      name,
      url: '',
      ok: false,
      httpStatus: null,
      contentType: null,
      bodySize: null,
      latencyMs: 0,
      proxyUsed: false,
      bodyPreview: '',
      error: 'unknown_source',
    };
  }
  const now = Date.now();
  if (now - (probeRateLimit[id] ?? 0) < PROBE_MIN_INTERVAL_MS) {
    return {
      source: id,
      name,
      url,
      ok: false,
      httpStatus: null,
      contentType: null,
      bodySize: null,
      latencyMs: 0,
      proxyUsed: false,
      bodyPreview: '',
      error: `rate_limited (min ${PROBE_MIN_INTERVAL_MS / 1000}s between probes)`,
      rateLimited: true,
    };
  }
  probeRateLimit[id] = now;
  const proxyUsed = !!getApiKey('PROXY_URL');
  const start = Date.now();
  try {
    const headers = SOURCE_REFERERS[id] ?? { Origin: '', Referer: '' };
    const resp = await fetchWithProxy(url, headers);
    const text = await resp.text();
    return {
      source: id,
      name,
      url,
      ok: resp.ok,
      httpStatus: resp.status,
      contentType: resp.headers.get('content-type'),
      bodySize: text.length,
      latencyMs: Date.now() - start,
      proxyUsed,
      bodyPreview: text.slice(0, 200),
    };
  } catch (err) {
    return {
      source: id,
      name,
      url,
      ok: false,
      httpStatus: null,
      contentType: null,
      bodySize: null,
      latencyMs: Date.now() - start,
      proxyUsed,
      bodyPreview: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

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
