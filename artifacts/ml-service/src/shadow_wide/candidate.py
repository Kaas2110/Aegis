"""Pinned last-fold artifact for diagnostics. No native import until explicit load.

The host, not an arbitrary HTTP feature vector, supplies the source-bound projection.
No training/calibration/selection fallback. JSON nulls remain canonical float32 NaN.
"""
from __future__ import annotations
import math
from pathlib import Path
from .common import HERE,Refusal,bounded,parse,canonical,digest,hex64

CANDIDATE_MANIFEST_SHA256='fce0840053e61daaf899adfff3d758bd18886daa491bee8d9d0300b9afc4a83a'
FEATURE_SHA256='a0b8952ade5da01c5e368f21be96c75140fb97d243bf058ceab5f5e1f457d380'
BUILDER_SHA256='6cb12f4ced0eac6a162f0ae8c099e25344944a34bfebf716d4382d34fe7a6e32'

def decode_vector(value):
 import numpy as np
 if not isinstance(value,dict) or set(value)!={'values','missing','float32Sha256'}:raise Refusal('vector_contract')
 values=value['values'];mask=value['missing']
 if not isinstance(values,list) or not isinstance(mask,list) or len(values)!=36114 or len(mask)!=36114:raise Refusal('vector_width')
 for v,m in zip(values,mask):
  if type(m)is not bool or (v is None)!=m or (v is not None and type(v)not in (int,float)):raise Refusal('vector_null_mask')
 try:
  with np.errstate(over='ignore',invalid='ignore'):x=np.array([math.nan if v is None else v for v in values],dtype='<f4')
 except (ValueError,TypeError,OverflowError):raise Refusal('vector_scalar')
 if np.isinf(x).any():raise Refusal('vector_nonfinite')
 x[np.isnan(x)]=np.float32(np.nan)
 if digest(x.tobytes())!=value['float32Sha256']:raise Refusal('vector_hash')
 if any(v is not None and float(a)!=v for v,a in zip(values,x)):raise Refusal('vector_float32_roundtrip')
 return x

class Candidate:
 def __init__(self,root=HERE):self.root=Path(root);self.model=None;self.manifest=None;self.names=None
 def verify(self):
  raw=bounded(self.root/'candidate-manifest.json',100000)
  if digest(raw)!=CANDIDATE_MANIFEST_SHA256:raise Refusal('candidate_manifest_pin')
  m=parse(raw)
  raw_names=bounded(self.root/m['featureNamesFile'],5*1024*1024)
  if digest(raw_names)!=m['featureNamesFileSha256']:raise Refusal('candidate_names_file_pin')
  names=parse(raw_names)
  if len(names)!=36114 or digest(canonical(names))!=FEATURE_SHA256:raise Refusal('candidate_feature_order')
  model=bounded(self.root/m['modelFile'],8*1024*1024)
  if len(model)!=m['modelBytes'] or digest(model)!=m['modelSha256']:raise Refusal('candidate_model_bytes_pin')
  if m['target']!='map_radiant_win' or m['phase']!='live' or m['builderBundleSha256']!=BUILDER_SHA256:raise Refusal('candidate_semantics')
  return m,names,model
 def load(self,*,loader=None):
  if self.model is not None:return
  m,names,raw=self.verify()
  if loader is None:
   import lightgbm as lgb
   loader=lambda text:lgb.Booster(model_str=text,params={'num_threads':1})
  # Load exactly the already-verified immutable bytes, not a second path read.
  model=loader(raw.decode('utf8'))
  if model.feature_name()!=names or model.num_feature()!=36114 or model.num_trees()!=256:raise Refusal('native_model_schema')
  self.model=model;self.manifest=m;self.names=names
 def predict(self,projection,*,guard=lambda:None):
  if self.model is None:raise Refusal('candidate_not_loaded')
  m=self.manifest
  if (not isinstance(projection,dict) or projection.get('contract')!='observed_wide36114_immutable_roster_projection_v2'
    or projection.get('status')!='projected_diagnostic' or projection.get('phase')!='live'
    or projection.get('featureNamesSha256')!=FEATURE_SHA256 or projection.get('builderBundleSha256')!=BUILDER_SHA256
    or projection.get('prediction')is not None or projection.get('modelHash')is not None):raise Refusal('projection_contract')
  quality=projection.get('quality')
  if not isinstance(quality,dict) or any(quality.get(k)is not False for k in ('eligibleForServing','eligibleForPromotion','prospectiveValidated','coverage95Validated','eventLatencyVerified')):raise Refusal('projection_quality_flags')
  for k in ('sourceInputSha256','anchorSha256','sourceSchemaSha256','projectionBundleSha256'):
   if not hex64(projection.get(k)):raise Refusal('projection_identity_hash')
  c=projection.get('gameTimeSeconds')
  if type(c)is not int or not m['trainClockMin']<=c<=m['trainClockMax']:raise Refusal('candidate_clock_outside_empirical_train')
  x=decode_vector(projection.get('features36114'));guard()
  result=self.model.predict(x.reshape(1,36114),num_threads=1,raw_score=False)
  guard()
  if getattr(result,'shape',None)!=(1,):raise Refusal('candidate_output_shape')
  probability=float(result[0])
  if not math.isfinite(probability) or not 0<=probability<=1:raise Refusal('candidate_probability')
  return {'target':'map_radiant_win','unit':'probability','rawProbability':probability,
   'calibratedProbability':None,'modelSha256':m['modelSha256'],'candidateId':m['candidateId'],
   'candidateManifestSha256':CANDIDATE_MANIFEST_SHA256,'candidateOrigin':m['candidateOrigin'],
   'selectedByValidation':False,'trainingProtocolSha256':m['trainingProtocolSha256'],
   'featureNamesSha256':FEATURE_SHA256,'featureVectorSha256':projection['features36114']['float32Sha256'],
   'sourceInputSha256':projection['sourceInputSha256'],'anchorSha256':projection['anchorSha256'],
   'projectionBundleSha256':projection['projectionBundleSha256'],'weightPolicy':m['weightPolicy'],
   'empiricalTrainClockSeconds':[m['trainClockMin'],m['trainClockMax']],
   'betweenTrainingCheckpoints':c%300!=0,'clockSupportValidated':False,'finalProductionRefit':False}
