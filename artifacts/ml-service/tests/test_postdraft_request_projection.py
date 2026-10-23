import copy,json,unittest
from collections import defaultdict,deque
from unittest.mock import patch
import numpy as np
from src.research.postdraft_full import builder
from src.research.postdraft_full.projection import LocalEntries,request_view
from src.research.postdraft_input_contract import ASSETS,verified_package
import test_postdraft_full_builder as prior_fixtures
from test_postdraft_input_contract import observation,NOW


class RequestProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.schema=verified_package()[1]

    def state(self):return prior_fixtures.FullBuilderTests().built_state()

    def bits(self,vector):return vector.view(np.uint32).tobytes()

    def test_local_defaults_and_nested_writes_never_touch_source(self):
        source=defaultdict(list,{1:[{'nested':[7]}]});view=LocalEntries(source,{})
        view[1][0]['nested'].append(9);view[2].append('new')
        self.assertEqual(source,{1:[{'nested':[7]}]})
        self.assertEqual(view.get(3,'absent'),'absent');self.assertNotIn(3,view)
        self.assertEqual(set(view),{1,2});self.assertEqual(len(view),2)
        self.assertIs(view[1],view[1])
        plain=LocalEntries({}, {})
        with self.assertRaises(KeyError):plain['missing']

    def test_unknown_rosters_and_pruning_have_exact_bits_without_shared_mutation(self):
        state,m=self.state();before=copy.deepcopy(state)
        for offset,unknown in [(2000,False),(86400*200,True),(3000,False)]:
            target=builder.current(m);target.update(match_id=555,start_time=m['start_time']+offset)
            if unknown:
                target.update(radiant_team_id=998,dire_team_id=999,
                    radiant_account_ids=list(range(1001,1006)),dire_account_ids=list(range(1006,1011)))
            a=copy.deepcopy(state).vector(target,self.schema)
            view=request_view(state);b=view.vector(target,self.schema)
            self.assertEqual(self.bits(a),self.bits(b))
            self.assertEqual(state.rich.individual.last_prediction_at,before.rich.individual.last_prediction_at)
            self.assertEqual(dict(state.rich.basic.teams),dict(before.rich.basic.teams))
            self.assertEqual(dict(state.rich.basic.elo),dict(before.rich.basic.elo))
            self.assertEqual(dict(state.rich.individual.events),dict(before.rich.individual.events))
            self.assertEqual(state.rich.feature_groups,before.rich.feature_groups)
            self.assertEqual(state.rich.individual.feature_groups,before.rich.individual.feature_groups)
            self.assertEqual(set(state.perf.player),set(before.perf.player))
            self.assertEqual(set(state.first.playerhero_perf),set(before.first.playerhero_perf))

    def test_profile_aliases_are_local_even_if_a_caller_mutates_nested_values(self):
        state,_=self.state();view=request_view(state)
        original=state.rich.team_games[1][0]['style'].copy()
        view.rich.team_games[1][0]['style']['duration_min']=999
        self.assertEqual(state.rich.team_games[1][0]['style'],original)
        view.rich.basic.teams[1].clear()
        self.assertTrue(state.rich.basic.teams[1])
        self.assertIsNot(view.rich.individual,state.rich.individual)

    def test_future_cache_exact_parity_current_outcome_ignored_and_booster_reused(self):
        state,_=self.state();manifest={'fixture':True,'snapshotCutoff':'2026-10-13T00:57:00Z'}
        cache=builder.FutureCache(state,manifest,'2026-10-13T00:58:00Z')
        with patch.object(builder,'request_view',side_effect=copy.deepcopy):
            old=cache.predict(observation(),now=NOW)
        model=cache._model
        actual=cache.predict(observation(),now=NOW)
        self.assertIs(cache._model,model)
        self.assertEqual(old,actual)
        dirty=observation();dirty['input'].update(radiantWin=False,radiantScore=999,duration=99999)
        self.assertEqual(actual,cache.predict(dirty,now=NOW))
        with patch.object(builder,'verified_package',side_effect=ValueError('model_pin_changed')):
            with self.assertRaisesRegex(ValueError,'model_pin_changed'):cache.predict(observation(),now=NOW)

    def test_saved_train_probability_golden_bits(self):
        import lightgbm as lgb
        fixtures=json.loads((ASSETS/'TRAIN-GOLDENS.json').read_bytes())
        self.assertEqual(len(fixtures),12)
        self.assertTrue(all(row['split']=='train' for row in fixtures))
        vectors=np.array([[np.nan if v is None else v for v in row['inputVector']] for row in fixtures],dtype=np.float32)
        model=lgb.Booster(model_file=str(ASSETS/'C_corrected_fixed80.model.txt'))
        actual=model.predict(vectors,num_threads=4)
        expected=np.array([row['expectedRadiantWinProbability'] for row in fixtures])
        self.assertEqual(actual.view(np.uint64).tobytes(),expected.view(np.uint64).tobytes())


if __name__=='__main__':unittest.main()
