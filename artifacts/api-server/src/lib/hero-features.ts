/**
 * Inference-side зеркало scripts/src/lib/hero-features.ts.
 * Идентичная реализация — иначе train ↔ predict разойдутся.
 */

export interface HeroStat {
  proWinRate: number;
  proPickRate: number;
}

export interface HeroMatchup {
  games: number;
  winRate: number;
}

export type HeroStatsMap = Map<number, HeroStat>;
export type HeroMatchupsMap = Map<number, Map<number, HeroMatchup>>;

export const HERO_FEATURE_NAMES = [
  'radiant_pick_strength',
  'dire_pick_strength',
  'pick_strength_diff',
  'matchup_advantage',
  'radiant_meta_score',
  'dire_meta_score',
  'ban_priority_diff',
] as const;

export const HERO_FEATURE_DIM = HERO_FEATURE_NAMES.length;

export function buildHeroFeatures(
  radiantPicks: number[],
  direPicks: number[],
  radiantBans: number[],
  direBans: number[],
  heroStats: HeroStatsMap,
  matchups: HeroMatchupsMap,
): number[] | null {
  if (radiantPicks.length !== 5 || direPicks.length !== 5) return null;

  let radPickStr = 0;
  let dirPickStr = 0;
  let radMeta = 0;
  let dirMeta = 0;

  for (const h of radiantPicks) {
    const s = heroStats.get(h);
    if (!s) return null;
    radPickStr += s.proWinRate;
    radMeta += s.proPickRate;
  }
  for (const h of direPicks) {
    const s = heroStats.get(h);
    if (!s) return null;
    dirPickStr += s.proWinRate;
    dirMeta += s.proPickRate;
  }

  // Симметричный fallback на обратную пару — см. scripts/src/lib/hero-features.ts.
  let matchupAdv = 0;
  for (const r of radiantPicks) {
    const directOuter = matchups.get(r);
    for (const d of direPicks) {
      const direct = directOuter?.get(d);
      if (direct && direct.games > 0) {
        matchupAdv += (direct.winRate - 0.5) * Math.log(direct.games + 1);
        continue;
      }
      const inverse = matchups.get(d)?.get(r);
      if (inverse && inverse.games > 0) {
        matchupAdv += (0.5 - inverse.winRate) * Math.log(inverse.games + 1);
      }
    }
  }

  let radBanPrio = 0;
  let dirBanPrio = 0;
  for (const h of radiantBans) {
    const s = heroStats.get(h);
    if (s) radBanPrio += s.proPickRate;
  }
  for (const h of direBans) {
    const s = heroStats.get(h);
    if (s) dirBanPrio += s.proPickRate;
  }

  return [
    radPickStr,
    dirPickStr,
    radPickStr - dirPickStr,
    matchupAdv,
    radMeta,
    dirMeta,
    radBanPrio - dirBanPrio,
  ];
}

// ── Wave 3: extras (player-skill, recent form, h2h, side, glicko, +4 new) ──

export interface PlayerHeroStat { games: number; wins: number; }
export type PlayerHeroStatsMap = Map<number, Map<number, PlayerHeroStat>>;

export interface RecentForm {
  winRate: number;
  games: number;
  avgKillsFor?: number;
  avgDurationSec?: number;
}
export type RecentFormMap = Map<number, RecentForm>;

export interface H2HEntry { games: number; winsLow: number; }
export type H2HMap = Map<string, H2HEntry>;

export interface PlayerGlicko { rating: number; rd: number; }
export type PlayerGlickoMap = Map<number, PlayerGlicko>;

export type SoSMap = Map<number, number>;
export type RosterStabilityMap = Map<number, number>;

export const EXTRA_FEATURE_NAMES = [
  'player_skill_diff',
  'recent_form_diff',
  'h2h_advantage_radiant',
  'side_advantage',
  'player_glicko_diff',
  'avg_kills_diff',
  'avg_duration_diff',
  'sos_diff',
  'roster_stability_diff',
] as const;

export const EXTRA_FEATURE_DIM = EXTRA_FEATURE_NAMES.length;

const GLOBAL_AVG_KILLS_PER_TEAM = 22;
const GLOBAL_AVG_DURATION_SEC = 2340;

function globalHeroWR(heroId: number, heroStats: HeroStatsMap): number {
  return heroStats.get(heroId)?.proWinRate ?? 0.5;
}

function teamPlayerSkill(
  picks: number[],
  accountIds: number[] | null | undefined,
  playerHeroStats: PlayerHeroStatsMap,
  heroStats: HeroStatsMap,
): number {
  if (!accountIds || accountIds.length !== picks.length) return 0;
  let sum = 0;
  for (let i = 0; i < picks.length; i++) {
    const acc = accountIds[i];
    const hero = picks[i];
    if (!acc || acc <= 0) continue;
    const heroMap = playerHeroStats.get(acc);
    const stat = heroMap?.get(hero);
    if (!stat || stat.games <= 0) continue;
    const playerWR = stat.wins / stat.games;
    const baseWR = globalHeroWR(hero, heroStats);
    sum += (playerWR - baseWR) * Math.log(stat.games + 1);
  }
  return sum;
}

function teamAvgGlicko(
  accountIds: number[] | null | undefined,
  playerGlicko: PlayerGlickoMap,
): number {
  if (!accountIds || accountIds.length === 0) return 1500;
  let sum = 0;
  for (const a of accountIds) {
    if (!a || a <= 0) { sum += 1500; continue; }
    const g = playerGlicko.get(a);
    sum += g ? g.rating : 1500;
  }
  return sum / accountIds.length;
}

export function computeRosterStability(
  rows: Array<{
    matchId: number;
    radiantTeamId: number | null;
    direTeamId: number | null;
    radiantAccountIds: number[] | null | undefined;
    direAccountIds: number[] | null | undefined;
  }>,
): RosterStabilityMap {
  const sorted = [...rows].sort((a, b) => b.matchId - a.matchId);
  const teamSets = new Map<number, number[][]>();

  for (const d of sorted) {
    if (d.radiantTeamId && d.radiantAccountIds && d.radiantAccountIds.length > 0) {
      const key = d.radiantTeamId;
      const arr = teamSets.get(key) ?? [];
      if (arr.length < 10) {
        arr.push(d.radiantAccountIds.filter(a => a > 0));
        teamSets.set(key, arr);
      }
    }
    if (d.direTeamId && d.direAccountIds && d.direAccountIds.length > 0) {
      const key = d.direTeamId;
      const arr = teamSets.get(key) ?? [];
      if (arr.length < 10) {
        arr.push(d.direAccountIds.filter(a => a > 0));
        teamSets.set(key, arr);
      }
    }
  }

  const result: RosterStabilityMap = new Map();
  for (const [teamId, sets] of teamSets) {
    if (sets.length < 2) {
      result.set(teamId, 1.0);
      continue;
    }
    let jacSum = 0;
    let pairs = 0;
    for (let i = 0; i < sets.length - 1; i++) {
      const setA = sets[i];
      const setB = new Set(sets[i + 1]);
      const intersection = setA.filter(x => setB.has(x)).length;
      const union = new Set([...setA, ...sets[i + 1]]).size;
      jacSum += union > 0 ? intersection / union : 1;
      pairs++;
    }
    result.set(teamId, pairs > 0 ? jacSum / pairs : 1.0);
  }
  return result;
}

export function buildExtraFeatures(args: {
  radiantTeamId: number;
  direTeamId: number;
  radiantPicks: number[];
  direPicks: number[];
  radiantAccountIds: number[] | null | undefined;
  direAccountIds: number[] | null | undefined;
  playerHeroStats: PlayerHeroStatsMap;
  heroStats: HeroStatsMap;
  recentForm: RecentFormMap;
  h2h: H2HMap;
  playerGlicko: PlayerGlickoMap;
  sos?: SoSMap;
  rosterStability?: RosterStabilityMap;
}): number[] {
  const radSkill = teamPlayerSkill(args.radiantPicks, args.radiantAccountIds, args.playerHeroStats, args.heroStats);
  const dirSkill = teamPlayerSkill(args.direPicks, args.direAccountIds, args.playerHeroStats, args.heroStats);
  const playerSkillDiff = radSkill - dirSkill;

  const formR = args.recentForm.get(args.radiantTeamId);
  const formD = args.recentForm.get(args.direTeamId);
  const recentFormDiff = (formR?.winRate ?? 0.5) - (formD?.winRate ?? 0.5);

  let h2hAdv = 0;
  if (args.radiantTeamId !== args.direTeamId) {
    const low = Math.min(args.radiantTeamId, args.direTeamId);
    const high = Math.max(args.radiantTeamId, args.direTeamId);
    const entry = args.h2h.get(`${low}_${high}`);
    if (entry && entry.games > 0) {
      const lowWR = entry.winsLow / entry.games;
      const radIsLow = args.radiantTeamId === low;
      const radWR = radIsLow ? lowWR : 1 - lowWR;
      h2hAdv = (radWR - 0.5) * Math.log(entry.games + 1);
    }
  }

  let glickoDiff = 0;
  if (args.radiantAccountIds || args.direAccountIds) {
    const radG = teamAvgGlicko(args.radiantAccountIds, args.playerGlicko);
    const dirG = teamAvgGlicko(args.direAccountIds, args.playerGlicko);
    glickoDiff = (radG - dirG) / 200;
  }

  const avgKillsDiff =
    ((formR?.avgKillsFor ?? GLOBAL_AVG_KILLS_PER_TEAM) -
     (formD?.avgKillsFor ?? GLOBAL_AVG_KILLS_PER_TEAM)) / 10;

  const avgDurDiff =
    ((formR?.avgDurationSec ?? GLOBAL_AVG_DURATION_SEC) -
     (formD?.avgDurationSec ?? GLOBAL_AVG_DURATION_SEC)) / 3600;

  const sosR = args.sos?.get(args.radiantTeamId);
  const sosD = args.sos?.get(args.direTeamId);
  const sosDiff = (sosR != null && sosD != null) ? (sosR - sosD) / 200 : 0;

  const stabR = args.rosterStability?.get(args.radiantTeamId) ?? 0.5;
  const stabD = args.rosterStability?.get(args.direTeamId) ?? 0.5;
  const rosterStabilityDiff = stabR - stabD;

  return [
    playerSkillDiff,
    recentFormDiff,
    h2hAdv,
    1,
    glickoDiff,
    avgKillsDiff,
    avgDurDiff,
    sosDiff,
    rosterStabilityDiff,
  ];
}
