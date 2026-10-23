"""Pinned dynamic TRAIN inputs. Import performs no IO, numpy import or native fit."""
import hashlib,importlib.util,json,math,re,sys
from pathlib import Path
from datetime import datetime,timezone

def need(ok,reason):
 if not ok:raise ValueError(reason)
def sha(path):
 h=hashlib.sha256()
 with Path(path).open('rb')as stream:
  for block in iter(lambda:stream.read(1024**2),b''):h.update(block)
 return h.hexdigest()
def save(path,value):
 with Path(path).open('x',encoding='utf8')as stream:json.dump(value,stream,ensure_ascii=False,allow_nan=False,indent=2)
def instant(s):
 match=re.fullmatch(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)',s)if isinstance(s,str)else None
 need(match is not None,'exact_timestamp_required');d=datetime.fromisoformat(match[1]+match[3].replace('Z','+00:00'));epoch=datetime(1970,1,1,tzinfo=timezone.utc);delta=d.astimezone(timezone.utc)-epoch
 return (delta.days*86400+delta.seconds)*1000000000+int((match[2]or'').ljust(9,'0'))
def load_module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

class LoadedDataset:
 """Context manager for one immutable fold. labelsDict values are ndarray views.

 Exposes names, rows, train_indices, validation_indices, labelsDict, target_specs,
 target_meanings and source.get(<=32 positions). No target is sent to a factory.
 """
 def __init__(self,plan,guard):
  self.plan=plan;self.guard=guard;self.handles=[];self.source=None;self.verified=set()
  self.remaining=plan.get('maximumDataVerificationBytes',4*1024**3)
  need(type(self.remaining)is int and 0<self.remaining<=64*1024**3,'bounded_data_verification_required')
 def pin(self,spec,json_document=False):
  need(type(spec)is dict and isinstance(spec.get('path'),str) and re.fullmatch('[a-f0-9]{64}',spec.get('sha256',''))is not None,'pinned_data_descriptor_required')
  path=Path(spec['path']);need(path.is_absolute(),'absolute_data_path_required')
  for p in [path,*path.parents]:
   stat=p.lstat();need(not p.is_symlink() and not getattr(stat,'st_file_attributes',0)&0x400,'data_reparse_path')
  size=path.stat().st_size;need(path.is_file() and (spec.get('bytes')is None or spec['bytes']==size),'data_size_changed')
  key=(str(path),spec['sha256'],size)
  if key not in self.verified:
   need(size<=self.remaining,'data_verification_budget');self.remaining-=size;h=hashlib.sha256()
   with path.open('rb')as stream:
    for block in iter(lambda:stream.read(1024**2),b''):h.update(block);self.guard()
   need(h.hexdigest()==spec['sha256'],'data_pin_changed');self.verified.add(key)
  if not json_document:return path
  need(size<=32*1024**2,'metadata_size_bound');return json.loads(path.read_text(encoding='utf-8-sig'))
 def array(self,spec,dtype,shape):
  import numpy as np
  value=np.load(self.pin(spec),mmap_mode='r',allow_pickle=False)
  self.handles.append(value);need(value.dtype==np.dtype(dtype) and value.shape==tuple(shape),'array_dtype_or_shape');return value
 def __enter__(self):
  try:self.open();return self
  except BaseException:self.close();raise
 def __exit__(self,*_):self.close()
 def close(self):
  if self.source is not None:self.source.close();self.source=None
  for value in self.handles:
   if getattr(value,'_mmap',None)is not None:value._mmap.close()
  self.handles=[]
 def open(self):
  p=self.plan;self.guard();m=self.pin(p['datasetManifest'],True)
  need(p['datasetManifest']['sha256']==p['datasetManifestSha256'] and m.get('contract')=='aegis.dynamic-rich-matrix.v2' and m.get('family')==p['family'] and m.get('complete')is True and m.get('candidateOnly')is True and m.get('outerHoldoutRead')is False,'admitted_dynamic_matrix_required')
  need(m.get('sourceKind')!='frozen_research_replay' and m.get('scope')!='full_frozen_TRAIN_inner','dynamic_export_not_frozen_replay')
  raw=self.pin(m['rawExport'],True);features=self.pin(m['featureContract'],True);splits=self.pin(m['splits'],True);review=self.pin(m['reviewReceipt'],True);targets=self.pin(m['targetContract'],True);d=self.pin(m['adapterDataset'],True)
  self.manifest=m;self.descriptor=d
  need(raw.get('complete')is True and raw.get('partition')=='TRAIN' and raw.get('providerFetchedDuringTraining')is False,'TRAIN_export_required')
  need(type(raw.get('files'))is list and 0<len(raw['files'])<=128 and type(m.get('matrixFiles'))is list and 0<len(m['matrixFiles'])<=128,'raw_matrix_inventory_required')
  for pin in [*raw['files'],*m['matrixFiles']]:self.pin(pin)
  need(m['featureContract']['sha256']==p['featureContractSha256'] and m['splits']['sha256']==p['splitManifestSha256'],'adapter_plan_feature_split_binding')
  need(review.get('contract')=='aegis.dynamic-data-review.v2' and review.get('approved')is True and review.get('approvedBy')=='root' and review.get('adapterDatasetSha256')==m['adapterDataset']['sha256'] and review.get('targetContractSha256')==m['targetContract']['sha256'],'adapter_target_review_required')
  need(d.get('contract')=='aegis.rich-adapter-dataset.v1' and d.get('family')==p['family'] and d.get('TRAINonly')is True and d.get('outerHoldoutRead')is False,'adapter_TRAIN_contract')
  for key,wanted in [('featureContractSha256',m['featureContract']['sha256']),('splitManifestSha256',m['splits']['sha256']),('rawExportSha256',m['rawExport']['sha256']),('targetContractSha256',m['targetContract']['sha256'])]:need(d.get(key)==wanted,'adapter_manifest_binding:'+key)
  self.names=features.get('names');need(features.get('contract')=='aegis.full-rich-feature-contract.v1' and features.get('family')==p['family'] and features.get('unknownEncoding')=='NaN' and features.get('prunedFeatures')==0 and type(self.names)is list and len(self.names)==p['stateFeatures'] and len(set(self.names))==len(self.names) and all(isinstance(n,str) and n for n in self.names),'full_feature_inventory_required')
  phase='prematch'if p['family'].startswith('prematch_')else'postdraft'if p['family'].startswith('postdraft_')else'live'if p['family'].startswith('live_')else'series'
  need(d.get('phase')==features.get('phase')==phase,'adapter_phase_binding');self.rows=self.pin(d['sampleRows'],True);need(type(self.rows)is list and 0<len(self.rows)<=2000000,'bounded_sample_rows_required')
  n=len(self.rows);need(d.get('rowCount')==n and d.get('stateFeatures')==len(self.names),'adapter_dimensions')
  maprows=self.pin(m['mapRows'],True);by_map={str(r['mapId']):r for r in maprows};need(len(by_map)==len(maprows),'duplicate_map_rows');seen=set()
  for row in self.rows:
   need(type(row)is dict and isinstance(row.get('sampleId'),str) and row['sampleId'] not in seen and str(row.get('mapId'))in by_map,'sample_identity');seen.add(row['sampleId'])
   need(row.get('timestampBasis')in ('recorded','historical_reconstruction') and instant(row['featureKnownAt'])<=instant(row['predictionAt'])<=instant(raw['asOf']),'sample_asof_contract')
   need(instant(by_map[str(row['mapId'])]['predictionAt'])<=instant(row['predictionAt']),'sample_before_map_prediction')
   if row.get('observedAt')is not None:need(instant(row['observedAt'])<=instant(row['predictionAt']),'sample_observation_in_future')
   if p['family']=='series_winner':need(str(row.get('seriesId'))==str(by_map[str(row['mapId'])]['seriesId']),'series_sample_identity')
  need(type(splits)is list and len(splits)==4 and type(d.get('folds'))is list and len(d['folds'])==4,'four_fold_inputs_required')
  import numpy as np
  selected=None
  for i,(fold,ix)in enumerate(zip(splits,d['folds'])):
   need(fold.get('fold')==i and ix.get('fold')==i,'fold_index_order');parts={}
   for name,ids in [('train',fold['trainMapIds']),('validation',fold['validationMapIds'])]:
    map_ids=set(map(str,ids));expected=[j for j,r in enumerate(self.rows)if str(r['mapId'])in map_ids];spec=ix[name+'Indices'];arr=self.array(spec,'<i8',(len(expected),));need(len(arr)>0 and np.array_equal(arr,np.asarray(expected,dtype='<i8')),'whole_map_sample_indices_required');parts[name]=arr
   need(not set(parts['train'].tolist())&set(parts['validation'].tolist()),'fold_sample_overlap')
   if i==p['fold']:selected=parts
  self.train_indices=selected['train'];self.validation_indices=selected['validation'];self.labelsDict={};self.target_specs={};self.target_meanings={}
  heads=['p_current_map','q_series_if_current_won','q_series_if_current_lost']if p['family']=='series_winner'else['main']
  need(set(d['labels'])==set(heads) and set(targets['headTargets'])==set(heads),'exact_head_target_inventory')
  for head in heads:
   spec=d['labels'][head];need(spec.get('target')==targets['headTargets'][head],'target_spec_binding');self.labelsDict[head]=self.array(spec['values'],'<f8',(n,));self.target_specs[head]=spec['target'];self.target_meanings[head]=spec.get('targetMeaning')
   need(np.isfinite(self.labelsDict[head]).all(),'finite_target_values')
  need(d.get('weightPolicy')in ('unit_per_sample','equal_series'),'explicit_weight_policy');self.weight_policy=d['weightPolicy']
  s=d['source'];need(s.get('featureContractSha256')==m['featureContract']['sha256'] and s.get('rowCount')==n and s.get('stateFeatures')==len(self.names),'source_full_feature_binding')
  if s['kind']=='materialized_npy':base=_ArraySource(self.array(s['matrix'],'<f4',(n,len(self.names))))
  elif s['kind']=='reviewed_lazy_factory':
   need(s.get('contract')=='aegis.rich-feature-source.v1' and s.get('entryPoint')=='open_source' and type(s.get('dataFiles'))is list and 0<len(s['dataFiles'])<=128,'reviewed_factory_contract')
   for pin in s['dataFiles']:self.pin(pin)
   dependencies=s.get('dependencyPins');need(type(dependencies)is dict and len(dependencies)<=32,'explicit_factory_dependencies_required');root=Path(s['module']['path']).parent.resolve()
   for name,pin in dependencies.items():
    need(re.fullmatch('[A-Za-z0-9][A-Za-z0-9._/-]{0,255}',name)is not None and all(x not in ('','.','..')for x in name.split('/')),'factory_dependency_relative_path')
    file=self.pin(pin);need(file.resolve()==(root/name).resolve() and file.resolve().is_relative_to(root),'factory_dependency_binding')
   module=load_module('_aegis_reviewed_feature_factory_'+s['module']['sha256'],self.pin(s['module']))
   need(getattr(module,'CONTRACT',None)=='aegis.rich-feature-source.v1','feature_factory_interface')
   base=module.open_source(config={'dataFiles':s['dataFiles'],'parameters':s.get('parameters',{}),'featureNames':list(self.names),'rowCount':n},guard=self.guard)
  else:raise ValueError('unsupported_reviewed_source_kind')
  self.source=_CheckedSource(base,n,len(self.names),self.guard);self.guard()

class _ArraySource:
 def __init__(self,array):self.array=array
 def get(self,indices):return self.array[indices]
 def close(self):pass
class _CheckedSource:
 def __init__(self,base,n,width,guard):self.base=base;self.n=n;self.width=width;self.guard=guard
 def get(self,indices):
  import numpy as np
  need(isinstance(indices,(list,tuple,np.ndarray)) and 0<len(indices)<=32 and all(type(i)in (int,np.int32,np.int64) and 0<=i<self.n for i in indices),'bounded_feature_positions');self.guard();value=np.asarray(self.base.get(list(indices)));need(value.shape==(len(indices),self.width) and value.dtype==np.dtype('<f4') and not np.isinf(value).any(),'full_feature_source_shape_values');self.guard();return value
 def close(self):self.base.close()
