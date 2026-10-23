import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { PREMATCH_VALIDATION_CTE } from './prematchValidation';

test('PostgreSQL fixtures exclude late, legacy, malformed and conflicting observations from quality', { skip: !process.env.PREMATCH_TEST_DATABASE_URL }, async () => {
  const require = createRequire(import.meta.url);
  const pg = createRequire(require.resolve('@workspace/db'))('pg');
  const schema = `prematch_validation_test_${Date.now()}_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.PREMATCH_TEST_DATABASE_URL, max: 1 });
  let pool: any;
  const START = 1_700_000_000;
  const evidence = { __observed_game_time_sec: -120, __source_received_unix: START - 120 };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: process.env.PREMATCH_TEST_DATABASE_URL, max: 1, options: `-c search_path=${schema}` });
    await pool.query('CREATE TABLE pro_matches (match_id bigint PRIMARY KEY, start_time bigint, radiant_win boolean)');
    await pool.query('CREATE TABLE prematch_outcomes (match_id bigint PRIMARY KEY, predicted_at timestamptz NOT NULL, features jsonb, predicted_radiant_win_prob real NOT NULL, actual_radiant_win boolean)');

    async function insert(id: number, expected: string, overrides: { features?: unknown; predictedAt?: number; probability?: number | string; actual?: boolean; start?: number | null; historyWinner?: boolean } = {}) {
      await pool.query('INSERT INTO prematch_outcomes VALUES ($1, to_timestamp($2), $3::jsonb, $4, $5)', [id, overrides.predictedAt ?? START - 60, JSON.stringify('features' in overrides ? overrides.features : evidence), overrides.probability ?? 0.8, overrides.actual ?? true]);
      if (overrides.start !== null) await pool.query('INSERT INTO pro_matches VALUES ($1,$2,$3)', [id, overrides.start ?? START, overrides.historyWinner ?? true]);
      const result = await pool.query(`${PREMATCH_VALIDATION_CTE} SELECT validation_reason FROM prematch_validation WHERE match_id=$1`, [id]);
      assert.equal(result.rows[0].validation_reason, expected, `fixture ${id}`);
    }

    await insert(1, 'validated');
    await insert(2, 'validated', { start: null, actual: false, features: { ...evidence, __resolved_start_time_unix: START } });
    await insert(3, 'missing_observation_provenance', { features: {}, probability: 1 });
    await insert(4, 'start_time_unknown', { start: null });
    await insert(5, 'prediction_after_actual_start', { predictedAt: START + 1 });
    await insert(6, 'prediction_after_actual_start', { features: { ...evidence, __source_received_unix: START + 1 }, predictedAt: START + 2 });
    await insert(7, 'observed_after_start', { features: { ...evidence, __observed_game_time_sec: 0 } });
    await insert(8, 'observation_after_prediction', { predictedAt: START - 130 });
    await insert(9, 'missing_observation_provenance', { features: { ...evidence, __observed_game_time_sec: '-120' } });
    await insert(10, 'conflicting_result', { actual: false });
    await insert(11, 'conflicting_start_time', { features: { ...evidence, __resolved_start_time_unix: START + 2 } });
    await insert(12, 'start_time_unknown', { start: -1 });
    await insert(13, 'invalid_probability', { probability: 1.5 });
    await insert(14, 'invalid_probability', { probability: 'NaN' });
    await insert(15, 'missing_observation_provenance', { features: { ...evidence, __source_received_unix: { invalid: true } } });
    await insert(16, 'prediction_after_actual_start', { predictedAt: START });
    await insert(17, 'invalid_received_time', { features: { ...evidence, __source_received_unix: 0 } });
    await insert(18, 'start_time_unknown', { start: null, features: { ...evidence, __resolved_start_time_unix: 'not-a-date' } });

    const quality = await pool.query(`${PREMATCH_VALIDATION_CTE}
      SELECT COUNT(*)::int AS count,
        AVG(CASE WHEN (predicted_radiant_win_prob >= .5) = actual_radiant_win THEN 1.0 ELSE 0.0 END)::float AS accuracy,
        AVG(POWER(predicted_radiant_win_prob - CASE WHEN actual_radiant_win THEN 1 ELSE 0 END,2))::float AS brier
      FROM prematch_validation WHERE validation_reason='validated' AND actual_radiant_win IS NOT NULL`);
    assert.equal(quality.rows[0].count, 2);
    assert.equal(quality.rows[0].accuracy, 0.5);
    assert.ok(Math.abs(quality.rows[0].brier - 0.34) < 0.00001);
    const excluded = await pool.query(`${PREMATCH_VALIDATION_CTE} SELECT COUNT(*)::int AS count FROM prematch_validation WHERE validation_reason<>'validated'`);
    assert.equal(excluded.rows[0].count, 16);
    const empty = await pool.query(`${PREMATCH_VALIDATION_CTE} SELECT AVG(predicted_radiant_win_prob)::float AS quality FROM prematch_validation WHERE validation_reason='validated' AND match_id>2`);
    assert.equal(empty.rows[0].quality, null);
    // Re-reading never repairs evidence or rewrites legacy rows implicitly.
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM prematch_outcomes')).rows[0].count, 18);
    assert.deepEqual((await pool.query('SELECT features FROM prematch_outcomes WHERE match_id=3')).rows[0].features, {});
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
