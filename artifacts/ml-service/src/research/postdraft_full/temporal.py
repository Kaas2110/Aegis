"""Versioned, pure temporal hero-kill contract for retrospective research.

No network/DB/model access. Observed hero kills are exact opponent NPC names,
never localized-name guesses. Negative pre-horn times are retained. Final
score is used only by endpoint_eligibility, never by prefix/player features.
Endpoint agreement is a completeness filter, not proof of intermediate accuracy.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

CONTRACT_VERSION = "temporal-hero-kills-v1"
EXPECTED_SLOTS = (0, 1, 2, 3, 4, 128, 129, 130, 131, 132)


def _number(value: Any) -> bool:
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _event_time(value: Any) -> bool:
    return _number(value) and float(value).is_integer()


def _cutoff(value: Any) -> None:
    if not _number(value) or value < 0:
        raise ValueError("game_seconds must be finite, non-boolean and >= 0")


@dataclass(frozen=True)
class KillEvent:
    player_slot: int
    killer_hero_id: int | None
    index: int
    side: str
    time: int | float | None
    key: str | None
    kind: str  # hero, nonhero, unknown
    issue: str | None
    _raw: Any = field(repr=False, compare=False)

    def to_dict(self) -> dict[str, Any]:
        return {"player_slot": self.player_slot, "killer_hero_id": self.killer_hero_id,
                "index": self.index, "side": self.side, "time": self.time,
                "key": self.key, "kind": self.kind, "issue": self.issue,
                "raw": copy.deepcopy(self._raw)}


@dataclass(frozen=True)
class PreparedKills:
    """Frozen shell, not a deep-immutable object. Use to_dict for independent copies.

    Internal raw/provenance objects are private. Structural issues apply to the
    whole map: a missing log from any player conservatively makes every player's
    first-kill feature unknown, even if that player's own log is populated.
    """
    events: tuple[KillEvent, ...]
    structural_issues: tuple[str, ...]
    player_slots: tuple[int, ...]
    reference_mapping_sha256: str | None
    _provenance: dict[str, Any] = field(repr=False, compare=False)

    def to_dict(self) -> dict[str, Any]:
        """Export raw key/time, indices, exclusion reason and source provenance."""
        return {"contract_version": CONTRACT_VERSION,
                "events": [event.to_dict() for event in self.events],
                "structural_issues": list(self.structural_issues),
                "player_slots": list(self.player_slots),
                "reference_mapping_sha256": self.reference_mapping_sha256,
                "provenance": copy.deepcopy(self._provenance),
                "retrospective_only": True, "prospective_validated": False}


def prepare_events(
    players: Any,
    hero_names: Mapping[int, str],
    *,
    provenance: Mapping[str, Any] | None = None,
    expected_reference_mapping_sha256: str | None = None,
) -> PreparedKills:
    """Validate ten slots and exact reference identities; retain every raw event.

    hero_names is a pinned provider ID -> internal NPC name reference. Provenance
    should identify payload_sha256, received_at, reference_sha256 and source.
    The reference mapping digest is also calculated from sorted ID/name pairs.
    Missing arrays/references remain unknown, distinct from known empty logs.
    A structural missing log on one player invalidates all player features.
    """
    issues: set[str] = set()
    events: list[KillEvent] = []
    names: dict[int, str] = {}
    reference_hash = None
    valid_reference = isinstance(hero_names, Mapping) and all(
        type(k) is int and k > 0 and isinstance(v, str) and v.startswith("npc_dota_hero_")
        for k, v in hero_names.items()
    )
    if valid_reference:
        reference_hash = hashlib.sha256(json.dumps(sorted(hero_names.items()),
            ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        if len(set(hero_names.values())) != len(hero_names):
            issues.add("nonunique_reference_names")
    else:
        issues.add("invalid_hero_reference")
    if expected_reference_mapping_sha256 is not None and reference_hash != expected_reference_mapping_sha256:
        issues.add("reference_hash_mismatch")
    metadata = copy.deepcopy(dict(provenance or {}))
    if not isinstance(players, (list, tuple)) or any(not isinstance(p, Mapping) for p in players):
        return PreparedKills((), tuple(sorted(issues | {"players_missing_or_invalid"})), (), reference_hash, metadata)
    slots = [p.get("player_slot") for p in players]
    slots_valid = len(players) == 10 and all(type(s) is int for s in slots) and sorted(slots) == list(EXPECTED_SLOTS)
    if not slots_valid:
        issues.add("invalid_10_player_slots")
    heroes = [p.get("hero_id") for p in players]
    if any(type(h) is not int or h <= 0 for h in heroes) or len(set(h for h in heroes if type(h) is int)) != 10:
        issues.add("invalid_10_distinct_hero_ids")
    for player in players:
        slot = player.get("player_slot"); hero_id = player.get("hero_id")
        if type(slot) is not int or slot not in EXPECTED_SLOTS:
            continue
        name = hero_names.get(hero_id) if valid_reference and type(hero_id) is int else None
        if name is None:
            issues.add("unknown_hero_id_or_reference")
        else:
            names[slot] = name
        side_flag = player.get("isRadiant")
        if side_flag is not None and (type(side_flag) is not bool or side_flag != (slot < 128)):
            issues.add("slot_side_disagreement")
        if not isinstance(player.get("kills_log"), list):
            issues.add("kills_log_missing_or_invalid")
    for player in players:
        slot = player.get("player_slot")
        if type(slot) is not int or slot not in EXPECTED_SLOTS:
            continue
        enemy_names = {name for enemy_slot, name in names.items() if (enemy_slot < 128) != (slot < 128)}
        logs = player.get("kills_log")
        if not isinstance(logs, list):
            continue
        seen: Counter[tuple[int | float, str]] = Counter()
        for index, raw in enumerate(logs):
            raw_time = raw.get("time") if isinstance(raw, Mapping) else None
            raw_key = raw.get("key") if isinstance(raw, Mapping) else None
            time = raw_time if _event_time(raw_time) else None
            key = raw_key if isinstance(raw_key, str) and raw_key else None
            issue = None
            kind = "unknown"
            if not isinstance(raw, Mapping):
                issue = "event_not_object"
            elif key is None:
                issue = "victim_key_missing_or_invalid"
            elif not key.startswith("npc_dota_"):
                issue = "unrecognized_victim_key_namespace"
            elif not key.startswith("npc_dota_hero_"):
                kind = "nonhero"
            elif key not in enemy_names:
                issue = "hero_victim_not_in_exact_opponent_roster"
            elif time is None:
                issue = "event_time_missing_or_invalid"
            else:
                kind = "hero"
                seen[(time, key)] += 1
                if seen[(time, key)] > 1:
                    issue = "ambiguous_exact_duplicate_hero_event"
                    kind = "unknown"
            events.append(KillEvent(slot, player.get("hero_id"), index,
                "radiant" if slot < 128 else "dire", time, key, kind, issue, copy.deepcopy(raw)))
    return PreparedKills(tuple(events), tuple(sorted(issues)),
        tuple(sorted(s for s in slots if type(s) is int and s in EXPECTED_SLOTS)), reference_hash, metadata)


def _prefix_issues(prepared: PreparedKills, game_seconds: int | float, player_slot: int | None = None) -> list[str]:
    issues = set(prepared.structural_issues)
    for event in prepared.events:
        if player_slot is not None and event.player_slot != player_slot:
            continue
        # A known strictly future timestamp cannot invalidate an earlier prefix.
        # An unknown timestamp might belong to that prefix and must fail closed.
        if event.issue and (event.time is None or event.time <= game_seconds):
            issues.add(event.issue)
    return sorted(issues)


def score_at(prepared: PreparedKills, game_seconds: int | float) -> dict[str, Any]:
    """Prefix only, including negative events. Unknown data yields score=None.

    candidate_score is diagnostic and must not be treated as a complete score
    when available=False. No endpoint/final scalar enters this function.
    """
    _cutoff(game_seconds)
    candidate = {"radiant": 0, "dire": 0}
    for event in prepared.events:
        if event.kind == "hero" and event.time is not None and event.time <= game_seconds:
            candidate[event.side] += 1
    issues = _prefix_issues(prepared, game_seconds)
    return {"available": not issues, "score": dict(candidate) if not issues else None,
            "candidate_score": candidate, "issues": issues, "game_seconds": game_seconds}


def endpoint_eligibility(prepared: PreparedKills, duration_seconds: Any, final_score: Any) -> dict[str, Any]:
    """Retrospective completeness gate; final score is never used to fill events."""
    issues = set(prepared.structural_issues)
    issues.update(event.issue for event in prepared.events if event.issue)
    endpoint = None
    if not _number(duration_seconds) or duration_seconds <= 0:
        issues.add("invalid_duration")
    else:
        endpoint = score_at(prepared, duration_seconds)["candidate_score"]
        if any(event.kind == "hero" and event.time is not None and event.time > duration_seconds for event in prepared.events):
            issues.add("hero_event_after_game_end")
    if not isinstance(final_score, Mapping) or any(type(final_score.get(k)) is not int or final_score[k] < 0 for k in ("radiant", "dire")):
        issues.add("invalid_final_score")
    elif endpoint is not None and endpoint != {k: final_score[k] for k in ("radiant", "dire")}:
        issues.add("hero_event_counts_disagree_final")
    return {"eligible": not issues, "low_data": bool(issues), "issues": sorted(issues),
            "candidate_endpoint": endpoint, "retrospective_only": True,
            "intermediate_score_independently_verified": False, "prospective_validated": False}


def past_player_first_hero_kill_min(
    prepared: PreparedKills, player_slot: int, *, as_of_seconds: int | float,
) -> dict[str, Any]:
    """First observed hero kill within a known prefix of a strictly prior map.

    Caller owns the inter-map causal cutoff (prior map must already have ended
    before the target). This function owns within-map prefix correctness.
    None with status no_hero_kills is known absence; None with status unknown is
    missing evidence. No-frag does not become minute zero. Negative time is valid.
    """
    _cutoff(as_of_seconds)
    times = [event.time for event in prepared.events if event.player_slot == player_slot
             and event.kind == "hero" and event.time is not None and event.time <= as_of_seconds]
    # A later ambiguous event cannot change an already confirmed earliest time.
    issues = _prefix_issues(prepared, min(times) if times else as_of_seconds, player_slot)
    count_issues = _prefix_issues(prepared, as_of_seconds, player_slot)
    if type(player_slot) is not int or player_slot not in EXPECTED_SLOTS or player_slot not in prepared.player_slots:
        issues = sorted(set(issues) | {"player_slot_missing_or_invalid"})
        count_issues = sorted(set(count_issues) | {"player_slot_missing_or_invalid"})
    status = "unknown" if issues else "observed" if times else "no_hero_kills"
    return {"first_hero_kill_min": min(times) / 60 if status == "observed" else None,
            "status": status, "missing": status == "unknown",
            "has_hero_kill": None if issues else bool(times),
            "hero_kill_count": None if count_issues else len(times),
            "candidate_hero_kill_count": len(times), "issues": issues,
            "count_issues": count_issues,
            "as_of_seconds": as_of_seconds}
