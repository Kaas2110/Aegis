"""Pinned train-only goldens and adversarial observed-input contract tests; no fit."""
import copy,json,unittest
import numpy as np
from src.research import corrected_totals_diagnostic as adapter

STAMP='2026-10-13T01:00:00+00:00'


class CorrectedTotalsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine=adapter.CorrectedTotalsDiagnostic()
        md=cls.engine.manifest['goldens']
        cls.goldens=json.loads(adapter.checked_asset(md['file'],md['sha256']))['rows']

    def packet(self,minute=45,radiant=25,dire=20):
        p=copy.deepcopy(self.goldens[0]['packet'])
        p.update(gameTimeSec=minute*60,radiantScore=radiant,direScore=dire)
        return p

    def predict(self,p,lines=None):
        return self.engine.predict(p,expected_match_id=p['matchId'],computed_at=STAMP,lines=lines)

    def test_pinned_bundle_has_exact_selected_models_and_no_quality_gates(self):
        self.assertEqual(len(self.engine.model_hashes),16)
        self.assertEqual(self.engine.manifest['selectedVariants'],{'kills':'draft1006','duration':'draft1006'})
        out=self.predict(self.packet())
        for gate in adapter.GATES:self.assertIs(out[gate],False)
        self.assertIsNone(out['publicProbabilities'])
        self.assertEqual(out['lineDiagnostics'],[])

    def test_train_only_saved_model_quantile_and_vector_parity_22_cases(self):
        self.assertEqual(len(self.goldens),22)
        for row in self.goldens:
            out=self.predict(row['packet'])
            self.assertEqual(out['featureVectorSha256'],row['feature_sha256'])
            for target in ('kills','duration'):
                np.testing.assert_array_equal(out['quantiles'][target]['rawRemaining'],row['raw_quantiles'][target])

    def test_train_only_saved_cdf_parity_22_cases(self):
        for row in self.goldens:
            _,vector=adapter.observed_input(row['packet'],row['packet']['matchId'])
            for target in ('kills','duration'):
                case=row['cdf'][target]
                raw,cal=self.engine._cdf(target,vector,[int(t) for t in case['thresholds']])
                np.testing.assert_array_equal(raw,case['raw'])
                np.testing.assert_allclose(cal,case['calibrated'],rtol=0,atol=1e-15)

    def test_final_or_future_fields_never_change_features_or_predictions(self):
        p=self.packet();before=self.predict(p)
        p.update(radiantWin=False,finalKills=999,finalDuration=999999,gold_t=[999999],futureEvents=[{'time':999999}])
        for player in p['players']:player.update(gpm=99999,finalRole=1,kills_log=[{'time':999999}])
        after=self.predict(p)
        self.assertEqual(before,after)

    def test_state_evolves_at9_45_62_without_exceeding_observed_lower_bounds(self):
        outputs=[self.predict(self.packet(m,r,d)) for m,r,d in ((9,5,4),(45,30,25),(62,48,43))]
        self.assertEqual([r['stateFeatureVector'][1] for r in outputs],[9.,45.,62.])
        self.assertEqual(len({r['featureVectorSha256'] for r in outputs}),3)
        self.assertEqual(len({tuple(r['quantiles']['duration']['rawRemaining']) for r in outputs}),3)
        for o in outputs:
            p=o['observedInput'];q=o['quantiles']
            self.assertTrue(all(v>=p['radiantScore']+p['direScore'] for v in q['kills']['finalKills']))
            self.assertTrue(all(v>=p['gameTimeSec']+1-1e-9 for v in q['duration']['finalSeconds']))
            np.testing.assert_allclose(np.asarray(q['duration']['finalMinutes'])*60,q['duration']['finalSeconds'],rtol=0,atol=1e-9)
            self.assertIs(o['interpolatedClockQualityValidated'],False)
        self.assertEqual([o['clockOnTrainingCheckpoint'] for o in outputs],[False,True,False])

    def test_clock_domain_and_map_identity_are_required(self):
        for second in (299,4501):
            p=self.packet();p['gameTimeSec']=second
            with self.assertRaises(adapter.ContractError):self.predict(p)
        with self.assertRaises(adapter.ContractError):
            self.engine.predict(self.packet(),expected_match_id=1,computed_at=STAMP)

    def test_missing_unknown_invalid_observation_is_not_zero_filled(self):
        p=self.packet()
        for key,value in (('radiantScore',None),('direScore',-1),('radiantScore',False),('players',p['players'][:9]),('gameTimeSec',float('nan'))):
            bad=copy.deepcopy(p);bad[key]=value
            with self.assertRaises(adapter.ContractError):self.predict(bad)

    def test_integer_and_half_kill_lines_have_correct_settlement(self):
        p=self.packet();total=p['radiantScore']+p['direScore']
        o=self.predict(p,[{'target':'kills','unit':'kills','line':total+10},{'target':'kills','unit':'kills','line':total+10.5}])
        integer,half=o['lineDiagnostics']
        self.assertEqual((integer['residualThresholdAt'],integer['residualThresholdBelow']),(10,9))
        self.assertEqual((half['residualThresholdAt'],half['residualThresholdBelow']),(10,10))
        for v in (integer,half):
            self.assertTrue(v['available'])
            for kind in ('raw','calibrated'):self.assertAlmostEqual(sum(v[kind].values()),1.)
        self.assertEqual(half['raw']['pPush'],0.)
        self.assertEqual(half['calibrated']['pPush'],0.)

    def test_duration_requires_explicit_exact_second_settlement(self):
        p=self.packet();line=p['gameTimeSec']+600
        bad=[{'target':'duration','line':line,'unit':'seconds'},
             {'target':'duration','line':55,'unit':'minutes','settlement':'exact_seconds'},
             {'target':'duration','line':line+.5,'unit':'seconds','settlement':'exact_seconds'}]
        o=self.predict(p,bad+[{'target':'duration','line':line,'unit':'seconds','settlement':'exact_seconds'}])
        self.assertTrue(all(not x['available'] for x in o['lineDiagnostics'][:3]))
        last=o['lineDiagnostics'][-1]
        self.assertTrue(last['available']);self.assertEqual((last['residualThresholdAt'],last['residualThresholdBelow']),(600,599))

    def test_quarter_negative_and_nonfinite_lines_are_explicitly_unsupported(self):
        p=self.packet();lines=[{'target':'kills','unit':'kills','line':v} for v in (50.25,-1,float('nan'),False,10**1000)]
        for item in self.predict(p,lines)['lineDiagnostics']:
            self.assertFalse(item['available']);self.assertIsNone(item['raw']);self.assertIsNone(item['calibrated'])

    def test_unknown_cdf_tail_refuses_instead_of_forcing100percent(self):
        p=self.packet();total=p['radiantScore']+p['direScore']
        lines=[{'target':'kills','unit':'kills','line':total+121},
               {'target':'duration','unit':'seconds','settlement':'exact_seconds','line':p['gameTimeSec']+5401}]
        for item in self.predict(p,lines)['lineDiagnostics']:
            self.assertEqual(item['reason'],'cdf_residual_support_exceeded')
            self.assertFalse(item['available']);self.assertIsNone(item['raw']);self.assertIsNone(item['calibrated'])

    def test_support_boundaries_are_inclusive(self):
        p=self.packet();total=p['radiantScore']+p['direScore']
        lines=[{'target':'kills','unit':'kills','line':total},
               {'target':'kills','unit':'kills','line':total+120},
               {'target':'duration','unit':'seconds','settlement':'exact_seconds','line':p['gameTimeSec']+1},
               {'target':'duration','unit':'seconds','settlement':'exact_seconds','line':p['gameTimeSec']+5400}]
        items=self.predict(p,lines)['lineDiagnostics'];self.assertTrue(all(x['available'] for x in items))
        self.assertEqual(items[0]['raw']['pUnder'],0.);self.assertEqual(items[2]['raw']['pUnder'],0.)

    def test_resolved_lines_do_not_masquerade_as_model_confidence(self):
        p=self.packet();lines=[{'target':'kills','unit':'kills','line':44},
                              {'target':'duration','unit':'seconds','settlement':'exact_seconds','line':p['gameTimeSec']}]
        for item in self.predict(p,lines)['lineDiagnostics']:
            self.assertFalse(item['available']);self.assertIsNone(item['raw'])

    def test_heads_are_independent_cdf_does_not_consume_rich_quantiles(self):
        p=self.packet();lines=[{'target':'kills','unit':'kills','line':55}]
        before=self.predict(p,lines);p['players']=[{'heroId':100+i,'team':0 if i<5 else 1} for i in range(10)]
        after=self.predict(p,lines)
        self.assertNotEqual(before['featureVectorSha256'],after['featureVectorSha256'])
        self.assertEqual(before['stateFeatureVectorSha256'],after['stateFeatureVectorSha256'])
        self.assertEqual(before['lineDiagnostics'],after['lineDiagnostics'])
        self.assertIs(after['jointDistributionValidated'],False)

    def test_raw_and_calibrated_outputs_are_separate_unvalidated(self):
        o=self.predict(self.packet(),[{'target':'kills','unit':'kills','line':55}])
        d=o['lineDiagnostics'][0]
        self.assertIsNot(d['raw'],d['calibrated']);self.assertIs(d['exactPushValidated'],False)
        self.assertIs(d['calibrationQualityValidated'],False);self.assertIs(d['probabilitiesArePublic'],False)
        self.assertTrue(any('zero push' in x for x in o['limitations']))

    def test_deterministic_digest_and_explicit_timezone(self):
        p=self.packet();a=self.predict(p);b=self.predict(p);self.assertEqual(a,b)
        unhashed={k:v for k,v in a.items() if k!='responseSha256'}
        self.assertEqual(a['responseSha256'],adapter.canonical_hash(unhashed))
        with self.assertRaises(adapter.ContractError):self.engine.predict(p,expected_match_id=p['matchId'],computed_at='2026-10-13T01:00:00')

    def test_feature_model_and_asset_tampering_is_rejected(self):
        with self.assertRaises(adapter.ContractError):adapter.checked_asset('MANIFEST.json','0'*64)
        with self.assertRaises(adapter.ContractError):adapter.checked_asset('../MANIFEST.json','0'*64)

    def test_line_count_is_bounded_and_malformed_lines_are_explicit(self):
        p=self.packet();valid={'target':'kills','line':55,'unit':'kills'}
        self.assertEqual(len(self.predict(p,[valid]*128)['lineDiagnostics']),128)
        with self.assertRaises(adapter.ContractError):self.predict(p,[valid]*129)
        with self.assertRaises(adapter.ContractError):self.predict(p,{'line':55})
        malformed=self.predict(p,[None,[],{}, {'target':[], 'line':55}])['lineDiagnostics']
        self.assertTrue(all(not line['available'] and line['raw'] is None and line['calibrated'] is None for line in malformed))


if __name__=='__main__':unittest.main(verbosity=2)
