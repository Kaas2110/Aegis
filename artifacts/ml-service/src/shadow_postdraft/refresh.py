"""Refresh a derived history cache using only a local read-only DB snapshot.

A durable allocation marker makes interrupted exports recoverable. Deletion is
limited to two named derived files under an owned generation; audit records stay.
"""
from __future__ import annotations
import hashlib
import json
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

INTERVAL_SECONDS = 6 * 3600
RETRY_SECONDS = 15 * 60
KEEP_GENERATIONS = 4
MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024
MIN_FREE_BYTES = 2 * 2**30
GENERATION = re.compile(r'^generation-\d{8}T\d{6}Z-[a-f0-9]{12}$')
FILES = {'maps.jsonl', 'hero-reference.json', 'MANIFEST.json', 'OWNER.json', 'DISCARDED.json'}

def now_utc(): return datetime.now(timezone.utc)
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def epoch(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None: raise ValueError('timezone_required')
    return result.timestamp()

def checked_path(path):
    path = Path(path)
    if not path.is_absolute(): raise ValueError('absolute_store_path_required')
    for item in [path, *path.parents]:
        if item.is_symlink() or (item.exists() and item.is_junction()):
            raise ValueError('store_reparse_refused')
    return path.resolve()

def atomic_json(path, value):
    path = checked_path(path)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists(): checked_path(temp).unlink()

def read_json(path): return json.loads(checked_path(path).read_text(encoding='utf-8'))

class SnapshotStore:
    def __init__(self, root, reference):
        self.root = checked_path(root); self.reference = checked_path(reference)
        self.root.mkdir(parents=True, exist_ok=True)
        marker = self.root / 'STORE.json'
        if not marker.exists():
            if list(self.root.iterdir()): raise ValueError('nonempty_unowned_store')
            atomic_json(marker, {'contract': 'aegis_postdraft_derived_store_v1', 'owner': uuid.uuid4().hex})
        self.marker = read_json(marker)
        if (self.marker.get('contract') != 'aegis_postdraft_derived_store_v1' or
                not re.fullmatch('[a-f0-9]{32}', self.marker.get('owner', ''))):
            raise ValueError('wrong_store_contract')

    def directory(self, name):
        if not isinstance(name, str) or not GENERATION.fullmatch(name): raise ValueError('unsafe_generation')
        result = checked_path(self.root / name)
        if result.parent != self.root: raise ValueError('foreign_generation')
        return result

    def current(self):
        pointer = self.root / 'CURRENT.json'
        if not pointer.exists(): return None
        value = read_json(pointer)
        if value.get('owner') != self.marker['owner']: raise ValueError('unsafe_store_pointer')
        directory = self.directory(value.get('generation'))
        if digest(checked_path(directory / 'MANIFEST.json')) != value.get('manifestSha256'):
            raise ValueError('store_pointer_hash_mismatch')
        from .actor import SnapshotConfig
        return SnapshotConfig(directory, value['manifestSha256'])

    def _owned(self, directory):
        directory = self.directory(directory.name)
        owner = read_json(directory / 'OWNER.json')
        if owner != {'owner': self.marker['owner'], 'generation': directory.name}:
            raise ValueError('unowned_generation')
        return directory

    def discard(self, directory, reason='failed_generation'):
        """Only derived bytes; never active generation, unknown files or source DB."""
        directory = checked_path(directory)
        if directory.parent != self.root: raise ValueError('foreign_generation')
        directory = self._owned(directory)
        active = self.current()
        if active is not None and active.directory == directory: return False
        if not {p.name for p in directory.iterdir()} <= FILES: raise ValueError('unknown_generation_file')
        targets = [checked_path(directory / name) for name in ('maps.jsonl', 'hero-reference.json')]
        for target in targets:
            if target.parent != directory or (target.exists() and not target.is_file()):
                raise ValueError('unsafe_retention_target')
        for target in targets:
            if target.exists(): target.unlink()
        atomic_json(directory / 'DISCARDED.json', {'reason': reason, 'discardedAt': now_utc().isoformat()})
        return True

    def recover_pending(self):
        pending = self.root / 'PENDING.json'
        if not pending.exists(): return
        value = read_json(pending)
        if value.get('owner') != self.marker['owner']: raise ValueError('foreign_pending_generation')
        directory = self.directory(value.get('generation'))
        if directory.exists():
            # Allocation was recorded before mkdir/export, so even a crash before
            # the first row has an explicit ownership record.
            owner = directory / 'OWNER.json'
            if not owner.exists(): atomic_json(owner, {'owner': self.marker['owner'], 'generation': directory.name})
            self.discard(directory, 'interrupted_or_failed_export')
        checked_path(pending).unlink()

    def export(self, guard):
        import psycopg
        from psycopg.rows import dict_row
        from psycopg.conninfo import conninfo_to_dict
        from src.research.postdraft_full.export_snapshot import export_snapshot
        options = conninfo_to_dict(os.environ['DATABASE_URL'])
        if options.get('host') not in ('localhost', '127.0.0.1', '::1'):
            raise ValueError('only_local_database_allowed')
        self.recover_pending()
        name = 'generation-' + now_utc().strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:12]
        directory = self.directory(name)
        atomic_json(self.root / 'PENDING.json', {'owner': self.marker['owner'], 'generation': name})
        def bounded_guard():
            guard()
            if shutil.disk_usage(self.root).free < MIN_FREE_BYTES: raise ValueError('snapshot_disk_headroom')
            if directory.exists():
                owner = directory / 'OWNER.json'
                if not owner.exists(): atomic_json(owner, {'owner': self.marker['owner'], 'generation': name})
                data = checked_path(directory / 'maps.jsonl')
                if data.exists() and data.stat().st_size > MAX_SNAPSHOT_BYTES: raise ValueError('snapshot_size_limit')
        try:
            bounded_guard()
            with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row, connect_timeout=5) as connection:
                export_snapshot(connection, directory, self.reference, guard=bounded_guard)
            bounded_guard()
            from .actor import SnapshotConfig
            return SnapshotConfig(directory, digest(directory / 'MANIFEST.json'))
        except Exception:
            self.recover_pending()
            raise

    def publish(self, config):
        directory = checked_path(config.directory)
        if directory.parent != self.root: raise ValueError('foreign_generation')
        self._owned(directory)
        if digest(checked_path(directory / 'MANIFEST.json')) != config.manifest_sha256:
            raise ValueError('publication_hash_mismatch')
        atomic_json(self.root / 'CURRENT.json', {'owner': self.marker['owner'], 'generation': directory.name,
                    'manifestSha256': config.manifest_sha256, 'publishedAt': now_utc().isoformat()})
        # Do not fail the publication after CURRENT is committed. The pending
        # marker is safe on restart because recover_pending protects CURRENT.
        try:
            pending = self.root / 'PENDING.json'
            if pending.exists() and read_json(pending).get('generation') == directory.name:
                checked_path(pending).unlink()
        except Exception: pass

    def prune(self, active):
        active = checked_path(active)
        if active.parent != self.root: raise ValueError('foreign_active_generation')
        candidates = []
        for directory in self.root.iterdir():
            if not GENERATION.fullmatch(directory.name): continue
            directory = checked_path(directory)
            if not directory.is_dir(): raise ValueError('generation_not_directory')
            if not (directory / 'OWNER.json').exists(): continue
            self._owned(directory)
            manifest = directory / 'MANIFEST.json'
            if not manifest.exists() or not (directory / 'maps.jsonl').exists(): continue
            value = read_json(manifest)
            if value.get('contract') != 'startup_postdraft_history_snapshot_v1' or value.get('readOnly') is not True: continue
            candidates.append((epoch(value['snapshotCutoff']), directory))
        keep = {p for _, p in sorted(candidates, reverse=True)[:KEEP_GENERATIONS]}; keep.add(active)
        for _, directory in candidates:
            if directory not in keep: self.discard(directory, 'retention_pruned')

class RefreshLoop:
    def __init__(self, actor, store, *, exporter=None, now=now_utc):
        self.actor = actor; self.store = store; self.exporter = exporter or store.export; self.now = now
        self.stop_event = threading.Event(); self.thread = None; self.gate = threading.Lock(); self.retry_at = 0
        self.last = {'state': 'idle', 'lastSuccessAt': None, 'reason': None, 'providerCalls': 0, 'intervalSeconds': INTERVAL_SECONDS}

    def step(self):
        if not self.gate.acquire(blocking=False): return 'already_running'
        config = None
        try:
            if self.stop_event.is_set(): return 'stopped'
            status = self.actor.status(); now = self.now().timestamp()
            if status['state'] == 'building' or now < self.retry_at: return 'deferred'
            cutoff = status.get('snapshotCutoff')
            if status['state'] == 'ready' and cutoff is not None and 0 <= now - epoch(cutoff) < INTERVAL_SECONDS:
                return 'not_due'
            self.last = {**self.last, 'state': 'exporting', 'reason': None}
            self.store.recover_pending()
            config = self.store.current()
            if config is not None:
                meta = read_json(config.directory / 'MANIFEST.json'); age = now - epoch(meta['snapshotCutoff'])
                if not 0 <= age < INTERVAL_SECONDS or (cutoff and epoch(meta['snapshotCutoff']) <= epoch(cutoff)):
                    config = None
            if config is None: config = self.exporter(self.actor._checked_guard)
            self.last = {**self.last, 'state': 'building'}
            if not self.actor.replace_snapshot(config, publish=self.store.publish): raise RuntimeError('replacement_not_ready')
            self.last = {**self.last, 'state': 'idle', 'lastSuccessAt': self.now().isoformat(), 'reason': None}
            try: self.store.prune(config.directory)
            except Exception: self.last = {**self.last, 'reason': 'retention_deferred'}
            self.retry_at = 0
            return 'replaced'
        except Exception:
            cleanup_failed = False
            try:
                if config is not None: self.store.discard(config.directory)
                self.store.recover_pending()
            except Exception: cleanup_failed = True
            self.retry_at = self.now().timestamp() + RETRY_SECONDS
            self.last = {**self.last, 'state': 'retry_wait', 'reason': 'snapshot_cleanup_required' if cleanup_failed else 'snapshot_refresh_unavailable'}
            # Refuse further exports if owned bytes cannot safely be cleaned.
            if cleanup_failed: self.retry_at = float('inf')
            return 'failed'
        finally: self.gate.release()

    def _run(self):
        while not self.stop_event.is_set():
            self.step(); self.stop_event.wait(30)
    def start(self):
        if self.thread and self.thread.is_alive(): return
        self.thread = threading.Thread(target=self._run, name='aegis-postdraft-refresh', daemon=True); self.thread.start()
    def close(self): self.stop_event.set()
    def status(self): return dict(self.last)

def configured_refresh(actor):
    if os.environ.get('AEGIS_POSTDRAFT_AUTO_REFRESH') != '1': return None
    root = os.environ.get('AEGIS_POSTDRAFT_SNAPSHOT_STORE', '')
    reference = os.environ.get('AEGIS_POSTDRAFT_REFERENCE_FILE', '')
    store = SnapshotStore(root, reference)
    saved = store.current()
    if saved is not None:
        cutoff = epoch(read_json(saved.directory / 'MANIFEST.json')['snapshotCutoff'])
        if 0 <= now_utc().timestamp() - cutoff < 86400:
            actor.configure_saved_snapshot(saved)
    return RefreshLoop(actor, store)
