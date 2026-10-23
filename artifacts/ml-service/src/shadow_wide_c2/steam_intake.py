"""Explicit Steam-only startup and bounded trusted local archive notifications.

No HTTP/provider/DB transport, native model import, alternate feature formulas,
or global Engine monkeypatch. All reviewed adapters are private source modules.
"""
from __future__ import annotations
import hashlib,importlib,importlib.util,os,re,sys,threading,time,types
from pathlib import Path
from . import local

READER_SHA='3d70f29c7c74ee18266a11577a4170d892f59b6d807c009c174f63238a9f86c2'
ADAPTER_SHA='b8fb8aa5c0829e17df61cb6cb436f31345703c5b2b28035116186d3540bf83c9'
CONTRACT='c2_steam_phase_committed_intake_startup.v1'
FLAGS={k:False for k in ('active','eligibleForServing','eligibleForPromotion','eligibleForQualityClaims',
    'coverage95Validated','eventLatencyVerified')}
_IMPORT_LOCK=threading.Lock()
class Refusal(ValueError):pass
def need(ok,reason):
    if not ok:raise Refusal('c2_steam_'+reason)
def safe_reason(error):
    if isinstance(error,Refusal)and len(error.args)==1 and type(error.args[0])is str and error.args[0].startswith('c2_steam_'):return error.args[0]
    return 'c2_steam_intake_refusal'
def source_inventory(directory,expected):
    root=local.trusted_path(directory,directory=True).resolve();raw=local.read_file(root/'MANIFEST.json',2*1024**2)
    need(local.sha(raw)==expected,'source_manifest_pin')
    files=local.parse(raw).get('files');need(type(files)is dict and 1<=len(files)<=128,'source_inventory')
    for name,pin in files.items():
        r=Path(name);need(not r.is_absolute()and r.parts and '..'not in r.parts,'source_relative_path')
        p=local.trusted_path(root/r).resolve();need(p.is_relative_to(root),'source_path_escape')
        raw=local.read_file(p,2*1024**2)
        need(type(pin)is dict and len(raw)==pin.get('bytes')and local.sha(raw)==pin.get('sha256'),'source_file_pin')
    return root
def private_module(name,path,*,package=False):
    """Never alias script-style core/metrics/etc or modify sys.path."""
    path=path.resolve();raw=local.read_file(path,2*1024**2);digest=local.sha(raw)
    existing=sys.modules.get(name)
    need(existing is None or(getattr(existing,'__aegis_source_sha__',None)==digest and
        Path(getattr(existing,'__file__','')).resolve()==path),'source_namespace_collision')
    if existing is not None:return existing
    spec=importlib.util.spec_from_file_location(name,path,submodule_search_locations=[str(path.parent)]if package else None)
    value=importlib.util.module_from_spec(spec);sys.modules[name]=value
    try:exec(compile(raw,str(path),'exec'),value.__dict__);value.__aegis_source_sha__=digest
    except BaseException:sys.modules.pop(name,None);raise
    return value
def source_modules(config):
    need(config['readerManifestSha256']==READER_SHA and config['adapterManifestSha256']==ADAPTER_SHA,'source_revision')
    reader_root=source_inventory(config['readerDirectory'],READER_SHA)
    adapter_root=source_inventory(config['adapterDirectory'],ADAPTER_SHA)
    with _IMPORT_LOCK:
        namespace='_aegis_c2_steam_reader_v3_3d70f29c'
        package=private_module(namespace,reader_root/'__init__.py',package=True)
        # Relative imports stay within this exact privately pinned package.
        for n in ('capture_identity','reader','producer','bridge_adapter'):
            module=private_module(namespace+'.'+n,reader_root/(n+'.py'))
            setattr(package,n,module)
        reader,producer,base=(getattr(package,n)for n in ('reader','producer','bridge_adapter'))
        stable=private_module('_aegis_c2_steam_stable_b8fb8aa5',adapter_root/'steam_integration.py')
        memory=private_module('_aegis_c2_steam_memory_b8fb8aa5',adapter_root/'memory_adapter.py')
        purchase=private_module('_aegis_c2_steam_purchase_b8fb8aa5',adapter_root/'purchase_optimization.py')
        producer.verify_sources()
    adapters=types.SimpleNamespace(history_method=memory.history_method,freeze=memory.freeze,
        engine_type=lambda Engine:purchase.engine_type(memory.engine_type(Engine)))
    return reader,producer,stable.Integration(reader,base),adapters

class SteamIntake:
    def __init__(self,settings,*,clock,guard,monotonic=time.monotonic):
        path,expected=settings;need(local.hex64(expected),'config_pin_required')
        raw=local.read_file(path,100000);need(local.sha(raw)==expected,'config_pin')
        c=local.parse(raw)
        need(type(c)is dict and set(c)=={'contract','enabled','rootReviewed','approvedBy','historyConfig',
            'readerDirectory','readerManifestSha256','adapterDirectory','adapterManifestSha256',
            'fieldPolicy','gameStatePolicy','inboxDirectory','allowedArchiveRoot','wallSeconds','maxNotifications'},'config_contract')
        need(c['contract']==CONTRACT and c['enabled']is True and c['rootReviewed']is True and c['approvedBy']=='root','root_approval_required')
        need(type(c['wallSeconds'])is int and 1<=c['wallSeconds']<=28800 and type(c['maxNotifications'])is int and
            1<=c['maxNotifications']<=250,'finite_session_bounds')
        self.config=c;self.config_sha=expected;self.clock=clock;self.guard=guard;self.monotonic=monotonic
        self.deadline=self.monotonic()+c['wallSeconds'];self.seen=set();self.processed=set();self.last_receipt={};self.engine=None;self.ready_sha=None;self.ready=None;self.phase=None;self._engine_class=None
        self.inbox=local.trusted_path(c['inboxDirectory'],directory=True).resolve()
        self.allowed=local.trusted_path(c['allowedArchiveRoot'],directory=True).resolve()
        need(not any(self.inbox.iterdir()),'new_empty_inbox_required')
        guard();self.reader,self.producer,self.adapter,self.memory=source_modules(c)
        self.bundle=self._history_bundle(c['historyConfig']);self.policy_raw=self.bundle.bytes(c['fieldPolicy'],10000)
        # Root approval/semantic knownAt remain enforced independently per packet.
        self.policy_sha=c['fieldPolicy']['sha256'];self.state_policy_raw=self.bundle.bytes(c['gameStatePolicy'],10000);self.state_policy_sha=c['gameStatePolicy']['sha256'];guard()
    def _history_bundle(self,ref):
        need(type(ref)is dict and set(ref)=={'path','sha256','bytes'}and type(ref['bytes'])is int and
            0<ref['bytes']<=100000 and local.hex64(ref['sha256']),'history_config_ref')
        raw=local.read_file(ref['path'],100000);need(len(raw)==ref['bytes']and local.sha(raw)==ref['sha256'],'history_config_pin')
        config=local.parse(raw)
        need(type(config)is dict and set(config)=={'contract','roots','bundle','startPolicy','bridgeDirectory','bridgeManifestSha256'}and
            config['contract']=='steam_c2_offline_history_config.v1','history_only_contract')
        need(type(config['roots'])is dict and 1<=len(config['roots'])<=8 and all(type(k)is str and re.fullmatch('[a-zA-Z0-9_-]{1,32}',k)for k in config['roots']),'history_roots')
        # Same original LocalBundle history validation, with only the reviewed
        # immutable-row parsing/borrow adapter; no fake OD reader registration.
        cls=type('SteamOnlyPinnedHistoryBundle',(local.LocalBundle,),{'history':self.memory.history_method(local.LocalBundle)})
        bundle=object.__new__(cls);bundle.config=config;bundle.config_sha256=ref['sha256']
        bundle.roots={k:local.trusted_path(v,directory=True)for k,v in config['roots'].items()}
        bundle.manifest=bundle.json(config['bundle'],4*1024**2);bundle.readers={}
        need(bundle.manifest.get('contract')=='steam_c2_history_only_bootstrap.v1','history_bundle_contract')
        return bundle
    def engine_type(self,Engine):
        need(self._engine_class is None,'engine_type_once');self._engine_class=self.memory.engine_type(Engine);return self._engine_class
    def is_phase_result(self,value):return self.phase is not None and self.phase.owns_result(value)
    def check_wall(self):need(self.monotonic()<self.deadline,'session_expired')
    def bind(self,engine,*,phase_factory=None):
        need(self.engine is None,'engine_already_bound')
        self.check_wall();self.guard();self.adapter.install_on_engine(engine);self.engine=engine
        # A configured but invalid phase binding must fail before publishing READY.
        if phase_factory is not None:self.phase=phase_factory(self)
        ready={'contract':'c2_steam_phase_local_inbox_ready.v1','readyAt':local.wall(self.clock).isoformat(),
            'configSha256':self.config_sha,'inboxDirectory':str(self.inbox),'allowedArchiveRoot':str(self.allowed),
            'cacheSourceKnownAt':engine.cache.source_known_at,'cacheMaterializedAt':engine.cache.built_at,
            'wallSeconds':self.config['wallSeconds'],'maxNotifications':self.config['maxNotifications'],
            'actualProviderCalls':0,'receiptPhaseHook':self.phase.status()if self.phase is not None else {'configured':False},
            'prediction':None,'modelHash':None,**FLAGS}
        raw=local.canonical(ready)+b'\n';self.ready_sha=local.sha(raw)
        with(self.inbox/'READY.json').open('xb')as f:f.write(raw)
        self.ready=ready;return ready
    def session_active(self):
        self.guard()
        need(self.deadline is not None,'not_ready')
        return self.monotonic()<self.deadline and len(self.seen)<self.config['maxNotifications']
    def claim_next(self):
        """Claim once before parsing; retain all files and never retry a claim."""
        if not self.session_active():return None
        entries=[]
        for p in self.inbox.iterdir():
            need(len(entries)<512,'inbox_entry_bound');entries.append(p)
        choices=sorted(p for p in entries if p.name.endswith('.dispatch.json')and p.name not in self.seen)
        if not choices:return None
        p=choices[0];self.seen.add(p.name);return p
    def project(self,dispatch):
        self.guard();need(self.engine is not None and self.ready_sha is not None,'not_ready')
        p=local.trusted_path(dispatch).resolve()
        need(p.parent==self.inbox and re.fullmatch('[a-f0-9]{64}\\.dispatch\\.json',p.name),'notification_path')
        need(p.name in self.seen and p.name not in self.processed,'unclaimed_or_repeated_notification')
        self.processed.add(p.name)
        need(self.monotonic()<self.deadline,'session_expired')
        raw=local.read_file(p,10000);need(local.sha(raw)==p.name[:64],'notification_filename_pin')
        d=local.parse(raw)
        need(type(d)is dict and set(d)=={'contract','readySha256','archiveDirectory','completeSha256','outcomeKnownAtDispatch','publishedAt'}and
            d['contract']=='c2_steam_phase_committed_archive_notification.v1'and d['readySha256']==self.ready_sha and
            d['outcomeKnownAtDispatch']is False and local.hex64(d['completeSha256']),'notification_contract')
        now=local.wall(self.clock).isoformat()
        need(self.reader.us(self.ready['readyAt'])<=self.reader.us(d['publishedAt'])<=self.reader.us(now),'notification_causal_time')
        archive=local.trusted_path(d['archiveDirectory'],directory=True).resolve()
        need(archive.is_relative_to(self.allowed),'archive_root')
        try:
            reader=(self.producer.load_committed(str(archive),d['completeSha256'],now=now,require_live=False)
                    if self.phase is not None else self.producer.load_committed(str(archive),d['completeSha256'],now=now))
            receipt=self.reader.us(reader['current']['received_at']);mid=reader['current']['match_id']
            need(receipt>=self.reader.us(self.ready['readyAt']),'observation_before_ready')
            need(mid not in self.last_receipt or receipt>self.last_receipt[mid],'nonprogressing_receipt_no_retry')
            # The original producer reconstructs from raw pins and verifies
            # unknown outcome, <=180s local age, current/history causal cutoffs.
            live_project=lambda:self.adapter.project(self.engine,reader,self.policy_raw,self.policy_sha,bundle=self.bundle)
            value=self.phase.project(reader,live_project=live_project)if self.phase is not None else live_project()
        except (self.reader.Refusal,self.reader.cap.Refusal)as error:
            raise Refusal('c2_steam_source_refusal:'+str(error))from None
        self.guard();need(self.monotonic()<self.deadline,'session_expired');self.last_receipt[mid]=receipt
        value={**value,'steamCommittedIntake':{'contract':'c2_trusted_steam_archive_intake.v1',
            'notificationSha256':local.sha(raw),'archiveCompleteSha256':d['completeSha256'],'readySha256':self.ready_sha,
            'readerSha256':self.reader.hashobj(reader),'source':'Steam/GetRealtimeStats/v1','originalReceiptPreserved':True,
            'archiveDirectory':str(archive),'providerCalls':0,'onceClaimNoRetry':True}}
        return reader,value
    def status(self):
        return {'configured':True,'ready':self.ready is not None,'notificationsClaimed':len(self.seen),
            'maxNotifications':self.config['maxNotifications'],'wallSeconds':self.config['wallSeconds'],
            'localInboxPolling':self.ready is not None and self.monotonic()<self.deadline and len(self.seen)<self.config['maxNotifications'],
            'readySha256':self.ready_sha,'receiptPhaseHook':self.phase.status()if self.phase is not None else {'configured':False},
            'automaticProviderPolling':False,'prediction':None,**FLAGS}

def publish_notification(ready_path,ready_sha,archive,complete_sha,*,root_approved,outcome_unknown,clock=local.utcnow):
    """Explicit local producer callback after COMPLETE; atomic immutable publish."""
    need(root_approved is True and outcome_unknown is True,'publisher_approval_unknown_outcome_required')
    ready_path=local.trusted_path(ready_path);raw=local.read_file(ready_path,10000)
    need(local.sha(raw)==ready_sha,'publisher_ready_pin');ready=local.parse(raw)
    need(ready.get('contract')=='c2_steam_phase_local_inbox_ready.v1','publisher_ready_contract')
    inbox=local.trusted_path(ready['inboxDirectory'],directory=True).resolve()
    need(ready_path.resolve()==inbox/'READY.json','publisher_ready_path')
    allowed=local.trusted_path(ready['allowedArchiveRoot'],directory=True).resolve()
    archive=local.trusted_path(archive,directory=True).resolve();need(archive.is_relative_to(allowed),'publisher_archive_root')
    body=local.read_file(archive/'COMPLETE.json',10000)
    need(local.hex64(complete_sha)and local.sha(body)==complete_sha,'publisher_complete_pin')
    need(local.parse(body).get('contract')=='steam_rt_phase_archive_complete.v1','publisher_phase_complete_contract')
    now=local.wall(clock).isoformat();need(local.stamp(ready['readyAt'])<=local.stamp(now),'publisher_future_ready')
    value={'contract':'c2_steam_phase_committed_archive_notification.v1','readySha256':ready_sha,'archiveDirectory':str(archive),
        'completeSha256':complete_sha,'outcomeKnownAtDispatch':False,'publishedAt':now}
    raw=local.canonical(value)+b'\n';digest=local.sha(raw);final=inbox/(digest+'.dispatch.json');pending=inbox/(digest+'.pending')
    # No replacement, deletion of another claim, or notification retry.
    with pending.open('xb')as stream:stream.write(raw)
    try:os.link(pending,final)
    finally:
        if pending.is_file()and local.sha(local.read_file(pending,10000))==digest:pending.unlink()
    return {'notification':str(final),'sha256':digest,'providerCalls':0,'databaseCalls':0,'prediction':None,**FLAGS}
