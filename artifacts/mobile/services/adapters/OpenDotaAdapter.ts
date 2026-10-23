import { apiFetch } from '../../lib/api';
import { readLiveDataQuality, observedLiveStateEligible } from '../../lib/liveFreshness';
import type { RealLiveMatchData, RealUpcomingMatchData } from './types';



export class OpenDotaAdapter {
  id = 'opendota';
  name = 'OpenDota';

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await apiFetch(`/api/matches/live`);
      if (!resp.ok) return false;
      const data = (await resp.json()) as { sources?: Array<{ source?: string; error?: string }> };
      const src = data.sources?.find(s => s.source === 'opendota');
      return !!src && !src.error;
    } catch {
      return false;
    }
  }

  async fetchLiveMatches(): Promise<{ noData: boolean; data: RealLiveMatchData[] }> {
    const resp = await apiFetch(`/api/matches/live`);
    const result = (await resp.json()) as {
      noData: boolean;
      sources: Array<{ source: string; data: unknown; error?: string }>;
    };

    if (result.noData) {
      return { noData: true, data: [] };
    }

    const src = result.sources?.find(s => s.source === 'opendota');
    const rawData = src?.data;

    if (!Array.isArray(rawData) || rawData.length === 0) {
      return { noData: true, data: [] };
    }

    // Real OpenDota /api/live fields (no scoreboard — flat structure)
    const normalized: RealLiveMatchData[] = (rawData as Array<{
      live_freshness?: unknown;
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
    }>).filter(m => observedLiveStateEligible(readLiveDataQuality(m.live_freshness))).map(m => ({
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

    return { noData: normalized.length === 0, data: normalized };
  }

  async fetchUpcomingMatches(): Promise<{ noData: boolean; data: RealUpcomingMatchData[] }> {
    const resp = await apiFetch(`/api/matches/upcoming`);
    const result = (await resp.json()) as {
      noData: boolean;
      data: RealUpcomingMatchData[];
    };
    return { noData: result.noData, data: result.data ?? [] };
  }
}
