import type { RealBookmakerOdds } from './types';

const API_BASE = '/api/odds';

export class TheOddsApiAdapter {
  id = 'the_odds_api';
  name = 'The Odds API';

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${API_BASE}/dota2`);
      const data = (await resp.json()) as { noData?: boolean; error?: string };
      return !data.noData;
    } catch {
      return false;
    }
  }

  async fetchOdds(eventId?: string): Promise<{
    noData: boolean;
    data: RealBookmakerOdds[];
    meta?: { requestsRemaining?: string; requestsUsed?: string };
    error?: string;
  }> {
    const resp = await fetch(`${API_BASE}/dota2`);
    const result = (await resp.json()) as {
      noData: boolean;
      data: Array<{
        eventId: string;
        team1: string;
        team2: string;
        commenceTime: string;
        bookmakers: Array<{
          bookmakerId: string;
          bookmakerName: string;
          team1Odds: number;
          team2Odds: number;
          lastUpdate: string;
        }>;
      }>;
      meta?: { requestsRemaining?: string; requestsUsed?: string };
      error?: string;
    };

    let events = result.data ?? [];
    if (eventId) {
      events = events.filter(e => e.eventId === eventId);
    }

    const normalized: RealBookmakerOdds[] = events.flatMap(ev =>
      ev.bookmakers.map(bk => ({
        eventId: ev.eventId,
        team1: ev.team1,
        team2: ev.team2,
        commenceTime: ev.commenceTime,
        bookmakerId: bk.bookmakerId,
        bookmakerName: bk.bookmakerName,
        team1Odds: bk.team1Odds,
        team2Odds: bk.team2Odds,
        lastUpdate: bk.lastUpdate,
        source: this.id,
      }))
    );

    return { noData: result.noData, data: normalized, meta: result.meta, error: result.error };
  }
}
