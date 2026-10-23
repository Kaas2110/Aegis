"""Pinned coherent total distributions on actual observed states; no fitting/IO API.

Historical diagnostics only. Selection/calibration stay frozen; a successful
calculation is not evidence of timely data, prospective skill or promotion.
"""
from __future__ import annotations
from datetime import datetime,timezone
from pathlib import Path
from typing import Mapping,Any
import hashlib,json,math
import lightgbm as lgb
import numpy as np
from scipy import sparse
from src.research import corrected_live_totals_contract as features
from src.research import temporal_hero_kills as shared_kills

CONTRACT='hazard-totals-diagnostic-v1'
MANIFEST_SHA256='9bb659af665cb5ae2bca617a20c7ea478ee20529cfe1d1b93e68a7c76ca2b549'
ASSETS=Path(__file__).resolve().parent/'assets/hazard_totals_diagnostic_v1'
DOMAINS={'kills':(0,120),'duration':(1,5400)}
LEVELS=(.05,.1,.25,.5,.75,.9,.95)
GATES=('eligibleForServing','eligibleForPromotion','eligibleForQualityClaims','latencyValidated',
       'calibrationQualityValidated','bookmakerSettlementValidated','interpolatedClockQualityValidated')
MAX_LINES=128

class ContractError(ValueError):pass
def sha(raw:bytes)->str:return hashlib.sha256(raw).hexdigest()
def canonical_hash(value:Any)->str:return sha(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode())
def checked_asset(name:str,expected:str)->bytes:
 if not isinstance(name,str) or Path(name).name!=name:raise ContractError('asset_name_not_allowed')
 path=(ASSETS/name).resolve()
 if path.parent!=ASSETS.resolve():raise ContractError('asset_path_not_allowed')
 raw=path.read_bytes()
 if sha(raw)!=expected:raise ContractError('asset_hash_mismatch:'+name)
 return raw
def integer(value:Any,name:str,minimum=0)->int:
 if type(value) is not int or not minimum<=value<=2**53-1:raise ContractError('invalid_'+name)
 return value
def timestamp(value:Any)->str:
 if not isinstance(value,str):raise ContractError('computed_at_required')
 try:t=datetime.fromisoformat(value.replace('Z','+00:00'))
 except ValueError as e:raise ContractError('invalid_computed_at') from e
 if t.tzinfo is None:raise ContractError('computed_at_timezone_required')
 return t.astimezone(timezone.utc).isoformat()

def observed_input(packet:Mapping[str,Any],expected_match_id:int,variant:str)->tuple[dict,np.ndarray]:
 if not isinstance(packet,Mapping):raise ContractError('observed_packet_required')
 if variant not in ('state6','draft1006'):raise ContractError('unknown_variant')
 match_id=integer(packet.get('matchId'),'match_id',1)
 if match_id!=integer(expected_match_id,'expected_match_id',1):raise ContractError('map_identity_mismatch')
 if packet.get('phase')!='live':raise ContractError('ongoing_live_phase_required')
 clock=integer(packet.get('gameTimeSec'),'clock',1)
 if not 300<=clock<=4500:raise ContractError('clock_outside_300_4500_seconds')
 try:vector=features.features_from_observed(packet,variant='state_only' if variant=='state6' else 'state_draft')
 except (ValueError,TypeError) as e:raise ContractError(str(e)) from e
 state={'matchId':match_id,'phase':'live','gameTimeSec':clock,'radiantScore':packet['radiantScore'],'direScore':packet['direScore']}
 if variant=='draft1006':state['players']=sorted([{'heroId':p['heroId'],'team':p['team']} for p in packet['players']],key=lambda p:(p['team'],p['heroId']))
 return state,vector

class DiscreteHazard:
 """Stable exact atoms, survival and quantiles with an unallocated right tail."""
 def __init__(self,logits:np.ndarray,lower:int,upper:int,temperature:float):
  z=np.asarray(logits,dtype=np.float64)
  if type(lower) is not int or type(upper) is not int or lower<0 or upper<lower or z.shape!=(upper-lower+1,) or not np.isfinite(z).all():raise ContractError('invalid_hazard_domain_or_logits')
  if type(temperature) not in (float,int) or not math.isfinite(temperature) or temperature<=0:raise ContractError('invalid_temperature')
  self.lower=lower;self.upper=upper;z=z/temperature
  self.log_survival=np.cumsum(-np.logaddexp(0.,z))
  self.log_pmf=np.r_[0.,self.log_survival[:-1]]-np.logaddexp(0.,-z)
  self.log_cdf=np.logaddexp.accumulate(self.log_pmf)
  if not np.isfinite(self.log_pmf).all() or not np.isfinite(self.log_survival).all() or abs(float(np.logaddexp(self.log_cdf[-1],self.log_survival[-1])))>1e-9:raise ContractError('invalid_hazard_mass')
 def quantiles(self):
  values=[]
  for q in LEVELS:
   positions=np.flatnonzero(self.log_cdf>=math.log(q));values.append(int(positions[0])+self.lower if len(positions) else None)
  return values
 def line(self,residual:float)->dict:
  at=math.floor(residual);before=math.ceil(residual)-1
  if at>self.upper or before>self.upper:return {'available':False,'reason':'residual_support_exceeded','probabilities':None}
  lu=float(self.log_cdf[before-self.lower]) if before>=self.lower else -math.inf
  lo=float(self.log_survival[at-self.lower]) if at>=self.lower else 0.
  lp=float(self.log_pmf[at-self.lower]) if residual==at and at>=self.lower else -math.inf
  values=[math.exp(v) for v in (lu,lp,lo)]
  if abs(sum(values)-1)>1e-9:raise ContractError('line_mass_not_one')
  # Exact atoms, never differences of a stepped/isotonic CDF. Log probabilities
  # remain present when an extremely tiny float probability underflows.
  return {'available':True,'reason':None,'probabilities':dict(zip(('pUnder','pPush','pOver'),values)),
          'logProbabilities':dict(zip(('under','push','over'),[v if math.isfinite(v) else None for v in (lu,lp,lo)])),
          'structurallyImpossible':dict(zip(('under','push','over'),[v==-math.inf for v in (lu,lp,lo)])),
          'resolvedByObservedLowerBound':residual<self.lower}

class HazardTotalsDiagnostic:
 def __init__(self):
  m=json.loads(checked_asset('MANIFEST.json',MANIFEST_SHA256));self.manifest=m
  if m.get('contract')!=CONTRACT or m.get('scope')!='map' or any(m.get(k) is not False for k in GATES):raise ContractError('diagnostic_only_manifest_required')
  if m['clockDomainSeconds']!=[300,4500] or m['domains']!={k:list(v) for k,v in DOMAINS.items()}:raise ContractError('domain_mismatch')
  if sha(Path(features.__file__).read_bytes())!=m['featureSourceSha256'] or sha(Path(shared_kills.__file__).read_bytes())!=m['sharedHeroKillSha256']:raise ContractError('feature_source_hash_mismatch')
  self.names=json.loads(checked_asset(m['features']['file'],m['features']['sha256']))
  if self.names['state6']!=list(features.STATE_NAMES) or self.names['draft1006']!=list(features.FEATURE_NAMES):raise ContractError('feature_names_mismatch')
  cal=json.loads(checked_asset(m['calibration']['file'],m['calibration']['sha256']))
  selection=json.loads(checked_asset(m['selection']['file'],m['selection']['sha256']))
  if m['selectedVariants']!={k:v['variant'] for k,v in selection.items()}:raise ContractError('selection_mismatch')
  expected=[(t,v) for t in DOMAINS for v in ('state6','draft1006')]
  if [(a['target'],a['variant']) for a in m['models']]!=expected:raise ContractError('artifact_count_or_order_mismatch')
  self.models={};self.meta={}
  for a in m['models']:
   key=f"{a['target']}-{a['variant']}"
   if a['file']!=f'hazard-{key}.txt':raise ContractError('artifact_name_mismatch')
   temp=a['temperature'];c=cal['models'][key]
   if type(temp) not in (int,float) or not .5<=temp<=2 or temp!=c['temperature'] or c['method']!='bounded_scalar_hazard_logit_temperature':raise ContractError('calibration_mismatch')
   model=lgb.Booster(model_str=checked_asset(a['file'],a['sha256']).decode())
   if model.feature_name()!=self.names[a['variant']]+['hazard_candidate_k'] or model.feature_name()!=a['featureNames']:raise ContractError('model_feature_order_mismatch')
   self.models[key]=model;self.meta[key]=a
 def logits(self,target:str,variant:str,vector:np.ndarray)->np.ndarray:
  if target not in DOMAINS or variant not in self.names:raise ContractError('unknown_model')
  vector=np.asarray(vector,dtype=np.float32)
  if vector.shape!=(len(self.names[variant]),) or not np.isfinite(vector).all():raise ContractError('invalid_vector')
  lower,upper=DOMAINS[target];parts=[];base=sparse.csr_matrix(vector[None,:]) if variant=='draft1006' else None
  for begin in range(lower,upper+1,600):
   kk=np.arange(begin,min(begin+600,upper+1),dtype=np.float32)
   if base is None:x=np.column_stack((np.repeat(vector[None,:],len(kk),axis=0),kk)).astype(np.float32)
   else:x=sparse.hstack((base[np.zeros(len(kk),int)],sparse.csr_matrix(kk[:,None])),format='csr',dtype=np.float32)
   parts.append(self.models[f'{target}-{variant}'].predict(x,raw_score=True,num_threads=4))
  z=np.concatenate(parts)
  if not np.isfinite(z).all():raise ContractError('nonfinite_model_logits')
  return z
 @staticmethod
 def requested_line(spec:Any,state:dict,distributions:dict)->dict:
  base={'available':False,'diagnosticOnly':True,'eligibleForServing':False,'probabilitiesArePublic':False,'raw':None,'calibrated':None}
  if not isinstance(spec,Mapping):return {**base,'reason':'line_object_required'}
  target=spec.get('target');line=spec.get('line')
  if not isinstance(target,str) or target not in DOMAINS:return {**base,'reason':'unknown_line_target'}
  if type(line) not in (int,float) or not math.isfinite(line) or not 0<=line<=2**53-1:return {**base,'reason':'nonnegative_finite_line_required'}
  base.update({'target':target,'line':line,'unit':'kills' if target=='kills' else 'seconds'})
  if target=='kills':
   if spec.get('unit')!='kills':return {**base,'reason':'kills_unit_required'}
   if line*2!=math.floor(line*2):return {**base,'reason':'quarter_or_nonhalf_line_unsupported'}
   current=state['radiantScore']+state['direScore']
  else:
   if spec.get('unit')!='seconds' or spec.get('settlement')!='exact_seconds':return {**base,'reason':'explicit_exact_second_settlement_required'}
   if line!=math.floor(line):return {**base,'reason':'integer_second_line_required'}
   current=state['gameTimeSec']
  residual=line-current;raw,cal=distributions[target]
  rr=raw.line(residual);cc=cal.line(residual)
  if not cc['available']:return {**base,'reason':cc['reason'],'residualLine':residual}
  return {**base,'available':True,'reason':None,'residualLine':residual,'raw':rr,'calibrated':cc,
          'basis':'observed_lower_bound' if cc['resolvedByObservedLowerBound'] else 'one_discrete_hazard_distribution'}
 def predict(self,packet:Mapping[str,Any],*,expected_match_id:int,computed_at:str,variant:str|None=None,lines:list|None=None)->dict:
  stamp=timestamp(computed_at)
  if lines is not None and (not isinstance(lines,list) or len(lines)>MAX_LINES):raise ContractError('at_most_128_lines_required')
  chosen=variant or 'state6'
  if variant is None and set(self.manifest['selectedVariants'].values())!={'state6'}:raise ContractError('explicit_target_selection_required')
  state,vector=observed_input(packet,expected_match_id,chosen);dist={};totals={}
  for target in DOMAINS:
   key=f'{target}-{chosen}';meta=self.meta[key];lo,hi=DOMAINS[target];z=self.logits(target,chosen,vector)
   raw=DiscreteHazard(z,lo,hi,1.);cal=DiscreteHazard(z,lo,hi,meta['temperature']);dist[target]=(raw,cal)
   offset=state['radiantScore']+state['direScore'] if target=='kills' else state['gameTimeSec']
   q=cal.quantiles();total=[offset+v if v is not None else None for v in q]
   totals[target]={'variant':chosen,'selectedByValidation':self.manifest['selectedVariants'][target]==chosen,
     'unit':'kills' if target=='kills' else 'seconds','modelSha256':meta['sha256'],'temperature':meta['temperature'],
     'rawLogitsSha256':sha(np.asarray(z,dtype='<f8').tobytes()),'quantileLevels':list(LEVELS),
     'rawRemainingQuantiles':raw.quantiles(),'calibratedRemainingQuantiles':q,'calibratedFinalQuantiles':total,
     'finalMinutes':[v/60 if v is not None else None for v in total] if target=='duration' else None,
     'remainingSupport':[lo,hi],'tailAboveRemaining':hi,'tailProbability':math.exp(float(cal.log_survival[-1])),
     'tailLogProbability':float(cal.log_survival[-1]),'tailAllocatedToLastBin':False}
  result={'contract':CONTRACT,'available':True,'scope':'map','matchId':state['matchId'],'computedAt':stamp,'diagnosticOnly':True,
    **{k:False for k in GATES},'active':False,'originalLiveReceiptVerified':False,'publicProbabilities':None,
    'observedInput':state,'observedInputSha256':canonical_hash(state),'featureNames':self.names[chosen],
    'featureVector':vector.tolist(),'featureVectorSha256':sha(np.asarray(vector,dtype='<f4').tobytes()),'featureStorageDtype':'float32',
    'manifestSha256':MANIFEST_SHA256,'calibrationSha256':self.manifest['calibration']['sha256'],
    'clockOnTrainingCheckpoint':state['gameTimeSec']%300==0,'totals':totals,
    'lineDiagnostics':[self.requested_line(s,state,dist) for s in (lines or [])],'limitations':self.manifest['limitations']}
  result['responseSha256']=canonical_hash(result)
  return result
