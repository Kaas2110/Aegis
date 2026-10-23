BEGIN;
-- These timestamps establish DB statement/check boundaries, not provider event time
-- or the exact wall-clock moment of transaction commit.
CREATE TABLE IF NOT EXISTS live_shadow_requests (
  id text PRIMARY KEY,
  observation_id text NOT NULL REFERENCES live_observation_journal(id),
  match_id bigint NOT NULL,
  candidate_id text NOT NULL,
  candidate_hash text NOT NULL,
  model_hash text NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome_known_at_dispatch boolean NOT NULL,
  request_body jsonb NOT NULL,
  evidence jsonb NOT NULL,
  CONSTRAINT live_shadow_requests_observation_candidate_idx UNIQUE (observation_id, candidate_hash)
);
CREATE INDEX IF NOT EXISTS live_shadow_requests_match_time_idx
  ON live_shadow_requests(match_id, dispatched_at);
CREATE TABLE IF NOT EXISTS live_shadow_results (
  request_id text PRIMARY KEY REFERENCES live_shadow_requests(id),
  status text NOT NULL CHECK (status IN ('predicted','unavailable','error')),
  reason text,
  completed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome_known_at_finish boolean NOT NULL,
  before_local_outcome_at_checks boolean NOT NULL,
  response jsonb,
  assessment jsonb NOT NULL,
  CHECK ((status='predicted' AND response IS NOT NULL AND reason IS NULL)
    OR (status<>'predicted' AND reason IS NOT NULL)),
  CHECK (NOT before_local_outcome_at_checks OR status='predicted'),
  CHECK ((assessment->>'eligibleForServing'='false') IS TRUE),
  CHECK ((assessment->>'eligibleForPromotion'='false') IS TRUE),
  CHECK ((assessment->>'meetsVerifiedLiveLatencyPolicy'='false') IS TRUE)
);
-- A failed or interrupted request remains visible without a result. No replay
-- worker can overwrite it with a forecast produced after the outcome is known.
CREATE OR REPLACE FUNCTION reject_live_shadow_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'live shadow evidence is append-only';
END $$;
DROP TRIGGER IF EXISTS live_shadow_requests_append_only ON live_shadow_requests;
CREATE TRIGGER live_shadow_requests_append_only BEFORE UPDATE OR DELETE
  ON live_shadow_requests FOR EACH ROW EXECUTE FUNCTION reject_live_shadow_mutation();
DROP TRIGGER IF EXISTS live_shadow_results_append_only ON live_shadow_results;
CREATE TRIGGER live_shadow_results_append_only BEFORE UPDATE OR DELETE
  ON live_shadow_results FOR EACH ROW EXECUTE FUNCTION reject_live_shadow_mutation();
DROP TRIGGER IF EXISTS live_shadow_requests_no_truncate ON live_shadow_requests;
CREATE TRIGGER live_shadow_requests_no_truncate BEFORE TRUNCATE
  ON live_shadow_requests FOR EACH STATEMENT EXECUTE FUNCTION reject_live_shadow_mutation();
DROP TRIGGER IF EXISTS live_shadow_results_no_truncate ON live_shadow_results;
CREATE TRIGGER live_shadow_results_no_truncate BEFORE TRUNCATE
  ON live_shadow_results FOR EACH STATEMENT EXECUTE FUNCTION reject_live_shadow_mutation();
COMMIT;
