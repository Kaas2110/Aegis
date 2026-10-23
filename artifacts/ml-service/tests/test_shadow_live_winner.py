"""In-process real FastAPI/ASGI requests; no server, provider, database, fit or activation."""
from __future__ import annotations
import asyncio
import copy
import hashlib
import hmac
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
from typing import Annotated
import unittest
from unittest import mock
import lightgbm as lgb
import numpy as np
from fastapi import FastAPI, Header, HTTPException

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
sys.path.insert(0, str(PROJECT_ROOT))
from src.shadow_live_winner import adapter as a
from src.shadow_live_winner.router import create_live_winner_router, MAX_REQUEST_BYTES
from src.shadow_live_winner.pins import MANIFEST_SHA256
FIXTURES = HERE/'fixtures'
PACKAGE = PROJECT_ROOT/'src/shadow_live_winner'
TOKEN = 'unit-test-token-not-a-production-secret'


def require_token(x_ml_token: Annotated[str | None, Header()] = None):
    if not x_ml_token or not hmac.compare_digest(x_ml_token, TOKEN):
        raise HTTPException(401, detail='invalid or missing X-ML-Token')


def make_app(factory=a.RuntimeShadowWinnerAdapter):
    app = FastAPI()
    app.include_router(create_live_winner_router(require_token, adapter_factory=factory))
    return app


async def request_async(app, data=None, *, raw=None, token=TOKEN, length='auto', chunks=None):
    if raw is None:
        raw = json.dumps(data, allow_nan=False, separators=(',', ':')).encode()
    headers = [(b'content-type', b'application/json')]
    if token is not None:
        headers.append((b'x-ml-token', token.encode()))
    if length is not None:
        headers.append((b'content-length', str(len(raw) if length == 'auto' else length).encode()))
    messages = []
    pieces = chunks if chunks is not None else [raw]
    incoming = [{'type': 'http.request', 'body': chunk, 'more_body': i < len(pieces)-1}
                for i, chunk in enumerate(pieces)]
    async def receive():
        return incoming.pop(0) if incoming else {'type': 'http.disconnect'}
    async def send(message):
        messages.append(message)
    scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'POST',
             'scheme': 'http', 'path': '/shadow/live-winner', 'raw_path': b'/shadow/live-winner',
             'query_string': b'', 'headers': headers, 'client': ('127.0.0.1', 123), 'server': ('test', 80)}
    await app(scope, receive, send)
    status = next(m['status'] for m in messages if m['type'] == 'http.response.start')
    body = b''.join(m.get('body', b'') for m in messages if m['type'] == 'http.response.body')
    return status, json.loads(body)


def request(app, data=None, **kwargs):
    return asyncio.run(request_async(app, data, **kwargs))


def observation(clock=600, *, oid='a'*64, received='2026-05-01T00:10:00+00:00', r=0, d=0, lead=0):
    return {'observationId': oid, 'source': 'opendota', 'targetScope': 'map', 'clockUnit': 'seconds', 'scoreUnit': 'kills',
            'receivedAt': received, 'recordedAt': received,
            'input': {'matchId': 12345, 'radiantTeamId': 12, 'direTeamId': 34, 'gameTimeSec': clock,
                      'radiantScore': r, 'direScore': d, 'radiantLead': lead,
                      'players': [{'heroId': h, 'team': int(h > 5)} for h in range(1, 11)]}}


def body(current=None, history=None):
    current = current or observation()
    return {'current': current, 'history': history or [], 'expectedMatchId': current['input']['matchId']}


class RuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adapter = a.RuntimeShadowWinnerAdapter()
        cls.app = make_app(lambda: cls.adapter)
        raw = (FIXTURES/'shadow-live-winner-train-goldens.json').read_bytes()
        assert a.digest(raw) == cls.adapter.manifest['historicalParityProof']['artifacts']['golden-training-features.json']
        cls.goldens = json.loads(raw)

    def assert_reason(self, expected_status, expected_reason, data=None, **kwargs):
        status, out = request(self.app, data or body(), **kwargs)
        self.assertEqual(status, expected_status, out)
        self.assertEqual(out['detail']['reason'], expected_reason)
        return out

    def test_actual_route_all_30_train_goldens_exact_vector_and_reloaded_probability(self):
        direct = lgb.Booster(model_str=(PACKAGE/'assets'/a.MODEL_FILE).read_text(encoding='utf-8'))
        loaded_app = make_app()
        self.assertEqual(self.goldens['comparedEligibleTrainRows'], 408)
        self.assertEqual(len(self.goldens['rows']), 30)
        for g in self.goldens['rows']:
            with self.subTest(match=g['matchId'], snapshot=g['snapshotId']):
                status, out = request(loaded_app, body(g['current'], g['history']))
                self.assertEqual(status, 200, out)
                self.assertEqual(out['status'], 'shadow_predicted')
                self.assertEqual(out['featureValues'], g['expectedFeatureValues'])
                self.assertEqual(out['missingMask'], g['expectedMissingMask'])
                vector = a.decode_vector(g['expectedFeatureValues'], g['expectedMissingMask'])
                self.assertAlmostEqual(out['rawProbability'], float(direct.predict(vector.reshape(1,-1), num_threads=1)[0]), places=12)
                self.assertEqual(out['modelSha256'], a.MODEL_SHA256)
                self.assertEqual(out['manifestSha256'], MANIFEST_SHA256)
                self.assertEqual(out['executionMode'], 'runtime_shadow')
                self.assertEqual(out['targetScope'], 'map')
                self.assertNotIn('eligibleForProspectiveEvaluation', out)
                self.assertFalse(out['eligibleForServing'])
                self.assertFalse(out['eligibleForPromotion'])
                self.assertFalse(out['prospectiveValidated'])
                self.assertFalse(out['meetsVerifiedLiveLatencyPolicy'])
                self.assertIsNone(out['measuredEndToEndLatencySeconds'])

    def test_auth_is_real_dependency_and_precedes_body_and_model_loading(self):
        factory = mock.Mock(side_effect=AssertionError('must not load'))
        app = make_app(factory)
        factory.assert_not_called()
        for token in (None, 'wrong'):
            status, out = request(app, raw=b'not json', token=token)
            self.assertEqual(status, 401)
            self.assertEqual(out, {'detail': 'invalid or missing X-ML-Token'})
        factory.assert_not_called()

    def test_exact_raw_request_bytes_bind_success_and_domain_refusal(self):
        data=body()
        compact=json.dumps(data,separators=(',',':')).encode()
        pretty=json.dumps(data,indent=2).encode()
        first=request(self.app,raw=compact)[1]
        second=request(self.app,raw=pretty)[1]
        self.assertEqual(first['requestBodySha256'],hashlib.sha256(compact).hexdigest())
        self.assertEqual(second['requestBodySha256'],hashlib.sha256(pretty).hexdigest())
        self.assertNotEqual(first['requestBodySha256'],second['requestBodySha256'])
        self.assertEqual(first['inputHash'],second['inputHash'])
        data['current']['requestBodySha256']='0'*64
        changed=json.dumps(data,separators=(',',':')).encode()
        third=request(self.app,raw=changed)[1]
        self.assertEqual(third['requestBodySha256'],hashlib.sha256(changed).hexdigest())
        self.assertNotEqual(third['requestBodySha256'],'0'*64)
        self.assertEqual(third['inputHash'],first['inputHash'])
        data['current']['input']['gameTimeSec']=0
        refused=json.dumps(data,separators=(',',':')).encode()
        out=request(self.app,raw=refused)[1]
        self.assertEqual(out['status'],'unavailable')
        self.assertEqual(out['requestBodySha256'],hashlib.sha256(refused).hexdigest())

    def test_request_schema_errors_are_bounded_and_do_not_echo_payload(self):
        bad = body(); bad['expectedMatchId'] = True
        self.assert_reason(422, 'invalid_shadow_request', bad)
        bad = body(); bad['unexpectedSecret'] = 'payload-must-not-be-echoed'
        out = self.assert_reason(422, 'invalid_shadow_request', bad)
        self.assertNotIn('payload-must-not-be-echoed', json.dumps(out))
        for key in ('current', 'history', 'expectedMatchId'):
            bad = body(); del bad[key]
            self.assert_reason(422, 'invalid_shadow_request', bad)
        for key in ('observationId', 'receivedAt', 'recordedAt', 'source', 'clockUnit', 'scoreUnit', 'targetScope'):
            bad = body(); del bad['current'][key]
            self.assert_reason(422, 'invalid_shadow_request', bad)
        self.assert_reason(422, 'invalid_shadow_request', raw=b'{bad json')
        self.assert_reason(422, 'invalid_shadow_request', raw=b'\xff')

    def test_nonstandard_json_numbers_rejected_and_required_null_never_becomes_zero(self):
        raw = json.dumps(body()).replace('"radiantLead": 0', '"radiantLead": NaN').encode()
        self.assert_reason(422, 'invalid_shadow_request', raw=raw)
        raw = raw.replace(b'NaN', b'Infinity')
        self.assert_reason(422, 'invalid_shadow_request', raw=raw)
        for key, reason in [('gameTimeSec','game_clock'),('radiantScore','radiant_score'),
                            ('direScore','dire_score'),('radiantLead','raw_provider_lead')]:
            bad = body(); bad['current']['input'][key] = None
            self.assert_reason(422, 'missing_or_invalid_'+reason, bad)
        bad = body(); bad['current']['input']['radiantLead'] = 10**1000
        self.assert_reason(422, 'missing_or_invalid_raw_provider_lead', bad)

    def test_zero_scores_lead_draft_and_null_native_missing_roundtrip(self):
        status, out = request(self.app, body())
        self.assertEqual(status, 200)
        self.assertEqual(out['featureValues'][1:7], [0]*6)
        self.assertEqual(out['featureValues'][18:28], [1]*5+[-1]*5)
        self.assertEqual(out['featureValues'][28:], [0]*240)
        self.assertTrue(out['missingMask'][9])
        self.assertIsNone(out['featureValues'][9])
        v = a.decode_vector(out['featureValues'], out['missingMask'])
        self.assertTrue(np.isnan(v[9]))
        missing = body(); missing['current']['input']['players'] = []
        status, out_missing = request(self.app, missing)
        self.assertEqual(status, 200)
        self.assertEqual(out_missing['featureValues'][18:], [None]*250)
        self.assertNotEqual(out['inputHash'], out_missing['inputHash'])
        out['missingMask'][9] = False
        with self.assertRaisesRegex(a.ContractError,'nullable_vector_mask_mismatch'):
            a.decode_vector(out['featureValues'], out['missingMask'])

    def test_bounds_apply_with_real_and_missing_and_dishonest_content_length(self):
        self.assert_reason(413, 'shadow_request_too_large', raw=b'{}', length=MAX_REQUEST_BYTES+1)
        self.assert_reason(400, 'invalid_content_length', raw=b'{}', length='-1')
        self.assert_reason(400, 'invalid_content_length', raw=b'{}', length='nonnumeric')
        chunks = [b' '*600_000, b' '*600_000]
        for length in (None, 2):
            self.assert_reason(413, 'shadow_request_too_large', raw=b'', chunks=chunks, length=length)
        bad = body(); bad['history'] = [observation()]*257
        self.assert_reason(422, 'invalid_shadow_request', bad)
        with self.assertRaisesRegex(a.ContractError,'history_limit_exceeded'):
            self.adapter.predict(observation(), [observation()]*257, expected_match_id=12345)

    def test_domain_refusals_do_not_return_prediction(self):
        clocks = {-20:'post_draft_model_unavailable',0:'early_phase_outside_adapter_support',
                  299:'early_phase_outside_adapter_support',4773:'outside_empirical_training_clock_support',
                  4800:'tail80_model_unavailable',10000:'tail80_model_unavailable'}
        for clock, expected in clocks.items():
            status, out = request(self.app, body(observation(clock)))
            self.assertEqual(status, 200)
            self.assertEqual(out['status'],'unavailable')
            self.assertEqual(out['reason'],expected)
            self.assertIsNone(out['rawProbability'])
            self.assertIsNone(out['featureValues'])
            self.assertIsNone(out['missingMask'])
        for clock in (300,4772):
            self.assertEqual(request(self.app,body(observation(clock)))[1]['status'],'shadow_predicted')

    def test_future_current_final_labels_and_checkpoint_cannot_change_input(self):
        g = copy.deepcopy(self.goldens['rows'][-1])
        original = body(g['current'],g['history'])
        before = request(self.app,original)[1]
        for e in [original['current'],*original['history']]:
            e.update(winner=True, duration=12345, evaluationCheckpointMinute=9999)
            e['input'].update(finalRadiantWin=True,finalRadiantScore=9999,finalDireScore=9999,finalDuration=2)
        after = request(self.app,original)[1]
        for key in ('rawProbability','featureValues','missingMask','featureVectorHash','inputHash'):
            self.assertEqual(before[key],after[key],key)
        original = body()
        future = observation(1200,oid='b'*64,received='2026-05-01T00:20:00+00:00')
        future['input'] = {'invalid_future_payload': True}
        original['history'] = [future]
        self.assertEqual(request(self.app,body())[1]['inputHash'],request(self.app,original)[1]['inputHash'])

    def test_recorded_at_cutoff_and_both_history_orders_are_causal(self):
        current = observation()
        p1 = observation(200,oid='b'*64,received='2026-05-01T00:03:20+00:00')
        p2 = observation(450,oid='c'*64,received='2026-05-01T00:07:30+00:00')
        p1['recordedAt'] = '2026-05-01T00:10:01+00:00'
        self.assert_reason(422,'history_recorded_after_current_cutoff',body(current,[p1]))
        p1['recordedAt'] = '2026-05-01T00:08:00+00:00'
        self.assert_reason(422,'history_not_monotone_in_receipt_order',body(current,[p1,p2]))
        p1['recordedAt'] = p1['receivedAt']
        self.assert_reason(422,'history_not_monotone_in_receipt_order',body(current,[p2,p1]))
        self.assert_reason(422,'duplicate_observation_identity',body(current,[p1,p1]))
        p1['input']['gameTimeSec'] = 600
        self.assert_reason(422,'history_clock_not_strictly_past',body(current,[p1]))
        p1['input']['gameTimeSec'] = 200; p1['input']['radiantScore'] = 1
        self.assert_reason(422,'current_score_regressed',body(current,[p1]))

    def test_lineage_contains_ordered_noncontributing_id_and_side_and_map_identity(self):
        prior = observation(50,oid='b'*64,received='2026-05-01T00:00:50+00:00')
        old = request(self.app,body())[1]
        out = request(self.app,body(history=[prior]))[1]
        self.assertEqual(old['featureValues'],out['featureValues'])
        self.assertNotEqual(old['inputHash'],out['inputHash'])
        self.assertEqual(out['historyLineageInReceiptOrder'][0]['observationId'],'b'*64)
        bad = body(); bad['expectedMatchId'] = 99
        self.assert_reason(422,'current_map_identity_mismatch',bad)
        prior['input']['matchId'] = 99
        self.assert_reason(422,'current_map_identity_mismatch',body(history=[prior]))
        prior['input']['matchId'] = 12345; prior['input']['radiantTeamId'] = 34; prior['input']['direTeamId'] = 12
        self.assert_reason(422,'history_side_identity_mismatch',body(history=[prior]))

    def test_synthetic_and_backfill_refused_caller_cannot_claim_quality(self):
        for area in ('envelope','input'):
            for flag in ('synthetic','backfill'):
                bad = body(); target = bad['current'] if area=='envelope' else bad['current']['input']
                target[flag] = True
                self.assert_reason(422,'synthetic_or_backfill_observation',bad)
        fake = body(); fake['current'].update(eligibleForServing=True,prospectiveValidated=True,
                  sourceQuality={'eventLatencyVerified':True,'measuredEndToEndLatencySeconds':0})
        status,out = request(self.app,fake)
        self.assertEqual(status,200)
        for flag in ('active','eligibleForServing','eligibleForPromotion','prospectiveValidated',
                     'eventLatencyVerified','meetsVerifiedLiveLatencyPolicy'):
            self.assertIs(out[flag],False)
        self.assertIsNone(out['measuredEndToEndLatencySeconds'])
        self.assertNotIn('eligibleForProspectiveEvaluation',out)

    def test_timestamp_units_and_unknown_hero_schema_fail_closed(self):
        bad = body(); bad['current']['recordedAt'] = '2099-01-01T00:00:00+00:00'
        self.assert_reason(422,'future_or_inconsistent_receipt',bad)
        bad = body(); bad['current']['input']['players'][0]['heroId'] = 251
        self.assert_reason(422,'hero_outside_pinned_schema',bad)
        bad = body(); bad['current']['clockUnit'] = 'minutes'
        self.assert_reason(422,'invalid_shadow_request',bad)

    def test_portable_package_loads_without_frozen_datasets_and_does_not_rehash_per_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp)/'relocated'
            shutil.copytree(PACKAGE,destination,ignore=shutil.ignore_patterns('__pycache__'))
            with mock.patch.object(a,'PACKAGE_ROOT',destination),mock.patch.object(a,'checked_bytes',wraps=a.checked_bytes) as checked:
                app = make_app()
                self.assertEqual(request(app,body())[0],200)
                self.assertEqual(checked.call_count,5)
                self.assertEqual(request(app,body())[0],200)
                self.assertEqual(checked.call_count,5)
                self.assertEqual({call.args[0] for call in checked.call_args_list},set(self.adapter.manifest['packageFiles']))
                self.assertFalse((destination/'features.npz').exists())

    def test_manifest_artifact_feature_source_and_executable_tamper_refuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp)/'tampered'
            shutil.copytree(PACKAGE,destination,ignore=shutil.ignore_patterns('__pycache__'))
            for relative in ['manifest.json',*self.adapter.manifest['packageFiles']]:
                path = destination/relative; original = path.read_bytes()
                path.write_bytes(original+b'\nCORRUPTED')
                with mock.patch.object(a,'PACKAGE_ROOT',destination):
                    with self.assertRaisesRegex(a.ContractError,'sha256_mismatch'):
                        a.RuntimeShadowWinnerAdapter()
                    status,out = request(make_app(),body())
                    self.assertEqual((status,out),(503,{'detail':{'reason':'shadow_package_unavailable'}}))
                path.write_bytes(original)
        with self.assertRaisesRegex(a.ContractError,'not_whitelisted'):
            a.checked_bytes('../model.txt',a.MODEL_SHA256)

    def test_schema_feature_order_and_promotion_flags_are_fixed(self):
        for mutate in (lambda m:m['featureNames'].reverse(),lambda m:m.update(target='series_winner'),
                       lambda m:m['sourcePins'].update({'source/architecture_contract.py':'0'*64}),
                       lambda m:m.update(eligibleForServing=True),
                       lambda m:m.update(adapterClockSupport={'minSeconds':0,'maxSeconds':9999})):
            altered=copy.deepcopy(self.adapter.manifest); mutate(altered)
            with self.assertRaises(a.ContractError):a.validate_manifest(altered)
        names=list(a.FEATURE_NAMES); names[0],names[1]=names[1],names[0]
        self.assertNotEqual(a.canonical_hash({'names':names,'dtype':'float32','missing':'json_null_mask_to_nan'}),
                            self.adapter.manifest['featureSchemaHash'])

    def test_inference_errors_bounded_and_busy_guard_serializes_only_model_work(self):
        class Broken:
            def predict(self,*args,**kwargs):raise RuntimeError('sensitive private path and payload')
        status,out=request(make_app(Broken),body())
        self.assertEqual((status,out),(503,{'detail':{'reason':'shadow_inference_unavailable'}}))
        entered=threading.Event();release=threading.Event()
        class Slow:
            def predict(self,*args,**kwargs):
                entered.set()
                if not release.wait(5):raise RuntimeError('test synchronization timeout')
                return {'status':'fixture'}
        app=make_app(Slow)
        async def exercise():
            first=asyncio.create_task(request_async(app,body()))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait,2))
                status,out=await request_async(app,body())
                self.assertEqual((status,out),(503,{'detail':{'reason':'shadow_busy'}}))
            finally:release.set()
            status,out=await first
            self.assertEqual(status,200)
            self.assertEqual(out['status'],'fixture')
            self.assertEqual(out['requestBodySha256'],hashlib.sha256(json.dumps(body(),separators=(',',':')).encode()).hexdigest())
        asyncio.run(exercise())


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RuntimeTests))
    report={'scope':'Runtime module and real in-process FastAPI/ASGI tests, not prediction accuracy or prospective evidence',
            'testCount':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
            'goldenTrainRows':30,'historicalEligibleTrainParityRows':408,
            'manifestSha256':MANIFEST_SHA256,'modelSha256':a.MODEL_SHA256,
            'providerCalls':0,'databaseConnections':0,'modelFits':0,'runtimeActivation':False}
    (HERE/'VALIDATION-shadow-live-winner.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    raise SystemExit(0 if result.wasSuccessful() else 1)
