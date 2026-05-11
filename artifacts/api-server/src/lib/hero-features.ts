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

// ── Wave 3: extras (player-skill, recent form, h2h, side) — зеркало scripts/src/lib ──

export interface PlayerHeroStat { games: number; wins: number; }
export type PlayerHeroStatsMap = Map<number, Map<number, PlayerHeroStat>>;

export interface RecentForm { winRate: number; games: number; }
export type RecentFormMap = Map<number, RecentForm>;

export interface H2HEntry { games: number; winsLow: number; }
export type H2HMap = Map<string, H2HEntry>;

export const EXTRA_FEATURE_NAMES = [
  'player_skill_diff',
  'recent_form_diff',
  'h2h_advantage_radiant',
  'side_advantage',
] as const;

export const EXTRA_FEATURE_DIM = EXTRA_FEATURE_NAMES.length;

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

  return [playerSkillDiff, recentFormDiff, h2hAdv, 1];
}
