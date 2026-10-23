"""Frozen historical actual-packet architecture comparison. No external I/O.

This is exploratory delayed-state evaluation, not evidence of event delivery.
Label metadata defines cohorts and losses only; it never fills input features.
"""
from collections import Counter,defaultdict
from datetime import datetime,timezone
import hashlib,json,math
from pathlib import Path
import numpy as np

OUT=Path('outputs/Aegis-live-architecture-v2-20261004')
INPUT=Path('outputs/Aegis-night-ML-20261004')
HASHES={'matches.json':'eb08f61b8a5ec283f3e325286ac589570f0c37881084465b7e97216cb2c0f41c',
        'observed-live-raw.json':'e6bab265f5f335a94ab832829b1ce5322ca78d2166ce01e227767c843bfd49ea'}
BOUNDARIES=[int(datetime(2026,5,d,tzinfo=timezone.utc).timestamp()) for d in (19,24,28)]
SPLITS=['train','validation','calib','test']
BASE_NAMES=['observed_game_minutes','radiant_score','dire_score','kill_diff','total_kills','kills_per_minute','raw_provider_lead_k',
            'draft_valid']
TRAJ_NAMES=[f'{name}_{window}' for window in (120,300) for name in ('trajectory_available','actual_gap_minutes','raw_lead_slope_k','total_kill_slope','kill_diff_slope')]
FEATURE_NAMES=BASE_NAMES+TRAJ_NAMES+[f'observed_draft_signed_hero_{i}' for i in range(1,251)]
def finite(v):return type(v) in (int,float) and math.isfinite(v)
def epoch(v):return datetime.fromisoformat(v).timestamp() if isinstance(v,str) else v
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write(name,obj):
 with (OUT/name).open('x',encoding='utf-8') as f:json.dump(obj,f,indent=2,ensure_ascii=False,allow_nan=False)
def group(m):
 s=m.get('series_id')
 return 'series:'+str(s) if type(s) is int and s>0 else 'pairday:'+str(m.get('league_id'))+':'+':'.join(map(str,sorted([m['radiant_team_id'],m['dire_team_id']])))+':'+str(m['start_time']//86400)

def map_splits(matches):
 groups={}
 for m in matches.values():
  g=groups.setdefault(group(m),{'first':m['start_time'],'last':m['start_time']+m['duration']+300})
  g['first']=min(g['first'],m['start_time']);g['last']=max(g['last'],m['start_time']+m['duration']+300)
 assignment={};purged=set()
 for m in matches.values():
  g=groups[group(m)];i=sum(g['first']>=b for b in BOUNDARIES)
  if i<3 and g['last']>=BOUNDARIES[i]-86400:purged.add(group(m));continue
  assignment[m['match_id']]=SPLITS[i]
 return assignment,sorted(purged)

def clean_packets(snapshots,matches):
 clean=defaultdict(list);reject=Counter()
 for s in sorted(snapshots,key=lambda s:(epoch(s['captured_at']),s['id'])):
  m=matches.get(s['match_id']);t=s.get('game_time_sec');p=s.get('raw_payload') or {}
  if not m:reject['unmatched_map']+=1;continue
  if s.get('source')!='live' or p.get('source') in ('synthetic','backfill') or p.get('synthetic') is True:reject['synthetic']+=1;continue
  if not finite(t) or t<0 or t>=m['duration']:reject['invalid_game_clock']+=1;continue
  receipt=epoch(s['captured_at'])
  if not m['start_time']<=receipt<m['start_time']+m['duration']:reject['outside_conservative_receipt_window']+=1;continue
  if any(not finite(s.get(k)) for k in ('radiant_score','dire_score','radiant_lead')):reject['missing_state']+=1;continue
  if any(s[k]<0 or int(s[k])!=s[k] for k in ('radiant_score','dire_score')):reject['invalid_scores']+=1;continue
  if any(s.get(k) is not None and s[k]!=m[k] for k in ('radiant_team_id','dire_team_id')):reject['team_mismatch']+=1;continue
  if any(s[k]>m[k] for k in ('radiant_score','dire_score')):reject['state_exceeds_final_score']+=1;continue
  prev=clean[s['match_id']][-1] if clean[s['match_id']] else None
  if prev and (t<=prev['game_time_sec'] or s['radiant_score']<prev['radiant_score'] or s['dire_score']<prev['dire_score']):reject['regressing_duplicate_state']+=1;continue
  clean[s['match_id']].append(s)
 return clean,dict(reject)

def selected_at(history,checkpoint):
 past=[s for s in history if s['game_time_sec']<=checkpoint*60]
 if not past:return None,'no_past_frame'
 s=past[-1]
 if checkpoint*60-s['game_time_sec']>120:return None,'stale_game_state'
 return (s,past),'available'

def routing(observed_seconds,architecture):
 """Route only from observed clock. Measurement checkpoint never advances a head.

For checkpoint heads: (0,5] ->5,...,(70,80)->75; observed>=80 ->tail.
Thus a past78min packet measured at80 still uses75, not a premature tail.
"""
 minute=observed_seconds/60
 if minute>=80:return 'tail80'
 if architecture=='shared':return 'shared_before80'
 if architecture=='phase':return 'phase_early' if minute<=15 else 'phase_mid' if minute<=35 else 'phase_late'
 if architecture=='checkpoint':return 'checkpoint_'+str(max(5,min(75,5*math.ceil(minute/5))))
 raise ValueError('invalid architecture')

def features(s,past,checkpoint):
 t=s['game_time_sec'];r=s['radiant_score'];d=s['dire_score']
 players=(s.get('raw_payload') or {}).get('players')
 valid=(isinstance(players,list) and len(players)==10 and all(type(p.get('hero_id')) is int and 0<p['hero_id']<=250 and type(p.get('team')) is int and p['team'] in (0,1) for p in players)
        and sum(p['team']==0 for p in players)==5 and len({p['hero_id'] for p in players})==10)
 # Checkpoint is a sampling coordinate, never an online feature.
 f=[t/60,r,d,r-d,r+d,(r+d)/(t/60),s['radiant_lead']/1000,int(valid)]
 for window in (120,300):
  older=[p for p in past[:-1] if p['game_time_sec']<=t-window and t-window-p['game_time_sec']<=120]
  if not older:f.extend([0,np.nan,np.nan,np.nan,np.nan]);continue
  prev=older[-1];gap=(t-prev['game_time_sec'])/60
  f.extend([1,gap,(s['radiant_lead']-prev['radiant_lead'])/1000/gap,(r+d-prev['radiant_score']-prev['dire_score'])/gap,(r-d-prev['radiant_score']+prev['dire_score'])/gap])
 heroes=np.zeros(250) if valid else np.full(250,np.nan)
 if valid:
  for p in players:heroes[p['hero_id']-1]=1 if p['team']==0 else -1
 return np.array(f+heroes.tolist(),dtype=np.float32)

def counts(rows):
 return {'frames':len(rows),'maps':len({r['match_id'] for r in rows}),'series_groups':len({r['group'] for r in rows}),
         'verified_series':len({r['group'] for r in rows if r['group'].startswith('series:')})}
def heads():return ['shared_before80','phase_early','phase_mid','phase_late']+[f'checkpoint_{m}' for m in range(5,80,5)]+['tail80']
def membership(row,head):return head in row['routing'].values()

def protocol():
 return {'version':'observed-live-architecture-comparison-v2','registered_at':datetime.now(timezone.utc).isoformat(),
 'v1_abandoned':'evaluation-only checkpoint_game_age_sec removed; identical model/hyperparameters/splits, no tuning against viewed v1 test. V2 test remains exploratory and reused.',
 'status':'exploratory_historical_reused_test_not_fresh_validation','purpose':'Compare architecture only with identical actual-packet feature semantics and common map+minute evaluation.',
 'targets':['map_winner'],'excluded_targets':'totals/series and new prior variants are separate experiments; this run isolates architecture.',
 'input_hashes':HASHES,'checkpoints':'5,10,...,75 then80,85,90,... while match unfinished; maxactual corpusduration, no future reserve',
 'protected_reserve_start':'2026-10-04T00:00:00Z','splits':{'boundaries_utc':['2026-05-19','2026-05-24','2026-05-28'],'purge_seconds':86400,
 'group':'known series_id else pair/league/UTCday heuristic','label_availability':'conservative reconstructed end+300, not actual receipt'},
 'selection':'previous actual snapshot at checkpoint, game-age<=120seconds; conservative receipt within[start,start+duration); provider event age unknown. Missing/incomplete observed draft stays in corpus with NaN+valid flag.',
 'routing':'By observed game clock, never future checkpoint. Before80 shared or phase(<=15,<=35,<80) or checkpoint(ceil5 clamp75). Observed>=80 one COMMON tail head, still continuous clock at85/90. No separate tail models.',
 'architecture_candidates':['shared','phase','checkpoint'],'feature_names':FEATURE_NAMES,
 'semantics':'raw radiant_lead is not asserted NW or earned gold; no replay gold/xp, reconstructed prior, final draft/stat fields, provider delay as network age, team IDs or match IDs as input. All trajectories past actual packets, explicit gaps.',
 'minimum_head_support':{'train_maps':40,'validation_maps':10,'train_two_classes':True,'validation_two_classes':True},
 'missing_head_policy':'no_prediction, report coverage/refusals; no silent shared fallback. Compare all3 on identical predicted map+minute rows plus pairwise intersections.',
 'fit':{'library':'LightGBM','max_fits':20,'one_at_a_time':True,'n_jobs':4,'n_estimators':300,'learning_rate':.03,'num_leaves':15,'max_depth':5,'min_child_samples':10,'reg_lambda':3,'reg_alpha':.1,'random_state':42,'deterministic':True,'force_col_wise':True,'verbosity':-1,'early_stopping_rounds':30,'metric':'binary_logloss','training_weight':'equal total mass per map within head'},
 'selection_policy':'no global hyperparameter search and no model promotion; early stopping validation only; architecture choice not made from finaltest; calibration reserve untouched',
 'evaluation':'Per-minute and common80+ with equal map weights, accuracy/Brier/logloss/calibration; CI bootstrap whole series1000seed42, pairwise Brier differences on exactsame rows; <100maps or30verifiedseries marked insufficient for confirmatory claims. No majorityvote.',
 'admission':'no admission: actual source event timestamps unknown,95% endtoend gate unproven. Historical corpus strongly selected and delayed. No serving changes.'}

def prepare():
 OUT.mkdir(parents=True,exist_ok=True)
 if (OUT/'protocol.json').exists():raise FileExistsError('immutable experiment already prepared')
 for name,h in HASHES.items():
  if sha(INPUT/name)!=h:raise ValueError('frozen input hash mismatch:'+name)
 raw=json.loads((INPUT/'matches.json').read_text(encoding='utf-8'));snap=json.loads((INPUT/'observed-live-raw.json').read_text(encoding='utf-8'))
 matches={m['match_id']:m for m in raw if type(m.get('radiant_win')) is bool and all(finite(m.get(k)) for k in ('start_time','duration','radiant_score','dire_score','radiant_team_id','dire_team_id')) and m['duration']>0 and m['start_time']<1791072000}
 split,purged=map_splits(matches);clean,reject=clean_packets(snap,matches)
 # Freeze before any fit, prediction, validation or test metrics are computed.
 p=protocol();write('protocol.json',p)
 rows=[];matrix=[];coverage=[]
 observed_ids={s['match_id'] for s in snap if s['match_id'] in matches}
 maxminute=5*math.floor(max(m['duration'] for mid,m in matches.items() if mid in observed_ids)/300)
 for minute in range(5,maxminute+1,5):
  eligible=[m for mid,m in matches.items() if mid in observed_ids and m['duration']>minute*60]
  c=Counter()
  for m in eligible:
   chosen,reason=selected_at(clean.get(m['match_id'],[]),minute)
   if chosen is None:c[reason]+=1;continue
   if m['match_id'] not in split:c['split_purged']+=1;continue
   s,past=chosen;x=features(s,past,minute)
   row={'match_id':m['match_id'],'group':group(m),'start':m['start_time'],'label_available':m['start_time']+m['duration']+300,'split':split[m['match_id']],
        'minute':minute,'winner':int(m['radiant_win']),'snapshot_id':s['id'],'captured_at':s['captured_at'],'observed_game_sec':s['game_time_sec'],'game_age_seconds':minute*60-s['game_time_sec'],
        'provider_delay_raw':(s.get('raw_payload') or {}).get('delay'),'observed_draft_valid':bool(x[7]),'trajectory120':bool(x[8]),'trajectory300':bool(x[13]),
        'routing':{a:routing(s['game_time_sec'],a) for a in ('shared','phase','checkpoint')}}
   rows.append(row);matrix.append(x);c['available']+=1
  coverage.append({'minute':minute,'maps_still_playing_with_any_historical_packet':len(eligible),**c})
 write('rows.json',rows)
 np.savez_compressed(OUT/'features.npz',X=np.array(matrix,dtype=np.float32))
 headinventory={}
 for head in heads():
  rr=[r for r in rows if membership(r,head)]
  cc={sp:counts([r for r in rr if r['split']==sp]) for sp in SPLITS}
  classes={sp:sorted({r['winner'] for r in rr if r['split']==sp}) for sp in ('train','validation')}
  cc['fit_eligible']=cc['train']['maps']>=40 and cc['validation']['maps']>=10 and all(len(v)==2 for v in classes.values())
  headinventory[head]=cc
 inv={'raw_frames':len(snap),'raw_maps':len({s['match_id'] for s in snap}),'matched_pro_maps':len(observed_ids),'clean_maps':len(clean),'clean_frames':sum(map(len,clean.values())),
 'rejected_frames':reject,'purged_groups':purged,'splits':{sp:counts([r for r in rows if r['split']==sp]) for sp in SPLITS},
 'head_inventory':headinventory,'expected_fits':sum(v['fit_eligible'] for v in headinventory.values()),'coverage':coverage,
 'draft_valid_frames':sum(r['observed_draft_valid'] for r in rows),'trajectory120_frames':sum(r['trajectory120'] for r in rows),'trajectory300_frames':sum(r['trajectory300'] for r in rows),
 'source_event_time_verified_frames':0,'admission':'not_admitted_unknown_event_freshness','columns':len(FEATURE_NAMES),
 'dataset_hashes':{name:sha(OUT/name) for name in ('protocol.json','rows.json','features.npz')}}
 write('inventory.json',inv)
 print(json.dumps({k:inv[k] for k in ('clean_maps','clean_frames','splits','expected_fits','columns')},indent=2))

if __name__=='__main__':prepare()
