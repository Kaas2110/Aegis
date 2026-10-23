import {
  db,
  liveObservationJournalTable,
  liveSnapshotsTable,
  livePredictionJournalTable,
  liveJournalOutcomesTable,
  proMatchesTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  observeLivePacket,
  type LiveObservation,
} from "../lib/liveObservationContract";
import {
  evidenceHash,
  type PredictionEvidence,
} from "../lib/predictionEvidence";
import { JournalOutbox } from "../lib/journalOutbox";
import { verifyJournalSnapshotLink, journalSnapshotLinkSql } from "../lib/journalSnapshotLink";

type Producer =
  | "prematch_context"
  | "live_winner"
  | "asym_live_winner"
  | "live_total_kills"
  | "live_total_duration";
type JournalRow = typeof livePredictionJournalTable.$inferInsert;
type Success = {
  modelVersion: string;
  evidence: PredictionEvidence;
  output: Record<string, unknown>;
};
const producers: Producer[] = [
  "prematch_context",
  "live_winner",
  "asym_live_winner",
  "live_total_kills",
  "live_total_duration",
];

export class LiveJournalContext {
  readonly observation: LiveObservation;
  readonly rows = new Map<Producer, JournalRow>();
  constructor(
    packet: Record<string, unknown>,
    receivedAt: Date,
    readonly snapshotId: number,
    outcomeKnownAtCapture: boolean | null = null,
  ) {
    this.observation = observeLivePacket(packet, receivedAt);
    this.observation.availability = {
      ...this.observation.availability,
      ...{ outcomeKnownAtCapture },
    };
    if (outcomeKnownAtCapture === true)
      this.observation.qualityReasons.push("outcome_already_known_locally");
    if (outcomeKnownAtCapture === null)
      this.observation.qualityReasons.push("outcome_availability_not_checked");
    for (const producer of producers)
      this.unavailable(producer, "not_computed_or_model_unavailable");
  }
  private row(producer: Producer): JournalRow {
    const phase =
      producer === "prematch_context" && this.observation.phase === "live"
        ? "pregame_model_during_live"
        : this.observation.phase;
    return {
      id: evidenceHash({ observationId: this.observation.id, producer }),
      observationId: this.observation.id,
      producer,
      phase,
      market:
        producer === "live_total_kills"
          ? "total_kills"
          : producer === "live_total_duration"
            ? "total_duration"
            : "map_winner",
      predictedAt: new Date(),
      status: "unavailable",
      reason: "not_computed",
    };
  }
  unavailable(producer: Producer, reason: string, error = false): void {
    // Downstream UI-table failure must not erase an already computed forecast.
    if (error && this.rows.get(producer)?.status === "predicted") return;
    this.rows.set(producer, {
      ...this.row(producer),
      status: error ? "error" : "unavailable",
      reason,
    });
  }
  predicted(producer: Producer, result: Success): void {
    const p = result.output.radiantWinProbability;
    if (
      p !== undefined &&
      (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)
    )
      throw new Error("invalid_probability");
    // Validate the exact ordered vector before storing. No hidden NaN->null conversion.
    evidenceHash(result.evidence);
    evidenceHash(result.output);
    this.rows.set(producer, {
      ...this.row(producer),
      status: "predicted",
      reason: null,
      modelVersion: result.modelVersion,
      evidence: { ...result.evidence },
      output: result.output,
    });
  }
}

/** Local labels only: the collector never makes an additional provider request. */
export async function reconcileLocalJournalOutcomes(
  store: Pick<typeof db, "selectDistinctOn" | "insert"> = db,
): Promise<void> {
  const rows = await store
    .selectDistinctOn([proMatchesTable.matchId], {
      match: proMatchesTable,
      previousRevisionId: sql<
        string | null
      >`(SELECT o.id FROM live_journal_outcomes o
      WHERE o.match_id=${proMatchesTable.matchId} ORDER BY o.recorded_at DESC,o.id DESC LIMIT 1)`,
    })
    .from(proMatchesTable)
    .innerJoin(
      liveObservationJournalTable,
      eq(liveObservationJournalTable.matchId, proMatchesTable.matchId),
    )
    .where(
      and(
        sql`${proMatchesTable.radiantWin} IS NOT NULL AND ${proMatchesTable.duration} > 0`,
        sql`NOT coalesce((SELECT o.outcome FROM live_journal_outcomes o WHERE o.match_id=${proMatchesTable.matchId}
        ORDER BY o.recorded_at DESC,o.id DESC LIMIT 1) @> jsonb_build_object(
          'radiantWin',${proMatchesTable.radiantWin},'durationSec',${proMatchesTable.duration},
          'radiantTeamId',${proMatchesTable.radiantTeamId},'direTeamId',${proMatchesTable.direTeamId},
          'startTime',${proMatchesTable.startTime},'seriesId',${proMatchesTable.series_id},'seriesType',${proMatchesTable.series_type},
          'radiantScore',CASE WHEN ${proMatchesTable.radiantScore}>=0 THEN ${proMatchesTable.radiantScore} ELSE NULL END,
          'direScore',CASE WHEN ${proMatchesTable.direScore}>=0 THEN ${proMatchesTable.direScore} ELSE NULL END),false)`,
      ),
    )
    .limit(100);
  for (const { match: m, previousRevisionId } of rows) {
    const outcome = {
      matchId: m.matchId,
      startTime: m.startTime,
      durationSec: m.duration,
      radiantTeamId: m.radiantTeamId,
      direTeamId: m.direTeamId,
      radiantWin: m.radiantWin,
      radiantScore:
        m.radiantScore != null && m.radiantScore >= 0 ? m.radiantScore : null,
      direScore: m.direScore != null && m.direScore >= 0 ? m.direScore : null,
      seriesId: m.series_id,
      seriesType: m.series_type,
      localIngestedAt: m.ingestedAt.toISOString(),
    };
    const contentHash = evidenceHash(outcome);
    // Chained event identity preserves A->B->A corrections and still deduplicates retries.
    await store
      .insert(liveJournalOutcomesTable)
      .values({
        id: evidenceHash({ previousRevisionId, contentHash }),
        matchId: m.matchId,
        source: "local_pro_matches",
        recordedAt: sql`clock_timestamp()`,
        evidenceHash: contentHash,
        outcome,
      })
      .onConflictDoNothing();
  }
}

let lastSettlement = 0;
/** Called once for a durable collector batch, independently of UI request volume. */
export async function flushLivePredictionJournal(
  contexts: LiveJournalContext[],
): Promise<void> {
  let stage: "enqueue" | "drain" | "settlement" = "enqueue";
  let newBatchQueued = false;
  try {
    const outbox = new JournalOutbox(process.env.AEGIS_STATE_DIR ?? "");
    if (contexts.length)
      await outbox.enqueue(
        JSON.parse(
          JSON.stringify({
            version: 1,
            observations: contexts.map((c) => ({
              ...c.observation,
              snapshotId: c.snapshotId,
            })),
            predictions: contexts.flatMap((c) => [...c.rows.values()]),
          }),
        ),
      );
    newBatchQueued = contexts.length > 0;
    stage = "drain";
    await outbox.drain(async (raw) => {
      const batch = raw as {
        version: number;
        observations: Array<typeof liveObservationJournalTable.$inferInsert>;
        predictions: JournalRow[];
      };
      if (
        batch.version !== 1 ||
        !Array.isArray(batch.observations) ||
        !Array.isArray(batch.predictions)
      )
        throw new Error("invalid_journal_batch");
      const observations = batch.observations.map((o) => ({
        ...o,
        receivedAt: new Date(o.receivedAt),
        recordedAt: new Date(o.recordedAt!),
      }));
      const predictions = batch.predictions.map((p) => ({
        ...p,
        predictedAt: new Date(p.predictedAt),
      }));
      await db.transaction(async (tx) => {
        await tx
          .insert(liveObservationJournalTable)
          .values(observations)
          .onConflictDoNothing();
        // Earlier diagnostic hooks may have inserted the same observation with
        // snapshot_id=NULL. Fill only that link, after verifying real raw source.
        const snapshotIds = [...new Set(observations.map(o => o.snapshotId)
          .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0))];
        if (snapshotIds.length) {
          const snapshots = await tx.select({
            id: liveSnapshotsTable.id, matchId: liveSnapshotsTable.matchId,
            source: liveSnapshotsTable.source, capturedAt: liveSnapshotsTable.capturedAt,
            gameTimeSec: liveSnapshotsTable.gameTimeSec, rawPayload: liveSnapshotsTable.rawPayload,
          }).from(liveSnapshotsTable).where(inArray(liveSnapshotsTable.id, snapshotIds));
          const byId = new Map(snapshots.map(s => [s.id, s]));
          for (const observation of observations) {
            const proof = verifyJournalSnapshotLink(observation,
              observation.snapshotId == null ? undefined : byId.get(observation.snapshotId));
            if (proof) await tx.execute(journalSnapshotLinkSql(proof));
          }
        }
        await tx
          .insert(livePredictionJournalTable)
          .values(predictions)
          .onConflictDoNothing();
      });
    });
    stage = "settlement";
    if (Date.now() - lastSettlement >= 60_000) {
      await reconcileLocalJournalOutcomes();
      lastSettlement = Date.now();
    }
  } catch (err) {
    // A journal failure must not change serving probabilities or spend provider quota.
    logger.error(
      {
        code: (err as { code?: string }).code ?? "journal_write_error",
        observations: contexts.length,
        stage,
        newBatchQueued,
      },
      stage === "enqueue"
        ? "[LivePredictionJournal] could not queue new batch; observation evidence may be lost"
        : "[LivePredictionJournal] persistence failed; queued batches or labels retry next poll",
    );
  }
}
