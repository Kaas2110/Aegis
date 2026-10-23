import copy,json,math,unittest
from unittest.mock import patch
import numpy as np
from src.research import hazard_totals_diagnostic as h

AT='2026-10-13T01:00:00Z'
class HazardMathTests(unittest.TestCase):
 def test_geometric_oracle_integer_and_half_lines(self):
  d=h.DiscreteHazard(np.zeros(5),0,4,1.)
  for k in range(5):
   p=d.line(k)['probabilities']
   self.assertAlmostEqual(p['pPush'],.5**(k+1));self.assertAlmostEqual(p['pOver'],.5**(k+1))
   self.assertAlmostEqual(p['pUnder'],1-.5**k)
   half=d.line(k+.5)
   if k<4:self.assertEqual(half['probabilities']['pPush'],0.)
  # All unallocated mass is at integers >=5, so 4.5 is still exactly priceable.
  self.assertAlmostEqual(d.line(4.5)['probabilities']['pOver'],1/32)
  self.assertFalse(d.line(5)['available']);self.assertAlmostEqual(math.exp(d.log_survival[-1]),1/32)
 def test_duration_support_and_physical_bound(self):
  d=h.DiscreteHazard(np.zeros(3),1,3,1.)
  self.assertEqual(d.line(0)['probabilities'],{'pUnder':0.,'pPush':0.,'pOver':1.})
  self.assertEqual(d.line(1)['probabilities'],{'pUnder':0.,'pPush':.5,'pOver':.5})
 def test_unknown_tail_quantile_is_not_last_bin(self):
  d=h.DiscreteHazard(np.full(3,-20.),1,3,1.)
  self.assertEqual(d.quantiles(),[None]*7);self.assertGreater(math.exp(d.log_survival[-1]),.999)
 def test_tiny_atoms_keep_log_probability(self):
  d=h.DiscreteHazard(np.full(2,-1000.),0,1,1.)
  p=d.line(0)
  self.assertEqual(p['probabilities']['pPush'],0.)
  self.assertEqual(p['logProbabilities']['push'],-1000.)
  self.assertFalse(p['structurallyImpossible']['push'])
 def test_bad_distribution_input(self):
  for z,lo,hi,t in [(np.array([float('nan')]),0,0,1),(np.zeros(2),0,0,1),(np.zeros(2),0,1,0),(np.zeros(2),0,1,True)]:
   with self.assertRaises(h.ContractError):h.DiscreteHazard(z,lo,hi,t)

class RuntimeTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.model=h.HazardTotalsDiagnostic();m=cls.model.manifest
  cls.goldens=json.loads(h.checked_asset(m['goldens']['file'],m['goldens']['sha256']))['rows']
 def packet(self):return copy.deepcopy(self.goldens[0]['packet'])
 def calculate(self,p=None,**kwargs):
  p=self.packet() if p is None else p
  return self.model.predict(p,expected_match_id=p['matchId'],computed_at=AT,**kwargs)
 def test_fifteen_train_checkpoint_features_and_full_domain_logit_parity(self):
  self.assertEqual(len(self.goldens),15)
  for golden in self.goldens:
   for variant in ('state6','draft1006'):
    out=self.calculate(golden['packet'],variant=variant)
    self.assertEqual(out['featureVectorSha256'],golden['features'][variant])
    for target in ('kills','duration'):
     expected=golden['outputs'][f'{target}-{variant}'];actual=out['totals'][target]
     self.assertEqual(actual['rawLogitsSha256'],expected['rawLogitsSha256'])
     self.assertEqual(actual['calibratedRemainingQuantiles'],expected['remainingQuantiles'])
     self.assertAlmostEqual(actual['tailProbability'],expected['tailProbability'],places=14)
 def test_selected_state_does_not_require_unconsumed_draft(self):
  p=self.packet();del p['players'];out=self.calculate(p)
  self.assertEqual(len(out['featureVector']),6);self.assertNotIn('players',out['observedInput'])
  self.assertTrue(all(x['selectedByValidation'] for x in out['totals'].values()))
  with self.assertRaisesRegex(h.ContractError,'draft_incomplete'):self.calculate(p,variant='draft1006')
 def test_current_final_fields_cannot_change_features_or_prediction(self):
  p=self.packet();a=self.calculate(p,variant='draft1006')
  p.update({'radiant_win':True,'duration':9000,'radiant_score_final':300,'futureGold':1e9,'replayEvents':[{'time':9000}]})
  self.assertEqual(a,self.calculate(p,variant='draft1006'))
 def test_draft_sort_invariance_and_side_sensitive_features(self):
  p=self.packet();a=self.calculate(p,variant='draft1006');p['players'].reverse()
  self.assertEqual(a,self.calculate(p,variant='draft1006'))
  for x in p['players']:x['team']=1-x['team']
  self.assertNotEqual(a['featureVectorSha256'],self.calculate(p,variant='draft1006')['featureVectorSha256'])
 def test_malformed_observed_inputs_and_uncovered_clocks_refuse(self):
  for key,value in [('gameTimeSec',0),('gameTimeSec',299),('gameTimeSec',4800),('gameTimeSec',900.0),('radiantScore',None),('direScore',-1),('phase','finished'),('phase','post_draft')]:
   p=self.packet();p[key]=value
   with self.assertRaises(h.ContractError):self.calculate(p)
  with self.assertRaisesRegex(h.ContractError,'map_identity'):self.model.predict(self.packet(),expected_match_id=1,computed_at=AT)
 def test_state_and_grid_update_9_45_62_minutes(self):
  results=[]
  for minute,score in [(9,7),(45,55),(62,97)]:
   p=self.packet();p['gameTimeSec']=60*minute;p['radiantScore']=score;p['direScore']=score//2
   out=self.calculate(p,lines=[{'target':'duration','line':60*minute,'unit':'seconds','settlement':'exact_seconds'}])
   q=out['totals']['duration']['calibratedFinalQuantiles']
   self.assertTrue(all(v is None or v>60*minute for v in q))
   self.assertEqual(out['lineDiagnostics'][0]['basis'],'observed_lower_bound')
   self.assertEqual(out['lineDiagnostics'][0]['calibrated']['probabilities']['pOver'],1.)
   results.append(out['featureVectorSha256'])
  self.assertEqual(len(set(results)),3)
 def test_exact_integer_push_half_zero_and_probability_sums(self):
  p=self.packet();current=p['radiantScore']+p['direScore']
  lines=[{'target':'kills','line':current+i,'unit':'kills'} for i in (0,1,1.5,10,120,120.5,121)]
  out=self.calculate(p,lines=lines)
  for row in out['lineDiagnostics'][:6]:
   for label in ('raw','calibrated'):self.assertAlmostEqual(sum(row[label]['probabilities'].values()),1.,places=10)
  self.assertGreater(out['lineDiagnostics'][1]['calibrated']['probabilities']['pPush'],0.)
  self.assertEqual(out['lineDiagnostics'][2]['calibrated']['probabilities']['pPush'],0.)
  self.assertFalse(out['lineDiagnostics'][6]['available'])
 def test_units_and_unknown_bookmaker_settlement_refuse(self):
  bad=[None,{'target':[]},{'target':'duration','line':40,'unit':'minutes'},
       {'target':'duration','line':2400,'unit':'seconds'}, {'target':'kills','line':20.25,'unit':'kills'},
       {'target':'kills','line':float('nan'),'unit':'kills'},{'target':'kills','line':True,'unit':'kills'},
       {'target':'duration','line':2400.5,'unit':'seconds','settlement':'exact_seconds'}]
  out=self.calculate(lines=bad)
  self.assertTrue(all(not x['available'] and x['calibrated'] is None for x in out['lineDiagnostics']))
  json.dumps(out,allow_nan=False)
 def test_receipt_and_quality_not_invented(self):
  out=self.calculate(variant='draft1006')
  self.assertTrue(out['diagnosticOnly']);self.assertFalse(out['originalLiveReceiptVerified']);self.assertIsNone(out['publicProbabilities'])
  self.assertTrue(all(out[k] is False for k in h.GATES));self.assertTrue(all(not v['selectedByValidation'] for v in out['totals'].values()))
  self.assertEqual(out['responseSha256'],h.canonical_hash({k:v for k,v in out.items() if k!='responseSha256'}))
 def test_limits_computation_timestamp_and_artifact_guard(self):
  with self.assertRaises(h.ContractError):self.calculate(lines=[{}]*129)
  with self.assertRaises(h.ContractError):self.model.predict(self.packet(),expected_match_id=self.packet()['matchId'],computed_at='2026-01-01')
  with self.assertRaisesRegex(h.ContractError,'asset_hash'):h.checked_asset('MANIFEST.json','0'*64)
  with self.assertRaises(h.ContractError):h.checked_asset('../MANIFEST.json','0'*64)
  with patch.object(h,'MANIFEST_SHA256','0'*64):
   with self.assertRaises(h.ContractError):h.HazardTotalsDiagnostic()

if __name__=='__main__':unittest.main()
