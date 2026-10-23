-- Apply explicitly through the normal migration path. No auto-migration in readers.
CREATE TABLE IF NOT EXISTS history_context_snapshots (
 cache_key text PRIMARY KEY CHECK (cache_key ~ '^[a-f0-9]{64}$'),
 content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
 match_id bigint NOT NULL CHECK (match_id > 0),
 history_cutoff_at_text text NOT NULL,
 valid_from_at_text text NOT NULL,
 snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
 inserted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (coalesce(snapshot->>'contract' = 'aegis.history-context-snapshot.v1',false)),
 CHECK (coalesce(snapshot->>'cacheKey' = cache_key,false)),
 CHECK (coalesce(snapshot->>'contentHash' = content_hash,false)),
 CHECK (coalesce(snapshot->'identity'->>'matchId' = match_id::text,false)),
 CHECK (coalesce(snapshot->'identity'->>'historyCutoffAt' = history_cutoff_at_text,false)),
 CHECK (coalesce(snapshot->'identity'->>'validFrom' = valid_from_at_text,false))
);
CREATE INDEX IF NOT EXISTS history_context_snapshots_match_id_idx ON history_context_snapshots(match_id);
CREATE OR REPLACE FUNCTION reject_history_context_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history_context_snapshots is append-only'; END; $$;
DROP TRIGGER IF EXISTS history_context_snapshots_append_only ON history_context_snapshots;
CREATE TRIGGER history_context_snapshots_append_only BEFORE UPDATE OR DELETE ON history_context_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_history_context_snapshot_mutation();
DROP TRIGGER IF EXISTS history_context_snapshots_no_truncate ON history_context_snapshots;
CREATE TRIGGER history_context_snapshots_no_truncate BEFORE TRUNCATE ON history_context_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION reject_history_context_snapshot_mutation();
