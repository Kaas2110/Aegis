-- Explicit opt-in only. No production prediction or training table is modified.
CREATE TABLE IF NOT EXISTS steam_dynamic_diagnostic_v1 (
 observation_id text PRIMARY KEY CHECK (observation_id ~ '^[a-f0-9]{64}$'),
 match_id numeric(20,0) NOT NULL,
 source_profile text NOT NULL,
 known_at timestamptz NOT NULL,
 game_clock_seconds double precision,
 raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[a-f0-9]{64}$'),
 source_input_hash text NOT NULL CHECK (source_input_hash ~ '^[a-f0-9]{64}$'),
 dynamic_contract text NOT NULL,
 normalized_observation jsonb NOT NULL,
 phase_code integer,
 roshan_respawn_timer_raw double precision,
 eligible_for_serving boolean NOT NULL DEFAULT false CHECK (eligible_for_serving = false),
 eligible_for_training boolean NOT NULL DEFAULT false CHECK (eligible_for_training = false),
 ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS steam_dynamic_diagnostic_v1_map_time
 ON steam_dynamic_diagnostic_v1(match_id,source_profile,known_at,observation_id);
