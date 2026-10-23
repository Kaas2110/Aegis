"""File-only empirical live totals experiment; never publishes a model."""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):
    os.environ[key]='2'
import joblib
import numpy as np
import psycopg
from psycopg.rows import dict_row
from .causal_dataset import BASE_NAMES, LIVE_NAMES, CONTRACT, DAY, prematch_rows, live_rows, split_rows
from .live_totals_distribution import (DISTRIBUTION_KIND, FOREST_PARAMETERS, PHASE_SECONDS, PHASE_MIN_MAPS,
    FOREST_MASS, PHASE_TAIL_MASS, LOGLOSS_EPSILON, EmpiricalRemainingForest, evaluate_distributions,
    paired_cluster_interval)
from threadpoolctl import threadpool_limits

# Keep runtime limits explicit even if BLAS was initialized during imports.
for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):
    os.environ[key]='2'
threadpool_limits(limits=2)

BOUNDARIES=('2026-05-19','2026-05-24','2026-05-28')
RESERVED='2026-10-04'
LINES={'kills':[30.5,40.5,50.5,60.5,70.5], 'duration':[int(v*60) for v in (25.5,30.5,35.5,40.5,45.5,50.5)]}


def immutable_json(path,value):
    with path.open('x',encoding='utf-8',newline='\n') as stream:
        stream.write(json.dumps(value,sort_keys=True,indent=2,ensure_ascii=False,allow_nan=False)+'\n')


def epoch(value):
    return int(datetime.strptime(value,'%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp())


def utc(value):
    return datetime.fromtimestamp(value,timezone.utc).isoformat() if value is not None else None


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def active_models(connection):
    return connection.execute('SELECT id,version,kind,features_version,engine,md5(binary_blob) AS blob_hash '
                              'FROM model_versions WHERE is_active ORDER BY id').fetchall()


def flags():
    return {'active':False,'eligibleForServing':False,'eligibleForPromotion':False,
      'validationStatus':'historical_live_totals_research','calibratedCoverage':None,
      'blockers':['fresh_patch_sample_too_small','prospective_validation_required','historical_prematch_context_reconstructed']}


def source_hashes():
    folder=Path(__file__).parent
    names=('run_live_totals.py','live_totals_distribution.py','causal_dataset.py')
    return {name:sha(folder/name) for name in names}


def describe(rows):
    by_map={r['match_id']:r for r in rows}
    return {'frames':len(rows),'maps':len(by_map),'series':len({r['group'] for r in rows}),
      'months':dict(sorted(Counter(utc(r['start'])[:7] for r in by_map.values()).items())),
      'first_start':utc(min((r['start'] for r in rows),default=None)),
      'last_start':utc(max((r['start'] for r in rows),default=None))}


def totals_rows(adapted, cap):
    result=[]; rejected=Counter()
    for row in adapted:
        elapsed=row['game_minute']*60
        observed=row['base'][19]
        end=row['start']+row['duration']
        if not row['start'] <= row['captured'] < end:
            rejected['received_after_or_before_game']+=1;continue
        if row['start']>=cap or row['label_available']>=cap or row['captured']>=cap:
            rejected['reserved_or_unavailable_outcome']+=1;continue
        if (abs(round(elapsed)-elapsed)>1e-6 or observed != int(observed)
            or row['kills'] is None or row['kills'] != int(row['kills']) or row['kills']<observed):
            rejected['invalid_kills_or_time']+=1;continue
        elapsed=int(round(elapsed)); observed=int(observed)
        if row['duration']<=elapsed:
            rejected['nonpositive_remaining_duration']+=1;continue
        if row['latest_feature_outcome']>=row['start']:
            raise ValueError('future prematch outcome')
        result.append({**{k:row[k] for k in ('match_id','group','start','label_available','snapshot_id','captured','latest_feature_outcome')},
          'features':[float(value) if np.isfinite(value) else None for value in row['base']],
          'elapsed_seconds':elapsed,'observed_kills':observed,
          'final_duration':int(row['duration']),'final_kills':int(row['kills']),
          'remaining_duration':int(row['duration'])-elapsed,'remaining_kills':int(row['kills'])-observed})
    return result,dict(rejected)


def assert_split_integrity(splits):
    matches=set(); groups=set()
    for name, rows in splits.items():
        ids={r['match_id'] for r in rows}; series={r['group'] for r in rows}
        if ids & matches or series & groups:
            raise ValueError('map or series leakage between splits')
        if any(r['remaining_duration']<=0 or r['remaining_kills']<0 or r['label_available']>=epoch(RESERVED) for r in rows):
            raise ValueError('invalid remaining outcome or reserved target')
        matches |= ids; groups |= series


def prepare(out, earlier):
    if (out/'design.json').exists():
        raise ValueError('design already fixed')
    design={'registered_at':datetime.now(timezone.utc).isoformat(),'protocol':'empirical_live_totals_research_v1',
      'boundaries_utc':BOUNDARIES,'reserved_from_utc':utc(epoch(RESERVED)),'purge_seconds':DAY,
      'features':BASE_NAMES+LIVE_NAMES,'source_hashes':source_hashes(),'forest_parameters':FOREST_PARAMETERS,
      'distributionKind':DISTRIBUTION_KIND,'targetScope':'map','nativeUnits':{'duration':'seconds','kills':'kills'},
      'phase_seconds':PHASE_SECONDS,'phase_min_maps':PHASE_MIN_MAPS,'forest_mass':FOREST_MASS,
      'phase_geometric_tail_mass':PHASE_TAIL_MASS,'tail_mean':'map-weighted training residual mean in phase; support-safe lower bound 2 sec or 1 kill',
      'tail_support':{'duration':'positive integer seconds','kills':'nonnegative integer kills'},
      'lines_native':LINES,'logloss_epsilon':LOGLOSS_EPSILON,'classification_threshold':.5,
      'fitting_weights':'equal maps; equal frames within map','evaluation_weights':'equal maps; equal frames within map',
      'selection':'one prespecified forest configuration; validation/calibration used only for diagnostics, no tuning',
      'calibration':'none; report measured raw coverage separately, do not claim calibrated coverage',
      'line_event':'final total strictly exceeds line; push included in not-over binary score; pPush also available',
      'bootstrap':'paired whole-series; equal-map estimand; 2000 replicates seed42',**flags()}
    immutable_json(out/'design.json',design)
    with psycopg.connect(os.environ['DATABASE_URL'],row_factory=dict_row) as c:
        c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        c.execute("SET LOCAL statement_timeout='120s'")
        now=float(c.execute('SELECT extract(epoch FROM transaction_timestamp()) AS now').fetchone()['now'])
        cap=min(now,epoch(RESERVED))
        matches=c.execute('''SELECT match_id,start_time,duration,radiant_team_id,dire_team_id,radiant_win,radiant_score,dire_score,
          series_id,series_type,league_id FROM pro_matches WHERE start_time<%s AND start_time+duration+300<%s
          ORDER BY start_time,match_id''',(cap,cap)).fetchall()
        snapshots=c.execute('''SELECT id,match_id,captured_at,game_time_sec,radiant_lead,radiant_score,dire_score,source,
          jsonb_build_object('source',raw_payload->'source','synthetic',raw_payload->'synthetic','delay',raw_payload->'delay',
            'players',CASE WHEN jsonb_typeof(raw_payload->'players')='array' THEN
              (SELECT jsonb_agg(jsonb_build_object('hero_id',p->'hero_id','team',p->'team')) FROM jsonb_array_elements(raw_payload->'players') p)
            END) raw_payload FROM live_snapshots WHERE source='live' AND captured_at<to_timestamp(%s)
          ORDER BY captured_at,id''',(cap,)).fetchall()
        before=active_models(c)
        raw_sources=c.execute('SELECT source,count(*) frames,count(DISTINCT match_id) maps FROM live_snapshots GROUP BY source').fetchall()
    prematch= prematch_rows(matches)
    adapted=live_rows(snapshots,prematch)
    # Preserve the audit field omitted by the shared live adapter.
    prematches={r['match_id']:r for r in prematch}
    for r in adapted:
        r['latest_feature_outcome']=prematches[r['match_id']]['latest_feature_outcome']
    rows,rejected=totals_rows(adapted,cap)
    splits,manifest=split_rows(rows,boundaries=[epoch(v) for v in BOUNDARIES])
    assert_split_integrity(splits)
    for name,minimum in [('train',70),('validation',15),('calib',15),('test',30)]:
        if len({r['match_id'] for r in splits[name]})<minimum:
            raise ValueError('insufficient independent '+name+'; do not move prespecified boundaries')
    immutable_json(out/'frozen-dataset.json',splits)
    old=json.loads((earlier/'live-split-manifest.json').read_text(encoding='utf-8'))
    overlap=len({r['match_id'] for r in splits['test']} & set(old['splits']['test']['match_ids']))
    contract={'distributionKind':DISTRIBUTION_KIND,'targetScope':'map','featuresVersion':CONTRACT,
      'featureNames':BASE_NAMES+LIVE_NAMES,'featureCount':len(BASE_NAMES+LIVE_NAMES),
      'observedState':{'elapsedSeconds':'integer seconds','totalKills':'nonnegative integer','receivedAt':'actual captured_at','source':'opendota'},
      'support':{'duration':'finalSeconds=elapsedSeconds+positive integer remaining','kills':'finalKills=observedKills+nonnegative integer remaining'},
      'outputs':['q05','q25','q50','q75','q95','pOver','pUnder','pPush'],
      'durationUI':'convert seconds to minutes exactly once; do not reuse legacy lognormal contracts',
      'gold':'provider radiant_lead; no gold_t or networth reconstruction',
      'unsupported':['unverified building bitmask','items/XP/player-level live trajectories','exact letter-patch match labels'],**flags()}
    immutable_json(out/'feature-contract.json',contract)
    protocol={**design,'prepared_at':datetime.now(timezone.utc).isoformat(),'data_as_of_utc':utc(now),'cap_utc':utc(cap),
      'design_sha256':sha(out/'design.json'),'dataset_sha256':sha(out/'frozen-dataset.json'),
      'contract_sha256':sha(out/'feature-contract.json'),'raw_sources':raw_sources,'raw_live_frames':len(snapshots),
      'adapted_frames':len(adapted),'causal_filtered':describe(rows),'rejected':rejected,
      'cohorts':{name:describe(data) for name,data in splits.items()},'split_manifest':manifest,
      'previous_test_overlap_maps':overlap,'active_models_before':before,
      'limitations':['Historical research; test overlaps previously inspected live holdout.',
       'Only a handful of October maps; no current-patch quality claim.',
       'Archive end+300 availability and prematch team/series context are reconstructed.',
       'No replay-derived frames or backfill mixed into observed-live cohort.',
       'Conditional geometric tail is a fixed regularization assumption with mean learned from train, not validated universal tail law.',
       'Intervals are empirical raw model intervals; coverage measured, not guaranteed.',
       'No provider requests, production DB writes, model promotion or Oct4 reserve use.']}
    immutable_json(out/'protocol.json',protocol)
    print(json.dumps({key:protocol[key] for key in ('causal_filtered','cohorts','rejected','previous_test_overlap_maps','dataset_sha256')},indent=2))


def frozen(out):
    protocol=json.loads((out/'protocol.json').read_text(encoding='utf-8'))
    if protocol['source_hashes']!=source_hashes():raise ValueError('source changed after preparation')
    for key,name in [('design_sha256','design.json'),('dataset_sha256','frozen-dataset.json'),('contract_sha256','feature-contract.json')]:
        if protocol[key]!=sha(out/name):raise ValueError('frozen input changed')
    return protocol,json.loads((out/'frozen-dataset.json').read_text(encoding='utf-8'))


def fit(out):
    protocol,data=frozen(out)
    artifact=out/'empirical-remaining-v1.joblib'
    if artifact.exists() or (out/'fit.json').exists():raise ValueError('fit already exists')
    model=EmpiricalRemainingForest().fit(data['train'])
    with artifact.open('xb') as stream:joblib.dump(model,stream,compress=3)
    immutable_json(out/'fit.json',{'artifact':artifact.name,'artifact_sha256':sha(artifact),
      'protocol_sha256':sha(out/'protocol.json'),'fitted_at':datetime.now(timezone.utc).isoformat(),
      'train':describe(data['train']),'test_used':False,'validation_used':False,'calibration_used':False,**flags()})
    print(json.dumps({'trained':describe(data['train']),'artifact_bytes':artifact.stat().st_size,'artifact_sha256':sha(artifact)}))


def score_cohort(model, rows):
    output={}
    for target in ('kills','duration'):
        candidate=model.predict_distributions(rows,target)
        baseline=model.predict_distributions(rows,target,baseline=True)
        cm,cl,cq=evaluate_distributions(candidate,rows,target,LINES[target])
        bm,bl,bq=evaluate_distributions(baseline,rows,target,LINES[target])
        output[target]={'candidate':cm,'phase_baseline':bm,
          'paired_mae_delta':paired_cluster_interval(cl['mae'],bl['mae'],rows),
          'support_violations':sum(int(d.quantile(.05)<r['observed_kills'] if target=='kills' else d.quantile(.05)<=r['elapsed_seconds']) for d,r in zip(candidate,rows))}
    return output


def evaluate(out):
    protocol,data=frozen(out)
    record=json.loads((out/'fit.json').read_text(encoding='utf-8'))
    if (out/'metrics.json').exists():raise ValueError('evaluation already recorded')
    if record['protocol_sha256']!=sha(out/'protocol.json') or record['artifact_sha256']!=sha(out/record['artifact']):raise ValueError('artifact changed')
    model=joblib.load(out/record['artifact'])
    cohorts={key:data[key] for key in ('validation','calib','test')}
    cohorts['test_october']=[r for r in data['test'] if r['start']>=epoch('2026-10-01')]
    scores={key:score_cohort(model,rows) for key,rows in cohorts.items() if rows}
    examples=[]
    for target in ('kills','duration'):
        for r,d in list(zip(data['test'],model.predict_distributions(data['test'],target)))[:4]:
            median=d.quantile(.5)
            if target=='kills':lines=[max(r['observed_kills']+.5,math_line) for math_line in [median-9.5,median-4.5,median+.5,median+5.5,median+10.5]]
            else:
                center=(median//60)*60+30
                first_line=(r['elapsed_seconds']//60)*60+30
                if first_line<=r['elapsed_seconds']:first_line+=60
                lines=[max(first_line,center+offset) for offset in (-600,-300,0,300,600)]
            examples.append({'match_id':r['match_id'],'snapshot_id':r['snapshot_id'],'target':target,'unit':'seconds' if target=='duration' else 'kills',
              'observedState':{'elapsedSeconds':r['elapsed_seconds'],'totalKills':r['observed_kills'],'receivedAt':utc(r['captured']),'source':'opendota'},
              'quantiles':{str(q):d.quantile(q) for q in (.05,.25,.5,.75,.95)},
              'ladder':[{'line':line,**d.probabilities(line)} for line in sorted(set(lines))],**flags()})
    with psycopg.connect(os.environ['DATABASE_URL'],row_factory=dict_row) as c:
        c.execute('SET TRANSACTION READ ONLY');after=active_models(c)
    if after!=protocol['active_models_before']:raise ValueError('active models changed externally')
    report={'evaluated_at':datetime.now(timezone.utc).isoformat(),'cohort_sizes':{k:describe(v) for k,v in cohorts.items()},
      'scores':scores,'protocol_sha256':sha(out/'protocol.json'),'artifact_sha256':record['artifact_sha256'],
      'dataset_sha256':protocol['dataset_sha256'],'limitations':protocol['limitations'],
      'previous_test_overlap_maps':protocol['previous_test_overlap_maps'],'active_models_unchanged':True,'active_count':len(after),
      'provider_requests':0,'database_writes':0,**flags()}
    immutable_json(out/'distribution-examples.json',examples)
    immutable_json(out/'metrics.json',report)
    print(json.dumps({'cohorts':report['cohort_sizes'],'test':{t:{k:v for k,v in scores['test'][t].items() if k not in ('candidate','phase_baseline')} | {'candidate_mae':scores['test'][t]['candidate']['mae'],'baseline_mae':scores['test'][t]['phase_baseline']['mae'],'coverage':scores['test'][t]['candidate']['coverageMetrics']} for t in ('kills','duration')},'test_october':{t:{'candidate_mae':scores['test_october'][t]['candidate']['mae'],'baseline_mae':scores['test_october'][t]['phase_baseline']['mae'],'delta_ci':scores['test_october'][t]['paired_mae_delta']} for t in ('kills','duration')}},indent=2))


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--phase',choices=('prepare','fit','evaluate'),required=True)
    p.add_argument('--output',required=True);p.add_argument('--earlier',required=True);a=p.parse_args()
    out=Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
    if a.phase=='prepare':prepare(out,Path(a.earlier))
    else:{'fit':fit,'evaluate':evaluate}[a.phase](out)


if __name__=='__main__':main()
