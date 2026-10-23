"""Wide causal-context × observed-clock/score features. No fitting or external IO.

This is a research feature builder, not an activated model or proof of timely
coverage. It preserves every column of the frozen 7148 postdraft schema. A
historically reconstructed context remains explicitly distinct from observed
receipt-time context. Current player GPM, items and final results are not inputs.
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import hashlib
import json
import math
import numpy as np

CONTRACT = 'wide-history-observed-state-v1'
NAMES_SHA = '6cda9871540f2044018c5ba69492e5853199a14d35f1b08e4f3ef4edeac89e1a'
GROUPS_SHA = 'b10876f425f7197501c305c48dbbe919bef401bccc4143e5af896a3a22782846'
MODES = ('historical_end_plus_300_reconstruction', 'observed_receipt_context')
MULTIPLIERS = ('clock_minutes', 'log1p_clock_minutes', 'kill_difference',
               'kill_total', 'kill_pace')
STATE_NAMES = ('clock_minutes', 'log1p_clock_minutes', 'clock_capped_at_80',
               'clock_80plus', 'radiant_kills', 'dire_kills', 'kill_difference',
               'kill_total', 'kill_pace', 'kill_share_radiant')
WINDOWS = (60, 180, 300, 600)
TRAJECTORY_NAMES = ('coverage', 'span_seconds', 'samples', 'kill_diff_per_minute',
                    'kill_total_per_minute', 'minimum_kill_diff',
                    'maximum_kill_diff', 'recovery_from_minimum',
                    'retreat_from_maximum', 'lead_sign_changes',
                    'since_last_kill_lead_change_seconds')


class ContractError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def timestamp(value, name):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ContractError('invalid_' + name)
    return float(value)


def integer(value, name, minimum=0):
    if type(value) is not int or not minimum <= value <= 2**53-1:
        raise ContractError('invalid_' + name)
    return value


@dataclass(frozen=True)
class Schema:
    prior_names: tuple[str, ...]
    prior_groups: tuple[str, ...]
    value_indices: tuple[int, ...]

    @classmethod
    def load(cls, dataset):
        dataset = Path(dataset)
        values = []
        for name, digest in [('feature-names.json', NAMES_SHA), ('feature-groups.json', GROUPS_SHA)]:
            raw = (dataset / name).read_bytes()
            if hashlib.sha256(raw).hexdigest() != digest:
                raise ContractError('prior_schema_pin_mismatch')
            values.append(json.loads(raw))
        names, groups = values
        if len(names) != 7148 or len(set(names)) != len(names) or set(names) != set(groups):
            raise ContractError('prior_schema_mismatch')
        return cls(tuple(names), tuple(groups[n] for n in names),
                   tuple(i for i, n in enumerate(names) if not n.endswith('__missing')))

    def names(self):
        prior = ['prior__' + n for n in self.prior_names]
        state = ['state__' + n for n in STATE_NAMES]
        history = ['trajectory__' + str(w) + 's__' + n for w in WINDOWS for n in TRAJECTORY_NAMES]
        history += ['trajectory__reset', 'trajectory__missing']
        products = ['interaction__' + m + '__' + self.prior_names[i]
                    for m in MULTIPLIERS for i in self.value_indices]
        return prior + state + history + products


def state(packet):
    if not isinstance(packet, dict):
        raise ContractError('state_object_required')
    return {
        'match_id': integer(packet.get('match_id'), 'match_id', 1),
        'clock_seconds': integer(packet.get('clock_seconds'), 'clock_seconds'),
        'radiant_kills': integer(packet.get('radiant_kills'), 'radiant_kills'),
        'dire_kills': integer(packet.get('dire_kills'), 'dire_kills'),
        'available_at': timestamp(packet.get('available_at'), 'available_at'),
    }


def prefix(current, history):
    """Receipt-ordered, observed-score trajectories; never future game frames.

    Missing/duplicate/regressed clocks reset trajectory explicitly. Future
    receipts are ignored; already-received states with an inconsistent clock or
    decreasing score cannot silently be used as a valid previous observation.
    """
    accepted = []
    reset = False
    previous_receipt = -math.inf
    for raw in history:
        p = state(raw)
        if p['match_id'] != current['match_id']:
            raise ContractError('history_map_mismatch')
        if p['available_at'] > current['available_at']:
            continue
        if p['available_at'] < previous_receipt:
            raise ContractError('history_not_receipt_ordered')
        previous_receipt = p['available_at']
        if p['clock_seconds'] >= current['clock_seconds'] or any(
                p[k] > current[k] for k in ('radiant_kills', 'dire_kills')):
            accepted = []
            reset = True
            continue
        if accepted and (p['clock_seconds'] <= accepted[-1]['clock_seconds'] or any(
                p[k] < accepted[-1][k] for k in ('radiant_kills', 'dire_kills'))):
            accepted = []
            reset = True
        accepted.append(p)
    return accepted, reset


def trajectory(current, history):
    history, reset = prefix(current, history)
    features = []
    for window in WINDOWS:
        points = [p for p in history if current['clock_seconds'] - window <= p['clock_seconds']]
        if not points:
            features += [0., *([math.nan] * (len(TRAJECTORY_NAMES)-1))]
            continue
        points.append(current)
        span = current['clock_seconds'] - points[0]['clock_seconds']
        diffs = [p['radiant_kills'] - p['dire_kills'] for p in points]
        totals = [p['radiant_kills'] + p['dire_kills'] for p in points]
        nonzero = [(p['clock_seconds'], np.sign(d)) for p, d in zip(points, diffs) if d]
        changes = [b[0] for a, b in zip(nonzero, nonzero[1:]) if a[1] != b[1]]
        features += [span/window, float(span), float(len(points)),
                     (diffs[-1]-diffs[0])*60/span, (totals[-1]-totals[0])*60/span,
                     float(min(diffs)), float(max(diffs)), float(diffs[-1]-min(diffs)),
                     float(max(diffs)-diffs[-1]), float(len(changes)),
                     float(current['clock_seconds']-changes[-1]) if changes else math.nan]
    return features + [float(reset), float(not history)], reset


def build(schema, *, prior_vector, context, current, history=()):
    """Project whitelisted state and supplied pinned, causal prior vector.

    context metadata is a caller assertion verified by the dataset/runtime join;
    it cannot make a retro source into proof of historical provider receipt.
    No winner/duration/current final statistics are consumed from input objects.
    """
    c = state(current)
    if context.get('mode') not in MODES:
        raise ContractError('explicit_context_provenance_required')
    if context.get('match_id') != c['match_id']:
        raise ContractError('context_map_mismatch')
    if context.get('feature_schema_sha256') != NAMES_SHA:
        raise ContractError('context_schema_mismatch')
    target_start = timestamp(context.get('target_start'), 'target_start')
    outcome_cutoff = timestamp(context.get('latest_prior_outcome_available_at'), 'prior_outcome_cutoff')
    if outcome_cutoff >= target_start or target_start > c['available_at']:
        raise ContractError('prior_outcome_not_before_target')
    receipt_verified = context['mode'] == 'observed_receipt_context'
    if receipt_verified:
        latest_receipt = timestamp(context.get('latest_prior_receipt_at'), 'prior_receipt')
        built_at = timestamp(context.get('context_built_at'), 'context_built_at')
        if latest_receipt > target_start:
            raise ContractError('prior_receipt_after_target')
        if built_at < latest_receipt:
            raise ContractError('context_built_before_input_receipt')
        if built_at > c['available_at']:
            raise ContractError('context_built_in_future')
    a = np.asarray(prior_vector)
    if a.shape != (len(schema.prior_names),) or a.dtype != np.dtype('float32') or np.isinf(a).any():
        raise ContractError('prior_vector_contract')
    expected_hash = hashlib.sha256(a.astype('<f4', copy=False).tobytes()).hexdigest()
    if context.get('feature_vector_sha256') != expected_hash:
        raise ContractError('prior_vector_hash_mismatch')
    minute = c['clock_seconds']/60
    r, d = c['radiant_kills'], c['dire_kills']
    diff, total = r-d, r+d
    pace = total/minute if minute > 0 else math.nan
    values = [minute, math.log1p(minute), min(minute, 80), float(minute >= 80),
              r, d, diff, total, pace, r/total if total else math.nan]
    past, reset = trajectory(c, history)
    multipliers = [minute, math.log1p(minute), diff, total, pace]
    selected = a[list(schema.value_indices)].astype(np.float64)
    # Missing values propagate; 0*NaN stays NaN. No learned constant imputation.
    products = np.concatenate([selected*m for m in multipliers])
    vector = np.concatenate([a, np.asarray(values+past), products]).astype('<f4')
    if np.isinf(vector).any():
        raise ContractError('interaction_float32_overflow')
    return vector, {
        'contract': CONTRACT, 'context_mode': context['mode'],
        'context_receipt_asserted': receipt_verified, 'receipt_independently_verified': False,
        'feature_count': len(vector), 'all_prior_columns_preserved': True,
        'trajectory_reset': reset, 'active': False, 'quality_claims_allowed': False,
        'input_scope': 'causal_past_context_and_current_observed_clock_hero_kills_only',
        'current_player_gpm_used': False, 'current_networth_used': False,
        'current_final_fields_used': False,
        'vector_sha256': hashlib.sha256(vector.tobytes()).hexdigest(),
    }
