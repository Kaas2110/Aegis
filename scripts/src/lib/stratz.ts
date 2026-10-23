/** STRATZ GraphQL client. Single primary token, shared persistent limits.
 * Actual transport and quota live in @workspace/db/stratz. No curl fallback,
 * browser impersonation or token rotation. STRATZ_API is the required API UA.
 */
import { stratzQuery, firstStratzToken, StratzUnavailableError } from '@workspace/db/stratz';
export { StratzUnavailableError } from '@workspace/db/stratz';

// Pacing is enforced inside the shared transport while holding its lock.
export const stratzSleep = async (): Promise<void> => {};

/** Compatibility for callers: one primary token is active at most. */
export function getStratzPoolSize(): number {
  return firstStratzToken(process.env.STRATZ_TOKEN) ? 1 : 0;
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  return stratzQuery<T>(process.env.STRATZ_TOKEN, query, variables);
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
  didRadiantWin: boolean | null;
  pickBans: StratzPickBan[] | null;
  players: StratzPlayerSlot[] | null;
}

const MATCH_DETAIL_QUERY = /* graphql */ `
  query MatchDetail($matchId: Long!) {
    match(id: $matchId) {
      id
      startDateTime
      durationSeconds
      didRadiantWin
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
      winWeek(gameModeIds: [CAPTAINS_MODE]) {
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
  heroId: number;
  winCount: number;
  matchCount: number;
  lastPlayedDateTime: number | null;
}

const PLAYER_HEROES_QUERY = /* graphql */ `
  query PlayerHeroes($steamAccountId: Long!) {
    player(steamAccountId: $steamAccountId) {
      steamAccountId
      heroesPerformance(request: { take: 200, isLeague: true }) {
        heroId
        winCount
        matchCount
        lastPlayedDateTime
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
// Hero matchups (top-tier ranked, batched)
// ---------------------------------------------------------------------------
//
// `heroStats.matchUp(heroIds: [...], take: 200)` отдаёт всю матрицу матчапов
// в одном запросе (~2.4s, ~830KB на 145 героев = ~16k уникальных пар).
//
// ВАЖНО ПРО ИСТОЧНИК:
//   Stratz matchUp работает только по ranked-брекетам (HERALD..DIVINE_IMMORTAL),
//   фильтра «PROFESSIONAL/CAPTAINS_MODE» нет. Используем DIVINE_IMMORTAL
//   (топ-ранкед) — наиболее близко к про-уровню.
//
// ВАЖНО ПРО `matchCount`:
//   У Stratz matchCount — это игры в Immortal ranked (тысячи), у OpenDota —
//   только pro matches (десятки/сотни). Numbers не сопоставимы напрямую.
//   Фича `matchup_advantage` использует log(games + 1), поэтому переключение
//   источника даёт distribution-shift и требует переобучения v2/v3 моделей
//   (`pnpm --filter @workspace/scripts run train:lightgbm`).

export interface StratzHeroMatchup {
  heroId2: number;
  matchCount: number;
  winsAverage: number;  // winrate of heroId vs heroId2 (already calculated)
}

export interface StratzHeroMatchupRow {
  heroId: number;
  vs: StratzHeroMatchup[] | null;
}

const HERO_MATCHUPS_QUERY = /* graphql */ `
  query HeroMatchups($heroIds: [Short!]!, $take: Int!) {
    heroStats {
      matchUp(heroIds: $heroIds, bracketBasicIds: [DIVINE_IMMORTAL], matchLimit: 1, take: $take) {
        heroId
        vs {
          heroId2
          matchCount
          winsAverage
        }
      }
    }
  }
`;

/**
 * Fetch full hero-vs-hero matchup matrix for the given hero list.
 * Single GraphQL request, top-ranked bracket (DIVINE_IMMORTAL).
 *
 * @param heroIds - все hero IDs (обычно 145+ актуальных героев)
 * @param take - сколько vs-записей на героя (200 = практический максимум)
 */
export async function fetchHeroMatchupsRanked(
  heroIds: number[],
  take = 200,
): Promise<StratzHeroMatchupRow[]> {
  if (heroIds.length === 0) return [];
  const data = await gql<{ heroStats: { matchUp: StratzHeroMatchupRow[] } }>(
    HERO_MATCHUPS_QUERY,
    { heroIds, take },
  );
  return data.heroStats.matchUp ?? [];
}

// ---------------------------------------------------------------------------
// Connectivity check (для admin probe или pre-run валидации)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hero synergy (same-team pairs, top-tier ranked)
// ---------------------------------------------------------------------------
//
// Аналог `vs`-матчапов, но `with` — две героя в ОДНОЙ команде. Stratz отдаёт
// top-N (take=200) партнёров на героя в одном запросе. Stratz возвращает
// асимметричную выборку (для героя A топ-партнёров != для героя B топ-партнёров),
// поэтому при чтении в endpoint надо пробовать обе направленности (a,b)/(b,a).

export interface StratzHeroSynergy {
  heroId2: number;
  matchCount: number;
  winsAverage: number;  // winrate когда A и B в одной команде
}

export interface StratzHeroSynergyRow {
  heroId: number;
  with: StratzHeroSynergy[] | null;
}

const HERO_SYNERGY_QUERY = /* graphql */ `
  query HeroSynergy($heroIds: [Short!]!, $take: Int!) {
    heroStats {
      matchUp(heroIds: $heroIds, bracketBasicIds: [DIVINE_IMMORTAL], matchLimit: 1, take: $take) {
        heroId
        with {
          heroId2
          matchCount
          winsAverage
        }
      }
    }
  }
`;

export async function fetchHeroSynergyRanked(
  heroIds: number[],
  take = 200,
): Promise<StratzHeroSynergyRow[]> {
  if (heroIds.length === 0) return [];
  const data = await gql<{ heroStats: { matchUp: StratzHeroSynergyRow[] } }>(
    HERO_SYNERGY_QUERY,
    { heroIds, take },
  );
  return data.heroStats.matchUp ?? [];
}

// ---------------------------------------------------------------------------
// Hero roles (constants — статичные, дёргаются раз в патч)
// ---------------------------------------------------------------------------
//
// Stratz возвращает roles[] с level 1..3 для каждой роли (CARRY, NUKER, ...).
// Используется для фазовых скорингов (early/late) в /api/analytics/draft-score.
// ОДИН запрос на ~127 героев (~21KB), бесплатно.

export type StratzRoleId =
  | 'CARRY' | 'SUPPORT' | 'NUKER' | 'DISABLER' | 'JUNGLER'
  | 'DURABLE' | 'ESCAPE' | 'PUSHER' | 'INITIATOR';

export interface StratzHeroRole {
  roleId: StratzRoleId;
  level: number;  // 1..3
}

export interface StratzHeroConst {
  id: number;
  displayName: string;
  roles: StratzHeroRole[] | null;
}

const HERO_ROLES_QUERY = /* graphql */ `
  query HeroRoles {
    constants {
      heroes {
        id
        displayName
        roles { roleId level }
      }
    }
  }
`;

export async function fetchHeroRoles(): Promise<StratzHeroConst[]> {
  const data = await gql<{ constants: { heroes: StratzHeroConst[] } }>(HERO_ROLES_QUERY);
  return data.constants.heroes ?? [];
}

export async function checkStratzConnectivity(): Promise<{ ok: boolean; error?: string; poolSize: number }> {
  const poolSize = getStratzPoolSize();
  try {
    if (poolSize === 0) throw new StratzUnavailableError('STRATZ_TOKEN не задан в env');
    const data = await gql<{ __typename: string }>('{ __typename }');
    return { ok: !!data.__typename, poolSize };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), poolSize };
  }
}
