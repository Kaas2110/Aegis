"""Read-only export/evaluation of actually journaled forecasts; never reconstruct inputs.

Run from artifacts/ml-service:
  python -m src.research.prospective_journal --outdirectory <new-directory>

DATABASE_URL is read from the process environment, never logged. PostgreSQL reads
use one REPEATABLE READ READ ONLY transaction. The immutable raw JSONL exports are
the sole inputs to evaluation; local pro_matches or provider APIs are never read.
Latest outcome revisions at export time supply labels/eligibility/grouping only.
They NEVER fill a missing observation, feature, team, phase, or model probability.

Fixed game-minute evaluation uses the last eligible past packet within120 game
seconds. Receipt-to-prediction age is checked separately (<=120 wall seconds).
Neither number measures provider/network latency. providerDelayRaw is the declared
DotaTV broadcast delay in seconds, not measured packet latency. A later
checkpoint's frame is never pulled backwards. Repeated frames
are not independent votes; aggregate scores assign equal weight to each map.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import re
import sys

import numpy as np

VERSION = 'prospective_journal_evaluation_v2'
# Hashes of the exact TypeScript contracts; no guessed cross-runtime float hashing.
OBSERVATION_SCHEMA_V2 = '744edb22e1cfc0d27690a4017554e67bc0610f61704e6c4325d3a19782da3e92'
OBSERVATION_SCHEMA_V3 = '56df1c043c1ecb2ea8930c3211c7f754935cdc5079a6e97f520edad34023197b'
MAX_LOCAL_STATE_AGE = 180
MAX_DECLARED_EVENT_DELAY = 300
CHECKPOINTS = (5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60)
MAX_GAME_AGE = 120
MAX_RECEIPT_TO_PREDICTION = 120
MIN_MAPS = 100
MIN_SERIES = 30
SHA256 = re.compile(r'^[0-9a-f]{64}$')
TABLES = ('live_observation_journal', 'live_prediction_journal', 'live_journal_outcomes')


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def positive_id(value):
    return type(value) is int and 0 < value <= 9007199254740991


def timestamp(value):
    if finite(value):
        return float(value) if 0 < value < 253402300799 else None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except (ValueError, OverflowError):
            return None
    if isinstance(value, datetime) and value.tzinfo is not None:
        try:
            result = value.timestamp()
            return result if 0 < result < 253402300799 else None
        except (ValueError, OverflowError, OSError):
            pass
    return None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def valid_hash(value):
    return isinstance(value, str) and SHA256.fullmatch(value) is not None


def feature_schema_hash(names):
    # The producer hashes these two fixed ASCII object keys in this exact order.
    # The payload contains only strings, so no cross-runtime float formatting issue.
    return digest(json_bytes({'names': names, 'version': 'ordered-inference-vector-v1'}))


def evidence_error(evidence):
    if not isinstance(evidence, dict):
        return 'missing_prediction_evidence'
    if not valid_hash(evidence.get('modelHash')):
        return 'missing_or_invalid_model_hash'
    names, values = evidence.get('featureNames'), evidence.get('featureVector')
    if (not isinstance(names, list) or not names or not all(isinstance(n, str) and n for n in names)
            or len(set(names)) != len(names) or not isinstance(values, list) or len(names) != len(values)
            or not all(finite(v) for v in values)):
        return 'invalid_ordered_feature_vector'
    if evidence.get('featureSchemaHash') != feature_schema_hash(names):
        return 'feature_schema_hash_mismatch'
    return None


def latest_outcomes(outcomes, as_of):
    """Latest revision at cutoff, no fallback to an older better-looking revision."""
    grouped, reasons = defaultdict(list), Counter()
    for row in outcomes:
        at = timestamp(row.get('recorded_at'))
        if at is None or not positive_id(row.get('match_id')):
            reasons['invalid_outcome_identity_or_timestamp'] += 1
        elif at > as_of:
            reasons['outcome_revision_after_export_cutoff'] += 1
        else:
            grouped[row['match_id']].append((at, row))
    selected, earliest = {}, {}
    for mid, versions in grouped.items():
        # localIngestedAt is a conservative lower bound, NOT the verified instant
        # at which a winner first became available (the row may predate settlement).
        # Prefer false exclusions to allowing an outcome learned during inference.
        local_bounds = [timestamp(r['outcome'].get('localIngestedAt')) for _, r in versions
                        if isinstance(r.get('outcome'), dict)]
        earliest[mid] = min([at for at, _ in versions] + [t for t in local_bounds if t is not None and t <= as_of])
        last = max(at for at, _ in versions)
        tied = [r for at, r in versions if at == last]
        # An id/hash is not a chronological ordering among conflicting ties.
        if len({json_bytes(r.get('outcome')).hex() for r in tied}) > 1:
            reasons['conflicting_latest_outcome_revisions'] += 1
            continue
        selected[mid] = sorted(tied, key=lambda r: str(r.get('id')))[-1]
    return selected, earliest, reasons


def observation_quality(row):
    """Legacy observations remain descriptive; v3 state eligibility is enforced."""
    schema = row.get('schema_hash')
    if schema == OBSERVATION_SCHEMA_V2:
        return {'contract': 'opendota-observed-live-v2', 'stateQuality': 'legacy_unverified',
                'latencyQuality': 'unmeasured', 'verifiedLatencyEligible': False,
                'lastStateChangeEpoch': None, 'evidence': None}, None
    if schema != OBSERVATION_SCHEMA_V3:
        return None, 'unsupported_observation_schema'
    availability = row.get('availability')
    q = availability.get('liveDataQuality') if isinstance(availability, dict) else None
    if not isinstance(q, dict):
        return None, 'missing_v3_state_quality'
    if q.get('eligibleForObservedStatePrediction') is not True or q.get('reason') is not None:
        return None, 'v3_state_ineligible:' + str(q.get('reason') or 'unverified')
    changed, received, recorded = timestamp(q.get('lastStateChangeReceivedAt')), timestamp(q.get('receivedAt')), timestamp(row.get('recorded_at'))
    age = q.get('stateAgeSeconds')
    if (changed is None or received is None or recorded is None or received != timestamp(row.get('received_at'))
            or not changed <= received <= recorded or not finite(age) or age < 0
            or age + 0.001 < recorded - changed):
        return None, 'invalid_v3_state_clock_evidence'
    if max(age, recorded - changed) >= MAX_LOCAL_STATE_AGE:
        return None, 'v3_observed_state_expired'
    declared = q.get('declaredBroadcastDelaySeconds')
    if declared is not None and (not finite(declared) or declared < 0 or declared > MAX_DECLARED_EVENT_DELAY):
        return None, 'v3_declared_broadcast_delay_exceeds_policy_or_invalid'
    measured = q.get('measuredEndToEndLatencySeconds')
    verified = (q.get('eventLatencyVerified') is True and q.get('meetsVerifiedLiveLatencyPolicy') is True
                and finite(measured) and 0 <= measured <= MAX_DECLARED_EVENT_DELAY)
    return {'contract': 'opendota-observed-live-v3', 'stateQuality': 'eligible_observed_state',
            'latencyQuality': 'producer_reported_verified_within_policy' if verified else 'unmeasured_or_unverified',
            'verifiedLatencyEligible': verified, 'lastStateChangeEpoch': changed, 'evidence': q}, None


def clean_observations(observations, as_of):
    accepted, reasons, quality = {}, Counter(), Counter()
    seen_ids, packets, previous = set(), set(), {}
    ordered = sorted(observations, key=lambda r: (timestamp(r.get('received_at')) or float('inf'), str(r.get('id'))))
    for row in ordered:
        for reason in row.get('quality_reasons') or []:
            quality[str(reason)] += 1
        rid = row.get('id')
        if not isinstance(rid, str) or not rid or rid in seen_ids:
            reasons['missing_or_duplicate_observation_id'] += 1
            continue
        seen_ids.add(rid)
        received, recorded = timestamp(row.get('received_at')), timestamp(row.get('recorded_at'))
        packet = row.get('input')
        if not isinstance(packet, dict):
            reasons['missing_actual_input'] += 1
            continue
        if received is None or recorded is None or received > recorded or recorded > as_of:
            reasons['observation_timestamp_mismatch_or_future'] += 1
            continue
        mid, clock = row.get('match_id'), row.get('game_time_sec')
        if not positive_id(mid) or not positive_id(packet.get('matchId')) or packet.get('matchId') != mid:
            reasons['observation_match_identity_mismatch'] += 1
            continue
        if type(clock) is not int or not -3600 <= clock <= 10800 or packet.get('gameTimeSec') != clock:
            reasons['missing_invalid_or_mismatched_game_clock'] += 1
            continue
        rteam, dteam = packet.get('radiantTeamId'), packet.get('direTeamId')
        if not positive_id(rteam) or not positive_id(dteam) or rteam == dteam:
            reasons['invalid_observed_team_identity'] += 1
            continue
        if not valid_hash(row.get('input_hash')) or not valid_hash(row.get('schema_hash')):
            reasons['missing_observation_hash'] += 1
            continue
        availability = row.get('availability') or {}
        if availability.get('outcomeKnownAtCapture') is not False:
            reasons['outcome_known_at_capture_or_unchecked'] += 1
            continue
        freshness, freshness_error = observation_quality(row)
        if freshness_error:
            reasons[freshness_error] += 1
            continue
        quality['state_quality:' + freshness['stateQuality']] += 1
        quality['latency_quality:' + freshness['latencyQuality']] += 1
        players = packet.get('players')
        complete = (isinstance(players, list) and len(players) == 10
                    and all(isinstance(p, dict) and positive_id(p.get('heroId')) and type(p.get('team')) is int and p.get('team') in (0, 1) for p in players)
                    and len({p['heroId'] for p in players}) == 10
                    and sum(p['team'] == 0 for p in players) == 5)
        expected_phase = 'live' if clock >= 0 else 'post_draft' if complete else 'pre_draft'
        if row.get('phase') != expected_phase or availability.get('draftComplete') is not complete:
            reasons['observation_phase_or_draft_evidence_mismatch'] += 1
            continue
        scores = (packet.get('radiantScore'), packet.get('direScore'))
        if clock >= 0 and any(type(s) is not int or s < 0 for s in scores):
            reasons['invalid_live_score'] += 1
            continue
        key = (mid, row['input_hash'])
        if key in packets:
            reasons['duplicate_provider_packet'] += 1
            continue
        packets.add(key)
        old = previous.get(mid)
        if old:
            old_clock, old_scores, old_teams = old
            if old_teams != (rteam, dteam):
                reasons['observed_team_identity_changed'] += 1
                continue
            if clock < old_clock or (clock >= 0 and old_clock >= 0 and any(a < b for a, b in zip(scores, old_scores))):
                reasons['regressing_game_clock_or_score'] += 1
                continue
        previous[mid] = (clock, scores, (rteam, dteam))
        accepted[rid] = {**row, '_received': received, '_recorded': recorded, '_freshness': freshness}
    return accepted, reasons, quality


def group_spec(prediction, observation):
    ev = prediction['evidence']
    return {'producer': prediction.get('producer'), 'modelVersion': prediction.get('model_version'),
            'modelHash': ev['modelHash'], 'featureSchemaHash': ev['featureSchemaHash'],
            'observationSchemaHash': observation['schema_hash'], 'phase': prediction['phase'], 'market': prediction['market'],
            'observationContract': observation['_freshness']['contract'], 'stateQuality': observation['_freshness']['stateQuality'],
            'latencyQuality': observation['_freshness']['latencyQuality']}


def series_group(outcome, packet):
    sid = outcome.get('seriesId')
    if positive_id(sid):
        return 'series:' + str(sid), True
    # Explicitly labelled heuristic, never claimed to verify an independent series.
    day = int(outcome['startTime']) // 86400
    pair = sorted((packet['radiantTeamId'], packet['direTeamId']))
    return f'heuristic:{pair[0]}:{pair[1]}:{packet.get("leagueId")}:{day}', False


def collect_predictions(predictions, observations, outcomes, earliest_outcome, as_of):
    candidates, reasons, counts = defaultdict(list), Counter(), Counter()
    metadata, eligible, seen = {}, defaultdict(set), set()
    for pred in sorted(predictions, key=lambda r: (timestamp(r.get('predicted_at')) or float('inf'), str(r.get('id')))):
        counts[str(pred.get('status'))] += 1
        if pred.get('status') != 'predicted':
            reasons['producer:' + str(pred.get('reason') or pred.get('status'))] += 1
            continue
        if pred.get('id') in seen or not isinstance(pred.get('id'), str):
            reasons['duplicate_or_missing_prediction_id'] += 1
            continue
        seen.add(pred['id'])
        obs = observations.get(pred.get('observation_id'))
        if obs is None:
            reasons['observation_unavailable_or_rejected'] += 1
            continue
        at = timestamp(pred.get('predicted_at'))
        if at is None or at < obs['_recorded'] or at < obs['_received'] or at > as_of:
            reasons['prediction_timestamp_mismatch_or_future'] += 1
            continue
        receipt_age = at - obs['_received']
        if receipt_age > MAX_RECEIPT_TO_PREDICTION:
            reasons['stale_receipt_to_prediction'] += 1
            continue
        changed = obs['_freshness']['lastStateChangeEpoch']
        if changed is not None and at - changed >= MAX_LOCAL_STATE_AGE:
            reasons['observed_state_expired_before_prediction'] += 1
            continue
        phase = ('pregame_model_during_live' if pred.get('producer') == 'prematch_context' and obs['phase'] == 'live' else obs['phase'])
        if pred.get('phase') != phase:
            reasons['prediction_phase_mismatch'] += 1
            continue
        error = evidence_error(pred.get('evidence'))
        if error:
            reasons[error] += 1
            continue
        if not isinstance(pred.get('model_version'), str) or not pred['model_version'] or not isinstance(pred.get('producer'), str):
            reasons['missing_model_version_or_producer'] += 1
            continue
        if pred.get('market') != 'map_winner':
            reasons['market_not_in_winner_evaluator'] += 1
            continue
        output = pred.get('output')
        probability = output.get('radiantWinProbability') if isinstance(output, dict) else None
        if not finite(probability) or not 0 <= probability <= 1:
            reasons['invalid_actual_probability'] += 1
            continue
        spec = group_spec(pred, obs)
        key = digest(json_bytes(spec))
        metadata[key] = spec
        eligible[key].add(obs['match_id'])
        label = outcomes.get(obs['match_id'])
        if label is None:
            reasons['no_resolved_outcome_at_export'] += 1
            continue
        value = label.get('outcome')
        if (not isinstance(value, dict) or not positive_id(value.get('matchId')) or value.get('matchId') != obs['match_id']
                or value.get('radiantTeamId') != obs['input']['radiantTeamId']
                or value.get('direTeamId') != obs['input']['direTeamId']):
            reasons['outcome_match_or_team_identity_mismatch'] += 1
            continue
        if not valid_hash(label.get('evidence_hash')) or type(value.get('radiantWin')) is not bool:
            reasons['invalid_outcome_winner_or_hash'] += 1
            continue
        if value.get('localIngestedAt') is not None:
            local_at = timestamp(value['localIngestedAt'])
            if local_at is None or local_at > timestamp(label['recorded_at']):
                reasons['invalid_outcome_ingestion_timestamp'] += 1
                continue
        if earliest_outcome[obs['match_id']] <= at:
            reason = ('outcome_conservatively_known_before_prediction'
                      if earliest_outcome[obs['match_id']] < timestamp(label['recorded_at'])
                      else 'outcome_recorded_before_prediction')
            reasons[reason] += 1
            continue
        duration, start = value.get('durationSec'), value.get('startTime')
        if not finite(duration) or duration <= 0 or not finite(start) or start <= 0:
            reasons['invalid_label_time_axis'] += 1
            continue
        if start + duration > timestamp(label['recorded_at']):
            reasons['outcome_recorded_before_its_end_time'] += 1
            continue
        if obs['game_time_sec'] >= duration:
            reasons['observation_at_or_after_final_game_clock'] += 1
            continue
        if obs['game_time_sec'] >= 0 and obs['_received'] < start:
            reasons['live_observation_received_before_label_start'] += 1
            continue
        if any(type(value.get(key)) is int and value[key] >= 0 and type(obs['input'].get(key)) is int
               and obs['input'][key] > value[key] for key in ('radiantScore', 'direScore')):
            reasons['observed_score_exceeds_verified_final'] += 1
            continue
        # Finite label score not required for winner evaluation and never fills input.
        group, known = series_group(value, obs['input'])
        candidates[key].append({'match_id': obs['match_id'], 'observation_id': obs['id'], 'prediction_id': pred['id'],
            'game_time_sec': obs['game_time_sec'], 'received_at': obs['received_at'], 'predicted_at': pred['predicted_at'],
            '_received': obs['_received'], '_predicted': at, 'receipt_to_prediction_sec': receipt_age,
            'providerDelayRaw': obs['input'].get('providerDelayRaw'), 'quality_reasons': obs.get('quality_reasons') or [],
            'observationContract': obs['_freshness']['contract'], 'stateQuality': obs['_freshness']['stateQuality'],
            'latencyQuality': obs['_freshness']['latencyQuality'], 'verifiedLatencyEligible': obs['_freshness']['verifiedLatencyEligible'],
            'liveDataQuality': obs['_freshness']['evidence'],
            'providerTimeFieldsRaw': {k:v for k,v in obs['input'].items() if k.startswith('provider') and k.endswith('Raw')},
            'p': float(probability), 'winner': int(value['radiantWin']), 'group': group, 'known_series': known,
            'duration_sec_label': duration, 'outcome_revision_id': label['id'], 'outcome_evidence_hash': label['evidence_hash'],
            'phase': phase})
    return candidates, metadata, eligible, reasons, counts


def select_checkpoints(rows):
    bymap, selected, coverage = defaultdict(list), [], {}
    for r in rows:
        bymap[r['match_id']].append(r)
    phase = rows[0]['phase'] if rows else None
    if phase in ('pre_draft', 'post_draft'):
        # One last actually predicted negative-game-clock packet per map and phase.
        for rr in bymap.values():
            chosen = max(rr, key=lambda r: (r['_predicted'], r['prediction_id']))
            selected.append({**chosen, 'minute': 'before_start', 'checkpoint_game_age_sec': None})
        coverage['before_start'] = {'resolved_maps_with_predictions': len(bymap), 'evaluated_maps': len(selected)}
        return selected, coverage
    for minute in CHECKPOINTS:
        covered = Counter()
        for rr in bymap.values():
            if rr[0]['duration_sec_label'] <= minute * 60:
                covered['game_finished_before_checkpoint'] += 1
                continue
            covered['resolved_maps_still_playing'] += 1
            past = [r for r in rr if 0 <= r['game_time_sec'] <= minute * 60]
            if not past:
                covered['no_past_prediction'] += 1
                continue
            chosen = max(past, key=lambda r: (r['game_time_sec'], r['_predicted'], r['prediction_id']))
            age = minute * 60 - chosen['game_time_sec']
            if age > MAX_GAME_AGE:
                covered['stale_game_checkpoint'] += 1
                continue
            selected.append({**chosen, 'minute': minute, 'checkpoint_game_age_sec': age})
            covered['evaluated_maps'] += 1
        coverage[str(minute)] = dict(covered)
    return selected, coverage


def weights(rows):
    counts = Counter(r['match_id'] for r in rows)
    w = np.array([1 / counts[r['match_id']] for r in rows])
    return w / w.sum()


def bootstrap(rows, values, repeats=1000):
    groups = sorted({r['group'] for r in rows})
    if len(groups) < 2:
        return None
    index = {g: i for i, g in enumerate(groups)}
    values = np.atleast_2d(values)
    if values.shape[0] != len(rows):
        values = values.T
    w = weights(rows)
    mass, totals = np.zeros(len(groups)), np.zeros((len(groups), values.shape[1]))
    for r, weight, value in zip(rows, w, values):
        i = index[r['group']]
        mass[i] += weight
        totals[i] += weight * value
    rng, estimates = np.random.default_rng(42), []
    for _ in range(repeats):
        multiplicity = np.bincount(rng.integers(0, len(groups), len(groups)), minlength=len(groups))
        estimates.append((multiplicity @ totals) / (multiplicity @ mass))
    return np.quantile(estimates, [.025, .975], axis=0).T.tolist()


def score(rows):
    if not rows:
        return {'status': 'no_resolved_samples', 'maps': 0, 'series': 0, 'frames': 0, 'metrics': None}
    w = weights(rows)
    y = np.array([r['winner'] for r in rows], float)
    p = np.clip(np.array([r['p'] for r in rows]), 1e-6, 1 - 1e-6)
    losses = np.column_stack([((p >= .5) == y).astype(float), (p - y) ** 2, -y*np.log(p)-(1-y)*np.log1p(-p)])
    maps, series = len({r['match_id'] for r in rows}), len({r['group'] for r in rows})
    known = all(r['known_series'] for r in rows)
    enough = maps >= MIN_MAPS and series >= MIN_SERIES and known
    ci = bootstrap(rows, losses)
    bins, ece = [], 0.
    for i in range(10):
        mask = (p >= i/10) & (p < (i+1)/10)
        if not mask.any():
            continue
        mass = w[mask].sum()
        mean, observed = np.average(p[mask], weights=w[mask]), np.average(y[mask], weights=w[mask])
        ece += mass * abs(mean-observed)
        bins.append({'from': i/10, 'to': (i+1)/10, 'rows': int(mask.sum()), 'weight': float(mass), 'predicted': float(mean), 'observed': float(observed)})
    return {'status': 'descriptive_sufficient_sample' if enough else 'insufficient_sample_for_significance',
            'maps': maps, 'series': series, 'frames': len(rows), 'all_series_ids_verified': known,
            'metrics': dict(zip(('accuracy', 'brier', 'logloss'), map(float, w @ losses))), 'ece_10': float(ece), 'calibration_bins': bins,
            'series_bootstrap_95ci': dict(zip(('accuracy', 'brier', 'logloss'), ci)) if ci is not None else None,
            'ci_interpretation': 'descriptive_only; correlated maps grouped; heuristic groups and small samples do not support significance claims',
            'provider_delay_semantics': 'declared DotaTV broadcast delay seconds; not measured event latency',
            'verified_latency_eligible_frames': sum(r.get('verifiedLatencyEligible') is True for r in rows),
            'accuracy_95_percent_claim': False}


def compare_groups(groups, specs):
    comparisons = []
    for a, b in itertools.combinations(sorted(groups), 2):
        if specs[a]['phase'] != specs[b]['phase'] or specs[a]['observationSchemaHash'] != specs[b]['observationSchemaHash']:
            continue
        # Stronger than same map+minute: exact same received observation required.
        key = lambda r: (r['match_id'], r['minute'], r['observation_id'])
        aa, bb = {key(r): r for r in groups[a]}, {key(r): r for r in groups[b]}
        common = sorted(aa.keys() & bb.keys(), key=str)
        ra, rb = [aa[k] for k in common], [bb[k] for k in common]
        item = {'left': a, 'right': b, 'alignment': 'same map, checkpoint and observation_id', 'common_frames': len(common),
                'left_unmatched_frames': len(aa)-len(common), 'right_unmatched_frames': len(bb)-len(common),
                'left_common_only': score(ra), 'right_common_only': score(rb)}
        if common:
            y = np.array([r['winner'] for r in ra]);p=np.array([r['p'] for r in ra]);q=np.array([r['p'] for r in rb])
            assert all(l['winner']==r['winner'] and l['outcome_revision_id']==r['outcome_revision_id'] for l,r in zip(ra,rb))
            delta=np.column_stack([((q>=.5)==y).astype(float)-((p>=.5)==y).astype(float),(q-y)**2-(p-y)**2])
            item['right_minus_left'] = dict(zip(('accuracy','brier'), map(float, weights(ra) @ delta)))
            ci=bootstrap(ra,delta);item['paired_series_95ci']=dict(zip(('accuracy','brier'),ci)) if ci is not None else None
            item['significance_claim'] = False  # no automatic superiority decision or multiple-comparison fishing
        comparisons.append(item)
    return comparisons


def evaluate(observations, predictions, outcomes, as_of):
    as_of = timestamp(as_of)
    if as_of is None:
        raise ValueError('invalid_export_cutoff')
    labels, first_label, label_reasons = latest_outcomes(outcomes, as_of)
    clean, obs_reasons, quality = clean_observations(observations, as_of)
    candidates, specs, eligible, pred_reasons, statuses = collect_predictions(predictions, clean, labels, first_label, as_of)
    groups, selected = {}, {}
    for key, spec in specs.items():
        rows, coverage = select_checkpoints(candidates.get(key, []))
        selected[key] = rows
        minutes = ('before_start',) if spec['phase'] in ('pre_draft','post_draft') else CHECKPOINTS
        groups[key] = {'identity': spec, 'maps_with_valid_prediction_evidence': len(eligible[key]),
                       'aggregate_equal_maps': score(rows), 'minutes': {str(m): score([r for r in rows if r['minute']==m]) for m in minutes},
                       'coverage': coverage}
    inventory=Counter((str(r.get('producer')),str(r.get('market')),str(r.get('phase')),str(r.get('status'))) for r in predictions)
    report = {'version': VERSION, 'status': 'evaluated' if any(selected.values()) else 'no_resolved_samples',
              'cutoff_epoch': as_of, 'raw_counts': {'observations':len(observations),'predictions':len(predictions),'outcome_revisions':len(outcomes)},
              'accepted_observations':len(clean), 'latest_resolved_labels':len(labels), 'prediction_statuses':dict(statuses),
              'prediction_inventory':[{'producer':k[0],'market':k[1],'phase':k[2],'status':k[3],'count':v} for k,v in sorted(inventory.items())],
              'observation_exclusions':dict(obs_reasons),'prediction_exclusions':dict(pred_reasons),'outcome_exclusions':dict(label_reasons),
              'raw_quality_reason_counts':dict(quality),'groups':groups,'paired_comparisons':compare_groups(selected,specs),
              'policy': {'checkpoints':CHECKPOINTS,'max_game_checkpoint_age_sec':MAX_GAME_AGE,'max_receipt_to_prediction_sec':MAX_RECEIPT_TO_PREDICTION,
                         'minimum_maps':MIN_MAPS,'minimum_verified_series':MIN_SERIES,'bootstrap_repeats':1000,'bootstrap_seed':42,
                         'latency':'Measured event latency is separate from declared broadcast delay, local state age and receipt age. Unknown latency never passes the verified live latency cohort.',
                         'max_local_state_age_sec':MAX_LOCAL_STATE_AGE,'max_declared_event_delay_sec':MAX_DECLARED_EVENT_DELAY,
                         'legacy_v2':'Retained in a separate legacy_unverified descriptive cohort; never credited as latency-verified live performance.',
                         'v3':'Requires eligible actual state quality; expired/ineligible observations and predictions are excluded with reasons.',
                         'model_hash_validation':'Producer-reported hash format, exact ordered schema hash checked. No claim of independent artifact-store verification.',
                         'raw_hash_validation':'Raw export bytes SHA256; observation input_hash preserved, not recomputed with incompatible cross-runtime JSON numeric serialization.',
                         'markets':'Winner only. Totals retained in raw export and reason counts, no totals metric is claimed.',
                         'future_labels':'Latest as of export; labels only, no input enrichment; exclude after earliest journal recorded_at OR localIngestedAt across revisions. The latter is a conservative bound, not exact first winner availability.',
                         'selection':'Past game clock only; no future frame, no majority vote, no same-data model tuning.'}}
    # Selected rows retain linkage, actual probability and clocks; input vectors stay in raw predictions.
    return report, {k:[{n:v for n,v in r.items() if not n.startswith('_')} for r in rr] for k,rr in selected.items()}


def export_database(outdirectory, max_rows=500000):
    """Create a new output directory. Never reuse/overwrite a previous export."""
    outdirectory=Path(outdirectory)
    outdirectory.mkdir(parents=True, exist_ok=False)
    url=os.environ.get('DATABASE_URL')
    if not url:
        raise ValueError('DATABASE_URL_not_set')
    import psycopg
    manifest={'version':VERSION,'files':{},'transaction':'REPEATABLE READ READ ONLY','active':False}
    exported={}
    with psycopg.connect(url, autocommit=True, connect_timeout=10) as conn:
        conn.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        try:
            conn.execute("SET LOCAL statement_timeout = '120s'")
            conn.execute("SET LOCAL TIME ZONE 'UTC'")
            cutoff=conn.execute('SELECT transaction_timestamp()').fetchone()[0]
            for table in TABLES:
                count=conn.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
                if count>max_rows:
                    raise ValueError('journal_export_row_cap_exceeded')
                path=outdirectory/(table+'.jsonl');rows=[];h=hashlib.sha256()
                with path.open('xb') as stream, conn.cursor(name='export_'+table) as cursor:
                    cursor.execute(f'SELECT row_to_json(t)::text FROM {table} t ORDER BY id')
                    for (raw,) in cursor:
                        line=(raw+'\n').encode('utf-8');stream.write(line);h.update(line);rows.append(json.loads(raw))
                exported[table]=rows
                manifest['files'][path.name]={'sha256':h.hexdigest(),'bytes':path.stat().st_size,'rows':len(rows)}
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise
    report, selected=evaluate(*(exported[n] for n in TABLES), cutoff)
    for name,obj in [('report.json',report),('selected-predictions.json',selected)]:
        data=json.dumps(obj,ensure_ascii=False,indent=2,allow_nan=False).encode('utf-8')
        with (outdirectory/name).open('xb') as stream:stream.write(data)
        manifest['files'][name]={'sha256':digest(data),'bytes':len(data)}
    source=Path(__file__).read_bytes()
    with (outdirectory/'evaluator-source.py').open('xb') as stream:stream.write(source)
    manifest['files']['evaluator-source.py']={'sha256':digest(source),'bytes':len(source)}
    manifest.update({'cutoff':cutoff.isoformat(),'evaluator_sha256':digest(source),'status':report['status']})
    with (outdirectory/'manifest.json').open('xb') as stream:stream.write(json_bytes(manifest))
    return report


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--outdirectory',required=True,type=Path)
    parser.add_argument('--max-rows-per-table',type=int,default=500000)
    args=parser.parse_args(argv)
    if args.max_rows_per_table<1:parser.error('max rows must be positive')
    try:
        report=export_database(args.outdirectory,args.max_rows_per_table)
    except Exception as error:
        # psycopg exceptions/DSNs can carry credentials. Never echo raw exception text.
        print(json.dumps({'status':'export_failed','error_type':type(error).__name__,'existing_outputs_never_overwritten':True}),file=sys.stderr)
        return 1
    print(json.dumps({'status':report['status'],'counts':report['raw_counts'],'groups':len(report['groups'])}))
    return 0


if __name__=='__main__':
    raise SystemExit(main())
