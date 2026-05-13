import { Router, type IRouter } from 'express';
import { db, teamsTable, leaguesTable } from '@workspace/db';
import { inArray } from 'drizzle-orm';
import { getRandomUserAgent } from '../lib/userAgents';
import { withCache } from '../lib/responseCache';
import { getApiKey } from '../services/ApiKeysService';

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

/** Нормализует имя команды: убирает «Team », приводит к нижнему регистру. */
function normTeamName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.toLowerCase().replace(/^team\s+/i, '').replace(/\s+/g, ' ').trim();
}

/** Достаточно ли похожи два нормализованных имени (одно содержит другое). */
function namesMatch(a: string, b: string): boolean {
  if (!a || !b || a.length < 2 || b.length < 2) return false;
  return a === b || a.includes(b) || b.includes(a);
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
  league?: { name?: string };
  begin_at?: string;
  number_of_games?: number;
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
  // Не кэшируем неудачные ответы (isMock=true): если у OpenDota транзиентный
  // 503, мы не должны 30с подряд возвращать пустоту всем клиентам.
  const payload = await withCache('matches:live', 30_000, async () => {
    const results: { source: string; data: unknown; error?: string }[] = [];

    const pandascoreKey = getApiKey('PANDASCORE_API_KEY');

    // Запрашиваем OpenDota live, PandaScore running и Stratz параллельно.
    // PandaScore /running даёт официальные имена команд, счёт серии и номер
    // текущей карты. OpenDota даёт реальный game state (kills, gold, time).
    const openDotaPromise = apiFetch(`${OPENDOTA_BASE}/live`)
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

    const stratzToken = getApiKey('STRATZ_TOKEN');
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

    if (openDota.status === 'fulfilled') {
      // Если PandaScore вернул running-матчи — обогащаем OD данные:
      // счёт серии, текущая карта, ps_match_id.
      const enrichedData = psMatches.length > 0
        ? enrichWithPandaScoreRunning(openDota.value.data, psMatches)
        : openDota.value.data;
      results.push({ ...openDota.value, data: enrichedData });
    }
    if (stratz.status === 'fulfilled') results.push(stratz.value);

    const hasData = results.some(r => !r.error && Array.isArray(r.data) && (r.data as unknown[]).length > 0);
    return {
      sources: results,
      isMock: !hasData,
      mockData: hasData ? undefined : getMockLiveMatches(),
      pandascoreRunning: psMatches.length,
    };
  }, (v) => !(v as { isMock?: boolean }).isMock);
  res.json(payload);
});

// upcoming тоже кэшируем — 60с (предматчевое расписание меняется медленно).
router.get('/upcoming', async (req, res) => {
  const pandascoreKey = getApiKey('PANDASCORE_API_KEY');
  if (!pandascoreKey) {
    res.json({
      isMock: true,
      error: 'PANDASCORE_API_KEY не настроен. Получить: https://pandascore.co',
      data: getMockUpcomingMatches(),
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
      return await enrichWithLeagueNames(raw).catch(() => raw);
    });
    res.json({ isMock: false, data });
  } catch (err) {
    req.log.error({ err }, 'PandaScore upcoming error');
    res.json({ isMock: true, error: String(err), data: getMockUpcomingMatches() });
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
    res.json({ isMock: false, data });
  } catch (err) {
    req.log.error({ err }, 'Heroes fetch error');
    res.json({ isMock: true, data: [] });
  }
});

router.get('/hero-stats', async (req, res) => {
  try {
    const resp = await apiFetch(`${OPENDOTA_BASE}/heroStats`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as unknown;
    res.json({ isMock: false, data });
  } catch (err) {
    req.log.error({ err }, 'Hero stats fetch error');
    res.json({ isMock: true, data: [] });
  }
});

function getMockLiveMatches() {
  return [
    {
      match_id: 999001,
      team_name_radiant: 'Team Liquid',
      team_name_dire: 'Team Falcons',
      radiant_lead: 8200,
      radiant_score: 14,
      dire_score: 18,
      duration: 2100,
      spectators: 12400,
      game_mode: 2,
      source: 'mock',
    },
    {
      match_id: 999002,
      team_name_radiant: 'Team Spirit',
      team_name_dire: 'BetBoom Team',
      radiant_lead: 1400,
      radiant_score: 11,
      dire_score: 9,
      duration: 1350,
      spectators: 8200,
      game_mode: 2,
      source: 'mock',
    },
  ];
}

function getMockUpcomingMatches() {
  const now = Date.now();
  return [
    {
      id: 'mock_m3',
      team1: 'Gaimin Gladiators',
      team2: 'Tundra Esports',
      tournament: 'BetBoom Dacha 2025',
      format: 'bo1',
      begin_at: new Date(now + 45 * 60 * 1000).toISOString(),
      source: 'mock',
    },
    {
      id: 'mock_m4',
      team1: 'Nigma Galaxy',
      team2: 'PSG Quest',
      tournament: 'ESL One 2025',
      format: 'bo3',
      begin_at: new Date(now + 3 * 3600 * 1000).toISOString(),
      source: 'mock',
    },
  ];
}

export default router;
