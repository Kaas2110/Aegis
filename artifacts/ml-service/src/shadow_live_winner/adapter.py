"""Pinned runtime shadow comparator. No database, fit, provider or active-model imports."""
from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import math
import re
import lightgbm as lgb
import numpy as np

PACKAGE_ROOT = Path(__file__).resolve().parent
CONTRACT = 'observed_live_winner_runtime_shadow_v1'
MODEL_FILE = 'shared_before80.model.txt'
MODEL_SHA256 = 'a0a5c6c8293ae0dd5d4009d25cf22ba81f6d49eefc03ecf047cb1e061851c806'
MAX_HISTORY = 256
SOURCE_PINS = {
    'source/architecture_contract.py': '1e2dce1034dcdd788c84ad1c27ed2c9ca95e512e4096f65a285481e55257f16f',
    'source/run_comparison.py': 'faa3fcafa109725c41e8faa7906d79d2088d3dc0e3572b6dcb2ff4e4703beeba',
    'protocol.json': '5dfafe946f32a5c31a4ac20498e454901f9ed171ea5c348cd943ed1ac328ff9a',
    'features.npz': '8f3081b7342966c808b667fee6226a462617d6effdae64c60ca5efe3283d2a2e',
    'rows.json': '56ed8e7b77e164f2418e1ae645faad87861e28bba02d06e49b3f677f1aa336a6',
    'fit-report.json': '41d558cb6219a563c6c88ff28b61791ec121cfcb617a09d983be619a8a73dc1b',
}
BASE_NAMES = ['observed_game_minutes', 'radiant_score', 'dire_score', 'kill_diff', 'total_kills',
              'kills_per_minute', 'raw_provider_lead_k', 'draft_valid']
TRAJ_NAMES = [f'{name}_{window}' for window in (120, 300) for name in
              ('trajectory_available', 'actual_gap_minutes', 'raw_lead_slope_k', 'total_kill_slope', 'kill_diff_slope')]
FEATURE_NAMES = BASE_NAMES + TRAJ_NAMES + [f'observed_draft_signed_hero_{i}' for i in range(1, 251)]


class ContractError(ValueError):
    pass


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical_hash(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8'))


def finite(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def integer(value, name, minimum=None):
    if type(value) is not int or abs(value) > 2**53-1 or (minimum is not None and value < minimum):
        raise ContractError('missing_or_invalid_' + name)
    return value


def timestamp(value):
    if not isinstance(value, str):
        raise ContractError('timestamp_required')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ContractError('invalid_timestamp') from exc
    if parsed.tzinfo is None:
        raise ContractError('timezone_required')
    return parsed.astimezone(timezone.utc)


def checked_bytes(relative, expected):
    path = (PACKAGE_ROOT / relative).resolve()
    allowed = {'assets/' + MODEL_FILE, 'reference/architecture_contract.py',
               'feature_contract.json', 'adapter.py', 'router.py'}
    if not path.is_relative_to(PACKAGE_ROOT) or relative not in allowed:
        raise ContractError('artifact_path_not_whitelisted')
    raw = path.read_bytes()
    if digest(raw) != expected:
        raise ContractError('source_or_artifact_sha256_mismatch:' + relative)
    return raw


def validate_manifest(value):
    if value.get('contract') != CONTRACT or value.get('candidateId') != 'observed-v2-shared-before80-diagnostic':
        raise ContractError('candidate_contract_mismatch')
    if value.get('artifact') != {'filename': 'assets/' + MODEL_FILE, 'sha256': MODEL_SHA256}:
        raise ContractError('artifact_whitelist_mismatch')
    if value.get('featureNames') != FEATURE_NAMES or value.get('dtype') != 'float32':
        raise ContractError('feature_order_or_dtype_mismatch')
    if value.get('featureSchemaHash') != canonical_hash({'names': FEATURE_NAMES, 'dtype': 'float32', 'missing': 'json_null_mask_to_nan'}):
        raise ContractError('feature_schema_hash_mismatch')
    if value.get('sourcePins') != SOURCE_PINS:
        raise ContractError('source_contract_mismatch')
    if value.get('target') != 'map_radiant_win' or value.get('engine') != 'lightgbm_text_binary':
        raise ContractError('target_or_engine_mismatch')
    if value.get('adapterClockSupport') != {'minSeconds': 300, 'maxSeconds': 4772}:
        raise ContractError('clock_support_mismatch')
    if any(value.get(k) is not False for k in ('active', 'eligibleForServing', 'eligibleForPromotion', 'prospectiveValidated')):
        raise ContractError('shadow_flags_must_remain_false')
    if set(value.get('packageFiles', {})) != {'assets/' + MODEL_FILE, 'reference/architecture_contract.py',
                                             'feature_contract.json', 'adapter.py', 'router.py'}:
        raise ContractError('package_file_whitelist_mismatch')


def normalize_observation(envelope, expected_match_id, *, now=None):
    if not isinstance(envelope, dict):
        raise ContractError('observation_required')
    for field, expected in [('source', 'opendota'), ('targetScope', 'map'), ('clockUnit', 'seconds'), ('scoreUnit', 'kills')]:
        if envelope.get(field) != expected:
            raise ContractError('source_scope_or_units_mismatch:' + field)
    oid = envelope.get('observationId')
    if not isinstance(oid, str) or not re.fullmatch('[0-9a-f]{64}', oid):
        raise ContractError('observation_id_required')
    received, recorded = timestamp(envelope.get('receivedAt')), timestamp(envelope.get('recordedAt'))
    now = now or datetime.now(timezone.utc)
    if received > recorded or recorded > now:
        raise ContractError('future_or_inconsistent_receipt')
    packet = envelope.get('input')
    if not isinstance(packet, dict):
        raise ContractError('input_object_required')
    for part in (envelope, packet):
        if (part.get('synthetic') is True or part.get('backfill') is True
                or part.get('source') in ('synthetic', 'backfill')):
            raise ContractError('synthetic_or_backfill_observation')
    mid = integer(packet.get('matchId'), 'match_id', 1)
    if mid != integer(expected_match_id, 'expected_match_id', 1):
        raise ContractError('current_map_identity_mismatch')
    radiant = integer(packet.get('radiantTeamId'), 'radiant_team_id', 1)
    dire = integer(packet.get('direTeamId'), 'dire_team_id', 1)
    if radiant == dire:
        raise ContractError('same_team_on_both_sides')
    lead = packet.get('radiantLead')
    if not finite(lead):
        raise ContractError('missing_or_invalid_raw_provider_lead')
    players = packet.get('players')
    normalized_players = []
    if isinstance(players, list):
        for p in players:
            p = p if isinstance(p, dict) else {}
            hero = p.get('heroId')
            if type(hero) is int and hero > 250:
                raise ContractError('hero_outside_pinned_schema')
            normalized_players.append({'heroId': hero if type(hero) is int and 0 < hero <= 250 else None,
                                       'team': p.get('team') if type(p.get('team')) is int and p['team'] in (0, 1) else None})
    normalized_players.sort(key=lambda p: (2 if p['team'] is None else p['team'], p['heroId'] or 0))
    return {'observationId': oid, 'receivedAt': received.isoformat(), 'recordedAt': recorded.isoformat(),
            'matchId': mid, 'radiantTeamId': radiant, 'direTeamId': dire,
            'gameTimeSec': integer(packet.get('gameTimeSec'), 'game_clock'),
            'radiantScore': integer(packet.get('radiantScore'), 'radiant_score', 0),
            'direScore': integer(packet.get('direScore'), 'dire_score', 0),
            'radiantLead': lead, 'players': normalized_players}


def causal_history(current, history, expected_match_id):
    """Past receipts only. Future rows do not alter the earlier vector or input hash."""
    if not isinstance(history, list):
        raise ContractError('history_list_required')
    if len(history) > MAX_HISTORY:
        raise ContractError('history_limit_exceeded')
    retained, seen = [], set()
    cutoff = timestamp(current['receivedAt'])
    for raw in history:
        if not isinstance(raw, dict):
            raise ContractError('history_observation_required')
        if timestamp(raw.get('receivedAt')) > cutoff:
            continue
        item = normalize_observation(raw, expected_match_id)
        if timestamp(item['recordedAt']) > timestamp(current['recordedAt']):
            raise ContractError('history_recorded_after_current_cutoff')
        if item['observationId'] == current['observationId'] or item['observationId'] in seen:
            raise ContractError('duplicate_observation_identity')
        if (item['radiantTeamId'], item['direTeamId']) != (current['radiantTeamId'], current['direTeamId']):
            raise ContractError('history_side_identity_mismatch')
        if item['gameTimeSec'] < 0 or item['gameTimeSec'] >= current['gameTimeSec']:
            raise ContractError('history_clock_not_strictly_past')
        if retained and (timestamp(item['receivedAt']) < timestamp(retained[-1]['receivedAt'])
                         or timestamp(item['recordedAt']) < timestamp(retained[-1]['recordedAt'])
                         or item['gameTimeSec'] <= retained[-1]['gameTimeSec']
                         or item['radiantScore'] < retained[-1]['radiantScore']
                         or item['direScore'] < retained[-1]['direScore']):
            raise ContractError('history_not_monotone_in_receipt_order')
        if item['radiantScore'] > current['radiantScore'] or item['direScore'] > current['direScore']:
            raise ContractError('current_score_regressed')
        seen.add(item['observationId'])
        retained.append(item)
    return retained


def build_features(current, history):
    """Exact frozen v2 Float32 formula, with native trained missingness."""
    t, r, d = current['gameTimeSec'], current['radiantScore'], current['direScore']
    if t <= 0:
        raise ContractError('positive_feature_clock_required')
    players = current['players']
    valid = (len(players) == 10 and all(p['heroId'] is not None and p['team'] is not None for p in players)
             and sum(p['team'] == 0 for p in players) == 5 and len({p['heroId'] for p in players}) == 10)
    values = [t / 60, r, d, r-d, r+d, (r+d)/(t/60), current['radiantLead']/1000, int(valid)]
    contributing = []
    for window in (120, 300):
        older = [p for p in history if p['gameTimeSec'] <= t-window and t-window-p['gameTimeSec'] <= 120]
        if not older:
            values.extend([0, np.nan, np.nan, np.nan, np.nan])
            continue
        prior = older[-1]
        gap = (t-prior['gameTimeSec'])/60
        values.extend([1, gap, (current['radiantLead']-prior['radiantLead'])/1000/gap,
                       (r+d-prior['radiantScore']-prior['direScore'])/gap,
                       (r-d-prior['radiantScore']+prior['direScore'])/gap])
        contributing.append({'windowSeconds': window, 'observationId': prior['observationId'],
                             'observationHash': canonical_hash(prior), 'receivedAt': prior['receivedAt']})
    heroes = np.zeros(250) if valid else np.full(250, np.nan)
    if valid:
        for p in players:
            heroes[p['heroId']-1] = 1 if p['team'] == 0 else -1
    vector = np.asarray(values + heroes.tolist(), dtype=np.float32)
    if vector.shape != (268,) or np.isinf(vector).any():
        raise ContractError('invalid_feature_vector')
    return vector, contributing


def encode_vector(vector):
    return [None if np.isnan(v) else float(v) for v in vector], np.isnan(vector).tolist()


def decode_vector(values, missing):
    if (not isinstance(values, list) or not isinstance(missing, list)
            or len(values) != 268 or len(missing) != 268
            or any(type(mask) is not bool or (value is None) != mask or (not mask and not finite(value))
                   for value, mask in zip(values, missing))):
        raise ContractError('nullable_vector_mask_mismatch')
    array = np.asarray([np.nan if mask else value for value, mask in zip(values, missing)], dtype=np.float32)
    if np.isinf(array).any():
        raise ContractError('feature_float32_overflow')
    return array


class RuntimeShadowWinnerAdapter:
    def __init__(self):
        from .pins import MANIFEST_SHA256
        raw = (PACKAGE_ROOT / 'manifest.json').read_bytes()
        if digest(raw) != MANIFEST_SHA256:
            raise ContractError('manifest_sha256_mismatch')
        self.manifest = json.loads(raw)
        validate_manifest(self.manifest)
        self.manifest_hash = MANIFEST_SHA256
        files = {relative: checked_bytes(relative, expected) for relative, expected in self.manifest['packageFiles'].items()}
        feature_contract = json.loads(files['feature_contract.json'])
        if feature_contract != {'version': 'observed-live-architecture-comparison-v2',
                                'sourceSha256': SOURCE_PINS['source/architecture_contract.py'],
                                'names': FEATURE_NAMES, 'dtype': 'float32', 'missing': 'json_null_mask_to_nan',
                                'trajectoryWindowsSeconds': [120, 300], 'olderFrameToleranceSeconds': 120}:
            raise ContractError('packaged_feature_contract_mismatch')
        text = files['assets/' + MODEL_FILE].decode('utf-8')
        if re.findall(r'^objective=(.+)$', text, re.MULTILINE) != ['binary sigmoid:1']:
            raise ContractError('binary_objective_mismatch')
        self.model = lgb.Booster(model_str=text)
        if self.model.num_feature() != 268 or self.model.feature_name() != ['Column_' + str(i) for i in range(268)]:
            raise ContractError('booster_feature_schema_mismatch')

    def predict(self, envelope, history, *, expected_match_id):
        if not isinstance(history, list) or len(history) > MAX_HISTORY:
            raise ContractError('history_limit_exceeded')
        current = normalize_observation(envelope, expected_match_id)
        computed = datetime.now(timezone.utc)
        base = {'contract': CONTRACT, 'tag': 'shadow_map_winner', 'candidateId': self.manifest['candidateId'],
                'executionMode': 'runtime_shadow', 'active': False,
                'eligibleForServing': False, 'eligibleForPromotion': False, 'prospectiveValidated': False,
                'target': 'map_radiant_win', 'targetScope': 'map',
                'computedAt': computed.isoformat(), 'receivedAt': current['receivedAt'],
                'recordedAt': current['recordedAt'], 'observationId': current['observationId'],
                'matchId': current['matchId'], 'currentObservationHash': canonical_hash(current),
                'modelSha256': MODEL_SHA256, 'manifestSha256': self.manifest_hash,
                'featureSchemaHash': self.manifest['featureSchemaHash'], 'sourceHashes': dict(SOURCE_PINS),
                'calibrationMethod': 'none', 'calibratedProbability': None,
                'eventLatencyVerified': False, 'measuredEndToEndLatencySeconds': None,
                'meetsVerifiedLiveLatencyPolicy': False,
                'qualityReasons': ['research_model_shadow_only', 'event_latency_unknown',
                                   'historical_model_not_prospectively_validated'],
                'note': 'Runtime shadow only; receipt retained. Prospective eligibility is decided by the collector ledger.'}
        clock = current['gameTimeSec']
        if clock < 0:
            reason = 'post_draft_model_unavailable'
        elif clock < 300:
            reason = 'early_phase_outside_adapter_support'
        elif clock >= 4800:
            reason = 'tail80_model_unavailable'
        elif clock > 4772:
            reason = 'outside_empirical_training_clock_support'
        else:
            reason = None
        if reason:
            return {**base, 'status': 'unavailable', 'reason': reason, 'rawProbability': None,
                    'featureValues': None, 'missingMask': None}
        past = causal_history(current, history, expected_match_id)
        vector, contributing = build_features(current, past)
        values, missing = encode_vector(vector)
        # JSON null -> native NaN is explicit and validated, never zero-filled.
        restored = decode_vector(values, missing)
        probability = float(self.model.predict(restored.reshape(1, -1), num_threads=1)[0])
        if not finite(probability) or not 0 <= probability <= 1:
            raise ContractError('invalid_model_probability')
        history_lineage = [{'observationId': p['observationId'], 'observationHash': canonical_hash(p),
                            'receivedAt': p['receivedAt']} for p in past]
        model_input = {'current': current, 'historyLineageInReceiptOrder': history_lineage,
                       'contributingHistory': contributing,
                       'featureValues': values, 'missingMask': missing,
                       'featureSchemaHash': base['featureSchemaHash']}
        return {**base, 'status': 'shadow_predicted', 'reason': None,
                'rawProbability': probability, 'featureNames': list(FEATURE_NAMES),
                'featureValues': values, 'missingMask': missing, 'featureDtype': 'float32',
                'featureVectorHash': canonical_hash({'values': values, 'missingMask': missing}),
                'inputHash': canonical_hash(model_input), 'contributingHistory': contributing,
                'historyLineageInReceiptOrder': history_lineage,
                'historyPolicy': 'same_map_past_receipts_monotone_clock_scores',
                'clockSupport': self.manifest['adapterClockSupport'],
                'clockGeneralizationStatus': 'checkpoint_sampled_training_continuous_clock_unvalidated'}
