"""Admission and game-meaning fixtures; no database, APIs or model fits."""
import copy,json,math,unittest
from pathlib import Path
try:
    from . import feature_availability as a
    from . import feature_availability_derivations as d
except ImportError:
    import feature_availability as a
    import feature_availability_derivations as d

def tiny_catalog(kind='static'):
    field={'phases':['pre_draft','post_draft','live'],'unit':'value','value_kind':'number','sources':['observed'],
           'dependencies':[],'temporal_kind':kind,'max_receipt_age_sec':120 if kind=='dynamic' else None,
           'max_event_age_sec':120 if kind=='dynamic' else None,'definition_version':'v1'}
    return {'fields':{'a':copy.deepcopy(field),'b':copy.deepcopy(field)},'families':{
        'fa':{'phases':['pre_draft','post_draft','live'],'required_fields':['a']},
        'fb':{'phases':['pre_draft','post_draft','live'],'required_fields':['b']}}}

def evidence(value=0):return {'value':value,'unit':'value','source':'observed','available_at':9990,'received_at':9990,'progressed_at':9990,'availability_mode':'observed','event_at':9985,'event_time_verified':True}
def case(i=1,phase='pre_draft',checkpoint='before_start',stratum='s'):
    return {'map_id':i,'series_id':i,'phase':phase,'checkpoint':checkpoint,'stratum':stratum,'decision_at':10000,'fields':{'a':evidence(),'b':evidence(1)}}
def plan(required=None,optional=None,phase='pre_draft',cp='before_start'):
    return {'threshold':.95,'minimum_maps':100,'minimum_series':30,'denominator_origin':'predeclared_supported_opportunities',
            'strata':[{'id':'s','phase':phase,'checkpoint':cp,'required_families':required or ['fa'],'candidate_families':optional or []}]}

class AvailabilityTests(unittest.TestCase):
    def test_zero_is_observed_not_missing(self):self.assertTrue(a.assess_field(case(),'a',tiny_catalog())['timely_available'])
    def test_missing_case_remains_in_denominator(self):
        cases=[case(i) for i in range(1,101)];cases[0]['fields']={};r=a.evaluate(cases,plan(),tiny_catalog(),20)
        self.assertEqual(r['strata']['s']['joint_required']['timely_available']['n_cases'],100)
        self.assertEqual(r['strata']['s']['joint_required']['timely_available']['rate'],.99)
    def test_no_samples_not_pass_even_declared_supported(self):
        r=a.evaluate([],plan(),tiny_catalog(),20);self.assertEqual(r['status'],'not_admitted')
        self.assertEqual(r['strata']['s']['joint_required']['timely_available']['status'],'no_samples')
    def test_small_sample_not_pass(self):
        r=a.evaluate([case()],plan(),tiny_catalog(),20);self.assertFalse(r['strata']['s']['admitted'])
    def test_per_field95_does_not_imply_joint95(self):
        cases=[case(i) for i in range(1,1001)]
        for c in cases[:30]:c['fields']['a']['value']=None
        for c in cases[30:60]:c['fields']['b']['value']=None
        s=a.evaluate(cases,plan(['fa','fb']),tiny_catalog(),40)['strata']['s']
        self.assertTrue(s['fields']['a']['timely_available']['pass']);self.assertTrue(s['fields']['b']['timely_available']['pass'])
        self.assertAlmostEqual(s['joint_required']['timely_available']['rate'],.94);self.assertFalse(s['admitted'])
    def test_95_point_estimate_without_lower_bound_not_pass(self):
        cases=[case(i) for i in range(1,101)]
        for c in cases[:5]:c['fields']['a']['value']=None
        r=a.evaluate(cases,plan(),tiny_catalog(),20);self.assertFalse(r['strata']['s']['admitted'])
    def test_all_available100_independent_maps_can_pass(self):
        r=a.evaluate([case(i) for i in range(1,101)],plan(),tiny_catalog(),20);self.assertTrue(r['strata']['s']['admitted'])
    def test_missing_optional_family_never_masks_required_features(self):
        cases=[case(i) for i in range(1,101)]
        for c in cases:c['fields']['b']['value']=None
        before=copy.deepcopy(cases);r=a.evaluate(cases,plan(optional=['fb']),tiny_catalog(),20)
        self.assertTrue(r['strata']['s']['admitted']);self.assertFalse(r['strata']['s']['families']['fb']['pass']);self.assertEqual(cases,before)
    def test_duplicate_opportunities_cannot_inflate_coverage(self):
        with self.assertRaisesRegex(ValueError,'duplicate'):a.evaluate([case(),case()],plan(),tiny_catalog(),20)
    def test_unverified_series_cannot_establish_independent_evidence(self):
        cases=[case(i) for i in range(1,101)]
        for c in cases:c['series_id']=None
        r=a.evaluate(cases,plan(),tiny_catalog(),20);self.assertFalse(r['strata']['s']['admitted'])
    def test_series_correlation_reduces_certainty(self):
        cases=[case(i) for i in range(1,101)]
        for c in cases:c['series_id']=1
        r=a.evaluate(cases,plan(),tiny_catalog(),20);self.assertEqual(r['strata']['s']['joint_required']['timely_available']['n_series'],1)
        self.assertFalse(r['strata']['s']['admitted'])
    def test_future_available_at_fails(self):
        c=case();c['fields']['a']['available_at']=10001;self.assertFalse(a.assess_field(c,'a',tiny_catalog())['causal_available'])
    def test_future_event_at_fails(self):
        c=case();c['fields']['a']['event_at']=10001;self.assertFalse(a.assess_field(c,'a',tiny_catalog('dynamic'))['timely_available'])
    def test_receipt_and_event_freshness_are_separate(self):
        c=case();c['fields']['a']['event_at']=9000;s=a.assess_field(c,'a',tiny_catalog('dynamic'))
        self.assertTrue(s['receipt_fresh']);self.assertFalse(s['event_fresh']);self.assertFalse(s['timely_available'])
    def test_unknown_event_time_is_unknown_not_automatic_global_mask(self):
        c=case();c['fields']['a']['event_time_verified']=False;s=a.assess_field(c,'a',tiny_catalog('dynamic'))
        self.assertTrue(s['present_valid']);self.assertTrue(s['causal_available']);self.assertIsNone(s['event_fresh']);self.assertFalse(s['timely_available'])
        self.assertEqual(c['fields']['a']['value'],0)
    def test_provider_delay_does_not_fabricate_event_time(self):
        c=case();c['fields']['a']['event_time_verified']=False;c['fields']['a']['providerDelayRaw']=10
        self.assertIsNone(a.assess_field(c,'a',tiny_catalog('dynamic'))['event_fresh'])
    def test_final300_second_source_delivery_boundary(self):
        c=case();c['fields']['a']['event_at']=9690;self.assertTrue(a.assess_field(c,'a',tiny_catalog('dynamic'))['event_fresh'])
        c['fields']['a']['event_at']=9689;self.assertFalse(a.assess_field(c,'a',tiny_catalog('dynamic'))['event_fresh'])
    def test_declared900_fails_and_declared300_does_not_prove_latency(self):
        c=case();c['fields']['a'].update(event_time_verified=False,providerDelayRaw=900)
        self.assertFalse(a.assess_field(c,'a',tiny_catalog('dynamic'))['event_fresh'])
        c['fields']['a']['providerDelayRaw']=300;self.assertIsNone(a.assess_field(c,'a',tiny_catalog('dynamic'))['event_fresh'])
    def test_fresh_repeat_packet_does_not_reset_progression_age(self):
        c=case();c['fields']['a']['progressed_at']=9800;s=a.assess_field(c,'a',tiny_catalog('dynamic'))
        self.assertTrue(s['receipt_fresh']);self.assertTrue(s['event_fresh']);self.assertFalse(s['progression_fresh']);self.assertFalse(s['timely_available'])
    def test_historical_priors_from_old_maps_are_allowed(self):
        c=case();cat=tiny_catalog('historical');c['fields']['a'].update(source_max_completed_at=100,source_max_available_at=500,excludes_target_match=True,target_match_id=1)
        self.assertTrue(a.assess_field(c,'a',cat)['timely_available'])
    def test_current_map_in_historical_prior_not_allowed(self):
        c=case();cat=tiny_catalog('historical');c['fields']['a'].update(source_max_completed_at=100,source_max_available_at=500,excludes_target_match=False,target_match_id=1)
        self.assertFalse(a.assess_field(c,'a',cat)['timely_available'])
    def test_completed_history_cannot_be_received_before_completion(self):
        c=case();cat=tiny_catalog('historical');c['fields']['a'].update(source_max_completed_at=800,source_max_available_at=500,excludes_target_match=True,target_match_id=1)
        self.assertFalse(a.assess_field(c,'a',cat)['timely_available'])
    def test_reconstructed_end_plus300_not_actual_availability(self):
        c=case();c['fields']['a']['availability_mode']='reconstructed';self.assertFalse(a.assess_field(c,'a',tiny_catalog())['timely_available'])
    def test_future_historical_receipt_not_available(self):
        c=case();cat=tiny_catalog('historical');c['fields']['a'].update(source_max_completed_at=100,source_max_available_at=10001,excludes_target_match=True,target_match_id=1)
        self.assertFalse(a.assess_field(c,'a',cat)['timely_available'])
    def test_units_sources_and_nan_are_not_silently_substituted(self):
        for change in ({'unit':'minutes'},{'source':'team_lead_disguised_as_player_gpm'},{'value':float('nan')},{'value':True}):
            c=case();c['fields']['a'].update(change);self.assertFalse(a.assess_field(c,'a',tiny_catalog())['present_valid'])
    def test_derived_requires_causal_dependencies_and_definition(self):
        cat=tiny_catalog();cat['fields']['b'].update(temporal_kind='derived',dependencies=['a']);c=case();c['fields']['b']['definition_version']='v1'
        self.assertTrue(a.assess_field(c,'b',cat)['timely_available']);c['fields']['a']['available_at']=10001
        self.assertFalse(a.assess_field(c,'b',cat)['timely_available'])
    def test_derived_computation_cannot_precede_dependency(self):
        cat=tiny_catalog();cat['fields']['b'].update(temporal_kind='derived',dependencies=['a']);c=case();c['fields']['b'].update(definition_version='v1',available_at=9980)
        self.assertIn('derived_timestamp_before_dependency',a.assess_field(c,'b',cat)['reasons'])
    def test_catalog_cycles_rejected(self):
        cat=tiny_catalog();cat['fields']['a']['dependencies']=['b'];cat['fields']['b']['dependencies']=['a']
        with self.assertRaisesRegex(ValueError,'cyclic'):a.validate_catalog(cat)
    def test_invalid_phase_not_relabelled_postdraft(self):
        c=case(phase='live',checkpoint=5)
        with self.assertRaisesRegex(ValueError,'phase'):a.evaluate([c],plan(),tiny_catalog(),20)
    def test_eighty_plus_tail_keeps_85_90_opportunities(self):
        cases=[case(1,'live',80),case(1,'live',85),case(1,'live',90)]
        s=a.evaluate(cases,plan(phase='live',cp='80+'),tiny_catalog(),20)['strata']['s']
        self.assertEqual(s['joint_required']['timely_available']['n_cases'],3);self.assertEqual(s['joint_required']['timely_available']['n_maps'],1)
    def test_earlier_checkpoint_cannot_enter_tail(self):
        with self.assertRaisesRegex(ValueError,'tail'):a.evaluate([case(1,'live',75)],plan(phase='live',cp='80+'),tiny_catalog(),20)
    def test_failures_must_be_in_declared_denominator(self):
        p=plan();p['denominator_origin']='only_successful_forecasts'
        with self.assertRaisesRegex(ValueError,'denominator'):a.evaluate([],p,tiny_catalog())
    def test_policy_cannot_be_relaxed_to_tiny_sample(self):
        p=plan();p['minimum_maps']=1
        with self.assertRaisesRegex(ValueError,'minimum'):a.evaluate([],p,tiny_catalog())
    def test_actual_catalog_resolves_all_dependencies_and_roles(self):
        cat=json.loads(Path(a.__file__).with_name('feature_catalog_v1.json').read_text(encoding='utf-8'));a.validate_catalog(cat)
        self.assertEqual(cat['fields']['role_probabilities']['value_kind'],'role_probs');self.assertEqual(cat['time_grid']['tail'],'80+')

class GameDerivationTests(unittest.TestCase):
    def measurement(self,value=5000,t=600):return {'metric':'cumulative_earned_gold_since_start','player_id':42,'hero_id':1,'value':value,'game_time_sec':t,'baseline_at_game_start':0}
    def test_gpm_correct_units_and_not_team_lead(self):
        self.assertEqual(d.player_gpm_from_earned(self.measurement(),600)['value'],500)
        m=self.measurement();m['metric']='radiant_lead';self.assertIsNone(d.player_gpm_from_earned(m,600)['value'])
    def test_gpm_needs_baseline_and_current_time(self):
        m=self.measurement();m['baseline_at_game_start']=None;self.assertIsNone(d.player_gpm_from_earned(m,600)['value'])
        self.assertIsNone(d.player_gpm_from_earned(self.measurement(),1200)['value'])
    def test_rolling_rate_needs_same_player_and_earned_measure(self):
        early=self.measurement(2500,300);late=self.measurement();self.assertEqual(d.rolling_player_gpm(early,late)['value'],500)
        late['player_id']=43;self.assertIsNone(d.rolling_player_gpm(early,late)['value'])
    def norm(self,mean=500):return {'hero_id':1,'minute':10,'patch':'7.41e','unit':'gold_per_minute','target_match_id':5,'excludes_target_match':True,'available_at':900,'max_history_completed_at':800,'effective_n':50,'mean':mean,'sd':100}
    def test_gpm_hero_role_minute_mixture_keeps_role_uncertainty(self):
        norms={'1':self.norm(600),'5':self.norm(300)};out=d.contextual_gpm_z(450,1,[.5,0,0,0,.5],10,'7.41e',norms,1000,5)
        self.assertAlmostEqual(out['value'],0);self.assertEqual(out['role_status'],'inferred_distribution')
        self.assertAlmostEqual(out['reference_sd'],math.sqrt(10000+22500))
    def test_norm_patch_future_and_sparse_never_fallback_silently(self):
        for change in ({'patch':'7.41d'},{'available_at':1001},{'effective_n':1},{'excludes_target_match':False}):
            norm=self.norm();norm.update(change)
            self.assertIsNone(d.contextual_gpm_z(500,1,[1,0,0,0,0],10,'7.41e',{'1':norm},1000,5)['value'])
    def test_lane_role_integer_not_position_distribution(self):
        self.assertIsNone(d.contextual_gpm_z(500,1,3,10,'7.41e',{},1000,5)['value'])
    def test_purchases_future_censored_and_not_inventory(self):
        events=[{'item':'bkb','game_time_sec':1200}]
        self.assertIsNone(d.first_purchase_timing('bkb',events,10,20,False)['value'])
        out=d.first_purchase_timing('bkb',events,25,24,True);self.assertEqual(out['value'],4);self.assertFalse(out['current_inventory_or_cooldown_known'])
    def test_absent_purchase_only_if_event_stream_complete(self):
        out=d.first_purchase_timing('bkb',[],25,20,True);self.assertTrue(out['right_censored']);self.assertEqual(out['value'],5)
    def test_tail_model_label_constant_clock_continuous(self):
        self.assertEqual([d.phase_bucket(x*60) for x in (80,85,90,105)],['80+']*4)
        out=d.style_interaction(1,2,3,85);self.assertEqual(out['game_minutes'],85);self.assertEqual(out['value'],6)

if __name__=='__main__':unittest.main()
