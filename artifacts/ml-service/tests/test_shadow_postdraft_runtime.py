"""Fast pure/HTTP tests: no DB, export, provider, fit or full-history bootstrap."""
import os
for name in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[name]='4'
import asyncio,copy,hashlib,json,sys,tempfile,threading,time,unittest
from pathlib import Path
from datetime import datetime,timezone,timedelta
from unittest.mock import patch
import numpy as np
from fastapi import FastAPI,Header,HTTPException
from src.shadow_postdraft.actor import (PostdraftActor,SnapshotConfig,load_snapshot,digest_bytes)
from src.shadow_postdraft.router import create_postdraft_router
from src.shadow_postdraft import pins
from src.research.postdraft_input_contract import ASSETS

NOW=datetime(2026,10,13,8,tzinfo=timezone.utc)
RUNTIME_HASH='d'*64
class TestClient:
    """Dependency-free in-process ASGI requests, no socket or provider access."""
    def __init__(self,app):self.app=app
    def request(self,method,path,content=b'',headers=None,**kwargs):
        if 'json' in kwargs:content=json.dumps(kwargs['json']).encode();headers={**(headers or {}),'content-type':'application/json'}
        encoded=[(k.lower().encode(),v.encode()) for k,v in (headers or {}).items()]
        if not any(k==b'content-length' for k,v in encoded):encoded.append((b'content-length',str(len(content)).encode()))
        scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':method,'scheme':'http','path':path,
            'raw_path':path.encode(),'query_string':b'','root_path':'','headers':encoded,'client':('test',1),'server':('test',80)}
        messages=[];received=False
        async def receive():
            nonlocal received
            if received:return {'type':'http.disconnect'}
            received=True;return {'type':'http.request','body':content,'more_body':False}
        async def send(message):messages.append(message)
        asyncio.run(self.app(scope,receive,send))
        class Response:
            status_code=next(m['status'] for m in messages if m['type']=='http.response.start')
            text=b''.join(m.get('body',b'') for m in messages if m['type']=='http.response.body').decode()
            def json(self):return json.loads(self.text)
        return Response()
    def get(self,path,**kwargs):return self.request('GET',path,**kwargs)
    def post(self,path,**kwargs):return self.request('POST',path,**kwargs)
def guard():return {'rssBytes':100*1024*1024,'freeBytes':20*2**30}
def verified():return {'packageManifestSha256':RUNTIME_HASH,'featurePackageManifestSha256':pins.FEATURE_PACKAGE_MANIFEST_SHA256}
def body():
    return {'current':{'observationId':'a'*64,'source':'opendota','targetScope':'map','clockUnit':'seconds',
        'receivedAt':(NOW-timedelta(seconds=30)).isoformat(),'recordedAt':(NOW-timedelta(seconds=29)).isoformat(),
        'phase':'live','input':{'matchId':999999999,'radiantTeamId':1,'direTeamId':2,'gameTimeSec':0,
        'players':[{'team':int(i>=5),'heroId':i+1,'accountId':100+i} for i in range(10)]},
        'availability':{'draftComplete':True,'outcomeKnownAtCapture':False},'sourceInputHash':'b'*64,
        'sourceSchemaHash':pins.OBSERVATION_SCHEMA_HASH},'expectedMatchId':999999999,'outcomeKnownAtDispatch':False}
def metadata():return {'snapshotCutoff':(NOW-timedelta(hours=1)).isoformat(),'builtAt':(NOW-timedelta(minutes=1)).isoformat(),
    'snapshotManifestSha256':'4'*64,'rawSnapshotSha256':'5'*64,'referenceSha256':'6'*64,'maps':1,'historyManifestSha256':'7'*64}
class FakeCache:
    built_at=(NOW-timedelta(minutes=1)).isoformat()
    manifest={'snapshotCutoff':(NOW-timedelta(hours=1)).isoformat()}
    def __init__(self,wait=None,entered=None):self.wait=wait;self.entered=entered;self.calls=0
    def predict(self,envelope,**kwargs):
        self.calls+=1
        if self.entered:self.entered.set()
        if self.wait:self.wait.wait(2)
        gold=json.loads((ASSETS/'TRAIN-GOLDENS.json').read_text())[0]
        values=gold['inputVector'];v=np.array([np.nan if x is None else x for x in values],dtype='<f4')
        return {'featureVector':values,'featureVectorFloat32Sha256':digest_bytes(v.tobytes()),
            'diagnosticRadiantWinProbability':gold['expectedRadiantWinProbability'],
            'normalizedInputSha256':'e'*64,'historyManifestSha256':'7'*64,'seriesContextStatus':'missing','limitations':[]}
def actor(loader=None,now=lambda:NOW):return PostdraftActor(config=SnapshotConfig(Path('unused'),'0'*64),
    loader=loader or (lambda *a,**k:(FakeCache(),metadata())),verifier=verified,guard=guard,now=now,declared_manifest_hash=RUNTIME_HASH)
def ready(a):
    a.start();a._thread.join(2);assert a.status()['state']=='ready'
class RuntimeTests(unittest.TestCase):
    def test_single_background_bootstrap_keeps_health_responsive(self):
        stop=threading.Event();entered=threading.Event();calls=[]
        def loader(*a,**k):calls.append(1);entered.set();stop.wait(2);return FakeCache(),metadata()
        a=actor(loader);start=time.monotonic();a.start();self.assertLess(time.monotonic()-start,.5)
        self.assertTrue(entered.wait(1));self.assertEqual(a.status()['state'],'building')
        for _ in range(5):a.start()
        self.assertEqual(len(calls),1);self.assertEqual(a.predict(body())['reason'],'cache_building')
        stop.set();a._thread.join(2);self.assertEqual(a.status()['state'],'ready')
    def test_healthy_prediction_uses_full_vector_and_canonical_nan_hash(self):
        a=actor();ready(a);out=a.predict(body());self.assertEqual(out['status'],'shadow_predicted')
        self.assertEqual(len(out['featureNames']),6668);self.assertEqual(len(out['featureValues']),6668)
        self.assertEqual(out['missingMask'],[x is None for x in out['featureValues']]);self.assertFalse(out['active'])
        self.assertEqual(out['packageManifestSha256'],RUNTIME_HASH)
    def test_dispatch_known_or_unknown_does_not_start_actor_or_model(self):
        for value,reason in [(True,'outcome_known_at_dispatch'),(None,'outcome_check_unknown')]:
            a=actor();b=body();b['outcomeKnownAtDispatch']=value
            self.assertEqual(a.predict(b)['reason'],reason);self.assertEqual(a.status()['state'],'cold')
    def test_invalid_phase_roster_capture_hash_or_age_refuses_without_start(self):
        cases=[]
        for path,value in [('clock',60),('clock',-3601),('clock','0'),('roster',None),('capture',None),('schema','f'*64),('age',180)]:
            b=body()
            if path=='clock':b['current']['input']['gameTimeSec']=value
            elif path=='roster':b['current']['input']['players'][0]['accountId']=None
            elif path=='capture':b['current']['availability']['outcomeKnownAtCapture']=None
            elif path=='schema':b['current']['sourceSchemaHash']=value
            else:b['current']['receivedAt']=(NOW-timedelta(seconds=value)).isoformat()
            cases.append(b)
        for b in cases:
            a=actor();self.assertEqual(a.predict(b)['status'],'unavailable');self.assertEqual(a.status()['state'],'cold')
    def test_serialized_inference_busy_has_no_vector(self):
        stop=threading.Event();entered=threading.Event();cache=FakeCache(stop,entered);a=actor(lambda *args,**kw:(cache,metadata()));ready(a)
        results=[];thread=threading.Thread(target=lambda:results.append(a.predict(body())));thread.start();self.assertTrue(entered.wait(1))
        second=a.predict(body());self.assertEqual(second['reason'],'postdraft_busy');self.assertIsNone(second['featureValues'])
        stop.set();thread.join(2);self.assertEqual(cache.calls,1)
    def test_failure_sanitized_and_not_auto_restarted(self):
        calls=[]
        def failed(*a,**k):calls.append(1);raise ValueError('secret/path/never-echo')
        a=actor(failed);a.start();a._thread.join(2);self.assertEqual(a.status()['state'],'failed')
        self.assertNotIn('secret',json.dumps(a.status()));a.start();self.assertEqual(len(calls),1)
    def test_snapshot_age_and_post_inference_receipt_age_refuse(self):
        clock=[NOW];a=actor(now=lambda:clock[0]);ready(a);clock[0]=NOW+timedelta(days=1)
        self.assertEqual(a.status()['state'],'stale');self.assertIsNone(a.predict(body())['rawProbability'])
        clock[0]=NOW
        class Slow(FakeCache):
            def predict(self,*args,**kw):result=super().predict(*args,**kw);clock[0]+=timedelta(seconds=160);return result
        a=actor(lambda *args,**kw:(Slow(),metadata()),now=lambda:clock[0]);ready(a)
        out=a.predict(body());self.assertEqual(out['reason'],'observation_stale_at_completion');self.assertIsNone(out['featureValues'])
    def test_resource_budget_prevents_clone(self):
        cache=FakeCache();a=actor(lambda *args,**kw:(cache,metadata()));ready(a)
        a._guard=lambda:{'rssBytes':4*2**30,'freeBytes':20*2**30}
        self.assertEqual(a.predict(body())['reason'],'postdraft_resource_unavailable');self.assertEqual(cache.calls,0)

class SnapshotTests(unittest.TestCase):
    def fixture(self,directory):
        data=b'{"match_id":1}\n';reference=b'{"payload":[{"id":1,"name":"hero"}]}'
        manifest={'contract':'startup_postdraft_history_snapshot_v1','readOnly':True,'mapsFile':'maps.jsonl','counts':{'rows':1},
            'snapshotCutoff':(NOW-timedelta(hours=1)).isoformat(),'mapsBytes':len(data),'mapsSha256':digest_bytes(data),'referenceSha256':digest_bytes(reference)}
        raw=json.dumps(manifest).encode();(directory/'MANIFEST.json').write_bytes(raw);(directory/'maps.jsonl').write_bytes(data);(directory/'hero-reference.json').write_bytes(reference)
        return SnapshotConfig(directory,digest_bytes(raw))
    def test_tampered_snapshot_or_reference_or_manifest_never_bootstraps(self):
        for filename in ('maps.jsonl','hero-reference.json','MANIFEST.json'):
            with tempfile.TemporaryDirectory() as td:
                p=Path(td);cfg=self.fixture(p);(p/filename).write_bytes(b'changed')
                with patch('src.research.postdraft_full.builder.bootstrap') as build:
                    with self.assertRaises(ValueError):load_snapshot(cfg,guard=guard,now=lambda:NOW)
                    build.assert_not_called()
    def test_stream_hash_prevents_file_change_after_preverification(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);cfg=self.fixture(p)
            def changed(rows,*args,**kwargs):
                (p/'maps.jsonl').write_bytes(b'{"match_id":2}\n');list(rows);return FakeCache()
            with patch('src.research.postdraft_full.builder.bootstrap',side_effect=changed):
                with self.assertRaisesRegex(ValueError,'changed_during_read'):load_snapshot(cfg,guard=guard,now=lambda:NOW)
    def test_verified_small_snapshot_allows_one_bootstrap_only(self):
        with tempfile.TemporaryDirectory() as td:
            cfg=self.fixture(Path(td));calls=[]
            def build(rows,*args,**kwargs):calls.extend(list(rows));return FakeCache()
            with patch('src.research.postdraft_full.builder.bootstrap',side_effect=build):cache,meta=load_snapshot(cfg,guard=guard,now=lambda:NOW)
            self.assertEqual(calls,[{'match_id':1}]);self.assertEqual(meta['maps'],1)

class RouterTests(unittest.TestCase):
    def client(self,a):
        app=FastAPI()
        def auth(x_ml_token:str|None=Header(default=None)):
            if x_ml_token!='fixture-token':raise HTTPException(401,'unauthorized')
        @app.get('/healthz')
        def health():return {'ok':True}
        app.include_router(create_postdraft_router(auth,actor=a));return TestClient(app)
    def test_auth_required_on_all_diagnostic_routes_health_independent(self):
        a=actor();client=self.client(a)
        for verb,path in [('get','/shadow/postdraft/status'),('post','/shadow/postdraft/warmup'),('post','/shadow/postdraft')]:
            self.assertEqual(getattr(client,verb)(path).status_code,401)
        self.assertEqual(client.get('/healthz').status_code,200);self.assertEqual(a.status()['state'],'cold')
    def test_exact_wire_hash_and_invalid_payload_redaction(self):
        a=actor();ready(a);client=self.client(a);wire=json.dumps(body(),indent=1).encode();h={'X-ML-Token':'fixture-token','Content-Type':'application/json'}
        response=client.post('/shadow/postdraft',content=wire,headers=h);self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['requestBodySha256'],hashlib.sha256(wire).hexdigest())
        b=body();b['outcomeKnownAtDispatch']=1
        self.assertEqual(client.post('/shadow/postdraft',json=b,headers=h).status_code,422)
        response=client.post('/shadow/postdraft',content=b'{"secret":"dont-echo",bad}',headers=h)
        self.assertEqual(response.status_code,422);self.assertNotIn('dont-echo',response.text)
        self.assertEqual(client.post('/shadow/postdraft',content=b'{}',headers={**h,'content-length':'300000'}).status_code,413)

if __name__=='__main__':unittest.main()
