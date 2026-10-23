BEGIN;
CREATE TABLE IF NOT EXISTS live_coverage_operations (
  id text PRIMARY KEY, sequence numeric(20,0) NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),operation jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS live_coverage_events (
  id text PRIMARY KEY,operation_id text NOT NULL REFERENCES live_coverage_operations(id),
  kind text NOT NULL CHECK(kind IN ('plan','poll','scope_enter','scope_exit','expectations','map_poll','integrity_gap')),
  occurred_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  scope_id text,poll_id text,match_id bigint,detail jsonb NOT NULL,
  CHECK((detail->>'eventLatencyVerified'='false') IS TRUE),
  CHECK((detail->>'meetsVerifiedLiveLatencyPolicy'='false') IS TRUE)
);
CREATE INDEX IF NOT EXISTS live_coverage_events_kind_scope_idx ON live_coverage_events(kind,scope_id,occurred_at);
CREATE INDEX IF NOT EXISTS live_coverage_events_poll_idx ON live_coverage_events(poll_id,kind);
CREATE TABLE IF NOT EXISTS live_coverage_state (
  id text PRIMARY KEY,state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION reject_live_coverage_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'live coverage evidence is append-only'; END $$;
DROP TRIGGER IF EXISTS live_coverage_ops_append_only ON live_coverage_operations;
CREATE TRIGGER live_coverage_ops_append_only BEFORE UPDATE OR DELETE ON live_coverage_operations FOR EACH ROW EXECUTE FUNCTION reject_live_coverage_mutation();
DROP TRIGGER IF EXISTS live_coverage_events_append_only ON live_coverage_events;
CREATE TRIGGER live_coverage_events_append_only BEFORE UPDATE OR DELETE ON live_coverage_events FOR EACH ROW EXECUTE FUNCTION reject_live_coverage_mutation();
DROP TRIGGER IF EXISTS live_coverage_ops_no_truncate ON live_coverage_operations;
CREATE TRIGGER live_coverage_ops_no_truncate BEFORE TRUNCATE ON live_coverage_operations FOR EACH STATEMENT EXECUTE FUNCTION reject_live_coverage_mutation();
DROP TRIGGER IF EXISTS live_coverage_events_no_truncate ON live_coverage_events;
CREATE TRIGGER live_coverage_events_no_truncate BEFORE TRUNCATE ON live_coverage_events FOR EACH STATEMENT EXECUTE FUNCTION reject_live_coverage_mutation();
-- Segments compress the fixed 120-second opportunities; backoff cannot shrink them.
-- Due dates are planned deadlines, never invented provider event/receipt timestamps.
CREATE OR REPLACE VIEW live_coverage_expected_slots AS
SELECT e.id AS segment_id,e.scope_id,e.match_id,e.poll_id,
  (e.detail->>'firstDueAt')::bigint+g.n*(e.detail->>'cadenceMs')::bigint AS due_ms,
  (e.detail->>'responseWindowMs')::bigint AS window_ms,e.detail->>'origin' AS origin,
  e.detail->>'scheduleCause' AS schedule_cause,
  (e.detail->>'scheduledPollDueAt')::bigint AS scheduled_poll_due_ms
FROM live_coverage_events e CROSS JOIN LATERAL generate_series(0,(e.detail->>'count')::integer-1) g(n)
WHERE e.kind='expectations';
CREATE OR REPLACE VIEW live_coverage_slot_assessment AS
SELECT s.*,
  NOT EXISTS(SELECT 1 FROM live_coverage_events x WHERE x.kind='scope_exit' AND x.scope_id=s.scope_id
    AND x.detail->>'reason'='local_outcome_known' AND (x.detail->>'effectiveAt')::bigint<s.due_ms) AS denominator_eligible,
  floor(extract(epoch FROM clock_timestamp())*1000)>s.due_ms+s.window_ms AS deadline_elapsed,
  EXISTS(SELECT 1 FROM live_coverage_events m WHERE m.kind='map_poll' AND m.scope_id=s.scope_id
    AND (m.detail->>'slotDueAt')::bigint=s.due_ms AND (m.detail->>'responseInWindow')::boolean
    AND (m.detail->>'packetPresent')::boolean AND (m.detail->>'identityMatches')::boolean) AS packet_received_within_window,
  EXISTS(SELECT 1 FROM live_coverage_events m WHERE m.kind='map_poll' AND m.scope_id=s.scope_id
    AND (m.detail->>'slotDueAt')::bigint=s.due_ms AND (m.detail->>'responseInWindow')::boolean
    AND (m.detail->>'state6FieldsComplete')::boolean) AS complete_state6_packet_received_within_window,
  EXISTS(SELECT 1 FROM live_coverage_events m WHERE m.kind='map_poll' AND m.scope_id=s.scope_id
    AND (m.detail->>'slotDueAt')::bigint=s.due_ms AND (m.detail->>'responseInWindow')::boolean
    AND (m.detail->>'state6FieldsComplete')::boolean AND (m.detail->>'passesLocalSourceGuard')::boolean) AS complete_state6_source_guard_packet_received_within_window,
  NULL::boolean AS available_usable_cached_state_at_fixed_slot,
  false AS cached_state_availability_measured,
  false AS verified_event_to_prediction_timely,
  'previously observed team-identified OpenDota maps; unknown unseen maps and discovery lag'::text AS scope_limit
FROM live_coverage_expected_slots s;
COMMIT;
