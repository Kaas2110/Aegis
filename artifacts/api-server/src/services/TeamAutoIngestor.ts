/**
 * TeamAutoIngestor — фоновый сервис автодобавления незнакомых команд.
 *
 * Когда PandaScore возвращает команду, которой нет в нашей таблице `teams`,
 * этот модуль в фоне:
 *   1. Ищет команду в OpenDota /api/teams (кэшированный снимок ~3000 команд).
 *   2. Если находит — upsert в `teams`.
 *   3. Запрашивает последние матчи команды через /api/teams/{id}/matches
 *      и upsert в `pro_matches` (тот же формат что и ingest:matches).
 *
 * Всё выполняется без блокировки основного потока — Fire-and-forget через
 * Promise + set<string> уже-в-процессе (чтобы не дублировать запросы).
 *
 * Ограничения:
 *   - OpenDota /api/teams не имеет поиска по имени → грузим весь список раз
 *     в REFRESH_MS и кэшируем в памяти.
 *   - Матчи команды не ингестируются если их уже >0 в pro_matches — avoid дублирования.
 *   - Нет ingest:drafts / players-heroes для новых команд: волна 3 (player data)
 *     не требуется для базового winner-prediction, это уровень v1/v2.
 */

import { logger } from '../lib/logger';
import { db, teamsTable, proMatchesTable } from '@workspace/db';
import { or, ilike, eq, sql, count } from 'drizzle-orm';

const OPENDOTA_BASE = 'https://api.opendota.com/api';

// Кэш полного списка OpenDota-команд (обновляется раз в 6 часов)
interface OdTeam {
  team_id: number;
  name: string | null;
  tag: string | null;
  rating: number | null;
  wins: number;
  losses: number;
  last_match_time: number | null;
}

let odTeamCache: OdTeam[] | null = null;
let odTeamCacheAt = 0;
const REFRESH_MS = 6 * 3600 * 1000;

async function getOdTeams(): Promise<OdTeam[]> {
  if (odTeamCache && Date.now() - odTeamCacheAt < REFRESH_MS) return odTeamCache;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const resp = await fetch(`${OPENDOTA_BASE}/teams`, { signal: ctrl.signal });
      if (!resp.ok) return odTeamCache ?? [];
      const data = (await resp.json()) as OdTeam[];
      odTeamCache = data;
      odTeamCacheAt = Date.now();
      return data;
    } finally {
      clearTimeout(tid);
    }
  } catch {
    return odTeamCache ?? [];
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function teamScore(odName: string, odTag: string | null, query: string): number {
  const q = norm(query);
  const n = norm(odName);
  const t = norm(odTag ?? '');
  if (n === q || t === q) return 100;
  if (n.includes(q) || q.includes(n)) return 80;
  if (t.length >= 3 && (t.includes(q) || q.includes(t))) return 70;
  // Prefix match ≥4 chars
  const minLen = Math.min(n.length, q.length);
  if (minLen >= 4 && n.slice(0, minLen) === q.slice(0, minLen)) return 50;
  return 0;
}

async function findInDB(name: string) {
  const rows = await db
    .select({ teamId: teamsTable.teamId, name: teamsTable.name })
    .from(teamsTable)
    .where(or(ilike(teamsTable.name, `%${name}%`), ilike(teamsTable.tag, `%${name}%`)))
    .limit(1);
  return rows[0] ?? null;
}

// Запросы в процессе (чтобы не дублировать параллельные вызовы)
const pending = new Set<string>();

/**
 * Пытается найти команду в OpenDota и добавить её в БД вместе с несколькими
 * последними матчами. Весь запрос выполняется в фоне (не await-ится вызывающим).
 */
export function autoIngestTeamBackground(teamName: string): void {
  const key = teamName.toLowerCase().trim();
  if (!key || key.length < 2 || pending.has(key)) return;

  void (async () => {
    pending.add(key);
    try {
      const existing = await findInDB(teamName);
      if (existing) return;

      const allTeams = await getOdTeams();
      let best: OdTeam | null = null;
      let bestScore = 0;
      for (const t of allTeams) {
        const s = teamScore(t.name ?? '', t.tag, teamName);
        if (s > bestScore) { bestScore = s; best = t; }
      }
      if (!best || bestScore < 50) {
        logger.debug({ teamName, bestScore }, '[AutoIngest] team not found in OpenDota');
        return;
      }

      // Upsert команду
      await db
        .insert(teamsTable)
        .values({
          teamId: best.team_id,
          name: best.name ?? teamName,
          tag: best.tag,
          rating: best.rating,
          wins: best.wins ?? 0,
          losses: best.losses ?? 0,
          lastMatchTime: best.last_match_time,
        })
        .onConflictDoUpdate({
          target: teamsTable.teamId,
          set: {
            name: sql`excluded.name`,
            tag: sql`excluded.tag`,
            rating: sql`excluded.rating`,
            wins: sql`excluded.wins`,
            losses: sql`excluded.losses`,
            lastMatchTime: sql`excluded.last_match_time`,
            updatedAt: sql`now()`,
          },
        });

      logger.info({ teamName, teamId: best.team_id, score: bestScore }, '[AutoIngest] team added to DB');

      // Проверяем сколько матчей у нас уже есть по этой команде
      const [row] = await db
        .select({ cnt: count() })
        .from(proMatchesTable)
        .where(or(
          eq(proMatchesTable.radiantTeamId, best.team_id),
          eq(proMatchesTable.direTeamId, best.team_id),
        ));
      const existing_matches = Number(row?.cnt ?? 0);
      if (existing_matches >= 10) {
        logger.debug({ teamId: best.team_id, existing_matches }, '[AutoIngest] enough matches already, skip');
        return;
      }

      // Грузим последние 20 матчей команды
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 12_000);
      let rawMatches: unknown[] = [];
      try {
        const resp = await fetch(
          `${OPENDOTA_BASE}/teams/${best.team_id}/matches?limit=20`,
          { signal: ctrl.signal },
        );
        if (resp.ok) rawMatches = (await resp.json()) as unknown[];
      } finally {
        clearTimeout(tid);
      }

      interface OdMatch {
        match_id: number;
        radiant: boolean;
        radiant_win: boolean;
        duration: number | null;
        start_time: number | null;
        leagueid: number | null;
        radiant_team_id?: number;
        dire_team_id?: number;
        cluster?: number;
        series_id?: number;
        series_type?: number;
      }

      let ingested = 0;
      for (const raw of rawMatches as OdMatch[]) {
        if (!raw.match_id) continue;
        const radiantId = raw.radiant ? best.team_id : (raw.radiant_team_id ?? null);
        const direId = !raw.radiant ? best.team_id : (raw.dire_team_id ?? null);
        // pro_matches требует startTime и duration (notNull в схеме)
        const startTimeSec = raw.start_time ?? Math.floor(Date.now() / 1000);
        const duration = raw.duration ?? 0;
        try {
          await db
            .insert(proMatchesTable)
            .values({
              matchId: raw.match_id,
              radiantTeamId: radiantId,
              direTeamId: direId,
              radiantWin: raw.radiant_win,
              duration,
              startTime: startTimeSec,
              leagueId: raw.leagueid ?? null,
              series_id: raw.series_id ?? null,
              series_type: raw.series_type ?? null,
            })
            .onConflictDoNothing();
          ingested++;
        } catch {
          // Пропускаем если матч уже есть или schema constraint
        }
      }
      logger.info({ teamId: best.team_id, ingested }, '[AutoIngest] matches ingested');
    } catch (err) {
      logger.warn({ err, teamName }, '[AutoIngest] error');
    } finally {
      pending.delete(key);
    }
  })();
}
