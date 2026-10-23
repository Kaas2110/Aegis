import test from "node:test";
import assert from "node:assert/strict";

// The context has no database side effects. No connection is opened by these tests.
process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:1/unused";
const { LiveJournalContext } = await import("./LivePredictionJournal");
const { evidenceHash, predictionEvidence } =
  await import("../lib/predictionEvidence");
const packet = {
  match_id: 99,
  team_id_radiant: 1,
  team_id_dire: 2,
  game_time: 600,
  radiant_score: 0,
  dire_score: 0,
  radiant_lead: 0,
  players: [],
};
const evidence = predictionEvidence(evidenceHash({ weights: [1] }), ["x"], [0]);

test("context during live is explicitly excluded from the pregame phase", () => {
  const ctx = new LiveJournalContext(packet, new Date(Date.now() - 1000), 1);
  assert.equal(
    ctx.rows.get("prematch_context")?.phase,
    "pregame_model_during_live",
  );
  assert.equal(ctx.rows.get("live_winner")?.phase, "live");
});
test("missing model is recorded without a fabricated probability", () => {
  const ctx = new LiveJournalContext(packet, new Date(Date.now() - 1000), 1);
  assert.equal(ctx.rows.size, 5);
  assert.equal(ctx.rows.get("live_winner")?.status, "unavailable");
  assert.equal(ctx.rows.get("live_winner")?.output, undefined);
});
test("UI persistence error preserves a computed total; other failure stays explicit", () => {
  const ctx = new LiveJournalContext(packet, new Date(Date.now() - 1000), 1);
  ctx.predicted("live_total_kills", {
    modelVersion: "fixture",
    evidence,
    output: { targetTransform: "log1p", logMean: 3, logStd: 0.2 },
  });
  ctx.unavailable("live_total_kills", "ui_database_failure", true);
  ctx.unavailable("live_total_duration", "model_timeout", true);
  assert.equal(ctx.rows.get("live_total_kills")?.status, "predicted");
  assert.equal(
    ctx.rows.get("live_total_kills")?.output?.targetTransform,
    "log1p",
  );
  assert.equal(ctx.rows.get("live_total_duration")?.status, "error");
});
