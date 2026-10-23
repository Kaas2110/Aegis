"""LightGBM lazy column sampling; all native imports occur inside make_backend."""
import hashlib,inspect

EXPECTED_SAMPLE_SHA='39390b2d1f4e89495f50e5411b008b7ba90953e3a0ea5c65871f7768d9810b78'
def make_backend():
 import numpy as np
 import lightgbm as lgb
 from lightgbm.basic import Dataset,ZERO_THRESHOLD
 if lgb.__version__!='4.6.0' or ZERO_THRESHOLD!=1e-35 or hashlib.sha256(inspect.getsource(Dataset._Dataset__sample).encode()).hexdigest()!=EXPECTED_SAMPLE_SHA:raise RuntimeError('unsupported_pinned_lazy_column_backend')
 class Backend:
  def dataset(self,source,indices,labels,weights,names,params,guard):
   class Sequence(lgb.Sequence):
    batch_size=32
    def __len__(self):return len(indices)
    def __getitem__(self,key):
     scalar=isinstance(key,(int,np.integer)) and not isinstance(key,(bool,np.bool_))
     positions=[int(indices[int(key)])]if scalar else indices[key].tolist()
     values=source.get(positions);return values[0].astype('<f8')if scalar else values
   return self.dataset_from_sequence(Sequence(),labels,weights,names,params,guard)
  def dataset_from_sequence(self,sequence,labels,weights,names,params,guard):
   if not isinstance(sequence,lgb.Sequence):
    original=sequence
    class WrappedSequence(lgb.Sequence):
     batch_size=32
     def __len__(self):return len(original)
     def __getitem__(self,key):return original[key]
    sequence=WrappedSequence()
   class Columns(Dataset):
    def _Dataset__sample(self,seqs,total_nrow):
     rows=self._create_sample_indices(total_nrow);counts=None;seen=0
     if len(rows)==0:raise ValueError('empty_native_sample')
     for row in self._yield_row_from_seqlist(seqs,rows):
      if row.ndim!=1 or row.dtype!=np.float64:raise ValueError('scalar_sample_dtype')
      if counts is None:counts=np.zeros(len(row),dtype='<i8')
      if row.shape!=counts.shape:raise ValueError('sample_schema_changed')
      counts+=(np.abs(row)>ZERO_THRESHOLD)|np.isnan(row);seen+=1
      if seen%32==0:guard()
     if seen!=len(rows):raise ValueError('sample_count_changed')
     edges=np.r_[0,np.cumsum(counts,dtype='<i8')];guard();values=np.empty(int(edges[-1]),dtype='<f8');row_ids=np.empty(int(edges[-1]),dtype='<i4');cursor=edges[:-1].copy();guard();seen=0
     for i,row in enumerate(self._yield_row_from_seqlist(seqs,rows)):
      if row.shape!=counts.shape or row.dtype!=np.float64:raise ValueError('sample_schema_changed')
      keep=np.flatnonzero((np.abs(row)>ZERO_THRESHOLD)|np.isnan(row));positions=cursor[keep]
      if np.any(positions>=edges[keep+1]):raise ValueError('sample_mutated')
      values[positions]=row[keep];row_ids[positions]=i;cursor[keep]+=1;seen+=1
      if seen%32==0:guard()
     if seen!=len(rows) or not np.array_equal(cursor,edges[1:]):raise ValueError('sample_mutated')
     guard();return ([values[a:b]for a,b in zip(edges[:-1],edges[1:])],[row_ids[a:b]for a,b in zip(edges[:-1],edges[1:])])
   return Columns(sequence,label=labels,weight=weights,feature_name=names,params=params,free_raw_data=True)
  def train(self,params,dataset,guard):
   def iteration(_):guard()
   iteration.before_iteration=True;iteration.order=-100
   return lgb.train(params,dataset,num_boost_round=256,callbacks=[iteration])
  def restore(self,path):return lgb.Booster(model_file=str(path))
  version=lgb.__version__
 return Backend()
def native_dataset(sequence,labels,weights,names,parameters,guard):
 return make_backend().dataset_from_sequence(sequence,labels,weights,names,parameters,guard)
