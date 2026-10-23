"""Inject existing require_token; no main import or route registration side effects."""
from __future__ import annotations
import hashlib,json
from contextlib import asynccontextmanager
from typing import Any,Callable,Literal
from fastapi import APIRouter,Depends,HTTPException,Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel,ConfigDict,Field,StrictBool,StrictInt,StrictStr,ValidationError
from .actor import PostdraftActor

MAX_REQUEST_BYTES=262144
MAX_RESPONSE_BYTES=1572864
class CurrentObservation(BaseModel):
    model_config=ConfigDict(strict=True,extra='forbid')
    observationId:StrictStr=Field(pattern=r'^[0-9a-f]{64}$')
    source:Literal['opendota']
    targetScope:Literal['map']
    clockUnit:Literal['seconds']
    receivedAt:StrictStr=Field(max_length=64)
    recordedAt:StrictStr=Field(max_length=64)
    phase:Literal['pre_draft','post_draft','live']
    input:dict[str,Any]
    availability:dict[str,Any]
    sourceInputHash:StrictStr=Field(pattern=r'^[0-9a-f]{64}$')
    sourceSchemaHash:StrictStr=Field(pattern=r'^[0-9a-f]{64}$')
class PostdraftRequest(BaseModel):
    model_config=ConfigDict(strict=True,extra='forbid')
    current:CurrentObservation
    expectedMatchId:StrictInt=Field(ge=1,le=2**53-1)
    outcomeKnownAtDispatch:StrictBool|None
def refuse(status,reason):raise HTTPException(status_code=status,detail={'reason':reason})
def bad_constant(value):raise ValueError('nonstandard_json_number')
async def read_request(request):
    length=request.headers.get('content-length')
    if length is not None:
        try:size=int(length)
        except ValueError:refuse(400,'invalid_content_length')
        if size<0:refuse(400,'invalid_content_length')
        if size>MAX_REQUEST_BYTES:refuse(413,'postdraft_request_too_large')
    data=bytearray()
    async for chunk in request.stream():
        if len(data)+len(chunk)>MAX_REQUEST_BYTES:refuse(413,'postdraft_request_too_large')
        data.extend(chunk)
    try:
        raw=json.loads(data,parse_constant=bad_constant)
        return PostdraftRequest.model_validate(raw),hashlib.sha256(data).hexdigest()
    except (ValueError,TypeError,RecursionError,UnicodeError,ValidationError):refuse(422,'invalid_postdraft_request')

def create_postdraft_router(require_token:Callable,*,actor:PostdraftActor|None=None):
    """Only actor construction; no bootstrap/DB/provider call on registration."""
    instance=actor if actor is not None else PostdraftActor()
    maintenance=None
    maintenance_error=None
    @asynccontextmanager
    async def lifespan(app):
        nonlocal maintenance,maintenance_error
        from .refresh import configured_refresh
        try:maintenance=configured_refresh(instance)
        except Exception:maintenance_error={'state':'configuration_error','reason':'snapshot_refresh_configuration_unavailable','providerCalls':0}
        if maintenance is not None:
            instance.start();maintenance.start()
        try:yield
        finally:
            if maintenance is not None:maintenance.close()
            instance.close()
    router=APIRouter(lifespan=lifespan)
    @router.get('/shadow/postdraft/status',dependencies=[Depends(require_token)])
    async def status():return {**instance.status(),'refresh':maintenance.status() if maintenance is not None else maintenance_error}
    @router.post('/shadow/postdraft/warmup',dependencies=[Depends(require_token)])
    async def warmup():return instance.start()
    @router.post('/shadow/postdraft',dependencies=[Depends(require_token)])
    async def predict(request:Request):
        body,digest=await read_request(request)
        try:result=await run_in_threadpool(instance.predict,body.model_dump())
        except Exception:refuse(503,'postdraft_diagnostic_unavailable')
        result={**result,'requestBodySha256':digest}
        try:encoded=json.dumps(result,separators=(',',':'),ensure_ascii=False,allow_nan=False)
        except (ValueError,TypeError,RecursionError):refuse(503,'postdraft_response_invalid')
        if len(encoded.encode('utf8'))>MAX_RESPONSE_BYTES:refuse(503,'postdraft_response_too_large')
        return result
    return router
