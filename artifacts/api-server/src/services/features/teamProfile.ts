/**
 * Team profile features — консолидирует T3-T7 фичи для одной команды.
 *
 * T3 series momentum — текущая series wins/losses + последние BO3 финиши
 * T4 dynamic form — recency-weighted winrate (последние N матчей exponential decay)
 * T5 ELO decomp — агрегат player_ratings по recent roster + tier-sensitive
 * T6 team styles — длительность/FB/scores профиль из team_extended_features
 * T7 entropy + side preference — pick-diversity (shannon) + radiant/dire bias
 *
 * Все читается SQL'ом из существующих таблиц, никаких новых ingest-скриптов.
 * Один эндпоинт `/api/analytics/team-profile?teamId=N` → весь profile.
 * Heavy lifting обходится без новых колонок: где нет данных, поле = null.
 *
 * Каждый под-блок fail-soft: упавший SQL → секция = null, остальное считается.
 * Это критично для T8 (A vs B compare) который пойдёт через 2× этого вызова.
 */

import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';

export interface SeriesMomentum {
  /** Активная незавершённая серия (если есть). */
  activeSeries: {
    seriesId: string;
    opponentId: number | null;
    format: number;
    winsForTeam: number;
    winsForOpponent: number;
    mapsPlayed: number;
  } | null;
  /** Win-rate последних N завершённых серий (BO3+). */
  recentSeriesWinRate: number | null;
  recentSeriesCount: number;
}

export interface DynamicForm {
  /** Базовый 30/90 winrate из team_recent_form. */
  winRate30d: number | null;
  winRate90d: number | null;
  /**
   * Recency-weighted winrate: exp-decay по start_time за 90д.
   * λ=ln(2)/30d → последние 30 дней весят 2× как предыдущие.
   */
  weightedWinRate: number | null;
  weightedSampleSize: number;
  winStreak: number | null;
  daysSinceLastMatch: number | null;
}

export interface EloDecomp {
  /**
   * Средний Glicko рейтинг ростера за последние 30д матчей.
   * Берём account_ids из match_drafts последних матчей team_id и усредняем
   * player_ratings.rating. Веса равные, RD-weighting — следующая итерация.
   */
  avgPlayerRating: number | null;
  /** Std отклонение по ростеру — «насколько ровный состав». */
  playerRatingSpread: number | null;
  /** Кол-во известных players (account_id != 0 и есть в player_ratings). */
  knownPlayers: number;
  /**
   * Tier proxy: 3=t1 (avg rating ≥ 1700), 2=t2 (1500-1700), 1=t3 (<1500).
   * Грубо, но даёт численный «тир» для tier-routing в моделях.
   */
  tierLevel: 1 | 2 | 3 | null;
}

export interface TeamStyles {
  avgDurationSec30d: number | null;
  firstBloodRate30d: number | null;
  avgKillsFor: number | null;
  avgKillsAgainst: number | null;
  /** Style label: 'fast' если avg dur < 32 мин, 'slow' если > 40, иначе 'mid'. */
  paceLabel: 'fast' | 'mid' | 'slow' | null;
  /** Aggression: kills_for / (kills_for + kills_against). 0.5 = neutral. */
  aggression: number | null;
}

export interface DraftEntropyAndSide {
  /**
   * Shannon entropy пиков героев за последние 30д. Высокая = разнообразный
   * пул героев, низкая = команда играет 1-2 героев на роли. Нормирована [0..1]:
   * H_norm = H / log2(уникальных героев).
   */
  pickEntropyNorm: number | null;
  uniqueHeroesPicked: number;
  /** Доля radiant wins среди всех matches (vs dire). 0.5 = неутрально. */
  radiantBias: number | null;
  /** Тот же показатель из team_extended_features (sanity check). */
  radiantWinRate: number | null;
  direWinRate: number | null;
}

export interface TeamProfile {
  teamId: number;
  teamName: string | null;
  teamRating: number | null;
  seriesMomentum: SeriesMomentum | null;
  dynamicForm: DynamicForm | null;
  eloDecomp: EloDecomp | null;
  styles: TeamStyles | null;
  entropy: DraftEntropyAndSide | null;
  /** Сколько секций успешно посчиталось (0..5). Для health-чека на UI. */
  sectionsAvailable: number;
  /** ms total — для бюджетирования. */
  computedMs: number;
}

const LOOKBACK_DAYS = 90;
const RECENT_SERIES_LIMIT = 15;
const ROSTER_LOOKBACK_DAYS = 30;

async function loadTeamBasic(teamId: number): Promise<{ name: string | null; rating: number | null } | null> {
  try {
    const r = await db.execute(sql`
      SELECT name, rating FROM teams WHERE team_id = ${teamId} LIMIT 1
    `);
    const row = r.rows[0] as { name?: string | null; rating?: number | null } | undefined;
    if (!row) return null;
    return { name: row.name ?? null, rating: row.rating ?? null };
  } catch (err) {
    logger.warn({ err, teamId }, '[teamProfile] loadTeamBasic failed');
    return null;
  }
}

async function computeSeriesMomentum(teamId: number): Promise<SeriesMomentum | null> {
  try {
    const active = await db.execute(sql`
      SELECT series_id, team_a_id, team_b_id, format, wins_a, wins_b,
             jsonb_array_length(maps) AS maps_played
      FROM bo3_series
      WHERE finished = false AND (team_a_id = ${teamId} OR team_b_id = ${teamId})
      ORDER BY updated_at DESC LIMIT 1
    `);
    const a = active.rows[0] as {
      series_id?: string | number; team_a_id?: number | null; team_b_id?: number | null;
      format?: number; wins_a?: number; wins_b?: number; maps_played?: number;
    } | undefined;
    let activeSeries: SeriesMomentum['activeSeries'] = null;
    if (a) {
      const isA = Number(a.team_a_id) === teamId;
      activeSeries = {
        seriesId: String(a.series_id ?? ''),
        opponentId: isA ? (a.team_b_id ?? null) : (a.team_a_id ?? null),
        format: a.format ?? 0,
        winsForTeam: isA ? (a.wins_a ?? 0) : (a.wins_b ?? 0),
        winsForOpponent: isA ? (a.wins_b ?? 0) : (a.wins_a ?? 0),
        mapsPlayed: a.maps_played ?? 0,
      };
    }
    const recent = await db.execute(sql`
      SELECT team_a_id, wins_a, wins_b
      FROM bo3_series
      WHERE finished = true AND format >= 1
        AND (team_a_id = ${teamId} OR team_b_id = ${teamId})
      ORDER BY updated_at DESC
      LIMIT ${RECENT_SERIES_LIMIT}
    `);
    let won = 0, total = 0;
    for (const row of recent.rows as Array<{ team_a_id?: number; wins_a?: number; wins_b?: number }>) {
      const isA = Number(row.team_a_id) === teamId;
      const wf = isA ? (row.wins_a ?? 0) : (row.wins_b ?? 0);
      const wo = isA ? (row.wins_b ?? 0) : (row.wins_a ?? 0);
      if (wf === wo) continue;
      total++;
      if (wf > wo) won++;
    }
    return {
      activeSeries,
      recentSeriesWinRate: total > 0 ? won / total : null,
      recentSeriesCount: total,
    };
  } catch (err) {
    logger.warn({ err, teamId }, '[teamProfile] seriesMomentum failed');
    return null;
  }
}

async function computeDynamicForm(teamId: number): Promise<DynamicForm | null> {
  try {
    const baseR = await db.execute(sql`
      SELECT period_days, win_rate FROM team_recent_form WHERE team_id = ${teamId}
    `);
    const wr: Record<number, number> = {};
    for (const r of baseR.rows as Array<{ period_days?: number; win_rate?: number }>) {
      if (typeof r.period_days === 'number' && typeof r.win_rate === 'number') {
        wr[r.period_days] = r.win_rate;
      }
    }
    const extR = await db.execute(sql`
      SELECT win_streak, days_since_last_match
      FROM team_extended_features WHERE team_id = ${teamId} LIMIT 1
    `);
    const ext = extR.rows[0] as { win_streak?: number; days_since_last_match?: number | null } | undefined;
    // Recency-weighted: половинный период 30 дней.
    const matches = await db.execute(sql`
      SELECT start_time, radiant_team_id, radiant_win
      FROM pro_matches
      WHERE (radiant_team_id = ${teamId} OR dire_team_id = ${teamId})
        AND start_time > EXTRACT(EPOCH FROM NOW() - INTERVAL '${sql.raw(String(LOOKBACK_DAYS))} days')
    `);
    const HALF_LIFE_SEC = 30 * 86400;
    const lambda = Math.LN2 / HALF_LIFE_SEC;
    const now = Date.now() / 1000;
    let sumW = 0, sumWWin = 0, count = 0;
    for (const m of matches.rows as Array<{ start_time?: number | string; radiant_team_id?: number | string | null; radiant_win?: boolean }>) {
      const st = Number(m.start_time ?? 0);
      if (!st) continue;
      const age = Math.max(0, now - st);
      const w = Math.exp(-lambda * age);
      const isRad = Number(m.radiant_team_id) === teamId;
      const won = isRad ? m.radiant_win === true : m.radiant_win === false;
      sumW += w;
      if (won) sumWWin += w;
      count++;
    }
    return {
      winRate30d: wr[30] ?? null,
      winRate90d: wr[90] ?? null,
      weightedWinRate: sumW > 0 ? sumWWin / sumW : null,
      weightedSampleSize: count,
      winStreak: ext?.win_streak ?? null,
      daysSinceLastMatch: ext?.days_since_last_match ?? null,
    };
  } catch (err) {
    logger.warn({ err, teamId }, '[teamProfile] dynamicForm failed');
    return null;
  }
}

async function computeEloDecomp(teamId: number): Promise<EloDecomp | null> {
  try {
    // F6 (Phase 9): первичный источник — таблица team_rosters (E1
    // ingest:od-team-rosters, 7d freshness): текущий ростер, top-5 по играм.
    // Драфты свежих матчей часто ещё не заингестены (лаг ingest:drafts),
    // из-за чего старое 30д-окно по match_drafts давало пустой результат
    // даже для tier-1 команд.
    const rosterRes = await db.execute(sql`
      SELECT pr.rating
      FROM (
        SELECT account_id
        FROM team_rosters
        WHERE team_id = ${teamId} AND is_current AND account_id > 0
        ORDER BY games_played DESC
        LIMIT 5
      ) tr
      JOIN player_ratings pr ON pr.account_id = tr.account_id
    `);
    let ratings = (rosterRes.rows as Array<{ rating?: number }>)
      .map(x => x.rating).filter((x): x is number => typeof x === 'number');

    if (ratings.length === 0) {
      // Fallback: account_ids со стороны team_id в драфтах последних 30д матчей.
      const r = await db.execute(sql`
        WITH recent AS (
          SELECT match_id, radiant_team_id, dire_team_id
          FROM pro_matches
          WHERE (radiant_team_id = ${teamId} OR dire_team_id = ${teamId})
            AND start_time > EXTRACT(EPOCH FROM NOW() - INTERVAL '${sql.raw(String(ROSTER_LOOKBACK_DAYS))} days')
        ),
        accs AS (
          SELECT DISTINCT (jsonb_array_elements_text(
            CASE WHEN r.radiant_team_id = ${teamId} THEN md.radiant_account_ids
                 ELSE md.dire_account_ids END
          ))::bigint AS account_id
          FROM recent r
          JOIN match_drafts md ON md.match_id = r.match_id
          WHERE CASE WHEN r.radiant_team_id = ${teamId} THEN md.radiant_account_ids
                     ELSE md.dire_account_ids END IS NOT NULL
        )
        SELECT pr.rating
        FROM accs a
        JOIN player_ratings pr ON pr.account_id = a.account_id
        WHERE a.account_id > 0
      `);
      ratings = (r.rows as Array<{ rating?: number }>)
        .map(x => x.rating).filter((x): x is number => typeof x === 'number');
    }
    if (ratings.length === 0) {
      return { avgPlayerRating: null, playerRatingSpread: null, knownPlayers: 0, tierLevel: null };
    }
    const mean = ratings.reduce((s, x) => s + x, 0) / ratings.length;
    const variance = ratings.reduce((s, x) => s + (x - mean) ** 2, 0) / ratings.length;
    const std = Math.sqrt(variance);
    const tierLevel: 1 | 2 | 3 = mean >= 1700 ? 3 : mean >= 1500 ? 2 : 1;
    return {
      avgPlayerRating: mean,
      playerRatingSpread: std,
      knownPlayers: ratings.length,
      tierLevel,
    };
  } catch (err) {
    logger.warn({ err, teamId }, '[teamProfile] eloDecomp failed');
    return null;
  }
}

async function computeTeamStyles(teamId: number): Promise<TeamStyles | null> {
  try {
    const extR = await db.execute(sql`
      SELECT avg_duration_sec_30d, first_blood_rate_30d
      FROM team_extended_features WHERE team_id = ${teamId} LIMIT 1
    `);
    const ext = extR.rows[0] as { avg_duration_sec_30d?: number | null; first_blood_rate_30d?: number | null } | undefined;
    const formR = await db.execute(sql`
      SELECT avg_kills_for, avg_kills_against
      FROM team_recent_form WHERE team_id = ${teamId} AND period_days = 30 LIMIT 1
    `);
    const form = formR.rows[0] as { avg_kills_for?: number | null; avg_kills_against?: number | null } | undefined;
    const dur = ext?.avg_duration_sec_30d ?? null;
    const paceLabel: TeamStyles['paceLabel'] =
      dur == null ? null : dur < 32 * 60 ? 'fast' : dur > 40 * 60 ? 'slow' : 'mid';
    const kf = form?.avg_kills_for ?? null;
    const ka = form?.avg_kills_against ?? null;
    const aggression = (kf != null && ka != null && (kf + ka) > 0) ? kf / (kf + ka) : null;
    return {
      avgDurationSec30d: dur,
      firstBloodRate30d: ext?.first_blood_rate_30d ?? null,
      avgKillsFor: kf,
      avgKillsAgainst: ka,
      paceLabel,
      aggression,
    };
  } catch (err) {
    logger.warn({ err, teamId }, '[teamProfile] styles failed');
    return null;
  }
}

async function computeEntropy(teamId: number): Promise<DraftEntropyAndSide | null> {
  try {
    // Pick entropy: собираем все hero_ids которые команда играла за 30д
    const r = await db.execute(sql`
      WITH recent AS (
        SELECT match_id, radiant_team_id
        FROM pro_matches
        WHERE (radiant_team_id = ${teamId} OR dire_team_id = ${teamId})
          AND start_time > EXTRACT(EPOCH FROM NOW() - INTERVAL '${sql.raw(String(ROSTER_LOOKBACK_DAYS))} days')
      )
      SELECT (jsonb_array_elements_text(
        CASE WHEN r.radiant_team_id = ${teamId} THEN md.radiant_picks ELSE md.dire_picks END
      ))::int AS hero_id
      FROM recent r
      JOIN match_drafts md ON md.match_id = r.match_id
    `);
    const counts = new Map<number, number>();
    let total = 0;
    for (const row of r.rows as Array<{ hero_id?: number }>) {
      if (typeof row.hero_id !== 'number') continue;
      counts.set(row.hero_id, (counts.get(row.hero_id) ?? 0) + 1);
      total++;
    }
    let pickEntropyNorm: number | null = null;
    const unique = counts.size;
    if (unique > 1 && total > 0) {
      let H = 0;
      for (const c of counts.values()) {
        const p = c / total;
        H -= p * Math.log2(p);
      }
      pickEntropyNorm = H / Math.log2(unique);
    } else if (unique === 1) {
      pickEntropyNorm = 0;
    }
    // Side preference из team_extended_features.
    const extR = await db.execute(sql`
      SELECT radiant_winrate, dire_winrate
      FROM team_extended_features WHERE team_id = ${teamId} LIMIT 1
    `);
    const ext = extR.rows[0] as { radiant_winrate?: number | null; dire_winrate?: number | null } | undefined;
    const rw = ext?.radiant_winrate ?? null;
    const dw = ext?.dire_winrate ?? null;
    const radiantBias = (rw != null && dw != null && (rw + dw) > 0) ? rw / (rw + dw) : null;
    return {
      pickEntropyNorm,
      uniqueHeroesPicked: unique,
      radiantBias,
      radiantWinRate: rw,
      direWinRate: dw,
    };
  } catch (err) {
    logger.warn({ err, teamId }, '[teamProfile] entropy failed');
    return null;
  }
}

/** Один вызов — все T3-T7 фичи для команды. Параллельно, fail-soft. */
export async function getTeamProfile(teamId: number): Promise<TeamProfile> {
  const t0 = Date.now();
  const [basic, sm, df, ed, st, en] = await Promise.all([
    loadTeamBasic(teamId),
    computeSeriesMomentum(teamId),
    computeDynamicForm(teamId),
    computeEloDecomp(teamId),
    computeTeamStyles(teamId),
    computeEntropy(teamId),
  ]);
  const sectionsAvailable = [sm, df, ed, st, en].filter(x => x !== null).length;
  return {
    teamId,
    teamName: basic?.name ?? null,
    teamRating: basic?.rating ?? null,
    seriesMomentum: sm,
    dynamicForm: df,
    eloDecomp: ed,
    styles: st,
    entropy: en,
    sectionsAvailable,
    computedMs: Date.now() - t0,
  };
}
