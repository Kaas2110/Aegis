"""Reuse the exact reviewed corrected7148/C1/C2 bridge, without array copies."""
from __future__ import annotations
import importlib, inspect, sys, textwrap, threading
from pathlib import Path
from .local import Refusal, fail, parse, read_file, sha, trusted_path, wall

BRIDGE_MANIFEST_SHA256 = '2681490fb6dc706d1bc63cecdbb03f319a176224147955d47c0504ef5ac2e32f'
_IMPORT_LOCK = threading.Lock()

def modules(directory, expected):
    directory = trusted_path(directory, directory=True)
    if expected != BRIDGE_MANIFEST_SHA256: fail('c2_bridge_revision_unreviewed')
    raw = read_file(directory / 'MANIFEST.json', 1000000)
    if sha(raw) != expected: fail('c2_bridge_manifest_pin')
    manifest = parse(raw)
    for name, entry in manifest['files'].items():
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts: fail('c2_bridge_package_path')
        if sha(read_file(directory / relative, 32*1024**2)) != entry['sha256']: fail('c2_bridge_package_pin')
    # The old finite bridge is script-style. Reuse only its verified modules;
    # refuse any process-global import collision rather than shadow another app.
    with _IMPORT_LOCK:
        expected_modules = {name: directory/(name+'.py') for name in ('dependencies', 'identity', 'corrected_cache', 'bridge')}
        expected_modules.update({'profiles': directory.parent/'per-player-asof-profiles-20261019/profiles.py',
            'shared_formulas': directory.parent/'per-player-asof-profiles-20261019/shared_formulas.py',
            'appendix': directory.parent/'individual-profile-appendix-20261019/appendix.py',
            'relative_roster': directory.parent/'relative-roster-state-extension-20261019/relative_roster.py'})
        for name, expected_path in expected_modules.items():
            loaded = sys.modules.get(name)
            if loaded is not None and (not getattr(loaded, '__file__', None) or Path(loaded.__file__).resolve() != expected_path.resolve()): fail('c2_bridge_import_collision')
        if str(directory) not in sys.path: sys.path.insert(0, str(directory))
        dependencies = importlib.import_module('dependencies')
        dependencies.verify() # all existing formula/source pins before formula imports
        cache = importlib.import_module('corrected_cache')
        bridge = importlib.import_module('bridge')
    return cache.CorrectedPriorCache, bridge.StagedRuntimeBridge

def timing_adapter(Cache, Bridge):
    """Change two integration-time checks/metadata, never a feature formula.
    Exact pinned method text is required. Old sealed code remains untouched.
    Data knownAt must precede actual start; physical memoization may follow it.
    """
    def changed(method, before, after):
        source = textwrap.dedent(inspect.getsource(method))
        if source.count(before) != 1: fail('c2_timing_adapter_source_changed')
        namespace = dict(method.__globals__)
        exec(compile(source.replace(before, after, 1), '<reviewed-c2-local-time-boundary>', 'exec'), namespace)
        return namespace[method.__name__]
    cache_project = changed(Cache.project,
        'if not self.cutoff<=self.built_at<=start<=receipt:',
        'if not self.cutoff<=self.source_known_at<=start<=receipt or not self.source_known_at<=self.built_at<=receipt:')
    bridge_project = changed(Bridge.project,
        "'latest_prior_receipt_at':self.cache.built_at,'context_built_at':self.cache.built_at,",
        "'latest_prior_receipt_at':self.cache.source_known_at,'context_built_at':self.cache.built_at,")
    return type('LocalAvailabilityCache', (Cache,), {'project': cache_project}), type('LocalAvailabilityBridge', (Bridge,), {'project': bridge_project})

class Engine:
    def __init__(self, bundle, *, clock, guard):
        history = bundle.history(clock=clock, guard=guard)
        Cache, Bridge = modules(bundle.config['bridgeDirectory'], bundle.config['bridgeManifestSha256'])
        Cache, Bridge = timing_adapter(Cache, Bridge)
        self.cache = Cache(**history['cache_args'])
        self.cache.source_known_at = history['source_known_at']
        self.bridge = Bridge(self.cache)
        guard()
        # Availability is the real completion time, never the start of a long
        # loader/build operation and never a historical manifest's claim.
        completed = wall(clock).timestamp()
        if completed < self.cache.built_at or completed-self.cache.cutoff > 86400: fail('c2_cache_completion_clock')
        self.cache.built_at = completed
        self.cache.proof['builtAt'] = self.cache.built_at
        self.cache.proof['snapshotSourceKnownAt'] = self.cache.source_known_at
        self.cache.proof['historyCaptureProofSha256'] = history['historyCaptureProofSha256']
        self.bundle = bundle; self.clock = clock; self.guard = guard
    def project(self, reader, timing, *, bundle=None):
        bundle = bundle or self.bundle
        self.guard()
        result = self.bridge.project(reader, timing, clock=self.clock)
        self.guard()
        result['localLoader'] = {'contract': 'c2_trusted_local_loader.v1', 'configSha256': bundle.config_sha256,
            'bundleManifestSha256': bundle.config['bundle']['sha256'], 'startSemanticsPolicySha256': bundle.config['startPolicy']['sha256'],
            'rawHistoryFileSha256': bundle.manifest['history']['maps']['sha256'], 'noProviderOrDatabaseCalls': True,
            'timingPolicy': 'immutable_input_known_before_actual_start; materialized_before_observation_receipt',
            'sourceKnownAt': self.cache.source_known_at, 'cacheMaterializedAt': self.cache.built_at,
            'timingAdapterSourceSha256': sha(read_file(Path(__file__), 100000))}
        return result
