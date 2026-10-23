"""Bounded pure/model inference/ASGI checks: no DB, provider, sockets or fits."""
import os
for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[key]='4'
import asyncio,copy,hashlib,json,shutil,tempfile,threading,unittest
from pathlib import Path
from datetime import datetime,timezone,timedelta
from unittest.mock import patch
from fastapi import FastAPI,Header,HTTPException
from src.shadow_hazard import pins
from src.shadow_hazard.runtime import HazardRuntime,verify_packages,checked_observation,Refusal
from src.shadow_hazard.resource import ResourceLimit
from src.shadow_hazard.router import create_hazard_router
from src.research import hazard_totals_diagnostic as research

NOW=datetime(2026,10,13,12,tzinfo=timezone.utc)
PACKAGE=Path(__import__('src.shadow_hazard.runtime',fromlist=['__file__']).__file__).parent
RESEARCH=Path(research.__file__).parent
PACKAGE_HASH=hashlib.sha256((PACKAGE/'runtime-manifest.json').read_bytes()).hexdigest()
def safe_guard():return {'rssBytes':100*1024*1024,'freeBytes':20*2**30}
def body(clock=900,radiant=7,dire=5):
    return {'current':{'observationId':'a'*64,'source':'opendota','targetScope':'map','clockUnit':'seconds',
      'receivedAt':(NOW-timedelta(seconds=30)).isoformat(),'recordedAt':(NOW-timedelta(seconds=29)).isoformat(),
      'phase':'live','input':{'matchId':123,'gameTimeSec':clock,'radiantScore':radiant,'direScore':dire,
      'players':[{'heroId':i+1,'team':0 if i<5 else 1} for i in range(10)]},
      'availability':{'outcomeKnownAtCapture':False,'draftComplete':True},'sourceInputHash':'b'*64,'sourceSchemaHash':pins.OBSERVATION_SCHEMA_HASH},
      'expectedMatchId':123,'outcomeKnownAtDispatch':False,'lineSource':'own_diagnostic_grid',
      'lines':[{'target':'kills','line':30.5,'unit':'kills'},
               {'target':'duration','line':2400,'unit':'seconds','settlement':'exact_seconds'}]}
class NativeClient:
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
def client(runtime):
    app=FastAPI()
    def auth(x_ml_token:str|None=Header(default=None)):
        if x_ml_token!='fixture-token':raise HTTPException(401,'unauthorized')
    @app.get('/healthz')
    def health():return {'ok':True}
    app.include_router(create_hazard_router(auth,runtime=runtime));return NativeClient(app)

class RuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model=research.HazardTotalsDiagnostic();m=cls.model.manifest
        cls.goldens=json.loads(research.checked_asset(m['goldens']['file'],m['goldens']['sha256']))['rows']
    def runtime(self,**overrides):
        args={'loader':lambda:self.model,'verifier':lambda:verify_packages(research_root=RESEARCH),
              'guard':safe_guard,'now':lambda:NOW,'declared_manifest_hash':PACKAGE_HASH}
        args.update(overrides);return HazardRuntime(**args)
    def test_actual_adapter_output_is_unchanged_through_wrapper(self):
        r=self.runtime();b=body();out=r.predict(b)
        self.assertEqual(out['status'],'shadow_predicted')
        packet=checked_observation(b,NOW)
        direct=self.model.predict(packet,expected_match_id=123,computed_at=NOW.isoformat(),variant='draft1006',lines=b['lines'])
        self.assertEqual(out['diagnostic'],direct)
        self.assertEqual(out['modelHashes'],pins.MODEL_HASHES)
        self.assertEqual(out['diagnostic']['featureNames'],list(pins.FEATURE_NAMES))
    def test_fifteen_real_train_goldens_preserve_expanded_draft1006_hashes(self):
        runtime=self.runtime();self.assertEqual(len(self.goldens),15)
        for golden in self.goldens:
            b=body();p=golden['packet'];b['current']['input']=p;b['expectedMatchId']=p['matchId']
            out=runtime.predict(b);self.assertEqual(out['status'],'shadow_predicted');d=out['diagnostic']
            self.assertEqual(d['featureVectorSha256'],golden['features']['draft1006'])
            for target in ('kills','duration'):
                expected=golden['outputs'][target+'-draft1006'];actual=d['totals'][target]
                self.assertEqual(actual['rawLogitsSha256'],expected['rawLogitsSha256'])
                self.assertEqual(actual['calibratedRemainingQuantiles'],expected['remainingQuantiles'])
                self.assertAlmostEqual(actual['tailProbability'],expected['tailProbability'],places=14)
    def test_unknown_or_known_outcome_refuses_before_model_load(self):
        for field,value in [('capture',None),('capture',True),('dispatch',None),('dispatch',True)]:
            b=body()
            if field=='capture':b['current']['availability']['outcomeKnownAtCapture']=value
            else:b['outcomeKnownAtDispatch']=value
            r=self.runtime(loader=lambda:self.fail('must not load'));out=r.predict(b)
            self.assertEqual(out['status'],'unavailable');self.assertIsNone(out['diagnostic']);self.assertEqual(r.status()['state'],'cold')
    def test_missing_scores_clock_identity_schema_and_phase_refuse_without_model(self):
        for key,value in [('radiantScore',None),('direScore',None),('radiantScore',True),('direScore',-1),
                          ('gameTimeSec',299),('gameTimeSec',4501),('gameTimeSec',4800),('gameTimeSec',900.0),('matchId',124)]:
            b=body();b['current']['input'][key]=value
            self.assertEqual(self.runtime(loader=lambda:self.fail('must not load')).predict(b)['status'],'unavailable')
        for key,value in [('phase','post_draft'),('sourceSchemaHash','0'*64),('sourceInputHash','invalid')]:
            b=body();b['current'][key]=value
            self.assertEqual(self.runtime(loader=lambda:self.fail('must not load')).predict(b)['status'],'unavailable')
    def test_zero_scores_and_domain_edges_remain_observed_values(self):
        for clock in (300,4500):
            out=self.runtime().predict(body(clock,0,0));self.assertEqual(out['status'],'shadow_predicted')
            self.assertEqual(out['diagnostic']['featureVector'][:6],[0.,clock/60.,0.,0.,0.,0.])
    def test_receipt_future_inversion_stale_and_missing_timezone_refuse(self):
        for received,recorded in [(NOW+timedelta(seconds=1),NOW+timedelta(seconds=2)),
                                  (NOW,NOW-timedelta(seconds=1)),(NOW-timedelta(seconds=180),NOW)]:
            b=body();b['current'].update(receivedAt=received.isoformat(),recordedAt=recorded.isoformat())
            self.assertEqual(self.runtime(loader=lambda:self.fail()).predict(b)['status'],'unavailable')
        b=body();b['current']['receivedAt']='2026-10-13T12:00:00'
        self.assertEqual(self.runtime(loader=lambda:self.fail()).predict(b)['reason'],'invalid_observation_time')
    def test_synthetic_or_backfilled_input_cannot_be_mislabelled_actual(self):
        for location in ('input','availability'):
            for flag in ('synthetic','backfill','reconstructed'):
                b=body();b['current'][location][flag]=True
                self.assertEqual(self.runtime(loader=lambda:self.fail()).predict(b)['reason'],'synthetic_or_backfill_observation')
    def test_future_and_current_final_fields_do_not_change_model_features_or_distribution(self):
        r=self.runtime();b=body();first=r.predict(b)
        b['current']['input'].update(radiant_win=False,duration=99999,futureEvents=[{'time':99999}],final_score=9999,
            gold=99999,items=[1,2])
        self.assertEqual(r.predict(b)['diagnostic'],first['diagnostic'])
    def test_exact_push_bounds_tail_and_duration_units_are_preserved(self):
        b=body(2700,20,20);b['lines']=[{'target':'kills','line':v,'unit':'kills'} for v in (39,40,41,41.5,160.5,161)]
        b['lines'] += [{'target':'duration','line':v,'unit':'seconds','settlement':'exact_seconds'} for v in (2700,2701,8100,8101)]
        d=self.runtime().predict(b)['diagnostic'];rows=d['lineDiagnostics']
        self.assertEqual(rows[0]['basis'],'observed_lower_bound');self.assertEqual(rows[3]['calibrated']['probabilities']['pPush'],0)
        self.assertGreater(rows[2]['calibrated']['probabilities']['pPush'],0)
        self.assertTrue(rows[4]['available']);self.assertFalse(rows[5]['available'])
        self.assertEqual(rows[6]['calibrated']['probabilities']['pOver'],1)
        self.assertFalse(rows[-1]['available'])
        self.assertTrue(all(x is None or x>=2701 for x in d['totals']['duration']['calibratedFinalQuantiles']))
        for target in ('kills','duration'):self.assertFalse(d['totals'][target]['tailAllocatedToLastBin'])
    def test_unsupported_lines_remain_explicit_refusals_not_guessed_settlement(self):
        b=body();b['lines']=[{'target':'kills','line':20.25,'unit':'kills'},
          {'target':'duration','line':40,'unit':'minutes'},{'target':'duration','line':2400,'unit':'seconds'}]
        rows=self.runtime().predict(b)['diagnostic']['lineDiagnostics']
        self.assertTrue(all(not r['available'] and r['calibrated'] is None for r in rows))
    def test_source_quality_claims_never_make_latency_or_serving_true(self):
        b=body();b['current']['availability'].update(eventLatencyVerified=True,coverage95Validated=True,measuredEndToEndLatencySeconds=0)
        out=self.runtime().predict(b)
        for name in ('active','eligibleForServing','eligibleForPromotion','eligibleForQualityClaims',
                     'eligibleForProspectiveEvaluation','prospectiveValidated','eventLatencyVerified','meetsVerifiedLiveLatencyPolicy','coverage95Validated'):
            self.assertIs(out[name],False)
        self.assertIsNone(out['measuredEndToEndLatencySeconds']);self.assertFalse(out['diagnostic']['originalLiveReceiptVerified'])
    def test_package_failure_and_resource_failure_are_sanitized(self):
        def fail():raise ValueError('secret/key/must-not-echo')
        out=self.runtime(verifier=fail).predict(body());self.assertEqual(out['reason'],'hazard_package_unavailable');self.assertNotIn('secret',json.dumps(out))
        def resources():raise ResourceLimit('not enough memory')
        self.assertEqual(self.runtime(guard=resources,loader=lambda:self.fail()).predict(body())['reason'],'hazard_resource_unavailable')
    def test_inference_busy_and_stale_completion_never_return_prediction(self):
        model=self.model;entered=threading.Event();release=threading.Event();clock=[NOW]
        class Slow:
            manifest=model.manifest;meta=model.meta
            def predict(self,*args,**kwargs):
                entered.set();release.wait(2);result=model.predict(*args,**kwargs);clock[0]=NOW+timedelta(seconds=160);return result
        r=self.runtime(loader=Slow,now=lambda:clock[0]);results=[]
        thread=threading.Thread(target=lambda:results.append(r.predict(body())));thread.start();self.assertTrue(entered.wait(1))
        self.assertEqual(r.predict(body())['reason'],'hazard_busy');release.set();thread.join(2)
        self.assertEqual(results[0]['reason'],'observation_stale_at_completion');self.assertIsNone(results[0]['diagnostic'])
    def test_runtime_source_tamper_refuses_and_real_bundle_verifies(self):
        self.assertEqual(verify_packages(research_root=RESEARCH),PACKAGE_HASH)
        with tempfile.TemporaryDirectory() as td:
            dest=Path(td)
            for p in PACKAGE.iterdir():
                if p.is_file():shutil.copyfile(p,dest/p.name)
            (dest/'runtime.py').write_text('changed',encoding='utf-8')
            r=self.runtime(verifier=lambda:verify_packages(dest,RESEARCH))
            self.assertEqual(r.predict(body())['reason'],'hazard_package_unavailable')
    def test_actual_corrupted_model_asset_is_refused_before_prediction(self):
        with tempfile.TemporaryDirectory() as td:
            dest=Path(td)
            for name in ('MANIFEST.json','FEATURE-NAMES.json','CALIBRATION.json','SELECTION.json'):
                shutil.copyfile(research.ASSETS/name,dest/name)
            (dest/'hazard-kills-state6.txt').write_bytes(b'corrupted')
            with patch.object(research,'ASSETS',dest):
                self.assertEqual(self.runtime(loader=research.HazardTotalsDiagnostic).predict(body())['reason'],'hazard_package_unavailable')

class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.model=research.HazardTotalsDiagnostic()
    def runtime(self):return HazardRuntime(loader=lambda:self.model,verifier=lambda:verify_packages(research_root=RESEARCH),guard=safe_guard,now=lambda:NOW,declared_manifest_hash=PACKAGE_HASH)
    def test_auth_all_routes_health_independent_and_no_cold_load(self):
        r=self.runtime();c=client(r)
        self.assertEqual(c.get('/shadow/live-totals-hazard/status').status_code,401)
        self.assertEqual(c.post('/shadow/live-totals-hazard').status_code,401)
        self.assertEqual(c.get('/healthz').status_code,200);self.assertEqual(r.status()['state'],'cold')
    def test_exact_wire_binding_for_success_refusal_and_whitespace(self):
        c=client(self.runtime());headers={'X-ML-Token':'fixture-token','Content-Type':'application/json'}
        b=body();wire=json.dumps(b,indent=1).encode();first=c.post('/shadow/live-totals-hazard',content=wire,headers=headers)
        self.assertEqual(first.status_code,200);self.assertEqual(first.json()['requestBodySha256'],hashlib.sha256(wire).hexdigest())
        compact=json.dumps(b,separators=(',',':')).encode();second=c.post('/shadow/live-totals-hazard',content=compact,headers=headers)
        self.assertNotEqual(first.json()['requestBodySha256'],second.json()['requestBodySha256'])
        self.assertEqual(first.json()['diagnostic'],second.json()['diagnostic'])
        b['outcomeKnownAtDispatch']=None;wire=json.dumps(b).encode();refusal=c.post('/shadow/live-totals-hazard',content=wire,headers=headers)
        self.assertEqual(refusal.json()['reason'],'outcome_availability_unknown');self.assertEqual(refusal.json()['requestBodySha256'],hashlib.sha256(wire).hexdigest())
    def test_request_count_size_nonfinite_and_schema_limits(self):
        c=client(self.runtime());headers={'X-ML-Token':'fixture-token'}
        for mutate in (lambda b:b.update(outcomeKnownAtDispatch=1),lambda b:b.update(lineSource='bookmaker'),
                       lambda b:b.update(variant='draft1006'),lambda b:b.update(lines=[b['lines'][0]]*129),
                       lambda b:b['lines'][0].update(line=True),lambda b:b['lines'][0].update(line=float('nan'))):
            b=body();mutate(b);self.assertEqual(c.post('/shadow/live-totals-hazard',json=b,headers=headers).status_code,422)
        b=body();b['lines']=[b['lines'][0]]*128
        self.assertEqual(c.post('/shadow/live-totals-hazard',json=b,headers=headers).status_code,200)
        malformed=c.post('/shadow/live-totals-hazard',content=b'{"secret":"must-not-echo",bad}',headers=headers)
        self.assertEqual(malformed.status_code,422);self.assertNotIn('must-not-echo',malformed.text)
        self.assertEqual(c.post('/shadow/live-totals-hazard',content=b'{}',headers={**headers,'content-length':'262145'}).status_code,413)
        self.assertEqual(c.post('/shadow/live-totals-hazard',content=b' '*262145,headers={**headers,'content-length':'1'}).status_code,413)
    def test_huge_nonfinite_score_cannot_escape_json_response(self):
        b=body();b['current']['input']['radiantScore']=10**400
        response=client(self.runtime()).post('/shadow/live-totals-hazard',json=b,headers={'X-ML-Token':'fixture-token'})
        self.assertEqual(response.status_code,200);self.assertEqual(response.json()['reason'],'radiant_score_required')

if __name__=='__main__':unittest.main()
