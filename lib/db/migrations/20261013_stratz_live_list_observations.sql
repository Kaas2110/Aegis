-- Raw selected GraphQL list before local filters. Existing poll only; no new API job.
CREATE TABLE IF NOT EXISTS stratz_live_list_observations (
 id text PRIMARY KEY CHECK(length(id)=64),
 received_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 contract_version text NOT NULL CHECK(contract_version='stratz_list_raw_filter_v1'),
 query_sha256 text NOT NULL CHECK(length(query_sha256)=64),
 raw_sha256 text NOT NULL CHECK(length(raw_sha256)=64),
 raw_bytes integer NOT NULL CHECK(raw_bytes>=2),
 raw_count integer NOT NULL CHECK(raw_count>=0),
 normalized_count integer NOT NULL CHECK(normalized_count>=0 AND normalized_count<=raw_count),
 status text NOT NULL CHECK(status IN ('upstream_empty','all_filtered','matches_available')),
 filter_reasons jsonb NOT NULL CHECK(jsonb_typeof(filter_reasons)='object'),
 raw_matches jsonb,
 raw_not_stored_reason text,
 CHECK((raw_matches IS NOT NULL AND jsonb_typeof(raw_matches)='array'
   AND jsonb_array_length(raw_matches)=raw_count AND raw_not_stored_reason IS NULL AND raw_bytes<=131072)
  OR (raw_matches IS NULL AND raw_not_stored_reason='payload_exceeds_archive_bound' AND raw_bytes>131072))
);
CREATE INDEX IF NOT EXISTS stratz_live_list_observations_received_idx ON stratz_live_list_observations(received_at);
COMMENT ON TABLE stratz_live_list_observations IS 'Append-only from ordinary STRATZ list poll; no provider latency or detailed-player coverage claim. Raw is the selected GraphQL list, not HTTP envelope.';
