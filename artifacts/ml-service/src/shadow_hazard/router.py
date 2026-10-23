"""Explicit authenticated route factory; no main import, bootstrap or network IO."""
from __future__ import annotations
import hashlib,json
from typing import Any,Callable,Literal
from fastapi import APIRouter,Depends,HTTPException,Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel,ConfigDict,Field,StrictBool,StrictInt,StrictFloat,StrictStr,ValidationError
from .runtime import HazardRuntime

MAX_REQUEST_BYTES=262144
MAX_RESPONSE_BYTES=1048576
class CurrentObservation(BaseModel):
    model_config=ConfigDict(strict=True,extra='forbid')
    observationId:StrictStr=Field(pattern=r'^[0-9a-f]{64}$')
    source:Literal['opendota'];targetScope:Literal['map'];clockUnit:Literal['seconds']
    receivedAt:StrictStr=Field(max_length=64);recordedAt:StrictStr=Field(max_length=64)
    phase:Literal['pre_draft','post_draft','live','unknown']
    input:dict[str,Any];availability:dict[str,Any]
    sourceInputHash:StrictStr=Field(pattern=r'^[0-9a-f]{64}$')
    sourceSchemaHash:StrictStr=Field(pattern=r'^[0-9a-f]{64}$')
class Line(BaseModel):
    model_config=ConfigDict(strict=True,extra='forbid')
    target:StrictStr=Field(max_length=32)
    line:StrictInt|StrictFloat=Field(ge=0,le=2**53-1,allow_inf_nan=False)
    unit:StrictStr=Field(max_length=32)
    settlement:StrictStr|None=Field(default=None,max_length=32)
class HazardRequest(BaseModel):
    model_config=ConfigDict(strict=True,extra='forbid')
    current:CurrentObservation
    expectedMatchId:StrictInt=Field(ge=1,le=2**53-1)
    outcomeKnownAtDispatch:StrictBool|None
    lineSource:Literal['own_diagnostic_grid']
    lines:list[Line]=Field(max_length=128)
def refuse(status,reason):raise HTTPException(status_code=status,detail={'reason':reason})
def bad_constant(value):raise ValueError('nonstandard_json_number')
async def read_request(request):
    length=request.headers.get('content-length')
    if length is not None:
        try:size=int(length)
        except ValueError:refuse(400,'invalid_content_length')
        if size<0:refuse(400,'invalid_content_length')
        if size>MAX_REQUEST_BYTES:refuse(413,'hazard_request_too_large')
    data=bytearray()
    async for chunk in request.stream():
        if len(data)+len(chunk)>MAX_REQUEST_BYTES:refuse(413,'hazard_request_too_large')
        data.extend(chunk)
    try:
        raw=json.loads(data,parse_constant=bad_constant)
        return HazardRequest.model_validate(raw),hashlib.sha256(data).hexdigest()
    except (ValueError,TypeError,RecursionError,UnicodeError,ValidationError):refuse(422,'invalid_hazard_request')
def create_hazard_router(require_token:Callable,*,runtime:HazardRuntime|None=None):
    instance=runtime if runtime is not None else HazardRuntime();router=APIRouter()
    @router.get('/shadow/live-totals-hazard/status',dependencies=[Depends(require_token)])
    async def status():return instance.status()
    @router.post('/shadow/live-totals-hazard',dependencies=[Depends(require_token)])
    async def predict(request:Request):
        body,digest=await read_request(request)
        try:result=await run_in_threadpool(instance.predict,body.model_dump())
        except Exception:refuse(503,'hazard_diagnostic_unavailable')
        result={**result,'requestBodySha256':digest}
        try:encoded=json.dumps(result,separators=(',',':'),ensure_ascii=False,allow_nan=False)
        except (ValueError,TypeError,RecursionError):refuse(503,'hazard_response_invalid')
        if len(encoded.encode('utf8'))>MAX_RESPONSE_BYTES:refuse(503,'hazard_response_too_large')
        return result
    return router
