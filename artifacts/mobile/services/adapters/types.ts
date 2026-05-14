import type { Match, Hero, Player, LiveSnapshot, BookmakerOdds, MarketType } from '@/types';

export interface DataSourceAdapter {
  sourceId: string;
  sourceName: string;
  sourceType: 'match_data' | 'odds_data' | 'hero_data' | 'player_data' | 'patch_data' | 'combined';

  fetchUpcomingMatches(): Promise<Match[]>;
  fetchLiveMatches(): Promise<Match[]>;
  fetchMatchDetails(matchId: string): Promise<Match | null>;
  fetchPlayers(teamId: string): Promise<Player[]>;
  fetchHeroes(): Promise<Hero[]>;
  fetchPatchData(): Promise<PatchData>;
  fetchOdds(matchId: string): Promise<BookmakerOdds[]>;
  healthCheck(): Promise<SourceHealthResult>;
  getLastSuccessfulSync(): Promise<Date | null>;
}

export interface BookmakerAdapter {
  bookmakerId: string;
  bookmakerName: string;
  isLegal: boolean;
  hasOfficialApi: boolean;

  fetchOdds(matchId: string, marketType: MarketType): Promise<BookmakerOdds | null>;
  fetchLiveOdds(matchId: string): Promise<BookmakerOdds[]>;
  healthCheck(): Promise<SourceHealthResult>;
}

export interface PatchData {
  patchId: string;
  patchVersion: string;
  releaseDate: Date;
  heroStats: {
    heroId: string;
    heroName: string;
    winrate: number;
    pickrate: number;
    banrate: number;
    tier: 'S' | 'A' | 'B' | 'C' | 'D';
  }[];
  metaSummary: string;
}

export interface SourceHealthResult {
  isHealthy: boolean;
  latencyMs: number;
  errorMessage?: string;
  lastChecked: Date;
}

// Slim types for real API adapters (MVP 2-4)
export interface RealBookmakerOdds {
  eventId: string;
  team1: string;
  team2: string;
  commenceTime: string;
  bookmakerId: string;
  bookmakerName: string;
  team1Odds: number;
  team2Odds: number;
  lastUpdate: string;
  source: string;
}

export interface RealLiveMatchData {
  matchId: string;
  team1: string;
  team2: string;
  radiantLead: number;
  team1Score: number;
  team2Score: number;
  durationSeconds: number;
  spectators: number;
  source: string;
}

export interface RealUpcomingMatchData {
  id: string;
  team1: string;
  team2: string;
  tournament?: string;
  format?: string;
  begin_at?: string;
  source: string;
}

export interface AdapterStatus {
  id: string;
  name: string;
  available: boolean;
  checkedAt: number;
  error?: string;
}
