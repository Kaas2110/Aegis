BEGIN;
CREATE TABLE IF NOT EXISTS live_observation_journal (
  id text PRIMARY KEY, match_id bigint NOT NULL, snapshot_id integer,
  received_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  game_time_sec integer, phase text NOT NULL, input_hash text NOT NULL, schema_hash text NOT NULL,
  input jsonb NOT NULL, quality_reasons jsonb NOT NULL, availability jsonb NOT NULL,
  CHECK (recorded_at >= received_at),
  CHECK (phase IN ('pre_draft','post_draft','live','unknown'))
);
CREATE INDEX IF NOT EXISTS live_observation_journal_match_time_idx ON live_observation_journal(match_id, received_at);
CREATE TABLE IF NOT EXISTS live_prediction_journal (
  id text PRIMARY KEY, observation_id text NOT NULL REFERENCES live_observation_journal(id),
  producer text NOT NULL, market text NOT NULL, phase text NOT NULL,
  status text NOT NULL CHECK (status IN ('predicted','unavailable','error')),
  reason text, predicted_at timestamptz NOT NULL, model_version text, evidence jsonb, output jsonb,
  CHECK ((status='predicted' AND model_version IS NOT NULL AND evidence IS NOT NULL AND output IS NOT NULL)
    OR (status<>'predicted' AND output IS NULL AND reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS live_prediction_journal_observation_idx ON live_prediction_journal(observation_id);
CREATE TABLE IF NOT EXISTS live_journal_outcomes (
  id text PRIMARY KEY, match_id bigint NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL, evidence_hash text NOT NULL, outcome jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS live_journal_outcomes_match_idx ON live_journal_outcomes(match_id,recorded_at);
COMMIT;
