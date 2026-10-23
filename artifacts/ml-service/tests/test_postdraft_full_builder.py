import copy,json,unittest
from unittest.mock import patch
import numpy as np
from src.research.postdraft_full.builder import (Accumulator,FutureCache,bootstrap,project_prior,validate_receipt,current)
from src.research.postdraft_input_contract import ContractError,verified_package
from test_postdraft_input_contract import observation,NOW

def prior(mid=1,start=1791750000):
    return {'match_id':mid,'start_time':start,'duration':1200,'radiant_team_id':1,'dire_team_id':2,
        'radiant_win':True,'radiant_score':20,'dire_score':10,'series_id':None,'series_type':0,'league_id':1,
        'ingested_at':'2026-10-08T00:00:00Z','parsed_at':None,'players':[], 'payload_schema_version':None,
        'draft':{'radiant_picks':[1,2,3,4,5],'dire_picks':[6,7,8,9,10],
            'radiant_account_ids':[100,101,102,103,104],'dire_account_ids':[105,106,107,108,109],
            'fetched_at':'2026-10-08T00:00:00Z'}}

class FullBuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.schema=verified_package()[1]
    def built_state(self):
        m,minima,_=project_prior(prior(),{});state=Accumulator();state.before(m);state.queue(m,minima);state.advance(1791752000)
        return state,m
    def test_end_plus_300_strict_boundary(self):
        m,minima,_=project_prior(prior(),{});s=Accumulator();s.before(m);s.queue(m,minima)
        s.advance(m['start_time']+1500);self.assertEqual(s.applied,0)
        s.advance(m['start_time']+1500.001);self.assertEqual(s.applied,1)
    def test_full_vector_target_and_future_mutations(self):
        s,m=self.built_state();target=current(m);target.update(match_id=55,start_time=m['start_time']+2000)
        a=copy.deepcopy(s).vector(target,self.schema)
        target.update(radiant_win=False,duration=99999,players=[{'gold_per_min':99999}],radiant_score=999)
        b=copy.deepcopy(s).vector(target,self.schema);np.testing.assert_array_equal(a,b)
        future,fmin,_=project_prior(prior(8,m['start_time']+10000),{})
        # A future completed row must be rejected at receipt selection, not silently included.
        with self.assertRaisesRegex(ContractError,'not_finished'):validate_receipt(future,m['start_time']+3000)
        self.assertEqual(a.shape,(6668,))
    def test_receipt_versions_known_before_capture_only(self):
        m=prior();validate_receipt(m,1791850000)
        for key in ('parsed_at','ingested_at'):
            bad=copy.deepcopy(m);bad[key]='2026-12-01T00:00:00Z'
            with self.assertRaises(ContractError):validate_receipt(bad,1791850000)
        bad=copy.deepcopy(m);bad['draft']['fetched_at']='2026-12-01T00:00:00Z'
        with self.assertRaises(ContractError):validate_receipt(bad,1791850000)
    def test_duplicate_and_order_refused(self):
        m,mins,_=project_prior(prior(),{});s=Accumulator();s.before(m)
        with self.assertRaisesRegex(ContractError,'duplicate'):s.before(m)
        older,_,_=project_prior(prior(2,m['start_time']-1),{})
        with self.assertRaises(ContractError):s.before(older)
    def test_future_cache_refuses_old_observation_and_completed_target(self):
        s,m=self.built_state();cache=FutureCache(s,{'snapshotCutoff':'2026-10-13T00:57:00Z'},'2026-10-13T00:59:01Z')
        with self.assertRaisesRegex(ContractError,'precedes'):cache.predict(observation(),now=NOW)
        cache.built_at='2026-10-13T00:58:00Z';env=observation();env['input']['matchId']=m['match_id']
        with self.assertRaisesRegex(ContractError,'completed_history'):cache.predict(env,now=NOW)
    def test_prediction_uses_clone_and_ignores_current_final_fields(self):
        state,m=self.built_state();cache=FutureCache(state,{'fixture':True,'snapshotCutoff':'2026-10-13T00:57:00Z'},'2026-10-13T00:58:00Z')
        before=state.rich.individual.last_prediction_at
        a=cache.predict(observation(),now=NOW)
        env=observation();env['input'].update(radiantWin=False,duration=9999,radiantScore=999)
        b=cache.predict(env,now=NOW)
        self.assertEqual(a['featureVectorFloat32Sha256'],b['featureVectorFloat32Sha256'])
        self.assertEqual(a['diagnosticRadiantWinProbability'],b['diagnosticRadiantWinProbability'])
        self.assertEqual(state.rich.individual.last_prediction_at,before)
        self.assertFalse(a['quality']['eligibleForServing']);self.assertEqual(len(a['featureVector']),6668)
    def test_series_context_cannot_come_from_future(self):
        state,_=self.built_state();cache=FutureCache(state,{'snapshotCutoff':'2026-10-13T00:57:00Z'},'2026-10-13T00:58:00Z');env=observation()
        env['seriesContext']={'matchId':env['input']['matchId'],'radiantTeamId':1,'direTeamId':2,
            'seriesId':1,'seriesType':1,'receivedAt':'2026-10-13T01:00:00Z'}
        with self.assertRaisesRegex(ContractError,'series_context'):cache.predict(env,now=NOW)
    def test_rebuilding_old_snapshot_does_not_refresh_its_age(self):
        state,_=self.built_state();cache=FutureCache(state,{'snapshotCutoff':'2026-10-10T00:00:00Z'},'2026-10-13T00:58:00Z')
        with self.assertRaisesRegex(ContractError,'snapshot_older_than_24h'):cache.predict(observation(),now=NOW)
        with self.assertRaisesRegex(ContractError,'before_snapshot'):FutureCache(state,{'snapshotCutoff':'2026-10-13T01:00:00Z'},'2026-10-13T00:58:00Z')
    def test_float32_overflow_refused_instead_of_inconsistent_missingness(self):
        state,m=self.built_state();target=current(m);target.update(match_id=55,start_time=m['start_time']+2000)
        values=state.perf.features(target);values['pastscalar_player_30d_gpm_mean_diff']=1e40
        with patch.object(state.perf,'features',return_value=values):
            with self.assertRaisesRegex(ContractError,'float32_feature_overflow'):state.vector(target,self.schema)

if __name__=='__main__':unittest.main()
