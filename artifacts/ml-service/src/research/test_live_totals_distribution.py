"""Contract tests for research totals support, coherent probabilities and causality."""
import unittest
import numpy as np
from .live_totals_distribution import (RemainingDistribution, row_map_weights,
    map_mean, EmpiricalRemainingForest, paired_cluster_interval)
from .run_live_totals import totals_rows, assert_split_integrity, epoch, RESERVED


class DistributionTests(unittest.TestCase):
    def test_kills_integer_support_and_one_monotone_cdf(self):
        d=RemainingDistribution([0,2,8],[.2,.3,.48],.02,4,'kills',40)
        lines=[39.5,40,40.5,42,42.5,48.5,70.5]
        probs=[d.probabilities(x) for x in lines]
        self.assertEqual(probs[0]['pOver'],1)
        self.assertTrue(all(a['pOver']>=b['pOver'] for a,b in zip(probs,probs[1:])))
        for line,p in zip(lines,probs):
            self.assertAlmostEqual(sum(p.values()),1)
            if line%1:self.assertEqual(p['pPush'],0)
        self.assertGreater(probs[-1]['pOver'],0)
        self.assertLess(probs[2]['pOver'],1)
        self.assertGreater(probs[1]['pPush'],0)
        for q in (.05,.25,.5,.75,.95):
            self.assertIsInstance(d.quantile(q),int)
            self.assertGreaterEqual(d.quantile(q),40)

    def test_duration_never_finishes_before_observation(self):
        d=RemainingDistribution([1,30,120],[.2,.3,.48],.02,60,'duration',3600)
        for q in (.05,.25,.5,.75,.95):self.assertGreater(d.quantile(q),3600)
        self.assertEqual(d.probabilities(3600)['pOver'],1)
        self.assertGreater(d.probabilities(4200)['pOver'],0)
        self.assertLess(d.probabilities(3601)['pOver'],1)

    def test_invalid_support_rejected(self):
        for values,target in [([0],'duration'),([-1],'kills'),([1.9],'kills')]:
            with self.assertRaises(ValueError):RemainingDistribution(values,[.98],.02,5,target,10)
        with self.assertRaises(ValueError):RemainingDistribution([2],[.5],.02,5,'kills',10)

    def test_equal_map_weighting_ignores_duplicate_frames(self):
        rows=[{'match_id':1}]+[{'match_id':2}]*10
        self.assertAlmostEqual(row_map_weights(rows)[1:].sum(),1)
        self.assertAlmostEqual(map_mean([0]+[10]*10,rows),5)
        rows=[{'match_id':1,'group':'series-a'}]*2+[{'match_id':2,'group':'series-b'}]
        ci=paired_cluster_interval([1,1,3],[0,0,0],rows,100)
        self.assertAlmostEqual(ci['delta'],2)
        self.assertEqual(ci['clusters'],2)

    def test_forest_distribution_roundtrip_missing_features(self):
        rows=[{'match_id':i//4,'group':str(i//8),'features':[i%4,None,i%7],
              'elapsed_seconds':600+(i%4)*60,'observed_kills':i%10,
              'remaining_duration':100+(i%17)*10,'remaining_kills':i%15} for i in range(100)]
        model=EmpiricalRemainingForest().fit(rows)
        for target in ('kills','duration'):
            for baseline in (False,True):
                predictions=model.predict_distributions(rows[:3],target,baseline=baseline)
                for row,d in zip(rows,predictions):
                    observed=row['observed_kills'] if target=='kills' else row['elapsed_seconds']
                    self.assertGreaterEqual(d.quantile(.05),observed+(target=='duration'))
                    self.assertAlmostEqual(sum(d.probabilities(observed+30.5).values()),1)


class CausalTotalsTests(unittest.TestCase):
    def row(self):
        features=[0.0]*26;features[19]=10
        return {'match_id':1,'group':'a','start':1000,'label_available':4900,
          'snapshot_id':5,'captured':3000,'latest_feature_outcome':999,
          'game_minute':30,'duration':3600,'kills':50,'base':features}

    def test_actual_end_receipt_and_reserve_excluded(self):
        good=self.row();end={**good,'captured':4600};future={**good,'label_available':epoch(RESERVED)}
        rows,reasons=totals_rows([good,end,future],epoch(RESERVED))
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['remaining_duration'],1800)
        self.assertEqual(rows[0]['remaining_kills'],40)
        self.assertEqual(reasons,{'received_after_or_before_game':1,'reserved_or_unavailable_outcome':1})

    def test_future_context_rejected(self):
        with self.assertRaises(ValueError):totals_rows([{**self.row(),'latest_feature_outcome':1000}],epoch(RESERVED))

    def test_map_and_series_cannot_cross_splits(self):
        rows,_=totals_rows([self.row()],epoch(RESERVED))
        with self.assertRaises(ValueError):assert_split_integrity({'train':rows,'test':rows})
        with self.assertRaises(ValueError):assert_split_integrity({'train':rows,'test':[{**rows[0],'match_id':2}]})


if __name__=='__main__':unittest.main()
