import type { RealLiveMatchData, RealUpcomingMatchData } from './types';

const API_BASE = '/api/matches';

export class OpenDotaAdapter {
  id = 'opendota';
  name = 'OpenDota';

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${API_BASE}/live`);
      if (!resp.ok) return false;
      const data = (await resp.json()) as { sources?: Array<{ source?: string; error?: string }> };
      const src = data.sources?.find(s => s.source === 'opendota');
      return !!src && !src.error;
    } catch {
      return false;
    }
  }

  async fetchLiveMatches(): Promise<{ isMock: boolean; data: RealLiveMatchData[] }> {
    const resp = await fetch(`${API_BASE}/live`);
    const result = (await resp.json()) as {
      isMock: boolean;
      mockData?: RealLiveMatchData[];
      sources: Array<{ source: string; data: unknown; error?: string }>;
    };

    if (result.isMock) {
      return { isMock: true, data: result.mockData ?? [] };
    }

    const src = result.sources?.find(s => s.source === 'opendota');
    const rawData = src?.data;

    if (!Array.isArray(rawData) || rawData.length === 0) {
      return { isMock: true, data: result.mockData ?? [] };
    }

    // Real OpenDota /api/live fields (no scoreboard — flat structure)
    const normalized: RealLiveMatchData[] = (rawData as Array<{
      match_id?: number;
      team_name_radiant?: string;
      team_name_dire?: string;
      team_id_radiant?: number;
      team_id_dire?: number;
      radiant_lead?: number;
      radiant_score?: number;
      dire_score?: number;
      game_time?: number;
      spectators?: number;
    }>).map(m => ({
      matchId: String(m.match_id ?? 'unknown'),
      team1: m.team_name_radiant ?? 'Без названия',
      team2: m.team_name_dire ?? 'Без названия',
      radiantLead: m.radiant_lead ?? 0,
      team1Score: m.radiant_score ?? 0,
      team2Score: m.dire_score ?? 0,
      durationSeconds: m.game_time ?? 0,
      spectators: m.spectators ?? 0,
      source: this.id,
    }));

    return { isMock: false, data: normalized };
  }

  async fetchUpcomingMatches(): Promise<{ isMock: boolean; data: RealUpcomingMatchData[] }> {
    const resp = await fetch(`${API_BASE}/upcoming`);
    const result = (await resp.json()) as {
      isMock: boolean;
      data: RealUpcomingMatchData[];
    };
    return { isMock: result.isMock, data: result.data ?? [] };
  }
}
