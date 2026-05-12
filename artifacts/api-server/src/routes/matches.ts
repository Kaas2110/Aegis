import { Router, type IRouter } from 'express';
import { db, teamsTable, leaguesTable } from '@workspace/db';
import { inArray } from 'drizzle-orm';
import { autoIngestTeamBackground } from '../services/TeamAutoIngestor';
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

    const openDotaPromise = apiFetch(`${OPENDOTA_BASE}/live`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const raw = await r.json() as unknown;
        const enriched = await enrichLiveMatchesWithTeamNames(raw).catch(err => {
          req.log.warn({ err }, 'team-name enrichment failed, returning raw');
          return raw;
        });
        const data = await enrichWithLeagueNames(enriched).catch(err => {
          req.log.warn({ err }, 'league enrichment failed, returning raw');
          return enriched;
        });
        return { source: 'opendota', data };
      })
      .catch(err => ({ source: 'opendota', data: [], error: String(err) }));

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

    const [openDota, stratz] = await Promise.allSettled([openDotaPromise, stratzPromise]);
    if (openDota.status === 'fulfilled') results.push(openDota.value);
    if (stratz.status === 'fulfilled') results.push(stratz.value);
    const hasData = results.some(r => !r.error && Array.isArray(r.data) && (r.data as unknown[]).length > 0);
    return {
      sources: results,
      isMock: !hasData,
      mockData: hasData ? undefined : getMockLiveMatches(),
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
      url.searchParams.set('page[size]', '50');
      url.searchParams.set('sort', 'begin_at');
      url.searchParams.set('filter[status]', 'not_started');
      const resp = await apiFetch(url.toString());
      if (!resp.ok) throw new Error(`PandaScore: HTTP ${resp.status}`);
      const raw = await resp.json() as unknown;
      const enriched = await enrichWithLeagueNames(raw).catch(() => raw);
      // Фоновый авто-ингест команд которых нет в нашей БД.
      // Fire-and-forget — не блокирует ответ клиенту.
      if (Array.isArray(enriched)) {
        for (const m of enriched as Record<string, unknown>[]) {
          const opps = m['opponents'] as Array<{ opponent?: { name?: string } }> | undefined;
          const t1 = (opps?.[0]?.opponent?.name ?? '').trim();
          const t2 = (opps?.[1]?.opponent?.name ?? '').trim();
          if (t1) autoIngestTeamBackground(t1);
          if (t2) autoIngestTeamBackground(t2);
        }
      }
      return enriched;
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
