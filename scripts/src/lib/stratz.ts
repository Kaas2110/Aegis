/**
 * Stratz GraphQL client для scripts/.
 *
 * Stratz API: https://api.stratz.com/graphql
 * Auth: Bearer {STRATZ_TOKEN} в заголовке Authorization.
 * Rate-limits (Individual token, бесплатный):
 *   20 req/s · 250 req/min · 4 000 req/h · 20 000 req/day
 *
 * Скрипты читают STRATZ_TOKEN из process.env (не из ApiKeysService/DB —
 * скрипты запускаются как отдельные процессы и не имеют доступа к БД-оверрайду).
 * Добавьте токен в Replit Secrets: STRATZ_TOKEN=<ваш токен с stratz.com/api>.
 *
 * Если токен не задан — все функции бросают StratzUnavailableError, которую
 * вызывающий код должен перехватить и откатиться на OpenDota.
 */

export class StratzUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StratzUnavailableError';
  }
}

const STRATZ_GQL = 'https://api.stratz.com/graphql';
const SLEEP_MS = 260; // ~230 req/min — безопасный запас под 250/min лимит
export const stratzSleep = () => new Promise<void>(r => setTimeout(r, SLEEP_MS));

function getToken(): string {
  const t = process.env['STRATZ_TOKEN'];
  if (!t) throw new StratzUnavailableError('STRATZ_TOKEN не задан в env');
  return t;
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = getToken();
  const resp = await fetch(STRATZ_GQL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'AegisAnalytics/1.0 (pro-analytics bot)',
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new StratzUnavailableError(`Stratz HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const body = (await resp.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new StratzUnavailableError(`Stratz GQL error: ${body.errors.map(e => e.message).join('; ')}`);
  }
  if (!body.data) throw new StratzUnavailableError('Stratz returned empty data');
  return body.data;
}

// ---------------------------------------------------------------------------
// Match details (picks/bans + player steamAccountIds)
// ---------------------------------------------------------------------------

export interface StratzPickBan {
  isPick: boolean;
  heroId: number;
  isRadiant: boolean;
  order: number;
}

export interface StratzPlayerSlot {
  steamAccountId: number | null;
  isRadiant: boolean;
  hero: { id: number } | null;
}

export interface StratzMatchDetail {
  id: number;
  startDateTime: number;   // Unix seconds
  durationSeconds: number;
  radiantWin: boolean | null;
  pickBans: StratzPickBan[] | null;
  players: StratzPlayerSlot[] | null;
}

const MATCH_DETAIL_QUERY = /* graphql */ `
  query MatchDetail($matchId: Long!) {
    match(id: $matchId) {
      id
      startDateTime
      durationSeconds
      radiantWin
      pickBans {
        isPick
        heroId
        isRadiant
        order
      }
      players {
        steamAccountId
        isRadiant
        hero { id }
      }
    }
  }
`;

export async function fetchMatchDetail(matchId: number): Promise<StratzMatchDetail> {
  const data = await gql<{ match: StratzMatchDetail }>(MATCH_DETAIL_QUERY, { matchId });
  if (!data.match) throw new StratzUnavailableError(`match ${matchId} not found in Stratz`);
  return data.match;
}

// ---------------------------------------------------------------------------
// Hero stats (professional bracket)
// Stratz winDay/winWeek по bracketIds=[PROFESSIONAL] — актуальнее OpenDota
// ---------------------------------------------------------------------------

export interface StratzHeroWinRow {
  heroId: number;
  winCount: number;
  matchCount: number;
}

const HERO_STATS_QUERY = /* graphql */ `
  query HeroStatsPro {
    heroStats {
      winWeek(bracketIds: [PROFESSIONAL]) {
        heroId
        winCount
        matchCount
      }
    }
  }
`;

export async function fetchHeroStatsPro(): Promise<StratzHeroWinRow[]> {
  const data = await gql<{ heroStats: { winWeek: StratzHeroWinRow[] } }>(HERO_STATS_QUERY);
  return data.heroStats.winWeek ?? [];
}

// ---------------------------------------------------------------------------
// Player hero performance
// ---------------------------------------------------------------------------

export interface StratzPlayerHeroPerf {
  hero: { id: number } | null;
  win: number;
  matchCount: number;
  last: number | null;   // Unix seconds last played
}

const PLAYER_HEROES_QUERY = /* graphql */ `
  query PlayerHeroes($steamAccountId: Long!) {
    player(steamAccountId: $steamAccountId) {
      steamAccountId
      heroesPerformance(request: { take: 200, bracketIds: [PROFESSIONAL, DIVINE, IMMORTAL] }) {
        hero { id }
        win
        matchCount
        last
      }
    }
  }
`;

export interface StratzPlayerHeroData {
  steamAccountId: number | null;
  heroesPerformance: StratzPlayerHeroPerf[] | null;
}

export async function fetchPlayerHeroes(steamAccountId: number): Promise<StratzPlayerHeroData> {
  const data = await gql<{ player: StratzPlayerHeroData }>(PLAYER_HEROES_QUERY, { steamAccountId });
  return data.player;
}

// ---------------------------------------------------------------------------
// Connectivity check (для admin probe или pre-run валидации)
// ---------------------------------------------------------------------------

export async function checkStratzConnectivity(): Promise<{ ok: boolean; error?: string }> {
  try {
    getToken();
    const data = await gql<{ __typename: string }>('{ __typename }');
    return { ok: !!data.__typename };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
