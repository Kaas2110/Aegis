"""Prespecified file-only base16 refit. No provider calls or model activation.

Archive outcomes use the established end+300 reconstruction, not measured
historical arrival. The prospective Oct 4 reserve is never queried or used.
"""
from __future__ import annotations
import argparse
import base64
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path

for key in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
    os.environ[key] = '4'

import numpy as np
import psycopg
from psycopg.rows import dict_row
from ..main import TrainRequest, TrainSample, train, _deserialize_bundle
from .causal_dataset import BASE_NAMES, CONTRACT, DAY, prematch_rows, split_rows
from .evaluation import grouped_metrics, reliability
from .run_window_comparison import (active_models, assert_disjoint, epoch, paired_intervals,
                                    sha, summary, utc, window_train)

BOUNDARIES = ('2026-09-01', '2026-09-15', '2026-09-23')
RESERVED = '2026-10-04'
PROTOCOL = 'fresh_base_refit_v1'


def immutable_json(path, value):
    encoded = json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False)
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(encoded + '\n')


def flags():
    return {'validationStatus': 'exploratory_fresh_base_candidate', 'active': False,
            'eligibleForServing': False, 'eligibleForPromotion': False,
            'blockers': ['reconstructed_historical_arrivals', 'historical_holdout_already_exposed',
                         'prospective_confirmation_required', 'online_prediction_contract_not_validated']}


def source_hashes():
    folder = Path(__file__).parent
    paths = [folder / name for name in ('run_fresh_base.py', 'causal_dataset.py', 'prematch_snapshot.py',
                                        'run_window_comparison.py', 'evaluation.py')]
    paths.append(folder.parent / 'main.py')
    return {path.name: sha(path) for path in paths}


def select_frames(rows, as_of):
    cap = min(as_of, epoch(RESERVED))
    # No label from or extending into the reserved period reaches any split.
    usable = [r for r in rows if r['start'] < cap and r['label_available'] < cap]
    splits, manifest = split_rows(usable, boundaries=[epoch(v) for v in BOUNDARIES])
    cutoff = epoch(BOUNDARIES[0]) - DAY
    splits['train'] = window_train(splits['train'], splits['train'], cutoff, 365)
    assert_disjoint(splits)
    for name, minimum in (('train', 500), ('validation', 30), ('calib', 20), ('test', 50)):
        if len(splits[name]) < minimum:
            raise ValueError(f'insufficient prespecified {name}; do not move boundaries after fitting')
    return splits, manifest


def prior_exposure(previous, earlier, test_rows):
    known = {}
    previous_protocol = json.loads((previous / 'protocol.json').read_text(encoding='utf-8'))
    earlier_manifest = json.loads((earlier / 'prematch-split-manifest.json').read_text(encoding='utf-8'))
    sources = {'earlier_causal_test': earlier_manifest['splits']['test']['match_ids'],
               'earlier_window_test_before_roster_filter': previous_protocol['split_manifest']['splits']['test']['match_ids']}
    test_ids = {r['match_id'] for r in test_rows}
    for name, ids in sources.items():
        known[name] = {'overlapping_maps': len(test_ids & set(ids)), 'test_maps': len(test_ids)}
    return known


def prepare(out, previous, earlier):
    if (out / 'design.json').exists():
        raise ValueError('immutable design exists; refusing to redefine this experiment')
    old = json.loads((previous / 'protocol.json').read_text(encoding='utf-8'))
    selection = json.loads((previous / 'selection.json').read_text(encoding='utf-8'))
    if selection['selected_windows']['base'] != 365:
        raise ValueError('expected previously selected base365 configuration')
    design = {'protocol': PROTOCOL, 'registered_at': datetime.now(timezone.utc).isoformat(),
      'boundaries_utc': list(BOUNDARIES), 'reserved_from_utc': utc(epoch(RESERVED)),
      'train_window_days': 365, 'purge_seconds': DAY, 'features': BASE_NAMES,
      'parameters': old['model_parameters'], 'source_hashes': source_hashes(),
      'prior_protocol_sha256': sha(previous / 'protocol.json'), 'prior_selection_sha256': sha(previous / 'selection.json'),
      'selection': 'one fixed base365 configuration; validation binary log loss selects stopping iteration only',
      'calibration': 'none; calibration partition retained untouched; no calibration fitting or selection',
      'baselines': {'elo_only': 'base[1], chronological historical Elo prior', 'constant_half': 0.5},
      'classification_threshold': 0.5, 'bootstrap_replicates': 2000, 'bootstrap_seed': 42,
      'uncertainty': 'paired whole-series and separate UTC-day cluster bootstrap; equal-map estimand; exploratory',
      'cohort': 'all eligible base maps, no draft/roster coverage filter',
      'historical_availability': 'reconstructed outcome end+300 seconds; not measured provider receipt', **flags()}
    immutable_json(out / 'design.json', design)
    with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row) as connection:
        connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        connection.execute("SET LOCAL statement_timeout='120s'")
        as_of = float(connection.execute('SELECT extract(epoch FROM transaction_timestamp()) AS now').fetchone()['now'])
        cap = min(as_of, epoch(RESERVED))
        matches = connection.execute('''SELECT match_id,start_time,duration,radiant_team_id,dire_team_id,
          radiant_win,radiant_score,dire_score,series_id,series_type,league_id
          FROM pro_matches WHERE start_time < %s AND start_time+duration+300 < %s
          AND radiant_team_id>0 AND dire_team_id>0 AND radiant_team_id<>dire_team_id
          AND duration BETWEEN 600 AND 10800 AND radiant_win IS NOT NULL
          ORDER BY start_time,match_id''', (cap, cap)).fetchall()
        active = active_models(connection)
    source_data_hash = hashlib.sha256(json.dumps(matches, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    rows = prematch_rows(matches)
    splits, manifest = select_frames(rows, cap)
    keys = ('match_id', 'group', 'start', 'label_available', 'latest_feature_outcome', 'base', 'winner')
    frozen = {name: [{key: row[key] for key in keys} for row in data] for name, data in splits.items()}
    immutable_json(out / 'frozen-dataset.json', frozen)
    feature_contract = {'featuresVersion': CONTRACT, 'names': BASE_NAMES, 'count': len(BASE_NAMES),
      'view': 'base', 'availability': design['historical_availability'],
      'history_semantics': 'Training eligibility 365 days. Team queues 180 days; Elo/H2H retain all prior eligible history.',
      'target_context': 'Historical team and series metadata are unverified at actual prediction time.',
      'patch_features': 'none; never infer exact tournament patch from calendar', **flags()}
    immutable_json(out / 'feature-contract.json', feature_contract)
    protocol = {**design, 'design_sha256': sha(out / 'design.json'), 'prepared_at': datetime.now(timezone.utc).isoformat(),
      'data_as_of_utc': utc(as_of), 'effective_upper_exclusive_utc': utc(cap), 'source_data_sha256': source_data_hash,
      'dataset_sha256': sha(out / 'frozen-dataset.json'), 'feature_contract_sha256': sha(out / 'feature-contract.json'),
      'active_models_before': active, 'split_manifest_before_train_window': manifest,
      'split_summaries': {name: summary(data) for name, data in splits.items()},
      'split_months': {name: dict(sorted(Counter(utc(r['start'])[:7] for r in data).items())) for name,data in splits.items()},
      'test_prior_exposure': prior_exposure(previous, earlier, splits['test']),
      'limitations': ['Exploratory retrospective refit; historical test labels were exposed in prior experiments.',
        'Sparse recent coverage may be selected by collection availability and not representative of all professional play.',
        'Feature availability reconstructed at outcome end+300, not actual archival receipt.',
        'No exact letter-patch match labels and no patch features; calendar dates are not ground truth.',
        'All base maps retained; not directly comparable to the earlier roster-intersection window experiment.',
        'Recent test is small; cluster confidence intervals are exploratory and not multiplicity-adjusted.',
        'The Oct 4 prospective reserve remains separate and unused.'], 'database_writes': 0, 'provider_requests': 0}
    immutable_json(out / 'protocol.json', protocol)
    print(json.dumps({k: protocol[k] for k in ('split_summaries', 'split_months', 'test_prior_exposure', 'dataset_sha256')}, indent=2))


def frozen_inputs(out):
    protocol = json.loads((out / 'protocol.json').read_text(encoding='utf-8'))
    if protocol['source_hashes'] != source_hashes():
        raise ValueError('source changed after preregistration')
    for key, filename in [('design_sha256', 'design.json'), ('dataset_sha256', 'frozen-dataset.json'),
                          ('feature_contract_sha256', 'feature-contract.json')]:
        if protocol[key] != sha(out / filename):
            raise ValueError(f'frozen {filename} changed')
    return protocol, json.loads((out / 'frozen-dataset.json').read_text(encoding='utf-8'))


def fit(out):
    protocol, frozen = frozen_inputs(out)
    if (out / 'fit.json').exists() or list(out.glob('*.joblib')):
        raise ValueError('model already fitted; refusing repeat or post-test refit')
    samples = lambda rows: [TrainSample(features=r['base'], label=r['winner']) for r in rows]
    req = TrainRequest(label='fresh-base365-research', feature_names=BASE_NAMES,
      train=samples(frozen['train']), validation=samples(frozen['validation']), calib=[], test=[], **protocol['parameters'])
    response = train(req)
    blob = base64.b64decode(response.blob_b64)
    model = _deserialize_bundle(blob)['model']
    path = out / 'fresh-base365.joblib'
    with path.open('xb') as stream:
        stream.write(blob)
    validation = frozen['validation']
    probabilities = model.predict_proba(np.asarray([r['base'] for r in validation]))[:, 1]
    record = {'fitted_at': datetime.now(timezone.utc).isoformat(), 'artifact': path.name, 'artifact_sha256': sha(path),
      'protocol_sha256': sha(out / 'protocol.json'), 'best_iteration': int(model.best_iteration_),
      'effective_model_parameters': model.get_params(), 'calib_accessed': False, 'test_accessed': False,
      'validation': grouped_metrics(probabilities, [r['winner'] for r in validation], validation), **flags()}
    immutable_json(out / 'fit.json', record)
    print(json.dumps(record, indent=2))


def evaluate(out):
    protocol, frozen = frozen_inputs(out)
    fit_record = json.loads((out / 'fit.json').read_text(encoding='utf-8'))
    if (out / 'metrics.json').exists():
        raise ValueError('test already evaluated; refusing overwrite')
    path = out / fit_record['artifact']
    if fit_record['artifact_sha256'] != sha(path) or fit_record['protocol_sha256'] != sha(out / 'protocol.json'):
        raise ValueError('model or protocol changed since fitting')
    test_rows = frozen['test']
    y = np.asarray([r['winner'] for r in test_rows])
    model = _deserialize_bundle(path.read_bytes())['model']
    prediction = model.predict_proba(np.asarray([r['base'] for r in test_rows]))[:, 1]
    predictions = {'base365': prediction, 'elo_only': np.asarray([r['base'][1] for r in test_rows]),
                   'constant_half': np.full(len(test_rows), .5)}
    metrics = {name: grouped_metrics(p, y, test_rows) for name,p in predictions.items()}
    day_rows = [{**r, 'group': utc(r['start'])[:10]} for r in test_rows]
    intervals = {baseline: {kind: paired_intervals(prediction, predictions[baseline], y, rows, 2000)
                 for kind, rows in [('series', test_rows), ('utc_day', day_rows)]}
                 for baseline in ('elo_only', 'constant_half')}
    with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row) as connection:
        connection.execute('SET TRANSACTION READ ONLY')
        after = active_models(connection)
    if after != protocol['active_models_before']:
        raise ValueError('active models changed during experiment; investigate external writer')
    report = {'evaluated_at': datetime.now(timezone.utc).isoformat(), 'metrics': metrics, 'paired_deltas': intervals,
      'test_summary': summary(test_rows), 'reliability': reliability(prediction, y, test_rows),
      'test_prior_exposure': protocol['test_prior_exposure'], 'limitations': protocol['limitations'],
      'protocol_sha256': sha(out / 'protocol.json'), 'fit_sha256': sha(out / 'fit.json'),
      'artifact_sha256': sha(path), 'active_models_unchanged': True, 'active_count': len(after),
      'database_writes': 0, 'provider_requests': 0, **flags()}
    immutable_json(out / 'test-predictions.json', [{
      **{k:r[k] for k in ('match_id', 'group', 'start', 'winner')},
      **{name:float(p[i]) for name,p in predictions.items()}} for i,r in enumerate(test_rows)])
    immutable_json(out / 'metrics.json', report)
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=('prepare', 'fit', 'evaluate'), required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--previous', required=True)
    parser.add_argument('--earlier', required=True)
    args = parser.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if args.phase == 'prepare':
        prepare(out, Path(args.previous), Path(args.earlier))
    else:
        {'fit': fit, 'evaluate': evaluate}[args.phase](out)


if __name__ == '__main__':
    main()
