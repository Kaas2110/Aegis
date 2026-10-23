import { stratzQuery } from '@workspace/db/stratz';
import {stratzLiveListEvidence} from './stratzLiveListEvidence';

// Scalar fields verified against MatchLiveType on 2026-10-03. Detailed player
// enrichment remains disabled; this replaces the obsolete REST League/live.
const LIVE_LIST_QUERY = `query AegisLiveMatches {
  live { matches {
    matchId radiantScore direScore leagueId radiantTeamId direTeamId
    gameTime buildingState lobbyId completed
  } }
}`;
interface LiveMatch {
  matchId?: number | null;
  radiantScore?: number | null;
  direScore?: number | null;
  leagueId?: number | null;
  radiantTeamId?: number | null;
  direTeamId?: number | null;
  gameTime?: number | null;
  buildingState?: number | null;
  lobbyId?: number | string | null;
  completed?: boolean | null;
}

export function normalizeStratzLiveList(matches: Array<LiveMatch | null> | null | undefined) {
  if (!Array.isArray(matches)) return [];
  return matches.filter((match): match is LiveMatch => !!match
    && Number.isSafeInteger(match.matchId) && (match.matchId ?? 0) > 0
    && match.completed !== true
    && ((match.leagueId ?? 0) > 0 || (match.radiantTeamId ?? 0) > 0 || (match.direTeamId ?? 0) > 0))
    .map(match => ({
      ...match,
      source: 'stratz',
      // STRATZ IDs are Valve/Dota match/team/league IDs; never remap to PandaScore.
      match_id: match.matchId!,
      league_id: match.leagueId ?? null,
      team_id_radiant: match.radiantTeamId ?? null,
      team_id_dire: match.direTeamId ?? null,
      radiant_score: match.radiantScore ?? null,
      dire_score: match.direScore ?? null,
      game_time: match.gameTime ?? null,
      building_state: match.buildingState ?? null,
      lobby_id: match.lobbyId ?? null,
    }));
}

export async function fetchStratzLiveListObserved(token: string) {
  const data = await stratzQuery<{ live?: { matches?: Array<LiveMatch | null> | null } | null }>(token, LIVE_LIST_QUERY);
  if (!Array.isArray(data.live?.matches)) throw new Error('STRATZ live list unavailable');
  const receivedAt=new Date().toISOString();
  const matches=normalizeStratzLiveList(data.live.matches);
  return {matches,evidence:stratzLiveListEvidence(data.live.matches,matches.length,LIVE_LIST_QUERY,receivedAt)};
}
/** Compatible reader for callers that do not own durable collection. */
export async function fetchStratzLiveList(token: string) {
  return (await fetchStratzLiveListObserved(token)).matches;
}
