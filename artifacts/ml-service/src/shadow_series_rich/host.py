"""Synchronous root-pinned local readers; no background work, DB or provider calls."""
from pathlib import Path
import json,os,time,threading
from .contract import FLAGS,Refusal,require,fail,context,live_estimate,compose,unavailable,timestamp
from .bundle import Bundle,read,sha,local_file
class Runtime:
 def __init__(self,settings=None,*,clock=time.time,bundle_factory=Bundle):
  self.settings=settings;self.clock=clock;self.bundle_factory=bundle_factory;self.bundle=None;self.gate=threading.Lock()
 def config(self):
  if self.settings is None:fail('local_config_missing_actual_start_producer_unavailable')
  path,expected=self.settings;raw=Path(path).read_bytes();require(sha(raw)==expected,'root_config_pin_changed');c=json.loads(raw)
  require(c['contract']=='series14255.local-readers.v1'and c['diagnosticOnly']is True and c['eligibleForServing']is False,'diagnostic_config_required')
  require(c['enabled']is True,'local_reader_disabled');return c
 def status(self):
  try:c=self.config();return {'status':'configured_read_only','readers':sorted(c['readers']),**FLAGS}
  except Refusal as e:return {'status':'blocked','reason':str(e),'readers':[],**FLAGS}
  except Exception:return {'status':'blocked','reason':'seriesdiag_local_reader_config_unavailable','readers':[],**FLAGS}
 def result(self,name):
  if not self.gate.acquire(blocking=False):return unavailable('seriesdiag_one_diagnostic_call_at_a_time')
  try:
   c=self.config();require(type(name)is str and name in c['readers'],'unknown_local_reader');entry=c['readers'][name];root=Path(c['readerRoot']).resolve()
   current=read(local_file(root,entry['contextFile']));s=context(current)
   if s['terminal']:return compose(current,None,now=self.clock())
   live=read(local_file(root,entry['liveEstimateFile']));live_estimate(current,live,self.clock())
   if s['deciding']:return compose(current,live,now=self.clock())
   require(type(entry.get('snapshotReceiptFile'))is str,'exact14255_actual_start_producer_unavailable');snapshot=read(local_file(root,entry['snapshotReceiptFile']))
   require(timestamp(snapshot['snapshotComputedAt'])<=timestamp(live['predictedAt']),'snapshot_computed_after_live_prediction')
   require(timestamp(snapshot['actualMapStart'])<=timestamp(live['observedAt']),'actual_start_after_live_observation')
   if self.bundle is None:self.bundle=self.bundle_factory()
   values=self.bundle.vector(snapshot,local_file(root,snapshot['vectorFile']).read_bytes(),current)
   # q models consume this SAME14255 vector under both hypothetical outcomes.
   # No incremented-score after-current vector, fabricated final map stats or labels.
   a_is_r=s['aIsRadiant'];need_r=s['target']-(current['winsA']if a_is_r else current['winsB']);need_d=s['target']-(current['winsB']if a_is_r else current['winsA'])
   qw_r=1. if need_r==1 else self.bundle.predict('q_series_if_current_won',values)
   ql_r=0. if need_d==1 else self.bundle.predict('q_series_if_current_lost',values)
   qw_a,ql_a=(qw_r,ql_r)if a_is_r else(1-ql_r,1-qw_r)
   return compose(current,live,q_won_a=qw_a,q_lost_a=ql_a,binding={'scope':self.bundle.binding['scope'],'features':14255,'fold':3,'featureNamesDigest':self.bundle.binding['featureNamesDigest'],'baseLineageId':self.bundle.binding['baseLineageId'],'heads':{k:v['sha256']for k,v in self.bundle.binding['heads'].items()}},now=self.clock())
  except Refusal as e:return unavailable(str(e))
  except Exception:return unavailable('seriesdiag_local_reader_or_model_unavailable')
  finally:self.gate.release()
def configured_runtime():
 path=os.environ.get('AEGIS_SERIES_DIAGNOSTIC_CONFIG');pin=os.environ.get('AEGIS_SERIES_DIAGNOSTIC_CONFIG_SHA256')
 if path is None and pin is None:return Runtime()
 if not path or not pin or len(pin)!=64:return Runtime()
 return Runtime((path,pin))
