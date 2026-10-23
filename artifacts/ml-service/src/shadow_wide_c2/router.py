"""Internal authenticated read-only registration; no vector/path request input."""
from contextlib import asynccontextmanager
from fastapi import APIRouter, Depends
from .host import configured_runtime

def create_c2_local_router(require_token, *, runtime=None):
    instance = runtime if runtime is not None else configured_runtime()
    @asynccontextmanager
    async def lifespan(app):
        instance.start()
        try: yield
        finally: instance.close()
    router = APIRouter(lifespan=lifespan)
    @router.get('/shadow/wide-c2-local/status', dependencies=[Depends(require_token)])
    def status(): return instance.status()
    @router.get('/shadow/wide-c2-local/result/{reader_name}', dependencies=[Depends(require_token)])
    def result(reader_name: str): return instance.result(reader_name)
    return router
