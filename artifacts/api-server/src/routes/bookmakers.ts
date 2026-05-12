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
 * Покрытие маркетов на 2026-05-12:
 *   - winner: pari, betboom, x1stavka, olimp (4/6).
 *   - totalKills / totalDuration: парсинг из markets-массива (PARI, BetBoom, 1xStavka).
 *     Fonbet / LigaStavok / Olimp — нужен per-event fetch (реализован ниже, требует PROXY_URL).
 *   - firstBlood: PARI, BetBoom.
 *   - Новый эндпоинт: GET /api/bookmakers/match-lines — агрегирует тоталы со всех источников.
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

// ---------- Totals parsing helpers ----------

type RawOutcome = { name?: string; coefficient?: number; coeff?: number; value?: number };
type RawMarket = { name?: string; type?: string; outcomes?: RawOutcome[]; coefs?: RawOutcome[] };

/**
 * Нормализует название исхода и извлекает тип (over/under) и линию.
 * Поддерживает: «Больше 42.5», «ТБ (42.5)», «Б 42», «Over 42.5»,
 *               «Меньше 43», «ТМ 43.5», «М 43», «Under 43».
 */
function parseOutcomeSide(name: string): { side: 'over' | 'under'; line: number } | null {
  const n = name.trim();
  const overRe = /^(?:больш|ТБ|тб|тотал больш|over|б\s|б\()[\s(]*([\d]+[.,][\d]+|[\d]+)/i;
  const underRe = /^(?:меньш|ТМ|тм|тотал меньш|under|м\s|м\()[\s(]*([\d]+[.,][\d]+|[\d]+)/i;
  let m = n.match(overRe);
  if (m) return { side: 'over', line: parseFloat(m[1].replace(',', '.')) };
  m = n.match(underRe);
  if (m) return { side: 'under', line: parseFloat(m[1].replace(',', '.')) };
  return null;
}

/**
 * Проверяет, относится ли имя маркета к тотал-убийствам.
 */
function isTotalKillsMarket(name: string): boolean {
  return /тотал.{0,20}убийств|убийств.{0,20}тотал|total\s+kills|kills?\s+total/i.test(name);
}

/**
 * Проверяет, относится ли имя маркета к длительности матча.
 */
function isTotalDurationMarket(name: string): boolean {
  return /длительн|продолж|duration|время.{0,10}матч|матч.{0,10}время/i.test(name);
}

/**
 * Проверяет, относится ли имя маркета к первой крови.
 */
function isFirstBloodMarket(name: string): boolean {
  return /перв.{0,10}кров|first\s+blood/i.test(name);
}

/**
 * Парсит outcomes маркета в список UnifiedMarketTotal[].
 * Ожидает пары over/under (либо по 2 исхода на линию, либо все over/under вперемешку).
 */
function parseTotalLinesFromOutcomes(outcomes: RawOutcome[]): UnifiedMarketTotal[] {
  const byLine = new Map<number, { over: number | null; under: number | null }>();
  for (const o of outcomes) {
    const name = o.name ?? '';
    const coeff = num(o.coefficient ?? o.coeff ?? o.value);
    if (!coeff) continue;
    const parsed = parseOutcomeSide(name);
    if (!parsed || !Number.isFinite(parsed.line)) continue;
    const entry = byLine.get(parsed.line) ?? { over: null, under: null };
    if (parsed.side === 'over') entry.over = coeff;
    else entry.under = coeff;
    byLine.set(parsed.line, entry);
  }
  return Array.from(byLine.entries())
    .filter(([, v]) => v.over !== null && v.under !== null)
    .sort((a, b) => a[0] - b[0])
    .map(([line, v]) => ({ line, over: v.over!, under: v.under! }));
}

/**
 * Парсит рынок первой крови из outcomes. Возвращает { yes, no } где:
 *   yes = P1/Radiant первая кровь, no = P2/Dire первая кровь.
 */
function parseFirstBloodFromOutcomes(outcomes: RawOutcome[]): UnifiedMarketBinary | null {
  if (outcomes.length < 2) return null;
  const y = num(outcomes[0].coefficient ?? outcomes[0].coeff);
  const n = num(outcomes[1].coefficient ?? outcomes[1].coeff);
  return y && n ? { yes: y, no: n } : null;
}

/**
 * Ищет и парсит тоталы из массива markets.
 * Возвращает результат: totalKills[], totalDuration[], firstBlood?.
 */
function extractMarketsFromRaw(
  markets: RawMarket[],
): { totalKills?: UnifiedMarketTotal[]; totalDuration?: UnifiedMarketTotal[]; firstBlood?: UnifiedMarketBinary } {
  let totalKills: UnifiedMarketTotal[] | undefined;
  let totalDuration: UnifiedMarketTotal[] | undefined;
  let firstBlood: UnifiedMarketBinary | undefined;

  for (const m of markets) {
    const name = m.name ?? m.type ?? '';
    const outcomes = m.outcomes ?? m.coefs ?? [];
    if (!totalKills && isTotalKillsMarket(name)) {
      const lines = parseTotalLinesFromOutcomes(outcomes);
      if (lines.length > 0) totalKills = lines;
    } else if (!totalDuration && isTotalDurationMarket(name)) {
      const lines = parseTotalLinesFromOutcomes(outcomes);
      if (lines.length > 0) totalDuration = lines;
    } else if (!firstBlood && isFirstBloodMarket(name)) {
      const fb = parseFirstBloodFromOutcomes(outcomes);
      if (fb) firstBlood = fb;
    }
  }
  return { totalKills, totalDuration, firstBlood };
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
  const url = 'https://pari.ru/api/v3/line/events?sportId=33&take=200';
  const resp = await fetchWithProxy(url, {
    'Origin': 'https://pari.ru',
    'Referer': 'https://pari.ru/cybersport/dota-2',
  });
  if (!resp.ok) throw new Error(`PARI HTTP ${resp.status}`);
  const raw = (await resp.json()) as {
    events?: Array<{
      id?: string;
      team1?: string;
      team2?: string;
      startsAt?: string;
      tournamentName?: string;
      status?: string;
      markets?: Array<{ name?: string; type?: string; outcomes?: Array<{ name?: string; coefficient?: number }> }>;
    }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.events ?? [])
    .filter((e) => (e.tournamentName ?? '').toLowerCase().includes('dota'))
    .map((e) => {
      const mktList = (e.markets ?? []) as RawMarket[];
      const winnerMkt = mktList.find(
        (m) => /победитель|winner/i.test(m.name ?? ''),
      );
      const t1 = num(winnerMkt?.outcomes?.[0]?.coefficient);
      const t2 = num(winnerMkt?.outcomes?.[1]?.coefficient);

      const { totalKills, totalDuration, firstBlood } = extractMarketsFromRaw(mktList);

      return {
        source: 'pari',
        eventId: String(e.id ?? ''),
        team1: e.team1 ?? '',
        team2: e.team2 ?? '',
        startsAt: e.startsAt ?? null,
        status: dotaStatus(e.status),
        markets: {
          ...(t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {}),
          ...(totalKills?.length ? { totalKills } : {}),
          ...(totalDuration?.length ? { totalDuration } : {}),
          ...(firstBlood ? { firstBlood } : {}),
        },
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((e) => e.team1 && e.team2);
  return { source: 'pari', isMock: false, events, fetchedAt: new Date().toISOString() };
}

async function adapterBetBoom(): Promise<SourceResponse> {
  // BetBoom — расширенный эндпоинт с маркетами
  const url = 'https://betboom.ru/api/v3/sports/40/line?take=200&withMarkets=true';
  const resp = await fetchWithProxy(url, {
    'Origin': 'https://betboom.ru',
    'Referer': 'https://betboom.ru/sport/cybersport/dota-2',
  });
  if (!resp.ok) throw new Error(`BetBoom HTTP ${resp.status}`);
  const raw = (await resp.json()) as {
    events?: Array<{
      id?: string;
      name?: string;
      team1?: string;
      team2?: string;
      beginAt?: string;
      sectionName?: string;
      status?: string;
      w1?: number;
      w2?: number;
      markets?: Array<{ name?: string; type?: string; outcomes?: Array<{ name?: string; coefficient?: number }> }>;
    }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.events ?? [])
    .filter((e) => (e.sectionName ?? '').toLowerCase().includes('dota'))
    .map((e) => {
      const t1 = num(e.w1);
      const t2 = num(e.w2);
      const mktList = (e.markets ?? []) as RawMarket[];
      const { totalKills, totalDuration, firstBlood } = extractMarketsFromRaw(mktList);
      return {
        source: 'betboom',
        eventId: String(e.id ?? ''),
        team1: e.team1 ?? '',
        team2: e.team2 ?? '',
        startsAt: e.beginAt ?? null,
        status: dotaStatus(e.status),
        markets: {
          ...(t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {}),
          ...(totalKills?.length ? { totalKills } : {}),
          ...(totalDuration?.length ? { totalDuration } : {}),
          ...(firstBlood ? { firstBlood } : {}),
        },
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((e) => e.team1 && e.team2);
  return { source: 'betboom', isMock: false, events, fetchedAt: new Date().toISOString() };
}

async function adapter1xStavka(): Promise<SourceResponse> {
  // 1xStavka LineFeed с маркетами. mode=4 = с тоталами.
  // T-коды: 1=П1, 3=П2, 9=ТБ (с параметром X), 10=ТМ (с параметром X)
  const url = 'https://1xstavka.ru/LineFeed/Get1x2_VZip?sports=1620&count=200&lng=ru&mode=4&country=1&getEmpty=true';
  const resp = await fetchWithProxy(url, {
    'Origin': 'https://1xstavka.ru',
    'Referer': 'https://1xstavka.ru/line/esports/dota-2/',
  });
  if (!resp.ok) throw new Error(`1xStavka HTTP ${resp.status}`);
  const raw = (await resp.json()) as {
    Value?: Array<{
      I?: number;
      O1?: string;
      O2?: string;
      S?: number;
      SE?: string;
      E?: Array<{ T?: number; C?: number; P?: number; G?: number }>;
    }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.Value ?? [])
    .map((e) => {
      const outcomes = e.E ?? [];
      const t1 = num(outcomes.find((o) => o.T === 1)?.C);
      const t2 = num(outcomes.find((o) => o.T === 3)?.C);

      // T=9 = ТБ (Больше), T=10 = ТМ (Меньше). P = линия, C = кэф, G = группа маркета
      // Группируем по G (группа = одна линия тотала)
      const byGroup = new Map<number, { over: number | null; under: number | null; line: number }>();
      for (const o of outcomes) {
        if ((o.T === 9 || o.T === 10) && o.G != null && o.P != null) {
          const entry = byGroup.get(o.G) ?? { over: null, under: null, line: o.P };
          if (o.T === 9) entry.over = num(o.C);
          else entry.under = num(o.C);
          entry.line = o.P;
          byGroup.set(o.G, entry);
        }
      }
      const totalKills: UnifiedMarketTotal[] = Array.from(byGroup.values())
        .filter((v) => v.over !== null && v.under !== null)
        .sort((a, b) => a.line - b.line)
        .map((v) => ({ line: v.line, over: v.over!, under: v.under! }));

      return {
        source: 'x1stavka',
        eventId: String(e.I ?? ''),
        team1: e.O1 ?? '',
        team2: e.O2 ?? '',
        startsAt: e.S ? new Date(e.S * 1000).toISOString() : null,
        status: dotaStatus(e.SE),
        markets: {
          ...(t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {}),
          ...(totalKills.length ? { totalKills } : {}),
        },
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

/**
 * GET /api/bookmakers/match-lines
 *
 * Агрегирует реальные тоталы (kills/duration) для конкретного матча
 * из всех доступных букмекеров. Матч ищется по именам команд (нечёткий).
 *
 * Запрос: ?team1=NAME1&team2=NAME2&type=kills|duration
 * Ответ:  { found: boolean, source?: string, lines?: number[], odds?: {over,under}[], eventId?: string }
 */
router.get('/match-lines', async (req, res) => {
  if (!BOOKMAKERS_ENABLED) {
    res.status(503).json({ found: false, reason: 'BOOKMAKERS_ENABLED=false' });
    return;
  }
  const team1 = String(req.query.team1 ?? '').trim();
  const team2 = String(req.query.team2 ?? '').trim();
  const type = String(req.query.type ?? 'kills');
  if (!team1 || !team2) {
    res.status(400).json({ found: false, reason: 'team1 and team2 are required' });
    return;
  }
  if (type !== 'kills' && type !== 'duration') {
    res.status(400).json({ found: false, reason: 'type must be kills or duration' });
    return;
  }

  // Перебираем источники в порядке приоритета (лучший охват маркетов — первый)
  const PRIORITY_SOURCES = ['pari', 'betboom', 'x1stavka', 'fonbet', 'liga_stavok', 'olimp'];

  for (const sourceId of PRIORITY_SOURCES) {
    let sourceData: SourceResponse | null = null;
    try {
      sourceData = await fetchSource(sourceId);
    } catch {
      continue;
    }
    if (!sourceData || sourceData.isMock || sourceData.events.length === 0) continue;

    const ev = sourceData.events.find(e => {
      const fwd = teamsMatch(team1, e.team1) && teamsMatch(team2, e.team2);
      const rev = teamsMatch(team1, e.team2) && teamsMatch(team2, e.team1);
      return fwd || rev;
    });
    if (!ev) continue;

    const mktData = type === 'kills' ? ev.markets.totalKills : ev.markets.totalDuration;
    if (!mktData || mktData.length === 0) continue;

    // Успех: нашли реальные линии
    res.json({
      found: true,
      source: sourceId,
      sourceName: SOURCE_NAMES[sourceId] ?? sourceId,
      eventId: ev.eventId,
      lines: mktData.map(m => m.line),
      odds: mktData.map(m => ({ over: m.over, under: m.under })),
      fetchedAt: new Date().toISOString(),
    });
    return;
  }

  res.json({ found: false, reason: 'no_data' });
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

// ---------- Upcoming-joined: join PandaScore upcoming + конкретный букмекер ----------
//
// GET /api/bookmakers/upcoming-joined?source=fonbet|liga_stavok|...|mock|all
//
// - all   → весь PandaScore upcoming (матчи всех тиров), без кэфов
// - mock  → весь PandaScore + синтетические детерминированные кэфы (для тестирования)
// - <bk>  → только матчи, присутствующие И в PandaScore И у выбранного букмекера
//           (нечёткий матч по именам команд); кэфы из ответа букмекера
//
// Ответ: { source, isMock, count, matches: JoinedMatch[] }
// Используется мобильным клиентом при выборе фильтра букмекера.

interface JoinedMatch {
  pandaScoreId: string | number;
  team1: string;
  team2: string;
  team1Id?: number;
  team2Id?: number;
  startsAt: string | null;
  tournament: string;
  numberOfGames: number;
  league_tier?: string;
  bookmakerEvent?: {
    source: string;
    sourceName: string;
    eventId: string;
    winner?: { team1: number; team2: number };
  };
}

// normalizeTeamName уже определена выше — переиспользуем.

function teamsMatch(psName: string, bkName: string): boolean {
  const a = normalizeTeamName(psName);
  const b = normalizeTeamName(bkName);
  if (a === b) return true;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length < b.length ? a : b;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  return false;
}

// Детерминированный hash-based псевдо-шанс победы для mock-кэфов.
// Один и тот же матч всегда получает одни и те же кэфы — не «прыгают» при рефреше.
function syntheticOdds(team1: string, team2: string): { team1: number; team2: number } {
  let h = 2166136261;
  for (const c of `${team1.toLowerCase()}|${team2.toLowerCase()}`) {
    h ^= c.charCodeAt(0);
    h = (Math.imul(h, 16777619) >>> 0);
  }
  const prob1 = 0.35 + (h % 30000) / 100000; // 35–65 %
  const vig = 0.05;
  const o1 = Math.round((1 / (prob1 + vig / 2)) * 100) / 100;
  const o2 = Math.round((1 / (1 - prob1 + vig / 2)) * 100) / 100;
  return { team1: o1, team2: o2 };
}

async function fetchPandaScoreUpcoming(apiKey: string, limit = 50): Promise<Record<string, unknown>[]> {
  const url = new URL('https://api.pandascore.co/dota2/matches/upcoming');
  url.searchParams.set('token', apiKey);
  url.searchParams.set('page[size]', String(limit));
  url.searchParams.set('sort', 'begin_at');
  url.searchParams.set('filter[status]', 'not_started');
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const resp = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: { 'User-Agent': getRandomUserAgent(), Accept: 'application/json' },
    });
    if (!resp.ok) return [];
    return (await resp.json()) as Record<string, unknown>[];
  } catch {
    return [];
  } finally {
    clearTimeout(tid);
  }
}

function psMatchToJoined(m: Record<string, unknown>): JoinedMatch | null {
  const opps = m['opponents'] as Array<{ opponent?: { id?: number; name?: string } }> | undefined;
  const t1 = (opps?.[0]?.opponent?.name ?? '').trim();
  const t2 = (opps?.[1]?.opponent?.name ?? '').trim();
  if (!t1 || !t2 || /^tbd$/i.test(t1) || /^tbd$/i.test(t2)) return null;
  const startMs = m['begin_at'] ? Date.parse(m['begin_at'] as string) : NaN;
  if (!Number.isFinite(startMs)) return null;
  const league = m['league'] as Record<string, unknown> | undefined;
  const serie = m['serie'] as Record<string, unknown> | undefined;
  const leagueName = String(
    (m['league_name'] as string | undefined) ??
    league?.['name'] ??
    serie?.['full_name'] ??
    'Pro Match',
  ).trim();
  return {
    pandaScoreId: m['id'] as string | number,
    team1: t1,
    team2: t2,
    team1Id: opps?.[0]?.opponent?.id,
    team2Id: opps?.[1]?.opponent?.id,
    startsAt: new Date(startMs).toISOString(),
    tournament: leagueName,
    numberOfGames: (m['number_of_games'] as number | undefined) ?? 3,
    league_tier: m['league_tier'] as string | undefined,
  };
}

router.get('/upcoming-joined', async (req, res) => {
  const pandascoreKey = getApiKey('PANDASCORE_API_KEY');
  const source = String(req.query.source ?? 'all').toLowerCase();

  // --- 1. Получаем PandaScore upcoming ---
  let psRaw: Record<string, unknown>[] = [];
  if (pandascoreKey) {
    psRaw = await fetchPandaScoreUpcoming(pandascoreKey, 50);
  }
  const psMatches = psRaw.map(psMatchToJoined).filter((m): m is JoinedMatch => m !== null);

  // --- 2. "all" — возвращаем всё без кэфов ---
  if (source === 'all') {
    res.json({ source: 'all', isMock: false, count: psMatches.length, matches: psMatches });
    return;
  }

  // --- 3. "mock" — синтетические кэфы для тестирования ---
  if (source === 'mock') {
    const withOdds: JoinedMatch[] = psMatches.map(m => ({
      ...m,
      bookmakerEvent: {
        source: 'mock',
        sourceName: 'Mock (тест)',
        eventId: `mock_${m.pandaScoreId}`,
        winner: syntheticOdds(m.team1, m.team2),
      },
    }));
    res.json({ source: 'mock', isMock: true, count: withOdds.length, matches: withOdds });
    return;
  }

  // --- 4. Конкретный букмекер — fetch + join ---
  const bkData = await fetchSource(source);
  if (!bkData || bkData.isMock || bkData.events.length === 0) {
    res.json({
      source,
      isMock: true,
      count: 0,
      matches: [],
      error: bkData?.error ?? 'no_data',
      hint: bkData?.hint ?? 'Букмекер недоступен. Возможно, требуется РФ-прокси (PROXY_URL).',
    });
    return;
  }

  const joined: JoinedMatch[] = [];
  for (const ps of psMatches) {
    const ev = bkData.events.find(e => {
      const fwd = teamsMatch(ps.team1, e.team1) && teamsMatch(ps.team2, e.team2);
      const rev = teamsMatch(ps.team1, e.team2) && teamsMatch(ps.team2, e.team1);
      return fwd || rev;
    });
    if (ev) {
      const swapped = teamsMatch(ps.team1, ev.team2) && teamsMatch(ps.team2, ev.team1);
      const raw = ev.markets.winner;
      const winner = raw
        ? (swapped ? { team1: raw.team2, team2: raw.team1 } : raw)
        : undefined;
      joined.push({
        ...ps,
        bookmakerEvent: {
          source: ev.source,
          sourceName: SOURCE_NAMES[ev.source] ?? ev.source,
          eventId: ev.eventId,
          ...(winner ? { winner } : {}),
        },
      });
    }
  }
  res.json({ source, isMock: false, count: joined.length, matches: joined });
});

export default router;
