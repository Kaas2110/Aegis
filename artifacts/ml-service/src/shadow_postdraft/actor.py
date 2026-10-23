"""One lazy background bootstrap; immutable pinned snapshot; serialized diagnostics.

Health routes never wait for history construction. No PostgreSQL connection,
provider, pickle, training, active-model registry or public serving dependency.
"""
from __future__ import annotations
import hashlib,json,math,os,threading
from dataclasses import dataclass
from datetime import datetime,timezone
from pathlib import Path
from typing import Callable
from . import pins
from .resource import guard as resource_guard,ResourceLimit

MAX_SNAPSHOT_BYTES=512*1024*1024
MAX_LINE_BYTES=2*1024*1024
MAX_ROWS=50000
def utcnow():return datetime.now(timezone.utc)
def iso(now):return now.astimezone(timezone.utc).isoformat()
def stamp(text):
    parsed=datetime.fromisoformat(text.replace('Z','+00:00'))
    if parsed.tzinfo is None:raise ValueError('timezone_required')
    return parsed.timestamp()
def digest_bytes(data):return hashlib.sha256(data).hexdigest()
def bounded_bytes(path,limit):
    if path.is_symlink() or path.stat().st_size>limit:raise ValueError('unsafe_or_oversized_pinned_file')
    data=path.read_bytes()
    if len(data)>limit:raise ValueError('oversized_pinned_file')
    return data
def file_hash(path,guard=lambda:None):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for i,block in enumerate(iter(lambda:stream.read(1024*1024),b'')):
            h.update(block)
            if i%16==0:guard()
    return h.hexdigest()

@dataclass(frozen=True)
class SnapshotConfig:
    directory: Path
    manifest_sha256: str
    @classmethod
    def environment(cls):
        path=os.environ.get('AEGIS_POSTDRAFT_SNAPSHOT_DIR','').strip()
        expected=os.environ.get('AEGIS_POSTDRAFT_SNAPSHOT_MANIFEST_SHA256','').strip()
        if not path or len(expected)!=64 or any(c not in '0123456789abcdef' for c in expected):raise ValueError('postdraft_snapshot_not_configured')
        return cls(Path(path),expected)

def verify_packages(package_root=None,research_root=None):
    """Return hashes only after checking ALL pinned runtime and feature sources."""
    own=Path(package_root) if package_root else Path(__file__).resolve().parent
    own_bytes=bounded_bytes(own/'runtime-manifest.json',1000000);manifest=json.loads(own_bytes)
    for name,expected in manifest['files'].items():
        if Path(name).name!=name:raise ValueError('runtime_manifest_path_escape')
        if digest_bytes(bounded_bytes(own/name,2000000))!=expected:raise ValueError('runtime_source_pin_mismatch')
    research=Path(research_root) if research_root else own.parent/'research';full=research/'postdraft_full/FULL-RUNTIME-MANIFEST.json'
    raw=bounded_bytes(full,1000000)
    if digest_bytes(raw)!=pins.FEATURE_PACKAGE_MANIFEST_SHA256:raise ValueError('feature_package_pin_mismatch')
    feature_manifest=json.loads(raw)
    for name,expected in feature_manifest['sourceHashes'].items():
        relative=Path(name)
        if relative.is_absolute() or '..' in relative.parts:raise ValueError('feature_manifest_path_escape')
        if digest_bytes(bounded_bytes(research/relative,32*1024*1024))!=expected:raise ValueError('feature_source_pin_mismatch')
    return {'packageManifestSha256':digest_bytes(own_bytes),'featurePackageManifestSha256':digest_bytes(raw)}

def load_snapshot(config,*,guard=resource_guard,now=utcnow,progress=lambda x:None):
    """Verify-before-use AND verify read stream before publishing a future cache."""
    from src.research.postdraft_full.builder import bootstrap
    guard();directory=config.directory
    if not directory.is_dir() or directory.is_symlink():raise ValueError('snapshot_directory_unavailable')
    rawmanifest=bounded_bytes(directory/'MANIFEST.json',1000000)
    if digest_bytes(rawmanifest)!=config.manifest_sha256:raise ValueError('snapshot_manifest_pin_mismatch')
    manifest=json.loads(rawmanifest)
    if (manifest.get('contract')!='startup_postdraft_history_snapshot_v1' or manifest.get('readOnly') is not True or
        manifest.get('mapsFile')!='maps.jsonl' or not 0<manifest['counts']['rows']<=MAX_ROWS):raise ValueError('snapshot_contract_mismatch')
    age=now().timestamp()-stamp(manifest['snapshotCutoff'])
    if age<0 or age>86400:raise ValueError('snapshot_stale_or_future')
    data=directory/'maps.jsonl'
    if data.is_symlink() or data.stat().st_size!=manifest['mapsBytes'] or data.stat().st_size>MAX_SNAPSHOT_BYTES:raise ValueError('snapshot_size_mismatch')
    if file_hash(data,guard)!=manifest['mapsSha256']:raise ValueError('snapshot_raw_pin_mismatch')
    reference=bounded_bytes(directory/'hero-reference.json',2000000)
    if digest_bytes(reference)!=manifest['referenceSha256']:raise ValueError('snapshot_reference_pin_mismatch')
    heroes=json.loads(reference)['payload'];mapping={h['id']:h['name'] for h in heroes}
    if len(mapping)!=len(heroes) or not mapping:raise ValueError('invalid_hero_reference')
    stream_hash=hashlib.sha256();rows=0
    def records():
        nonlocal rows
        with data.open('rb') as stream:
            while True:
                line=stream.readline(MAX_LINE_BYTES+1)
                if not line:break
                if len(line)>MAX_LINE_BYTES:raise ValueError('snapshot_row_too_large')
                stream_hash.update(line);rows+=1
                if rows>MAX_ROWS:raise ValueError('snapshot_row_limit')
                yield json.loads(line,parse_constant=lambda x:(_ for _ in ()).throw(ValueError('nonfinite_json')))
    cache=bootstrap(records(),manifest,mapping,guard=guard,progress=progress)
    if rows!=manifest['counts']['rows'] or stream_hash.hexdigest()!=manifest['mapsSha256']:raise ValueError('snapshot_changed_during_read')
    if now().timestamp()-stamp(manifest['snapshotCutoff'])>86400:raise ValueError('snapshot_stale_or_future')
    return cache,{'snapshotManifestSha256':config.manifest_sha256,'rawSnapshotSha256':manifest['mapsSha256'],
        'referenceSha256':manifest['referenceSha256'],'snapshotCutoff':manifest['snapshotCutoff'],'builtAt':cache.built_at,
        'maps':rows,'historyManifestSha256':digest_bytes(json.dumps(cache.manifest,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())}

class PostdraftActor:
    def __init__(self,*,config=None,loader=load_snapshot,verifier=verify_packages,guard=resource_guard,now=utcnow,declared_manifest_hash=None):
        self._config=config;self._loader=loader;self._verifier=verifier;self._guard=guard;self._now=now
        self._lock=threading.Lock();self._infer_gate=threading.BoundedSemaphore(1);self._generation_gate=threading.Lock();self._previous=None
        self._state='cold';self._reason='cache_not_started';self._cache=None;self._metadata={};self._pins={}
        self._thread=None;self._stop=threading.Event();self._reserve=0
        if declared_manifest_hash is None:
            try:declared_manifest_hash=digest_bytes(bounded_bytes(Path(__file__).with_name('runtime-manifest.json'),1000000))
            except Exception:declared_manifest_hash=None
        self._declared_package_hash=declared_manifest_hash
    def _checked_guard(self):
        if self._stop.is_set():raise ResourceLimit('actor_stopping')
        return self._guard()
    def configure_saved_snapshot(self,config):
        """Startup only; loader still verifies raw bytes, bounds and causal cutoff."""
        with self._lock:
            if self._state!='cold' or self._config is not None:return False
            self._config=config
            return True
    def _build(self):
        try:
            before=self._checked_guard();verified=self._verifier()
            if verified['packageManifestSha256']!=self._declared_package_hash:raise ValueError('runtime_manifest_pin_mismatch')
            config=self._config or SnapshotConfig.environment()
            cache,metadata=self._loader(config,guard=self._checked_guard,now=self._now)
            # Do not publish a cache if package files changed during the build.
            if self._verifier()!=verified:raise ValueError('runtime_package_changed_during_bootstrap')
            after=self._checked_guard()
            reserve=max(128*1024*1024,after.get('rssBytes',0)-before.get('rssBytes',0))+128*1024*1024
            with self._lock:self._cache=cache;self._metadata=metadata;self._pins=verified;self._reserve=reserve;self._state='ready';self._reason=None
        except Exception:
            # Never echo paths, query text, config values or arbitrary exception payload.
            with self._lock:self._state='failed';self._reason='cache_bootstrap_unavailable';self._cache=None
    def start(self):
        with self._lock:
            if self._state=='cold':
                self._state='building';self._reason='cache_building'
                self._thread=threading.Thread(target=self._build,name='aegis-postdraft-bootstrap',daemon=True);self._thread.start()
        return self.status()
    def replace_snapshot(self,config,*,publish=lambda config:None):
        """Build separately; publish atomically between inferences, retaining old inputs.

        Old cache continues serving during export/bootstrap. A queued observation
        predating the new builtAt may use the previous generation for180 seconds.
        """
        if not self._generation_gate.acquire(blocking=False):return False
        try:
            with self._lock:
                if self._state=='building':return False
                if self._cache is None:self._state='building';self._reason='cache_building'
            before=self._checked_guard();verified=self._verifier()
            if verified['packageManifestSha256']!=self._declared_package_hash:raise ValueError('runtime_manifest_pin_mismatch')
            cache,metadata=self._loader(config,guard=self._checked_guard,now=self._now)
            if self._verifier()!=verified:raise ValueError('runtime_package_changed_during_refresh')
            after=self._checked_guard()
            reserve=max(128*1024*1024,after.get('rssBytes',0)-before.get('rssBytes',0))+128*1024*1024
            # All requests have a bounded age; do not interrupt a current inference.
            while not self._stop.is_set():
                if self._infer_gate.acquire(timeout=.5):break
            else:raise ResourceLimit('actor_stopping')
            try:
                self._checked_guard()
                # Disk publication must succeed before changing the in-memory generation.
                publish(config)
                with self._lock:
                    if self._cache is not None:
                        self._previous=(self._cache,dict(self._metadata),self._now().timestamp())
                    self._cache=cache;self._metadata=metadata;self._pins=verified;self._reserve=max(self._reserve,reserve)
                    self._config=config;self._state='ready';self._reason=None
            finally:self._infer_gate.release()
            return True
        except Exception:
            with self._lock:
                if self._cache is None:self._state='failed';self._reason='cache_bootstrap_unavailable'
            raise
        finally:self._generation_gate.release()
    def _select_generation(self,received_at):
        from src.research.postdraft_input_contract import ContractError
        with self._lock:
            choices=[(self._cache,self._metadata)]
            if self._previous is not None:
                old,meta,replaced_at=self._previous
                if self._now().timestamp()-replaced_at<180:choices.append((old,meta))
                else:self._previous=None
            for cache,meta in choices:
                if cache is not None and stamp(meta['builtAt'])<=received_at and self._now().timestamp()-stamp(meta['snapshotCutoff'])<=86400:
                    return cache,{'state':'ready','reason':None,**meta,'packageManifestSha256':self._declared_package_hash}
        raise ContractError('observation_precedes_available_cache_generation')
    def close(self):self._stop.set()
    def status(self):
        with self._lock:
            if self._previous is not None and self._now().timestamp()-self._previous[2]>=180:self._previous=None
            if self._state=='ready' and self._now().timestamp()-stamp(self._metadata['snapshotCutoff'])>86400:
                self._state='stale';self._reason='snapshot_older_than_24h_refresh_required'
            result={'state':self._state,'reason':self._reason,
                **{k:self._metadata.get(k) for k in ('builtAt','snapshotCutoff','snapshotManifestSha256','rawSnapshotSha256','referenceSha256','maps','historyManifestSha256')},
                'packageManifestSha256':self._declared_package_hash}
        return result
    def _base(self,body,cache_status=None):
        current=body['current']
        clock=current['input'].get('gameTimeSec')
        return {'contract':pins.CONTRACT,'candidateId':pins.CANDIDATE_ID,'modelSha256':pins.MODEL_SHA256,
            'featureSchemaHash':pins.FEATURE_SCHEMA_HASH,'featurePackageManifestSha256':pins.FEATURE_PACKAGE_MANIFEST_SHA256,
            'packageManifestSha256':self.status()['packageManifestSha256'],
            'executionMode':'runtime_shadow','target':'map_radiant_win','targetScope':'map','observationId':current['observationId'],
            'matchId':body['expectedMatchId'],'receivedAt':current['receivedAt'],'recordedAt':current['recordedAt'],
            'computedAt':iso(self._now()),'phase':('postdraft' if clock<0 else 'early_live_draft_context') if type(clock) is int else 'unknown',
            'status':'unavailable','reason':None,'rawProbability':None,'calibratedProbability':None,
            'featureDtype':'float32','featureNames':None,'featureValues':None,'missingMask':None,'featureVectorHash':None,
            'active':False,'eligibleForServing':False,'eligibleForPromotion':False,'prospectiveValidated':False,
            'calibrationValidated':False,'eventLatencyVerified':False,'meetsVerifiedLiveLatencyPolicy':False,
            'measuredEndToEndLatencySeconds':None,'coverage95Validated':False,'cache':cache_status if cache_status is not None else self.status()}
    def predict(self,body):
        result=self._base(body)
        if body['outcomeKnownAtDispatch'] is not False:return {**result,'reason':'outcome_check_unknown' if body['outcomeKnownAtDispatch'] is None else 'outcome_known_at_dispatch'}
        from src.research.postdraft_full.journal_adapter import journal_envelope
        from src.research.postdraft_input_contract import ContractError,verified_package
        current=body['current'];packet=current['input']
        if packet.get('matchId')!=body['expectedMatchId']:return {**result,'reason':'observation_match_mismatch'}
        row={'id':current['observationId'],'match_id':body['expectedMatchId'],'received_at':current['receivedAt'],
            'recorded_at':current['recordedAt'],'game_time_sec':packet.get('gameTimeSec'),'phase':current['phase'],
            'input':packet,'availability':current['availability'],'input_hash':current['sourceInputHash'],
            'schema_hash':current['sourceSchemaHash'],'quality_reasons':[]}
        try:
            envelope=journal_envelope(row,now=iso(self._now()),expected_schema_hash=pins.OBSERVATION_SCHEMA_HASH,outcome_known_at_dispatch=False)
        except (ContractError,ValueError,TypeError,KeyError):return {**result,'reason':'postdraft_observation_ineligible'}
        state=self.start()
        if state['state']!='ready':return {**self._base(body),'reason':state['reason'],'cache':state}
        if not self._infer_gate.acquire(blocking=False):return {**self._base(body),'reason':'postdraft_busy'}
        try:
            self._checked_guard()
            # Preserve headroom for request-local deepcopy and model loading.
            usage=self._guard()
            if usage.get('rssBytes',0)+self._reserve>=4*2**30 or usage.get('freeBytes',2**64)-self._reserve<2*2**30:raise ResourceLimit('resource_budget_exceeded')
            if self._verifier()!=self._pins:raise ValueError('runtime_package_changed')
            cache,cache_status=self._select_generation(stamp(current['receivedAt']))
            output=cache.predict(envelope,now=iso(self._now()),guard=self._checked_guard)
            if self._now().timestamp()-stamp(current['receivedAt'])>=180:
                return {**self._base(body),'reason':'observation_stale_at_completion'}
            if self._now().timestamp()-stamp(cache_status['snapshotCutoff'])>86400:
                return {**self._base(body),'reason':'snapshot_stale_at_completion'}
            _,schema=verified_package()
            values=output['featureVector'];masks=[v is None for v in values]
            # Existing builder emits canonical positive quiet NaN for every missing value.
            import numpy as np
            vector=np.array([np.nan if m else v for v,m in zip(values,masks)],dtype='<f4')
            digest=digest_bytes(vector.tobytes())
            if digest!=output['featureVectorFloat32Sha256'] or len(values)!=6668 or np.isinf(vector).any():raise ValueError('vector_contract_mismatch')
            complete=self._base(body,cache_status)
            return {**complete,'status':'shadow_predicted','reason':None,'rawProbability':output['diagnosticRadiantWinProbability'],
                'featureNames':schema['featureNames'],'featureValues':values,'missingMask':masks,'featureVectorHash':digest,
                'inputHash':output['normalizedInputSha256'],'historyManifestSha256':output['historyManifestSha256'],
                'seriesContextStatus':output['seriesContextStatus'],'limitations':output['limitations']}
        except ContractError:
            return {**self._base(body),'reason':'postdraft_cache_observation_ineligible'}
        except ResourceLimit:
            return {**self._base(body),'reason':'postdraft_resource_unavailable'}
        except Exception:
            return {**self._base(body),'reason':'postdraft_inference_unavailable'}
        finally:self._infer_gate.release()
