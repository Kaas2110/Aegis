"""Portable stdlib research contract: schema3 final rosters and as-of inputs.
No imports from workspace engines, database clients, numpy or network code.
This is an overlay candidate; not installed into the application.
"""
from __future__ import annotations
from collections import Counter
from datetime import datetime
import math


def valid_picks(radiant, dire):
    """Identity validation only; mirrors the existing causal_dataset contract."""
    return (isinstance(radiant, list) and isinstance(dire, list)
            and len(radiant) == len(dire) == 5
            and all(type(h) is int and 0 < h < 1000 for h in radiant + dire)
            and len(set(radiant + dire)) == 10)


CONTRACT = 'schema3_asof_player_profiles_v1'
MODES = ('historical_reconstruction', 'observed_receipt')
SLOTS = (0, 1, 2, 3, 4, 128, 129, 130, 131, 132)
LAG = 300  # Match existing research formulas; never labelled measured latency.
FINAL_STATS = ('gold_per_min', 'xp_per_min', 'kills', 'deaths', 'assists',
               'hero_damage', 'tower_damage', 'last_hits', 'lane_role')


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def stamp(value):
    if value is None:
        return None
    if finite(value) and value > 0:
        return float(value)
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError as exc:
            raise ValueError('invalid_timestamp') from exc
    else:
        raise ValueError('invalid_timestamp')
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError('timestamp_requires_timezone')
    return parsed.timestamp()


def positive_id(value):
    return type(value) is int and value > 0


def account(value):
    return value if type(value) is int and 0 < value < 4294967295 else None


def clocks(row):
    """parsed_at is the receipt of the latest merged DB payload, not original availability."""
    explicit = stamp(row.get('received_at'))
    parsed = stamp(row.get('parsed_at'))
    if explicit is not None and parsed is not None and explicit != parsed:
        raise ValueError('conflicting_receipt_times')
    received = explicit if explicit is not None else parsed
    observed = stamp(row.get('observed_at'))
    if observed is not None and received is not None and observed > received:
        raise ValueError('observation_after_receipt')
    return dict(received_at=received, observed_at=observed,
                receipt_basis='explicit_collector_receipt' if explicit is not None
                else 'latest_merged_payload_parsed_at' if parsed is not None else 'unknown')


def final_roster(row):
    """Only side/slot/account/hero pairing is recovered; order and bans stay unknown."""
    if not positive_id(row.get('match_id')):
        raise ValueError('invalid_match_id')
    if type(row.get('payload_schema_version')) is not int or row['payload_schema_version'] < 3:
        raise ValueError('schema3_required')
    players = row.get('players')
    if not isinstance(players, list) or len(players) != 10 or any(not isinstance(p, dict) for p in players):
        raise ValueError('ten_players_required')
    if any(type(p.get('player_slot')) is not int for p in players):
        raise ValueError('invalid_player_slots')
    if sorted(p['player_slot'] for p in players) != list(SLOTS):
        raise ValueError('invalid_player_slots')
    ordered = sorted(players, key=lambda p: p['player_slot'])
    picks = [[p.get('hero_id') for p in ordered[:5]], [p.get('hero_id') for p in ordered[5:]]]
    if not valid_picks(*picks):
        raise ValueError('invalid_or_duplicate_heroes')
    ids = [account(p.get('account_id')) for p in ordered]
    known = [a for a in ids if a is not None]
    if len(known) != len(set(known)):
        raise ValueError('duplicate_known_accounts')
    projected = [dict(player_slot=p['player_slot'], hero_id=p['hero_id'], account_id=a)
                 for p, a in zip(ordered, ids)]
    return dict(match_id=row['match_id'], radiant=projected[:5], dire=projected[5:],
                provenance='schema3_parsed_final_roster', **clocks(row),
                order_basis='sorted_player_slot_not_draft_pick_order',
                draft_order=None, bans=None, draft_observed_at=None,
                timely_draft_proven=False, eligible_for_serving=False,
                phase='historical_postdraft_reconstruction')


def roster_for_phase(roster, phase):
    if phase != 'historical_postdraft_reconstruction':
        raise ValueError('final_roster_not_proven_for_requested_phase')
    if roster.get('provenance') != 'schema3_parsed_final_roster' or roster.get('timely_draft_proven') is not False:
        raise ValueError('invalid_final_roster_contract')
    return ([dict(p) for p in roster['radiant']], [dict(p) for p in roster['dire']])


def select_history(rows, *, target_match_id, cutoff, mode):
    if mode not in MODES:
        raise ValueError('explicit_availability_mode_required')
    if not positive_id(target_match_id):
        raise ValueError('target_match_id_required')
    cutoff = stamp(cutoff)
    if cutoff is None:
        raise ValueError('cutoff_required')
    selected, rejected, seen = [], Counter(), set()
    for row in rows:
        mid = row.get('match_id')
        if mid == target_match_id:
            rejected['target_match_excluded'] += 1
            continue  # Never inspect the target's outcome/final scalars.
        if not positive_id(mid):
            raise ValueError('invalid_history_match_id')
        if mid in seen:
            raise ValueError('duplicate_history_match_id')
        seen.add(mid)
        start = stamp(row.get('start_time'))
        duration = row.get('duration')
        if start is None or not finite(duration) or duration <= 0:
            raise ValueError('invalid_history_duration')
        # Keep the existing research clock. No claim that wall end includes pauses.
        end = start + duration
        effective = end + LAG
        if effective >= cutoff:
            rejected['event_at_or_after_cutoff'] += 1
            continue
        if type(row.get('radiant_win')) is not bool:
            rejected['completed_outcome_missing'] += 1
            continue
        roster = final_roster(row)
        receipt = roster['received_at']
        if receipt is not None and receipt < end:
            rejected['receipt_before_reconstructed_completion'] += 1
            continue
        if mode == 'observed_receipt' and receipt is None:
            rejected['receipt_unknown'] += 1
            continue
        if mode == 'observed_receipt' and receipt >= cutoff:
            rejected['receipt_at_or_after_cutoff'] += 1
            continue
        selected.append(dict(row=row, roster=roster, match_id=mid, started_at=start,
                             completed_event_at=end, profile_event_at=effective,
                             received_at=receipt, observed_at=roster['observed_at']))
    selected.sort(key=lambda e: (e['profile_event_at'], e['match_id']))
    contract = dict(version=CONTRACT, availability_mode=mode, target_match_id=target_match_id,
                    event_cutoff=cutoff, receipt_cutoff=cutoff if mode=='observed_receipt' else None,
                    excludes_target_match=True, selected_maps=len(selected), rejected=dict(rejected),
                    source_max_completed_at=max((e['completed_event_at'] for e in selected), default=None),
                    source_max_received_at=max((e['received_at'] for e in selected if e['received_at'] is not None), default=None),
                    unknown_receipt_maps=sum(e['received_at'] is None for e in selected),
                    history_clock='reconstructed_start_plus_duration_plus300',
                    ordering='profile_event_at_then_match_id; not original arrival order',
                    historical_reconstruction_only=mode=='historical_reconstruction',
                    eligible_for_serving=False)
    return selected, contract
