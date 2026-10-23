"""Disabled-by-default live rich totals hook. Trusted startup config only.

Imports only the four exact sealed diagnostic modules; no phase projector or compact model.
The host passes its original Engine result and reader, without reconstructing either.
"""
from __future__ import annotations
import importlib.util, sys, threading, time
from pathlib import Path
from .local import Refusal as HostRefusal, canonical, hex64, parse, read_file, sha, trusted_path

RUNTIME_SHA256 = 'ebc437cee1b05bc9146d963d1ee0254f15ed0e4f5a226c3bad3e3e032c652c61'
CONTRACT = 'c2_rich_totals_startup.v1'
FLAGS = {k: False for k in ('active','eligibleForServing','eligibleForPromotion',
    'eligibleForQualityClaims','eligibleForProspectiveEvaluation','prospectiveValidated',
    'eventLatencyVerified','coverage95Validated')}
MODULES = ('aegis_rich_totals_common','aegis_rich_totals_dependencies','aegis_hazard_cdf_transport','aegis_rich_totals_binding')
_IMPORT_GATE = threading.Lock()

class Refusal(ValueError): pass
class HardRefusal(HostRefusal): pass
def require(ok, reason):
    if not ok: raise Refusal('rich_totals_' + reason)
def unavailable(reason):
    return {'status':'unavailable','reason':reason,'publicPrediction':None,'modelHash':None,**FLAGS}
def safe_reason(error):
    if isinstance(error, Refusal) and len(error.args)==1 and type(error.args[0]) is str and error.args[0].startswith('rich_totals_'):
        return error.args[0]
    return 'rich_totals_optional_internal_refusal'

def verified_sources(directory, expected):
    """Verify every sealed byte before executing any of that package's source."""
    require(expected == RUNTIME_SHA256, 'runtime_version_pin')
    root=trusted_path(directory,directory=True).resolve()
    raw=read_file(root/'MANIFEST.json',2*1024**2)
    require(sha(raw)==expected,'runtime_manifest_pin')
    manifest=parse(raw); files=manifest.get('files')
    require(type(files) is dict and 3<=len(files)<=128,'runtime_inventory_bound')
    sources={}
    for name,pin in files.items():
        relative=Path(name)
        require(not relative.is_absolute() and relative.parts and '..' not in relative.parts,'runtime_relative_path')
        path=trusted_path(root/relative).resolve()
        require(path.is_relative_to(root) and type(pin) is dict and type(pin.get('bytes')) is int
                and 0<pin['bytes']<=2*1024**2 and hex64(pin.get('sha256')),'runtime_file_bound')
        body=read_file(path,2*1024**2)
        require(len(body)==pin['bytes'] and sha(body)==pin['sha256'],'runtime_file_pin')
        if name in {m+'.py' for m in MODULES}: sources[name[:-3]]=(path,body)
    require(set(sources)==set(MODULES),'runtime_modules_required')
    return root,sources

def load_runtime(directory, expected):
    root,sources=verified_sources(directory,expected)
    # These unique script module names are the sealed source's import contract.
    # Never add a directory to sys.path, alias core/metrics/artifacts, or replace
    # an unrelated pre-existing module. Store the digest of executed source.
    with _IMPORT_GATE:
        for name,(path,body) in sources.items():
            existing=sys.modules.get(name)
            require(existing is None or (getattr(existing,'__aegis_source_sha256__',None)==sha(body)
                    and Path(getattr(existing,'__file__','')).resolve()==path),'runtime_module_collision')
        created=[]
        try:
            for name in MODULES:
                if name in sys.modules: continue
                path,body=sources[name]
                spec=importlib.util.spec_from_file_location(name,path)
                module=importlib.util.module_from_spec(spec)
                sys.modules[name]=module;created.append(name)
                exec(compile(body,str(path),'exec'),module.__dict__)
                module.__aegis_source_sha256__=sha(body)
            common=sys.modules[MODULES[0]]
            require(common.verify_package()==expected,'runtime_recheck')
            return common,sys.modules[MODULES[-1]].RichTotalsBindings
        except BaseException:
            for name in reversed(created): sys.modules.pop(name,None)
            raise

class RichTotalsDiagnostic:
    """Metadata-only boot; lazy one-thread inference behind original host guard."""
    def __init__(self,bundle,config_ref,*,guard,monotonic=time.monotonic):
        try: raw_config=bundle.bytes(config_ref,100000);cfg=parse(raw_config)
        except (HostRefusal,OSError): raise Refusal('rich_totals_startup_config_unavailable') from None
        require(type(cfg) is dict and set(cfg)=={'contract','enabled','rootReviewed','diagnosticInferenceAuthorized',
            'approvedBy','runtimeDirectory','runtimeSourceManifestSha256','binding','limits'},'startup_config_contract')
        require(cfg['contract']==CONTRACT and cfg['enabled'] is True and cfg['rootReviewed'] is True
                and cfg['diagnosticInferenceAuthorized'] is True and cfg['approvedBy']=='root','root_startup_approval_required')
        require(cfg['limits']=={'inferenceThreads':1,'maxProjectionSeconds':30,'maxResponseBytes':4*1024**2,
            'maxRssBytes':4*1024**3,'minFreeBytes':4*1024**3},'fixed_resource_contract')
        self.guard=guard;self.monotonic=monotonic;self.deadline=None;self._gate=threading.BoundedSemaphore(1)
        self._checked_guard()
        try: self.common,factory=load_runtime(cfg['runtimeDirectory'],cfg['runtimeSourceManifestSha256'])
        except Refusal: raise
        except (HostRefusal,OSError,ValueError,KeyError,TypeError):
            raise Refusal('rich_totals_runtime_source_unavailable') from None
        try: self.binding=factory(bundle,cfg['binding'],guard=self._checked_guard)
        except HardRefusal: raise
        except self.common.Refusal as error: self._translate(error)
        except (HostRefusal,OSError,KeyError,TypeError):
            raise Refusal('rich_totals_metadata_unavailable') from None
        self.config_sha256=sha(raw_config);self._checked_guard()
    def _checked_guard(self):
        # Existing guard enforces STOP and RSS/free floors. Do not turn these
        # failures into an optional nested policy refusal.
        try: result=self.guard()
        except Exception as error:
            reason=error.args[0] if isinstance(error,HostRefusal) and len(error.args)==1 and type(error.args[0]) is str and error.args[0].startswith('c2_') else 'c2_rich_totals_resource_or_stop'
            raise HardRefusal(reason) from None
        if self.deadline is not None and self.monotonic()>self.deadline:
            raise HardRefusal('c2_rich_totals_time_bound')
        return result
    def _translate(self,error):
        reason=error.args[0] if len(error.args)==1 and type(error.args[0]) is str else 'rich_totals_optional_internal_refusal'
        if reason=='rich_totals_memory_limit': raise HardRefusal('c2_rich_totals_memory_limit') from None
        require(reason.startswith('rich_totals_'),'optional_refusal_contract')
        raise Refusal(reason) from None
    def project(self,value,*,reader,computed_at):
        if not self._gate.acquire(blocking=False): raise Refusal('rich_totals_busy_no_queue')
        try:
            self.deadline=self.monotonic()+30;self._checked_guard()
            try:
                result=self.binding.diagnose('live',value,reader=reader,computed_at=computed_at,lines=[])
            except self.common.Refusal as error: self._translate(error)
            self._checked_guard()
            require(type(result) is dict and result.get('publicPrediction') is None and result.get('modelHash') is None
                    and all(result.get(k) is False for k in FLAGS),'public_diagnostic_contract')
            require(len(canonical(result))<=4*1024**2,'response_bound')
            return result
        finally:
            self.deadline=None;self._gate.release()
    def status(self):
        return {**self.binding.status(),'startupConfigSha256':self.config_sha256,
            'runtimeSourceManifestSha256':RUNTIME_SHA256,'phaseRoutingEnabled':False,**FLAGS}
