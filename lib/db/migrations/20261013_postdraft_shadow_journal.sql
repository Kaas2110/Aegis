BEGIN;
-- A separate phase-specific journal keeps the existing268-feature live candidate
-- and its metrics unchanged. DB statement timestamps are not event timestamps.
CREATE TABLE IF NOT EXISTS postdraft_shadow_requests (
  id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
  observation_id text NOT NULL REFERENCES live_observation_journal(id),
  match_id bigint NOT NULL CHECK(match_id>0),
  candidate_id text NOT NULL,
  candidate_hash text NOT NULL CHECK(candidate_hash ~ '^[a-f0-9]{64}$'),
  model_hash text NOT NULL CHECK(model_hash ~ '^[a-f0-9]{64}$'),
  phase text NOT NULL CHECK(phase IN('pre_draft','post_draft','live')),
  game_time_sec integer NOT NULL CHECK(game_time_sec BETWEEN -3600 AND 59),
  draft_fingerprint text CHECK(draft_fingerprint IS NULL OR draft_fingerprint ~ '^[a-f0-9]{64}$'),
  source_input_hash text NOT NULL CHECK(source_input_hash ~ '^[a-f0-9]{64}$'),
  source_schema_hash text NOT NULL CHECK(source_schema_hash ~ '^[a-f0-9]{64}$'),
  request_body_sha256 text NOT NULL CHECK(request_body_sha256 ~ '^[a-f0-9]{64}$'),
  dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome_known_at_capture boolean,
  outcome_known_at_dispatch boolean,
  request_body jsonb NOT NULL CHECK(jsonb_typeof(request_body)='object'),
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  CHECK((game_time_sec<0 AND phase IN('pre_draft','post_draft')) OR (game_time_sec>=0 AND phase='live')),
  CONSTRAINT postdraft_shadow_requests_observation_candidate_idx UNIQUE(observation_id,candidate_hash)
);
CREATE INDEX IF NOT EXISTS postdraft_shadow_requests_match_time_idx
  ON postdraft_shadow_requests(match_id,dispatched_at);
CREATE TABLE IF NOT EXISTS postdraft_shadow_results (
  request_id text PRIMARY KEY REFERENCES postdraft_shadow_requests(id),
  phase text NOT NULL DEFAULT 'postdraft' CHECK(phase='postdraft'),
  status text NOT NULL CHECK(status IN('predicted','unavailable','error')),
  reason text,
  completed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome_known_at_finish boolean,
  before_local_outcome_at_checks boolean,
  response jsonb CHECK(response IS NULL OR jsonb_typeof(response)='object'),
  assessment jsonb NOT NULL CHECK(jsonb_typeof(assessment)='object'),
  CHECK((status='predicted' AND response IS NOT NULL AND reason IS NULL)
    OR (status<>'predicted' AND reason IS NOT NULL AND length(reason) BETWEEN 1 AND 200)),
  CHECK(status<>'predicted' OR
    (jsonb_typeof(response->'rawProbability')='number' AND (response->>'rawProbability')::numeric BETWEEN 0 AND 1) IS TRUE),
  CHECK(outcome_known_at_finish IS NOT TRUE OR status<>'predicted'),
  CHECK(outcome_known_at_finish IS NOT TRUE OR response IS NULL
    OR coalesce(jsonb_typeof(response->'rawProbability'),'null')='null'),
  CHECK(before_local_outcome_at_checks IS NOT TRUE OR status='predicted'),
  CHECK((assessment->>'eligibleForServing'='false') IS TRUE),
  CHECK((assessment->>'eligibleForPromotion'='false') IS TRUE),
  CHECK((assessment->>'prospectiveValidated'='false') IS TRUE),
  CHECK((assessment->>'eventLatencyVerified'='false') IS TRUE),
  CHECK((assessment->>'meetsVerifiedLiveLatencyPolicy'='false') IS TRUE),
  CHECK((jsonb_typeof(assessment->'measuredEndToEndLatencySeconds')='null') IS TRUE)
);
-- Keep unknown capture/dispatch/finish checks unknown. A false value means an
-- actual negative DB check, never an unavailable query or implicit JS coercion.
CREATE OR REPLACE FUNCTION check_postdraft_shadow_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q postdraft_shadow_requests%ROWTYPE; expected_before boolean;
BEGIN
  SELECT * INTO STRICT q FROM postdraft_shadow_requests WHERE id=NEW.request_id;
  expected_before:=CASE WHEN q.outcome_known_at_capture IS NULL OR q.outcome_known_at_dispatch IS NULL
    OR NEW.outcome_known_at_finish IS NULL THEN NULL ELSE
    (NEW.status='predicted' AND NOT q.outcome_known_at_capture AND NOT q.outcome_known_at_dispatch
      AND NOT NEW.outcome_known_at_finish) END;
  IF NEW.before_local_outcome_at_checks IS DISTINCT FROM expected_before THEN
    RAISE EXCEPTION 'postdraft before-outcome assessment does not match recorded checks';
  END IF;
  IF (q.outcome_known_at_capture IS TRUE OR q.outcome_known_at_dispatch IS TRUE)
    AND (NEW.status='predicted' OR (NEW.response IS NOT NULL
      AND coalesce(jsonb_typeof(NEW.response->'rawProbability'),'null')<>'null')) THEN
    RAISE EXCEPTION 'postdraft outcome already known; probability must be withheld';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS postdraft_shadow_result_checks ON postdraft_shadow_results;
CREATE TRIGGER postdraft_shadow_result_checks BEFORE INSERT ON postdraft_shadow_results
  FOR EACH ROW EXECUTE FUNCTION check_postdraft_shadow_result();
CREATE OR REPLACE FUNCTION reject_postdraft_shadow_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'postdraft shadow evidence is append-only'; END $$;
DROP TRIGGER IF EXISTS postdraft_shadow_requests_append_only ON postdraft_shadow_requests;
CREATE TRIGGER postdraft_shadow_requests_append_only BEFORE UPDATE OR DELETE
  ON postdraft_shadow_requests FOR EACH ROW EXECUTE FUNCTION reject_postdraft_shadow_mutation();
DROP TRIGGER IF EXISTS postdraft_shadow_results_append_only ON postdraft_shadow_results;
CREATE TRIGGER postdraft_shadow_results_append_only BEFORE UPDATE OR DELETE
  ON postdraft_shadow_results FOR EACH ROW EXECUTE FUNCTION reject_postdraft_shadow_mutation();
DROP TRIGGER IF EXISTS postdraft_shadow_requests_no_truncate ON postdraft_shadow_requests;
CREATE TRIGGER postdraft_shadow_requests_no_truncate BEFORE TRUNCATE ON postdraft_shadow_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_postdraft_shadow_mutation();
DROP TRIGGER IF EXISTS postdraft_shadow_results_no_truncate ON postdraft_shadow_results;
CREATE TRIGGER postdraft_shadow_results_no_truncate BEFORE TRUNCATE ON postdraft_shadow_results
  FOR EACH STATEMENT EXECUTE FUNCTION reject_postdraft_shadow_mutation();
COMMIT;
