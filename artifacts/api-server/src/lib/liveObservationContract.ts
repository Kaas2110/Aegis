import { evidenceHash } from "./predictionEvidence";
import { safeOpenDotaId } from "./openDotaLiveIds";
import { liveStateFreshness } from "./liveStateFreshness";
import {captureLiveStateSource} from "./liveStateSource";

export const LIVE_OBSERVATION_CONTRACT = {
  version: "opendota-observed-live-v3",
  stateFreshness: "collector state progression and declared broadcast delay; receipt is not event latency",
  gameTime: "seconds; negative means pre-start",
  providerObservedAt: "unknown; receipt is not provider observation time",
  providerDelayRaw:
    "SourceTV declared broadcast delay, seconds; not measured packet latency",
  providerClockFields:
    "raw last_update_time/activate_time/deactivate_time; event-time semantics not verified",
  radiantLead: "provider radiant_lead; not verified net worth or earned gold",
  buildingState: "opaque provider bitfield; no tower-count interpretation",
  draftIdentity: "explicit team 0/1; 5+5 distinct positive hero IDs",
  missing: "null; observed zero retained",
  lineage: "prospective collector only; never historical replay",
} as const;
export const LIVE_OBSERVATION_SCHEMA_HASH = evidenceHash(
  LIVE_OBSERVATION_CONTRACT,
);

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const integer = (v: unknown, min: number): number | null =>
  finite(v) && Number.isSafeInteger(v) && v >= min ? v : null;
const sourceCaptureReasons = new Set([
  "live_state_source_scalar_invalid", "live_state_source_players_bound",
  "live_state_source_player_invalid", "live_state_source_players_invalid",
  "live_state_source_state_invalid", "live_state_source_bytes_bound",
]);

export function observeLivePacket(
  packet: Record<string, unknown>,
  receivedAt: Date,
  recordedAt = new Date(),
) {
  const matchId = safeOpenDotaId(packet.match_id);
  if (!matchId) throw new Error("invalid_match_identity");
  const receiveMs = receivedAt.getTime(),
    recordMs = recordedAt.getTime();
  if (
    !Number.isFinite(receiveMs) ||
    !Number.isFinite(recordMs) ||
    receiveMs > recordMs
  )
    throw new Error("invalid_observation_time");
  const players = (Array.isArray(packet.players) ? packet.players : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      heroId: integer(p.hero_id, 1),
      accountId: safeOpenDotaId(p.account_id) ?? null,
      team: p.team === 0 || p.team === 1 ? p.team : null,
      providerTeamSlot: integer(p.team_slot, 0),
    }))
    .sort(
      (a, b) =>
        (a.team ?? 2) - (b.team ?? 2) ||
        (a.heroId ?? 0) - (b.heroId ?? 0) ||
        (a.accountId ?? 0) - (b.accountId ?? 0),
    );
  const input = {
    matchId,
    radiantTeamId: safeOpenDotaId(packet.team_id_radiant) ?? null,
    direTeamId: safeOpenDotaId(packet.team_id_dire) ?? null,
    leagueId: safeOpenDotaId(packet.league_id) ?? null,
    gameTimeSec: integer(packet.game_time, -3600),
    radiantScore: integer(packet.radiant_score, 0),
    direScore: integer(packet.dire_score, 0),
    radiantLead: finite(packet.radiant_lead) ? packet.radiant_lead : null,
    buildingState: integer(packet.building_state, 0),
    players,
    providerDelayRaw: finite(packet.delay) ? packet.delay : null,
    providerLastUpdateRaw: finite(packet.last_update_time)
      ? packet.last_update_time
      : null,
    providerActivateTimeRaw: finite(packet.activate_time)
      ? packet.activate_time
      : null,
    providerDeactivateTimeRaw: finite(packet.deactivate_time)
      ? packet.deactivate_time
      : null,
    // Raw provider clock fields do not establish an authoritative event timestamp.
    providerObservedAt: null,
    xpAdvantage: null,
    networthAdvantage: null,
  };
  const draftComplete =
    players.length === 10 &&
    players.filter((p) => p.team === 0).length === 5 &&
    players.filter((p) => p.team === 1).length === 5 &&
    players.every((p) => p.heroId !== null) &&
    new Set(players.map((p) => p.heroId)).size === 10;
  // Recompute from the collector evidence, never trust a provider-supplied public quality field.
  const liveDataQuality = liveStateFreshness(packet, receivedAt.toISOString(), recordMs);
  const reasons: string[] = [];
  if (!liveDataQuality.eligibleForObservedStatePrediction)
    reasons.push(`live_freshness:${liveDataQuality.reason ?? "unverified"}`);
  if (
    !input.radiantTeamId ||
    !input.direTeamId ||
    input.radiantTeamId === input.direTeamId
  )
    reasons.push("invalid_team_identity");
  if (input.gameTimeSec === null) reasons.push("missing_or_invalid_game_clock");
  if (input.radiantScore === null || input.direScore === null)
    reasons.push("missing_or_invalid_score");
  if (input.radiantLead === null) reasons.push("missing_provider_lead");
  if (!draftComplete) reasons.push("draft_identity_unverified");
  const phase =
    input.gameTimeSec === null
      ? "unknown"
      : input.gameTimeSec >= 0
        ? "live"
        : draftComplete
          ? "post_draft"
          : "pre_draft";
  const inputHash = evidenceHash(input);
  // This evidence is an additional requirement for the wide diagnostic gate.
  // Its rejection must not interrupt the pre-existing ordinary journal/batch.
  // Keep the strict capture and binder unchanged; absence remains unavailable.
  let liveStateSource: ReturnType<typeof captureLiveStateSource> | null = null;
  let liveStateSourceCaptureReason: string | null = null;
  try {
    liveStateSource = captureLiveStateSource(packet);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    liveStateSourceCaptureReason = sourceCaptureReasons.has(code)
      ? code : "live_state_source_capture_failed";
  }
  return {
    id: evidenceHash({
      contract: LIVE_OBSERVATION_SCHEMA_HASH,
      inputHash,
      receivedAt: receivedAt.toISOString(),
    }),
    matchId,
    receivedAt,
    recordedAt,
    gameTimeSec: input.gameTimeSec,
    phase,
    inputHash,
    schemaHash: LIVE_OBSERVATION_SCHEMA_HASH,
    input,
    qualityReasons: reasons,
    availability: {
      liveDataQuality,
      liveStateSource,
      liveStateSourceCaptureReason,
      draftComplete,
      providerObservedAtKnown: false,
      xp: false,
      networth: false,
      items: false,
      levels: false,
      respawn: false,
      buildingEncodingVerified: false,
    },
  };
}

export type LiveObservation = ReturnType<typeof observeLivePacket>;
