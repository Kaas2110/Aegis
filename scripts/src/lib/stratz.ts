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
 *
 * TRANSPORT NOTE: Stratz's Cloudflare CDN blocks Node.js fetch (TLS JA3 fingerprint
 * differs from browser). curl passes because libcurl has a different TLS fingerprint
 * that Cloudflare doesn't flag. We therefore route all GraphQL calls through curl
 * via child_process.execFile. Overhead ~30ms/spawn, well within the 260ms rate-limit
 * sleep we already enforce.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

const GQL_HEADERS = (token: string) => ({
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  // Browser UA + Origin/Referer bypass Cloudflare's TLS/bot check when running
  // from non-Russian IPs (e.g. Replit). On production Russian servers, Node fetch
  // works fine without these — Cloudflare doesn't flag Russian datacenter IPs.
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Origin': 'https://stratz.com',
  'Referer': 'https://stratz.com/',
});

function isJsonResponse(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

/** Parse and validate a Stratz GraphQL JSON response string. */
function parseGqlResponse<T>(text: string): T {
  if (!text.trim()) throw new StratzUnavailableError('Stratz returned empty body');
  if (!isJsonResponse(text)) {
    throw new StratzUnavailableError(`Stratz CF challenge (not JSON): ${text.slice(0, 120)}`);
  }
  const parsed = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> };
  if (parsed.errors?.length) {
    throw new StratzUnavailableError(`Stratz GQL error: ${parsed.errors.map(e => e.message).join('; ')}`);
  }
  if (!parsed.data) throw new StratzUnavailableError('Stratz returned empty data');
  return parsed.data;
}

/**
 * Execute a GraphQL request against Stratz.
 *
 * Transport strategy:
 *   1. Try Node.js fetch — fast, works on Russian production servers where
 *      Cloudflare does not apply TLS/IP-reputation filtering.
 *   2. If CF blocks (HTML response or fetch error) → fall back to curl.
 *      curl uses libcurl's TLS fingerprint which Cloudflare doesn't flag,
 *      making it the reliable path from Replit/non-RU IPs.
 */
async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = getToken();
  const body = JSON.stringify({ query, variables });
  const headers = GQL_HEADERS(token);

  // --- Attempt 1: Node fetch ---
  try {
    const resp = await fetch(STRATZ_GQL, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    if (resp.ok && isJsonResponse(text)) {
      return parseGqlResponse<T>(text);
    }
    // CF challenge page or non-JSON 200 — fall through to curl
  } catch {
    // Network error — fall through to curl
  }

  // --- Attempt 2: curl (TLS fingerprint bypass) ---
  const args = [
    '--silent', '--max-time', '15',
    '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/json',
    '-H', 'Accept: application/json',
    '-H', `User-Agent: ${headers['User-Agent']}`,
    '-H', 'Origin: https://stratz.com',
    '-H', 'Referer: https://stratz.com/',
    '--data-raw', body,
    STRATZ_GQL,
  ];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('curl', args, { maxBuffer: 8 * 1024 * 1024 }));
  } catch (e) {
    throw new StratzUnavailableError(`curl exec failed: ${(e as Error).message}`);
  }
  return parseGqlResponse<T>(stdout);
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
