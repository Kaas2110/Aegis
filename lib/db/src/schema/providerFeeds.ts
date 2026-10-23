import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
export const providerFeedSnapshotsTable = pgTable('provider_feed_snapshots', {
  key: text('key').primaryKey(),
  payload: jsonb('payload'),
  receivedAt: timestamp('received_at', {withTimezone: true}),
  attemptedAt: timestamp('attempted_at', {withTimezone: true}),
  lastError: text('last_error'),
});
