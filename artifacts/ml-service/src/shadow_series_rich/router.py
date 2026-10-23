"""Authenticated reader-name-only diagnostic routes; no public prediction changes."""
from fastapi import APIRouter,Depends
from pydantic import BaseModel,ConfigDict
from .host import configured_runtime
class ReaderRequest(BaseModel):
 model_config=ConfigDict(extra='forbid')
 readerName:str
def create_series_diagnostic_router(require_token,*,runtime=None):
 instance=runtime if runtime is not None else configured_runtime();router=APIRouter()
 @router.get('/diagnostics/series-rich/status',dependencies=[Depends(require_token)])
 def status():return instance.status()
 @router.post('/diagnostics/series-rich/evaluate',dependencies=[Depends(require_token)])
 def evaluate(request:ReaderRequest):return instance.result(request.readerName)
 return router
