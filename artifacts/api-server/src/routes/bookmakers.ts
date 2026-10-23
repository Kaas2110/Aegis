/** Public bookmaker feeds. External polling is performed only by BookmakerWorker/admin refresh.
 * Public routes read observations with source receipt times and exclude stale prices.
 * Source URLs and schemas verified against official public sites on 2026-10-03.
 */
import { Router, type IRouter } from 'express';
import { getRandomUserAgent } from '../lib/userAgents';
import { logger as bookmakerLogger } from '../lib/logger';
import { normalizeTeamName, orientBookmakerMarkets, unambiguousSourceEvents } from '../services/BookmakerMatcher';
import {parseBovada, parseFonbetLine, parseOlimp} from '../services/BookmakerParsers';
import {fetchBookmaker} from '../services/BookmakerTransport';

const router: IRouter = Router();

// Sources remain selectable; actual availability is reported separately.
const BOOKMAKERS_ENABLED = process.env['BOOKMAKERS_ENABLED'] !== 'false';
// An explicitly empty allowlist disables every source; only an unset variable
// preserves the legacy behaviour of polling all adapters.
const sourceAllowlistValue = process.env['BOOKMAKER_SOURCES'];
const sourceAllowlist = sourceAllowlistValue === undefined
  ? null
  : new Set(sourceAllowlistValue.split(',').map(id => id.trim().toLowerCase()).filter(Boolean));

const REQUEST_DELAY_MS = 1500;
// TTL покрывает максимальный интервал BookmakerWorker (idle = 60 мин) + grace.
// Воркер сам пишет в кэш каждые 3 мин (live) / 60 мин (idle), эндпоинты читают.
// Если воркер остановлен, чтение возвращает stale; запросов по требованию нет.
const CACHE_TTL_MS = 65 * 60_000;
const FAILURE_CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 12_000;
const RETRY_DELAY_MS = 1_000;

// ---------- Unified shape ----------

export interface UnifiedMarketWinner {
  team1: number;
  team2: number;
}
export interface UnifiedMarketTotal {
  line: number;
  over: number;
  under: number;
  scope?: 'series' | 'map';
  map?: number;
  unit?: 'kills' | 'minutes' | 'maps';
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
  receivedAt?: string;
  sourceUpdatedAt?: string | null;
  scope?: 'series' | 'map';
  expiresAt?: string;
}

interface SourceResponse {
  source: string;
  noData: boolean;
  events: UnifiedBookmakerEvent[];
  fetchedAt: string;
  stale?: boolean;
  unavailable?: boolean;
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
  const ttl = entry.value.error ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - entry.fetchedAt >= ttl) return null;
  return entry.value;
}

function setCached(source: string, value: SourceResponse): void {
  cache[source] = { fetchedAt: Date.now(), value };
}

// ---------- HTTP ----------

// Native fetch respects the process network configuration. No system proxy is changed.
async function fetchWithProxy(url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Cache-Control': 'no-cache',
    'X-Requested-With': 'XMLHttpRequest',
    ...extraHeaders,
  };

  // The signal must remain active while adapters consume response.json()/text().
  // Clearing a manual timer after headers leaves a stalled body unbounded.
  const response = await fetchBookmaker(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const contentType=response.headers.get('content-type') ?? '';
  if(contentType.includes('text/html')) throw new Error('HTTP '+response.status+' unexpected_content_type:text/html (website/challenge, not an odds API)');
  return response;
}

function isTransientSourceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  if (err instanceof TypeError && err.message === 'fetch failed') return true;
  // Adapter HTTP failures carry their status; parsing errors/challenges and
  // other 4xx responses deliberately receive no automatic retry.
  return /\bHTTP (?:429|5\d{2})\b/.test(err.message);
}

async function fetchAdapterWithRetry(adapter: () => Promise<SourceResponse>): Promise<SourceResponse> {
  try {
    return await adapter();
  } catch (err) {
    if (!isTransientSourceError(err)) throw err;
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    return adapter(); // At most two attempts, including body-read failures.
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

// ---------- Per-source request / response tracker ----------

export interface SourceTickStatus {
  ok: boolean;
  events: number;
  error: string | null;
  checkedAt: string;
  durationMs: number;
}

interface SourceCounter {
  requestsTotal: number;
  responsesOk: number;
  lastStatus: SourceTickStatus | null;
}

const sourceCounters: Record<string, SourceCounter> = {};

function getCounter(source: string): SourceCounter {
  if (!sourceCounters[source]) {
    sourceCounters[source] = { requestsTotal: 0, responsesOk: 0, lastStatus: null };
  }
  return sourceCounters[source]!;
}

/** ENV-name → bookmaker source-id mapping for admin integrations enrichment. */
export const ENV_NAME_TO_SOURCE: Record<string, string> = {
  FONBET_API_KEY: 'fonbet',
  LIGASTAVOK_API_KEY: 'liga_stavok',
  PARI_API_KEY: 'pari',
  BETBOOM_API_KEY: 'betboom',
  X1STAVKA_API_KEY: 'x1stavka',
  OLIMP_API_KEY: 'olimp',
};

export function getSourceTrackers(): Record<string, { requestsTotal: number; responsesOk: number; lastStatus: SourceTickStatus | null }> {
  const result: Record<string, { requestsTotal: number; responsesOk: number; lastStatus: SourceTickStatus | null }> = {};
  for (const [k, v] of Object.entries(sourceCounters)) {
    result[k] = { requestsTotal: v.requestsTotal, responsesOk: v.responsesOk, lastStatus: v.lastStatus };
  }
  return result;
}

// ---------- Adapters ----------

async function adapterFonbet(): Promise<SourceResponse> {
  const resp=await fetchWithProxy(SOURCE_URLS.fonbet!, SOURCE_REFERERS.fonbet);
  if(!resp.ok)throw new Error('Fonbet HTTP '+resp.status);
  const raw=await resp.json(),receivedAt=new Date().toISOString();
  const events=parseFonbetLine(raw,'fonbet',receivedAt);
  return {source:'fonbet',noData:events.length===0,events,fetchedAt:receivedAt};
}

async function adapterLigaStavok(): Promise<SourceResponse> {
  // Step 1: fetch championships list to get championship IDs for Dota 2.
  const champsUrl = 'https://line.ligastavok.ru/lsbets/api/v3/line/championships?sportFamilyKind=Esports&take=200';
  const champsResp = await fetchWithProxy(champsUrl, {
    'Origin': 'https://www.ligastavok.ru',
    'Referer': 'https://www.ligastavok.ru/bets/esports/dota',
  });
  if (!champsResp.ok) throw new Error(`LigaStavok championships HTTP ${champsResp.status}`);
  const champsRaw = (await champsResp.json()) as {
    data?: Array<{
      id?: string | number;
      name?: string;
      sport?: { name?: string };
      sportFamily?: { name?: string };
      events?: Array<{
        id?: string;
        name?: string;
        team1?: string;
        team2?: string;
        startsAt?: string;
        // Markets may be inline (varies by API version)
        markets?: Array<{ name?: string; outcomes?: Array<{ name?: string; odds?: number; coefficient?: number }> }>;
        odds?: { w1?: number; w2?: number };
      }>;
    }> | { events?: Array<{ id?: string; name?: string; team1?: string; team2?: string; startsAt?: string; tournament?: { sport?: string }; markets?: Array<{ name?: string; outcomes?: Array<{ name?: string; odds?: number; coefficient?: number }> }> }> };
  };

  // The API may return an array of championships OR a single object with events
  type LsEvent = {
    id?: string;
    name?: string;
    team1?: string;
    team2?: string;
    startsAt?: string;
    markets?: Array<{ name?: string; outcomes?: Array<{ name?: string; odds?: number; coefficient?: number }> }>;
    tournament?: { sport?: string };
    odds?: { w1?: number; w2?: number };
  };

  let evList: LsEvent[] = [];
  if (Array.isArray(champsRaw.data)) {
    for (const champ of champsRaw.data) {
      const champName = (champ.name ?? '').toLowerCase();
      const sportName = (champ.sport?.name ?? champ.sportFamily?.name ?? '').toLowerCase();
      if (!champName.includes('dota') && !sportName.includes('dota')) continue;
      evList.push(...(champ.events ?? []));
    }
  } else if (champsRaw.data && 'events' in champsRaw.data) {
    const d = champsRaw.data as { events?: LsEvent[] };
    evList = (d.events ?? []).filter((e) => (e.tournament?.sport ?? '').toLowerCase().includes('dota'));
  }

  const getOdds = (o: { odds?: number; coefficient?: number } | undefined) =>
    num(o?.odds) ?? num(o?.coefficient) ?? null;

  const events: UnifiedBookmakerEvent[] = evList
    .map((e) => {
      const winnerMkt = (e.markets ?? []).find((m) => {
        const n = (m.name ?? '').toLowerCase();
        return n.includes('победитель') || n.includes('winner') || n === 'п1/п2' || n === 'исход';
      });
      const t1 = winnerMkt?.outcomes?.[0] ? getOdds(winnerMkt.outcomes[0]) : num(e.odds?.w1) ?? null;
      const t2 = winnerMkt?.outcomes?.[1] ? getOdds(winnerMkt.outcomes[1]) : num(e.odds?.w2) ?? null;

      // Parse kill totals if present
      const killsMkt = (e.markets ?? []).find((m) => {
        const n = (m.name ?? '').toLowerCase();
        return (n.includes('убийств') || n.includes('kill') || n.includes('фраг')) && (n.includes('тотал') || n.includes('total'));
      });
      const killsLines: UnifiedMarketTotal[] = [];
      if (killsMkt?.outcomes && killsMkt.outcomes.length >= 2) {
        for (let i = 0; i + 1 < killsMkt.outcomes.length; i += 2) {
          const o = killsMkt.outcomes[i];
          const u = killsMkt.outcomes[i + 1];
          const lineMatch = (o?.name ?? '').match(/(\d+\.?\d*)/);
          const line = lineMatch ? parseFloat(lineMatch[1]!) : null;
          const over = getOdds(o);
          const under = getOdds(u);
          if (line !== null && over !== null && under !== null) killsLines.push({ line, over, under });
        }
      }

      return {
        source: 'liga_stavok',
        eventId: String(e.id ?? ''),
        team1: e.team1 ?? '',
        team2: e.team2 ?? '',
        startsAt: e.startsAt ?? null,
        status: 'unknown' as const,
        markets: {
          ...(t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {}),
          ...(killsLines.length > 0 ? { totalKills: killsLines } : {}),
        },
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((e) => e.team1 && e.team2);
  return { source: 'liga_stavok', noData: false, events, fetchedAt: new Date().toISOString() };
}

async function adapterPari(): Promise<SourceResponse> {
  const resp=await fetchWithProxy(SOURCE_URLS.pari!, SOURCE_REFERERS.pari);
  if(!resp.ok)throw new Error('PARI HTTP '+resp.status);
  const raw=await resp.json(),receivedAt=new Date().toISOString();
  const events=parseFonbetLine(raw,'pari',receivedAt);
  return {source:'pari',noData:events.length===0,events,fetchedAt:receivedAt};
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
    events?: Array<{
      id?: string;
      name?: string;
      team1?: string;
      team2?: string;
      beginAt?: string;
      sectionName?: string;
      w1?: number;
      w2?: number;
      // Extended markets (present when endpoint returns full event detail)
      markets?: Array<{ name?: string; outcomes?: Array<{ name?: string; value?: number; coefficient?: number }> }>;
      totals?: Array<{ name?: string; type?: string; value?: number; over?: number; under?: number }>;
    }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.events ?? [])
    .filter((e) => (e.sectionName ?? '').toLowerCase().includes('dota'))
    .map((e) => {
      const t1 = num(e.w1);
      const t2 = num(e.w2);

      // Try to parse totalKills from markets or totals sub-arrays (if endpoint includes them)
      const killsLines: UnifiedMarketTotal[] = [];
      for (const m of e.markets ?? []) {
        const n = (m.name ?? '').toLowerCase();
        if ((n.includes('убийств') || n.includes('kill') || n.includes('фраг')) && (n.includes('тотал') || n.includes('total'))) {
          const outcomes = m.outcomes ?? [];
          for (let i = 0; i + 1 < outcomes.length; i += 2) {
            const o = outcomes[i];
            const u = outcomes[i + 1];
            const lineMatch = (o?.name ?? '').match(/(\d+\.?\d*)/);
            const line = lineMatch ? parseFloat(lineMatch[1]!) : null;
            const over = num(o?.value ?? o?.coefficient);
            const under = num(u?.value ?? u?.coefficient);
            if (line !== null && over !== null && under !== null) killsLines.push({ line, over, under });
          }
        }
      }
      for (const t of e.totals ?? []) {
        const n = (t.name ?? t.type ?? '').toLowerCase();
        if (n.includes('убийств') || n.includes('kill') || n.includes('фраг')) {
          const line = num(t.value);
          const over = num(t.over);
          const under = num(t.under);
          if (line !== null && over !== null && under !== null) killsLines.push({ line, over, under });
        }
      }

      return {
        source: 'betboom',
        eventId: String(e.id ?? ''),
        team1: e.team1 ?? '',
        team2: e.team2 ?? '',
        startsAt: e.beginAt ?? null,
        status: 'unknown' as const,
        markets: {
          ...(t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {}),
          ...(killsLines.length > 0 ? { totalKills: killsLines } : {}),
        },
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
  const base='https://www.olimp.bet/api/v4/0';
  const events: UnifiedBookmakerEvent[]=[];
  // Both feeds are background-only. Full detail is bounded to 24 Dota events
  // per feed/cycle, two in flight, so market completeness never causes a flood.
  for(const phase of ['line','live'] as const){
    const response=await fetchWithProxy(base+'/'+phase+'/sports-with-competitions-with-events?vids%5B%5D=112%3A',SOURCE_REFERERS.olimp);
    if(!response.ok)throw new Error('Olimp HTTP '+response.status);
    const raw=await response.json();
    const receipt=new Date().toISOString();
    const summaries=parseOlimp(raw,phase==='live',receipt);
    for(let offset=0;offset<summaries.length;offset+=2){
      const group=summaries.slice(offset,Math.min(offset+2,24));
      if(!group.length)break;
      const details=await Promise.all(group.map(async event=>{
        const r=await fetchWithProxy(base+'/'+phase+'/events?'+new URLSearchParams({'vids[]':event.eventId+':',main:'false'}),SOURCE_REFERERS.olimp);
        if(!r.ok)throw new Error('Olimp HTTP '+r.status);
        return parseOlimp(await r.json(),phase==='live',new Date().toISOString());
      }));
      events.push(...details.flat());
      if(offset+2<summaries.length && offset+2<24)await new Promise(resolve=>setTimeout(resolve,250));
    }
    events.push(...summaries.slice(24));
  }
  return {source:'olimp',noData:events.length===0,events,fetchedAt:new Date().toISOString()};
}

async function adapterBovada(): Promise<SourceResponse> {
  const response=await fetchWithProxy(SOURCE_URLS.bovada!,SOURCE_REFERERS.bovada);
  if(!response.ok)throw new Error('Bovada HTTP '+response.status);
  const raw=await response.json(),receivedAt=new Date().toISOString();
  const events=parseBovada(raw,receivedAt);
  return {source:'bovada',noData:events.length===0,events,fetchedAt:receivedAt};
}


// URL-ы держим в отдельной таблице, чтобы probe-эндпоинт мог дёргать ровно тот
// же URL что и адаптер (без парсинга).
const SOURCE_URLS: Record<string, string> = {
  fonbet: 'https://line-lb51.bk6bba-resources.com/events/listBase?scopeMarket=1600&lang=ru',
  liga_stavok:
    'https://line.ligastavok.ru/lsbets/api/v3/line/championships?sportFamilyKind=Esports&take=200',
  pari: 'https://line-lb51-w.pb06e2-resources.com/events/list?scopeMarket=2300&lang=ru',
  betboom: 'https://betboom.ru/api/v3/sports/40/line?take=200',
  x1stavka:
    'https://1xstavka.ru/LineFeed/Get1x2_VZip?sports=1620&count=200&lng=ru&mode=4&country=1&getEmpty=true',
  olimp: 'https://www.olimp.bet/api/v4/0/line/sports-with-competitions-with-events?vids%5B%5D=112%3A',
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
function isSourceAllowed(id: string): boolean {
  return sourceAllowlist === null || sourceAllowlist.has(id);
}
export function getAllSourceIds(): string[] { return KNOWN_SOURCE_IDS.filter(isSourceAllowed); }
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
    hint: 'Букмекерский функционал выключен на этом инстансе. Включите через ENV BOOKMAKERS_ENABLED=true (для РФ-буков нужен РФ-IP).',
  };
}

/** Read-only public view: a cache miss/expiry never polls a bookmaker. */
export async function readSource(source: string): Promise<SourceResponse> {
  if (!BOOKMAKERS_ENABLED) return disabledResponse(source);
  if (!isSourceAllowed(source)) return {source, noData: true, events: [], fetchedAt: '', unavailable: true, error: 'SOURCE_DISABLED'};
  const cached = cache[source];
  if (!cached) return {source, noData: true, events: [], fetchedAt: '', unavailable: true, stale: true, error: 'background_feed_not_ready'};
  return {...cached.value,
    events:cached.value.events.map(event=>({...event,expiresAt:bookmakerEventExpiresAt(event)})),
    stale: Boolean(cached.value.error) || Date.now() - cached.fetchedAt >= CACHE_TTL_MS};
}

/** Worker/admin refresh only. Public handlers use readSource. */
export async function fetchSource(source: string, opts?: { force?: boolean }): Promise<SourceResponse> {
  if (!BOOKMAKERS_ENABLED) return disabledResponse(source);
  if (KNOWN_SOURCE_IDS.includes(source) && !isSourceAllowed(source)) {
    return {
      source,
      noData: true,
      events: [],
      fetchedAt: new Date().toISOString(),
      error: 'SOURCE_DISABLED',
      hint: 'Источник выключен настройкой BOOKMAKER_SOURCES на этом инстансе.',
    };
  }

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
    const result = await fetchAdapterWithRetry(adapter);
    if (result.error) throw new Error(result.error);
    const durationMs = Date.now() - startedAt;
    bookmakerLogger.info(
      { tag: 'bookmaker', source, events: result.events.length, durationMs, error: result.error ?? null },
      '[bookmaker] fetched',
    );
    setCached(source, result);
    { const c = getCounter(source); c.requestsTotal += 1; c.responsesOk += 1; c.lastStatus = { ok: true, events: result.events.length, error: null, checkedAt: new Date().toISOString(), durationMs }; }
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errMsg = err instanceof Error ? err.message : String(err);
    { const c = getCounter(source); c.requestsTotal += 1; c.lastStatus = { ok: false, events: 0, error: errMsg, checkedAt: new Date().toISOString(), durationMs }; }
    bookmakerLogger.warn({ tag: 'bookmaker', source, durationMs, err: errMsg }, '[bookmaker] fetch failed');
    const previous = cache[source]?.value;
    const fail: SourceResponse = {
      source,
      noData: !previous?.events.length,
      events: previous?.events ?? [],
      fetchedAt: previous?.fetchedAt ?? '',
      stale: true,
      unavailable: !previous?.fetchedAt,
      error: errMsg,
      hint: 'Источник не обновлён: см. точную ошибку HTTP, формата ответа или соединения. Предыдущие коэффициенты считаются устаревшими.',
    };
    // даже фейлы кэшируем коротко, чтобы не долбить упавший источник
    setCached(source, fail);
    return fail;
  }
}

// Aggregate response time must not masquerade as the source's receipt time.
function latestSourceReceipt(sources: SourceResponse[]): string | null {
  return sources.map(s => s.fetchedAt).filter(Boolean).sort().at(-1) ?? null;
}

/** Only valid current observations may be offered for odds/edge calculations. */
const LIVE_QUOTE_MAX_AGE_MS=195_000; // 180s polling + bounded 15s network jitter.
export function bookmakerEventExpiresAt(event: UnifiedBookmakerEvent, now=Date.now()): string {
  const received=Date.parse(event.receivedAt??event.updatedAt);
  if(!Number.isFinite(received))return '';
  const scheduled=event.startsAt?Date.parse(event.startsAt):NaN;
  const expires=event.status==='upcoming' && scheduled>now
    ? Math.min(received+3_600_000,scheduled)
    : received+LIVE_QUOTE_MAX_AGE_MS;
  return new Date(expires).toISOString();
}

export function usableBookmakerEvents(source: SourceResponse): UnifiedBookmakerEvent[] {
  if (source.error || source.unavailable || source.stale) return [];
  const now=Date.now(), received=Date.parse(source.fetchedAt);
  return source.events.filter(event=>{
    const updated=Date.parse(event.updatedAt);
    const expires=Date.parse(bookmakerEventExpiresAt(event,now));
    return Number.isFinite(received) && Number.isFinite(updated)
      && now-received>=0 && now-updated>=0 && now<expires;
  });
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
      available: BOOKMAKERS_ENABLED && isSourceAllowed(id) && !!cached && usableBookmakerEvents(cached).length>0,
      cached: !!getCached(id),
      ...(cached?.fetchedAt ? { lastFetchedAt: cached.fetchedAt } : {}),
      ...(cached ? { eventsCount: cached.events.length } : {}),
      ...(cached?.error ? { lastError: cached.error } : {}),
    };
  }
  const { getBookmakerWorkerStats } = await import('../services/BookmakerWorker');
  res.json({
    enabled: BOOKMAKERS_ENABLED,
    cacheTtlMs: CACHE_TTL_MS,
    failureCacheTtlMs: FAILURE_CACHE_TTL_MS,
    sources,
    worker: getBookmakerWorkerStats(),
    note: BOOKMAKERS_ENABLED
      ? 'Обновление выполняется только фоновым воркером. Доступность подтверждается корректным ответом источника; количество событий показывает фактическое покрытие Dota 2.'
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
  const {sameTeamIdentity} = await import('../services/BookmakerMatcher');
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
  const all = await Promise.all(getAllSourceIds().map((s) => readSource(s)));
  const sources: Array<{
    source: string;
    eventId: string;
    startsAt: string | null;
    status: UnifiedBookmakerEvent['status'];
    markets: UnifiedBookmakerEvent['markets'];
    flipped: boolean;
    updatedAt: string;
    fetchedAt: string;
    receivedAt: string;
    scope: 'series' | 'map';
    expiresAt: string;
  }> = [];
  for (const src of all) {
    if (!src.events.length) continue;
    for (const ev of usableBookmakerEvents(src)) {
      const direct=sameTeamIdentity(ev.team1,team1)&&sameTeamIdentity(ev.team2,team2);
      const reverse=sameTeamIdentity(ev.team1,team2)&&sameTeamIdentity(ev.team2,team1);
      if (direct === reverse) continue;
      const requestedStart = Date.parse(String(req.query.startsAt ?? ''));
      const eventStart = ev.startsAt ? Date.parse(ev.startsAt) : NaN;
      if (!Number.isFinite(requestedStart) || !Number.isFinite(eventStart) || Math.abs(requestedStart-eventStart)>2*3600000) continue;
      // Определяем ориентацию: совпадает ли ev.team1 с запрошенным team1 (fuzzy)
      const sameOrder = direct;
      const markets=orientBookmakerMarkets(ev.markets,!sameOrder);
      sources.push({
        source: ev.source,
        updatedAt: ev.updatedAt,
        fetchedAt: src.fetchedAt,
        receivedAt: ev.receivedAt ?? ev.updatedAt,
        scope: ev.scope ?? 'series',
        expiresAt: bookmakerEventExpiresAt(ev),
        eventId: ev.eventId,
        startsAt: ev.startsAt,
        status: ev.status,
        markets,
        flipped: !sameOrder,
      });
    }
  }
  const sourcesPolled = all.map((s) => ({ source: s.source, events: s.events.length, error: s.error ?? null }));
  const verifiedSources = unambiguousSourceEvents(sources);
  res.json({
    enabled: true,
    found: verifiedSources.length > 0,
    team1,
    team2,
    team1Id,
    team2Id,
    sources: verifiedSources,
    sourcesPolled,
  });
});

// ---------- Unified merge ----------
// normalizeTeamName / fuzzyTeamMatch / fuzzyPairMatch — общие из
// BookmakerMatcher (там TOKEN_ALIAS «bb→betboom» и дискриминаторы
// junior/academy). Раньше здесь была локальная копия БЕЗ алиасов —
// из-за этого for-match не матчил «BB Team» ↔ «BetBoom Team» и мобилка
// не видела кэфы Bovada (баг 2026-07-17).

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
  const all = await Promise.all(getAllSourceIds().map((s) => readSource(s)));
  const byPair = new Map<string, MergedEvent>();
  for (const src of all) {
    if (!src.events.length) continue;
    for (const ev of usableBookmakerEvents(src)) {
      const orientation = normalizeTeamName(ev.team1) < normalizeTeamName(ev.team2);
      if (!ev.startsAt || !Number.isFinite(Date.parse(ev.startsAt))) continue;
      const key = pairKey(ev.team1, ev.team2)+'|'+ev.startsAt;
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
    fetchedAt: latestSourceReceipt(all),
    stale: all.some(source => source.stale || source.error),
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
      bodyPreview: '',
      error: `rate_limited (min ${PROBE_MIN_INTERVAL_MS / 1000}s between probes)`,
      rateLimited: true,
    };
  }
  probeRateLimit[id] = now;
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
  const results = await Promise.all(getAllSourceIds().map((s) => readSource(s)));
  res.json({
    enabled: true,
    sources: results,
    fetchedAt: latestSourceReceipt(results),
    stale: results.some(source => source.stale || source.error),
  });
});

// ---------- Matched: bookmaker events ↔ our live/upcoming matches ----------
// Сопоставляет букмекерские события с нашими live/upcoming матчами по именам
// команд (fuzzy) + времени начала (±2 ч). Возвращает массив групп с matchId.
// Bookmaker events без матча в нашей базе попадают в unmatched (только для
// admin/diagnostic — mobile их не показывает).

/** Loopback GET к нашему серверу с минимальным timeout 5s. */
async function loopbackGet<T>(path: string): Promise<T | null> {
  const port = process.env['PORT'] ?? '8080';
  for (const host of ['127.0.0.1', 'localhost']) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await fetch(`http://${host}:${port}${path}`, { signal: ctrl.signal });
        if (!r.ok) continue;
        return (await r.json()) as T;
      } finally {
        clearTimeout(tid);
      }
    } catch {
      continue;
    }
  }
  return null;
}

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

  const { matchBookmakerEvents } = await import('../services/BookmakerMatcher');
  type OurMatch = import('../services/BookmakerMatcher').OurMatch;

  // Тянем все источники + наши матчи параллельно
  const [all, liveData, upcomingData] = await Promise.all([
    Promise.all(getAllSourceIds().map((s) => readSource(s))),
    loopbackGet<unknown>('/api/matches/live'),
    loopbackGet<unknown>('/api/matches/upcoming'),
  ]);

  // /api/matches/live и /api/matches/upcoming могут возвращать [] или { matches: [] }
  function toArray(v: unknown): unknown[] {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (Array.isArray(obj['matches'])) return obj['matches'] as unknown[];
      if (Array.isArray(obj['data'])) return obj['data'] as unknown[];
      // F7 (Phase 9): /api/matches/live реально отвечает { sources: [{ source,
      // data: [...] }] } — раньше эта форма не разворачивалась и live-матчи
      // вообще не попадали в матчинг (все события буков уходили в unmatched).
      if (Array.isArray(obj['sources'])) {
        const out: unknown[] = [];
        for (const s of obj['sources'] as Array<Record<string, unknown>>) {
          if (s && Array.isArray(s['data'])) out.push(...(s['data'] as unknown[]));
        }
        return out;
      }
    }
    return [];
  }
  const liveRaw = toArray(liveData);
  const upcomingRaw = toArray(upcomingData);

  // Объединяем все букмекерские события в один плоский массив
  const bookmakerEvents: UnifiedBookmakerEvent[] = [];
  for (const src of all) {
    bookmakerEvents.push(...usableBookmakerEvents(src));
  }

  // Конвертируем PandaScore-формат матчей в OurMatch
  function psToOurMatch(m: Record<string, unknown>, isLive: boolean): OurMatch | null {
    const id = m['id'];
    if (!id) return null;
    const opps = (m['opponents'] as Array<{ opponent?: { id?: number; name?: string } }> | undefined) ?? [];
    const o1 = opps[0]?.opponent;
    const o2 = opps[1]?.opponent;
    if (!o1?.name || !o2?.name) return null;
    const startsAt = (m['begin_at'] ?? m['scheduled_at']) as string | null | undefined;
    return {
      matchId: String(id),
      psMatchId: typeof id === 'number' ? id : undefined,
      team1Name: o1.name,
      team2Name: o2.name,
      team1Id: o1.id,
      team2Id: o2.id,
      startsAt: startsAt ?? null,
      isLive,
    };
  }

  // F7 (Phase 9): live-элементы из /api/matches/live (OpenDota и PandaScore
  // live-конвертация) имеют плоскую форму { team_name_radiant, team_name_dire,
  // match_id / ps_match_id, ... } — без opponents[]. Отдельный конвертер.
  function liveToOurMatch(m: Record<string, unknown>): OurMatch | null {
    const t1 = m['team_name_radiant'];
    const t2 = m['team_name_dire'];
    if (typeof t1 !== 'string' || typeof t2 !== 'string' || !t1 || !t2) return null;
    const psId = m['ps_match_id'];
    const rawId = m['match_id'] ?? psId;
    if (rawId == null) return null;
    return {
      matchId: String(rawId),
      psMatchId: typeof psId === 'number' ? psId : undefined,
      team1Name: t1,
      team2Name: t2,
      team1Id: typeof m['team_id_radiant'] === 'number' ? (m['team_id_radiant'] as number) : undefined,
      team2Id: typeof m['team_id_dire'] === 'number' ? (m['team_id_dire'] as number) : undefined,
      startsAt: null, // No verified series start: do not attach series odds to this map.
      scope: 'map',
      isLive: true,
    };
  }

  // F7 (Phase 9): дедуп — один и тот же матч может прийти дважды:
  // (а) только что начавшаяся серия видна и в live (OD match_id), и в
  //     PS upcoming (begin_at в окне ±2ч);
  // (б) при реактивации Stratz live один матч появится в двух sources[].
  // Ключи: psMatchId + нормализованная пара имён (сортированная — порядок
  // radiant/dire не важен). live добавляем первыми, чтобы приоритет был у них.
  const seenPsIds = new Set<number>();
  const seenPairs = new Set<string>();
  const pairKey = (m: OurMatch): string =>
    [m.team1Name, m.team2Name]
      .map(n => n.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ''))
      .sort()
      .join('::')+'::'+m.matchId;
  const pushUnique = (m: OurMatch): void => {
    if (m.psMatchId != null && seenPsIds.has(m.psMatchId)) return;
    const key = pairKey(m);
    if (seenPairs.has(key)) return;
    if (m.psMatchId != null) seenPsIds.add(m.psMatchId);
    seenPairs.add(key);
    ourMatches.push(m);
  };

  const ourMatches: OurMatch[] = [];
  for (const m of liveRaw ?? []) {
    const rec = m as Record<string, unknown>;
    const converted = liveToOurMatch(rec) ?? psToOurMatch(rec, true);
    if (converted) pushUnique(converted);
  }
  for (const m of upcomingRaw ?? []) {
    const converted = psToOurMatch(m as Record<string, unknown>, false);
    if (converted) pushUnique(converted);
  }

  const matched = matchBookmakerEvents(ourMatches, bookmakerEvents);

  // Неприматченные букмекерские события (нет в нашей БД матчей)
  const matchedEventIds = new Set(
    matched.flatMap(g => g.bookmakerSources.map(s => s.source+':'+s.eventId)),
  );
  const unmatched = bookmakerEvents.filter(ev => !matchedEventIds.has(ev.source+':'+ev.eventId));

  const sourcesPolled = all.map((s) => ({ source: s.source, events: s.events.length, error: s.error ?? null }));

  req.log.info(
    {
      tag: 'matched',
      durationMs: Date.now() - t0,
      groups: matched.length,
      eventsTotal: bookmakerEvents.length,
      matchedToOurMatches: matched.length,
      unmatchedEvents: unmatched.length,
      ourMatchesCount: ourMatches.length,
      sourcesPolled,
    },
    '[bookmaker] /matched/dota2 done',
  );
  res.json({
    enabled: true,
    fetchedAt: latestSourceReceipt(all),
    stale: all.some(source => source.stale || source.error),
    sourcesPolled,
    count: matched.length,
    matched,
    unmatched,
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
    const result = await readSource(id);
    res.json(result);
  });
}

export default router;
