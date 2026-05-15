import { Router, type IRouter } from 'express';
import { db, teamsTable, leaguesTable, heroStatsTable } from '@workspace/db';
import { inArray } from 'drizzle-orm';
import { getRandomUserAgent } from '../lib/userAgents';
import { withCache } from '../lib/responseCache';
import { getApiKey, getStratzToken } from '../services/ApiKeysService';

const router: IRouter = Router();

/**
 * Обогащает массив live-матчей именами команд из локальной таблицы teams.
 * OpenDota /api/live часто отдаёт `team_id_*` без `team_name_*` — мы берём
 * имена из нашего snapshot'а ~1000 команд (загружается ingest:teams).
 * Если команды нет в нашей таблице — оставляем как есть, мобильный клиент
 * покажет «Без названия».
 */
async function enrichLiveMatchesWithTeamNames(
  matches: unknown
): Promise<unknown> {
  if (!Array.isArray(matches) || matches.length === 0) return matches;

  // Имя считаем «отсутствующим», если значения нет, оно не строка или строка
  // из одних пробелов. team_id=0 — приватные лобби, в БД такого нет → скипаем.
  const isBlank = (v: unknown): boolean =>
    typeof v !== 'string' || v.trim().length === 0;
  const validId = (v: unknown): number | null =>
    typeof v === 'number' && v > 0 ? v : null;

  // Собираем уникальные team_id, у которых нет имени.
  const missingIds = new Set<number>();
  for (const raw of matches) {
    const m = raw as Record<string, unknown>;
    const tidR = validId(m['team_id_radiant']);
    const tidD = validId(m['team_id_dire']);
    if (tidR && isBlank(m['team_name_radiant'])) missingIds.add(tidR);
    if (tidD && isBlank(m['team_name_dire'])) missingIds.add(tidD);
  }
  if (missingIds.size === 0) return matches;

  const rows = await db
    .select({ teamId: teamsTable.teamId, name: teamsTable.name, tag: teamsTable.tag })
    .from(teamsTable)
    .where(inArray(teamsTable.teamId, Array.from(missingIds)));
  // Используем `||` (а не `??`), чтобы пустая строка `name` тоже падала на `tag`.
  const byId = new Map(rows.map(r => [r.teamId, (r.name || r.tag || '').trim()] as const));

  return matches.map(raw => {
    const m = raw as Record<string, unknown>;
    const tidR = validId(m['team_id_radiant']);
    const tidD = validId(m['team_id_dire']);
    const next = { ...m };
    if (tidR && isBlank(next['team_name_radiant'])) {
      const name = byId.get(tidR);
      if (name) next['team_name_radiant'] = name;
    }
    if (tidD && isBlank(next['team_name_dire'])) {
      const name = byId.get(tidD);
      if (name) next['team_name_dire'] = name;
    }
    return next;
  });
}

/**
 * Подмешивает в каждый матч поле `league_name` (берётся из локальной таблицы
 * `leagues`, заполняется ingest:leagues). Если лиги нет — оставляет undefined,
 * мобилка покажет fallback («Pro Match» / «Лига #N»). Поддерживает массив
 * объектов с полями `league_id` (OpenDota live) или `league.id` (PandaScore).
 */
async function enrichWithLeagueNames(matches: unknown): Promise<unknown> {
  if (!Array.isArray(matches) || matches.length === 0) return matches;
  const ids = new Set<number>();
  for (const raw of matches) {
    const m = raw as Record<string, unknown>;
    const direct = m['league_id'];
    if (typeof direct === 'number' && direct > 0) ids.add(direct);
    const nested = (m['league'] as Record<string, unknown> | undefined)?.['id'];
    if (typeof nested === 'number' && nested > 0) ids.add(nested);
  }
  if (ids.size === 0) return matches;
  const rows = await db
    .select({ leagueId: leaguesTable.leagueId, name: leaguesTable.name, tier: leaguesTable.tier })
    .from(leaguesTable)
    .where(inArray(leaguesTable.leagueId, Array.from(ids)));
  const byId = new Map(rows.map(r => [r.leagueId, { name: r.name ?? '', tier: r.tier ?? '' }] as const));
  return matches.map(raw => {
    const m = raw as Record<string, unknown>;
    const direct = m['league_id'] as number | undefined;
    const nested = (m['league'] as Record<string, unknown> | undefined)?.['id'] as number | undefined;
    const lid = (typeof direct === 'number' && direct > 0) ? direct
      : (typeof nested === 'number' && nested > 0) ? nested : null;
    if (lid === null) return m;
    const info = byId.get(lid);
    if (!info || !info.name) return m;
    return { ...m, league_name: info.name, league_tier: info.tier };
  });
}

const OPENDOTA_BASE = 'https://api.opendota.com/api';
const STRATZ_BASE = 'https://api.stratz.com/api/v1';
const PANDASCORE_BASE = 'https://api.pandascore.co';
// STRATZ_TOKEN / PANDASCORE_API_KEY — резолвим через ApiKeysService на каждый
// запрос, чтобы admin-web мог менять override без рестарта api-server.

// ── PandaScore running-enrichment ─────────────────────────────────────────

/** Нормализует имя команды: убирает «Team »/«ex-» префиксы, приводит к нижнему регистру. */
function normTeamName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/^team\s+/i, '')
    // ex-HEROIC, ex_TSM, ex.NaVi → heroic / tsm / navi (бывшие составы)
    .replace(/^ex[-_.\s]+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Достаточно ли похожи два нормализованных имени (одно содержит другое). */
function namesMatch(a: string, b: string): boolean {
  if (!a || !b || a.length < 2 || b.length < 2) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// ── Фильтр матчей по min team rating ──────────────────────────────────────
//
// Цель: не показывать в мобильном приложении матчи, в которых обе команды
// слабее заданного порога (по дефолту топ-300 OpenDota = рейтинг ≥1158).
// Если хотя бы одна команда дотягивает до порога — матч остаётся.
// Если обе команды нам неизвестны (нет в `teams`) — тоже скрываем: ML-предикт
// для них всё равно вернёт null, мобилка покажет «Данные собираются...» вечно.
//
// Конфигурируется через env `MIN_TEAM_RATING`. Установите `0`, чтобы выключить
// фильтр (показывать все матчи).

const MIN_TEAM_RATING_DEFAULT = 1158;

function getMinTeamRating(): number {
  const raw = process.env.MIN_TEAM_RATING;
  if (raw === undefined || raw === '') return MIN_TEAM_RATING_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : MIN_TEAM_RATING_DEFAULT;
}

interface TeamRatingMaps {
  byId: Map<number, number>;
  byNorm: Map<string, number>;
}

async function loadTeamRatings(input: {
  ids: number[];
  names: string[];
}): Promise<TeamRatingMaps> {
  const byId = new Map<number, number>();
  const byNorm = new Map<string, number>();
  const uniqIds = Array.from(new Set(input.ids.filter(n => n > 0)));
  const uniqNamesNorm = Array.from(new Set(input.names.map(normTeamName).filter(Boolean)));
  if (uniqIds.length === 0 && uniqNamesNorm.length === 0) return { byId, byNorm };

  // Тянем по id отдельным запросом (точный матч); по имени — ниже через
  // загрузку всех ratable-команд (taблица ~1000 строк, дешевле чем строить
  // CASE-WHEN по нормализованному имени).
  const rows = await db
    .select({
      teamId: teamsTable.teamId,
      name: teamsTable.name,
      tag: teamsTable.tag,
      rating: teamsTable.rating,
    })
    .from(teamsTable);
  for (const r of rows) {
    if (r.rating == null) continue;
    byId.set(r.teamId, r.rating);
    if (r.name) byNorm.set(normTeamName(r.name), r.rating);
    if (r.tag) byNorm.set(normTeamName(r.tag), r.rating);
  }
  return { byId, byNorm };
}

function bestRating(
  maps: TeamRatingMaps,
  teamId: unknown,
  teamName: unknown,
): number {
  let best = -Infinity;
  if (typeof teamId === 'number' && teamId > 0) {
    const r = maps.byId.get(teamId);
    if (r != null && r > best) best = r;
  }
  if (typeof teamName === 'string' && teamName.trim()) {
    const norm = normTeamName(teamName);
    const exact = maps.byNorm.get(norm);
    if (exact != null && exact > best) best = exact;
    // Substring-fallback для PS-имён, не совпадающих по точному ключу
    // (sponsor-префиксы вроде «Aurora Gaming» vs «Aurora», roster-trade
    // переименования и т.п.). Минимальная длина 5 чтобы не словить ложные
    // совпадения по коротким токенам ('ig', 'og', 'tsm').
    if (best === -Infinity && norm.length >= 5) {
      for (const [k, v] of maps.byNorm) {
        if (k.length < 3) continue;
        if (k.includes(norm) || norm.includes(k)) {
          if (v > best) best = v;
        }
      }
    }
  }
  return best;
}

/**
 * Фильтрует массив live-матчей (OpenDota / PandaScore-shape) по min team
 * rating. Для каждого матча: если хотя бы одна команда имеет рейтинг ≥
 * threshold — оставляем. Иначе скипаем.
 */
async function filterMatchesByMinRating<T>(
  matches: T[],
  extract: (m: T) => { idR: unknown; idD: unknown; nameR: unknown; nameD: unknown },
): Promise<T[]> {
  const min = getMinTeamRating();
  if (min <= 0 || matches.length === 0) return matches;
  const ids: number[] = [];
  const names: string[] = [];
  for (const m of matches) {
    const e = extract(m);
    if (typeof e.idR === 'number') ids.push(e.idR);
    if (typeof e.idD === 'number') ids.push(e.idD);
    if (typeof e.nameR === 'string') names.push(e.nameR);
    if (typeof e.nameD === 'string') names.push(e.nameD);
  }
  const maps = await loadTeamRatings({ ids, names });
  return matches.filter(m => {
    const e = extract(m);
    const rR = bestRating(maps, e.idR, e.nameR);
    const rD = bestRating(maps, e.idD, e.nameD);
    return Math.max(rR, rD) >= min;
  });
}

interface PsGame {
  status: string;
  winner?: { id?: number | null; name?: string };
  begin_at?: string | null;
}

interface PsRunningMatch {
  id: number;
  opponents?: Array<{ opponent?: { name?: string; id?: number } }>;
  games?: PsGame[];
  league?: { id?: number; name?: string };
  serie?: { full_name?: string };
  begin_at?: string;
  number_of_games?: number;
  results?: Array<{ team_id?: number; score?: number }>;
  league_id?: number;
}

/**
 * Конвертирует PandaScore /running матч в OpenDota-like форму, которую ждёт
 * мобилка (`team_name_radiant`, `team_id_radiant`, `radiant_score`,
 * `duration`, `league_id`, `league_name`, `current_map`,
 * `radiant_series_wins`, `dire_series_wins`). Используется как fallback,
 * когда OpenDota /api/live недоступен (HTTP 522/AbortError).
 *
 * Live game state (kills/duration) PS не отдаёт, оставляем нули — карточка
 * всё равно покажет команды + турнир + счёт серии, что и нужно пользователю.
 */
function psRunningToLiveShape(ps: PsRunningMatch[]): Record<string, unknown>[] {
  return ps.map((m, idx) => {
    const o1 = m.opponents?.[0]?.opponent;
    const o2 = m.opponents?.[1]?.opponent;
    const o1Id = o1?.id ?? null;
    const o2Id = o2?.id ?? null;
    const games = m.games ?? [];
    const finished = games.filter(g => g.status === 'finished');
    let r1 = 0, r2 = 0;
    finished.forEach(g => {
      const wId = g.winner?.id ?? null;
      if (wId === null) return;
      if (o1Id !== null && wId === o1Id) r1++;
      else if (o2Id !== null && wId === o2Id) r2++;
    });
    // Если winner.id отсутствует — fallback на results[].score (агрегат PS).
    if (r1 === 0 && r2 === 0 && Array.isArray(m.results)) {
      const a = m.results.find(x => x.team_id === o1Id)?.score ?? 0;
      const b = m.results.find(x => x.team_id === o2Id)?.score ?? 0;
      r1 = a; r2 = b;
    }
    const leagueId = m.league?.id ?? m.league_id ?? 0;
    return {
      // Используем синтетический match_id (отрицательный, не пересекается с OD).
      match_id: -m.id,
      ps_match_id: m.id,
      team_id_radiant: o1Id ?? 0,
      team_id_dire:    o2Id ?? 0,
      team_name_radiant: o1?.name ?? '',
      team_name_dire:    o2?.name ?? '',
      radiant_score: 0,
      dire_score: 0,
      duration: 0,
      spectators: 0,
      game_mode: 2,
      league_id: leagueId,
      league_name: m.league?.name ?? m.serie?.full_name ?? '',
      radiant_series_wins: r1,
      dire_series_wins:    r2,
      current_map: finished.length + 1,
      number_of_games: m.number_of_games ?? 3,
      source: 'pandascore',
      // Поле для дедупликации с OD — порядковый номер на случай одинаковых пар.
      _ps_idx: idx,
    };
  });
}

/**
 * OpenDota /api/live отдаёт каждую карту серии как отдельный матч.
 * Дедублицируем по паре team_id: если два матча между теми же командами —
 * оставляем тот, у которого наибольший match_id (более свежая карта).
 */
function deduplicateByTeamPair(matches: Record<string, unknown>[]): Record<string, unknown>[] {
  const best = new Map<string, Record<string, unknown>>();
  for (const m of matches) {
    const r = Number(m['team_id_radiant'] ?? 0);
    const d = Number(m['team_id_dire'] ?? 0);
    const key = [Math.min(r, d), Math.max(r, d)].join(':');
    const cur = best.get(key);
    if (!cur || Number(m['match_id'] ?? 0) > Number(cur['match_id'] ?? 0)) {
      best.set(key, m);
    }
  }
  return Array.from(best.values());
}

/**
 * Обогащает OpenDota pro-матчи данными из PandaScore /dota2/matches/running:
 *  - Счёт серии (radiant_series_wins / dire_series_wins) по реально завершённым играм
 *  - Номер текущей карты (current_map) = число завершённых игр + 1
 *  - ps_match_id — ID матча в PandaScore (для будущей интеграции с букмекерами)
 *  - Имена команд: PS-официальные если OpenDota не дал своих
 *
 * Матчинг по нормализованному имени команды (нечёткий: substring-match).
 * Если совпадение не найдено — матч возвращается без изменений.
 */
function enrichWithPandaScoreRunning(
  odMatches: unknown,
  psMatches: PsRunningMatch[],
): unknown {
  if (!Array.isArray(odMatches) || psMatches.length === 0) return odMatches;

  return odMatches.map(rawMatch => {
    const m = rawMatch as Record<string, unknown>;
    const odR = String(m['team_name_radiant'] ?? '');
    const odD = String(m['team_name_dire'] ?? '');
    const od1 = normTeamName(odR);
    const od2 = normTeamName(odD);

    const ps = psMatches.find(p => {
      const ps1 = normTeamName(p.opponents?.[0]?.opponent?.name);
      const ps2 = normTeamName(p.opponents?.[1]?.opponent?.name);
      return (namesMatch(od1, ps1) && namesMatch(od2, ps2)) ||
             (namesMatch(od1, ps2) && namesMatch(od2, ps1));
    });

    if (!ps) return m;

    // Определяем направление (radiant = opponent[0] или [1])
    const ps1 = ps.opponents?.[0]?.opponent;
    const ps2 = ps.opponents?.[1]?.opponent;
    const ps1Name = ps1?.name ?? '';
    const ps2Name = ps2?.name ?? '';
    const swapped = !namesMatch(od1, normTeamName(ps1Name));
    const psRadiantOpp = swapped ? ps2 : ps1;
    const psDireOpp    = swapped ? ps1 : ps2;
    const psRadiantName = psRadiantOpp?.name ?? '';
    const psDireName    = psDireOpp?.name ?? '';
    const psRadiantId   = psRadiantOpp?.id ?? null;
    const psDireId      = psDireOpp?.id ?? null;

    // Счёт по завершённым картам — winner.id матчим против opponent.id.
    // PandaScore возвращает winner:{id, type:"Team"} для finished-карт.
    let radiantWins = 0, direWins = 0;
    const games = ps.games ?? [];
    const finishedGames = games.filter(g => g.status === 'finished');
    finishedGames.forEach(g => {
      const wId = g.winner?.id ?? null;
      if (wId === null) return;
      if (psRadiantId !== null && wId === psRadiantId) radiantWins++;
      else if (psDireId !== null && wId === psDireId) direWins++;
    });

    const currentMap = finishedGames.length + 1;

    return {
      ...m,
      // Имена: оставляем OD если есть, иначе PS-официальные
      team_name_radiant: odR.trim() || psRadiantName,
      team_name_dire:    odD.trim() || psDireName,
      // Счёт серии и текущая карта из PS (надёжнее OD)
      radiant_series_wins: radiantWins,
      dire_series_wins:    direWins,
      current_map: currentMap,
      ps_match_id: ps.id,
    };
  });
}

// ── Hero name cache (lazy, refreshed раз в час) ────────────────────────────
//
// hero_stats заполняется ingest:hero-stats. Имена там — внутренние OD slugs
// (например, "antimage"). Этого достаточно для UI: на клиенте они мапятся в
// локализованные имена через локальный hero-каталог. Если кеш пуст (свежая
// БД) — отдаём `Hero #${id}` как fallback.
let heroNameCache: Map<number, string> | null = null;
let heroNameCacheAt = 0;
const HERO_CACHE_TTL_MS = 60 * 60 * 1000;

async function getHeroNames(): Promise<Map<number, string>> {
  const now = Date.now();
  if (heroNameCache && (now - heroNameCacheAt) < HERO_CACHE_TTL_MS) return heroNameCache;
  try {
    const rows = await db.select({ id: heroStatsTable.heroId, name: heroStatsTable.name }).from(heroStatsTable);
    heroNameCache = new Map(rows.map(r => [r.id, r.name] as const));
    heroNameCacheAt = now;
  } catch {
    heroNameCache = heroNameCache ?? new Map();
  }
  return heroNameCache;
}

// ── Live-draft enrichment ──────────────────────────────────────────────────
//
// OpenDota `/api/live` НЕ отдаёт пики/баны. Но `/api/matches/{id}` возвращает
// `picks_bans` даже для матча в процессе (как только драфт стартовал). Эту
// функцию мы вызываем после того, как PandaScore уже подмешал ps_match_id и
// мы знаем, какая карта сейчас идёт.
//
// Стратегия:
//  1. Параллельно (concurrency=4) fetch'им /api/matches/{match_id} для всех
//     pro-live матчей с валидным match_id.
//  2. Per-match cache 60s, чтобы при опросе мобилкой раз в 30s не бить OD на
//     тот же матч заново (rate limit OD = 60 req/min).
//  3. Маппим picks_bans → { picks: [{heroId, heroName, side, order}], bans: [...] }.
//     team=0 → radiant, team=1 → dire.
//  4. Если фетч упал/таймаут — матч возвращается без поля `draft` (UI покажет
//     placeholder «Драфт ещё не стартовал»).

interface OpenDotaPickBan {
  is_pick: boolean;
  hero_id: number;
  team: number; // 0 = radiant, 1 = dire
  order: number;
}

interface LiveDraftPayload {
  picks: Array<{ heroId: number; heroName: string; side: 'radiant' | 'dire'; order: number }>;
  bans: Array<{ heroId: number; heroName: string; side: 'radiant' | 'dire'; order: number }>;
  source: 'opendota';
  fetchedAt: string;
}

const draftCache = new Map<number, { payload: LiveDraftPayload | null; at: number }>();
const DRAFT_CACHE_TTL_MS = 60_000;
const DRAFT_CACHE_MAX = 200;

function setDraftCache(matchId: number, payload: LiveDraftPayload | null) {
  // Простая bounded LRU: при переполнении выкидываем самые старые записи
  // (Map сохраняет порядок вставки). 200 записей × ~5 KB = ~1 MB макс.
  draftCache.set(matchId, { payload, at: Date.now() });
  if (draftCache.size > DRAFT_CACHE_MAX) {
    const excess = draftCache.size - DRAFT_CACHE_MAX;
    const it = draftCache.keys();
    for (let i = 0; i < excess; i++) {
      const k = it.next().value;
      if (k !== undefined) draftCache.delete(k);
    }
  }
}

async function fetchOpenDotaDraft(matchId: number): Promise<LiveDraftPayload | null> {
  const cached = draftCache.get(matchId);
  if (cached && (Date.now() - cached.at) < DRAFT_CACHE_TTL_MS) return cached.payload;
  try {
    const resp = await apiFetch(`${OPENDOTA_BASE}/matches/${matchId}`, { timeout: 4000 });
    if (!resp.ok) {
      setDraftCache(matchId, null);
      return null;
    }
    const data = await resp.json() as { picks_bans?: OpenDotaPickBan[] };
    const pb = Array.isArray(data.picks_bans) ? data.picks_bans : [];
    if (pb.length === 0) {
      setDraftCache(matchId, null);
      return null;
    }
    const heroes = await getHeroNames();
    const heroName = (id: number) => heroes.get(id) ?? `Hero #${id}`;
    const payload: LiveDraftPayload = {
      picks: pb.filter(p => p.is_pick).map(p => ({
        heroId: p.hero_id,
        heroName: heroName(p.hero_id),
        side: p.team === 0 ? 'radiant' : 'dire',
        order: p.order,
      })),
      bans: pb.filter(p => !p.is_pick).map(p => ({
        heroId: p.hero_id,
        heroName: heroName(p.hero_id),
        side: p.team === 0 ? 'radiant' : 'dire',
        order: p.order,
      })),
      source: 'opendota',
      fetchedAt: new Date().toISOString(),
    };
    setDraftCache(matchId, payload);
    return payload;
  } catch {
    setDraftCache(matchId, null);
    return null;
  }
}

async function enrichLiveMatchesWithDrafts(matches: unknown): Promise<unknown> {
  if (!Array.isArray(matches) || matches.length === 0) return matches;
  // Concurrency=4: типично 5-10 live-матчей, не хотим съесть весь rate-limit
  // OD (60/min). Fetch занимает ~300-800ms, total <2s даже для 10 матчей.
  const idSet = new Set<number>();
  for (const raw of matches) {
    const id = Number((raw as Record<string, unknown>)['match_id'] ?? 0);
    if (id > 0) idSet.add(id);
  }
  const ids = Array.from(idSet);
  const drafts = new Map<number, LiveDraftPayload | null>();
  const CONCURRENCY = 4;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(id => fetchOpenDotaDraft(id)));
    batch.forEach((id, idx) => drafts.set(id, results[idx] ?? null));
  }
  return matches.map(raw => {
    const m = raw as Record<string, unknown>;
    const id = Number(m['match_id'] ?? 0);
    const draft = id > 0 ? drafts.get(id) : null;
    return draft ? { ...m, draft } : m;
  });
}

interface RequestOptions {
  timeout?: number;
  headers?: Record<string, string>;
}

async function apiFetch(url: string, options: RequestOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout ?? 10000);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/json',
        ...options.headers,
      },
    });
    return resp;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Кэшируем live-ответ на 30с: мобилка опрашивает раз в 60с, и при N клиентах
// без кэша мы бы N раз в минуту били OpenDota (rate-limit 60/min).
router.get('/live', async (req, res) => {
  // Не кэшируем неудачные ответы (noData=true): если у OpenDota транзиентный
  // 503, мы не должны 30с подряд возвращать пустоту всем клиентам.
  const payload = await withCache('matches:live', 30_000, async () => {
    const results: { source: string; data: unknown; error?: string }[] = [];

    const pandascoreKey = getApiKey('PANDASCORE_API_KEY');

    // Запрашиваем OpenDota live, PandaScore running и Stratz параллельно.
    // PandaScore /running даёт официальные имена команд, счёт серии и номер
    // текущей карты. OpenDota даёт реальный game state (kills, gold, time).
    const openDotaPromise = apiFetch(`${OPENDOTA_BASE}/live`, { timeout: 20_000 })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const raw = await r.json() as unknown;
        // Фильтруем только профессиональные матчи: у них league_id > 0 или
        // team_id_radiant/dire > 0. Паблики (100% трафика /api/live) отбрасываем —
        // у них нет имён команд и они не релевантны для беттинг-аналитики.
        const proOnly = Array.isArray(raw)
          ? deduplicateByTeamPair(
              raw.filter((m: Record<string, unknown>) =>
                (typeof m['league_id'] === 'number' && m['league_id'] > 0) ||
                (typeof m['team_id_radiant'] === 'number' && m['team_id_radiant'] > 0) ||
                (typeof m['team_id_dire'] === 'number' && m['team_id_dire'] > 0)
              )
            )
          : raw;
        const enriched = await enrichLiveMatchesWithTeamNames(proOnly).catch(err => {
          req.log.warn({ err }, 'team-name enrichment failed, returning pro-only raw');
          return proOnly;
        });
        const data = await enrichWithLeagueNames(enriched).catch(err => {
          req.log.warn({ err }, 'league enrichment failed, returning raw');
          return enriched;
        });
        return { source: 'opendota', data };
      })
      .catch(err => ({ source: 'opendota', data: [], error: String(err) }));

    // PandaScore /running: официальные метаданные про-матчей (счёт серии, карта).
    // Timeout 5s чтобы не тормозить ответ если PS недоступен.
    const pandascoreRunningPromise = pandascoreKey
      ? apiFetch(
          `${PANDASCORE_BASE}/dota2/matches/running?token=${pandascoreKey}&page[size]=20`,
          { timeout: 5000 },
        )
          .then(async r => r.ok ? (await r.json() as PsRunningMatch[]) : [])
          .catch(() => [] as PsRunningMatch[])
      : Promise.resolve([] as PsRunningMatch[]);

    const stratzToken = getStratzToken();
    const stratzPromise = stratzToken
      ? apiFetch(`${STRATZ_BASE}/League/live`, { headers: { Authorization: `Bearer ${stratzToken}` } })
          .then(async r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json() as unknown;
            return { source: 'stratz', data };
          })
          .catch(err => ({ source: 'stratz', data: null, error: String(err) }))
      : Promise.resolve({ source: 'stratz', data: null, error: 'STRATZ_TOKEN не настроен' });

    const [openDota, stratz, psRunning] = await Promise.allSettled([
      openDotaPromise, stratzPromise, pandascoreRunningPromise,
    ]);

    const psMatches = psRunning.status === 'fulfilled' ? psRunning.value : [];

    const odData = openDota.status === 'fulfilled' ? openDota.value.data : [];
    const odIsArray = Array.isArray(odData);
    const odCount = odIsArray ? (odData as unknown[]).length : 0;

    if (openDota.status === 'fulfilled') {
      // Если PandaScore вернул running-матчи — обогащаем OD данные:
      // счёт серии, текущая карта, ps_match_id.
      const psEnriched = psMatches.length > 0
        ? enrichWithPandaScoreRunning(openDota.value.data, psMatches)
        : openDota.value.data;
      // Подмешиваем picks_bans для каждого live-матча из OD /matches/{id}.
      // Кешируется per-match на 60s, поэтому даже при cache miss верхнего
      // уровня (раз в 30s) мы не убиваем rate-limit OpenDota.
      const withDrafts = await enrichLiveMatchesWithDrafts(psEnriched).catch(err => {
        req.log.warn({ err }, 'live draft enrichment failed, returning without drafts');
        return psEnriched;
      });
      // Фильтр по min team rating: матчи где обе команды слабее порога
      // (по дефолту топ-300 = ≥1158) скрываем — для них всё равно нет ML.
      const filtered = Array.isArray(withDrafts)
        ? await filterMatchesByMinRating(
            withDrafts as Record<string, unknown>[],
            m => ({
              idR: m['team_id_radiant'],
              idD: m['team_id_dire'],
              nameR: m['team_name_radiant'],
              nameD: m['team_name_dire'],
            }),
          ).catch(err => {
            req.log.warn({ err }, 'rating filter failed, returning unfiltered');
            return withDrafts as Record<string, unknown>[];
          })
        : withDrafts;
      const beforeN = Array.isArray(withDrafts) ? withDrafts.length : 0;
      const afterN = Array.isArray(filtered) ? filtered.length : 0;
      if (beforeN > afterN) {
        req.log.info(
          { tag: 'rating-filter', source: 'opendota', kept: afterN, dropped: beforeN - afterN, minRating: getMinTeamRating() },
          '[matches/live] filtered low-tier matches',
        );
      }
      results.push({ ...openDota.value, data: filtered });
    }
    if (stratz.status === 'fulfilled') results.push(stratz.value);

    // PandaScore /running как fallback-источник live-матчей. Если OpenDota /live
    // упал (HTTP 522 / AbortError — Cloudflare часто так делает) или вернул 0
    // pro-матчей, мы всё равно показываем актуальные команды + турнир + счёт
    // серии. Live game state (kills/duration) недоступен — карточка покажет
    // нули, но пара команд и название турнира — реальные.
    if (odCount === 0 && psMatches.length > 0) {
      const psShaped = await enrichWithLeagueNames(psRunningToLiveShape(psMatches)).catch(() => psRunningToLiveShape(psMatches));
      const psFiltered = Array.isArray(psShaped)
        ? await filterMatchesByMinRating(
            psShaped as Record<string, unknown>[],
            m => ({
              idR: m['team_id_radiant'],
              idD: m['team_id_dire'],
              nameR: m['team_name_radiant'],
              nameD: m['team_name_dire'],
            }),
          ).catch(() => psShaped as Record<string, unknown>[])
        : psShaped;
      results.push({ source: 'pandascore', data: psFiltered });
    }

    const hasData = results.some(r => !r.error && Array.isArray(r.data) && (r.data as unknown[]).length > 0);
    return {
      sources: results,
      // Никаких заглушечных данных: если у нас нет реальных матчей — отдаём
      // пустой список с флагом noData, чтобы клиент мог показать корректное
      // пустое состояние.
      noData: !hasData,
      pandascoreRunning: psMatches.length,
    };
  }, (v) => !(v as { noData?: boolean }).noData);
  res.json(payload);
});

// upcoming тоже кэшируем — 60с (предматчевое расписание меняется медленно).
router.get('/upcoming', async (req, res) => {
  const pandascoreKey = getApiKey('PANDASCORE_API_KEY');
  if (!pandascoreKey) {
    res.json({
      noData: true,
      error: 'PANDASCORE_API_KEY не настроен. Получить: https://pandascore.co',
      data: [],
    });
    return;
  }
  try {
    const data = await withCache('matches:upcoming', 60_000, async () => {
      const url = new URL(`${PANDASCORE_BASE}/dota2/matches/upcoming`);
      url.searchParams.set('token', pandascoreKey);
      url.searchParams.set('page[size]', '20');
      url.searchParams.set('sort', 'begin_at');
      url.searchParams.set('filter[status]', 'not_started');
      const resp = await apiFetch(url.toString());
      if (!resp.ok) throw new Error(`PandaScore: HTTP ${resp.status}`);
      const raw = await resp.json() as unknown;
      const enriched = await enrichWithLeagueNames(raw).catch(() => raw);
      // Фильтр по min team rating: PS upcoming имеет shape
      // [{opponents:[{opponent:{id,name}}]}] — извлекаем имена и сравниваем
      // с нашей таблицей `teams`.
      if (!Array.isArray(enriched)) return enriched;
      return await filterMatchesByMinRating(
        enriched as Record<string, unknown>[],
        m => {
          const opps = (m['opponents'] as Array<{ opponent?: { id?: number; name?: string } }> | undefined) ?? [];
          return {
            idR: undefined,
            idD: undefined,
            nameR: opps[0]?.opponent?.name,
            nameD: opps[1]?.opponent?.name,
          };
        },
      ).catch(() => enriched);
    });
    res.json({ noData: false, data });
  } catch (err) {
    req.log.error({ err }, 'PandaScore upcoming error');
    res.json({ noData: true, error: String(err), data: [] });
  }
});

// heroes/hero-stats — почти статические данные. Кэш 1 час.
router.get('/heroes', async (req, res) => {
  try {
    const data = await withCache('matches:heroes', 3_600_000, async () => {
      const resp = await apiFetch(`${OPENDOTA_BASE}/heroes`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json() as unknown;
    });
    res.json({ noData: false, data });
  } catch (err) {
    req.log.error({ err }, 'Heroes fetch error');
    res.json({ noData: true, data: [] });
  }
});

router.get('/hero-stats', async (req, res) => {
  try {
    const resp = await apiFetch(`${OPENDOTA_BASE}/heroStats`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as unknown;
    res.json({ noData: false, data });
  } catch (err) {
    req.log.error({ err }, 'Hero stats fetch error');
    res.json({ noData: true, data: [] });
  }
});

export default router;
