"""One explicitly enabled wide diagnostic worker; startup cache precedes new drafts.

No DB/provider calls. Trusted committed reader + durable dispatch/finish journal are
mandatory at the API boundary. This actor never synthesizes an ongoing-map anchor.
"""
from __future__ import annotations
import os,secrets,threading,time
from contextlib import contextmanager
from pathlib import Path
from .common import HERE,Refusal,FLAGS,bounded,parse,canonical,digest,hex64,wall,seconds,now,safe_reason,refusal
from .candidate import Candidate,CANDIDATE_MANIFEST_SHA256

MAX_REQUEST_BYTES=16*1024*1024
MAX_RESPONSE_BYTES=16*1024*1024

def settings_environment():
 if os.environ.get('AEGIS_WIDE_SHADOW_ENABLED')!='1':return None
 path=Path(os.environ.get('AEGIS_WIDE_SHADOW_CONFIG',''))
 expected=os.environ.get('AEGIS_WIDE_SHADOW_CONFIG_SHA256','')
 if not path.is_absolute() or not hex64(expected):raise Refusal('wide_config_missing')
 raw=bounded(path,100000)
 if digest(raw)!=expected:raise Refusal('wide_config_pin')
 value=parse(raw)
 if set(value)!={'snapshotDirectory','snapshotManifestSha256','anchorDirectory','globalLockPath','candidateManifestSha256'}:raise Refusal('wide_config_keys')
 if not hex64(value['snapshotManifestSha256']) or value['candidateManifestSha256']!=CANDIDATE_MANIFEST_SHA256:raise Refusal('wide_config_pins')
 for key in ('snapshotDirectory','anchorDirectory','globalLockPath'):
  p=Path(value[key])
  if not p.is_absolute() or any(x.is_symlink() or (hasattr(x,'is_junction') and x.is_junction()) for x in (p,*p.parents)):raise Refusal('wide_config_path')
 return value

@contextmanager
def startup_lock(path):
 """No stale stealing. The thread owns this lock until its build actually ends."""
 p=Path(path);raw=canonical({'pid':os.getpid(),'task':'wide-diagnostic-cache-startup','token':secrets.token_hex(32)})
 try:
  with p.open('xb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
 except FileExistsError:raise Refusal('wide_bootstrap_competing_job')
 def check():
  if bounded(p,100000)!=raw:raise Refusal('wide_bootstrap_lock_changed')
 try:yield check
 finally:
  # A changed/removed lock is never deleted by this owner.
  if p.exists() and bounded(p,100000)==raw:p.unlink()

def memory_guard():
 # Reuse installed read-only process probe, with a stricter 4GiB free floor.
 from src.shadow_postdraft.resource import usage
 rss,free=usage()
 if type(rss)is not int or type(free)is not int or rss<0 or free<0:raise Refusal('wide_resource_probe')
 if rss+128*1024**2>=4*1024**3 or free-128*1024**2<4*1024**3:raise Refusal('wide_memory_limit')
 return {'rssBytes':rss,'freeBytes':free}

class Backend:
 """Concrete reviewed modules. Imports and native load happen only at enabled boot."""
 def boot(self,settings,guard):
  from src.research.wide_observed import sources
  from src.research.wide_observed.cache import build_cache
  from src.research.wide_observed.anchor import AnchorStore
  from src.research.wide_observed_v2.bridge import verify_package
  from .package import verify_host_package
  pins=verify_host_package();guard()
  if sources.verify_sources()!=pins['frozenFormulaBundleSha256'] or verify_package()!=pins['projectionBundleSha256']:raise Refusal('wide_dependency_pin')
  # No already-running maps are enumerated here and no draft anchors are created.
  cache=build_cache(settings['snapshotDirectory'],settings['snapshotManifestSha256'],guard=guard)
  candidate=Candidate();candidate.load();guard()
  if verify_host_package()!=pins:raise Refusal('wide_package_changed_during_boot')
  return {'cache':cache,'store':AnchorStore(settings['anchorDirectory']),'candidate':candidate,
   'cacheProof':cache.proof,'pins':pins}
 def anchor(self,state,reader,clock):
  from src.research.wide_observed.anchor import capture_anchor
  return capture_anchor(reader,state['store'],state['cache'],clock=clock)
 def binding(self,state,match_id):
  from src.research.wide_observed_v2.bridge import load_anchor_binding
  return load_anchor_binding(state['store'],match_id)
 def project(self,state,reader,clock):
  from src.research.wide_observed_v2.bridge import project_observed
  return project_observed(reader,state['store'],clock=clock)
 def predict(self,state,projection,guard):return state['candidate'].predict(projection,guard=guard)

def request_gate(body,clock):
 if not isinstance(body,dict) or set(body)!={'operation','dispatchId','expectedMatchId','candidateManifestSha256','outcomeKnownAtDispatch','reader'}:raise Refusal('wide_request_keys')
 if body['operation']not in ('anchor','predict') or not hex64(body['dispatchId']) or body['candidateManifestSha256']!=CANDIDATE_MANIFEST_SHA256:raise Refusal('wide_request_identity')
 match=body['expectedMatchId'];r=body['reader']
 if type(match)is not int or not 1<=match<=2**53-1 or not isinstance(r,dict):raise Refusal('wide_match_identity')
 if body['outcomeKnownAtDispatch']is not False or r.get('captureOutcomeKnown')is not False or r.get('outcomeKnownAtRead')is not False:raise Refusal('wide_outcome_known_or_unverified')
 row=r.get('current')
 if not isinstance(row,dict) or row.get('match_id')!=match or type(row.get('match_id'))is not int:raise Refusal('wide_current_identity')
 if not isinstance(row.get('availability'),dict) or row['availability'].get('outcomeKnownAtCapture')is not False:raise Refusal('wide_capture_binding')
 t=seconds(wall(clock));receipt=seconds(row.get('received_at'));recorded=seconds(row.get('recorded_at'))
 if not 0<=t-receipt<=180 or not receipt<=recorded<=t:raise Refusal('wide_current_receipt_stale_or_future')
 c=row.get('game_time_sec')
 if type(c)is not int:raise Refusal('wide_clock_invalid')
 if body['operation']=='anchor' and not -3600<=c<60:raise Refusal('wide_anchor_phase_unsupported')
 if body['operation']=='predict' and not 300<=c<=6600:raise Refusal('candidate_clock_outside_empirical_train')
 return row

class WideHost:
 def __init__(self,settings=None,*,backend=None,clock=now,guard=memory_guard,lock_factory=startup_lock):
  self.settings=settings;self.backend=backend or Backend();self.clock=clock;self.guard=guard;self.lock_factory=lock_factory
  self._state='disabled' if settings is None else 'cold';self._reason='wide_disabled' if settings is None else 'wide_not_started'
  self._data=None;self._mu=threading.Lock();self._gate=threading.BoundedSemaphore(1);self._thread=None;self._stop=threading.Event()
  self._resource={};self._started=None
 def _checked_guard(self):
  if self._stop.is_set():raise Refusal('wide_stopping')
  sample=self.guard();self._resource=sample;return sample
 def _bootstrap(self):
  try:
   started=time.monotonic()
   with self.lock_factory(self.settings['globalLockPath']) as ownership:
    def guard():
     ownership();self._checked_guard()
     if time.monotonic()-started>900:raise Refusal('wide_bootstrap_time_limit')
    data=self.backend.boot(self.settings,guard);guard()
    with self._mu:
     if self._stop.is_set():raise Refusal('wide_stopping')
     self._data=data;self._state='ready';self._reason=None
  except Exception as error:
   with self._mu:self._state='failed';self._reason=safe_reason(error);self._data=None
 def start(self):
  with self._mu:
   if self._state=='cold':
    self._started=wall(self.clock);self._state='building';self._reason='wide_cache_building'
    self._thread=threading.Thread(target=self._bootstrap,name='aegis-wide-diagnostic-startup',daemon=True);self._thread.start()
  return self.status()
 def close(self):
  self._stop.set()
  if self._thread:self._thread.join(timeout=2)
  with self._mu:self._state='stopping';self._reason='wide_stopping'
 def status(self):
  with self._mu:
   return {'contract':'wide36114.shadow.status.v1','state':self._state,'reason':self._reason,
    'startedAt':self._started,'candidateManifestSha256':CANDIDATE_MANIFEST_SHA256,
    'cacheProof':self._data.get('cacheProof') if self._data else None,'resource':dict(self._resource),
    'maxConcurrency':1,'internalQueueSize':0,'callerMustJournalBusyRefusals':True,
    'automaticRefresh':False,'measuredEndToEndLatencySeconds':None,**FLAGS}
 def binding(self,match_id):
  if type(match_id)is not int or not 1<=match_id<=2**53-1:return refusal('wide_match_identity')
  if not self._gate.acquire(blocking=False):return refusal('wide_busy')
  try:
   if self._state!='ready' or self._data is None:return refusal(self._reason or 'wide_not_ready')
   self._checked_guard();value=self.backend.binding(self._data,match_id)
   return {'contract':'wide36114.shadow.binding.v1','status':'anchor_binding','binding':value,
    'candidateManifestSha256':CANDIDATE_MANIFEST_SHA256,**FLAGS}
  except Exception as error:return refusal(safe_reason(error))
  finally:self._gate.release()
 def handle(self,body):
  # No hidden queue: API durable dispatcher owns bounded scheduling and accounting.
  if not self._gate.acquire(blocking=False):return refusal('wide_busy')
  try:
   request_gate(body,self.clock)
   if self._state!='ready' or self._data is None:return refusal(self._reason or 'wide_not_ready')
   self._checked_guard();reader=body['reader']
   if body['operation']=='anchor':
    a=self.backend.anchor(self._data,reader,self.clock);request_gate(body,self.clock)
    diagnostic={'anchorSha256':a['anchorSha256'],'featureAsOf':a['featureAsOf'],
     'builderBundleSha256':a['builderBundleSha256'],'snapshotProof':a['snapshotProof'],
     'priorFeatureNamesSha256':a['priorFeatureNamesSha256'],'priorVectorSha256':a['prior7148']['float32Sha256']}
    status='anchor_ready';prediction=None;source_lineage_canonical=None
   else:
    diagnostic=self.backend.project(self._data,reader,self.clock);request_gate(body,self.clock)
    prediction=self.backend.predict(self._data,diagnostic,self._checked_guard);request_gate(body,self.clock)
    status='shadow_predicted';source_lineage_canonical=canonical(diagnostic['sourceLineage']).decode('utf8')
   self._checked_guard()
   return {'contract':'wide36114.shadow.response.v1','status':status,'reason':None,
    'dispatchId':body['dispatchId'],'matchId':body['expectedMatchId'],'operation':body['operation'],
    'completedAt':wall(self.clock),'candidateManifestSha256':CANDIDATE_MANIFEST_SHA256,
    'diagnostic':diagnostic,'prediction':prediction,'sourceLineageCanonicalJson':source_lineage_canonical,'executionMode':'runtime_shadow',
    'outcomeKnownAtCapture':False,'outcomeKnownAtRead':False,'outcomeKnownAtDispatch':False,
    'outcomeKnownAtFinish':None,'measuredEndToEndLatencySeconds':None,**FLAGS}
  except Exception as error:return refusal(safe_reason(error))
  finally:self._gate.release()

def configured_host():
 try:return WideHost(settings_environment())
 except Exception as error:
  host=WideHost();host._state='configuration_error';host._reason=safe_reason(error);return host
