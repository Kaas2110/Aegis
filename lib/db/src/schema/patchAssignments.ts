import { pgTable, text, jsonb, timestamp, bigint, boolean, primaryKey, index } from 'drizzle-orm/pg-core';
import { proMatchesTable } from './dota';

/** Additive metadata only. Never overwrite provider patch values or replay data. */
export const dotaPatchCalendarReleasesTable = pgTable('dota_patch_calendar_releases', {
  calendarHash: text('calendar_hash').notNull(), patchVersion: text('patch_version').notNull(),
  source: text('source').notNull(), releaseFrom: timestamp('release_from', {withTimezone: true}).notNull(),
  releaseTo: timestamp('release_to', {withTimezone: true}).notNull(), timestampPrecision: text('timestamp_precision').notNull(),
  observedAt: timestamp('observed_at', {withTimezone: true}).notNull(), knownAt: timestamp('known_at', {withTimezone: true}).notNull(),
  knowledgeBasis: text('knowledge_basis').notNull(),
}, table => [primaryKey({columns: [table.calendarHash, table.patchVersion]})]);

export const matchPatchAssignmentsTable = pgTable('match_patch_assignments', {
  matchId: bigint('match_id', {mode: 'number'}).primaryKey().references(() => proMatchesTable.matchId, {onDelete: 'cascade'}),
  matchStart: timestamp('match_start', {withTimezone: true}).notNull(),
  inferredVersion: text('inferred_version'), confirmedVersion: text('confirmed_version'),
  providerBaseVersion: text('provider_base_version'), providerEvidence: jsonb('provider_evidence'),
  provenance: text('provenance').notNull(), uncertainty: boolean('uncertainty').notNull(),
  reasons: jsonb('reasons').notNull(), candidates: jsonb('candidates').notNull(),
  calendarHash: text('calendar_hash').notNull(), releaseKnownAt: timestamp('release_known_at', {withTimezone: true}),
  releaseObservedAt: timestamp('release_observed_at', {withTimezone: true}), releaseTimestampPrecision: text('release_timestamp_precision'),
  inferenceBasis: text('inference_basis').notNull(), resolverVersion: text('resolver_version').notNull(),
  inputFingerprint: text('input_fingerprint').notNull(), assignedAt: timestamp('assigned_at', {withTimezone: true}).notNull().defaultNow(),
}, table => [index('match_patch_assignments_version_idx').on(table.inferredVersion),
  index('match_patch_assignments_uncertainty_idx').on(table.uncertainty)]);
