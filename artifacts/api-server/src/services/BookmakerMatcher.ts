/**
 * BookmakerMatcher — сопоставляет события букмекеров с нашими матчами.
 *
 * Serving requires both team identities, valid series start times and an
 * unambiguous source event. Fuzzy helpers remain available for diagnostics.
 */

import type { UnifiedBookmakerEvent } from '../routes/bookmakers';

const TIME_WINDOW_MS = 2 * 60 * 60 * 1000;

const ORG_STOP = new Set([
  'team', 'gaming', 'esport', 'esports', 'club', 'fc', 'the', 'gg',
]);

// F7 (Phase 9): у букмекеров и PandaScore разные написания одних и тех же
// организаций («BB Team» ↔ «BetBoom Team», «VP» ↔ «Virtus.pro»). Токены
// нормализуем через словарь известных алиасов ПЕРЕД сравнением.
const TOKEN_ALIAS: Record<string, string> = {
  bb: 'betboom',
  vp: 'virtuspro',
  virtus: 'virtuspro',
  navi: 'natusvincere',
  natus: 'natusvincere',
  vincere: 'natusvincere',
};

// Токены, различающие молодёжные/академические составы от основы.
// Если один из сравниваемых нейм-сетов содержит такой токен, а другой нет —
// это разные команды (даже если остальные токены совпали через alias).
const DISCRIMINATOR_TOKENS = ['junior', 'jr', 'academy', 'youth', 'young'];

export function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`""«»]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function teamTokens(name: string): string[] {
  const tokens = name
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !ORG_STOP.has(t))
    .map(t => TOKEN_ALIAS[t] ?? t);
  return [...new Set(tokens)];
}

export function fuzzyTeamMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (normalizeTeamName(a) === normalizeTeamName(b)) return true;
  const tokA = teamTokens(a);
  const tokB = teamTokens(b);
  if (!tokA.length || !tokB.length) return false;
  // Дискриминаторы: «NAVI Junior» ≠ «Natus Vincere» — молодёжные/академ.
  // составы не должны схлопываться с основой по subset-правилу.
  for (const d of DISCRIMINATOR_TOKENS) {
    if (tokA.includes(d) !== tokB.includes(d)) return false;
  }
  const shorter = tokA.length <= tokB.length ? tokA : tokB;
  const longer  = tokA.length <= tokB.length ? tokB : tokA;
  return shorter.every(t => longer.includes(t));
}

/** Identity comparison for serving: aliases/organization words are allowed,
 * but subset token matches must never attach another team's quote. */
export function sameTeamIdentity(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (normalizeTeamName(a) === normalizeTeamName(b)) return true;
  const aliases: Record<string,string> = {vp:'virtuspro',bbteam:'betboomteam',navi:'natusvincere'};
  const an=normalizeTeamName(a),bn=normalizeTeamName(b);
  if ((aliases[an]??an)===(aliases[bn]??bn)) return true;
  const at=teamTokens(a).sort(),bt=teamTokens(b).sort();
  return at.length>0 && at.length===bt.length && at.every((t,i)=>t===bt[i]);
}

/** Series time must come from a unique running PandaScore series, not a map's
 * activate_time or an approximate substring match from a different roster. */
export function verifiedRunningSeriesIdentity(
  team1: string, team2: string,
  candidates: Array<{id:number;begin_at?:string;opponents?:Array<{opponent?:{name?:string}}> }>,
  now=Date.now(),
): {id:number;startsAt:string} | null {
  const matches=candidates.filter(candidate=>{
    const a=candidate.opponents?.[0]?.opponent?.name??'',b=candidate.opponents?.[1]?.opponent?.name??'';
    const direct=sameTeamIdentity(team1,a)&&sameTeamIdentity(team2,b);
    const reverse=sameTeamIdentity(team1,b)&&sameTeamIdentity(team2,a);
    return direct!==reverse;
  });
  if(matches.length!==1)return null;
  const match=matches[0]!,started=Date.parse(match.begin_at??'');
  if(!Number.isFinite(started) || started>now+5*60_000 || started<now-12*3_600_000)return null;
  return {id:match.id,startsAt:new Date(started).toISOString()};
}

export function orientWinnerOutcomes(
  outcomes: Array<{description?: string; price?: {decimal?: string | number}}>,
  team1: string, team2: string,
): {team1: number; team2: number} | undefined {
  const first = outcomes.filter(o => sameTeamIdentity(o.description ?? '', team1));
  const second = outcomes.filter(o => sameTeamIdentity(o.description ?? '', team2));
  if (first.length !== 1 || second.length !== 1 || first[0] === second[0]) return undefined;
  const a=Number(first[0].price?.decimal), b=Number(second[0].price?.decimal);
  return Number.isFinite(a) && Number.isFinite(b) && a>1 && b>1 ? {team1:a,team2:b} : undefined;
}

/** More than one plausible event at a source is not a verified event identity. */
export function unambiguousSourceEvents<T extends {source: string}>(events: T[]): T[] {
  const counts=new Map<string,number>();
  for(const event of events) counts.set(event.source,(counts.get(event.source)??0)+1);
  return events.filter(event=>counts.get(event.source)===1);
}

/** Fuzzy-матч двух пар команд (с учётом возможной смены ориентации). */
export function fuzzyPairMatch(a1: string, a2: string, b1: string, b2: string): boolean {
  return (fuzzyTeamMatch(a1, b1) && fuzzyTeamMatch(a2, b2))
      || (fuzzyTeamMatch(a1, b2) && fuzzyTeamMatch(a2, b1));
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
  scope?: 'series' | 'map';
}

export interface BookmakerSource {
  source: string;
  eventId: string;
  status: UnifiedBookmakerEvent['status'];
  markets: UnifiedBookmakerEvent['markets'];
  flipped: boolean;
  receivedAt?: string;
  scope?: 'series' | 'map';
}

export function orientBookmakerMarkets(markets: UnifiedBookmakerEvent['markets'], flipped: boolean): UnifiedBookmakerEvent['markets'] {
  if (!flipped) return markets;
  return {...markets,
    ...(markets.winner ? {winner:{team1:markets.winner.team2,team2:markets.winner.team1}} : {}),
    ...(markets.mapWinners ? {mapWinners:markets.mapWinners.map(m => ({...m,team1:m.team2,team2:m.team1}))} : {}),
    ...(markets.correctScore ? {correctScore:markets.correctScore.map(m => ({...m,score:m.score.split(/[:-]/).reverse().join('-')}))} : {}),
  };
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
 * Совпадение: обе команды, обязательное время ±2ч, однозначная серия.
 */
export function matchBookmakerEvents(
  ourMatches: OurMatch[],
  bookmakerEvents: UnifiedBookmakerEvent[],
): MatchedBookmakerGroup[] {
  const results: MatchedBookmakerGroup[] = [];

  for (const m of ourMatches) {
    const matchStartMs = m.startsAt ? Date.parse(m.startsAt) : NaN;
    // A single OpenDota map cannot establish the identity or start of a series.
    if (!Number.isFinite(matchStartMs) || m.scope === 'map') continue;

    const sources: BookmakerSource[] = [];
    for (const ev of bookmakerEvents) {
      const sameOrder =
        sameTeamIdentity(ev.team1, m.team1Name) && sameTeamIdentity(ev.team2, m.team2Name);
      const flipped =
        sameTeamIdentity(ev.team1, m.team2Name) && sameTeamIdentity(ev.team2, m.team1Name);

      if (sameOrder === flipped || ev.scope === 'map') continue;

      const evStartMs = ev.startsAt ? Date.parse(ev.startsAt) : NaN;
      if (!Number.isFinite(evStartMs) || Math.abs(evStartMs - matchStartMs) > TIME_WINDOW_MS) continue;
      const candidateMatches=ourMatches.filter(other => {
        if(other.scope==='map' || !other.startsAt) return false;
        const time=Date.parse(other.startsAt);
        const direct=sameTeamIdentity(ev.team1,other.team1Name)&&sameTeamIdentity(ev.team2,other.team2Name);
        const reverse=sameTeamIdentity(ev.team1,other.team2Name)&&sameTeamIdentity(ev.team2,other.team1Name);
        return direct!==reverse && Number.isFinite(time) && Math.abs(evStartMs-time)<=TIME_WINDOW_MS;
      });
      if(new Set(candidateMatches.map(other=>other.matchId)).size!==1) continue;

      const markets=orientBookmakerMarkets(ev.markets,flipped);
      sources.push({source:ev.source,eventId:ev.eventId,status:ev.status,markets,flipped,
        receivedAt:ev.receivedAt ?? ev.updatedAt,scope:ev.scope});
    }

    const verified=unambiguousSourceEvents(sources);
    if (verified.length > 0) {
      results.push({
        matchId: m.matchId,
        psMatchId: m.psMatchId,
        team1: m.team1Name,
        team2: m.team2Name,
        team1Id: m.team1Id,
        team2Id: m.team2Id,
        startsAt: m.startsAt,
        isLive: m.isLive,
        bookmakerSources: verified,
      });
    }
  }

  return results;
}
