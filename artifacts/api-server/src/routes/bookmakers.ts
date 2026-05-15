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
import { logger as bookmakerLogger } from '../lib/logger';

const router: IRouter = Router();

// Дефолт включён: с Replit-IP реально работает Bovada (US-IP, без ключа).
// 6 РФ-букмекеров требуют PROXY_URL — без него вернут пустой массив, но фича
// в целом активна. Жёсткое выключение: BOOKMAKERS_ENABLED=false.
const BOOKMAKERS_ENABLED = process.env['BOOKMAKERS_ENABLED'] !== 'false';
// PROXY_URL резолвится динамически через `getApiKey('PROXY_URL')` (см. ниже).

const REQUEST_DELAY_MS = 1500;
// TTL покрывает максимальный интервал BookmakerWorker (idle = 60 мин) + grace.
// Воркер сам пишет в кэш каждые 3 мин (live) / 60 мин (idle), эндпоинты читают.
// Если воркер мёртв — on-demand fetch отрабатывает после истечения TTL.
const CACHE_TTL_MS = 65 * 60_000;
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
export interface UnifiedMarketMapWinner {
  map: number;
  team1: number;
  team2: number;
}
export interface UnifiedMarketCorrectScore {
  score: string; // '2-0', '2-1', '1-2', '0-2'
  price: number;
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
    /** Победители отдельных карт (Bovada Live Map 1/2/3) */
    mapWinners?: UnifiedMarketMapWinner[];
    /** Тотал карт в серии (например 2.5 для bo3) */
    totalMaps?: UnifiedMarketTotal[];
    /** Счёт серии: 2-0 / 2-1 / 1-2 / 0-2 */
    correctScore?: UnifiedMarketCorrectScore[];
  };
  updatedAt: string;
}

interface SourceResponse {
  source: string;
  noData: boolean;
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
  return { source: 'fonbet', noData: false, events, fetchedAt: new Date().toISOString() };
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
  return { source: 'liga_stavok', noData: false, events, fetchedAt: new Date().toISOString() };
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
  return { source: 'pari', noData: false, events, fetchedAt: new Date().toISOString() };
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
  return { source: 'betboom', noData: false, events, fetchedAt: new Date().toISOString() };
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
  return { source: 'x1stavka', noData: false, events, fetchedAt: new Date().toISOString() };
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
  return { source: 'olimp', noData: false, events, fetchedAt: new Date().toISOString() };
}

// ── Bovada (US-licensed, public JSON, без ключа, проходит с Replit-IP) ──
// Покрывает: winner серии (Moneyline @ Game), winner отдельных карт
// (Moneyline @ Live Map N), тоталы карт в серии (Total @ Game), ТБ/ТМ киллов
// (Under/Over Kills @ Live Map N), счёт серии (Correct Score), форы.
// Используется как живой источник кэфов на Replit, где РФ-буки заблокированы.
async function adapterBovada(): Promise<SourceResponse> {
  const url =
    'https://www.bovada.lv/services/sports/event/coupon/events/A/description/esports/dota-2';
  const resp = await fetchWithProxy(url, {
    Origin: 'https://www.bovada.lv',
    Referer: 'https://www.bovada.lv/sports/esports/dota-2',
  });
  if (!resp.ok) throw new Error(`Bovada HTTP ${resp.status}`);
  const raw = (await resp.json()) as Array<{
    events?: Array<{
      id?: string | number;
      description?: string;
      startTime?: number;
      competitors?: Array<{ name?: string; home?: boolean }>;
      displayGroups?: Array<{
        description?: string;
        markets?: Array<{
          description?: string;
          period?: { description?: string };
          outcomes?: Array<{
            description?: string;
            price?: { decimal?: string | number; handicap?: string | number };
          }>;
        }>;
      }>;
    }>;
  }>;

  const events: UnifiedBookmakerEvent[] = [];
  for (const chunk of raw) {
    for (const e of chunk.events ?? []) {
      const competitors = (e.competitors ?? []).map((c) => c.name ?? '').filter(Boolean);
      if (competitors.length < 2) continue;
      const t1Name = competitors[0]!;
      const t2Name = competitors[1]!;

      const winner: UnifiedMarketWinner | undefined = (() => {
        for (const grp of e.displayGroups ?? []) {
          for (const m of grp.markets ?? []) {
            if (
              (m.description ?? '').toLowerCase() === 'moneyline' &&
              (m.period?.description ?? '').toLowerCase() === 'game'
            ) {
              const o1 = num(m.outcomes?.[0]?.price?.decimal);
              const o2 = num(m.outcomes?.[1]?.price?.decimal);
              if (o1 && o2) return { team1: o1, team2: o2 };
            }
          }
        }
        return undefined;
      })();

      const mapWinners: UnifiedMarketMapWinner[] = [];
      const totalKills: UnifiedMarketTotal[] = [];
      const totalMaps: UnifiedMarketTotal[] = [];
      const correctScore: UnifiedMarketCorrectScore[] = [];

      for (const grp of e.displayGroups ?? []) {
        for (const m of grp.markets ?? []) {
          const desc = (m.description ?? '').toLowerCase();
          const period = (m.period?.description ?? '').toLowerCase();
          const outcomes = m.outcomes ?? [];

          // Map-level winner: "Moneyline" @ "Map N"
          const mapMatch = period.match(/^map (\d+)$/);
          if (mapMatch && desc === 'moneyline' && outcomes.length >= 2) {
            const o1 = num(outcomes[0]?.price?.decimal);
            const o2 = num(outcomes[1]?.price?.decimal);
            if (o1 && o2) mapWinners.push({ map: Number(mapMatch[1]), team1: o1, team2: o2 });
          }

          // Total maps in series: "Total" @ "Game"
          if (desc === 'total' && period === 'game') {
            for (let i = 0; i < outcomes.length; i += 2) {
              const over = outcomes[i];
              const under = outcomes[i + 1];
              const line = num(over?.price?.handicap);
              const o = num(over?.price?.decimal);
              const u = num(under?.price?.decimal);
              if (line && o && u) totalMaps.push({ line, over: o, under: u });
            }
          }

          // Per-map kills total: "Under/Over Kills" @ "Map N"
          if (mapMatch && desc === 'under/over kills') {
            for (let i = 0; i < outcomes.length; i += 2) {
              const over = outcomes[i];
              const under = outcomes[i + 1];
              const line = num(over?.price?.handicap);
              const o = num(over?.price?.decimal);
              const u = num(under?.price?.decimal);
              if (line && o && u) totalKills.push({ line, over: o, under: u });
            }
          }

          // Correct score for series: "Correct Score" @ "Game"
          if (desc === 'correct score' && period === 'game') {
            for (const oc of outcomes) {
              const score = (oc.description ?? '').replace(/\s+/g, '');
              const price = num(oc.price?.decimal);
              if (score && price) correctScore.push({ score, price });
            }
          }
        }
      }

      const markets: UnifiedBookmakerEvent['markets'] = {};
      if (winner) markets.winner = winner;
      if (mapWinners.length) markets.mapWinners = mapWinners;
      if (totalKills.length) markets.totalKills = totalKills;
      if (totalMaps.length) markets.totalMaps = totalMaps;
      if (correctScore.length) markets.correctScore = correctScore;

      events.push({
        source: 'bovada',
        eventId: String(e.id ?? ''),
        team1: t1Name,
        team2: t2Name,
        startsAt: e.startTime ? new Date(e.startTime).toISOString() : null,
        status: 'unknown',
        markets,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return { source: 'bovada', noData: events.length === 0, events, fetchedAt: new Date().toISOString() };
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
  bovada:
    'https://www.bovada.lv/services/sports/event/coupon/events/A/description/esports/dota-2',
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
  bovada: {
    Origin: 'https://www.bovada.lv',
    Referer: 'https://www.bovada.lv/sports/esports/dota-2',
  },
};

const ADAPTERS: Record<string, () => Promise<SourceResponse>> = {
  fonbet: adapterFonbet,
  liga_stavok: adapterLigaStavok,
  pari: adapterPari,
  betboom: adapterBetBoom,
  x1stavka: adapter1xStavka,
  olimp: adapterOlimp,
  bovada: adapterBovada,
};

const SOURCE_NAMES: Record<string, string> = {
  fonbet: 'Fonbet',
  liga_stavok: 'Лига Ставок',
  pari: 'PARI',
  betboom: 'BetBoom',
  x1stavka: '1xStavka',
  olimp: 'Olimp.bet',
  bovada: 'Bovada',
};

export const KNOWN_SOURCE_IDS = Object.keys(ADAPTERS);
export function getAllSourceIds(): string[] { return Object.keys(ADAPTERS); }
export function isBookmakersEnabled(): boolean { return BOOKMAKERS_ENABLED; }
export function getSourceName(id: string): string {
  return SOURCE_NAMES[id] ?? id;
}
export function clearBookmakerCache(): void {
  for (const key of Object.keys(cache)) delete cache[key];
}

// ---------- Helpers used by routes ----------

function disabledResponse(source: string): SourceResponse {
  return {
    source,
    noData: true,
    events: [],
    fetchedAt: new Date().toISOString(),
    error: 'BOOKMAKERS_ENABLED=false',
    hint: 'Букмекерский функционал выключен на этом инстансе. Включите через ENV BOOKMAKERS_ENABLED=true (требуется РФ-IP или PROXY_URL).',
  };
}

export async function fetchSource(source: string, opts?: { force?: boolean }): Promise<SourceResponse> {
  if (!BOOKMAKERS_ENABLED) return disabledResponse(source);

  const cached = getCached(source);
  if (cached && !opts?.force) return cached;

  if (rateLimit(source)) {
    return cached ?? {
      source,
      noData: true,
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
      noData: true,
      events: [],
      fetchedAt: new Date().toISOString(),
      error: `unknown_source:${source}`,
    };
  }

  const startedAt = Date.now();
  try {
    const result = await adapter();
    const durationMs = Date.now() - startedAt;
    bookmakerLogger.info(
      { tag: 'bookmaker', source, events: result.events.length, durationMs, error: result.error ?? null },
      '[bookmaker] fetched',
    );
    setCached(source, result);
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errMsg = err instanceof Error ? err.message : String(err);
    bookmakerLogger.warn({ tag: 'bookmaker', source, durationMs, err: errMsg }, '[bookmaker] fetch failed');
    const fail: SourceResponse = {
      source,
      noData: true,
      events: [],
      fetchedAt: new Date().toISOString(),
      error: errMsg,
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

router.get('/status', async (_req, res) => {
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
  const { getBookmakerWorkerStats } = await import('../services/BookmakerWorker');
  res.json({
    enabled: BOOKMAKERS_ENABLED,
    proxyConfigured: !!getApiKey('PROXY_URL'),
    cacheTtlMs: CACHE_TTL_MS,
    sources,
    worker: getBookmakerWorkerStats(),
    note: BOOKMAKERS_ENABLED
      ? 'Букмекерские источники активны. На non-RU IP может потребоваться PROXY_URL.'
      : 'Букмекерский функционал выключен. Установите BOOKMAKERS_ENABLED=true в ENV.',
  });
});

// ---------- Per-match lookup ----------
// GET /api/bookmakers/for-match?team1=Name1&team2=Name2[&team1Id=X&team2Id=Y]
// Возвращает агрегированные кэфы по конкретной паре команд из кэша воркера.
// Skip silently: если ни один источник не имеет события для этой пары — { found:false, sources:[] }.
// Используется мобилкой для отображаемых матчей: один lookup на матч (или
// несколько в параллель, всё из in-memory кэша — без апстрим-нагрузки).
router.get('/for-match', async (req, res) => {
  if (!BOOKMAKERS_ENABLED) {
    res.status(503).json({ enabled: false, error: 'BOOKMAKERS_ENABLED=false' });
    return;
  }
  const team1 = String(req.query['team1'] ?? '').trim();
  const team2 = String(req.query['team2'] ?? '').trim();
  const team1Id = req.query['team1Id'] ? Number(req.query['team1Id']) : null;
  const team2Id = req.query['team2Id'] ? Number(req.query['team2Id']) : null;
  if (!team1 || !team2) {
    res.status(400).json({ error: 'team1 and team2 query params required' });
    return;
  }
  const wantPair = pairKey(team1, team2);
  const all = await Promise.all(Object.keys(ADAPTERS).map((s) => fetchSource(s)));
  const sources: Array<{
    source: string;
    eventId: string;
    startsAt: string | null;
    status: UnifiedBookmakerEvent['status'];
    markets: UnifiedBookmakerEvent['markets'];
    flipped: boolean;
  }> = [];
  for (const src of all) {
    if (!src.events.length) continue;
    for (const ev of src.events) {
      if (pairKey(ev.team1, ev.team2) !== wantPair) continue;
      // Определяем ориентацию: совпадает ли ev.team1 с запрошенным team1 после нормализации
      const sameOrder = normalizeTeamName(ev.team1) === normalizeTeamName(team1);
      const markets: UnifiedBookmakerEvent['markets'] = sameOrder
        ? ev.markets
        : {
            ...(ev.markets.winner
              ? { winner: { team1: ev.markets.winner.team2, team2: ev.markets.winner.team1 } }
              : {}),
            ...(ev.markets.totalKills ? { totalKills: ev.markets.totalKills } : {}),
            ...(ev.markets.totalDuration ? { totalDuration: ev.markets.totalDuration } : {}),
            ...(ev.markets.firstBlood ? { firstBlood: ev.markets.firstBlood } : {}),
          };
      sources.push({
        source: ev.source,
        eventId: ev.eventId,
        startsAt: ev.startsAt,
        status: ev.status,
        markets,
        flipped: !sameOrder,
      });
    }
  }
  const sourcesPolled = all.map((s) => ({ source: s.source, events: s.events.length, error: s.error ?? null }));
  res.json({
    enabled: true,
    found: sources.length > 0,
    team1,
    team2,
    team1Id,
    team2Id,
    sources,
    sourcesPolled,
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

// ---------- Matched: bookmaker events ↔ teams in our DB ----------
// Цель — вернуть массив букмекерских событий, у которых имена обеих команд
// удалось матчить с teamsTable (по нормализованным именам). Это даёт мобилке
// прямой ключ team1_id / team2_id, который она уже использует в карточках
// /api/matches/live и /api/matches/upcoming. Группировку «наш матч → букмекеры»
// делаем на клиенте (он у себя имеет полный контекст match.id).
//
// Маркеты: возвращаем UnifiedBookmakerEvent.markets как есть (winner / totalKills
// / totalMaps / mapWinners / correctScore / firstBlood / totalDuration), чтобы
// UI мог по своему усмотрению выводить кэф рядом с любым нашим прогнозом.
router.get('/matched/dota2', async (req, res) => {
  const t0 = Date.now();
  if (!BOOKMAKERS_ENABLED) {
    res.status(503).json({
      enabled: false,
      error: 'BOOKMAKERS_ENABLED=false',
      hint: 'Букмекерский функционал выключен.',
    });
    return;
  }
  // Тянем все источники параллельно, любые ошибки уже инкапсулированы
  // в SourceResponse.error и фильтруются по noData.
  const all = await Promise.all(Object.keys(ADAPTERS).map((s) => fetchSource(s)));

  // Команды из БД — нормализуем имя для fuzzy-матча.
  const { db, teamsTable } = await import('@workspace/db');
  const teams = await db.select({ teamId: teamsTable.teamId, name: teamsTable.name, tag: teamsTable.tag }).from(teamsTable);
  const byNorm = new Map<string, { teamId: number; name: string }>();
  for (const t of teams) {
    const norm = normalizeTeamName(t.name ?? '');
    if (norm) byNorm.set(norm, { teamId: t.teamId, name: t.name ?? '' });
    if (t.tag) {
      const tagNorm = normalizeTeamName(t.tag);
      // Tag матч слабее чем по имени, но даёт покрытие для коротких имён ('OG', 'BB').
      if (tagNorm && !byNorm.has(tagNorm)) byNorm.set(tagNorm, { teamId: t.teamId, name: t.name ?? '' });
    }
  }

  type MatchedEvent = UnifiedBookmakerEvent & {
    matched: boolean;
    team1Id: number | null;
    team2Id: number | null;
    team1Canonical: string | null;
    team2Canonical: string | null;
  };
  const enriched: MatchedEvent[] = [];
  for (const src of all) {
    if (!src.events.length) continue;
    for (const ev of src.events) {
      const t1 = byNorm.get(normalizeTeamName(ev.team1));
      const t2 = byNorm.get(normalizeTeamName(ev.team2));
      enriched.push({
        ...ev,
        matched: !!(t1 && t2),
        team1Id: t1?.teamId ?? null,
        team2Id: t2?.teamId ?? null,
        team1Canonical: t1?.name ?? null,
        team2Canonical: t2?.name ?? null,
      });
    }
  }

  // Группируем по упорядоченной паре team_id — чтобы UI получил единый ключ
  // на разные источники для одного и того же матча.
  type Group = {
    pairKey: string;
    team1Id: number | null;
    team2Id: number | null;
    team1: string;
    team2: string;
    startsAt: string | null;
    sources: MatchedEvent[];
  };
  const groups = new Map<string, Group>();
  for (const ev of enriched) {
    const key = ev.matched && ev.team1Id && ev.team2Id
      ? (ev.team1Id < ev.team2Id ? `${ev.team1Id}|${ev.team2Id}` : `${ev.team2Id}|${ev.team1Id}`)
      : `name:${pairKey(ev.team1, ev.team2)}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        pairKey: key,
        team1Id: ev.team1Id,
        team2Id: ev.team2Id,
        team1: ev.team1Canonical ?? ev.team1,
        team2: ev.team2Canonical ?? ev.team2,
        startsAt: ev.startsAt,
        sources: [],
      };
      groups.set(key, g);
    }
    g.sources.push(ev);
  }

  const sourcesPolled = all.map((s) => ({ source: s.source, events: s.events.length, error: s.error ?? null }));
  const matchedCount = enriched.filter((e) => e.matched).length;
  req.log.info(
    {
      tag: 'matched',
      durationMs: Date.now() - t0,
      groups: groups.size,
      eventsTotal: enriched.length,
      matchedToTeams: matchedCount,
      teamsLoaded: byNorm.size,
      sourcesPolled,
    },
    '[bookmaker] /matched/dota2 done',
  );
  res.json({
    enabled: true,
    fetchedAt: new Date().toISOString(),
    sourcesPolled,
    count: groups.size,
    matched: Array.from(groups.values()),
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
