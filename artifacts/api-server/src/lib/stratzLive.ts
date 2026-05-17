/**
 * ════════════════════════════════════════════════════════════════════
 *  DORMANT — Stratz live upstream пуст с 2026-05-16
 * ════════════════════════════════════════════════════════════════════
 *
 * Этот файл сохранён намеренно — код готов к повторному включению.
 * Вызовы из LiveWorker.ts закомментированы. Ни один путь в runtime
 * сейчас не доходит до этого файла.
 *
 * КАК ВКЛЮЧИТЬ ОБРАТНО:
 *   1. В LiveWorker.ts раскомментировать import (строка ~33) и блок enrichment.
 *   2. Добавить xpAdvantage_kxp / networthAdvantage_kgold в buildLiveTotalsFeatures
 *      (MarketLgbm.ts + scripts/src/train-live-totals.ts), сменить kind на
 *      live_total_kills_v2, запустить train:live-totals.
 *   3. В /api/admin/coverage раскомментировать stratzPct метрику.
 *
 * ЧТО ДАВАЛ STRATZ LIVE (чего нет в OpenDota /api/live):
 *   - per-player: gold, networth, xpm, gpm, items, respawn time, impPerMinute
 *   - match meta: avgRank, gameState, gameMinute, delay, roshanRespawnSec
 *   - Stratz projections: liveWinRate, prematchWinRate/Duration
 *
 * OpenDota /api/live отдаёт только match-level: game_time, scores,
 * building_state, kills — per-player live телеметрия недоступна через OD
 * (нужен GC-бот, как у Stratz).
 *
 * Пять nullable колонок в live_snapshots сохранены в БД:
 *   stratz_match_meta, stratz_players, xp_advantage,
 *   networth_advantage, stratz_fetched_at
 *
 * ════════════════════════════════════════════════════════════════════
 *
 * Stratz live API client — fetches rich per-player + match-meta data for a
 * currently-running pro match. Used by LiveWorker to enrich OpenDota /api/live
 * snapshots with fields OpenDota doesn't expose:
 *   - per-player gold/networth/xpm/gpm/items/respawn/impPerMinute
 *   - match meta: avgRank, gameState, gameMinute, delay, roshan respawn
 *   - Stratz's own projections: liveWinRate, prematch winRate/duration
 *
 * Schema introspection (2026-05-16) confirmed Stratz live does NOT expose:
 *   - hasAegis / aegis holder
 *   - numBuybacks / buyback state
 *   - vision score / ward placement
 *   - teamfight events (those live only in `playbackData` blob or replay-parse)
 *
 * TRANSPORT: Stratz Cloudflare blocks Node fetch on non-RU IPs (JA3 mismatch).
 * Same curl-fallback pattern as scripts/src/lib/stratz.ts.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getStratzToken } from '../services/ApiKeysService';
import { logger } from './logger';

const execFileAsync = promisify(execFile);
const STRATZ_GQL = 'https://api.stratz.com/graphql';
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 30_000;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface StratzLivePlayer {
  steamAccountId: number | null;
  heroId: number | null;
  isRadiant: boolean;
  level: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  lastHits: number | null;
  denies: number | null;
  gold: number | null;
  goldSpent: number | null;
  networth: number | null;
  goldPerMinute: number | null;
  experiencePerMinute: number | null;
  heroDamage: number | null;
  towerDamage: number | null;
  respawnTimer: number | null;
  impPerMinute: number | null;
  items: number[];
}

export interface StratzLiveMatchMeta {
  avgRank: number | null;
  gameState: string | null;
  gameMinute: number | null;
  delay: number | null;
  roshanRespawnSec: number | null;
  liveWinRateRadiant: number | null;
  prematchWinRateRadiant: number | null;
  prematchDurationMin: number | null;
}

export interface StratzLiveDetail {
  matchId: number;
  meta: StratzLiveMatchMeta;
  players: StratzLivePlayer[];
  /** Σ Radiant.xpm * gameMinute − Σ Dire.xpm * gameMinute */
  xpAdvantage: number | null;
  /** Σ Radiant.networth − Σ Dire.networth */
  networthAdvantage: number | null;
}

const LIVE_MATCH_QUERY = `query LiveMatch($id: Long!) {
  live {
    match(id: $id) {
      matchId
      gameTime
      gameMinute
      gameState
      delay
      averageRank
      winRateValues
      durationValues
      liveWinRateValues { winRate }
      players {
        steamAccountId
        heroId
        isRadiant
        level
        numKills
        numDeaths
        numAssists
        numLastHits
        numDenies
        gold
        goldSpent
        networth
        goldPerMinute
        experiencePerMinute
        heroDamage
        towerDamage
        respawnTimer
        impPerMinute { imp }
        itemId0 itemId1 itemId2 itemId3 itemId4 itemId5
      }
    }
  }
}`;

interface StratzRawPlayer {
  steamAccountId?: number | null;
  heroId?: number | null;
  isRadiant?: boolean;
  level?: number | null;
  numKills?: number | null;
  numDeaths?: number | null;
  numAssists?: number | null;
  numLastHits?: number | null;
  numDenies?: number | null;
  gold?: number | null;
  goldSpent?: number | null;
  networth?: number | null;
  goldPerMinute?: number | null;
  experiencePerMinute?: number | null;
  heroDamage?: number | null;
  towerDamage?: number | null;
  respawnTimer?: number | null;
  impPerMinute?: { imp?: number | null } | null;
  itemId0?: number | null;
  itemId1?: number | null;
  itemId2?: number | null;
  itemId3?: number | null;
  itemId4?: number | null;
  itemId5?: number | null;
}

interface StratzRawMatch {
  matchId?: number | null;
  gameTime?: number | null;
  gameMinute?: number | null;
  gameState?: string | null;
  delay?: number | null;
  averageRank?: number | null;
  winRateValues?: number | null;
  durationValues?: number | null;
  liveWinRateValues?: { winRate?: number | null } | null;
  players?: StratzRawPlayer[] | null;
}

// ── in-memory cache ────────────────────────────────────────────────────────
const cache = new Map<number, { at: number; value: StratzLiveDetail | null }>();

// ── circuit breaker ────────────────────────────────────────────────────────
// Stratz live API эпизодически пуст (live.match(id)=null для ВСЕХ id, live.matches=[])
// — это апстрим, не наш баг (см. docs/operations-manual.md §Stratz live).
// Чтобы не выжигать квоту/трафик на null-ответы, считаем подряд-null и при
// пороге отрубаем Stratz на STRATZ_OFF_MS. Любой не-null ответ моментально
// сбрасывает счётчик и возвращает enrichment в строй.
// Разделяем breaker по классу ошибки (architect feedback):
//   1) NULL-upstream (live.match=null) — длинный 30m cooldown, апстрим
//      эпизодически пуст по своей воле, бессмысленно ретраить.
//   2) Transport error (fetch/curl/parse fail) — короткий 5m cooldown,
//      Stratz Cloudflare переменно блокирует, рано или поздно отпустит.
// Раньше оба случая считались в один счётчик, и при серии транзиентных 502
// breaker открывался на 30 минут даже если апстрим работал.
let consecutiveNulls = 0;
let consecutiveTransport = 0;
let stratzDisabledUntil = 0;
let lastBreakerReason: 'null_upstream' | 'transport_error' | null = null;
const NULL_BREAKER_THRESHOLD = 20;
const TRANSPORT_BREAKER_THRESHOLD = 10;
const STRATZ_OFF_MS_NULL = 30 * 60_000;       // 30 минут
const STRATZ_OFF_MS_TRANSPORT = 5 * 60_000;   // 5 минут
const NULL_LOG_EVERY_N = 10;
let nullLogCounter = 0;
type StratzOutcome = 'ok' | 'null_upstream' | 'transport_error';
function recordStratzOutcome(outcome: StratzOutcome): void {
  if (outcome === 'ok') {
    if (consecutiveNulls >= NULL_BREAKER_THRESHOLD || consecutiveTransport >= TRANSPORT_BREAKER_THRESHOLD) {
      logger.info({ tag: 'stratz-live' }, '[stratzLive] data is back, breaker reset');
    }
    consecutiveNulls = 0;
    consecutiveTransport = 0;
    stratzDisabledUntil = 0;
    lastBreakerReason = null;
    return;
  }
  if (outcome === 'null_upstream') {
    consecutiveNulls++;
    if (consecutiveNulls === NULL_BREAKER_THRESHOLD) {
      stratzDisabledUntil = Date.now() + STRATZ_OFF_MS_NULL;
      lastBreakerReason = 'null_upstream';
      logger.warn({ tag: 'stratz-live', reason: 'null_upstream', cooldownMin: STRATZ_OFF_MS_NULL / 60_000 },
        '[stratzLive] live API пуст ' + NULL_BREAKER_THRESHOLD + ' раз подряд → пауза');
    }
    return;
  }
  // transport_error
  consecutiveTransport++;
  if (consecutiveTransport === TRANSPORT_BREAKER_THRESHOLD) {
    stratzDisabledUntil = Date.now() + STRATZ_OFF_MS_TRANSPORT;
    lastBreakerReason = 'transport_error';
    logger.warn({ tag: 'stratz-live', reason: 'transport_error', cooldownMin: STRATZ_OFF_MS_TRANSPORT / 60_000 },
      '[stratzLive] transport errors ' + TRANSPORT_BREAKER_THRESHOLD + ' раз подряд → пауза');
  }
}
function isStratzDisabled(): boolean {
  if (stratzDisabledUntil === 0) return false;
  if (Date.now() >= stratzDisabledUntil) {
    // Cooldown истёк — пробуем снова. Соответствующий counter не сбрасываем
    // (T-1 от порога), чтобы при продолжающемся отказе breaker сразу
    // сработал на следующем неудачном ответе того же класса.
    stratzDisabledUntil = 0;
    if (lastBreakerReason === 'null_upstream') {
      consecutiveNulls = NULL_BREAKER_THRESHOLD - 1;
    } else if (lastBreakerReason === 'transport_error') {
      consecutiveTransport = TRANSPORT_BREAKER_THRESHOLD - 1;
    }
    return false;
  }
  return true;
}

function cacheGet(matchId: number): StratzLiveDetail | null | undefined {
  const e = cache.get(matchId);
  if (!e) return undefined;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(matchId); return undefined; }
  return e.value;
}
function cacheSet(matchId: number, value: StratzLiveDetail | null): void {
  cache.set(matchId, { at: Date.now(), value });
  // bounded — pro live ≤ 50 матчей одновременно, но защитимся
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) cache.delete(k);
  }
}

// ── curl fallback ──────────────────────────────────────────────────────────
function isJsonResponse(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

function parseGql<T>(text: string): T | null {
  if (!isJsonResponse(text)) return null;
  try {
    const parsed = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> };
    if (parsed.errors?.length) {
      logger.debug({ tag: 'stratz-live', errors: parsed.errors.map(e => e.message) }, 'gql errors');
      return null;
    }
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

async function gqlOnce(token: string, body: string): Promise<unknown> {
  // 1) fetch
  try {
    const resp = await fetch(STRATZ_GQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': UA,
        Origin: 'https://stratz.com',
        Referer: 'https://stratz.com/',
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await resp.text();
    if (resp.ok && isJsonResponse(text)) {
      const parsed = parseGql<unknown>(text);
      if (parsed !== null) return parsed;
    }
    // CF challenge → fall to curl
  } catch {
    // fall to curl
  }

  // 2) curl
  const args = [
    '--silent', '--max-time', String(Math.ceil(FETCH_TIMEOUT_MS / 1000)),
    '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/json',
    '-H', 'Accept: application/json',
    '-H', `User-Agent: ${UA}`,
    '-H', 'Origin: https://stratz.com',
    '-H', 'Referer: https://stratz.com/',
    '--data-raw', body,
    STRATZ_GQL,
  ];
  const { stdout } = await execFileAsync('curl', args, { maxBuffer: 4 * 1024 * 1024 });
  return parseGql<unknown>(stdout);
}

// ── normalization ──────────────────────────────────────────────────────────
function normalizePlayer(p: StratzRawPlayer): StratzLivePlayer {
  const items = [p.itemId0, p.itemId1, p.itemId2, p.itemId3, p.itemId4, p.itemId5]
    .filter((x): x is number => typeof x === 'number' && x > 0);
  return {
    steamAccountId: p.steamAccountId ?? null,
    heroId: p.heroId ?? null,
    isRadiant: p.isRadiant === true,
    level: p.level ?? null,
    kills: p.numKills ?? null,
    deaths: p.numDeaths ?? null,
    assists: p.numAssists ?? null,
    lastHits: p.numLastHits ?? null,
    denies: p.numDenies ?? null,
    gold: p.gold ?? null,
    goldSpent: p.goldSpent ?? null,
    networth: p.networth ?? null,
    goldPerMinute: p.goldPerMinute ?? null,
    experiencePerMinute: p.experiencePerMinute ?? null,
    heroDamage: p.heroDamage ?? null,
    towerDamage: p.towerDamage ?? null,
    respawnTimer: p.respawnTimer ?? null,
    impPerMinute: p.impPerMinute?.imp ?? null,
    items,
  };
}

function aggregate(players: StratzLivePlayer[], gameMinute: number | null): { xp: number | null; nw: number | null } {
  if (players.length === 0) return { xp: null, nw: null };
  let rXpm = 0, dXpm = 0, rNw = 0, dNw = 0;
  let hasXp = false, hasNw = false;
  for (const p of players) {
    if (typeof p.experiencePerMinute === 'number') {
      if (p.isRadiant) rXpm += p.experiencePerMinute; else dXpm += p.experiencePerMinute;
      hasXp = true;
    }
    if (typeof p.networth === 'number') {
      if (p.isRadiant) rNw += p.networth; else dNw += p.networth;
      hasNw = true;
    }
  }
  const gm = typeof gameMinute === 'number' && gameMinute > 0 ? gameMinute : 1;
  return {
    xp: hasXp ? Math.round((rXpm - dXpm) * gm) : null,
    nw: hasNw ? rNw - dNw : null,
  };
}

/**
 * Fetch live match enrichment. Returns null if token missing, fetch failed,
 * or Stratz returned no data. Fail-soft — caller writes snapshot without
 * Stratz fields.
 */
export async function fetchLiveMatchDetail(matchId: number): Promise<StratzLiveDetail | null> {
  const cached = cacheGet(matchId);
  if (cached !== undefined) return cached;

  if (isStratzDisabled()) return null;

  const token = getStratzToken();
  if (!token) return null;

  const body = JSON.stringify({ query: LIVE_MATCH_QUERY, variables: { id: matchId } });
  let raw: unknown;
  try {
    raw = await gqlOnce(token, body);
  } catch (err) {
    logger.debug({ tag: 'stratz-live', matchId, err: String(err) }, 'fetch failed');
    cacheSet(matchId, null);
    recordStratzOutcome('transport_error');
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    // Невалидный JSON / GraphQL errors — относим к transport_error, апстрим
    // не отдал нам нормальной структуры (CF challenge, 5xx, timeout, …).
    cacheSet(matchId, null);
    recordStratzOutcome('transport_error');
    return null;
  }
  const match = (raw as { live?: { match?: StratzRawMatch | null } }).live?.match;
  if (!match) {
    // INFO-level (не debug), но с rate-limit 1/10 чтобы не спамить при
    // массовом degraded upstream. Срабатывание брейкера логируется отдельным
    // warn и всегда виден. См. docs/operations-manual.md §Stratz live.
    nullLogCounter++;
    if (nullLogCounter % NULL_LOG_EVERY_N === 1) {
      logger.info({ tag: 'stratz-live', matchId, sampledEvery: NULL_LOG_EVERY_N },
        '[stratzLive] live.match returned null (upstream empty, sampled)');
    }
    cacheSet(matchId, null);
    recordStratzOutcome('null_upstream');
    return null;
  }
  recordStratzOutcome('ok');

  const players = (match.players ?? []).map(normalizePlayer);
  const meta: StratzLiveMatchMeta = {
    avgRank: match.averageRank ?? null,
    gameState: match.gameState ?? null,
    gameMinute: match.gameMinute ?? null,
    delay: match.delay ?? null,
    roshanRespawnSec: null, // roshanRespawn { time } — отдельный nested тип, можно дотянуть позже если понадобится
    liveWinRateRadiant: match.liveWinRateValues?.winRate ?? null,
    prematchWinRateRadiant: match.winRateValues ?? null,
    prematchDurationMin: match.durationValues ?? null,
  };
  const agg = aggregate(players, meta.gameMinute);
  const detail: StratzLiveDetail = {
    matchId,
    meta,
    players,
    xpAdvantage: agg.xp,
    networthAdvantage: agg.nw,
  };
  cacheSet(matchId, detail);
  return detail;
}

/** Fetch many matches in parallel with bounded concurrency. */
export async function fetchLiveMatchDetailBatch(
  matchIds: number[],
  concurrency = 4,
): Promise<Map<number, StratzLiveDetail | null>> {
  const out = new Map<number, StratzLiveDetail | null>();
  let i = 0;
  async function worker(): Promise<void> {
    while (i < matchIds.length) {
      const idx = i++;
      const id = matchIds[idx]!;
      const detail = await fetchLiveMatchDetail(id).catch(() => null);
      out.set(id, detail);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, matchIds.length) }, worker));
  return out;
}
