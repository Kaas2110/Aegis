/**
 * Российские букмекеры — публичные мобильные/web JSON-эндпоинты.
 *
 * 6 РФ-источников: Fonbet, Лига Ставок, PARI, BetBoom, 1xStavka, Olimp.bet.
 * + 1 US-источник: Bovada (работает с Replit-IP без ключа).
 * Все API — публичные, без ключей.
 *
 * Управление:
 *   BOOKMAKERS_ENABLED=true   — включить (дефолт true, на Replit работает только Bovada)
 *
 * При выключенном флаге все эндпоинты возвращают HTTP 503 с понятным JSON-телом
 * (`{ enabled: false, error, hint }`).
 *
 * Реальность с не-РФ IP (Replit, 2026-05-18): все 6 РФ-источников блочат гео
 * (DNS / Cloudflare / HTML-челлендж). Тест с datacenter РФ-прокси не помог
 * (см. docs/laptop-deploy.md § Букмекеры). Прокси-логика убрана — ходим
 * напрямую отовсюду. РФ-буки оживут только на ноуте с домашним РФ-IP, и то
 * после починки 3 устаревших адаптеров (pari/betboom/olimp). Admin-эндпоинт
 * `POST /api/admin/bookmakers/probe` доступен для диагностики.
 *
 * ToS: использование этих API находится в серой зоне — пользователь предупреждён.
 */
import { Router, type IRouter } from 'express';
import { getRandomUserAgent } from '../lib/userAgents';
import { logger as bookmakerLogger } from '../lib/logger';

const router: IRouter = Router();

// Дефолт включён: с Replit-IP реально работает Bovada (US-IP, без ключа).
// 6 РФ-букмекеров на Replit-IP заблокированы (гео/Cloudflare/DNS) — их адаптеры
// возвращают пустой массив или ошибку, но фича в целом активна.
// Жёсткое выключение: BOOKMAKERS_ENABLED=false.
const BOOKMAKERS_ENABLED = process.env['BOOKMAKERS_ENABLED'] !== 'false';

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

// Все источники (Bovada + 6 РФ-буков) ходим напрямую. Прокси-логика убрана
// 2026-05-18 после теста shared РФ-прокси: ломал Bovada (US-IP-only),
// не помогал ни одному из 6 РФ-буков (DNS / Cloudflare / устаревшие URL).
// Для переезда на ноут см. docs/laptop-deploy.md § «Букмекеры».
async function fetchWithProxy(url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Cache-Control': 'no-cache',
    'X-Requested-With': 'XMLHttpRequest',
    ...extraHeaders,
  };

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
  // Fonbet v1 line API. Factors array carries odds inline alongside event list.
  // Factor ids (esports): "1"=П1(team1 wins), "2"=П2(team2 wins).
  // Kill totals: "1751"=TotalO, "1752"=TotalU — pt field is the line value.
  const url = 'https://line34.fonbet.ru/api/v1/line/sport/events?sport=12&count=100';
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
      // Flat factors array — field name is either "f" or "id" depending on API version
      factors?: Array<{ f?: string | number; id?: string | number; v?: number; pt?: string | number }>;
    }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.events ?? [])
    .filter((e) => (e.sportId === 12 || e.sportId === undefined))
    .map((e) => {
      const factors = e.factors ?? [];
      const getFactor = (fid: string): number | null => {
        const f = factors.find((x) => String(x.f ?? x.id ?? '') === fid);
        return num(f?.v);
      };
      const t1 = getFactor('1');
      const t2 = getFactor('2');

      // Group kill-total factors by pt (line value)
      const overFactors = factors.filter((x) => String(x.f ?? x.id ?? '') === '1751');
      const underFactors = factors.filter((x) => String(x.f ?? x.id ?? '') === '1752');
      const killsLines: UnifiedMarketTotal[] = [];
      for (const o of overFactors) {
        const line = num(o.pt);
        const over = num(o.v);
        const u = underFactors.find((x) => x.pt === o.pt);
        const under = u ? num(u.v) : null;
        if (line !== null && over !== null && under !== null) {
          killsLines.push({ line, over, under });
        }
      }

      return {
        source: 'fonbet',
        eventId: String(e.id ?? ''),
        team1: e.team1 ?? '',
        team2: e.team2 ?? '',
        startsAt: e.startTime ? new Date(e.startTime * 1000).toISOString() : null,
        status: 'unknown' as const,
        markets: {
          ...(t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {}),
          ...(killsLines.length > 0 ? { totalKills: killsLines } : {}),
        },
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((e) => e.team1 && e.team2);
  return { source: 'fonbet', noData: false, events, fetchedAt: new Date().toISOString() };
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
      const mkts = e.markets ?? [];
      const winnerMkt = mkts.find((m) => {
        const n = (m.name ?? '').toLowerCase();
        return n === 'победитель' || n === 'winner' || n.includes('победитель матча');
      });
      const t1 = num(winnerMkt?.outcomes?.[0]?.coefficient);
      const t2 = num(winnerMkt?.outcomes?.[1]?.coefficient);

      // Parse total kills market
      const killsMkt = mkts.find((m) => {
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
          const over = num(o?.coefficient);
          const under = num(u?.coefficient);
          if (line !== null && over !== null && under !== null) killsLines.push({ line, over, under });
        }
      }

      return {
        source: 'pari',
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
  // Olimp.bet публичный эндпоинт
  const url = 'https://www.olimp.bet/ru/api/lines/get_events?sport=cybersport&subsport=dota-2&take=200';
  const resp = await fetchWithProxy(url, {
    'Origin': 'https://www.olimp.bet',
    'Referer': 'https://www.olimp.bet/ru/cybersport/dota-2',
  });
  if (!resp.ok) throw new Error(`Olimp HTTP ${resp.status}`);
  const raw = (await resp.json()) as {
    events?: Array<{
      id?: string;
      team1?: string;
      team2?: string;
      date?: string;
      coef1?: number;
      coef2?: number;
      // Extended fields that Olimp may return
      totals?: Array<{ name?: string; type?: string; value?: number; over?: number; under?: number }>;
      firstBlood?: { yes?: number; no?: number; 1?: number; 2?: number };
      markets?: Array<{ name?: string; outcomes?: Array<{ name?: string; coefficient?: number; value?: number }> }>;
    }>;
  };
  const events: UnifiedBookmakerEvent[] = (raw.events ?? [])
    .map((e) => {
      const t1 = num(e.coef1);
      const t2 = num(e.coef2);

      // Parse kill totals from totals array or markets
      const killsLines: UnifiedMarketTotal[] = [];
      for (const t of e.totals ?? []) {
        const n = (t.name ?? t.type ?? '').toLowerCase();
        if (n.includes('убийств') || n.includes('kill') || n.includes('фраг')) {
          const line = num(t.value);
          const over = num(t.over);
          const under = num(t.under);
          if (line !== null && over !== null && under !== null) killsLines.push({ line, over, under });
        }
      }
      for (const m of e.markets ?? []) {
        const n = (m.name ?? '').toLowerCase();
        if ((n.includes('убийств') || n.includes('kill')) && (n.includes('тотал') || n.includes('total'))) {
          const outcomes = m.outcomes ?? [];
          for (let i = 0; i + 1 < outcomes.length; i += 2) {
            const o = outcomes[i];
            const u = outcomes[i + 1];
            const lineMatch = (o?.name ?? '').match(/(\d+\.?\d*)/);
            const line = lineMatch ? parseFloat(lineMatch[1]!) : null;
            const over = num(o?.coefficient ?? o?.value);
            const under = num(u?.coefficient ?? u?.value);
            if (line !== null && over !== null && under !== null) killsLines.push({ line, over, under });
          }
        }
      }

      // Parse first blood
      const fbRaw = e.firstBlood;
      const fbYes = fbRaw ? (num(fbRaw.yes) ?? num((fbRaw as { 1?: number })[1])) : null;
      const fbNo = fbRaw ? (num(fbRaw.no) ?? num((fbRaw as { 2?: number })[2])) : null;

      return {
        source: 'olimp',
        eventId: String(e.id ?? ''),
        team1: e.team1 ?? '',
        team2: e.team2 ?? '',
        startsAt: e.date ?? null,
        status: 'unknown' as const,
        markets: {
          ...(t1 && t2 ? { winner: { team1: t1, team2: t2 } } : {}),
          ...(killsLines.length > 0 ? { totalKills: killsLines } : {}),
          ...(fbYes !== null && fbNo !== null ? { firstBlood: { yes: fbYes, no: fbNo } } : {}),
        },
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
            const mDesc = (m.description ?? '').toLowerCase();
            const pDesc = (m.period?.description ?? '').toLowerCase();
            // Period names: "Game" (prematch), "Live Game" (live), "Full Game", etc.
            // Exclude per-map periods like "Map 1", "Live Map 2".
            const isGameLevel = pDesc.includes('game') && !pDesc.includes('map');
            if (mDesc === 'moneyline' && isGameLevel) {
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
    hint: 'Букмекерский функционал выключен на этом инстансе. Включите через ENV BOOKMAKERS_ENABLED=true (для РФ-буков нужен РФ-IP).',
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
    { const c = getCounter(source); c.requestsTotal += 1; c.responsesOk += 1; c.lastStatus = { ok: true, events: result.events.length, error: null, checkedAt: new Date().toISOString(), durationMs }; }
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errMsg = err instanceof Error ? err.message : String(err);
    { const c = getCounter(source); c.requestsTotal += 1; c.lastStatus = { ok: false, events: 0, error: errMsg, checkedAt: new Date().toISOString(), durationMs }; }
    bookmakerLogger.warn({ tag: 'bookmaker', source, durationMs, err: errMsg }, '[bookmaker] fetch failed');
    const fail: SourceResponse = {
      source,
      noData: true,
      events: [],
      fetchedAt: new Date().toISOString(),
      error: errMsg,
      hint: 'Источник недоступен с текущего IP. РФ-буки требуют РФ-IP (см. docs/laptop-deploy.md § Букмекеры).',
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
    cacheTtlMs: CACHE_TTL_MS,
    sources,
    worker: getBookmakerWorkerStats(),
    note: BOOKMAKERS_ENABLED
      ? 'Букмекерские источники активны. РФ-буки доступны только с РФ-IP (см. docs/laptop-deploy.md).'
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
      if (!fuzzyPairMatch(ev.team1, ev.team2, team1, team2)) continue;
      // Определяем ориентацию: совпадает ли ev.team1 с запрошенным team1 (fuzzy)
      const sameOrder = fuzzyTeamMatch(ev.team1, team1);
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

/**
 * Токены имени команды без служебных org-слов.
 * "Xtreme Gaming" → ["xtreme"], "Team Spirit" → ["spirit"],
 * "Ex-Heroic" → ["heroic"],    "Natus Vincere" → ["natus","vincere"]
 */
const ORG_STOP = new Set([
  'team','gaming','esport','esports','club','fc','ex','former','the','gg',
]);
function teamTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !ORG_STOP.has(t));
}

/**
 * Fuzzy-сравнение двух названий команд:
 *  1. Точный нормализованный матч (быстрый путь).
 *  2. Token-overlap после отброса org-слов:
 *     "Xtreme" ↔ "Xtreme Gaming", "Ex-Heroic" ↔ "Heroic",
 *     "Team AURORA" ↔ "Aurora Gaming".
 */
function fuzzyTeamMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (normalizeTeamName(a) === normalizeTeamName(b)) return true;
  const tokA = teamTokens(a);
  const tokB = teamTokens(b);
  if (!tokA.length || !tokB.length) return false;
  const shorter = tokA.length <= tokB.length ? tokA : tokB;
  const longer  = tokA.length <= tokB.length ? tokB : tokA;
  return shorter.every(t => longer.includes(t));
}

/** Fuzzy-матч двух пар команд (с учётом возможной смены ориентации). */
function fuzzyPairMatch(a1: string, a2: string, b1: string, b2: string): boolean {
  return (fuzzyTeamMatch(a1, b1) && fuzzyTeamMatch(a2, b2))
      || (fuzzyTeamMatch(a1, b2) && fuzzyTeamMatch(a2, b1));
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
  const results = await Promise.all(Object.keys(ADAPTERS).map((s) => fetchSource(s)));
  res.json({
    enabled: true,
    sources: results,
    fetchedAt: new Date().toISOString(),
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
    Promise.all(Object.keys(ADAPTERS).map((s) => fetchSource(s))),
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
    }
    return [];
  }
  const liveRaw = toArray(liveData);
  const upcomingRaw = toArray(upcomingData);

  // Объединяем все букмекерские события в один плоский массив
  const bookmakerEvents: UnifiedBookmakerEvent[] = [];
  for (const src of all) {
    bookmakerEvents.push(...src.events);
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

  const ourMatches: OurMatch[] = [];
  for (const m of liveRaw ?? []) {
    const converted = psToOurMatch(m as Record<string, unknown>, true);
    if (converted) ourMatches.push(converted);
  }
  for (const m of upcomingRaw ?? []) {
    const converted = psToOurMatch(m as Record<string, unknown>, false);
    if (converted) ourMatches.push(converted);
  }

  const matched = matchBookmakerEvents(ourMatches, bookmakerEvents);

  // Неприматченные букмекерские события (нет в нашей БД матчей)
  const matchedEventIds = new Set(
    matched.flatMap(g => g.bookmakerSources.map(s => s.eventId)),
  );
  const unmatched = bookmakerEvents.filter(ev => !matchedEventIds.has(ev.eventId));

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
    fetchedAt: new Date().toISOString(),
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
    const result = await fetchSource(id);
    res.json(result);
  });
}

export default router;
