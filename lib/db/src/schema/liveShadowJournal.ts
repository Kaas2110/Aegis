import { pgTable, text, bigint, boolean, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { liveObservationJournalTable } from './predictionJournal';

export const liveShadowRequestsTable = pgTable('live_shadow_requests', {
  id: text('id').primaryKey(),
  observationId: text('observation_id').notNull().references(() => liveObservationJournalTable.id),
  matchId: bigint('match_id', { mode: 'number' }).notNull(),
  candidateId: text('candidate_id').notNull(),
  candidateHash: text('candidate_hash').notNull(),
  modelHash: text('model_hash').notNull(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }).notNull().defaultNow(),
  outcomeKnownAtDispatch: boolean('outcome_known_at_dispatch').notNull(),
  requestBody: jsonb('request_body').$type<Record<string, unknown>>().notNull(),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
}, t => ({
  matchTime: index('live_shadow_requests_match_time_idx').on(t.matchId, t.dispatchedAt),
  candidate: uniqueIndex('live_shadow_requests_observation_candidate_idx').on(t.observationId, t.candidateHash),
}));

export const liveShadowResultsTable = pgTable('live_shadow_results', {
  requestId: text('request_id').primaryKey().references(() => liveShadowRequestsTable.id),
  status: text('status').notNull(),
  reason: text('reason'),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  outcomeKnownAtFinish: boolean('outcome_known_at_finish').notNull(),
  beforeLocalOutcomeAtChecks: boolean('before_local_outcome_at_checks').notNull(),
  response: jsonb('response').$type<Record<string, unknown>>(),
  assessment: jsonb('assessment').$type<Record<string, unknown>>().notNull(),
});
