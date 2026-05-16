/**
 * Stratz GraphQL client для scripts/.
 *
 * Stratz API: https://api.stratz.com/graphql
 * Auth: Bearer {token} в заголовке Authorization.
 * Rate-limits (Individual token, бесплатный):
 *   20 req/s · 250 req/min · 4 000 req/h · 20 000 req/day
 *
 * MULTI-TOKEN POOL (2026-05-14)
 * ─────────────────────────────
 * `STRATZ_TOKEN` поддерживает comma-separated пул:
 *   STRATZ_TOKEN=tok1,tok2,tok3
 * Лимиты Stratz применяются на токен (через JWT), не на IP — поэтому пул
 * из N токенов даёт ×N throughput. Это полу-серая зона ToS Stratz: каждый
 * токен привязан к реальному Steam-аккаунту, и на множественные аккаунты
 * у одного пользователя они не привязывают сущность, но формально это
 * обход single-user лимита. Пользователь предупреждён.
 *
 * Стратегия выбора:
 *   - LRU среди доступных (cooldownUntil <= now): берём токен, который
 *     дольше всех не использовался → равномерная нагрузка на токены.
 *   - При 429 от любого токена → cooldown 65s (запас над window 60s).
 *   - Если все токены в cooldown → ждём ближайшего, либо бросаем
 *     StratzUnavailableError если ждать > 30s.
 *   - Каждый токен соблюдает PER_TOKEN_GAP_MS (260ms) между запросами,
 *     чтобы никогда не пробить 250/min.
 *
 * TRANSPORT NOTE: Stratz's Cloudflare CDN blocks Node.js fetch (TLS JA3
 * fingerprint differs from browser). curl passes because libcurl has a
 * different TLS fingerprint. We therefore route all GraphQL calls through
 * fetch first (быстрее, ~0ms overhead) и фолбэчим на curl при CF challenge.
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
const PER_TOKEN_GAP_MS = 260;        // ~230 req/min на токен — запас под 250/min
const COOLDOWN_429_MS = 65_000;      // 65s > 60s rate-window
const MAX_WAIT_FOR_TOKEN_MS = 30_000;

/**
 * stratzSleep раньше делал глобальную паузу 260ms между запросами.
 * С пулом токенов пейсинг встроен внутрь acquireToken() (per-token), поэтому
 * внешний sleep больше не нужен. Оставляем no-op для обратной совместимости
 * с уже существующими ingest-скриптами — удалять `await stratzSleep()`
 * вызовы не обязательно, они просто ничего не делают.
 */
export const stratzSleep = async (): Promise<void> => {};

interface TokenState {
  token: string;
  /** Маскированный «хвост» для логов (последние 4 символа). */
  tail: string;
  lastUsedAt: number;
  cooldownUntil: number;
}

let pool: TokenState[] | null = null;

function loadPool(): TokenState[] {
  // Собираем токены из двух форматов (оба поддерживаются одновременно):
  //  1. STRATZ_TOKEN=tok1,tok2,tok3   — comma-separated пул в одном секрете
  //  2. STRATZ_TOKEN + STRATZ_TOKEN_2 + STRATZ_TOKEN_3 … — по одному секрету на токен
  // Дедупликация: одинаковый JWT → одни лимиты, не нужно два слота.
  const seen = new Set<string>();
  const unique: string[] = [];

  const envNames = ['STRATZ_TOKEN', ...Array.from({ length: 9 }, (_, i) => `STRATZ_TOKEN_${i + 2}`)];
  for (const envName of envNames) {
    const raw = process.env[envName] ?? '';
    for (const tok of raw.split(',').map((s) => s.trim())) {
      if (tok.length === 0 || seen.has(tok)) continue;
      seen.add(tok);
      unique.push(tok);
    }
  }

  return unique.map((token) => ({
    token,
    tail: token.length >= 4 ? token.slice(-4) : '????',
    lastUsedAt: 0,
    cooldownUntil: 0,
  }));
}

function getPool(): TokenState[] {
  if (!pool) pool = loadPool();
  return pool;
}

/** Сколько уникальных токенов в пуле. Полезно для логов в ingest-скриптах. */
export function getStratzPoolSize(): number {
  return getPool().length;
}

/**
 * Промис-цепочка для сериализации критической секции выбора+резервирования
 * токена. Без неё две параллельные `gql()` вызова могут прочитать один и тот
 * же `lastUsedAt`, выбрать один и тот же токен и обе сразу его дёрнуть —
 * нарушая PER_TOKEN_GAP_MS и провоцируя 429.
 *
 * Внутри критической секции мы сразу «бронируем» токен: двигаем его
 * `lastUsedAt` вперёд (до now + per-token-gap), чтобы следующий ждущий
 * увидел его как «уже занят» и взял другой / запланировал на позже.
 * Само ожидание (sleep до waitUntil) происходит ВНЕ мьютекса — иначе
 * одна медленная заявка тормозила бы всех.
 */
let acquireMutex: Promise<unknown> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = acquireMutex.then(fn, fn);
  acquireMutex = next.catch(() => {}); // не ломаем цепочку при ошибке
  return next;
}

interface Reservation {
  state: TokenState;
  /** Абсолютное время, до которого вызывающему нужно поспать перед запросом. */
  waitUntil: number;
}

async function acquireToken(): Promise<TokenState> {
  const reservation = await runExclusive(async (): Promise<Reservation> => {
    const p = getPool();
    if (p.length === 0) {
      throw new StratzUnavailableError('STRATZ_TOKEN не задан в env');
    }
    while (true) {
      const now = Date.now();
      const available = p.filter((t) => t.cooldownUntil <= now);
      if (available.length > 0) {
        // LRU: берём токен с наименьшим lastUsedAt
        available.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        const chosen = available[0]!;
        // Бронирование: двигаем lastUsedAt в будущее, чтобы конкурентные
        // запросы увидели токен как «свежо использованный» и не выбрали его.
        const waitUntil = Math.max(now, chosen.lastUsedAt + PER_TOKEN_GAP_MS);
        chosen.lastUsedAt = waitUntil;
        return { state: chosen, waitUntil };
      }
      // Все токены в cooldown — ждём ближайшего, но не дольше MAX_WAIT.
      // Спим ВНУТРИ мьютекса намеренно: пока ни один токен недоступен,
      // нет смысла пускать вторую заявку — она всё равно встанет в очередь.
      const soonest = Math.min(...p.map((t) => t.cooldownUntil));
      const wait = soonest - now;
      if (wait > MAX_WAIT_FOR_TOKEN_MS) {
        throw new StratzUnavailableError(
          `все ${p.length} Stratz-токен(ов) в cooldown; следующий доступен через ${Math.round(wait / 1000)}s`,
        );
      }
      await sleep(Math.max(wait, 100));
    }
  });
  // Спим до зарезервированного времени ВНЕ мьютекса — другие заявки уже
  // могут взять другие токены (или встать в очередь к этому же на более
  // позднее время).
  const wait = reservation.waitUntil - Date.now();
  if (wait > 0) await sleep(wait);
  return reservation.state;
}

function markCooldown(tokenState: TokenState, ms = COOLDOWN_429_MS): void {
  tokenState.cooldownUntil = Date.now() + ms;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
    throw new StratzUnavailableError(`Stratz GQL error: ${parsed.errors.map((e) => e.message).join('; ')}`);
  }
  if (!parsed.data) throw new StratzUnavailableError('Stratz returned empty data');
  return parsed.data;
}

/**
 * Execute a GraphQL request against Stratz.
 *
 * Стратегия:
 *   1. acquireToken() — выбираем LRU доступный токен из пула.
 *   2. fetch — быстрый путь. Если 429 → cooldown токену, повторяем с другим.
 *   3. CF challenge (HTML вместо JSON) → curl-fallback с тем же токеном.
 *   4. curl выводит HTTP_STATUS в трейлере; на 429 → cooldown, retry.
 *   5. Максимум попыток = размер пула + 1 (запас на CF retry).
 */
async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const body = JSON.stringify({ query, variables });
  const poolSize = getStratzPoolSize();
  if (poolSize === 0) throw new StratzUnavailableError('STRATZ_TOKEN не задан в env');
  const maxAttempts = poolSize + 1;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tokenState = await acquireToken();
    const token = tokenState.token;
    const headers = GQL_HEADERS(token);

    // --- Attempt: Node fetch ---
    let triedCurl = false;
    try {
      const resp = await fetch(STRATZ_GQL, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await resp.text();
      if (resp.status === 429) {
        markCooldown(tokenState);
        lastErr = new StratzUnavailableError(`429 rate-limit (token …${tokenState.tail})`);
        continue;
      }
      if (resp.ok && isJsonResponse(text)) {
        return parseGqlResponse<T>(text);
      }
      // CF challenge или non-JSON 200 → fall-through к curl
    } catch {
      // Network error → fall-through к curl
    }

    // --- Fallback: curl (TLS-fingerprint bypass) ---
    triedCurl = true;
    const args = [
      '--silent', '--max-time', '15',
      '-w', '\nHTTP_STATUS:%{http_code}',
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
      lastErr = new StratzUnavailableError(`curl exec failed: ${(e as Error).message}`);
      continue;
    }
    // Парсим статус из трейлера `\nHTTP_STATUS:NNN`
    const statusMatch = /\nHTTP_STATUS:(\d+)\s*$/.exec(stdout);
    const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 200;
    const cleanText = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
    if (status === 429) {
      markCooldown(tokenState);
      lastErr = new StratzUnavailableError(`429 rate-limit via curl (token …${tokenState.tail})`);
      continue;
    }
    try {
      return parseGqlResponse<T>(cleanText);
    } catch (e) {
      // Не 429, но parse-ошибка (CF challenge даже через curl, или GQL error).
      // Не баним токен — пробуем повторить со следующим, чтобы исключить
      // «токен умер» сценарий. Но если retry даст ту же ошибку — выйдем по maxAttempts.
      lastErr = e;
      // Защита от бесконечного цикла когда poolSize=1 и проблема не транзитная:
      if (poolSize === 1 && triedCurl) throw e;
      continue;
    }
  }
  throw lastErr ?? new StratzUnavailableError('Stratz: все попытки исчерпаны');
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
