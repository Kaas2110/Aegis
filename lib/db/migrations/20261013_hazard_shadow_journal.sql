BEGIN;
-- Separate diagnostic candidate and own grid; never the public predictions table.
CREATE TABLE IF NOT EXISTS hazard_shadow_requests (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 observation_id text NOT NULL REFERENCES live_observation_journal(id),
 match_id bigint NOT NULL CHECK(match_id>0),
 candidate_id text NOT NULL,
 candidate_hash text NOT NULL CHECK(candidate_hash ~ '^[a-f0-9]{64}$'),
 kills_model_hash text NOT NULL CHECK(kills_model_hash ~ '^[a-f0-9]{64}$'),
 duration_model_hash text NOT NULL CHECK(duration_model_hash ~ '^[a-f0-9]{64}$'),
 phase text NOT NULL CHECK(phase='live'),
 game_time_sec integer NOT NULL CHECK(game_time_sec BETWEEN 300 AND 4500),
 line_profile text NOT NULL CHECK(line_profile='observed-offset-grid-v1'),
 line_grid_hash text NOT NULL CHECK(line_grid_hash ~ '^[a-f0-9]{64}$'),
 source_input_hash text NOT NULL CHECK(source_input_hash ~ '^[a-f0-9]{64}$'),
 source_schema_hash text NOT NULL CHECK(source_schema_hash ~ '^[a-f0-9]{64}$'),
 request_body_sha256 text NOT NULL CHECK(request_body_sha256 ~ '^[a-f0-9]{64}$'),
 dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome_known_at_capture boolean,
 outcome_known_at_dispatch boolean,
 request_body jsonb NOT NULL CHECK(jsonb_typeof(request_body)='object'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 CHECK((request_body->>'lineSource'='own_diagnostic_grid') IS TRUE),
 CONSTRAINT hazard_shadow_requests_observation_candidate_grid_idx UNIQUE(observation_id,candidate_hash,line_grid_hash)
);
CREATE INDEX IF NOT EXISTS hazard_shadow_requests_match_time_idx ON hazard_shadow_requests(match_id,dispatched_at);
CREATE TABLE IF NOT EXISTS hazard_shadow_results (
 request_id text PRIMARY KEY REFERENCES hazard_shadow_requests(id),
 phase text NOT NULL DEFAULT 'live' CHECK(phase='live'),
 status text NOT NULL CHECK(status IN('predicted','unavailable','error')),
 reason text,
 completed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome_known_at_finish boolean,
 before_local_outcome_at_checks boolean,
 response jsonb CHECK(response IS NULL OR jsonb_typeof(response)='object'),
 response_hash text CHECK(response_hash IS NULL OR response_hash ~ '^[a-f0-9]{64}$'),
 assessment jsonb NOT NULL CHECK(jsonb_typeof(assessment)='object'),
 CHECK((response IS NULL)=(response_hash IS NULL)),
 CHECK((status='predicted' AND response IS NOT NULL AND reason IS NULL)
   OR (status<>'predicted' AND reason IS NOT NULL AND length(reason) BETWEEN 1 AND 200)),
 CHECK(status<>'predicted' OR (response->>'status'='shadow_predicted' AND jsonb_typeof(response->'diagnostic')='object') IS TRUE),
 CHECK(status='predicted' OR response IS NULL OR (jsonb_typeof(response->'diagnostic')='null') IS TRUE),
 CHECK(response IS NULL OR (
   response->>'active'='false' AND response->>'eligibleForServing'='false' AND response->>'eligibleForPromotion'='false'
   AND response->>'eligibleForQualityClaims'='false' AND response->>'eligibleForProspectiveEvaluation'='false'
   AND response->>'prospectiveValidated'='false' AND response->>'eventLatencyVerified'='false'
   AND response->>'meetsVerifiedLiveLatencyPolicy'='false' AND response->>'coverage95Validated'='false'
   AND jsonb_typeof(response->'measuredEndToEndLatencySeconds')='null') IS TRUE),
 CHECK((assessment->>'active'='false') IS TRUE),
 CHECK((assessment->>'eligibleForServing'='false') IS TRUE),
 CHECK((assessment->>'eligibleForPromotion'='false') IS TRUE),
 CHECK((assessment->>'eligibleForQualityClaims'='false') IS TRUE),
 CHECK((assessment->>'eligibleForProspectiveEvaluation'='false') IS TRUE),
 CHECK((assessment->>'prospectiveValidated'='false') IS TRUE),
 CHECK((assessment->>'eventLatencyVerified'='false') IS TRUE),
 CHECK((assessment->>'meetsVerifiedLiveLatencyPolicy'='false') IS TRUE),
 CHECK((assessment->>'coverage95Validated'='false') IS TRUE),
 CHECK((jsonb_typeof(assessment->'measuredEndToEndLatencySeconds')='null') IS TRUE)
);
CREATE OR REPLACE FUNCTION check_hazard_shadow_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q hazard_shadow_requests%ROWTYPE; expected_before boolean; unverified boolean;
BEGIN
 SELECT * INTO STRICT q FROM hazard_shadow_requests WHERE id=NEW.request_id;
 unverified:=q.outcome_known_at_capture IS DISTINCT FROM FALSE OR q.outcome_known_at_dispatch IS DISTINCT FROM FALSE
   OR NEW.outcome_known_at_finish IS DISTINCT FROM FALSE;
 expected_before:=CASE WHEN q.outcome_known_at_capture IS NULL OR q.outcome_known_at_dispatch IS NULL
   OR NEW.outcome_known_at_finish IS NULL THEN NULL ELSE
   (NEW.status='predicted' AND NOT q.outcome_known_at_capture AND NOT q.outcome_known_at_dispatch AND NOT NEW.outcome_known_at_finish) END;
 IF NEW.before_local_outcome_at_checks IS DISTINCT FROM expected_before THEN
   RAISE EXCEPTION 'hazard before-outcome assessment contradicts recorded checks';
 END IF;
 IF unverified AND (NEW.status='predicted' OR NEW.response IS NOT NULL OR NEW.response_hash IS NOT NULL) THEN
   RAISE EXCEPTION 'hazard outcome known or unknown; entire response must be withheld';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hazard_shadow_result_checks ON hazard_shadow_results;
CREATE TRIGGER hazard_shadow_result_checks BEFORE INSERT ON hazard_shadow_results FOR EACH ROW EXECUTE FUNCTION check_hazard_shadow_result();
CREATE OR REPLACE FUNCTION reject_hazard_shadow_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'hazard shadow evidence is append-only'; END $$;
DROP TRIGGER IF EXISTS hazard_shadow_requests_append_only ON hazard_shadow_requests;
CREATE TRIGGER hazard_shadow_requests_append_only BEFORE UPDATE OR DELETE ON hazard_shadow_requests FOR EACH ROW EXECUTE FUNCTION reject_hazard_shadow_mutation();
DROP TRIGGER IF EXISTS hazard_shadow_results_append_only ON hazard_shadow_results;
CREATE TRIGGER hazard_shadow_results_append_only BEFORE UPDATE OR DELETE ON hazard_shadow_results FOR EACH ROW EXECUTE FUNCTION reject_hazard_shadow_mutation();
DROP TRIGGER IF EXISTS hazard_shadow_requests_no_truncate ON hazard_shadow_requests;
CREATE TRIGGER hazard_shadow_requests_no_truncate BEFORE TRUNCATE ON hazard_shadow_requests FOR EACH STATEMENT EXECUTE FUNCTION reject_hazard_shadow_mutation();
DROP TRIGGER IF EXISTS hazard_shadow_results_no_truncate ON hazard_shadow_results;
CREATE TRIGGER hazard_shadow_results_no_truncate BEFORE TRUNCATE ON hazard_shadow_results FOR EACH STATEMENT EXECUTE FUNCTION reject_hazard_shadow_mutation();
COMMIT;
