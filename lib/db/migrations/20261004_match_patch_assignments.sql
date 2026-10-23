-- Calendar inferences are separate from provider-reported patch facts.
CREATE TABLE IF NOT EXISTS dota_patch_calendar_releases (
  calendar_hash text NOT NULL, patch_version text NOT NULL, source text NOT NULL,
  release_from timestamptz NOT NULL, release_to timestamptz NOT NULL,
  timestamp_precision text NOT NULL CHECK (timestamp_precision IN ('source_timestamp_seconds','date_only_utc')),
  observed_at timestamptz NOT NULL, known_at timestamptz NOT NULL, knowledge_basis text NOT NULL,
  PRIMARY KEY (calendar_hash, patch_version), CHECK (release_to >= release_from)
);
CREATE TABLE IF NOT EXISTS match_patch_assignments (
  match_id bigint PRIMARY KEY REFERENCES pro_matches(match_id) ON DELETE CASCADE,
  match_start timestamptz NOT NULL, inferred_version text, confirmed_version text,
  provider_base_version text, provider_evidence jsonb,
  provenance text NOT NULL CHECK (provenance IN ('inferred_by_release_calendar','provider_reported_exact','unresolved')),
  uncertainty boolean NOT NULL, reasons jsonb NOT NULL, candidates jsonb NOT NULL,
  calendar_hash text NOT NULL, release_known_at timestamptz, release_observed_at timestamptz,
  release_timestamp_precision text, inference_basis text NOT NULL,
  resolver_version text NOT NULL, input_fingerprint text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_patch_assignments_version_idx ON match_patch_assignments(inferred_version);
CREATE INDEX IF NOT EXISTS match_patch_assignments_uncertainty_idx ON match_patch_assignments(uncertainty);
