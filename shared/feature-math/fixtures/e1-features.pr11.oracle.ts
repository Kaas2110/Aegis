export interface TeamRosterEntry {
  accountId: number;
  gamesPlayed: number;
  wins: number;
  isCurrent: boolean;
}
/** Map<teamId, RosterEntry[]>. Пустой массив для команд без данных. */
export type TeamRostersMap = Map<number, TeamRosterEntry[]>;

export interface TeamPoolEntry { games: number; wins: number; }
/** Map<teamId, Map<heroId, {games, wins}>>. */
export type TeamHeroPoolMap = Map<number, Map<number, TeamPoolEntry>>;

export interface HeroBenchmarkAgg {
  /** Медиана (percentile≈0.5) для метрики. */
  median: number;
  /** Робастный proxy std = (p75 − p25) / 1.35 (нормальное приближение). */
  std: number;
}
/** Map<heroId, Map<metricField, {median, std}>>. metric = 'kills_per_min', 'xp_per_min', etc. */
export type HeroBenchmarksMap = Map<number, Map<string, HeroBenchmarkAgg>>;

export interface HeroItemPopularityAgg {
  /** Доля late-game покупок в общей массе (0..1). Прокси «late-game scaling hero». */
  lateShare: number;
  /** Доля start+early покупок (0..1). Прокси «early-aggression hero». */
  earlyAggression: number;
}
/** Map<heroId, ItemPopularityAgg>. */
export type HeroItemPopularityMap = Map<number, HeroItemPopularityAgg>;

export interface PlayerTotalsEntry { n: number; sum: number; avg: number; }
/** Map<accountId, Map<field, {n, sum, avg}>>. field = 'kills_per_min', 'gpm', etc. */
export type PlayerTotalsMap = Map<number, Map<string, PlayerTotalsEntry>>;

export interface PlayerCountsAgg {
  /** max(games(lane_role=r)) / sum(games) по 4 ролям. 1.0 = всегда одна роль, 0.25 = равномерно. */
  laneRoleClarity: number;
}
/** Map<accountId, {laneRoleClarity}>. */
export type PlayerCountsMap = Map<number, PlayerCountsAgg>;

export interface PlayerWlProEntry { win: number; lose: number; winrate: number; }
/** Map<accountId, {win, lose, winrate}> для pro-only WL за 180д. */
export type PlayerWlProMap = Map<number, PlayerWlProEntry>;

export const E1_PREMATCH_FEATURE_NAMES = [
  'roster_known_radiant',         // 0..1 — доля игроков радианта, известных в team_rosters команды
  'roster_known_dire',
  'roster_continuity_radiant',    // 0..1 — доля is_current_team_member из 5 игроков
  'roster_continuity_dire',
  'team_pool_overlap_radiant',    // sum log(games+1) по picks из team_hero_pool радианта
  'team_pool_overlap_dire',
  'team_pool_winrate_radiant',    // weighted avg winrate на этом 5-pick'е (по games)
  'team_pool_winrate_dire',
  'roster_avg_gpm_radiant',       // avg(player_totals.gold_per_min) по 5 игрокам
  'roster_avg_gpm_dire',
  'roster_avg_xpm_radiant',       // avg(player_totals.xp_per_min)
  'roster_avg_xpm_dire',
  'roster_avg_kda_radiant',       // avg((kills+assists)/max(1,deaths))
  'roster_avg_kda_dire',
  'roster_avg_wlpro180_radiant',  // avg(player_wl_pro.winrate) за 180д
  'roster_avg_wlpro180_dire',
  'roster_role_clarity_radiant',  // avg(player_counts.laneRoleClarity)
  'roster_role_clarity_dire',
] as const;
export const E1_PREMATCH_FEATURE_DIM = E1_PREMATCH_FEATURE_NAMES.length;

function rosterKnown(accountIds: number[] | null | undefined, roster: TeamRosterEntry[] | undefined): number {
  if (!accountIds || accountIds.length === 0 || !roster) return 0;
  const set = new Set(roster.map(r => r.accountId));
  let n = 0;
  for (const a of accountIds) if (a && a > 0 && set.has(a)) n++;
  return n / Math.max(1, accountIds.length);
}

function rosterContinuity(accountIds: number[] | null | undefined, roster: TeamRosterEntry[] | undefined): number {
  if (!accountIds || accountIds.length === 0 || !roster) return 0;
  const currentSet = new Set(roster.filter(r => r.isCurrent).map(r => r.accountId));
  let n = 0;
  for (const a of accountIds) if (a && a > 0 && currentSet.has(a)) n++;
  return n / Math.max(1, accountIds.length);
}

function teamPoolStats(picks: number[], pool: Map<number, TeamPoolEntry> | undefined): { overlap: number; wr: number } {
  if (!pool || pool.size === 0) return { overlap: 0, wr: 0.5 };
  let overlap = 0;
  let weightedWinSum = 0;
  let weightSum = 0;
  for (const h of picks) {
    const e = pool.get(h);
    if (!e || e.games <= 0) continue;
    overlap += Math.log(e.games + 1);
    const w = Math.log(e.games + 1);
    weightedWinSum += (e.wins / e.games) * w;
    weightSum += w;
  }
  return { overlap, wr: weightSum > 0 ? weightedWinSum / weightSum : 0.5 };
}

function teamAvgTotal(
  accountIds: number[] | null | undefined,
  totals: PlayerTotalsMap,
  field: string,
): number {
  if (!accountIds || accountIds.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const a of accountIds) {
    if (!a || a <= 0) continue;
    const entry = totals.get(a)?.get(field);
    if (entry && entry.n > 0) { sum += entry.avg; n++; }
  }
  return n > 0 ? sum / n : 0;
}

function teamAvgKda(accountIds: number[] | null | undefined, totals: PlayerTotalsMap): number {
  if (!accountIds || accountIds.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const a of accountIds) {
    if (!a || a <= 0) continue;
    const inner = totals.get(a);
    if (!inner) continue;
    const k = inner.get('kills')?.avg ?? 0;
    const ast = inner.get('assists')?.avg ?? 0;
    const d = inner.get('deaths')?.avg ?? 0;
    const kda = (k + ast) / Math.max(1, d);
    sum += kda; n++;
  }
  return n > 0 ? sum / n : 0;
}

function teamAvgWlPro(accountIds: number[] | null | undefined, wlPro: PlayerWlProMap): number {
  if (!accountIds || accountIds.length === 0) return 0.5;
  let sum = 0;
  let n = 0;
  for (const a of accountIds) {
    if (!a || a <= 0) continue;
    const e = wlPro.get(a);
    if (e && (e.win + e.lose) >= 5) { sum += e.winrate; n++; }
  }
  return n > 0 ? sum / n : 0.5;
}

function teamAvgRoleClarity(accountIds: number[] | null | undefined, counts: PlayerCountsMap): number {
  if (!accountIds || accountIds.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const a of accountIds) {
    if (!a || a <= 0) continue;
    const e = counts.get(a);
    if (e) { sum += e.laneRoleClarity; n++; }
  }
  return n > 0 ? sum / n : 0;
}

export function buildE1PrematchFeatures(args: {
  radiantTeamId: number;
  direTeamId: number;
  radiantPicks: number[];
  direPicks: number[];
  radiantAccountIds: number[] | null | undefined;
  direAccountIds: number[] | null | undefined;
  rosters: TeamRostersMap;
  pool: TeamHeroPoolMap;
  totals: PlayerTotalsMap;
  counts: PlayerCountsMap;
  wlPro: PlayerWlProMap;
}): number[] {
  const rosterR = args.rosters.get(args.radiantTeamId);
  const rosterD = args.rosters.get(args.direTeamId);
  const poolR = teamPoolStats(args.radiantPicks, args.pool.get(args.radiantTeamId));
  const poolD = teamPoolStats(args.direPicks, args.pool.get(args.direTeamId));
  return [
    rosterKnown(args.radiantAccountIds, rosterR),
    rosterKnown(args.direAccountIds, rosterD),
    rosterContinuity(args.radiantAccountIds, rosterR),
    rosterContinuity(args.direAccountIds, rosterD),
    poolR.overlap,
    poolD.overlap,
    poolR.wr,
    poolD.wr,
    teamAvgTotal(args.radiantAccountIds, args.totals, 'gold_per_min'),
    teamAvgTotal(args.direAccountIds, args.totals, 'gold_per_min'),
    teamAvgTotal(args.radiantAccountIds, args.totals, 'xp_per_min'),
    teamAvgTotal(args.direAccountIds, args.totals, 'xp_per_min'),
    teamAvgKda(args.radiantAccountIds, args.totals),
    teamAvgKda(args.direAccountIds, args.totals),
    teamAvgWlPro(args.radiantAccountIds, args.wlPro),
    teamAvgWlPro(args.direAccountIds, args.wlPro),
    teamAvgRoleClarity(args.radiantAccountIds, args.counts),
    teamAvgRoleClarity(args.direAccountIds, args.counts),
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// LIVE WINNER: builder УДАЛЁН (2026-05-18). Требовал per-player live stats
// (gpm/xpm/killsPm), которые отдаёт только Stratz через `live_snapshots.
// stratzPlayers`. Поскольку Stratz live DORMANT с 2026-05-16 и закладываться
// на него мы больше не хотим, live_winner остаётся на текущем fv=8 (LR без E1).
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// MARKET total_kills: +2 фичи (sum benchmarks по 10 picks).
// ──────────────────────────────────────────────────────────────────────────

export const E1_MARKET_KILLS_FEATURE_NAMES = [
  'hero_benchmark_kills_pm_sum_draft', // Σ_{i=1..10} median kills_per_min героя
  'hero_dmg_pm_sum_draft',             // Σ_{i=1..10} median hero_damage_per_min героя
] as const;
export const E1_MARKET_KILLS_FEATURE_DIM = E1_MARKET_KILLS_FEATURE_NAMES.length;

function draftBenchmarkSum(
  picks: number[],
  benchmarks: HeroBenchmarksMap,
  metric: string,
): number {
  let sum = 0;
  for (const h of picks) {
    const b = benchmarks.get(h)?.get(metric);
    if (b) sum += b.median;
  }
  return sum;
}

export function buildE1KillsFeatures(args: {
  radiantPicks: number[];
  direPicks: number[];
  benchmarks: HeroBenchmarksMap;
}): number[] {
  const allPicks = [...args.radiantPicks, ...args.direPicks];
  return [
    draftBenchmarkSum(allPicks, args.benchmarks, 'kills_per_min'),
    draftBenchmarkSum(allPicks, args.benchmarks, 'hero_damage_per_min'),
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// MARKET total_duration (включая q25/q75 quantile-models): +4 фичи.
//
// heroDurationBinMean из существующей hero_durations таблицы — НЕ часть E1,
// и должен подключаться отдельно через имеющийся loader. Здесь только
// два item-popularity прокси на сторону.
// ──────────────────────────────────────────────────────────────────────────

export const E1_MARKET_DURATION_FEATURE_NAMES = [
  'hero_late_item_pop_share_radiant',  // Σ lateShare по 5 picks
  'hero_late_item_pop_share_dire',
  'hero_early_item_aggression_radiant',// Σ earlyAggression по 5 picks
  'hero_early_item_aggression_dire',
] as const;
export const E1_MARKET_DURATION_FEATURE_DIM = E1_MARKET_DURATION_FEATURE_NAMES.length;

function teamItemShare(
  picks: number[],
  itemPop: HeroItemPopularityMap,
  field: 'lateShare' | 'earlyAggression',
): number {
  let sum = 0;
  for (const h of picks) {
    const e = itemPop.get(h);
    if (e) sum += e[field];
  }
  return sum;
}

export function buildE1DurationFeatures(args: {
  radiantPicks: number[];
  direPicks: number[];
  itemPop: HeroItemPopularityMap;
}): number[] {
  return [
    teamItemShare(args.radiantPicks, args.itemPop, 'lateShare'),
    teamItemShare(args.direPicks, args.itemPop, 'lateShare'),
    teamItemShare(args.radiantPicks, args.itemPop, 'earlyAggression'),
    teamItemShare(args.direPicks, args.itemPop, 'earlyAggression'),
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// MARKET first_blood: +2 фичи (early-fight proxy на сторону).
// ──────────────────────────────────────────────────────────────────────────

export const E1_MARKET_FB_FEATURE_NAMES = [
  'hero_fb_proxy_radiant', // Σ kills_pm_median · earlyAggression по 5 picks
  'hero_fb_proxy_dire',
] as const;
export const E1_MARKET_FB_FEATURE_DIM = E1_MARKET_FB_FEATURE_NAMES.length;

function teamFbProxy(
  picks: number[],
  benchmarks: HeroBenchmarksMap,
  itemPop: HeroItemPopularityMap,
): number {
  let sum = 0;
  for (const h of picks) {
    const killsPm = benchmarks.get(h)?.get('kills_per_min')?.median ?? 0;
    const earlyAgg = itemPop.get(h)?.earlyAggression ?? 0;
    sum += killsPm * earlyAgg;
  }
  return sum;
}

export function buildE1FbFeatures(args: {
  radiantPicks: number[];
  direPicks: number[];
  benchmarks: HeroBenchmarksMap;
  itemPop: HeroItemPopularityMap;
}): number[] {
  return [
    teamFbProxy(args.radiantPicks, args.benchmarks, args.itemPop),
    teamFbProxy(args.direPicks, args.benchmarks, args.itemPop),
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// LIVE_TOTALS (T3.5): +2 фичи (агрегат по всем 10 пикам).
// rosterPaceProxy — из team_extended_features (НЕ часть E1).
// ──────────────────────────────────────────────────────────────────────────

export const E1_LIVE_TOTALS_FEATURE_NAMES = [
  'hero_kills_pm_benchmark_sum',    // Σ median kills_per_min по 10 героям
  'hero_late_item_pop_share_total', // Σ lateShare по 10 героям
] as const;
export const E1_LIVE_TOTALS_FEATURE_DIM = E1_LIVE_TOTALS_FEATURE_NAMES.length;

export function buildE1LiveTotalsFeatures(args: {
  radiantPicks: number[];
  direPicks: number[];
  benchmarks: HeroBenchmarksMap;
  itemPop: HeroItemPopularityMap;
}): number[] {
  const allPicks = [...args.radiantPicks, ...args.direPicks];
  return [
    draftBenchmarkSum(allPicks, args.benchmarks, 'kills_per_min'),
    teamItemShare(allPicks, args.itemPop, 'lateShare'),
  ];
}
