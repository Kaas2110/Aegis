/**
 * Wave 5: расширенные prematch team-фичи.
 *
 * Реализует rolling-state pass по pro_matches (хронологически) и считает
 * "as-of-match" значения per-team — без leakage будущих игр.
 *
 * Используется:
 *  - `train-model.ts` / `train-lightgbm.ts` — для каждого матча вычисляет
 *     состояние команд НА МОМЕНТ матча (before update) и подаёт в
 *     buildTeamFeatures.
 *  - `compute-team-extended.ts` — финальное состояние "как сейчас"
 *     записывается в `team_extended_features` для использования на inference'е.
 *
 * Все per-side rolling считается ОТДЕЛЬНО для radiant и dire — это даёт
 * фичу "side preference" (radiant.radiantWr - dire.direWr), которая
 * подсказывает что команда X лучше за свет, а Y — за тьму.
 */

const WINDOW_30D_SEC = 30 * 86400;
const FB_EARLY_THRESHOLD_SEC = 5 * 60;  // first blood считается «ранним» если до 5 мин

export interface MatchForRollup {
  matchId: number;
  startTime: number;       // unix seconds
  duration: number;        // seconds
  radiantTeamId: number | null;
  direTeamId: number | null;
  radiantWin: boolean;
  firstBloodTime: number | null;  // seconds since match start
}

/** Последние N (только в окне 30d) матчей команды для агрегатов. */
interface RecentMatchEntry {
  startTime: number;       // unix seconds
  won: boolean;
  durationSec: number;
  earlyFb: boolean;        // FB случился до FB_EARLY_THRESHOLD_SEC
}

export interface TeamRollingState {
  lastMatchTime: number | null;
  winStreak: number;             // signed: +N подряд побед / -N поражений
  radiantWins: number;           // cumulative per-side
  radiantGames: number;
  direWins: number;
  direGames: number;
  recent: RecentMatchEntry[];    // только матчи в окне 30d (старые сбрасываются на чтении)
}

export function newRollingState(): TeamRollingState {
  return {
    lastMatchTime: null,
    winStreak: 0,
    radiantWins: 0,
    radiantGames: 0,
    direWins: 0,
    direGames: 0,
    recent: [],
  };
}

/** Снимок состояния «as-of-now» (now = unix seconds), без модификации. */
export interface TeamExtendedSnapshot {
  winStreak: number;
  daysSinceLastMatch: number | null;  // null если матчей не было
  matches30d: number;
  avgDurationSec30d: number | null;   // null если 0 матчей в окне
  firstBloodRate30d: number | null;   // null если 0 матчей в окне
  radiantWinrate: number | null;      // null если 0 игр за свет
  direWinrate: number | null;         // null если 0 игр за тьму
}

export function snapshotAt(state: TeamRollingState, nowSec: number): TeamExtendedSnapshot {
  // Чистим recent от устаревших (вне 30d окна относительно nowSec).
  const cutoff = nowSec - WINDOW_30D_SEC;
  const fresh = state.recent.filter(r => r.startTime >= cutoff);
  let dur = 0, fb = 0;
  for (const r of fresh) { dur += r.durationSec; if (r.earlyFb) fb += 1; }
  const n = fresh.length;
  return {
    winStreak: state.winStreak,
    daysSinceLastMatch: state.lastMatchTime != null
      ? Math.max(0, (nowSec - state.lastMatchTime) / 86400)
      : null,
    matches30d: n,
    avgDurationSec30d: n > 0 ? dur / n : null,
    firstBloodRate30d: n > 0 ? fb / n : null,
    radiantWinrate: state.radiantGames > 0 ? state.radiantWins / state.radiantGames : null,
    direWinrate: state.direGames > 0 ? state.direWins / state.direGames : null,
  };
}

/** Применяет один матч к двум командам (mutates state). Должно вызываться
 *  СТРОГО хронологически (по startTime asc). */
export function applyMatch(
  rState: TeamRollingState,
  dState: TeamRollingState,
  m: MatchForRollup,
): void {
  const earlyFb = m.firstBloodTime != null && m.firstBloodTime > 0
    && m.firstBloodTime <= FB_EARLY_THRESHOLD_SEC;
  // Сбросим recent от устаревших ДО добавления нового — чтобы окно
  // двигалось вместе с временем поступления матча.
  const cutoff = m.startTime - WINDOW_30D_SEC;
  rState.recent = rState.recent.filter(r => r.startTime >= cutoff);
  dState.recent = dState.recent.filter(r => r.startTime >= cutoff);

  rState.recent.push({ startTime: m.startTime, won: m.radiantWin, durationSec: m.duration, earlyFb });
  dState.recent.push({ startTime: m.startTime, won: !m.radiantWin, durationSec: m.duration, earlyFb });

  // win streak — knock on радиант, dire
  rState.winStreak = m.radiantWin
    ? (rState.winStreak >= 0 ? rState.winStreak + 1 : 1)
    : (rState.winStreak <= 0 ? rState.winStreak - 1 : -1);
  dState.winStreak = !m.radiantWin
    ? (dState.winStreak >= 0 ? dState.winStreak + 1 : 1)
    : (dState.winStreak <= 0 ? dState.winStreak - 1 : -1);

  rState.radiantGames += 1; if (m.radiantWin) rState.radiantWins += 1;
  dState.direGames += 1; if (!m.radiantWin) dState.direWins += 1;

  rState.lastMatchTime = m.startTime;
  dState.lastMatchTime = m.startTime;
}

// ── Имена и dim расширенных фичей ─────────────────────────────────────
//
// Добавляются ПОСЛЕ существующих 12 базовых TEAM_FEATURE_NAMES. Порядок
// фиксирован — должен совпадать в train scripts и в PredictionModel.
export const EXTENDED_TEAM_FEATURE_NAMES = [
  'win_streak_diff',          // (r - d) clipped ±10, /10
  'rest_days_diff',           // (r - d) clipped ±14, /14 (more rest = positive)
  'matches_30d_diff',         // (r - d) clipped ±20, /20
  'avg_duration_30d_diff',    // (r - d) в минутах, clipped ±10, /10
  'fb_rate_30d_diff',         // (r - d) -1..1
  'side_pref_diff',           // r.radiantWr - d.direWr, -1..1
] as const;
export const EXTENDED_TEAM_FEATURE_DIM = EXTENDED_TEAM_FEATURE_NAMES.length;  // 6

function clip(x: number, abs: number): number {
  if (x > abs) return abs;
  if (x < -abs) return -abs;
  return x;
}

/**
 * Считает 6 расширенных фичей из двух snapshot'ов.
 * Если snapshot отсутствует (новая команда без матчей) — фича = 0
 * (нейтральный сигнал, как и поведение тренировки).
 */
export function buildExtendedTeamFeatures(
  r: TeamExtendedSnapshot | null,
  d: TeamExtendedSnapshot | null,
): number[] {
  const rs = r ?? defaultSnapshot();
  const ds = d ?? defaultSnapshot();

  const winStreakDiff = clip((rs.winStreak - ds.winStreak), 10) / 10;
  const restR = rs.daysSinceLastMatch ?? 0;
  const restD = ds.daysSinceLastMatch ?? 0;
  const restDaysDiff = clip(restR - restD, 14) / 14;

  const matchesDiff = clip(rs.matches30d - ds.matches30d, 20) / 20;

  const durMinR = rs.avgDurationSec30d != null ? rs.avgDurationSec30d / 60 : 36;  // дефолт 36 мин (медиана)
  const durMinD = ds.avgDurationSec30d != null ? ds.avgDurationSec30d / 60 : 36;
  const durDiff = clip(durMinR - durMinD, 10) / 10;

  const fbR = rs.firstBloodRate30d ?? 0.5;
  const fbD = ds.firstBloodRate30d ?? 0.5;
  const fbDiff = fbR - fbD;

  // 0.5 default → side_pref_diff = 0 когда обоих snapshot'ов нет
  // (true neutral, без leakage radiant-bias).
  const sidePrefR = rs.radiantWinrate ?? 0.5;
  const sidePrefD = ds.direWinrate ?? 0.5;
  const sidePref = sidePrefR - sidePrefD;

  return [winStreakDiff, restDaysDiff, matchesDiff, durDiff, fbDiff, sidePref];
}

function defaultSnapshot(): TeamExtendedSnapshot {
  return {
    winStreak: 0,
    daysSinceLastMatch: null,
    matches30d: 0,
    avgDurationSec30d: null,
    firstBloodRate30d: null,
    radiantWinrate: null,
    direWinrate: null,
  };
}
