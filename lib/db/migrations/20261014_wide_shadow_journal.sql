BEGIN;
CREATE TABLE IF NOT EXISTS wide_shadow_attempts (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 observation_id text NOT NULL REFERENCES live_observation_journal(id),
 match_id bigint NOT NULL CHECK(match_id>0),
 candidate_hash text NOT NULL CHECK(candidate_hash ~ '^[a-f0-9]{64}$'),
 model_hash text NOT NULL CHECK(model_hash ~ '^[a-f0-9]{64}$'),
 operation text NOT NULL CHECK(operation IN('anchor','predict','unsupported')),
 game_time_sec integer,
 source_input_hash text NOT NULL CHECK(source_input_hash ~ '^[a-f0-9]{64}$'),
 source_schema_hash text NOT NULL CHECK(source_schema_hash ~ '^[a-f0-9]{64}$'),
 outcome_known_at_capture boolean,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 UNIQUE(observation_id,candidate_hash)
);
CREATE INDEX IF NOT EXISTS wide_shadow_attempts_match_time_idx ON wide_shadow_attempts(match_id,created_at);
CREATE TABLE IF NOT EXISTS wide_shadow_dispatches (
 attempt_id text PRIMARY KEY REFERENCES wide_shadow_attempts(id),
 dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome_known_at_read boolean,
 outcome_known_at_dispatch boolean,
 request_body text NOT NULL CHECK(octet_length(request_body)<=16777216),
 request_body_sha256 text NOT NULL CHECK(request_body_sha256 ~ '^[a-f0-9]{64}$'),
 reader_provenance jsonb NOT NULL CHECK(jsonb_typeof(reader_provenance)='object')
);
CREATE TABLE IF NOT EXISTS wide_shadow_results (
 attempt_id text PRIMARY KEY REFERENCES wide_shadow_attempts(id),
 status text NOT NULL CHECK(status IN('anchor_ready','predicted','unavailable')),
 reason text,
 completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome_known_at_finish boolean,
 before_local_outcome_at_checks boolean,
 response jsonb CHECK(response IS NULL OR jsonb_typeof(response)='object'),
 response_hash text CHECK(response_hash IS NULL OR response_hash ~ '^[a-f0-9]{64}$'),
 assessment jsonb NOT NULL CHECK(jsonb_typeof(assessment)='object'),
 CHECK((response IS NULL)=(response_hash IS NULL)),
 CHECK((status IN('anchor_ready','predicted') AND reason IS NULL AND response IS NOT NULL)
  OR(status='unavailable' AND length(reason) BETWEEN 1 AND 200 AND response IS NULL)),
 CHECK((assessment->'active'='false'::jsonb AND assessment->'eligibleForServing'='false'::jsonb
  AND assessment->'eligibleForPromotion'='false'::jsonb AND assessment->'eligibleForQualityClaims'='false'::jsonb
  AND assessment->'eligibleForProspectiveEvaluation'='false'::jsonb AND assessment->'prospectiveValidated'='false'::jsonb
  AND assessment->'eventLatencyVerified'='false'::jsonb AND assessment->'coverage95Validated'='false'::jsonb
  AND assessment->'meetsVerifiedLiveLatencyPolicy'='false'::jsonb
  AND assessment->'measuredEndToEndLatencySeconds'='null'::jsonb) IS TRUE)
);
CREATE OR REPLACE FUNCTION wide_shadow_check_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o live_observation_journal%ROWTYPE; captured boolean;
BEGIN
 SELECT * INTO STRICT o FROM live_observation_journal WHERE id=NEW.observation_id;
 captured:=CASE WHEN o.availability->'outcomeKnownAtCapture'='true'::jsonb THEN true
  WHEN o.availability->'outcomeKnownAtCapture'='false'::jsonb THEN false ELSE null END;
 IF NEW.match_id IS DISTINCT FROM o.match_id OR NEW.game_time_sec IS DISTINCT FROM o.game_time_sec
  OR NEW.source_input_hash IS DISTINCT FROM o.input_hash OR NEW.source_schema_hash IS DISTINCT FROM o.schema_hash
  OR NEW.outcome_known_at_capture IS DISTINCT FROM captured THEN RAISE EXCEPTION 'wide source attempt mismatch'; END IF;
 IF NEW.operation IS DISTINCT FROM (CASE WHEN o.game_time_sec BETWEEN -3600 AND 59 THEN 'anchor'
  WHEN o.game_time_sec BETWEEN 300 AND 6600 THEN 'predict' ELSE 'unsupported' END) THEN
  RAISE EXCEPTION 'wide phase mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION wide_shadow_check_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a wide_shadow_attempts%ROWTYPE; b jsonb;
BEGIN
 SELECT * INTO STRICT a FROM wide_shadow_attempts WHERE id=NEW.attempt_id;
 b:=NEW.request_body::jsonb;
 IF NEW.request_body_sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.request_body,'UTF8')),'hex')
  OR NEW.reader_provenance IS DISTINCT FROM b->'reader'->'provenance' THEN RAISE EXCEPTION 'wide request byte/provenance mismatch'; END IF;
 IF (b->>'dispatchId'=a.id AND b->>'operation'=a.operation AND (b->>'expectedMatchId')::bigint=a.match_id
  AND b->>'candidateManifestSha256'=a.candidate_hash AND b->'outcomeKnownAtDispatch'='false'::jsonb
  AND b->'reader'->'captureOutcomeKnown'='false'::jsonb AND b->'reader'->'outcomeKnownAtRead'='false'::jsonb
  AND b->'reader'->'current'->>'id'=a.observation_id
  AND b->'reader'->'current'->>'input_hash'=a.source_input_hash
  AND b->'reader'->'current'->>'schema_hash'=a.source_schema_hash) IS DISTINCT FROM TRUE
  OR a.outcome_known_at_capture IS DISTINCT FROM FALSE OR NEW.outcome_known_at_read IS DISTINCT FROM FALSE
  OR NEW.outcome_known_at_dispatch IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'wide dispatch binding mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION wide_shadow_check_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a wide_shadow_attempts%ROWTYPE; d wide_shadow_dispatches%ROWTYPE; o live_observation_journal%ROWTYPE; expected_before boolean; success boolean; r jsonb;
BEGIN
 SELECT * INTO STRICT a FROM wide_shadow_attempts WHERE id=NEW.attempt_id;
 SELECT * INTO d FROM wide_shadow_dispatches WHERE attempt_id=NEW.attempt_id;
 success:=NEW.status IN('anchor_ready','predicted');
 expected_before:=CASE WHEN a.outcome_known_at_capture IS NULL OR d.outcome_known_at_read IS NULL
  OR d.outcome_known_at_dispatch IS NULL OR NEW.outcome_known_at_finish IS NULL THEN NULL
  ELSE NOT a.outcome_known_at_capture AND NOT d.outcome_known_at_read
   AND NOT d.outcome_known_at_dispatch AND NOT NEW.outcome_known_at_finish END;
 IF NEW.before_local_outcome_at_checks IS DISTINCT FROM expected_before THEN RAISE EXCEPTION 'wide outcome assessment mismatch'; END IF;
 IF success AND expected_before IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'wide success requires all known false outcomes'; END IF;
 IF success THEN
  SELECT * INTO STRICT o FROM live_observation_journal WHERE id=a.observation_id;
  IF (o.received_at<=o.recorded_at AND o.recorded_at<=d.dispatched_at AND d.dispatched_at<=NEW.completed_at
   AND NEW.completed_at-o.received_at<=interval '180 seconds') IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION 'wide success requires current local receipt'; END IF;
  r:=NEW.response;
  IF ((r->>'dispatchId'=a.id) AND (r->>'candidateManifestSha256'=a.candidate_hash)
   AND (r->>'requestBodySha256'=d.request_body_sha256)
   AND (r->>'status'=CASE WHEN NEW.status='predicted' THEN 'shadow_predicted' ELSE 'anchor_ready' END)
   AND r->'active'='false'::jsonb AND r->'eligibleForServing'='false'::jsonb
   AND r->'eligibleForPromotion'='false'::jsonb AND r->'eligibleForQualityClaims'='false'::jsonb
   AND r->'eligibleForProspectiveEvaluation'='false'::jsonb AND r->'prospectiveValidated'='false'::jsonb
   AND r->'eventLatencyVerified'='false'::jsonb AND r->'coverage95Validated'='false'::jsonb
   AND r->'meetsVerifiedLiveLatencyPolicy'='false'::jsonb AND r->'measuredEndToEndLatencySeconds'='null'::jsonb) IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION 'wide response contract mismatch'; END IF;
  IF NEW.status='predicted' AND (a.operation='predict' AND r->'prediction'->>'modelSha256'=a.model_hash) IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION 'wide model mismatch'; END IF;
  IF NEW.status='anchor_ready' AND (a.operation='anchor' AND r->'prediction'='null'::jsonb) IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION 'wide anchor is not a prediction'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reject_wide_shadow_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'wide shadow evidence is append-only'; END $$;
DROP TRIGGER IF EXISTS wide_shadow_attempt_check ON wide_shadow_attempts;
CREATE TRIGGER wide_shadow_attempt_check BEFORE INSERT ON wide_shadow_attempts FOR EACH ROW EXECUTE FUNCTION wide_shadow_check_attempt();
DROP TRIGGER IF EXISTS wide_shadow_dispatch_check ON wide_shadow_dispatches;
CREATE TRIGGER wide_shadow_dispatch_check BEFORE INSERT ON wide_shadow_dispatches FOR EACH ROW EXECUTE FUNCTION wide_shadow_check_dispatch();
DROP TRIGGER IF EXISTS wide_shadow_result_check ON wide_shadow_results;
CREATE TRIGGER wide_shadow_result_check BEFORE INSERT ON wide_shadow_results FOR EACH ROW EXECUTE FUNCTION wide_shadow_check_result();
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['wide_shadow_attempts','wide_shadow_dispatches','wide_shadow_results'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS wide_shadow_immutable ON %I',name);
  EXECUTE format('CREATE TRIGGER wide_shadow_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_wide_shadow_mutation()',name);
 END LOOP;
END $$;
COMMIT;
