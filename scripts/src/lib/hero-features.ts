/**
 * Фичи драфта (hero/pick) для Волны 2 модели v2.
 *
 * Зеркало в artifacts/api-server/src/lib/hero-features.ts должно быть
 * идентичным — иначе тренировка и инференс разойдутся.
 *
 * Вход: 5 пиков радианта, 5 пиков дайра, баны (длина 5-7).
 * Выход: 7 hero-фичей или null если у какого-то пика нет hero_stats.
 *
 * Список фичей (порядок фиксирован, добавление новых — только в конец!):
 *   h0 = radiant_pick_strength      Σ pro_win_rate (5 героев)
 *   h1 = dire_pick_strength
 *   h2 = pick_strength_diff         h0 − h1
 *   h3 = matchup_advantage          Σ_{r,d} (winRate(r vs d) − 0.5) · log(games + 1)
 *   h4 = radiant_meta_score         Σ pro_pick_rate (насколько драфт «в мете»)
 *   h5 = dire_meta_score
 *   h6 = ban_priority_diff          Σ pro_pick_rate банов радианта − дайра
 */

export interface HeroStat {
  proWinRate: number;
  proPickRate: number;
}

export interface HeroMatchup {
  games: number;
  winRate: number;  // P(heroId wins vs vsHeroId)
}

export type HeroStatsMap = Map<number, HeroStat>;
/** Outer key: heroId. Inner key: vsHeroId. winRate = P(outer wins vs inner). */
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

/**
 * Возвращает 7 hero-фичей или null если выборка непригодна:
 *   - количество пиков ≠ 5 у любой из сторон;
 *   - у любого из пиков нет записи в hero_stats (новый герой / неполные данные).
 *
 * Бан-фичи мягче: отсутствие бана в hero_stats просто пропускается.
 */
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

  // Σ по 25 парам (radiantHero × direHero) winRate сглаженный по log(games+1).
  // Симметричный fallback: если нет прямой записи (r → d), пробуем обратную
  // (d → r) и инвертируем winRate. Это защищает от направленной асимметрии
  // на неполных матрицах (typical во время инкрементальной ингестии).
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

// ── Wave 3: player-skill / form / h2h / side / glicko ────────────────────
// 5 фичей поверх v2. v3 dim = team(12) + hero(7) + extra(9) = 28.

export interface PlayerHeroStat { games: number; wins: number; }
/** Map<accountId, Map<heroId, {games, wins}>> */
export type PlayerHeroStatsMap = Map<number, Map<number, PlayerHeroStat>>;

export interface RecentForm {
  winRate: number;
  games: number;
  avgKillsFor?: number;    // средние убийства за (команда как атакующая)
  avgDurationSec?: number; // средняя длительность карты в секундах
}
/** Map<teamId, RecentForm> for chosen period (e.g. 30d) */
export type RecentFormMap = Map<number, RecentForm>;

export interface H2HEntry { games: number; winsLow: number; }
/** Map keyed by `${low}_${high}` (sorted teamIds). */
export type H2HMap = Map<string, H2HEntry>;

export interface PlayerGlicko { rating: number; rd: number; }
/** Map<accountId, {rating, rd}> — Glicko-1 рейтинг игрока. */
export type PlayerGlickoMap = Map<number, PlayerGlicko>;

/** Map<teamId, avgOpponentElo> — Strength of Schedule (30d). */
export type SoSMap = Map<number, number>;

/** Map<teamId, stabilityScore 0–1> — avg Jaccard similarity last 10 lineups. */
export type RosterStabilityMap = Map<number, number>;

export const EXTRA_FEATURE_NAMES = [
  'player_skill_diff',       // Σ (wr_on_hero - global_wr_on_hero)·log(games+1) rad - dire
  'recent_form_diff',        // form30.winRate(rad) - form30.winRate(dire)
  'h2h_advantage_radiant',   // P(radiant wins h2h) - 0.5, scaled by log(games+1)
  'side_advantage',          // 1 (radiant always plays radiant в этом матче)
  'player_glicko_diff',      // (avg(rad glicko) - avg(dire glicko)) / 200
  'avg_kills_diff',          // (avgKillsFor_R - avgKillsFor_D) / 10
  'avg_duration_diff',       // (avgDurationSec_R - avgDurationSec_D) / 3600
  'sos_diff',                // (avgOppElo_R - avgOppElo_D) / 200
  'roster_stability_diff',   // Jaccard stability: stabilityR - stabilityD
] as const;

export const EXTRA_FEATURE_DIM = EXTRA_FEATURE_NAMES.length;

// Нормировочные константы (прo-сцена по историческим данным)
const GLOBAL_AVG_KILLS_PER_TEAM = 22;   // убийств за команду за карту (~44 total)
const GLOBAL_AVG_DURATION_SEC = 2340;    // ~39 минут

/** Глобальный winrate героя — берём из heroStats.proWinRate (≈0.5 если незнакомый). */
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

/**
 * Avg Glicko рейтинг команды (используя только игроков, у которых есть запись).
 * Игроки без записи трактуются как DEFAULT_GLICKO (1500) — нейтрально.
 */
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

/**
 * Вычисляет roster_stability по текущим данным match_drafts.
 * Для каждой команды берёт последние до 10 матчей (по убыванию matchId),
 * считает avg Jaccard similarity между соседними player-sets.
 * Возвращает Map<teamId, stability 0–1>.
 */
export function computeRosterStability(
  rows: Array<{
    matchId: number;
    radiantTeamId: number | null;
    direTeamId: number | null;
    radiantAccountIds: number[] | null | undefined;
    direAccountIds: number[] | null | undefined;
  }>,
): RosterStabilityMap {
  // По убыванию matchId (свежее = первее)
  const sorted = [...rows].sort((a, b) => b.matchId - a.matchId);
  const teamSets = new Map<number, number[][]>(); // teamId → list of player-sets

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
      result.set(teamId, 1.0); // только один матч — считаем стабильным
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

/** Возвращает 9 v3-extra фичей. Аргументы могут быть null — тогда фича = 0. */
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

  // H2H — направленный лукап через канонический ключ.
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

  // Glicko-diff: только если хотя бы одна сторона имеет account_ids; иначе 0.
  let glickoDiff = 0;
  if (args.radiantAccountIds || args.direAccountIds) {
    const radG = teamAvgGlicko(args.radiantAccountIds, args.playerGlicko);
    const dirG = teamAvgGlicko(args.direAccountIds, args.playerGlicko);
    glickoDiff = (radG - dirG) / 200;
  }

  // avg_kills_diff: (avgKillsFor_R - avgKillsFor_D) / 10
  const avgKillsDiff =
    ((formR?.avgKillsFor ?? GLOBAL_AVG_KILLS_PER_TEAM) -
     (formD?.avgKillsFor ?? GLOBAL_AVG_KILLS_PER_TEAM)) / 10;

  // avg_duration_diff: (avgDurationSec_R - avgDurationSec_D) / 3600
  const avgDurDiff =
    ((formR?.avgDurationSec ?? GLOBAL_AVG_DURATION_SEC) -
     (formD?.avgDurationSec ?? GLOBAL_AVG_DURATION_SEC)) / 3600;

  // sos_diff: (avgOppElo_R - avgOppElo_D) / 200
  const sosR = args.sos?.get(args.radiantTeamId);
  const sosD = args.sos?.get(args.direTeamId);
  const sosDiff = (sosR != null && sosD != null) ? (sosR - sosD) / 200 : 0;

  // roster_stability_diff: stabilityR - stabilityD (0 = нет данных)
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
