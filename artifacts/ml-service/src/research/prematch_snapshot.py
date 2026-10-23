"""Pure shadow-only adapter for the existing causal prematch feature formulas.

No I/O, predictions, model publication, current aggregate tables, or DB writes.
Input history is raw completed match payloads. ``receivedAt`` means the time
this exact outcome payload was received, not its latest refresh timestamp.
Absent timestamps on archived rows explicitly reconstruct end + 300 seconds.
Malformed explicit timestamps never fall back to reconstructed availability.

Target draftKnownAt/rosterKnownAt are required for those views. IDs and hero
arrays must retain the player-slot alignment used by the research contract.
The caller supplies known team/series context; optional teamsKnownAt and
seriesKnownAt allow the adapter to reject unavailable context. plannedStartAt
is metadata only. Actual target start, duration, scores and winner are ignored.

Historical late enrichment is conservatively omitted, not retroactively applied
at outcome arrival. Conflicting available revisions are excluded. A versioned
event store and online state persistence remain separate integration work.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import json

from .causal_dataset import (BASE_NAMES, CONTRACT, DRAFT_NAMES, ROSTER_NAMES,
                             History, finite_number, valid_picks)

SNAPSHOT_VERSION = "prematch_shadow_snapshot_v1"
FEATURE_NAMES = {"base": BASE_NAMES, "draft": BASE_NAMES + DRAFT_NAMES,
                 "roster": BASE_NAMES + DRAFT_NAMES + ROSTER_NAMES}


def timestamp(value):
    """UTC epoch seconds; reject bool, NaN, naive datetimes and naive ISO text."""
    if finite_number(value):
        return float(value) if 0 < value < 253402300799 else None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (ValueError, OverflowError):
            return None
    if isinstance(value, datetime) and value.tzinfo is not None:
        try:
            result = value.timestamp()
            return result if finite_number(result) and result > 0 else None
        except (ValueError, OverflowError, OSError):
            pass
    return None


def timestamp_field(row, camel, snake):
    """Return present, parsed. Conflicting aliases are an explicit error."""
    values = [timestamp(row[key]) for key in (camel, snake) if key in row]
    if not values:
        return False, None
    if any(v is None for v in values) or len(set(values)) != 1:
        return True, None
    return True, values[0]


def positive_id(value):
    return type(value) is int and value > 0


def valid_accounts(radiant, dire):
    return (isinstance(radiant, list) and isinstance(dire, list)
            and len(radiant) == len(dire) == 5
            and all(type(v) is int and 0 < v < 4294967295 for v in radiant + dire)
            and len(set(radiant + dire)) == 10)


def _mask_part(row, part):
    suffix = "picks" if part == "draft" else "account_ids"
    row[f"radiant_{suffix}"] = None
    row[f"dire_{suffix}"] = None


def _history_part(raw, row, part, available_at, mode, diagnostics):
    present, known = timestamp_field(raw, part + "KnownAt", part + "_known_at")
    if present and known is None:
        diagnostics[part + "_invalid_known_at"] += 1
        _mask_part(row, part)
        return False
    if present and known > available_at:
        diagnostics[part + "_late_enrichment_omitted"] += 1
        _mask_part(row, part)
        return False
    if part == "draft":
        valid = valid_picks(row.get("radiant_picks"), row.get("dire_picks"))
    else:
        # Historical updates already support individually observed players.
        # Keep valid partial account slots: requiring ten known accounts here
        # would silently change the batch player-history feature contract.
        valid = False
        for side in ("radiant", "dire"):
            key = side + "_account_ids"
            accounts = row.get(key)
            if isinstance(accounts, list) and len(accounts) == 5:
                row[key] = [v if type(v) is int and 0 < v < 4294967295 else None for v in accounts]
                valid = True
            else:
                row[key] = None
    if not valid:
        _mask_part(row, part)
        diagnostics[part + "_incomplete_or_invalid"] += 1
        return False
    if not present:
        diagnostics[part + ("_reconstructed" if mode == "reconstructed" else "_payload_received_at")] += 1
    return True


def _history_row(raw, as_of, target_id, excluded):
    if not isinstance(raw, dict):
        excluded["invalid_row"] += 1
        return None
    match_id = raw.get("match_id")
    if not positive_id(match_id):
        excluded["invalid_match_id"] += 1
        return None
    if match_id == target_id:
        excluded["target_match"] += 1
        return None
    # Ignore a future receipt before inspecting the future outcome payload.
    present, received = timestamp_field(raw, "receivedAt", "received_at")
    if present and received is None:
        excluded["invalid_received_at"] += 1
        return None
    if present and received >= as_of:
        excluded["outcome_not_yet_received"] += 1
        return None
    start = timestamp(raw.get("start_time"))
    duration = raw.get("duration")
    if start is None or start >= as_of:
        excluded["invalid_or_future_start"] += 1
        return None
    if not finite_number(duration) or not 600 <= duration <= 10800:
        excluded["invalid_duration"] += 1
        return None
    ended = start + duration
    if present and received < ended:
        excluded["received_before_match_end"] += 1
        return None
    available = received if present else ended + 300
    if available >= as_of:
        excluded["outcome_not_yet_available"] += 1
        return None
    radiant, dire = raw.get("radiant_team_id"), raw.get("dire_team_id")
    if not positive_id(radiant) or not positive_id(dire) or radiant == dire:
        excluded["invalid_teams"] += 1
        return None
    winner = raw.get("radiant_win")
    if type(winner) not in (bool, int) or winner not in (0, 1):
        excluded["invalid_outcome"] += 1
        return None
    row = {key: raw.get(key) for key in (
        "match_id", "radiant_team_id", "dire_team_id", "series_id", "series_type",
        "radiant_picks", "dire_picks", "radiant_account_ids", "dire_account_ids")}
    row.update(start_time=start, duration=duration, radiant_win=bool(winner))
    if not positive_id(row["series_id"]):
        row["series_id"] = None
    if type(row["series_type"]) is not int or row["series_type"] not in (0, 1, 2):
        row["series_type"] = None
    for key in ("radiant_score", "dire_score"):
        value = raw.get(key)
        row[key] = value if finite_number(value) and value >= 0 else None
    mode = "observed" if present else "reconstructed"
    diagnostics = Counter()
    draft = _history_part(raw, row, "draft", available, mode, diagnostics)
    if draft:
        _history_part(raw, row, "roster", available, mode, diagnostics)
    else:
        _mask_part(row, "roster")
        diagnostics["roster_without_draft_omitted"] += 1
    # Only fields that affect History are included in the revision identity.
    identity = json.dumps(row, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {"row": row, "available": available, "mode": mode,
            "diagnostics": diagnostics, "identity": identity}


def _target_part(fixture, row, part, as_of, reasons):
    present, known = timestamp_field(fixture, part + "KnownAt", part + "_known_at")
    if not present:
        reason = "missing_known_at"
    elif known is None:
        reason = "invalid_known_at"
    elif known > as_of:
        reason = "not_yet_known"
    elif part == "draft" and not valid_picks(row.get("radiant_picks"), row.get("dire_picks")):
        reason = "incomplete_or_invalid_picks"
    elif part == "roster" and not valid_accounts(row.get("radiant_account_ids"), row.get("dire_account_ids")):
        reason = "incomplete_or_invalid_accounts"
    else:
        return
    reasons[part].append(reason)
    _mask_part(row, part)


def _coverage(history, fixture, used, excluded, diagnostics):
    teams = {}
    for side in ("radiant", "dire"):
        team = fixture.get(side + "_team_id")
        records = history.teams.get(team, []) if positive_id(team) else []
        teams[side] = {"maps180d": len(records),
                       "lastOutcomeAvailableAt": records[-1][0] if records else None}
    modes = Counter(item["mode"] for item in used)
    return {"usedOutcomes": len(used), "observedOutcomes": modes["observed"],
            "reconstructedOutcomes": modes["reconstructed"],
            "oldestOutcomeAvailableAt": min((item["available"] for item in used), default=None),
            "latestOutcomeAvailableAt": history.latest_outcome or None,
            "excludedRows": dict(sorted(excluded.items())),
            "historicalFeatureAvailability": dict(sorted(diagnostics.items())),
            "teams": teams, "teamHistoryDays": 180,
            "eloHeroPlayerHistory": "all prior eligible outcomes; not limited to training window"}


def build_prematch_snapshot(matches, fixture, as_of):
    """Build one deterministic, non-persistent prematch shadow snapshot.

    Known positive but unseen teams receive the same smoothed priors as batch
    research, with zero coverage. Missing/invalid team IDs block every view.
    Outcome arrivals are strictly earlier than asOf; known target inputs may
    equal asOf. Identical duplicate payloads count once. Conflicting available
    revisions of one map fail closed and cannot double-update state.
    """
    now = timestamp(as_of)
    if now is None:
        raise ValueError("as_of must be a positive UTC timestamp")
    if not isinstance(fixture, dict):
        raise ValueError("fixture must be a mapping of known prematch context")
    target = {key: fixture.get(key) for key in (
        "match_id", "radiant_team_id", "dire_team_id", "series_id", "series_type",
        "radiant_picks", "dire_picks", "radiant_account_ids", "dire_account_ids")}
    target["start_time"] = now  # only the prediction clock reaches the formulas
    reasons = {view: [] for view in FEATURE_NAMES}
    if (not positive_id(target["radiant_team_id"]) or not positive_id(target["dire_team_id"])
            or target["radiant_team_id"] == target["dire_team_id"]):
        reasons["base"].append("unknown_or_invalid_teams")
    present, known = timestamp_field(fixture, "teamsKnownAt", "teams_known_at")
    if present and (known is None or known > now):
        reasons["base"].append("invalid_or_future_teams_known_at")
    present, known = timestamp_field(fixture, "seriesKnownAt", "series_known_at")
    context_notes = []
    if present and (known is None or known > now):
        target["series_id"], target["series_type"] = None, None
        context_notes.append("series_context_not_known_at_prediction")
    if target["series_type"] is not None and (type(target["series_type"]) is not int or target["series_type"] not in (0, 1, 2)):
        target["series_type"] = None
        context_notes.append("invalid_series_type")
    if target["series_type"] is None:
        context_notes.append("unknown_series_format_uses_existing_contract_zero")
    _target_part(fixture, target, "draft", now, reasons)
    _target_part(fixture, target, "roster", now, reasons)
    if reasons["draft"]:
        reasons["roster"].append("draft_unavailable")
        _mask_part(target, "roster")

    excluded, diagnostics, candidates = Counter(), Counter(), {}
    for raw in matches:
        item = _history_row(raw, now, target.get("match_id"), excluded)
        if item is not None:
            candidates.setdefault(item["row"]["match_id"], []).append(item)
    used = []
    for versions in candidates.values():
        if len({v["identity"] for v in versions}) > 1:
            excluded["conflicting_available_revisions"] += len(versions)
            continue
        # Prefer observed provenance on an exact timestamp tie.
        item = min(versions, key=lambda v: (v["available"], v["mode"] != "observed"))
        excluded["duplicate_payload"] += len(versions) - 1
        used.append(item)
    used.sort(key=lambda v: (v["available"], v["row"]["match_id"]))
    history = History()
    for item in used:
        history.update(item["row"], available_at=item["available"])
        diagnostics.update(item["diagnostics"])
    features = {view: None for view in FEATURE_NAMES}
    if not reasons["base"]:
        base, draft, roster = history.features(target, as_of=now)
        features["base"] = base
        if draft is not None:
            features["draft"] = base + draft
        if draft is not None and roster is not None:
            features["roster"] = base + draft + roster
    else:
        for view in ("draft", "roster"):
            reasons[view].append("base_unavailable")
    # Prune target team recency deques also for blocked snapshots, for coverage.
    for key in ("radiant_team_id", "dire_team_id"):
        if positive_id(target[key]):
            history._team(target[key], now)
    coverage = _coverage(history, target, used, excluded, diagnostics)
    observed, reconstructed = coverage["observedOutcomes"], coverage["reconstructedOutcomes"]
    availability = "mixed" if observed and reconstructed else "observed" if observed else "reconstructed" if reconstructed else "none"
    return {"features": features, "featureNames": {k: list(v) for k, v in FEATURE_NAMES.items()},
            "availableViews": [k for k, v in features.items() if v is not None],
            "unavailableReasons": {k: v for k, v in reasons.items() if v},
            "metadata": {"snapshotVersion": SNAPSHOT_VERSION, "featuresVersion": CONTRACT,
                         "asOf": datetime.fromtimestamp(now, timezone.utc).isoformat(), "asOfUnix": now,
                         "plannedStartAt": timestamp(fixture.get("plannedStartAt")),
                         "historyAvailability": availability, "historyCoverage": coverage,
                         "contextNotes": context_notes, "shadowOnly": True,
                         "eligibleForServing": False, "eligibleForPromotion": False,
                         "limitations": ["historical end+300 availability is reconstructed, not a measured arrival",
                                         "target phase and team/series context must be verified by caller",
                                         "late historical enrichment omitted; no revision event replay",
                                         "no model prediction, persistence, serving integration or prospective validation"]}}
