import {
  pgTable,
  text,
  bigint,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/** Append-only prospective evidence, independent from pruning of UI snapshots. */
export const liveObservationJournalTable = pgTable(
  "live_observation_journal",
  {
    id: text("id").primaryKey(),
    matchId: bigint("match_id", { mode: "number" }).notNull(),
    snapshotId: integer("snapshot_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    gameTimeSec: integer("game_time_sec"),
    phase: text("phase").notNull(),
    inputHash: text("input_hash").notNull(),
    schemaHash: text("schema_hash").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    qualityReasons: jsonb("quality_reasons").$type<string[]>().notNull(),
    availability: jsonb("availability")
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (t) => ({
    matchTime: index("live_observation_journal_match_time_idx").on(
      t.matchId,
      t.receivedAt,
    ),
  }),
);

export const livePredictionJournalTable = pgTable(
  "live_prediction_journal",
  {
    id: text("id").primaryKey(),
    observationId: text("observation_id")
      .notNull()
      .references(() => liveObservationJournalTable.id),
    producer: text("producer").notNull(),
    market: text("market").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    predictedAt: timestamp("predicted_at", { withTimezone: true }).notNull(),
    modelVersion: text("model_version"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
  },
  (t) => ({
    observation: index("live_prediction_journal_observation_idx").on(
      t.observationId,
    ),
  }),
);

/** Outcomes are appended later and never become part of an input snapshot. */
export const liveJournalOutcomesTable = pgTable(
  "live_journal_outcomes",
  {
    id: text("id").primaryKey(),
    matchId: bigint("match_id", { mode: "number" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    source: text("source").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    outcome: jsonb("outcome").$type<Record<string, unknown>>().notNull(),
  },
  (t) => ({
    match: index("live_journal_outcomes_match_idx").on(t.matchId, t.recordedAt),
  }),
);
