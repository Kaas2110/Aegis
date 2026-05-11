/**
 * Wave 3: head-to-head таблица команд из pro_matches.
 * SQL-only. Период по умолчанию — 365 дней.
 *
 * Хранит каноническую пару (low, high) по teamId; winsLow = победы команды
 * с меньшим teamId. На lookup'е inference считает направление.
 *
 * Запуск: pnpm --filter @workspace/scripts run compute:h2h
 */

import { db, teamH2HTable } from '@workspace/db';
import { sql } from 'drizzle-orm';

const PERIOD_DAYS = 365;

async function main() {
  const cutoff = Math.floor(Date.now() / 1000) - PERIOD_DAYS * 86400;
  console.log(`[compute-h2h] Recomputing for last ${PERIOD_DAYS}d …`);

  await db.execute(sql`
    INSERT INTO team_h2h (team_low_id, team_high_id, period_days, games, wins_low, computed_at)
    SELECT LEAST(radiant_team_id, dire_team_id) AS team_low_id,
           GREATEST(radiant_team_id, dire_team_id) AS team_high_id,
           ${PERIOD_DAYS}::int AS period_days,
           COUNT(*)::int AS games,
           SUM(CASE
                 WHEN (radiant_team_id < dire_team_id AND radiant_win) OR
                      (dire_team_id < radiant_team_id AND NOT radiant_win)
                 THEN 1 ELSE 0
               END)::int AS wins_low,
           NOW() AS computed_at
      FROM pro_matches
     WHERE start_time >= ${cutoff}
       AND radiant_team_id IS NOT NULL
       AND dire_team_id IS NOT NULL
       AND radiant_team_id <> dire_team_id
     GROUP BY 1, 2
        ON CONFLICT (team_low_id, team_high_id, period_days) DO UPDATE SET
            games = EXCLUDED.games,
            wins_low = EXCLUDED.wins_low,
            computed_at = NOW()
  `);
  const r = await db.execute(sql`SELECT COUNT(*)::int AS c FROM team_h2h WHERE period_days = ${PERIOD_DAYS}`);
  console.log(`[compute-h2h] Done. ${(r.rows[0] as { c: number }).c} pairs.`);
  process.exit(0);
}

main().catch(err => {
  console.error('[compute-h2h] FATAL', err);
  process.exit(1);
});
