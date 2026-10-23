import copy,unittest
from datetime import datetime,timezone
from test_postdraft_input_contract import observation,NOW
from src.research.postdraft_full.journal_adapter import journal_envelope,checked_completion
from src.research.postdraft_input_contract import ContractError

def row():
    e=observation()
    return {'id':e['observationId'],'match_id':e['input']['matchId'],'received_at':e['receivedAt'],
        'recorded_at':e['recordedAt'],'game_time_sec':0,'phase':e['phase'],'input':e['input'],
        'availability':e['availability'],'input_hash':'b'*64,'schema_hash':'c'*64,
        'quality_reasons':['live_freshness:event_latency_unverified']}

class JournalAdapterTests(unittest.TestCase):
    def adapt(self,r,**kwargs):return journal_envelope(r,now=NOW,expected_schema_hash='c'*64,outcome_known_at_dispatch=kwargs.get('outcome',False))
    def test_actual_column_mapping_retains_receipts_availability_and_identity(self):
        r=row();r['received_at']=datetime.fromisoformat(r['received_at'].replace('Z','+00:00'))
        e=self.adapt(r);self.assertEqual(e['input'],r['input']);self.assertEqual(e['availability'],r['availability'])
        self.assertEqual(e['sourceJournal']['inputHash'],r['input_hash'])
        self.assertFalse(e['sourceJournal']['sourceEventLatencyVerified'])
        self.assertEqual(e['sourceJournal']['qualityReasons'],r['quality_reasons'])
    def test_schema_identity_capture_and_dispatch_outcome_gates(self):
        for key,value in [('schema_hash','d'*64),('match_id',9),('game_time_sec',5),('phase','post_draft')]:
            r=row();r[key]=value
            with self.assertRaises(ContractError):self.adapt(r)
        r=row();r['availability']['outcomeKnownAtCapture']=None
        with self.assertRaises(ContractError):self.adapt(r)
        with self.assertRaises(ContractError):self.adapt(row(),outcome=True)
    def test_live_packet_out_of_postdraft_domain_not_extrapolated(self):
        r=row();r['game_time_sec']=r['input']['gameTimeSec']=300
        with self.assertRaisesRegex(ContractError,'postdraft_phase_only'):self.adapt(r)
    def test_nullable_final_outcome_gate_does_not_publish_late_probability(self):
        with self.assertRaises(ContractError):checked_completion({},outcome_known_at_finish=None)
        result=checked_completion({'diagnosticRadiantWinProbability':.7},outcome_known_at_finish=True)
        self.assertIsNone(result['probability']);self.assertNotIn('response',result)

if __name__=='__main__':unittest.main()
