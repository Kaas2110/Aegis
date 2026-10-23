-- Additive only. No changes to existing matches, models or live_snapshots.
CREATE TABLE IF NOT EXISTS provider_feed_snapshots (
  key text PRIMARY KEY,
  payload jsonb,
  received_at timestamptz,
  attempted_at timestamptz,
  last_error text
);
