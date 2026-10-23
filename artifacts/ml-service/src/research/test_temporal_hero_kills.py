import copy
import json
import math
from pathlib import Path
import unittest

from src.research.temporal_hero_kills import (
    prepare_events, score_at, endpoint_eligibility, past_player_first_hero_kill_min,
)

FIXTURES = {f['match_id']: f for f in json.loads((Path(__file__).parent / 'fixtures' / 'temporal_hero_kills.json').read_text())}


class TemporalHeroKillsTests(unittest.TestCase):
    def setUp(self):
        self.f = copy.deepcopy(FIXTURES[9030822324])
        self.names = {int(k): v for k, v in self.f['reference'].items()}
        self.provenance = {'payload_sha256': self.f['raw_gzip_sha256'],
                           'reference_sha256': self.f['reference_sha256'],
                           'source': 'saved-OpenDota-immutable-response'}

    def prepared(self):
        return prepare_events(self.f['players'], self.names, provenance=self.provenance)

    def first(self, p, slot=0, cutoff=None):
        return past_player_first_hero_kill_min(p, slot, as_of_seconds=self.f['duration'] if cutoff is None else cutoff)

    def test_real_six_bears_not_counted_raw_preserved(self):
        p = self.prepared(); data = p.to_dict()
        bears = [e for e in data['events'] if e['key'] == 'npc_dota_lone_druid_bear1']
        self.assertEqual(len(bears), 6)
        self.assertTrue(all(e['kind'] == 'nonhero' for e in bears))
        self.assertEqual(len(data['events']), 68)
        self.assertEqual(score_at(p, self.f['duration'])['score'], {'radiant': 26, 'dire': 36})
        self.assertTrue(endpoint_eligibility(p, self.f['duration'], self.f['final_score'])['eligible'])
        self.assertEqual(data['provenance'], self.provenance)
        for e in data['events']:
            self.assertEqual(e['raw']['key'], e['key']); self.assertEqual(e['raw']['time'], e['time'])

    def test_real_missing_hero_never_synthesizes_event(self):
        f = FIXTURES[9030351357]
        p = prepare_events(f['players'], {int(k): v for k, v in f['reference'].items()})
        before = p.to_dict(); g = endpoint_eligibility(p, f['duration'], f['final_score'])
        self.assertFalse(g['eligible']); self.assertTrue(g['low_data'])
        self.assertEqual(g['candidate_endpoint'], {'radiant': 46, 'dire': 13})
        self.assertIn('hero_event_counts_disagree_final', g['issues'])
        self.assertEqual(before, p.to_dict())

    def test_negative_time_is_valid_first_kill_not_zero(self):
        p = self.prepared()
        self.assertEqual(score_at(p, 0)['score'], {'radiant': 0, 'dire': 1})
        f = self.first(p, 129, 0)
        self.assertEqual(f['status'], 'observed'); self.assertEqual(f['first_hero_kill_min'], -0.2)

    def test_known_empty_different_from_missing(self):
        self.f['players'][0]['kills_log'] = []
        known = self.first(self.prepared())
        self.assertEqual(known['status'], 'no_hero_kills'); self.assertIsNone(known['first_hero_kill_min'])
        self.assertFalse(known['missing']); self.assertFalse(known['has_hero_kill'])
        del self.f['players'][0]['kills_log']
        p = self.prepared(); unknown = self.first(p)
        self.assertEqual(unknown['status'], 'unknown'); self.assertTrue(unknown['missing'])
        self.assertIsNone(unknown['has_hero_kill']); self.assertIsNone(score_at(p, 300)['score'])

    def test_future_mutation_leaves_score_and_first_unchanged(self):
        p = self.prepared(); before_score = score_at(p, 300); before_first = self.first(p, cutoff=300)
        enemy = next(x for x in self.f['players'] if x['player_slot'] >= 128)
        self.f['players'][0]['kills_log'].append({'time': 301, 'key': self.names[enemy['hero_id']]})
        self.f['players'][0]['kills_log'].append({'time': 302, 'key': 'npc_dota_hero_unknown'})
        q = self.prepared()
        self.assertEqual(before_score, score_at(q, 300)); self.assertEqual(before_first, self.first(q, cutoff=300))

    def test_unknown_key_before_first_prevents_invented_first(self):
        self.f['players'][0]['kills_log'].append({'time': -100, 'key': 'npc_dota_hero_unknown'})
        f = self.first(self.prepared())
        self.assertEqual(f['status'], 'unknown'); self.assertIsNone(f['first_hero_kill_min'])

    def test_unknown_key_after_confirmed_first_does_not_change_first(self):
        p = self.prepared(); before = self.first(p)
        self.assertEqual(before['status'], 'observed')
        self.f['players'][0]['kills_log'].append({'time': self.f['duration'] - 1, 'key': 'npc_dota_hero_unknown'})
        after = self.first(self.prepared())
        self.assertEqual(after['first_hero_kill_min'], before['first_hero_kill_min'])
        self.assertEqual(after['status'], 'observed'); self.assertIsNone(after['hero_kill_count'])

    def test_missing_time_might_precede_first_and_is_unknown(self):
        enemy = next(x for x in self.f['players'] if x['player_slot'] >= 128)
        self.f['players'][0]['kills_log'].append({'key': self.names[enemy['hero_id']]})
        p = self.prepared(); f = self.first(p)
        self.assertEqual(f['status'], 'unknown'); self.assertIsNone(score_at(p, 300)['score'])
        self.assertIn('event_time_missing_or_invalid', f['issues'])

    def test_time_bool_nan_and_fraction_fail_closed(self):
        enemy = next(x for x in self.f['players'] if x['player_slot'] >= 128)
        for time in (True, float('nan'), float('inf'), 0.5, 10**400):
            with self.subTest(time=str(time)[:30]):
                players = copy.deepcopy(self.f['players'])
                players[0]['kills_log'].append({'time': time, 'key': self.names[enemy['hero_id']]})
                p = prepare_events(players, self.names)
                self.assertIsNone(score_at(p, 300)['score']); self.assertTrue(self.first(p)['missing'])

    def test_unknown_hero_id_and_bad_reference_fail_closed(self):
        for names in ({k:v for k,v in self.names.items() if k != self.f['players'][0]['hero_id']}, {1: 'Anti-Mage'}):
            p = prepare_events(self.f['players'], names)
            self.assertIsNone(score_at(p, 300)['score']); self.assertTrue(self.first(p)['missing'])
        self.f['players'][0]['hero_id'] = 999999
        self.assertIsNone(score_at(self.prepared(), 300)['score'])

    def test_reference_hash_mismatch_fail_closed(self):
        p = prepare_events(self.f['players'], self.names, expected_reference_mapping_sha256='0'*64)
        self.assertIn('reference_hash_mismatch', p.structural_issues)
        self.assertIsNone(score_at(p, 300)['score'])

    def test_slot_duplicates_and_bool_fail_closed(self):
        for slot in (self.f['players'][1]['player_slot'], True):
            players = copy.deepcopy(self.f['players']); players[0]['player_slot'] = slot
            p = prepare_events(players, self.names)
            self.assertIn('invalid_10_player_slots', p.structural_issues)
            self.assertIsNone(score_at(p, 300)['score'])

    def test_raw_inputs_export_and_provenance_are_independent(self):
        before = copy.deepcopy(self.f); p = self.prepared(); exported = p.to_dict()
        exported['events'][0]['raw']['time'] = 99999; exported['provenance']['source'] = 'changed'
        self.f['players'][0]['kills_log'].clear(); self.provenance['source'] = 'mutated'
        self.assertNotEqual(p.to_dict()['provenance']['source'], 'mutated')
        self.assertNotEqual(p.to_dict()['events'][0]['raw']['time'], 99999)
        q = prepare_events(before['players'], self.names)
        self.assertEqual(score_at(p, 300), score_at(q, 300))

    def test_labels_are_only_gate_inputs(self):
        p = self.prepared(); before = score_at(p, 300); first = self.first(p)
        endpoint_eligibility(p, self.f['duration'], {'radiant': 999, 'dire': 999})
        self.assertEqual(before, score_at(p, 300)); self.assertEqual(first, self.first(p))

    def test_after_end_and_own_hero_are_not_accepted(self):
        enemy = next(x for x in self.f['players'] if x['player_slot'] >= 128)
        self.f['players'][0]['kills_log'].append({'time': self.f['duration'] + 1, 'key': self.names[enemy['hero_id']]})
        gate = endpoint_eligibility(self.prepared(), self.f['duration'], self.f['final_score'])
        self.assertIn('hero_event_after_game_end', gate['issues'])
        self.f['players'][0]['kills_log'].append({'time': -100, 'key': self.names[self.f['players'][0]['hero_id']]})
        self.assertTrue(self.first(self.prepared())['missing'])

    def test_invalid_cutoffs_and_malformed_players(self):
        for value in (True, -1, float('nan')):
            with self.assertRaises(ValueError): score_at(self.prepared(), value)
        p = prepare_events(None, self.names)
        self.assertFalse(score_at(p, 300)['available']); self.assertTrue(self.first(p)['missing'])

    def test_ambiguous_exact_duplicate_before_and_after_prefix(self):
        enemy = next(x for x in self.f['players'] if x['player_slot'] >= 128)
        key = self.names[enemy['hero_id']]
        self.f['players'][0]['kills_log'] = [
            {'time': 100, 'key': key}, {'time': 500, 'key': key}, {'time': 500, 'key': key},
        ]
        p = self.prepared()
        self.assertTrue(score_at(p, 300)['available'])
        self.assertFalse(score_at(p, 500)['available'])
        self.assertIn('ambiguous_exact_duplicate_hero_event', score_at(p, 500)['issues'])
        self.assertEqual(self.first(p, cutoff=500)['first_hero_kill_min'], 100/60)
        self.assertIsNone(self.first(p, cutoff=500)['hero_kill_count'])
        self.f['players'][0]['kills_log'].insert(1, {'time': 100, 'key': key})
        q = self.prepared()
        self.assertFalse(score_at(q, 300)['available'])
        self.assertTrue(self.first(q, cutoff=300)['missing'])

    def test_other_player_missing_log_is_conservatively_global(self):
        self.assertEqual(self.first(self.prepared())['status'], 'observed')
        del self.f['players'][1]['kills_log']
        self.assertEqual(self.first(self.prepared())['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
