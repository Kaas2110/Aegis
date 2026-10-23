import test from "node:test";
import assert from "node:assert/strict";
import {
  observeLivePacket,
  LIVE_OBSERVATION_SCHEMA_HASH,
} from "./liveObservationContract";
import { evidenceHash, predictionEvidence } from "./predictionEvidence";

const received = new Date("2026-10-04T07:00:00Z");
const recorded = new Date("2026-10-04T07:00:01Z");
function packet(): Record<string, unknown> {
  return {
    match_id: 1234,
    team_id_radiant: 12,
    team_id_dire: 34,
    game_time: 300,
    radiant_score: 0,
    dire_score: 1,
    radiant_lead: 0,
    building_state: 0,
    players: Array.from({ length: 10 }, (_, i) => ({
      hero_id: i + 1,
      account_id: 100 + i,
      team: i < 5 ? 0 : 1,
      team_slot: i % 5,
    })),
  };
}
test("observed zero is retained, missing lead remains null", () => {
  const p = packet();
  const o = observeLivePacket(p, received, recorded);
  assert.equal(o.input.radiantScore, 0);
  assert.equal(o.input.radiantLead, 0);
  assert.equal(o.input.buildingState, 0);
  assert.equal(o.input.providerObservedAt, null);
  delete p.radiant_lead;
  const missing = observeLivePacket(p, received, recorded);
  assert.equal(missing.input.radiantLead, null);
  assert.ok(missing.qualityReasons.includes("missing_provider_lead"));
  assert.notEqual(missing.inputHash, o.inputHash);
});
test("phase follows observed clock, late context never becomes pregame", () => {
  assert.equal(observeLivePacket(packet(), received, recorded).phase, "live");
  const p: Record<string, unknown> = { ...packet(), game_time: -60 };
  assert.equal(observeLivePacket(p, received, recorded).phase, "post_draft");
  delete p.players;
  assert.equal(observeLivePacket(p, received, recorded).phase, "pre_draft");
});
test("provider clock fields are preserved without claiming end-to-end latency", () => {
  const o = observeLivePacket(
    {
      ...packet(),
      delay: 900,
      last_update_time: 1791097000,
      activate_time: 1791096900,
    },
    received,
    recorded,
  );
  assert.equal(o.input.providerDelayRaw, 900);
  assert.equal(o.input.providerLastUpdateRaw, 1791097000);
  assert.equal(o.input.providerActivateTimeRaw, 1791096900);
  assert.equal(o.input.providerDeactivateTimeRaw, null);
  assert.equal(o.input.providerObservedAt, null);
  assert.equal(o.availability.providerObservedAtKnown, false);
});
test("team_slot is not side; cross-side duplicate heroes do not form a verified draft", () => {
  const p = packet();
  (p.players as Record<string, unknown>[]).forEach((x) => delete x.team);
  assert.equal(
    observeLivePacket(p, received, recorded).availability.draftComplete,
    false,
  );
  const q = packet();
  (q.players as Record<string, unknown>[])[9].hero_id = 1;
  assert.equal(
    observeLivePacket(q, received, recorded).availability.draftComplete,
    false,
  );
});
test("future receipt and unsafe identity rejected; missing clock is explicit", () => {
  assert.throws(
    () => observeLivePacket(packet(), recorded, received),
    /observation_time/,
  );
  assert.throws(
    () =>
      observeLivePacket(
        { ...packet(), match_id: "9007199254740993" },
        received,
        recorded,
      ),
    /identity/,
  );
  assert.equal(
    observeLivePacket({ ...packet(), game_time: undefined }, received, recorded)
      .phase,
    "unknown",
  );
});
test("fingerprint preserves player identity but ignores source array order", () => {
  const p = packet();
  const a = observeLivePacket(p, received, recorded);
  (p.players as unknown[]).reverse();
  const b = observeLivePacket(p, received, recorded);
  assert.equal(a.id, b.id);
  assert.equal(a.schemaHash, LIVE_OBSERVATION_SCHEMA_HASH);
  assert.notEqual(
    a.id,
    observeLivePacket(p, new Date(received.getTime() + 1000), recorded).id,
  );
  (p.players as Record<string, unknown>[])[0].account_id = 999;
  assert.notEqual(
    a.inputHash,
    observeLivePacket(p, received, recorded).inputHash,
  );
});
test("unrelated payload including future result is not model input", () => {
  const a = observeLivePacket(packet(), received, recorded);
  const b = observeLivePacket(
    {
      ...packet(),
      radiant_win: true,
      final_duration: 9999,
      api_key: "do-not-store",
    },
    received,
    recorded,
  );
  assert.equal(a.inputHash, b.inputHash);
  assert.ok(!JSON.stringify(b).includes("do-not-store"));
});
test("effective model and ordered vector fingerprint changes with coefficients and order", () => {
  const hash = evidenceHash({ weights: [1, 2], calibration: null });
  const ev = predictionEvidence(hash, ["first", "second"], [0, 2]);
  assert.deepEqual(ev.featureVector, [0, 2]);
  assert.notEqual(
    ev.modelHash,
    evidenceHash({ weights: [1, 3], calibration: null }),
  );
  assert.notEqual(
    ev.featureSchemaHash,
    predictionEvidence(hash, ["second", "first"], [2, 0]).featureSchemaHash,
  );
  assert.throws(() => predictionEvidence(hash, ["one"], [1, 2]), /evidence/);
  assert.throws(() => predictionEvidence(hash, ["one"], [NaN]), /evidence/);
});
