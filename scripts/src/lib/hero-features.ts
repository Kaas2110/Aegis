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
 *   ── T0 mini-fix (2026-05-16) ──────────────────────────────────────────
 *   h7 = synergy_diff               Σ_{r∈team5} (synergyWR(ri,rj)-0.5)·log(g+1)
 *                                    radiant - dire, по 10 уникальным парам внутри
 *                                    каждой команды. Источник: `hero_synergy`
 *                                    (Stratz DIVINE_IMMORTAL bracket). Если
 *                                    synergyMap === undefined → 0 (BC).
 *   h8 = early_game_score_diff      Σ heroStats.earlyGameScore (radiant) - dire.
 *                                    Источник: `hero_stats.early_game_score`
 *                                    (default 0.5 если не заполнено).
 *   h9 = late_game_score_diff       аналогично late_game_score.
 */

export interface HeroStat {
  proWinRate: number;
  proPickRate: number;
  /** T0 mini-fix: добавлено для early/late game score фичей. Default 0.5 если null. */
  earlyGameScore?: number;
  lateGameScore?: number;
}

export interface HeroMatchup {
  games: number;
  winRate: number;  // P(heroId wins vs vsHeroId)
}

export type HeroStatsMap = Map<number, HeroStat>;
/** Outer key: heroId. Inner key: vsHeroId. winRate = P(outer wins vs inner). */
export type HeroMatchupsMap = Map<number, Map<number, HeroMatchup>>;

/** Синергия (две героя в ОДНОЙ команде).
 *  Outer key: heroId. Inner key: withHeroId. winRate = P(team wins | both picked).
 *  Симметричный лукап: пробуем (a,b), потом (b,a) с тем же winRate. */
export interface HeroSynergyEntry { games: number; winRate: number; }
export type HeroSynergyMap = Map<number, Map<number, HeroSynergyEntry>>;

export const HERO_FEATURE_NAMES = [
  'radiant_pick_strength',
  'dire_pick_strength',
  'pick_strength_diff',
  'matchup_advantage',
  'radiant_meta_score',
  'dire_meta_score',
  'ban_priority_diff',
  'synergy_diff',
  'early_game_score_diff',
  'late_game_score_diff',
  'counter_bans_diff',
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
  /** T0 mini-fix: optional. Если не передан — synergy_diff = 0 (нейтрально). */
  synergy?: HeroSynergyMap | null,
): number[] | null {
  if (radiantPicks.length !== 5 || direPicks.length !== 5) return null;

  let radPickStr = 0;
  let dirPickStr = 0;
  let radMeta = 0;
  let dirMeta = 0;
  let radEarly = 0;
  let dirEarly = 0;
  let radLate = 0;
  let dirLate = 0;

  for (const h of radiantPicks) {
    const s = heroStats.get(h);
    if (!s) return null;
    radPickStr += s.proWinRate;
    radMeta += s.proPickRate;
    radEarly += s.earlyGameScore ?? 0.5;
    radLate += s.lateGameScore ?? 0.5;
  }
  for (const h of direPicks) {
    const s = heroStats.get(h);
    if (!s) return null;
    dirPickStr += s.proWinRate;
    dirMeta += s.proPickRate;
    dirEarly += s.earlyGameScore ?? 0.5;
    dirLate += s.lateGameScore ?? 0.5;
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

  // T0 mini-fix: synergy_diff. Перебираем 10 уникальных пар внутри каждой
  // команды (i<j). Симметричный лукап (a→b или b→a с тем же winRate).
  // Если synergy не передан или пара не найдена — вклад 0 (нейтрально).
  let radSyn = 0;
  let dirSyn = 0;
  if (synergy) {
    const pairScore = (a: number, b: number): number => {
      const e = synergy.get(a)?.get(b) ?? synergy.get(b)?.get(a);
      if (!e || e.games <= 0) return 0;
      return (e.winRate - 0.5) * Math.log(e.games + 1);
    };
    for (let i = 0; i < radiantPicks.length; i++) {
      for (let j = i + 1; j < radiantPicks.length; j++) {
        radSyn += pairScore(radiantPicks[i], radiantPicks[j]);
      }
    }
    for (let i = 0; i < direPicks.length; i++) {
      for (let j = i + 1; j < direPicks.length; j++) {
        dirSyn += pairScore(direPicks[i], direPicks[j]);
      }
    }
  }

  // T0 mini-fix v2: counter_bans_diff. «Защитный counter-ban» = команда забанила
  // героя b, который СИЛЬНО counter'ил бы её собственные пики p (winRate(b,p) > 0.5).
  // Чем больше суммарного «защищённого matchup-выигрыша» — тем умнее набанили.
  // Метрика не требует знания порядка бана/пика и draft-фазы.
  let radCBan = 0;
  let dirCBan = 0;
  const counterBanScore = (bans: number[], ourPicks: number[]): number => {
    let acc = 0;
    for (const b of bans) {
      const banOuter = matchups.get(b);
      if (!banOuter) continue;
      for (const p of ourPicks) {
        const m = banOuter.get(p);
        if (!m || m.games <= 0) continue;
        // winRate(b vs p) > 0.5 → b бил наш p → бан помог нам.
        const adv = m.winRate - 0.5;
        if (adv > 0) acc += adv * Math.log(m.games + 1);
      }
    }
    return acc;
  };
  radCBan = counterBanScore(radiantBans, radiantPicks);
  dirCBan = counterBanScore(direBans, direPicks);

  return [
    radPickStr,
    dirPickStr,
    radPickStr - dirPickStr,
    matchupAdv,
    radMeta,
    dirMeta,
    radBanPrio - dirBanPrio,
    radSyn - dirSyn,
    radEarly - dirEarly,
    radLate - dirLate,
    radCBan - dirCBan,
  ];
}

// ── Wave 3: player-skill / form / h2h / side / glicko ────────────────────
// 5 фичей поверх v2. v3 dim = team(5) + hero(7) + extra(5) = 17.

export interface PlayerHeroStat {
  games: number;
  wins: number;
  /** T0 mini-fix v2: Unix seconds последнего матча игрока на этом герое. NULL если неизвестно. */
  lastPlayed?: number | null;
}
/** Map<accountId, Map<heroId, {games, wins}>> */
export type PlayerHeroStatsMap = Map<number, Map<number, PlayerHeroStat>>;

export interface RecentForm { winRate: number; games: number; }
/** Map<teamId, RecentForm> for chosen period (e.g. 30d) */
export type RecentFormMap = Map<number, RecentForm>;

export interface H2HEntry { games: number; winsLow: number; }
/** Map keyed by `${low}_${high}` (sorted teamIds). */
export type H2HMap = Map<string, H2HEntry>;

export interface PlayerGlicko { rating: number; rd: number; }
/** Map<accountId, {rating, rd}> — Glicko-1 рейтинг игрока. */
export type PlayerGlickoMap = Map<number, PlayerGlicko>;

export const EXTRA_FEATURE_NAMES = [
  'player_skill_diff',     // Σ (winrate_on_hero - global_winrate_on_hero)·log(games+1) radiant - dire
  'recent_form_diff',      // form30.winRate(rad) - form30.winRate(dire)
  'h2h_advantage_radiant', // P(radiant wins h2h) - 0.5, scaled by log(games+1)
  'side_advantage',        // 1 (radiant always plays radiant в этом матче) — модель выучит вес
  'player_glicko_diff',    // (avg(rad glicko) - avg(dire glicko)) / 200
  'player_hero_recency_diff', // T0 mini-fix v2: avg «свежесть» (last_played) по 5 пикам radiant - dire
] as const;

export const EXTRA_FEATURE_DIM = EXTRA_FEATURE_NAMES.length;

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
 * T0 mini-fix v2: recency считается как доля «свежести» 1 - daysSinceLastPlayed/90,
 * усреднённая по 5 пикам стороны. Игрок без lastPlayed → пропускаем (не штрафуем).
 * Команда без accountIds → возвращаем 0 (нейтрально, BC).
 */
function teamRecency(
  picks: number[],
  accountIds: number[] | null | undefined,
  playerHeroStats: PlayerHeroStatsMap,
  nowUnix: number,
): number {
  if (!accountIds || accountIds.length !== picks.length) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < picks.length; i++) {
    const acc = accountIds[i];
    const hero = picks[i];
    if (!acc || acc <= 0) continue;
    const stat = playerHeroStats.get(acc)?.get(hero);
    if (!stat || stat.lastPlayed == null) continue;
    const daysAgo = Math.max(0, (nowUnix - stat.lastPlayed) / 86400);
    sum += Math.max(0, 1 - daysAgo / 90);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/** Возвращает 6 v3-extra фичей. Аргументы могут быть null — тогда фича = 0. */
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
  /** Unix seconds. Default = Date.now()/1000. Train передаёт время МАТЧА (не сегодняшнее), inference — текущее. */
  nowUnix?: number;
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

  // T0 mini-fix v2: recency_diff. nowUnix дефолт — текущий момент (inference);
  // train.ts передаёт startTime матча, чтобы не «протекало будущее» в lastPlayed.
  const now = args.nowUnix ?? Math.floor(Date.now() / 1000);
  const recencyR = teamRecency(args.radiantPicks, args.radiantAccountIds, args.playerHeroStats, now);
  const recencyD = teamRecency(args.direPicks, args.direAccountIds, args.playerHeroStats, now);
  const recencyDiff = recencyR - recencyD;

  return [playerSkillDiff, recentFormDiff, h2hAdv, 1, glickoDiff, recencyDiff];
}
