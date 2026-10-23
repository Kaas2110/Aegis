"""One full-inventory dynamic binary/series-head fit; no work or native import on import."""
import hashlib,importlib.util,json,math
from pathlib import Path
from collections import Counter
CONTRACT='aegis.rich-fit-adapter.v2'
BACKEND='lightgbm-lazyColumnSample'
HEADS=('p_current_map','q_series_if_current_won','q_series_if_current_lost')

def dependencies(plan):
 path=Path(plan['recipe']['path']);raw=path.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=plan['recipe']['sha256']:raise ValueError('recipe_pin_changed')
 recipe=json.loads(raw);out={}
 for name in ('common.py','common_native.py','common_metrics.py'):
  spec=recipe['adapterDependencies'][name];path=Path(spec['path'])
  if path.resolve()!=Path(__file__).resolve().parent/name or hashlib.sha256(path.read_bytes()).hexdigest()!=spec['sha256']:raise ValueError('binary_dependency_pin')
  module=importlib.util.spec_from_file_location('_aegis_binary_'+name.replace('.','_'),path);value=importlib.util.module_from_spec(module);module.loader.exec_module(value);out[name]=value
 return recipe,out
def context(row):
 c=row.get('observed_context');keys={'best_of','wins_R','wins_D','need_R','need_D','map_position'}
 if type(c)is not dict or set(c)!=keys or c['best_of']not in (1,3,5) or any(type(v)is not int for v in c.values()):raise ValueError('observed_series_context_required')
 need=c['best_of']//2+1
 if not (0<=c['wins_R']<need and 0<=c['wins_D']<need and c['need_R']==need-c['wins_R'] and c['need_D']==need-c['wins_D'] and c['map_position']==c['wins_R']+c['wins_D']+1):raise ValueError('unfinished_series_context_required')
 return c
def needed(row,head):return head=='p_current_map' or context(row)['need_R'if head=='q_series_if_current_won'else'need_D']>1
def select_indices(data,plan):
 import numpy as np
 train=data.train_indices.tolist();valid=data.validation_indices.tolist();head=plan['head'];series=plan['family']=='series_winner'
 if series:
  for r in data.rows:context(r)
  if data.weight_policy!='equal_series':raise ValueError('series_balance_policy_required')
  if head!='p_current_map':
   scenario=int(head=='q_series_if_current_won');train=[i for i in train if data.labelsDict['p_current_map'][i]==scenario and needed(data.rows[i],head)]
  valid=[i for i in valid if needed(data.rows[i],head)]
 labels=np.asarray(data.labelsDict[head][train],dtype='<f8')
 if not train or not valid or not np.isin(labels,[0,1]).all() or len(set(labels.tolist()))!=2:raise ValueError('supported_two_class_head_training_required')
 if series:
  counts=Counter(str(data.rows[i]['seriesId'])for i in train);w=np.array([1/counts[str(data.rows[i]['seriesId'])]for i in train],dtype='<f8');w*=len(w)/w.sum()
 else:
  if data.weight_policy!='unit_per_sample':raise ValueError('explicit_binary_unit_sample_policy_required')
  w=np.ones(len(train),dtype='<f8')
 return np.asarray(train,dtype='<i8'),np.asarray(valid,dtype='<i8'),labels,w
def fit_loaded(plan,output,guard,data,recipe,backend,common,metrics):
 import numpy as np
 family=plan['family'];head=plan['head'];series=family=='series_winner'
 common.need(family in ('prematch_map_winner','postdraft_map_winner','live_map_winner','series_winner') and head in (HEADS if series else('main',)),'binary_family_head_required')
 target=data.target_specs[head];condition=None if not series or head=='p_current_map' else('won'if head.endswith('_won')else'lost')
 common.need(set(target)in ({'meaning','unit','representation'},{'meaning','unit','representation','conditionOnCurrentMapOutcome'}) and {**target,'conditionOnCurrentMapOutcome':target.get('conditionOnCurrentMapOutcome')}=={'meaning':'series_winner'if series and head!='p_current_map'else'map_winner','unit':'binary','representation':'binary','conditionOnCurrentMapOutcome':condition},'binary_exact_target_semantics')
 for labels in data.labelsDict.values():common.need(np.isin(labels,[0,1]).all(),'all_binary_labels_required')
 params=recipe['parameters'];common.need(recipe.get('backend')=='lightgbm' and recipe.get('rounds')==256 and recipe.get('earlyStopping')is False and recipe.get('featurePruning')is False and params.get('objective')=='binary' and params.get('num_threads')==4 and params.get('feature_fraction')==1 and params.get('feature_fraction_bynode')==1 and params.get('feature_pre_filter')is False,'fixed_full_binary_recipe')
 common.need(type(params.get('bin_construct_sample_cnt'))is int and 0<params['bin_construct_sample_cnt']<=plan['maxPackedSampleRows'],'bounded_native_sample_count')
 train,valid,y,w=select_indices(data,plan);guard();dataset=backend.dataset(data.source,train,y,w,data.names,params,guard);dataset.construct();guard();model=backend.train(params,dataset,guard);guard()
 common.need(model.num_trees()==256 and model.feature_name()==data.names,'native_full_schema_256_trees');output=Path(output)
 with(output/'model.txt').open('x',encoding='utf8',newline='\n')as stream:stream.write(model.model_to_string())
 restored=backend.restore(output/'model.txt');probe=data.source.get(train[:32].tolist());a=model.predict(probe,raw_score=True,num_threads=4);b=restored.predict(probe,raw_score=True,num_threads=4)
 common.need(np.isfinite(a).all() and np.array_equal(a,b) and restored.feature_name()==data.names,'TRAIN_serialized_parity')
 common.save(output/'TRAIN-PARITY.json',{'contract':'aegis.dynamic-binary-parity.v1','identity':plan['identity'],'sampleIds':[data.rows[i]['sampleId']for i in train[:32]],'bitwiseRawScoreParity':True,'TRAINonly':True,'stateFeatures':len(data.names)})
 prediction=np.empty(len(valid),dtype='<f8')
 for offset in range(0,len(valid),32):
  ix=valid[offset:offset+32];prediction[offset:offset+len(ix)]=restored.predict(data.source.get(ix.tolist()),num_threads=4);guard()
 common.need(np.isfinite(prediction).all() and np.all((prediction>=0)&(prediction<=1)),'finite_native_probabilities')
 with(output/'prediction.npy').open('xb')as stream:np.save(stream,prediction,allow_pickle=False)
 common.save(output/'PREDICTIONS.json',{'contract':'aegis.dynamic-head-prediction-cache.v1','identity':plan['identity'],'sampleIds':[data.rows[i]['sampleId']for i in valid],'indices':valid.tolist(),'probabilitiesFile':'prediction.npy','predictionRoutingUsesCurrentOutcome':False,'noOuterHoldout':True})
 evaluation_indices=list(range(len(valid)))
 if series and head!='p_current_map':evaluation_indices=[j for j,i in enumerate(valid)if data.labelsDict['p_current_map'][i]==int(head.endswith('_won'))]
 metric_rows=[data.rows[valid[j]]for j in evaluation_indices];metric_y=[float(data.labelsDict[head][valid[j]])for j in evaluation_indices];metric_p=[float(prediction[j])for j in evaluation_indices]
 common.save(output/'METRICS.json',metrics.evaluate(metric_rows,metric_y,metric_p,series=series,conditional=series and head!='p_current_map'))
 common.save(output/'FIT-PROVENANCE.json',{'contract':'aegis.dynamic-binary-fit-provenance.v1','identity':plan['identity'],'fullFeatureNamesSha256':hashlib.sha256(json.dumps(data.names,ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),'trainSampleIds':[data.rows[i]['sampleId']for i in train],'trainWeights':w.tolist(),'target':target,'backendVersion':backend.version,'nativeFits':1,'outerHoldoutRead':False,'publicPromotion':False})
 names=('model.txt','TRAIN-PARITY.json','prediction.npy','PREDICTIONS.json','METRICS.json','FIT-PROVENANCE.json');expected=plan['resultExpectation'];guard()
 return {'contract':'aegis.rich-fit-result.v2','status':'fit_complete','identity':plan['identity'],'fitId':plan['fitId'],'bindings':expected['bindings'],'nativeFits':1,'trees':256,'stateFeatures':len(data.names),'candidateAxisFeatures':0,'featureCount':len(data.names),'fullInventoryRetained':True,'serializedParity':True,'noOuterHoldout':True,'candidateOnly':True,'publicPromotion':False,'artifacts':{name:common.sha(output/name)for name in names}}
def fit_one(*,plan,output,guard):
 recipe,modules=dependencies(plan);common=modules['common.py'];guard()
 with common.LoadedDataset(plan,guard)as data:
  backend=modules['common_native.py'].make_backend()
  return fit_loaded(plan,output,guard,data,recipe,backend,common,modules['common_metrics.py'])
