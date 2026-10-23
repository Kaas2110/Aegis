"""One finite local background bootstrap; HTTP readers consume cached results."""
from __future__ import annotations
import copy, json, math, os, threading, time
from .local import LocalBundle, Refusal, fail, hex64, utcnow, wall
from .fitted import FittedBindings, Refusal as FittedRefusal
from .steam_start import Refusal as SteamStartRefusal
from .loader_hook import reviewed_start_for_local_bundle
from .steam_intake import SteamIntake, Refusal as SteamIntakeRefusal
from .receipt_phase import ReceiptPhaseHook, Refusal as PhaseHookRefusal
from .rich_totals import RichTotalsDiagnostic, Refusal as RichTotalsRefusal, unavailable as totals_unavailable, safe_reason as totals_reason

FLAGS = {key: False for key in ('active', 'eligibleForServing', 'eligibleForPromotion', 'eligibleForQualityClaims', 'eventLatencyVerified', 'coverage95Validated')}
def refused(reason):
    return {'contract': 'wide45938.local.diagnostic.v1', 'status': 'unavailable', 'reason': reason,
        'prediction': None, 'modelHash': None, 'c1': None, 'c2': None, **FLAGS}
def safe_reason(error):
    if isinstance(error, (Refusal,FittedRefusal,SteamStartRefusal,SteamIntakeRefusal,PhaseHookRefusal)) and len(error.args) == 1 and type(error.args[0]) is str and error.args[0].startswith(('c2_','steam_start_')):
        return error.args[0]
    translated = {'cache_not_available_before_proven_start': 'c2_cache_not_available_before_start',
        'startup_cache_older_than_24h': 'c2_history_snapshot_stale_or_future',
        'map_identity_start_or_cache_changed': 'c2_map_identity_start_or_cache_changed',
        'current_receipt_future_or_stale': 'c2_current_receipt_future_or_stale'}
    if isinstance(error, ValueError) and len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in translated: return translated[error.args[0]]
    return 'c2_internal_refusal'
def memory_guard():
    from src.shadow_wide.host import memory_guard as existing_guard
    return existing_guard()
def environment():
    # This is a root startup file binding, never a request-supplied path.
    path = os.environ.get('AEGIS_C2_LOCAL_CONFIG')
    expected = os.environ.get('AEGIS_C2_LOCAL_CONFIG_SHA256')
    if path is None and expected is None: return None
    if not path or not hex64(expected): fail('c2_config_pin_required')
    return path, expected

def optional_refs_environment(name, *, mapping=False):
    raw=os.environ.get(name)
    if raw is None:return {} if mapping else None
    if len(raw)>20000:fail('c2_optional_binding_bound')
    try:value=json.loads(raw)
    except (ValueError,TypeError):fail('c2_optional_binding_json')
    if mapping:
        if not isinstance(value,dict)or len(value)>64 or any(not isinstance(k,str)or not k.isascii()or not k.isdecimal()or k.startswith('0')for k in value):fail('c2_start_bindings_identity')
        return value
    if not isinstance(value,dict):fail('c2_model_binding_ref')
    return value

def diagnostic_json(value):
    # Original profile sidecars legitimately contain unknown NaN metadata.
    # Encoded vectors already have explicit null masks and remain byte-identical.
    paths=[];count=0
    def clean(v,path):
        nonlocal count
        if isinstance(v,float)and not math.isfinite(v):
            count+=1
            if len(paths)<8192:paths.append(path)
            return None
        if isinstance(v,dict):return {k:clean(x,path+'/'+str(k).replace('~','~0').replace('/','~1'))for k,x in v.items()}
        if isinstance(v,(list,tuple)):return [clean(x,path+'/'+str(i))for i,x in enumerate(v)]
        return v
    result=clean(value,'')
    result['metadataNullNormalization']={'contract':'nonfinite_unknown_metadata_to_json_null.v1','count':count,'jsonPointers':paths,
        'pathsTruncated':count>len(paths),'vectorValuesMasksHashesChanged':False}
    return result

class LocalDiagnosticRuntime:
    def __init__(self, settings=None, *, clock=utcnow, guard=memory_guard, engine_factory=None, model_binding_ref=None, start_binding_refs=None, model_factory=None, rich_totals_ref=None, rich_totals_factory=None, steam_intake_settings=None, steam_intake_factory=None, receipt_phase_ref=None, receipt_phase_factory=None):
        self.steam_intake_settings=steam_intake_settings; self.steam_intake_factory=steam_intake_factory; self._steam=None
        self.receipt_phase_ref=receipt_phase_ref; self.receipt_phase_factory=receipt_phase_factory
        self.settings = settings; self.clock = clock; self.guard = guard; self.engine_factory = engine_factory
        self.model_binding_ref=model_binding_ref; self.start_binding_refs=start_binding_refs or {}; self.model_factory=model_factory
        self._models=None; self._model_reason='c2_fitted_binding_missing'
        self.rich_totals_ref=rich_totals_ref; self.rich_totals_factory=rich_totals_factory
        self._totals=None; self._totals_reason='rich_totals_not_configured'
        configured=settings is not None or steam_intake_settings is not None
        self._state='cold' if configured else 'not_configured'; self._reason=None if configured else 'c2_local_config_missing'
        self._bundle = None; self._engine = None; self._results = {}; self._lock = threading.Lock(); self._gate = threading.BoundedSemaphore(1)
        self._stop = threading.Event(); self._thread = None; self._cache_reason = None; self._deadline = None
    def start(self):
        with self._lock:
            if self._state == 'cold':
                self._state = 'loading'
                self._thread = threading.Thread(target=self._bootstrap, daemon=True, name='aegis-c2-local-diagnostic-bootstrap')
                self._thread.start()
        return self.status()
    def _checked_guard(self):
        if self._stop.is_set(): fail('c2_local_stopping')
        if self._deadline is not None and time.monotonic() > self._deadline: fail('c2_local_startup_time_bound')
        if self._deadline is not None and self._steam is not None:self._steam.check_wall()
        return self.guard()
    def _bootstrap(self):
        try:
            self._deadline = time.monotonic()+900
            self._checked_guard()
            if self.steam_intake_settings is not None:
                factory=self.steam_intake_factory or SteamIntake
                self._steam=factory(self.steam_intake_settings,clock=self.clock,guard=self._checked_guard)
                self._bundle=self._steam.bundle
            else:self._bundle = LocalBundle(*self.settings)
            if self.model_binding_ref is not None:
                try:
                    self._models=FittedBindings(self._bundle,self.model_binding_ref,model_factory=self.model_factory,guard=self._checked_guard)
                    self._model_reason=None
                except Exception as error:self._model_reason=safe_reason(error)
            if self.rich_totals_ref is not None:
                try:
                    factory=self.rich_totals_factory or RichTotalsDiagnostic
                    self._totals=factory(self._bundle,self.rich_totals_ref,guard=self._checked_guard)
                    self._totals_reason=None
                except RichTotalsRefusal as error:self._totals_reason=totals_reason(error)
            # First publish precise witness refusals without claiming a vector.
            for name in (() if self._steam is not None else self._bundle.readers):
                if self._stop.is_set(): fail('c2_local_stopping')
                self.refresh_local(name)
            # Build once at true startup time, so later collector callbacks can
            # serve maps whose independently witnessed start follows this build.
            try:
                if self.engine_factory is None:
                    from .engine import Engine
                    factory = Engine
                else: factory = self.engine_factory
                if self._steam is not None:factory=self._steam.engine_type(factory)
                self._engine = factory(self._bundle, clock=self.clock, guard=self._checked_guard)
                if self._steam is not None:
                    phase_factory=None
                    if self.receipt_phase_ref is not None:
                        factory=self.receipt_phase_factory or ReceiptPhaseHook
                        phase_factory=lambda intake:factory(intake,self.receipt_phase_ref,clock=self.clock,guard=self._checked_guard)
                    self._steam.bind(self._engine,phase_factory=phase_factory)
                else:
                    for name in self._bundle.readers: self.refresh_local(name)
            except Exception as error:
                self._cache_reason = safe_reason(error)
                if self._steam is not None:self._engine=None
            self._deadline = None
            with self._lock: self._state = 'ready'; self._reason = None
            if self._steam is not None and self._engine is not None:self._steam_loop()
        except Exception as error:
            with self._lock: self._state = 'failed'; self._reason = safe_reason(error)
    def refresh_local(self, name, *, bundle_ref=None):
        """Shared worker hook only; not exposed as an HTTP write/project route."""
        if self.steam_intake_settings is not None:return refused('c2_steam_only_mode')
        if not self._gate.acquire(blocking=False): return refused('c2_local_busy')
        try:
            if self._bundle is None: return refused('c2_local_not_ready')
            bundle = self._bundle.updated(bundle_ref) if bundle_ref is not None else self._bundle
            reader = bundle.reader(name)
            mid=reader.get('current',{}).get('match_id')
            start_ref=self.start_binding_refs.get(str(mid))
            timing=(reviewed_start_for_local_bundle(bundle,reader,start_ref)
                    if start_ref is not None else bundle.start(reader))
            self._checked_guard()
            if self._engine is None:
                fail('c2_local_cache_not_ready')
            value = self._engine.project(reader, timing, bundle=bundle)
            value = self._diagnose(reader,value)
        except Exception as error: value = refused(safe_reason(error))
        finally: self._gate.release()
        with self._lock: self._results[name] = copy.deepcopy(value)
        return copy.deepcopy(value)
    def _diagnose(self,reader,value):
        try:
            diagnostic=(self._models.project(value,observation_received_at=reader['current']['received_at'],clock_seconds=reader['current'].get('game_time_sec'))
                        if self._models is not None else {'status':'unavailable','reason':self._model_reason,'publicPrediction':None,**FLAGS})
        except FittedRefusal as error:
            # Optional model admission cannot discard a guarded vector.
            # Resource/STOP/Engine errors still reach the outer refusal.
            diagnostic={'status':'unavailable','reason':safe_reason(error),'publicPrediction':None,**FLAGS}
        try:
            # Pass the exact original reader and Engine result, before any
            # response overlay. The sealed runtime owns the 910 extension.
            totals=(self._totals.project(value,reader=reader,computed_at=wall(self.clock).isoformat())
                    if self._totals is not None else totals_unavailable(self._totals_reason))
        except RichTotalsRefusal as error:
            totals=totals_unavailable(totals_reason(error))
        self._checked_guard()
        value = {**value, **FLAGS, 'prediction': None, 'modelHash': None, 'diagnosticModels':diagnostic,
                 'richTotalsDiagnostic':totals}
        return diagnostic_json(value)
    def refresh_steam_committed(self,dispatch):
        """Internal callback only. No HTTP route or client-supplied reader."""
        if self._steam is None or self._engine is None:return refused('c2_steam_not_ready')
        if not self._gate.acquire(blocking=False):return refused('c2_local_busy')
        name='steam-intake-last'
        try:
            self._checked_guard()
            reader,value=self._steam.project(dispatch)
            name='steam-'+str(reader['current']['match_id'])
            # Phase heads already consumed their exact original packet; never send
            # their masked vectors into the live model binding. Normalize last.
            if self._steam.is_phase_result(value):value=diagnostic_json(value)
            else:
                value=self._diagnose(reader,value)
                if self._steam.phase is not None:value=self._steam.phase.finalize_live(reader,value)
        except Exception as error:value=refused(safe_reason(error))
        finally:self._gate.release()
        with self._lock:self._results[name]=copy.deepcopy(value)
        return copy.deepcopy(value)
    def _steam_loop(self):
        # Existing worker thread, finite local files only; never provider polling.
        while not self._stop.is_set() and self._steam.session_active():
            dispatch=self._steam.claim_next()
            if dispatch is None:self._stop.wait(1)
            else:self.refresh_steam_committed(dispatch)
    def result(self, name):
        with self._lock: value = copy.deepcopy(self._results.get(name, refused('c2_local_result_missing')))
        return value
    def status(self):
        with self._lock:
            return {'contract': 'wide45938.local.status.v1', 'state': self._state, 'reason': self._reason,
                'featureCounts': {'C1': 36114, 'C2': 45938}, 'registeredReaders': list(self._results),
                'results': {name: {'status': value['status'], 'reason': value.get('reason')} for name, value in self._results.items()},
                'cacheReady': self._engine is not None, 'cacheReason': self._cache_reason,
                 'providerCalls': 0, 'databaseCalls': None if self._steam is not None and self._steam.phase is not None else 0,
                'readOnlyOutcomePresenceConfigured':self._steam is not None and self._steam.phase is not None,
                'modelsBound':self._models.status()['modelsBound']if self._models else 0,
                'modelsLoaded':self._models.status()['modelsLoaded']if self._models else 0,
                'modelBindingReason':self._model_reason,
                'richTotalsModelsBound':self._totals.status()['modelsBound']if self._totals else 0,
                'richTotalsModelsLoaded':self._totals.status()['modelsLoaded']if self._totals else 0,
                'richTotalsBindingReason':self._totals_reason,
                'richTotalsPhaseRoutingEnabled':self._steam is not None and self._steam.phase is not None,
                'configuredExactSteamStartMatches':sorted(self.start_binding_refs),
                'steamIntake':self._steam.status()if self._steam is not None else {'configured':False},
                'automaticPolling':self._steam is not None and not self._stop.is_set()and self._steam.status().get('localInboxPolling',False),
                'automaticProviderPolling':False,
                'perUserProjection': False, 'measuredEventLatencySeconds': None, **FLAGS}
    def close(self):
        self._stop.set()
        if self._thread: self._thread.join(timeout=2)

def steam_environment():
    path=os.environ.get('AEGIS_C2_STEAM_INTAKE_CONFIG')
    expected=os.environ.get('AEGIS_C2_STEAM_INTAKE_CONFIG_SHA256')
    if path is None and expected is None:return None
    if not path or not hex64(expected):fail('c2_steam_config_pin_required')
    return path,expected

def configured_runtime():
    try: return LocalDiagnosticRuntime(environment(),steam_intake_settings=steam_environment(),
        model_binding_ref=optional_refs_environment('AEGIS_C2_FITTED_DIAGNOSTIC_REF'),
        rich_totals_ref=optional_refs_environment('AEGIS_C2_RICH_TOTALS_CONFIG_REF'),
        receipt_phase_ref=optional_refs_environment('AEGIS_C2_RECEIPT_PHASE_HOOK_REF'),
        start_binding_refs=optional_refs_environment('AEGIS_C2_EXACT_STEAM_START_REFS',mapping=True))
    except Exception as error:
        runtime = LocalDiagnosticRuntime(); runtime._state = 'configuration_error'; runtime._reason = safe_reason(error); return runtime
