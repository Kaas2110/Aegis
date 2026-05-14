/**
 * Wave 5: расширенные prematch team-фичи (inference-side).
 *
 * Зеркалирует scripts/src/lib/team-extended.ts (только snapshot/build —
 * без applyMatch/newRollingState, которые нужны лишь для тренировки).
 * Названия и порядок фичей ОБЯЗАНЫ совпадать с train-сторон.
 */

export interface TeamExtendedSnapshot {
  winStreak: number;
  daysSinceLastMatch: number | null;
  matches30d: number;
  avgDurationSec30d: number | null;
  firstBloodRate30d: number | null;
  radiantWinrate: number | null;
  direWinrate: number | null;
}

export const EXTENDED_TEAM_FEATURE_NAMES = [
  'win_streak_diff',
  'rest_days_diff',
  'matches_30d_diff',
  'avg_duration_30d_diff',
  'fb_rate_30d_diff',
  'side_pref_diff',
] as const;
export const EXTENDED_TEAM_FEATURE_DIM = EXTENDED_TEAM_FEATURE_NAMES.length;  // 6

function clip(x: number, abs: number): number {
  if (x > abs) return abs;
  if (x < -abs) return -abs;
  return x;
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

export function buildExtendedTeamFeatures(
  r: TeamExtendedSnapshot | null,
  d: TeamExtendedSnapshot | null,
): number[] {
  const rs = r ?? defaultSnapshot();
  const ds = d ?? defaultSnapshot();
  const winStreakDiff = clip(rs.winStreak - ds.winStreak, 10) / 10;
  const restR = rs.daysSinceLastMatch ?? 0;
  const restD = ds.daysSinceLastMatch ?? 0;
  const restDaysDiff = clip(restR - restD, 14) / 14;
  const matchesDiff = clip(rs.matches30d - ds.matches30d, 20) / 20;
  const durMinR = rs.avgDurationSec30d != null ? rs.avgDurationSec30d / 60 : 36;
  const durMinD = ds.avgDurationSec30d != null ? ds.avgDurationSec30d / 60 : 36;
  const durDiff = clip(durMinR - durMinD, 10) / 10;
  const fbR = rs.firstBloodRate30d ?? 0.5;
  const fbD = ds.firstBloodRate30d ?? 0.5;
  const fbDiff = fbR - fbD;
  // 0.5 default → side_pref_diff = 0 когда snapshot'ов нет (true neutral).
  const sidePrefR = rs.radiantWinrate ?? 0.5;
  const sidePrefD = ds.direWinrate ?? 0.5;
  const sidePref = sidePrefR - sidePrefD;
  return [winStreakDiff, restDaysDiff, matchesDiff, durDiff, fbDiff, sidePref];
}
