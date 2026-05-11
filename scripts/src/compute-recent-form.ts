/**
 * Wave 3: пересчёт недавней формы команд из pro_matches.
 * SQL-only, никаких внешних API. Запускается быстро (<10s).
 *
 * Считает за окна 30 и 90 дней:
 *  - games, wins, winRate
 *  - avgKillsFor, avgKillsAgainst (radiant_score / dire_score)
 *  - avgDurationSec
 *
 * Запуск: pnpm --filter @workspace/scripts run compute:recent-form
 */

import { db, teamRecentFormTable } from '@workspace/db';
import { sql } from 'drizzle-orm';

const PERIODS = [30, 90];

async function recomputeForPeriod(days: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  // Объединяем radiant + dire выступления каждой команды в один union-all,
  // потом группируем.
  await db.execute(sql`
    INSERT INTO team_recent_form (team_id, period_days, games, wins, win_rate,
      avg_kills_for, avg_kills_against, avg_duration_sec, computed_at)
    SELECT team_id,
           ${days}::int AS period_days,
           COUNT(*)::int AS games,
           SUM(CASE WHEN win THEN 1 ELSE 0 END)::int AS wins,
           (SUM(CASE WHEN win THEN 1.0 ELSE 0 END) / COUNT(*))::real AS win_rate,
           AVG(kills_for)::real AS avg_kills_for,
           AVG(kills_against)::real AS avg_kills_against,
           AVG(duration)::real AS avg_duration_sec,
           NOW() AS computed_at
      FROM (
        SELECT radiant_team_id AS team_id,
               radiant_win AS win,
               COALESCE(radiant_score, 0) AS kills_for,
               COALESCE(dire_score, 0) AS kills_against,
               duration
          FROM pro_matches
         WHERE start_time >= ${cutoff} AND radiant_team_id IS NOT NULL
        UNION ALL
        SELECT dire_team_id AS team_id,
               (NOT radiant_win) AS win,
               COALESCE(dire_score, 0) AS kills_for,
               COALESCE(radiant_score, 0) AS kills_against,
               duration
          FROM pro_matches
         WHERE start_time >= ${cutoff} AND dire_team_id IS NOT NULL
      ) m
     GROUP BY team_id
        ON CONFLICT (team_id, period_days) DO UPDATE SET
            games = EXCLUDED.games,
            wins = EXCLUDED.wins,
            win_rate = EXCLUDED.win_rate,
            avg_kills_for = EXCLUDED.avg_kills_for,
            avg_kills_against = EXCLUDED.avg_kills_against,
            avg_duration_sec = EXCLUDED.avg_duration_sec,
            computed_at = NOW()
  `);
  const r = await db.execute(sql`SELECT COUNT(*)::int AS c FROM team_recent_form WHERE period_days = ${days}`);
  return Number((r.rows[0] as { c: number }).c);
}

async function main() {
  console.log('[compute-recent-form] Recomputing …');
  for (const d of PERIODS) {
    const n = await recomputeForPeriod(d);
    console.log(`  period=${d}d → ${n} teams`);
  }
  console.log('[compute-recent-form] Done.');
  process.exit(0);
}

main().catch(err => {
  console.error('[compute-recent-form] FATAL', err);
  process.exit(1);
});
