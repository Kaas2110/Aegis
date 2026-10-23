import test from "node:test";
import assert from "node:assert/strict";

test(
  "outcome revisions preserve corrections, completion and A->B->A without duplicates",
  { skip: process.env.AEGIS_JOURNAL_DB_TEST !== "1" },
  async () => {
    const {
      db,
      pool,
      proMatchesTable,
      liveObservationJournalTable,
      liveJournalOutcomesTable,
    } = await import("@workspace/db");
    const { sql, eq, asc } = await import("drizzle-orm");
    const { reconcileLocalJournalOutcomes } =
      await import("./LivePredictionJournal");
    const { observeLivePacket } =
      await import("../lib/liveObservationContract");
    const rollback = new Error("rollback_journal_test");
    try {
      await db.transaction(async (tx) => {
        // Temp relations shadow production names for this connection only. No real rows are changed.
        await tx.execute(
          sql`CREATE TEMP TABLE pro_matches (LIKE public.pro_matches INCLUDING ALL) ON COMMIT DROP`,
        );
        await tx.execute(
          sql`CREATE TEMP TABLE live_observation_journal (LIKE public.live_observation_journal INCLUDING ALL) ON COMMIT DROP`,
        );
        await tx.execute(
          sql`CREATE TEMP TABLE live_journal_outcomes (LIKE public.live_journal_outcomes INCLUDING ALL) ON COMMIT DROP`,
        );
        await tx
          .insert(proMatchesTable)
          .values({
            matchId: 101,
            startTime: 1791000000,
            duration: 1800,
            radiantTeamId: 1,
            direTeamId: 2,
            radiantWin: true,
          });
        await tx
          .insert(liveObservationJournalTable)
          .values(
            observeLivePacket(
              {
                match_id: 101,
                team_id_radiant: 1,
                team_id_dire: 2,
                game_time: 300,
              },
              new Date(Date.now() - 60_000),
            ),
          );
        const revisions = () =>
          tx
            .select()
            .from(liveJournalOutcomesTable)
            .where(eq(liveJournalOutcomesTable.matchId, 101))
            .orderBy(asc(liveJournalOutcomesTable.recordedAt));
        await reconcileLocalJournalOutcomes(tx);
        let rows = await revisions();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome.radiantWin, true);
        assert.equal(rows[0].outcome.radiantScore, null);
        await reconcileLocalJournalOutcomes(tx);
        assert.equal((await revisions()).length, 1);
        await tx
          .update(proMatchesTable)
          .set({ radiantWin: false })
          .where(eq(proMatchesTable.matchId, 101));
        await reconcileLocalJournalOutcomes(tx);
        await tx
          .update(proMatchesTable)
          .set({ radiantWin: true })
          .where(eq(proMatchesTable.matchId, 101));
        await reconcileLocalJournalOutcomes(tx);
        rows = await revisions();
        assert.equal(rows.length, 3);
        assert.deepEqual(
          rows.map((r) => r.outcome.radiantWin),
          [true, false, true],
        );
        assert.equal(rows[0].evidenceHash, rows[2].evidenceHash);
        assert.notEqual(rows[0].id, rows[2].id);
        await tx
          .update(proMatchesTable)
          .set({ radiantScore: 22, direScore: 18 })
          .where(eq(proMatchesTable.matchId, 101));
        await reconcileLocalJournalOutcomes(tx);
        rows = await revisions();
        assert.equal(rows.length, 4);
        assert.equal(rows[3].outcome.radiantScore, 22);
        await reconcileLocalJournalOutcomes(tx);
        assert.equal((await revisions()).length, 4);
        throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    } finally {
      await pool.end();
    }
  },
);
