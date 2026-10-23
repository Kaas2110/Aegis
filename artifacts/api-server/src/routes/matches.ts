import { Router, type IRouter } from 'express';
import { db, teamsTable, leaguesTable, heroStatsTable, liveSnapshotsTable, matchDraftsTable, proMatchesTable } from '@workspace/db';
import { inArray, and, or, eq, gte, sql } from 'drizzle-orm';
import { withCache } from '../lib/responseCache';
import { getOpenDotaLiveFeed, LIVE_FEED_TTL_MS } from '../services/OpenDotaLiveFeed';
import { observedLiveDraft } from '../lib/observedLiveDraft';
import { getAppSettings } from '../services/AppSettings';
import { readProviderFeed, FEED_INTERVALS } from '../services/ProviderFeeds';
import { feedIsStale } from '../lib/backgroundFeed';
import {verifiedRunningSeriesIdentity} from '../services/BookmakerMatcher';

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
 * мобилка покажет fallback («Pro Match» / «Лига #N»).
 *
 * ⚠️ Матчи, у которых УЖЕ есть собственное имя лиги (`league.name` в
 * PandaScore-форме), НЕ трогаем: у PandaScore СВОЁ ID-пространство лиг
 * (и flat `league_id`, и `league.id` — это PS-IDs), а наша таблица `leagues` —
 * OpenDota-IDs. Подстановка по числовому совпадению давала коллизии:
 * EWC (PS league 5404) показывался как «U Tournament» (OpenDota league 5404).
 */
function hasOwnLeagueName(m: Record<string, unknown>): boolean {
  const nested = m['league'] as Record<string, unknown> | undefined;
  return typeof nested?.['name'] === 'string' && (nested['name'] as string).trim().length > 0;
}

async function enrichWithLeagueNames(matches: unknown): Promise<unknown> {
  if (!Array.isArray(matches) || matches.length === 0) return matches;
  const ids = new Set<number>();
  for (const raw of matches) {
    const m = raw as Record<string, unknown>;
    if (hasOwnLeagueName(m)) continue;
    const direct = m['league_id'];
    if (typeof direct === 'number' && direct > 0) ids.add(direct);
  }
  if (ids.size === 0) return matches;
  const rows = await db
    .select({ leagueId: leaguesTable.leagueId, name: leaguesTable.name, tier: leaguesTable.tier })
    .from(leaguesTable)
    .where(inArray(leaguesTable.leagueId, Array.from(ids)));
  const byId = new Map(rows.map(r => [r.leagueId, { name: r.name ?? '', tier: r.tier ?? '' }] as const));
  return matches.map(raw => {
    const m = raw as Record<string, unknown>;
    if (hasOwnLeagueName(m)) return m;
    const direct = m['league_id'] as number | undefined;
    const lid = (typeof direct === 'number' && direct > 0) ? direct : null;
    if (lid === null) return m;
    const info = byId.get(lid);
    if (!info || !info.name) return m;
    return { ...m, league_name: info.name, league_tier: info.tier };
  });
}


// API keys are resolved only by the background collector.

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
// Конфигурируется из админки (app_settings.min_team_rating, дефолт 1200).
// ENV `MIN_TEAM_RATING` имеет приоритет если задан (override для отладки).
// Установите `0` (в БД или env), чтобы выключить фильтр.

async function getMinTeamRating(): Promise<number> {
  const raw = process.env.MIN_TEAM_RATING;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  try {
    const s = await getAppSettings();
    return s.minTeamRating ?? 0;
  } catch {
    return 0;
  }
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
  const min = await getMinTeamRating();
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
  position?: number;
  winner?: { id?: number | null; name?: string };
  begin_at?: string | null;
  end_at?: string | null;
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
    const seriesIdentity=verifiedRunningSeriesIdentity(o1?.name??'',o2?.name??'',ps);
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
    // Между картами и без OD-источника: серия идёт, но текущая карта в драфте
    // (есть finished, но running ещё не начался — или running начался <60s
    // назад и реальной игры пока нет). UI покажет «ПЕРЕРЫВ» вместо стейл-live.
    const runningGame = games.find(g => g.status === 'running');
    const nowSec = Math.floor(Date.now() / 1000);
    const runningStartedRecently = runningGame?.begin_at
      ? Math.floor(new Date(runningGame.begin_at).getTime() / 1000) > nowSec - 60
      : false;
    const betweenMaps = finished.length > 0 && (!runningGame || runningStartedRecently);
    // B2: время окончания последней завершённой карты — используем в /live
    // чтобы отбросить «протухшие» between-maps матчи (серия закончилась >20мин
    // назад, но PS не пометил статус). Берём максимум end_at среди finished.
    let latestEndAtSec = 0;
    for (const g of finished) {
      if (!g.end_at) continue;
      const t = Math.floor(new Date(g.end_at).getTime() / 1000);
      if (t > latestEndAtSec) latestEndAtSec = t;
    }
    return {
      // Используем синтетический match_id (отрицательный, не пересекается с OD).
      match_id: -m.id,
      ps_match_id: m.id,
      series_start_time: seriesIdentity?.id===m.id ? seriesIdentity.startsAt : null,
      series_identity_verified: seriesIdentity?.id===m.id,
      _latest_end_at_sec: latestEndAtSec,
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
      between_maps: betweenMaps,
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
    const seriesIdentity=verifiedRunningSeriesIdentity(odR,odD,psMatches);
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

    // ── Детект "между картами / в драфте" ─────────────────────────────────
    // OpenDota /api/live кеширует данные предыдущей карты ещё долго после её
    // конца (activate_time старый, game_time продолжает «тикать», score 32:43
    // от Map 1). PandaScore же даёт честную картину: какая игра position=N
    // сейчас status='running' и её begin_at. Если begin_at running-игры
    // позже OD activate_time на >60s → OD показывает устаревшие данные
    // прошлой карты. UI должен показать «Серия 1-0, готовимся к карте N»
    // вместо фейкового live-снапшота.
    const runningGame = games.find(g => g.status === 'running');
    const odActivateTime = typeof m['activate_time'] === 'number' ? m['activate_time'] as number : 0;
    let betweenMaps = false;
    if (finishedGames.length > 0) {
      if (!runningGame) {
        // Нет ни одной running-игры в PS, но серия идёт → пауза между картами.
        betweenMaps = true;
      } else if (runningGame.begin_at && odActivateTime > 0) {
        const psStartSec = Math.floor(new Date(runningGame.begin_at).getTime() / 1000);
        // OD activate_time старее PS running game.begin_at на минуту+ → OD показывает
        // прошлую карту, реальная новая ещё в драфте/loading screen.
        if (psStartSec > odActivateTime + 60) {
          betweenMaps = true;
        }
      }
    }
    // B2: запоминаем end_at последней завершённой карты для staleness-фильтра.
    let latestEndAtSec = 0;
    for (const g of finishedGames) {
      if (!g.end_at) continue;
      const t = Math.floor(new Date(g.end_at).getTime() / 1000);
      if (t > latestEndAtSec) latestEndAtSec = t;
    }

    if (betweenMaps) {
      // Чистим live-снапшот: ML на устаревших данных предыдущей карты считать
      // нельзя, и пользователю не показываем фейковый «65:07 32:43».
      // Сохраняем счёт серии и команды — это и есть полезная инфа на этот момент.
      return {
        ...m,
        team_name_radiant: odR.trim() || psRadiantName,
        team_name_dire:    odD.trim() || psDireName,
        radiant_series_wins: radiantWins,
        dire_series_wins:    direWins,
        current_map: currentMap,
        ps_match_id: ps.id,
        series_start_time: seriesIdentity?.id===ps.id ? seriesIdentity.startsAt : null,
        series_identity_verified: seriesIdentity?.id===ps.id,
        between_maps: true,
        // Зануляем устаревшие OD-поля чтобы UI не показывал стейл
        game_time: 0,
        radiant_score: 0,
        dire_score: 0,
        radiant_lead: 0,
        draft: undefined,
      };
    }

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
      series_start_time: seriesIdentity?.id===ps.id ? seriesIdentity.startsAt : null,
      series_identity_verified: seriesIdentity?.id===ps.id,
      between_maps: false,
      _latest_end_at_sec: latestEndAtSec,
    };
  });
}

// B2: BETWEEN_MAPS_TIMEOUT_MS — серия, висящая в between_maps дольше этого
// окна (default 20 мин), считается завершённой/брошенной и не показывается.
// PS иногда не переключает status=finished вовремя.
const BETWEEN_MAPS_TIMEOUT_MS = 20 * 60 * 1000;

function dropStaleBetweenMaps(matches: unknown): unknown {
  if (!Array.isArray(matches)) return matches;
  const cutoffSec = Math.floor((Date.now() - BETWEEN_MAPS_TIMEOUT_MS) / 1000);
  return matches.filter(raw => {
    const m = raw as Record<string, unknown>;
    if (m['between_maps'] !== true) return true;
    const t = Number(m['_latest_end_at_sec'] ?? 0);
    if (t > 0 && t < cutoffSec) return false;
    return true;
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

// Live hero selections come from the already fetched lineup. Repeated calls to
// /matches/{id} while a match is running waste the free budget and are not a
// verified source of live ban history. Completed replay drafts use the path below.
interface LiveDraftPayload {
  picks: Array<{heroId:number;heroName:string;side:'radiant'|'dire';order:number}>;
  bans: Array<{heroId:number;heroName:string;side:'radiant'|'dire';order:number}>;
  source:'opendota'; fetchedAt:string;
}
async function enrichLiveMatchesWithDrafts(matches: unknown, fetchedAt: string | null): Promise<unknown> {
  if (!Array.isArray(matches) || !matches.length || !fetchedAt) return matches;
  const names=await getHeroNames();
  return matches.map(raw=>{
    const m=raw as Record<string,unknown>;
    const draft=observedLiveDraft(m,names,fetchedAt);
    return draft?{...m,draft}:m;
  });
}

// ── Драфты завершённых карт live-серии ────────────────────────────────────
//
// Мобилка во вкладке «Драфт» показывает подвкладки «Карта 1..N». Раньше драфт
// был доступен только для текущей карты; для уже сыгранных карт стояла
// заглушка «появится когда стартует» — баг. Здесь достаём драфты сыгранных
// карт серии:
//   1. Сыгранные карты определяем по live_snapshots: LiveWorker пишет снапшоты
//      каждой карты (matchId + team ids). Окно 12h покрывает любую BO5.
//   2. Драфт карты берём из match_drafts (заполняется ingest:drafts), а если
//      ingest ещё не успел — возвращаем draft=null до следующего фонового ingest.
//      Чтение серии никогда не загружает replay по запросу пользователя.

const SERIES_WINDOW_MS = 12 * 60 * 60 * 1000;
const FINISHED_DRAFT_TTL_MS = 30 * 60 * 1000;
const FINISHED_DRAFT_NULL_TTL_MS = 60 * 1000;
const FINISHED_DRAFT_CACHE_MAX = 300;
const finishedDraftCache = new Map<number, { payload: LiveDraftPayload | null; at: number }>();

async function getFinishedMapDraft(matchId: number): Promise<LiveDraftPayload | null> {
  const cached = finishedDraftCache.get(matchId);
  if (cached) {
    const ttl = cached.payload ? FINISHED_DRAFT_TTL_MS : FINISHED_DRAFT_NULL_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.payload;
  }
  // 1) Локальная таблица match_drafts (после ingest:drafts) — без внешних вызовов.
  let payload: LiveDraftPayload | null = null;
  try {
    const rows = await db.select().from(matchDraftsTable)
      .where(eq(matchDraftsTable.matchId, matchId)).limit(1);
    const row = rows[0];
    if (row && (row.radiantPicks.length > 0 || row.direPicks.length > 0)) {
      const heroes = await getHeroNames();
      const nameOf = (id: number) => heroes.get(id) ?? `Hero #${id}`;
      const mk = (ids: number[], side: 'radiant' | 'dire', base: number) =>
        ids.map((heroId, i) => ({ heroId, heroName: nameOf(heroId), side, order: base + i }));
      payload = {
        picks: [...mk(row.radiantPicks, 'radiant', 0), ...mk(row.direPicks, 'dire', 100)],
        bans: [...mk(row.radiantBans, 'radiant', 0), ...mk(row.direBans, 'dire', 100)],
        source: 'opendota',
        fetchedAt: row.fetchedAt.toISOString(),
      };
    }
  } catch { /* Return unknown until the background ingest supplies a draft. */ }
  finishedDraftCache.set(matchId, { payload, at: Date.now() });
  if (finishedDraftCache.size > FINISHED_DRAFT_CACHE_MAX) {
    const excess = finishedDraftCache.size - FINISHED_DRAFT_CACHE_MAX;
    const it = finishedDraftCache.keys();
    for (let i = 0; i < excess; i++) {
      const k = it.next().value;
      if (k !== undefined) finishedDraftCache.delete(k);
    }
  }
  return payload;
}

/**
 * GET /api/matches/series-drafts
 *   ?team1Id=&team2Id=            — пара команд текущей live-серии (обязательно)
 *   &currentMatchId=              — OD match_id текущей ИГРАЮЩЕЙСЯ карты
 *                                   (не передавать между картами: OD в этот
 *                                   момент держит id уже завершённой карты)
 *   &currentMapNumber=            — номер текущей карты по PandaScore (1-based)
 *
 * Ответ: { maps: [{ mapNumber, matchId, radiantTeamId, direTeamId, draft }] }
 * — только сыгранные карты. mapNumber выравнивается с конца: последняя
 * сыгранная карта = currentMapNumber - 1 (счёт PS надёжнее, чем полнота
 * наших снапшотов). draft=null — честный «данные ещё не готовы» для UI.
 */
router.get('/series-drafts', async (req, res) => {
  const team1Id = Number(req.query['team1Id']);
  const team2Id = Number(req.query['team2Id']);
  const currentMatchIdRaw = Number(req.query['currentMatchId'] ?? 0);
  const currentMatchId = Number.isInteger(currentMatchIdRaw) && currentMatchIdRaw > 0 ? currentMatchIdRaw : 0;
  const currentMapRaw = Number(req.query['currentMapNumber'] ?? 0);
  const currentMapNumber = Number.isInteger(currentMapRaw) && currentMapRaw >= 1 && currentMapRaw <= 5 ? currentMapRaw : 0;
  if (!Number.isInteger(team1Id) || team1Id <= 0 ||
      !Number.isInteger(team2Id) || team2Id <= 0 || team1Id === team2Id) {
    res.status(400).json({ error: 'team1Id и team2Id обязательны (положительные, разные)' });
    return;
  }
  try {
    const key = `series-drafts:${team1Id}:${team2Id}:${currentMatchId}:${currentMapNumber}`;
    const result = await withCache(key, 60_000, async () => {
      const cutoff = new Date(Date.now() - SERIES_WINDOW_MS);
      // Источник 1: live_snapshots (LiveWorker пишет их пока OD /api/live жив).
      const snapRows = await db.select({
        matchId: liveSnapshotsTable.matchId,
        radiantTeamId: liveSnapshotsTable.radiantTeamId,
        direTeamId: liveSnapshotsTable.direTeamId,
        firstSeenSec: sql<number>`extract(epoch from min(${liveSnapshotsTable.capturedAt}))::bigint`,
      })
        .from(liveSnapshotsTable)
        .where(and(
          gte(liveSnapshotsTable.capturedAt, cutoff),
          or(
            and(eq(liveSnapshotsTable.radiantTeamId, team1Id), eq(liveSnapshotsTable.direTeamId, team2Id)),
            and(eq(liveSnapshotsTable.radiantTeamId, team2Id), eq(liveSnapshotsTable.direTeamId, team1Id)),
          ),
        ))
        .groupBy(liveSnapshotsTable.matchId, liveSnapshotsTable.radiantTeamId, liveSnapshotsTable.direTeamId)
        .orderBy(sql`min(${liveSnapshotsTable.capturedAt}) asc`);

      // Источник 2: pro_matches (hourly ingest). Покрывает серии, которые шли
      // без OD live (429/квота): карта появится здесь в течение часа после
      // восстановления квоты, и драфт подтянется из match_drafts.
      const cutoffSec = Math.floor(cutoff.getTime() / 1000);
      const proRows = await db.select({
        matchId: proMatchesTable.matchId,
        radiantTeamId: proMatchesTable.radiantTeamId,
        direTeamId: proMatchesTable.direTeamId,
        startTime: proMatchesTable.startTime,
      })
        .from(proMatchesTable)
        .where(and(
          gte(proMatchesTable.startTime, cutoffSec),
          or(
            and(eq(proMatchesTable.radiantTeamId, team1Id), eq(proMatchesTable.direTeamId, team2Id)),
            and(eq(proMatchesTable.radiantTeamId, team2Id), eq(proMatchesTable.direTeamId, team1Id)),
          ),
        ))
        .orderBy(sql`${proMatchesTable.startTime} asc`);

      // Merge + dedupe по matchId; сортировка по времени первого появления.
      // В live_snapshots capturedAt ≥ фактического старта карты, в pro_matches
      // start_time — точный старт; для одного matchId берём pro_matches-версию.
      const byId = new Map<number, { matchId: number; radiantTeamId: number | null; direTeamId: number | null; orderSec: number }>();
      for (const r of snapRows) {
        byId.set(r.matchId, { matchId: r.matchId, radiantTeamId: r.radiantTeamId, direTeamId: r.direTeamId, orderSec: Number(r.firstSeenSec) });
      }
      for (const r of proRows) {
        byId.set(r.matchId, { matchId: r.matchId, radiantTeamId: r.radiantTeamId, direTeamId: r.direTeamId, orderSec: r.startTime });
      }
      const rows = Array.from(byId.values()).sort((a, b) => a.orderSec - b.orderSec);

      const finishedRows = rows.filter(r => r.matchId !== currentMatchId);
      const total = finishedRows.length;
      // Номеруем с конца: последняя сыгранная = currentMapNumber - 1.
      // Если currentMapNumber не передан — просто 1..N по порядку снапшотов.
      const lastNumber = currentMapNumber >= 2 ? currentMapNumber - 1 : total;
      const maps: Array<{
        mapNumber: number;
        matchId: number;
        radiantTeamId: number | null;
        direTeamId: number | null;
        draft: LiveDraftPayload | null;
      }> = [];
      for (let i = 0; i < total; i++) {
        const r = finishedRows[i]!;
        const mapNumber = lastNumber - (total - 1 - i);
        if (mapNumber < 1) continue; // рассинхрон снапшотов и счёта PS — лишние отбрасываем
        maps.push({
          mapNumber,
          matchId: r.matchId,
          radiantTeamId: r.radiantTeamId,
          direTeamId: r.direTeamId,
          draft: await getFinishedMapDraft(r.matchId),
        });
      }
      return { maps };
    }, v => v.maps.length > 0); // пустой ответ не кэшируем: снапшоты могли ещё не записаться
    res.json(result);
  } catch (err) {
    req.log.error({ err }, 'series-drafts failed');
    res.status(500).json({ error: 'Не удалось получить драфты серии' });
  }
});

// Every public match route reads only stored snapshots. Workers own all provider requests.
router.get('/live', async (req, res) => {
  // Only local enrichment is cached; provider receipt timestamps remain unchanged.
  const liveTtlMs = 30_000;
  const payload = await withCache('matches:live', liveTtlMs, async () => {
    const results: { source: string; data: unknown; fetchedAt?: string | null; stale?: boolean; error?: string }[] = [];

    const [psFeed, stratzFeed] = await Promise.all([
      readProviderFeed('pandascore_running'), readProviderFeed('stratz_live'),
    ]);

    // Читаем сохранённые OpenDota, PandaScore и STRATZ snapshots.
    // PandaScore /running даёт официальные имена команд, счёт серии и номер
    // текущей карты. OpenDota даёт реальный game state (kills, gold, time).
    let openDotaFetchedAt: string | null = null;
    let openDotaAttemptedAt: string | null = null;
    const openDotaPromise = getOpenDotaLiveFeed()
      .then(async feed => {
        const raw = feed.data;
        openDotaFetchedAt = feed.fetchedAt.toISOString();
        openDotaAttemptedAt = feed.attemptedAt;
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
        return { source: 'opendota', data, fetchedAt: openDotaFetchedAt, ...(feed.error ? {error: feed.error} : {}), stale: Boolean(feed.error) || Date.now() - feed.fetchedAt.getTime() >= LIVE_FEED_TTL_MS };
      })
      .catch(() => ({ source: 'opendota', data: null, fetchedAt: null, stale: true, error: 'background_feed_unavailable' }));

    // PandaScore /running: официальные метаданные про-матчей (счёт серии, карта).
    // Даже при сбое/истечении TTL здесь нет внешнего запроса.
    const pandascoreRunningPromise = Promise.resolve((psFeed.data ?? []) as PsRunningMatch[]);
    const stratzPromise = Promise.resolve(stratzFeed.data)
      .then(enrichLiveMatchesWithTeamNames)
      .then(enrichWithLeagueNames)
      .then(data => ({source: 'stratz', data, fetchedAt: stratzFeed.receivedAt, stale: feedIsStale(stratzFeed, FEED_INTERVALS.stratz_live), ...(stratzFeed.error ? {error: stratzFeed.error} : {})}));

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
      // Reuse observed picks from the shared live response; no per-match replay requests.
      const withDrafts = await enrichLiveMatchesWithDrafts(psEnriched, openDotaFetchedAt).catch(err => {
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
          { tag: 'rating-filter', source: 'opendota', kept: afterN, dropped: beforeN - afterN, minRating: await getMinTeamRating() },
          '[matches/live] filtered low-tier matches',
        );
      }
      const fresh = dropStaleBetweenMaps(filtered);
      results.push({ ...openDota.value, data: fresh });
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
      results.push({ source: 'pandascore', data: dropStaleBetweenMaps(psFiltered), fetchedAt: psFeed.receivedAt, stale: feedIsStale(psFeed, FEED_INTERVALS.pandascore_running), ...(psFeed.error ? {error: psFeed.error} : {}) });
    }

    const primary = results.find(r => Array.isArray(r.data) && r.data.length > 0) ?? results.find(r => Array.isArray(r.data));
    const odResult = results.find(r => r.source === 'opendota');
    const hasData = results.some(r => !r.error && Array.isArray(r.data) && (r.data as unknown[]).length > 0);
    return {
      sources: results,
      // Никаких заглушечных данных: если у нас нет реальных матчей — отдаём
      // пустой список с флагом noData, чтобы клиент мог показать корректное
      // пустое состояние.
      noData: !hasData,
      pandascoreRunning: psMatches.length,
      unavailable: !results.some(r => !r.error && Array.isArray(r.data)) && (psFeed.error !== null || psFeed.data === null),
      // B1 (Фаза 4): метаданные о свежести и происхождении данных.
      // Mobile использует чтобы показывать «обновлено 30s назад» и отличать
      // permanent (имена команд, лига) от transient (live kills/networth).
      _field_meta: {
        fetchedAt: primary?.fetchedAt ?? psFeed.receivedAt,
        stale: primary?.stale ?? feedIsStale(psFeed, FEED_INTERVALS.pandascore_running),
        cacheTtlSec: liveTtlMs / 1000,
        sources: {
          opendota_live: {freshness: 'transient', maxAgeSec: LIVE_FEED_TTL_MS / 1000, fetchedAt: openDotaFetchedAt, attemptedAt: openDotaAttemptedAt, error: odResult?.error ?? null, stale: odResult?.stale ?? true, sourceTable: 'db:provider_feed_snapshots'},
          stratz_live: {freshness: 'transient', maxAgeSec: FEED_INTERVALS.stratz_live / 1000, fetchedAt: stratzFeed.receivedAt, attemptedAt: stratzFeed.attemptedAt, error: stratzFeed.error, stale: feedIsStale(stratzFeed, FEED_INTERVALS.stratz_live), sourceTable: 'db:provider_feed_snapshots'},
          pandascore_running: {freshness: 'transient', maxAgeSec: FEED_INTERVALS.pandascore_running / 1000, fetchedAt: psFeed.receivedAt, attemptedAt: psFeed.attemptedAt, error: psFeed.error, stale: feedIsStale(psFeed, FEED_INTERVALS.pandascore_running), sourceTable: 'db:provider_feed_snapshots'},
          team_names: { freshness: 'permanent', sourceTable: 'db:teams' },
          league_names: { freshness: 'permanent', sourceTable: 'db:leagues' },
        },
      },
    };
  }, (v) => !(v as { noData?: boolean }).noData);
  res.status(payload.unavailable ? 503 : 200).json(payload);
});

// upcoming тоже кэшируем — 60с (предматчевое расписание меняется медленно).
router.get('/upcoming', async (req, res) => {
  try {
    const snapshot = await readProviderFeed('pandascore_upcoming');
    if (snapshot.data === null) {
      res.status(503).json({noData: true, unavailable: true, error: snapshot.error, data: [], fetchedAt: null});
      return;
    }
    const data = await withCache('matches:upcoming:' + snapshot.receivedAt, 30_000, async () => {
      const raw = snapshot.data;
      // B4: защитный фильтр — отбрасываем матчи, где PS уже выставил winner_id
      // (status=not_started, но игра по факту сыграна/отменена). Так же дропаем
      // матчи без обеих команд (TBD vs TBD из плейофф-сетки) — не показываем
      // болванки.
      const cleaned = Array.isArray(raw)
        ? (raw as Record<string, unknown>[]).filter(m => {
            if (m['winner_id'] !== null && m['winner_id'] !== undefined) return false;
            const opps = (m['opponents'] as Array<{ opponent?: { id?: number; name?: string } }> | undefined) ?? [];
            const hasBoth = opps[0]?.opponent?.name && opps[1]?.opponent?.name;
            return Boolean(hasBoth);
          })
        : raw;
      const enriched = await enrichWithLeagueNames(cleaned).catch(() => cleaned);
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
    res.json({ noData: !Array.isArray(data) || data.length === 0, data, fetchedAt: snapshot.receivedAt, attemptedAt: snapshot.attemptedAt, error: snapshot.error, stale: feedIsStale(snapshot, FEED_INTERVALS.pandascore_upcoming) });
  } catch (err) {
    req.log.error({ err }, 'PandaScore upcoming error');
    res.status(503).json({ noData: true, unavailable: true, error: 'background_feed_unavailable', data: [], fetchedAt: null });
  }
});

// Reference endpoints also remain read-only, including first load and cache expiry.
for (const [path, key] of [['/heroes','heroes'], ['/hero-stats','hero_stats']] as const) {
  router.get(path, async (req, res) => {
    try {
      const snapshot = await readProviderFeed(key);
      res.status(snapshot.data === null ? 503 : 200).json({
        noData: snapshot.data === null || snapshot.data.length === 0,
        unavailable: snapshot.data === null, data: snapshot.data ?? [],
        fetchedAt: snapshot.receivedAt, attemptedAt: snapshot.attemptedAt,
        error: snapshot.error, stale: feedIsStale(snapshot, FEED_INTERVALS[key]),
      });
    } catch (err) {
      req.log.error({err}, 'Reference feed read failed');
      res.status(503).json({noData: true, unavailable: true, data: [], fetchedAt: null, error: 'background_feed_unavailable'});
    }
  });
}
export default router;
