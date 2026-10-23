import copy,unittest
import test_shadow_hazard_runtime as base

class ExpandedRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.model=base.research.HazardTotalsDiagnostic()
    runtime=base.RuntimeTests.runtime
    def test_incomplete_unknown_duplicate_and_out_of_schema_draft_refuses_without_fallback(self):
        variants=[]
        b=base.body();b['current']['availability']['draftComplete']=False;variants.append(b)
        b=base.body();b['current']['input']['players']=[];variants.append(b)
        for key,value in [('heroId',None),('heroId',251),('heroId',True),('heroId',2),('team',None),('team',1),('team',True)]:
            b=base.body();b['current']['input']['players'][0][key]=value;variants.append(b)
        for b in variants:
            out=self.runtime(loader=lambda:self.fail('no model or compact fallback permitted')).predict(b)
            self.assertEqual(out['status'],'unavailable');self.assertIsNone(out['diagnostic'])
    def test_full_hero_vector_matters_and_roster_order_does_not(self):
        r=self.runtime();b=base.body();a=r.predict(b)
        self.assertEqual(a['candidateOrigin'],'user_requested_expanded')
        self.assertIs(a['selectedByValidation'],False)
        self.assertEqual(len(a['diagnostic']['featureVector']),1006)
        self.assertTrue(all(t['variant']=='draft1006' and not t['selectedByValidation'] for t in a['diagnostic']['totals'].values()))
        b['current']['input']['players'].reverse()
        same=r.predict(b)
        self.assertEqual(same['diagnostic'],a['diagnostic'])
        b['current']['input']['players'][0]['heroId']=101
        changed=r.predict(b)
        self.assertNotEqual(changed['diagnostic']['featureVectorSha256'],a['diagnostic']['featureVectorSha256'])
        self.assertNotEqual(changed['diagnostic']['observedInputSha256'],a['diagnostic']['observedInputSha256'])
    def test_old_selection_stays_unchanged_even_when_expanded_is_used(self):
        out=self.runtime().predict(base.body())
        self.assertEqual(self.model.manifest['selectedVariants'],{'kills':'state6','duration':'state6'})
        self.assertTrue(all(not v['selectedByValidation'] for v in out['diagnostic']['totals'].values()))

if __name__=='__main__':unittest.main()
