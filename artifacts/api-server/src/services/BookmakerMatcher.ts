/**
 * BookmakerMatcher — сопоставляет события букмекеров с нашими матчами.
 *
 * Алгоритм:
 *  1. Для каждого нашего матча (live + upcoming) ищем букмекерские события
 *     с fuzzy-совпадением по именам команд (с учётом org-слов типа "Gaming"/"Team").
 *  2. Если есть временные метки — дополнительно проверяем ±TIME_WINDOW_H часов.
 *  3. Возвращаем массив групп: { matchId, team1, team2, startsAt, bookmakerSources[] }.
 */

import type { UnifiedBookmakerEvent } from '../routes/bookmakers';

const TIME_WINDOW_MS = 2 * 60 * 60 * 1000;

const ORG_STOP = new Set([
  'team', 'gaming', 'esport', 'esports', 'club', 'fc', 'ex', 'former', 'the', 'gg',
]);

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`""«»]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function teamTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !ORG_STOP.has(t));
}

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

export interface OurMatch {
  matchId: string;
  psMatchId?: number;
  team1Name: string;
  team2Name: string;
  team1Id?: number;
  team2Id?: number;
  startsAt: string | null;
  isLive: boolean;
}

export interface BookmakerSource {
  source: string;
  eventId: string;
  status: UnifiedBookmakerEvent['status'];
  markets: UnifiedBookmakerEvent['markets'];
  flipped: boolean;
}

export interface MatchedBookmakerGroup {
  matchId: string;
  psMatchId?: number;
  team1: string;
  team2: string;
  team1Id?: number;
  team2Id?: number;
  startsAt: string | null;
  isLive: boolean;
  bookmakerSources: BookmakerSource[];
}

/**
 * Сопоставляет список наших матчей с массивом событий букмекеров.
 * Совпадение: fuzzy по именам команд (обе ориентации) + время ±2ч (если известно).
 */
export function matchBookmakerEvents(
  ourMatches: OurMatch[],
  bookmakerEvents: UnifiedBookmakerEvent[],
): MatchedBookmakerGroup[] {
  const results: MatchedBookmakerGroup[] = [];

  for (const m of ourMatches) {
    const matchStartMs = m.startsAt ? new Date(m.startsAt).getTime() : null;

    const sources: BookmakerSource[] = [];
    for (const ev of bookmakerEvents) {
      const sameOrder =
        fuzzyTeamMatch(ev.team1, m.team1Name) && fuzzyTeamMatch(ev.team2, m.team2Name);
      const flipped =
        !sameOrder &&
        fuzzyTeamMatch(ev.team1, m.team2Name) && fuzzyTeamMatch(ev.team2, m.team1Name);

      if (!sameOrder && !flipped) continue;

      if (matchStartMs !== null && ev.startsAt) {
        const evStartMs = new Date(ev.startsAt).getTime();
        if (Math.abs(evStartMs - matchStartMs) > TIME_WINDOW_MS) continue;
      }

      const markets: UnifiedBookmakerEvent['markets'] = flipped
        ? {
            ...(ev.markets.winner
              ? { winner: { team1: ev.markets.winner.team2, team2: ev.markets.winner.team1 } }
              : {}),
            ...(ev.markets.totalKills ? { totalKills: ev.markets.totalKills } : {}),
            ...(ev.markets.totalDuration ? { totalDuration: ev.markets.totalDuration } : {}),
            ...(ev.markets.firstBlood ? { firstBlood: ev.markets.firstBlood } : {}),
            ...(ev.markets.mapWinners
              ? {
                  mapWinners: ev.markets.mapWinners.map(mw => ({
                    ...mw,
                    team1: mw.team2,
                    team2: mw.team1,
                  })),
                }
              : {}),
            ...(ev.markets.totalMaps ? { totalMaps: ev.markets.totalMaps } : {}),
            ...(ev.markets.correctScore ? { correctScore: ev.markets.correctScore } : {}),
          }
        : ev.markets;

      sources.push({ source: ev.source, eventId: ev.eventId, status: ev.status, markets, flipped });
    }

    if (sources.length > 0) {
      results.push({
        matchId: m.matchId,
        psMatchId: m.psMatchId,
        team1: m.team1Name,
        team2: m.team2Name,
        team1Id: m.team1Id,
        team2Id: m.team2Id,
        startsAt: m.startsAt,
        isLive: m.isLive,
        bookmakerSources: sources,
      });
    }
  }

  return results;
}
