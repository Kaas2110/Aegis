"""Default-closed admission for legacy HTTP training, before dataset creation.

This is a resource-role boundary, not model quality approval or a global fit lock.
Prediction entry points and already-running calls are not changed here.
"""
from __future__ import annotations
import hashlib, os
from pathlib import Path
from fastapi import HTTPException

CONTRACT = 'legacy_http_training_admission.v1'
SOURCE_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
GUARDED_PATHS = ['/ml/train', '/train']

def training_admission_status():
    value = os.environ.get('AEGIS_LEGACY_HTTP_TRAINING_ENABLED')
    if value is None: enabled, reason = False, 'disabled_by_default'
    elif value == 'true': enabled, reason = True, 'enabled_explicitly'
    elif value == 'false': enabled, reason = False, 'disabled_explicitly'
    else: enabled, reason = False, 'invalid_configuration_fail_closed'
    return {'contract': CONTRACT, 'enabled': enabled, 'reason': reason,
        'guardedPaths': list(GUARDED_PATHS), 'scope': 'legacy_http_training_routes_only',
        'sourceSha256': SOURCE_SHA256}

def require_legacy_http_training_admission():
    if training_admission_status()['enabled'] is not True:
        raise HTTPException(status_code=503, detail={'reason': 'legacy_http_training_disabled'})
