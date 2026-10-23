"""Root-pinned local files, actual-start field review, and history input loader.

No network/DB dependency. A hash binds bytes; the independently reviewed policy
is responsible for source authenticity and the meaning of an explicit start field.
"""
from __future__ import annotations
import copy, gzip, hashlib, io, json, math, os, re
from datetime import datetime, timezone
from pathlib import Path

class Refusal(ValueError): pass
def fail(reason): raise Refusal(reason)
def sha(raw): return hashlib.sha256(raw).hexdigest()
def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
def integer(value, lower=1): return type(value) is int and lower <= value <= 2**53-1
def hex64(value): return type(value) is str and re.fullmatch('[a-f0-9]{64}', value) is not None
def stamp(value):
    if type(value) in (int, float) and math.isfinite(value) and value > 0: return float(value)
    if type(value) is not str or len(value) > 64: fail('c2_timestamp_invalid')
    try: d = datetime.fromisoformat(value.replace('Z', '+00:00')); result = d.timestamp()
    except (ValueError, OverflowError, OSError): fail('c2_timestamp_invalid')
    if d.tzinfo is None or not math.isfinite(result) or result <= 0: fail('c2_timestamp_invalid')
    return result
def utcnow(): return datetime.now(timezone.utc)
def wall(clock):
    value = clock()
    if not isinstance(value, datetime) or value.tzinfo is None: fail('c2_wall_clock_invalid')
    return value.astimezone(timezone.utc)
def parse(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out: fail('c2_duplicate_json_key')
            out[key] = value
        return out
    try: return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: fail('c2_json_nonfinite'))
    except Refusal: raise
    except (ValueError, UnicodeError, RecursionError): fail('c2_json_invalid')
def trusted_path(path, *, directory=False):
    path = Path(path)
    if not path.is_absolute(): fail('c2_local_absolute_path_required')
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()): fail('c2_local_reparse_path')
    if directory and not path.is_dir(): fail('c2_local_directory_missing')
    return path
def read_file(path, limit):
    path = trusted_path(path)
    if not path.is_file() or path.stat().st_size > limit: fail('c2_local_file_bound')
    with path.open('rb') as stream: raw = stream.read(limit + 1)
    if len(raw) > limit: fail('c2_local_file_bound')
    return raw
def pointer(value, address):
    if type(address) is not str or not address.startswith('/') or len(address) > 256: fail('c2_start_field_pointer')
    try:
        for piece in address[1:].split('/'):
            piece = piece.replace('~1', '/').replace('~0', '~')
            value = value[int(piece)] if isinstance(value, list) and piece.isdecimal() else value[piece]
    except (KeyError, IndexError, TypeError, ValueError): fail('c2_start_field_missing')
    return value

class LocalBundle:
    def __init__(self, config_path, expected_config_sha256):
        if not hex64(expected_config_sha256): fail('c2_config_pin_required')
        raw = read_file(config_path, 100000)
        if sha(raw) != expected_config_sha256: fail('c2_config_pin')
        config = parse(raw)
        if not isinstance(config, dict) or set(config) != {'contract', 'roots', 'bundle', 'startPolicy', 'bridgeDirectory', 'bridgeManifestSha256'} or config['contract'] != 'c2_local_diagnostic_config.v1': fail('c2_config_contract')
        if not isinstance(config['roots'], dict) or not 1 <= len(config['roots']) <= 8: fail('c2_local_roots_bound')
        self.roots = {key: trusted_path(value, directory=True) for key, value in config['roots'].items() if re.fullmatch('[a-zA-Z0-9_-]{1,32}', key)}
        if len(self.roots) != len(config['roots']): fail('c2_local_root_identity')
        self.config = config; self.config_sha256 = sha(raw)
        self.manifest = self.json(config['bundle'], 2000000)
        self.policy = self.json(config['startPolicy'], 1000000)
        if self.manifest.get('contract') != 'c2_local_runtime_bundle.v1' or self.policy.get('contract') != 'c2_reviewed_explicit_start_policy.v1': fail('c2_bundle_contract')
        self._bind_manifest()
        reviews = self.policy.get('reviews')
        if not isinstance(reviews, list) or len(reviews) > 32: fail('c2_start_review_bound')
        self.reviews = {}
        for review in reviews:
            if not isinstance(review, dict) or set(review) != {'id', 'sourceId', 'matchIdPointer', 'actualStartPointer', 'meaning', 'derivation', 'reviewEvidence'} or type(review['id']) is not str or review['id'] in self.reviews: fail('c2_start_review_contract')
            if review['meaning'] != 'actual_match_start_utc' or review['derivation'] != 'provider_explicit_field': fail('c2_actual_start_semantics_unreviewed')
            # Review evidence is a separate root-pinned file, not a supplied bool.
            self.bytes(review['reviewEvidence'], 1000000)
            self.reviews[review['id']] = review

    def _bind_manifest(self):
        if self.manifest.get('contract') != 'c2_local_runtime_bundle.v1': fail('c2_bundle_contract')
        self.readers = self.manifest.get('readers')
        if not isinstance(self.readers, dict) or not 1 <= len(self.readers) <= 64 or any(not re.fullmatch('[a-zA-Z0-9_-]{1,80}', key) for key in self.readers): fail('c2_readers_bound')
        entries = self.manifest.get('startWitnesses')
        if not isinstance(entries, list) or len(entries) > 64: fail('c2_start_witness_bound')
        self.witnesses = {}
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {'matchId', 'capture', 'reviewId'} or not integer(entry['matchId']) or entry['matchId'] in self.witnesses: fail('c2_start_witness_identity')
            self.witnesses[entry['matchId']] = entry
    def updated(self, ref):
        """Trusted collector callback may publish a new pinned local observation
        bundle. Startup history, root paths, formulas and semantics policy freeze.
        No HTTP endpoint accepts this reference or triggers this operation.
        """
        value = copy.copy(self); value.config = {**self.config, 'bundle': copy.deepcopy(ref)}
        value.manifest = self.json(ref, 2000000)
        if value.manifest.get('history') != self.manifest.get('history'): fail('c2_startup_history_changed')
        value._bind_manifest()
        return value

    def path(self, ref):
        if not isinstance(ref, dict) or set(ref) != {'root', 'path', 'sha256', 'bytes'} or ref['root'] not in self.roots or not hex64(ref['sha256']) or not integer(ref['bytes'], 0): fail('c2_artifact_reference')
        relative = Path(ref['path']) if type(ref['path']) is str else None
        if relative is None or relative.is_absolute() or '..' in relative.parts or not relative.parts: fail('c2_artifact_path')
        base = self.roots[ref['root']]; path = trusted_path(base / relative)
        if not path.resolve().is_relative_to(base.resolve()): fail('c2_artifact_path')
        return path

    def bytes(self, ref, limit):
        if not isinstance(ref, dict) or type(ref.get('bytes')) is not int: fail('c2_artifact_reference')
        if ref['bytes'] > limit: fail('c2_artifact_declared_bound')
        raw = read_file(self.path(ref), limit)
        if len(raw) != ref['bytes'] or sha(raw) != ref['sha256']: fail('c2_artifact_pin')
        return raw
    def json(self, ref, limit): return parse(self.bytes(ref, limit))
    def reader(self, name):
        if name not in self.readers: fail('c2_reader_not_registered')
        value = self.json(self.readers[name], 16*1024**2)
        if not isinstance(value, dict): fail('c2_reader_contract')
        return value

    def start(self, reader):
        current = reader.get('current', {})
        mid = current.get('match_id')
        if not integer(mid): fail('c2_match_identity')
        entry = self.witnesses.get(mid)
        if entry is None: fail('c2_actual_start_witness_missing')
        review = self.reviews.get(entry['reviewId'])
        if review is None: fail('c2_actual_start_semantics_unreviewed')
        capture = self.json(entry['capture'], 1000000)
        if not isinstance(capture, dict) or set(capture) != {'contract', 'sourceId', 'receivedAt', 'persistedAt', 'outcomeKnownAtCapture', 'body'} or capture['contract'] != 'reviewed_explicit_start_capture.v1' or capture['sourceId'] != review['sourceId'] or capture['outcomeKnownAtCapture'] is not False: fail('c2_start_capture_contract')
        payload = self.json(capture['body'], 16*1024**2)
        source_mid = pointer(payload, review['matchIdPointer'])
        if not integer(source_mid) or source_mid != mid: fail('c2_start_source_identity')
        actual = stamp(pointer(payload, review['actualStartPointer']))
        known = stamp(capture['receivedAt']); persisted = stamp(capture['persistedAt']); receipt = stamp(current.get('received_at'))
        if not actual <= known <= persisted <= receipt: fail('c2_start_not_known_asof_observation')
        return {'contract': 'reviewed_target_start_evidence_v1', 'matchId': mid, 'actualStart': actual, 'knownAt': known,
            'source': review['sourceId'], 'sourceSha256': capture['body']['sha256'], 'reviewId': review['id'],
            'captureSha256': entry['capture']['sha256'], 'reviewEvidenceSha256': review['reviewEvidence']['sha256'],
            'semanticsPolicySha256': self.config['startPolicy']['sha256']}

    def history(self, *, clock=utcnow, guard=lambda: None):
        history = self.manifest.get('history')
        if not isinstance(history, dict) or set(history) != {'maps', 'rows', 'snapshotCutoff', 'capturedAt', 'captureProof', 'heroReference', 'purchaseIndex'}: fail('c2_history_contract')
        cutoff = stamp(history['snapshotCutoff']); captured = stamp(history['capturedAt']); now = wall(clock).timestamp()
        if not cutoff <= captured <= now or now-cutoff > 86400: fail('c2_history_snapshot_stale_or_future')
        proof = self.json(history['captureProof'], 1000000)
        if (not isinstance(proof, dict) or set(proof) != {'contract', 'knownAt', 'snapshotCutoff', 'maps', 'heroReference', 'purchaseIndex', 'readOnly', 'originalHistoricalReceiptProven'}
            or proof['contract'] != 'c2_local_immutable_history_capture.v1' or proof['readOnly'] is not True or proof['originalHistoricalReceiptProven'] is not False
            or stamp(proof['knownAt']) != captured or stamp(proof['snapshotCutoff']) != cutoff
            or any(proof[key] != history[key] for key in ('maps', 'heroReference', 'purchaseIndex'))): fail('c2_history_capture_proof')
        count = history['rows']
        if not integer(count) or count > 50000: fail('c2_history_rows_bound')
        ref = history['maps']; path = self.path(ref)
        if ref['bytes'] > 512*1024**2 or path.stat().st_size != ref['bytes']: fail('c2_history_bytes_bound')
        rows = []; hasher = hashlib.sha256(); consumed = 0
        with path.open('rb') as stream:
            while True:
                line = stream.readline(2*1024**2 + 1)
                if not line: break
                consumed += len(line)
                if len(line) > 2*1024**2 or len(rows) >= count or consumed > ref['bytes']: fail('c2_history_stream_bound')
                hasher.update(line); rows.append(parse(line))
                if len(rows) % 100 == 1: guard()
        if len(rows) != count or consumed != ref['bytes'] or hasher.hexdigest() != ref['sha256']: fail('c2_history_stream_pin')
        heroes = self.json(history['heroReference'], 2000000)
        if not isinstance(heroes, dict) or not heroes or any(not k.isdecimal() or not isinstance(v, str) for k, v in heroes.items()): fail('c2_hero_reference')
        hero_names = {int(k): v for k, v in heroes.items()}
        index = self.json(history['purchaseIndex'], 16*1024**2)
        if not isinstance(index, list) or len(index) > count: fail('c2_purchase_index_bound')
        by_id = {}
        for entry in index:
            if not isinstance(entry, dict) or set(entry) != {'matchId', 'sourceId', 'receipt', 'encoding'} or not integer(entry['matchId']) or entry['matchId'] in by_id or entry['encoding'] not in ('json', 'json.gz') or type(entry['sourceId']) is not str or not 1 <= len(entry['sourceId']) <= 1024: fail('c2_purchase_index_identity')
            by_id[entry['matchId']] = entry
        if not set(by_id).issubset({row.get('match_id') for row in rows}): fail('c2_purchase_index_unknown_map')
        calls = set()
        def purchase_lookup(mid):
            if mid in calls: fail('c2_purchase_lookup_repeated')
            calls.add(mid); guard(); entry = by_id.get(mid)
            if entry is None: return None
            raw = self.bytes(entry['receipt'], 4_000_000 if entry['encoding'] == 'json.gz' else 16_000_000)
            if entry['encoding'] == 'json.gz':
                with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream: decoded = stream.read(16_000_001)
                if len(decoded) > 16_000_000: fail('c2_purchase_decoded_bound')
            else: decoded = raw
            receipt = parse(decoded)
            return {'receipt': receipt, 'receiptSha256': entry['receipt']['sha256'], 'receiptCanonicalSha256': sha(canonical(receipt)), 'sourceId': entry['sourceId']}
        return {'cache_args': {'rows': rows, 'snapshot_sha256': sha(canonical(rows)), 'snapshot_cutoff': cutoff, 'built_at': wall(clock).timestamp(),
            'hero_names': hero_names, 'purchase_lookup': purchase_lookup, 'guard': guard}, 'source_known_at': captured,
            'historyCaptureProofSha256': history['captureProof']['sha256']}
