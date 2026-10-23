import os
for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[key]='4'
import copy,json,unittest
import numpy as np
import lightgbm as lgb
from src.research.postdraft_input_contract import (ASSETS,ContractError,canonical_hash,verified_package,
    normalize_observation,phase_selection,draft_columns,select_history_versions,inspect_inputs,timestamp)

NOW='2026-10-13T01:00:00Z'
def observation(players=None):
    return {'observationId':'a'*64,'source':'opendota','targetScope':'map','clockUnit':'seconds',
        'receivedAt':'2026-10-13T00:59:00Z','recordedAt':'2026-10-13T00:59:01Z','phase':'live',
        'availability':{'draftComplete':True,'outcomeKnownAtCapture':False},'input':{'matchId':9999999999,
        'radiantTeamId':1,'direTeamId':2,'gameTimeSec':0,
        'players':players or [{'team':int(i>=5),'heroId':i+1,'accountId':100+i} for i in range(10)]}}
def prior(mid=123,basis='observed_payload_version'):
    payload={'match_id':mid,'start_time':timestamp('2026-10-12T23:00:00Z'),'duration':1200,
        'radiant_team_id':1,'dire_team_id':2,'radiant_win':True,'payload_schema_version':3,'players':[]}
    return {'matchId':mid,'versionId':'payload-v1-'+str(mid),'basis':basis,'capturedAt':'2026-10-13T00:55:00Z',
        'receivedAt':'2026-10-13T00:54:00Z' if basis=='observed_payload_version' else None,
        'payload':payload,'payloadSha256':canonical_hash(payload)}

class PostdraftContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest,cls.schema=verified_package()
        cls.goldens=json.loads((ASSETS/'TRAIN-GOLDENS.json').read_text(encoding='utf8'))

    def test_phase_boundaries_are_explicit(self):
        expected={-60:'postdraft_input_diagnostic',0:'postdraft_input_diagnostic',59:'postdraft_input_diagnostic',
            60:None,299:None,300:'existing_observed_live_diagnostic',4772:'existing_observed_live_diagnostic',4800:None}
        for clock,route in expected.items():self.assertEqual(phase_selection(clock,True)['route'],route)
        self.assertIsNone(phase_selection(0,False)['route'])

    def test_train_only_draft_subvector_exact(self):
        names=self.schema['featureNames'];indices=[names.index(n) for n in self.schema['directDraftNames']]
        self.assertEqual(len(indices),4504)
        for fixture in self.goldens:
            self.assertEqual(fixture['split'],'train')
            obs=normalize_observation(observation(fixture['draftPlayers']),now=NOW)
            actual=draft_columns(obs,self.schema)
            np.testing.assert_array_equal(np.array([actual[names[i]] for i in indices],dtype=np.float32),
                np.array([fixture['inputVector'][i] for i in indices],dtype=np.float32))

    def test_train_only_saved_model_probability_parity(self):
        model=lgb.Booster(model_file=str(ASSETS/'C_corrected_fixed80.model.txt'))
        # Original fixed fit supplied numpy arrays; the model stores Column_i.
        # Semantic order is supplied by the separately pinned fit manifest.
        self.assertEqual(model.feature_name(),['Column_'+str(i) for i in range(6668)])
        matrix=np.array([[np.nan if x is None else x for x in f['inputVector']] for f in self.goldens],dtype=np.float32)
        actual=model.predict(matrix,num_threads=4)
        np.testing.assert_array_equal(actual,np.array([f['expectedRadiantWinProbability'] for f in self.goldens]))

    def test_current_finals_do_not_change_partial_features(self):
        envelope=observation();baseline=inspect_inputs(envelope,[],now=NOW,schema=self.schema)
        envelope['input'].update({'radiantWin':False,'duration':9999,'radiantScore':999,'goldPerMin':5000})
        for player in envelope['input']['players']:player.update({'finalLaneRole':4,'gold_per_min':9999})
        mutated=inspect_inputs(envelope,[],now=NOW,schema=self.schema)
        self.assertEqual(baseline['partialVectorHash'],mutated['partialVectorHash'])
        self.assertEqual(baseline['normalizedInputHash'],mutated['normalizedInputHash'])

    def test_player_pairing_changes_identity_not_fabricated_features(self):
        envelope=observation();first=inspect_inputs(envelope,[],now=NOW,schema=self.schema)
        players=envelope['input']['players'];players[0]['accountId'],players[1]['accountId']=players[1]['accountId'],players[0]['accountId']
        second=inspect_inputs(envelope,[],now=NOW,schema=self.schema)
        self.assertNotEqual(first['normalizedInputHash'],second['normalizedInputHash'])
        self.assertEqual(first['partialVectorHash'],second['partialVectorHash'])

    def test_current_map_history_is_not_inspected(self):
        obs=normalize_observation(observation(),now=NOW)
        result=select_history_versions([{'matchId':obs.match_id,'payload':{'winner':'malformed future label'}}],obs)
        self.assertEqual(result['selectedMaps'],0)
        self.assertEqual(result['rejected'],{'current_map_excluded':1})

    def test_future_record_mutation_cannot_change_selected_lineage(self):
        obs=normalize_observation(observation(),now=NOW);future=prior(124)
        future['capturedAt']='2026-10-13T01:10:00Z'
        first=select_history_versions([prior(),future],obs)
        future['payload']={'radiant_win':False,'duration':-1};future['payloadSha256']='wrong'
        second=select_history_versions([prior(),future],obs)
        self.assertEqual(first['selectedLineageHash'],second['selectedLineageHash'])

    def test_strict_receipt_boundary_and_unknown_basis(self):
        obs=normalize_observation(observation(),now=NOW);equal=prior(124)
        equal['capturedAt']='2026-10-13T00:59:00Z';unknown=prior(125);unknown['basis']='latest_merged_parsed_at'
        result=select_history_versions([prior(),equal,unknown],obs)
        self.assertEqual(result['selectedMaps'],1)
        self.assertEqual(result['rejected'],{'captured_at_or_after_cutoff':1,'immutable_receipt_basis_missing':1})

    def test_startup_snapshot_only_supports_later_observations(self):
        obs=normalize_observation(observation(),now=NOW);version=prior(basis='startup_frozen_snapshot')
        result=select_history_versions([version],obs)
        self.assertEqual(result['selectedMaps'],1);self.assertFalse(result['selected'][0]['originalReceiptKnown'])
        version['capturedAt']='2026-10-13T01:01:00Z'
        self.assertEqual(select_history_versions([version],obs)['selectedMaps'],0)

    def test_tampered_or_duplicate_history_fails(self):
        obs=normalize_observation(observation(),now=NOW)
        with self.assertRaises(ContractError):select_history_versions([prior(),prior()],obs)
        changed=prior();changed['payload']['radiant_win']=False
        with self.assertRaises(ContractError):select_history_versions([changed],obs)

    def test_no_partial_vector_prediction_and_no_fake_quality(self):
        result=inspect_inputs(observation(),[prior()],now=NOW,schema=self.schema)
        self.assertEqual((result['computedFeatureCount'],result['unresolvedFeatureCount']),(4504,2164))
        self.assertEqual(sum(result['computedMask']),4504)
        self.assertIsNone(result['probability']);self.assertFalse(result['partialVectorMayBeUsedForPrediction'])
        for key in ('servingEligible','prospectiveValidated','latencyValidated','coverage95Validated'):self.assertFalse(result[key])

    def test_unknown_accounts_and_new_hero_block_rich_builder(self):
        envelope=observation();envelope['input']['players'][0]['accountId']=None
        self.assertFalse(inspect_inputs(envelope,[],now=NOW,schema=self.schema)['readyForFullHistoryBuild'])
        envelope=observation();envelope['input']['players'][0]['heroId']=999
        self.assertFalse(inspect_inputs(envelope,[],now=NOW,schema=self.schema)['readyForFullHistoryBuild'])

    def test_invalid_observation_gates(self):
        for mutate in (lambda e:e['availability'].update(outcomeKnownAtCapture=None),
                       lambda e:e.update(recordedAt='2026-10-13T02:00:00Z'),
                       lambda e:e['input']['players'][0].update(heroId=True),
                       lambda e:e['input']['players'][0].update(accountId=101),
                       lambda e:e['input'].update(radiantTeamId=2),
                       lambda e:e.update(phase='post_draft')):
            envelope=observation();mutate(envelope)
            with self.assertRaises(ContractError):normalize_observation(envelope,now=NOW)

    def test_sides_reverse_signed_draft_identity(self):
        envelope=observation();a=draft_columns(normalize_observation(envelope,now=NOW),self.schema)
        for player in envelope['input']['players']:player['team']=1-player['team']
        b=draft_columns(normalize_observation(envelope,now=NOW),self.schema)
        for name in a:
            if name.startswith(('hero_presence_','ally_pair_','counter_pair_')) and not name.endswith('__missing'):
                self.assertEqual(a[name],-b[name])

if __name__=='__main__':unittest.main()
