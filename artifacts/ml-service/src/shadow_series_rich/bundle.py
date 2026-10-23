"""Full14255 model binding and receipt validation; native imports only after gates."""
from pathlib import Path
import hashlib,json,struct
from .contract import require,fail,timestamp,context,positive
HERE=Path(__file__).resolve().parent
def sha(raw):return hashlib.sha256(raw).hexdigest()
def canonical(x):return json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def read(path):return json.loads(Path(path).read_text(encoding='utf8'))
def local_file(root,name):
 require(type(name)is str and name and not Path(name).is_absolute(),'local_relative_reference_required');path=Path(root)/name
 require(path.resolve().is_relative_to(Path(root).resolve())and not path.is_symlink()and path.is_file(),'local_reference_outside_root');return path
class Bundle:
 def __init__(self,root=HERE):
  self.root=Path(root);self.binding=read(self.root/'BINDING.json');self.names=read(self.root/'assets/feature-names.json')
  require(self.binding['scope']=='explicit_cv_fold3_diagnostic_not_final_fit'and self.binding['fold']==3 and self.binding['features']==len(self.names)==14255 and len(set(self.names))==14255,'full14255_binding')
  require(sha(canonical(self.names))==self.binding['featureNamesDigest'],'feature_schema_changed');self.engines={}
 def vector(self,receipt,raw,c):
  s=context(c);require(not s['terminal'],'snapshot_for_unfinished_current_map_only');required={'contract','context','actualMapStart','actualStartWitness','snapshotComputedAt','baseHistoryBuiltAt','baseLatestFeatureOutcome','baseLineageId','featureNamesDigest','vectorSha256','priorCompleted','currentDraftReceivedAt','sourceReconciled','vectorFile'}
  require(type(receipt)is dict and set(receipt)==required,'exact14255_receipt_schema')
  require(receipt['contract']=='series14255.actual-start.receipt.v1'and receipt['context']==c and receipt['sourceReconciled']is True,'exact14255_receipt_identity')
  require(receipt['baseLineageId']==self.binding['baseLineageId'],'original7148_lineage_required_not_C2v4')
  require(receipt['featureNamesDigest']==self.binding['featureNamesDigest']and len(raw)==14255*4 and sha(raw)==receipt['vectorSha256'],'full14255_vector_pin')
  start=timestamp(receipt['actualMapStart']);w=receipt['actualStartWitness'];require(type(w)is dict and set(w)=={'kind','actualMapStart','sourceHash'}and w['kind']=='independently_witnessed_actual_start'and w['actualMapStart']==receipt['actualMapStart']and type(w['sourceHash'])is str and len(w['sourceHash'])==64,'actual_start_witness_required')
  require(timestamp(receipt['baseLatestFeatureOutcome'])<=timestamp(receipt['baseHistoryBuiltAt'])<=start and timestamp(receipt['baseLatestFeatureOutcome'])<start and timestamp(receipt['currentDraftReceivedAt'])<=start,'feature_or_draft_received_after_start')
  require(timestamp(receipt['snapshotComputedAt'])>=max(timestamp(receipt['baseHistoryBuiltAt']),timestamp(receipt['currentDraftReceivedAt'])),'snapshot_computed_before_inputs')
  previous=receipt['priorCompleted'];require(type(previous)is list and len(previous)==c['currentMapNumber']-1,'complete_previous_prefix_required');seen=set();last_end=None
  for i,m in enumerate(previous,1):
   require(set(m)=={'matchId','seriesId','mapNumber','completedAt','detailsReceivedAt','outcomeReceivedAt','recordedAt'}and positive(m['matchId'])and m['matchId']!=c['matchId']and m['matchId']not in seen and m['seriesId']==c['seriesId']and m['mapNumber']==i,'previous_prefix_identity')
   seen.add(m['matchId']);end=timestamp(m['completedAt']);times=[timestamp(m[k])for k in('detailsReceivedAt','outcomeReceivedAt','recordedAt')]
   require(last_end is None or last_end<end,'previous_prefix_not_chronological');last_end=end
   require(end+300<start,'prior_original_recipe_endplus300_required')
   require(all(end<=t<start for t in times),'previous_prefix_not_received_before_start')
  vals=struct.unpack('<14255f',raw);require(not any(__import__('math').isinf(x)for x in vals),'infinite_feature')
  wr=c['winsA']if s['aIsRadiant']else c['winsB'];wd=c['winsB']if s['aIsRadiant']else c['winsA'];expected={'best_of':c['bestOf'],'map_position':c['currentMapNumber'],'expected_prior_count':len(previous),'loaded_prior_count':len(previous),'score_R':wr,'score_D':wd,'need_R':s['target']-wr,'need_D':s['target']-wd,'known_score':1}
  for k,v in expected.items():require(vals[self.names.index('series_prefix.context.'+k)]==v,'vector_series_context_mismatch')
  return vals
 def predict(self,head,values):
  require(head in self.binding['heads'],'unknown_rich_head');pin=self.binding['heads'][head];path=local_file(self.root,pin['file']);raw=path.read_bytes();require(sha(raw)==pin['sha256']and len(raw)==pin['bytes'],'model_bytes_changed')
  if head not in self.engines:
   import lightgbm as lgb
   model=lgb.Booster(model_file=str(path));require(model.feature_name()==self.names and model.num_feature()==14255 and model.num_trees()==pin['trees'],'model_full_schema_or_trees');self.engines[head]=model
  import numpy as np
  result=self.engines[head].predict(np.asarray([values],dtype='<f4'),num_threads=1)
  return float(result[0])
