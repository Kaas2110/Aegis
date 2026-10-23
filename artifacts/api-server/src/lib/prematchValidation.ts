import { sql } from 'drizzle-orm';

/**
 * One policy for every displayed prematch quality metric. Provider game clock
 * alone is insufficient: delayed pre-game telemetry may arrive after kickoff.
 * No timestamp is inferred from game_time, predicted_at or a scheduled match.
 * The resolved start stamp is written only by OutcomeTracker from /matches/id.
 */
export const PREMATCH_VALIDATION_CTE = `WITH prematch_evidence AS (
  SELECT po.*,
    CASE WHEN jsonb_typeof(po.features->'__observed_game_time_sec') = 'number'
      THEN (po.features->>'__observed_game_time_sec')::numeric END AS observed_clock,
    CASE WHEN jsonb_typeof(po.features->'__source_received_unix') = 'number'
      THEN (po.features->>'__source_received_unix')::numeric END AS received_unix,
    CASE WHEN pm.start_time > 0 AND pm.start_time <= EXTRACT(EPOCH FROM now())
      THEN pm.start_time::numeric END AS history_start,
    CASE WHEN jsonb_typeof(po.features->'__resolved_start_time_unix') = 'number'
      THEN (po.features->>'__resolved_start_time_unix')::numeric END AS resolved_start,
    pm.radiant_win AS history_winner
  FROM prematch_outcomes po
  LEFT JOIN pro_matches pm ON pm.match_id = po.match_id
), prematch_starts AS (
  SELECT *, COALESCE(history_start,
    CASE WHEN resolved_start > 0 AND resolved_start <= EXTRACT(EPOCH FROM now())
      THEN resolved_start END) AS verified_start_unix
  FROM prematch_evidence
), prematch_validation AS (
  SELECT *, CASE
    WHEN observed_clock IS NULL OR received_unix IS NULL THEN 'missing_observation_provenance'
    WHEN observed_clock >= 0 THEN 'observed_after_start'
    WHEN received_unix <= 0 THEN 'invalid_received_time'
    WHEN NOT (predicted_radiant_win_prob BETWEEN 0 AND 1) THEN 'invalid_probability'
    WHEN verified_start_unix IS NULL THEN 'start_time_unknown'
    WHEN history_start IS NOT NULL AND resolved_start > 0
      AND history_start <> resolved_start THEN 'conflicting_start_time'
    WHEN received_unix >= verified_start_unix OR EXTRACT(EPOCH FROM predicted_at) >= verified_start_unix
      THEN 'prediction_after_actual_start'
    WHEN received_unix > EXTRACT(EPOCH FROM predicted_at) THEN 'observation_after_prediction'
    WHEN actual_radiant_win IS NOT NULL AND history_winner IS NOT NULL
      AND actual_radiant_win <> history_winner THEN 'conflicting_result'
    ELSE 'validated' END AS validation_reason
  FROM prematch_starts
)`;

export const prematchValidationCte = () => sql.raw(PREMATCH_VALIDATION_CTE);
export const PREMATCH_VALIDATION_POLICY = 'observed-negative-clock-and-arrival-and-prediction-before-verified-start-v1';
export const PREMATCH_VALIDATION_NOTE = 'Качество рассчитано только по прогнозам, получение данных и создание которых подтверждены до фактического старта. Остальные записи исключены; это не подтверждение доходности или отсутствия утечек при обучении модели.';
