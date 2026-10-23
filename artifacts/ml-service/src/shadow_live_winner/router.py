"""Inject existing require_token; no main import, endpoint registration or model activation."""
from __future__ import annotations
import json
import hashlib
import logging
import threading
from typing import Any, Callable, Literal
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationError
from .adapter import ContractError, MAX_HISTORY, RuntimeShadowWinnerAdapter

MAX_REQUEST_BYTES = 1_048_576
log = logging.getLogger('ml-service.shadow-live-winner')


class ObservationEnvelope(BaseModel):
    # Unknown raw fields can be retained by the caller; only the adapter's explicit
    # projection becomes a feature. Extras cannot turn quality/serving flags on.
    model_config = ConfigDict(strict=True, extra='allow')
    observationId: StrictStr = Field(pattern=r'^[0-9a-f]{64}$')
    source: Literal['opendota']
    targetScope: Literal['map']
    clockUnit: Literal['seconds']
    scoreUnit: Literal['kills']
    receivedAt: StrictStr = Field(max_length=64)
    recordedAt: StrictStr = Field(max_length=64)
    input: dict[str, Any]


class ShadowLiveWinnerRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    current: ObservationEnvelope
    history: list[ObservationEnvelope] = Field(max_length=MAX_HISTORY)
    expectedMatchId: StrictInt = Field(ge=1, le=2**53-1)


def refuse(status: int, reason: str):
    # Do not echo request payloads, credentials, file paths or upstream exceptions.
    raise HTTPException(status_code=status, detail={'reason': reason})


def reject_json_constant(value):
    raise ValueError('nonstandard_json_number')


async def read_bounded_request(request: Request) -> tuple[ShadowLiveWinnerRequest, str]:
    length = request.headers.get('content-length')
    if length is not None:
        try:
            size = int(length)
        except ValueError:
            refuse(400, 'invalid_content_length')
        if size < 0:
            refuse(400, 'invalid_content_length')
        if size > MAX_REQUEST_BYTES:
            refuse(413, 'shadow_request_too_large')
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
            refuse(413, 'shadow_request_too_large')
        body.extend(chunk)
    try:
        raw = json.loads(body, parse_constant=reject_json_constant)
        return ShadowLiveWinnerRequest.model_validate(raw), hashlib.sha256(body).hexdigest()
    except (ValueError, TypeError, RecursionError, UnicodeError, ValidationError):
        refuse(422, 'invalid_shadow_request')


def create_live_winner_router(require_token: Callable, *, adapter_factory: Callable = RuntimeShadowWinnerAdapter) -> APIRouter:
    """Construction is side-effect free. First authenticated request loads pinned package once.

    The injected factory is internal test/configuration code, never a body/path parameter.
    No active registry row, provider, main application or legacy circuit is consulted.
    """
    router = APIRouter()
    gate = threading.BoundedSemaphore(1)
    instance: RuntimeShadowWinnerAdapter | None = None

    def infer(body: ShadowLiveWinnerRequest):
        nonlocal instance
        if not gate.acquire(blocking=False):
            refuse(503, 'shadow_busy')
        try:
            if instance is None:
                try:
                    instance = adapter_factory()
                except Exception:
                    log.error('Pinned shadow package failed validation/load')
                    refuse(503, 'shadow_package_unavailable')
            try:
                return instance.predict(body.current.model_dump(),
                                        [item.model_dump() for item in body.history],
                                        expected_match_id=body.expectedMatchId)
            except ContractError as exc:
                # Adapter messages are fixed codes only; do not include arbitrary payload data.
                refuse(422, str(exc))
            except Exception:
                log.error('Shadow winner inference failed')
                refuse(503, 'shadow_inference_unavailable')
        finally:
            gate.release()

    @router.post('/shadow/live-winner', dependencies=[Depends(require_token)])
    async def shadow_live_winner(request: Request):
        body, request_body_hash = await read_bounded_request(request)
        result = await run_in_threadpool(infer, body)
        # Bind response to exact bytes received, including otherwise ignored input fields.
        # Client-supplied hash fields cannot override this server-computed value.
        return {**result, 'requestBodySha256': request_body_hash}

    return router
