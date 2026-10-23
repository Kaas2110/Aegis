"""Portable boundary regression; no providers, database or learned engines."""
import unittest
try:
    from .causal_profile_contract import final_roster, roster_for_phase, select_history
except ImportError:
    from causal_profile_contract import final_roster, roster_for_phase, select_history

def row(mid=1, receipt=1901):
    return dict(match_id=mid,start_time=1000,duration=600,radiant_win=True,payload_schema_version=3,received_at=receipt,
        players=[dict(player_slot=i if i<5 else 128+i-5,hero_id=i+1,account_id=100+i) for i in range(10)])

class CausalProfileContractTests(unittest.TestCase):
    def test_target_is_excluded_before_reading_outcome(self):
        rows,contract=select_history([{'match_id':2},row()],target_match_id=2,cutoff=2000,mode='observed_receipt')
        self.assertEqual(len(rows),1)
        self.assertEqual(contract['rejected']['target_match_excluded'],1)
        self.assertFalse(contract['eligible_for_serving'])

    def test_event_and_receipt_clocks_are_separate(self):
        self.assertEqual(len(select_history([row(receipt=2100)],target_match_id=2,cutoff=2000,mode='observed_receipt')[0]),0)
        self.assertEqual(len(select_history([row(receipt=2100)],target_match_id=2,cutoff=2000,mode='historical_reconstruction')[0]),1)
        self.assertEqual(len(select_history([row()],target_match_id=2,cutoff=1900,mode='historical_reconstruction')[0]),0)

    def test_final_roster_is_not_a_known_live_draft(self):
        raw=row();raw['players'].reverse()
        roster=final_roster(raw)
        self.assertEqual(roster['radiant'][0]['hero_id'],1)
        self.assertIsNone(roster['bans']);self.assertIsNone(roster['draft_order'])
        self.assertIsNone(roster['draft_observed_at'])
        for phase in ['prematch','postdraft','live']:
            with self.assertRaises(ValueError):roster_for_phase(roster,phase)

if __name__=='__main__':unittest.main()
