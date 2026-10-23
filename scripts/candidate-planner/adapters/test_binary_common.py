"""Synthetic input and mocked backend checks only; never train LightGBM."""
import copy,hashlib,importlib.util,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import common,binary,common_metrics
FAMILIES=('prematch_map_winner','postdraft_map_winner','live_map_winner','prematch_kills_total','prematch_duration_total','live_kills_total','live_duration_total','series_winner')

class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='aegis-adapter-tests-');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.n=0
 def pin(self,value,suffix='.json'):
  self.n+=1;p=self.root/(str(self.n)+suffix)
  if suffix=='.npy':
   with p.open('wb')as f:np.save(f,value,allow_pickle=False)
  else:p.write_text(json.dumps(value),encoding='utf8')
  return {'path':str(p),'bytes':p.stat().st_size,'sha256':common.sha(p)}
 def fixture(self,family='prematch_map_winner',mutate=None,approved=True):
  base=Path(os.environ['AEGIS_COMPILER_FIXTURES'])/family/'MANIFEST.json';m=json.loads(base.read_text());d=json.loads(Path(m['adapterDataset']['path']).read_text());review=json.loads(Path(m['reviewReceipt']['path']).read_text())
  if mutate:mutate(d)
  m['adapterDataset']=self.pin(d);review.update(approved=approved,approvedBy='root',adapterDatasetSha256=m['adapterDataset']['sha256'],targetContractSha256=m['targetContract']['sha256'],syntheticFixtureOnly=True);m['reviewReceipt']=self.pin(review)
  manifest=self.pin(m);p={'datasetManifest':manifest,'datasetManifestSha256':manifest['sha256'],'family':family,'stateFeatures':d['stateFeatures'],'fold':0,'featureContractSha256':m['featureContract']['sha256'],'splitManifestSha256':m['splits']['sha256']}
  return p,d
 def test_all_eight_compiler_shapes_open_as_synthetic_only(self):
  for family in FAMILIES:
   p,d=self.fixture(family)
   with common.LoadedDataset(p,lambda:None)as x:
    self.assertEqual(len(x.names),2);self.assertEqual(x.source.get([0]).shape,(1,2));self.assertEqual(set(x.labelsDict),set(d['labels']))
 def test_unapproved_proposal_never_opens(self):
  p,_=self.fixture(approved=False)
  with self.assertRaisesRegex(ValueError,'adapter_target_review'):common.LoadedDataset(p,lambda:None).__enter__()
 def test_exact_nanoseconds_future_feature_rejected(self):
  self.assertEqual(common.instant('2026-10-23T09:00:00.000000001Z')-common.instant('2026-10-23T09:00:00Z'),1)
  def change(d):
   rows=json.loads(Path(d['sampleRows']['path']).read_text());rows[0]['featureKnownAt']=rows[0]['predictionAt'].replace('.000Z','.000000001Z');d['sampleRows']=self.pin(rows)
  p,_=self.fixture(mutate=change)
  with self.assertRaisesRegex(ValueError,'sample_asof'):common.LoadedDataset(p,lambda:None).__enter__()
 def test_wrong_npy_values_dtype_and_shape_refused(self):
  for change in (lambda d:d['source'].update(matrix=self.pin(np.zeros((5,2),dtype='<f8'),'.npy')),lambda d:d['folds'][0].update(trainIndices=self.pin(np.array([4],dtype='<i8'),'.npy')),lambda d:d['labels']['main'].update(values=self.pin(np.array([0,1,np.nan,0,1],dtype='<f8'),'.npy'))):
   p,_=self.fixture(mutate=change)
   with self.assertRaises(ValueError):common.LoadedDataset(p,lambda:None).__enter__()
 def test_changed_bytes_and_budget_refused(self):
  p,_=self.fixture();Path(p['datasetManifest']['path']).write_text('{}')
  with self.assertRaises(ValueError):common.LoadedDataset(p,lambda:None).__enter__()
  p,_=self.fixture();p['maximumDataVerificationBytes']=10
  with self.assertRaises(ValueError):common.LoadedDataset(p,lambda:None).__enter__()
 def test_checked_source_rejects_infinity_overwide_batches_and_negative_indices(self):
  p,_=self.fixture()
  with common.LoadedDataset(p,lambda:None)as x:
   for indices in ([-1],list(range(33)),[True]):
    with self.assertRaises(ValueError):x.source.get(indices)
   x.source.base.get=lambda ix:np.full((len(ix),2),np.inf,dtype='<f4')
   with self.assertRaises(ValueError):x.source.get([0])
 def data(self,series=False):
  rows=[{'sampleId':str(i),'mapId':str(i//2),'seriesId':str(i//4),'observedClockSeconds':300,'observed_context':{'best_of':3,'wins_R':0,'wins_D':0,'need_R':2,'need_D':2,'map_position':1}}for i in range(8)]
  current=np.array([1,1,0,0,1,0,1,0],dtype='<f8');y=np.array([1,0,1,0,1,0,1,0],dtype='<f8');heads=binary.HEADS if series else('main',)
  specs={h:{'meaning':'series_winner'if h.startswith('q_')else'map_winner','unit':'binary','representation':'binary',**({'conditionOnCurrentMapOutcome':'won'if h.endswith('_won')else'lost'}if h.startswith('q_')else{})}for h in heads}
  labels={h:(current.copy()if h=='p_current_map'else y.copy())for h in heads}
  return SimpleNamespace(rows=rows,names=['a','b','c'],source=SimpleNamespace(get=lambda ix:np.asarray([[i,0,1]for i in ix],dtype='<f4')),train_indices=np.arange(4,dtype='<i8'),validation_indices=np.arange(4,8,dtype='<i8'),labelsDict=labels,target_specs=specs,weight_policy='equal_series'if series else'unit_per_sample')
 def test_q_training_condition_does_not_route_validation_by_realized_outcome(self):
  d=self.data(True);p={'family':'series_winner','head':'q_series_if_current_won'};train,valid,y,w=binary.select_indices(d,p);self.assertEqual(train.tolist(),[0,1]);self.assertEqual(valid.tolist(),[4,5,6,7]);d.labelsDict['p_current_map'][4:]=1-d.labelsDict['p_current_map'][4:];self.assertEqual(binary.select_indices(d,p)[1].tolist(),valid.tolist())
 def test_series_deterministic_branch_uses_observed_context_only(self):
  d=self.data(True);d.rows[4]['observed_context'].update(wins_R=1,need_R=1,map_position=2);p={'family':'series_winner','head':'q_series_if_current_won'};self.assertEqual(binary.select_indices(d,p)[1].tolist(),[5,6,7])
 def test_mocked_native_exactly_one_fit_and_saved_probability_cache(self):
  data=self.data();calls=[]
  class Model:
   def num_trees(self):return 256
   def feature_name(self):return data.names
   def model_to_string(self):return 'synthetic mock model; never a fitted LightGBM artifact'
   def predict(self,x,**kw):return np.full(len(x),.6,dtype='<f8')
  class Backend:
   version='mock-no-native'
   def dataset(self,*args):calls.append('dataset');return SimpleNamespace(construct=lambda:calls.append('construct'))
   def train(self,*args):calls.append('train');return Model()
   def restore(self,*args):return Model()
  p={'family':'live_map_winner','head':'main','identity':{'fixture':True},'fitId':'a'*64,'maxPackedSampleRows':10000,'resultExpectation':{'bindings':{k:'b'*64 for k in ('planSha256','approvalSha256','recipeSha256','datasetManifestSha256','featureContractSha256','splitManifestSha256')}}}
  recipe={'backend':'lightgbm','rounds':256,'earlyStopping':False,'featurePruning':False,'parameters':{'objective':'binary','num_threads':4,'feature_fraction':1,'feature_fraction_bynode':1,'feature_pre_filter':False,'bin_construct_sample_cnt':10000}}
  result=binary.fit_loaded(p,self.root,lambda:None,data,recipe,Backend(),common,common_metrics);self.assertEqual(calls.count('train'),1);self.assertEqual(result['nativeFits'],1);self.assertEqual(len(result['artifacts']),6);self.assertFalse(json.loads((self.root/'PREDICTIONS.json').read_text())['predictionRoutingUsesCurrentOutcome'])
 def test_binary_rejects_wrong_target_before_backend_call(self):
  data=self.data();data.target_specs['main']['unit']='seconds';p={'family':'live_map_winner','head':'main'}
  with self.assertRaisesRegex(ValueError,'target_semantics'):binary.fit_loaded(p,self.root,lambda:None,data,{},None,common,common_metrics)
 def test_metrics_balance_maps_and_leave_ci_unclaimed(self):
  rows=[{'mapId':'a'}]*9+[{'mapId':'b'}];x=common_metrics.binary_metrics(rows,[1]*10,[1]*9+[0]);self.assertAlmostEqual(x['metrics']['accuracy'],.5);self.assertIsNone(x['ci95'])
 def test_adapter_imports_do_not_load_numpy_or_native_modules(self):
  code="import sys;sys.path.insert(0,sys.argv[1]);import binary,common,common_native,common_metrics;assert not any(x.startswith(('numpy','lightgbm')) for x in sys.modules)"
  r=subprocess.run([sys.executable,'-B','-c',code,str(Path(__file__).parent)],capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
if __name__=='__main__':unittest.main(verbosity=2)
