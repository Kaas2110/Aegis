"""Pure fixtures for prospective evidence/time/phase evaluation, no provider calls or fits."""
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
try:
    from . import prospective_journal as p
except ImportError:
    import prospective_journal as p

BASE = 1791100000


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def fixture(mid=1, game=295, received=None, producer='live_winner', model='a', probability=.8, label=True):
    received = BASE+game+10 if received is None else received
    players=[{'heroId': i+1, 'accountId': i+100, 'team':0 if i<5 else 1, 'providerTeamSlot':i%5} for i in range(10)]
    packet={'matchId':mid,'radiantTeamId':10,'direTeamId':20,'leagueId':5,'gameTimeSec':game,
            'radiantScore':3,'direScore':2,'radiantLead':1000,'players':players,'providerDelayRaw':900}
    phase='live' if game>=0 else 'post_draft'
    obs={'id':f'o{mid}-{game}-{received}','match_id':mid,'snapshot_id':None,'received_at':iso(received),'recorded_at':iso(received+.1),
         'game_time_sec':game,'phase':phase,'input_hash':p.digest(p.json_bytes(packet)),'schema_hash':p.OBSERVATION_SCHEMA_V2,'input':packet,
         'quality_reasons':[],'availability':{'draftComplete':True,'outcomeKnownAtCapture':False}}
    evidence={'modelHash':model*64,'featureSchemaHash':p.feature_schema_hash(['prior','game_min']),
              'featureNames':['prior','game_min'],'featureVector':[.5,game/60]}
    pred={'id':obs['id']+'-'+producer+'-'+model,'observation_id':obs['id'],'producer':producer,'market':'map_winner',
          'phase':'pregame_model_during_live' if producer=='prematch_context' and phase=='live' else phase,
          'status':'predicted','reason':None,'predicted_at':iso(received+1),'model_version':'version1','evidence':evidence,'output':{'radiantWinProbability':probability}}
    outcome={'id':'label'+str(mid),'match_id':mid,'recorded_at':iso(BASE+4000),'source':'local_pro_matches','evidence_hash':'c'*64,
             'outcome':{'matchId':mid,'radiantTeamId':10,'direTeamId':20,'radiantWin':label,'durationSec':3000,'startTime':BASE,
                        'seriesId':mid,'seriesType':1,'radiantScore':None,'direScore':None}}
    return obs,pred,outcome


def run(obs,preds,labels,cutoff=BASE+5000):
    return p.evaluate(obs,preds,labels,cutoff)


def count(report):
    return sum(g['aggregate_equal_maps']['frames'] for g in report['groups'].values())


class ProspectiveJournalTests(unittest.TestCase):
    def v3(self, **kwargs):
        o,q,l=fixture(**kwargs)
        received=p.timestamp(o['received_at']);recorded=p.timestamp(o['recorded_at'])
        o['schema_hash']=p.OBSERVATION_SCHEMA_V3
        o['availability']['liveDataQuality']={'eligibleForObservedStatePrediction':True,'reason':None,
            'receivedAt':o['received_at'],'lastStateChangeReceivedAt':o['received_at'],
            'stateAgeSeconds':recorded-received,'declaredBroadcastDelaySeconds':120,
            'measuredEndToEndLatencySeconds':None,'eventLatencyVerified':False,'meetsVerifiedLiveLatencyPolicy':False}
        o['input']['providerDelayRaw']=120
        return o,q,l

    def test_v2_descriptive_results_are_explicitly_unverified_not_95_claim(self):
        o,q,l=fixture();r,s=run([o],[q],[l]);g=next(iter(r['groups'].values()))
        self.assertEqual(count(r),1)
        self.assertEqual(g['identity']['stateQuality'],'legacy_unverified')
        self.assertEqual(g['aggregate_equal_maps']['verified_latency_eligible_frames'],0)
        self.assertFalse(g['aggregate_equal_maps']['accuracy_95_percent_claim'])

    def test_v3_supported_and_quality_exported_without_claiming_event_latency(self):
        o,q,l=self.v3();r,s=run([o],[q],[l]);g=next(iter(r['groups'].values()));row=next(iter(s.values()))[0]
        self.assertEqual(count(r),1)
        self.assertEqual(g['identity']['stateQuality'],'eligible_observed_state')
        self.assertEqual(g['identity']['latencyQuality'],'unmeasured_or_unverified')
        self.assertIsNone(row['liveDataQuality']['measuredEndToEndLatencySeconds'])
        self.assertFalse(row['verifiedLatencyEligible'])

    def test_v3_stale_or_missing_quality_excluded(self):
        o,q,l=self.v3();o['availability']['liveDataQuality']['eligibleForObservedStatePrediction']=False
        o['availability']['liveDataQuality']['reason']='upstream_state_not_progressing'
        r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        self.assertEqual(r['observation_exclusions']['v3_state_ineligible:upstream_state_not_progressing'],1)
        del o['availability']['liveDataQuality'];r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        self.assertEqual(r['observation_exclusions']['missing_v3_state_quality'],1)

    def test_new_receipt_cannot_hide_old_v3_state_or_excess_broadcast_delay(self):
        o,q,l=self.v3();quality=o['availability']['liveDataQuality']
        quality['lastStateChangeReceivedAt']=iso(p.timestamp(o['received_at'])-200)
        quality['stateAgeSeconds']=200.1
        r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        o,q,l=self.v3();o['availability']['liveDataQuality']['declaredBroadcastDelaySeconds']=900
        r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_state_can_expire_between_capture_and_prediction(self):
        o,q,l=self.v3();quality=o['availability']['liveDataQuality']
        quality['lastStateChangeReceivedAt']=iso(p.timestamp(o['received_at'])-179.5)
        quality['stateAgeSeconds']=179.6
        r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        self.assertEqual(r['prediction_exclusions']['observed_state_expired_before_prediction'],1)

    def test_v3_future_or_mismatched_clock_evidence_rejected(self):
        for field,value in [('lastStateChangeReceivedAt',iso(BASE+9999)),('receivedAt',iso(BASE)),('stateAgeSeconds',False)]:
            o,q,l=self.v3();o['availability']['liveDataQuality'][field]=value
            r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_unknown_schema_is_explicitly_unsupported_not_silently_trusted(self):
        o,q,l=self.v3();o['schema_hash']='e'*64;r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        self.assertEqual(r['observation_exclusions']['unsupported_observation_schema'],1)

    def test_claimed_latency_verification_without_measured_latency_does_not_pass(self):
        o,q,l=self.v3();quality=o['availability']['liveDataQuality']
        quality['eventLatencyVerified']=True;quality['meetsVerifiedLiveLatencyPolicy']=True
        r,s=run([o],[q],[l]);self.assertFalse(next(iter(s.values()))[0]['verifiedLatencyEligible'])

    def test_valid_zero_totals_still_evaluates_winner(self):
        o,q,l=fixture();report,selected=run([o],[q],[l])
        self.assertEqual(count(report),1)
        g=next(iter(report['groups'].values()));self.assertAlmostEqual(g['minutes']['5']['metrics']['brier'],.04)
        self.assertEqual(g['aggregate_equal_maps']['status'],'insufficient_sample_for_significance')
        self.assertEqual(next(iter(selected.values()))[0]['providerDelayRaw'],900)

    def test_no_labels_is_explicit_no_samples(self):
        o,q,l=fixture();r,_=run([o],[q],[])
        self.assertEqual(r['status'],'no_resolved_samples');self.assertEqual(len(r['groups']),1)

    def test_latest_label_revision_not_older(self):
        o,q,l=fixture();new=copy.deepcopy(l);new['id']='revision';new['recorded_at']=iso(BASE+4100);new['outcome']['radiantWin']=False
        r,selected=run([o],[q],[l,new]);row=next(iter(selected.values()))[0]
        self.assertEqual(row['winner'],0);self.assertEqual(row['outcome_revision_id'],'revision')

    def test_future_outcome_revision_excluded(self):
        o,q,l=fixture();future=copy.deepcopy(l);future['recorded_at']=iso(BASE+6000);future['outcome']['radiantWin']=False
        r,s=run([o],[q],[l,future]);self.assertEqual(next(iter(s.values()))[0]['winner'],1)
        self.assertEqual(r['outcome_exclusions']['outcome_revision_after_export_cutoff'],1)

    def test_conflicting_equal_time_revisions_not_arbitrarily_chosen(self):
        o,q,l=fixture();other=copy.deepcopy(l);other['id']='z';other['outcome']['radiantWin']=False
        r,_=run([o],[q],[l,other]);self.assertEqual(count(r),0)

    def test_known_or_unchecked_outcome_at_capture_rejected(self):
        for known in (True,None,0,'false'):
            o,q,l=fixture();o['availability']['outcomeKnownAtCapture']=known
            r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_previously_recorded_label_rejects_even_false_flag(self):
        o,q,l=fixture();l['recorded_at']=iso(BASE+300)
        r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        self.assertEqual(r['prediction_exclusions']['outcome_recorded_before_prediction'],1)

    def test_outcome_ingested_between_capture_and_inference_rejected(self):
        o,q,l=fixture();l['outcome']['localIngestedAt']=iso(BASE+305.5)
        r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        self.assertEqual(r['prediction_exclusions']['outcome_conservatively_known_before_prediction'],1)

    def test_outcome_old_ingest_is_conservative_exclusion_not_exact_availability(self):
        o,q,l=fixture();l['outcome']['localIngestedAt']=iso(BASE-100)
        r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_outcome_invalid_ingest_timestamp_not_ignored(self):
        for bad in ('not-a-date',iso(BASE+6000)):
            o,q,l=fixture();l['outcome']['localIngestedAt']=bad;r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_raw_provider_timestamps_preserved_not_used_as_verified_latency(self):
        o,q,l=fixture();o['input']['providerLastUpdateRaw']=0;o['input']['providerActivateTimeRaw']=BASE
        r,s=run([o],[q],[l]);row=next(iter(s.values()))[0]
        self.assertEqual(row['providerTimeFieldsRaw']['providerLastUpdateRaw'],0)
        self.assertEqual(row['providerDelayRaw'],900)

    def test_future_frame_never_used_at_earlier_checkpoint(self):
        o,q,l=fixture(game=301);r,s=run([o],[q],[l]);self.assertEqual(count(r),0)
        self.assertEqual(next(iter(r['groups'].values()))['coverage']['5']['no_past_prediction'],1)
        self.assertEqual(next(iter(r['groups'].values()))['minutes']['5']['status'],'no_resolved_samples')

    def test_label_clock_ending_in_future_of_recording_rejected(self):
        o,q,l=fixture();l['outcome']['durationSec']=4100;r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        self.assertEqual(r['prediction_exclusions']['outcome_recorded_before_its_end_time'],1)

    def test_boolean_match_id_cannot_pass_integer_equality(self):
        o,q,l=fixture();o['input']['matchId']=True;r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_last_past_frame_and_game_age_limit(self):
        a,b,l=fixture(game=180);c,d,_=fixture(game=295)
        r,s=run([a,c],[b,d],[l]);rows=next(iter(s.values()));self.assertEqual(len(rows),1);self.assertEqual(rows[0]['game_time_sec'],295)
        a,b,l=fixture(game=179);r,_=run([a],[b],[l]);self.assertEqual(count(r),0)

    def test_receipt_age_not_game_age(self):
        o,q,l=fixture();q['predicted_at']=iso(BASE+500)
        r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        self.assertEqual(r['prediction_exclusions']['stale_receipt_to_prediction'],1)

    def test_prediction_before_receipt_or_recorded_rejected(self):
        for t in (BASE+304,BASE+305.05):
            o,q,l=fixture();q['predicted_at']=iso(t);r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_future_observation_prediction_rejected(self):
        o,q,l=fixture(received=BASE+6000);r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_naive_timestamp_rejected(self):
        o,q,l=fixture();o['received_at']='2026-10-04T00:00:00';r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_input_outer_clock_mismatch_rejected(self):
        o,q,l=fixture();o['input']['gameTimeSec']=290;r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_input_outer_match_mismatch_rejected(self):
        o,q,l=fixture();o['input']['matchId']=2;r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_outcome_cannot_fill_missing_team_or_reverse_orientation(self):
        for field,value in [('radiantTeamId',None),('radiantTeamId',20),('direTeamId',10)]:
            o,q,l=fixture();o['input'][field]=value;r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        o,q,l=fixture();l['outcome']['radiantTeamId']=99;r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_final_known_score_can_reject_but_missing_score_not_imputed(self):
        o,q,l=fixture();l['outcome']['radiantScore']=1;r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_regressing_clock_and_score_rejected(self):
        a,b,l=fixture(game=290);c,d,_=fixture(game=285,received=BASE+320)
        r,s=run([a,c],[b,d],[l]);self.assertEqual(r['observation_exclusions']['regressing_game_clock_or_score'],1)
        c,d,_=fixture(game=295);c['input']['radiantScore']=1
        r,s=run([a,c],[b,d],[l]);self.assertEqual(r['observation_exclusions']['regressing_game_clock_or_score'],1)

    def test_duplicate_packet_and_prediction_dropped(self):
        o,q,l=fixture();dup=copy.deepcopy(o);dup['id']='other';dup['received_at']=iso(BASE+320);dup['recorded_at']=iso(BASE+320.1)
        r,s=run([o,dup],[q,copy.deepcopy(q)],[l]);self.assertEqual(count(r),1)
        self.assertEqual(r['observation_exclusions']['duplicate_provider_packet'],1)
        self.assertEqual(r['prediction_exclusions']['duplicate_or_missing_prediction_id'],1)

    def test_missing_or_invalid_evidence_and_vector_rejected(self):
        for mutate in (lambda q:q.update(evidence=None),lambda q:q['evidence'].update(modelHash='bad'),lambda q:q['evidence'].update(featureVector=[.5]),
                       lambda q:q['evidence'].update(featureVector=[float('nan'),1]),lambda q:q['evidence'].update(featureVector=[True,1]),
                       lambda q:q['evidence'].update(featureSchemaHash='d'*64)):
            o,q,l=fixture();mutate(q);r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_invalid_probability_rejected(self):
        for value in (None,True,float('nan'),1.1,-.1):
            o,q,l=fixture(probability=value);r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_phases_not_merged_or_misnamed(self):
        o,a,l=fixture();_,b,_=fixture(producer='prematch_context')
        r,s=run([o],[a,b],[l]);self.assertEqual(len(r['groups']),2);self.assertEqual(r['paired_comparisons'],[])
        b['phase']='post_draft';r,_=run([o],[b],[l]);self.assertEqual(count(r),0)

    def test_postdraft_requires_real_draft_and_negative_clock(self):
        o,q,l=fixture(game=-10,received=BASE-1);r,s=run([o],[q],[l]);self.assertEqual(count(r),1)
        self.assertEqual(next(iter(s.values()))[0]['minute'],'before_start')
        o['input']['players']=[];r,_=run([o],[q],[l]);self.assertEqual(count(r),0)

    def test_pairwise_only_same_map_minute_and_observation(self):
        a,b,l=fixture();_,c,_=fixture(model='d');other,op,ol=fixture(mid=2,model='d')
        r,s=run([a,other],[b,c,op],[l,ol]);comparison=r['paired_comparisons'][0]
        self.assertEqual(comparison['common_frames'],1)
        self.assertEqual(comparison['left_common_only']['maps'],1);self.assertEqual(comparison['right_common_only']['maps'],1)

    def test_same_map_minute_different_observation_not_paired(self):
        a,b,l=fixture(game=290);c,d,_=fixture(game=295,model='d')
        r,s=run([a,c],[b,d],[l]);self.assertEqual(r['paired_comparisons'][0]['common_frames'],0)

    def test_models_grouped_by_artifact_even_same_version(self):
        o,q,l=fixture();_,b,_=fixture(model='d');r,_=run([o],[q,b],[l]);self.assertEqual(len(r['groups']),2)

    def test_unavailable_and_totals_retained_inventory_not_scored(self):
        o,q,l=fixture();q['status']='unavailable';q['reason']='missing_model';r,_=run([o],[q],[l]);self.assertEqual(r['prediction_exclusions']['producer:missing_model'],1)
        q['status']='predicted';q['market']='total_kills';r,_=run([o],[q],[l]);self.assertEqual(count(r),0)
        self.assertEqual(r['prediction_exclusions']['market_not_in_winner_evaluator'],1)

    def test_map_balanced_metric_no_majority_vote(self):
        rows=[{'match_id':1,'group':'s1','known_series':True,'p':1,'winner':0}]*10+[{'match_id':2,'group':'s2','known_series':True,'p':0,'winner':0}]
        self.assertEqual(p.score(rows)['metrics']['accuracy'],.5)

    def test_evaluator_does_not_mutate_raw_inputs(self):
        o,q,l=fixture();raw=copy.deepcopy(([o],[q],[l]));run([o],[q],[l]);self.assertEqual(([o],[q],[l]),raw)

    def test_export_refuses_overwrite_before_any_db_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'existing';path.mkdir();(path/'marker').write_text('preserve')
            with self.assertRaises(FileExistsError):p.export_database(path)
            self.assertEqual((path/'marker').read_text(),'preserve')


if __name__=='__main__':unittest.main()
