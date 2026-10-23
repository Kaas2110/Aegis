"""Explicit include_router factory; injected existing X-ML-Token authenticator."""
from __future__ import annotations
import threading
from contextlib import asynccontextmanager
from fastapi import APIRouter,Depends,Request,HTTPException
from fastapi.concurrency import run_in_threadpool
from .host import configured_host,MAX_REQUEST_BYTES,MAX_RESPONSE_BYTES
from .common import Refusal,parse,digest,canonical,refusal

def create_wide_router(require_token,*,host=None):
 instance=host if host is not None else configured_host()
 # At most two bounded body buffers; one runtime operation, no unbounded waiters.
 admission=threading.BoundedSemaphore(2)
 @asynccontextmanager
 async def lifespan(app):
  instance.start()
  try:yield
  finally:instance.close()
 router=APIRouter(lifespan=lifespan)
 @router.get('/shadow/wide/status',dependencies=[Depends(require_token)])
 async def status():return instance.status()
 @router.get('/shadow/wide/anchor-binding/{match_id}',dependencies=[Depends(require_token)])
 async def binding(match_id:int):
  if not admission.acquire(blocking=False):raise HTTPException(429,detail={'reason':'wide_ingress_busy'})
  try:return await run_in_threadpool(instance.binding,match_id)
  finally:admission.release()
 @router.post('/shadow/wide/observation',dependencies=[Depends(require_token)])
 async def observation(request:Request):
  if not admission.acquire(blocking=False):raise HTTPException(429,detail={'reason':'wide_ingress_busy'})
  try:
   length=request.headers.get('content-length')
   if length is not None:
    try:n=int(length)
    except ValueError:raise HTTPException(400,detail={'reason':'invalid_content_length'})
    if n<0 or n>MAX_REQUEST_BYTES:raise HTTPException(413,detail={'reason':'wide_request_size'})
   raw=bytearray()
   async for chunk in request.stream():
    if len(raw)+len(chunk)>MAX_REQUEST_BYTES:raise HTTPException(413,detail={'reason':'wide_request_size'})
    raw.extend(chunk)
   try:body=parse(raw)
   except (ValueError,TypeError,UnicodeError,RecursionError):raise HTTPException(422,detail={'reason':'wide_request_json'})
   result=await run_in_threadpool(instance.handle,body)
   result={**result,'requestBodySha256':digest(raw)}
   try:encoded=canonical(result)
   except (ValueError,TypeError,RecursionError):raise HTTPException(503,detail={'reason':'wide_response_invalid'})
   if len(encoded)>MAX_RESPONSE_BYTES:raise HTTPException(503,detail={'reason':'wide_response_size'})
   return result
  finally:admission.release()
 return router
