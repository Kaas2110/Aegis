/** Exact legacy E1 public types; IO loaders remain in their original wrappers. */
export interface TeamRosterEntry { accountId: number; gamesPlayed: number; wins: number; isCurrent: boolean; }
export type TeamRostersMap = Map<number, TeamRosterEntry[]>;
export interface TeamPoolEntry { games: number; wins: number; }
export type TeamHeroPoolMap = Map<number, Map<number, TeamPoolEntry>>;
export interface HeroBenchmarkAgg { median: number; std: number; }
export type HeroBenchmarksMap = Map<number, Map<string, HeroBenchmarkAgg>>;
export interface HeroItemPopularityAgg { lateShare: number; earlyAggression: number; }
export type HeroItemPopularityMap = Map<number, HeroItemPopularityAgg>;
export interface PlayerTotalsEntry { n: number; sum: number; avg: number; }
export type PlayerTotalsMap = Map<number, Map<string, PlayerTotalsEntry>>;
export interface PlayerCountsAgg { laneRoleClarity: number; }
export type PlayerCountsMap = Map<number, PlayerCountsAgg>;
export interface PlayerWlProEntry { win: number; lose: number; winrate: number; }
export type PlayerWlProMap = Map<number, PlayerWlProEntry>;

export const E1_PREMATCH_FEATURE_NAMES: readonly [
  'roster_known_radiant', 'roster_known_dire',
  'roster_continuity_radiant', 'roster_continuity_dire',
  'team_pool_overlap_radiant', 'team_pool_overlap_dire',
  'team_pool_winrate_radiant', 'team_pool_winrate_dire',
  'roster_avg_gpm_radiant', 'roster_avg_gpm_dire',
  'roster_avg_xpm_radiant', 'roster_avg_xpm_dire',
  'roster_avg_kda_radiant', 'roster_avg_kda_dire',
  'roster_avg_wlpro180_radiant', 'roster_avg_wlpro180_dire',
  'roster_role_clarity_radiant', 'roster_role_clarity_dire',
];
export const E1_PREMATCH_FEATURE_DIM: 18;
export function buildE1PrematchFeatures(args: {
  radiantTeamId: number; direTeamId: number; radiantPicks: number[]; direPicks: number[];
  radiantAccountIds: number[] | null | undefined; direAccountIds: number[] | null | undefined;
  rosters: TeamRostersMap; pool: TeamHeroPoolMap; totals: PlayerTotalsMap;
  counts: PlayerCountsMap; wlPro: PlayerWlProMap;
}): number[];

export const E1_MARKET_KILLS_FEATURE_NAMES: readonly ['hero_benchmark_kills_pm_sum_draft', 'hero_dmg_pm_sum_draft'];
export const E1_MARKET_KILLS_FEATURE_DIM: 2;
export function buildE1KillsFeatures(args: {radiantPicks: number[]; direPicks: number[]; benchmarks: HeroBenchmarksMap}): number[];

export const E1_MARKET_DURATION_FEATURE_NAMES: readonly [
  'hero_late_item_pop_share_radiant', 'hero_late_item_pop_share_dire',
  'hero_early_item_aggression_radiant', 'hero_early_item_aggression_dire',
];
export const E1_MARKET_DURATION_FEATURE_DIM: 4;
export function buildE1DurationFeatures(args: {radiantPicks: number[]; direPicks: number[]; itemPop: HeroItemPopularityMap}): number[];

export const E1_MARKET_FB_FEATURE_NAMES: readonly ['hero_fb_proxy_radiant', 'hero_fb_proxy_dire'];
export const E1_MARKET_FB_FEATURE_DIM: 2;
export function buildE1FbFeatures(args: {radiantPicks: number[]; direPicks: number[]; benchmarks: HeroBenchmarksMap; itemPop: HeroItemPopularityMap}): number[];

export const E1_LIVE_TOTALS_FEATURE_NAMES: readonly ['hero_kills_pm_benchmark_sum', 'hero_late_item_pop_share_total'];
export const E1_LIVE_TOTALS_FEATURE_DIM: 2;
export function buildE1LiveTotalsFeatures(args: {radiantPicks: number[]; direPicks: number[]; benchmarks: HeroBenchmarksMap; itemPop: HeroItemPopularityMap}): number[];
