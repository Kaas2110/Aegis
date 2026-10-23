"""Fixture-only shadow feature parity and availability checks; no I/O."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import unittest

from .causal_dataset import BASE_NAMES, CONTRACT, DAY, DRAFT_NAMES, prematch_rows
from .prematch_snapshot import build_prematch_snapshot, timestamp
from .test_causal_dataset import START, match


def target(match_id=99, as_of=START + 2000, **changes):
    fixture = match(match_id, as_of)
    fixture.update(draftKnownAt=as_of, rosterKnownAt=as_of)
    fixture.update(changes)
    return fixture


def build(history, fixture=None, as_of=START + 2000):
    return build_prematch_snapshot(history, fixture or target(as_of=as_of), as_of)


class HistoricalParityTests(unittest.TestCase):
    def test_all_views_equal_batch_with_concurrent_and_series_matches(self):
        matches = [match(1, duration=3000, series_id=42),
                   match(2, START + 100, radiant_win=False, series_id=42),
                   match(3, START + 1001, series_id=42),
                   match(4, START + 4000, series_id=43)]
        rows = prematch_rows(matches)
        for raw, expected in zip(matches, rows):
            fixture = target(raw['match_id'], raw['start_time'], **{
                k: v for k, v in raw.items() if k not in ('match_id', 'start_time')})
            actual = build(matches, fixture, raw['start_time'])
            for view in ('base', 'draft', 'roster'):
                self.assertEqual(actual['features'][view], expected[view])
            self.assertEqual(actual['metadata']['featuresVersion'], CONTRACT)
            self.assertEqual(actual['metadata']['historyCoverage']['latestOutcomeAvailableAt'],
                             expected['latest_feature_outcome'] or None)

    def test_partial_archived_player_slots_keep_same_batch_contributions(self):
        history = [match(1, radiant_account_ids=[101, None, 0, 104, 105], dire_account_ids=None)]
        fixture = target()
        expected = prematch_rows(history + [fixture])[-1]
        actual = build(history, fixture)
        for view in ('base', 'draft', 'roster'):
            self.assertEqual(actual['features'][view], expected[view])

    def test_as_of_not_future_planned_or_actual_start_controls_recency(self):
        history = [match(1)]
        expected = prematch_rows(history + [target()])[-1]
        fixture = target(start_time=START + 200 * DAY, plannedStartAt=START + 300 * DAY,
                         duration=999999, radiant_win=False, radiant_score=9999)
        actual = build(history, fixture)
        self.assertEqual(actual['features']['base'], expected['base'])
        self.assertEqual(actual['metadata']['plannedStartAt'], START + 300 * DAY)
        self.assertEqual(actual['metadata']['asOfUnix'], START + 2000)

    def test_reverse_order_and_input_immutability(self):
        history = [match(1, duration=3000), match(2, START + 100), match(3, START + 1000)]
        untouched, fixture = deepcopy(history), target()
        fixture_copy = deepcopy(fixture)
        self.assertEqual(build(history, fixture), build(list(reversed(history)), fixture))
        self.assertEqual(history, untouched)
        self.assertEqual(fixture, fixture_copy)

    def test_duplicate_payload_does_not_double_count_and_conflict_fails_closed(self):
        original = match(1, receivedAt=START + 1000)
        repeated = {**original, 'receivedAt': START + 1100}
        single = build([original])
        duplicate = build([repeated, original])
        self.assertEqual(single['features'], duplicate['features'])
        self.assertEqual(duplicate['metadata']['historyCoverage']['usedOutcomes'], 1)
        self.assertEqual(duplicate['metadata']['historyCoverage']['excludedRows']['duplicate_payload'], 1)
        conflict = {**repeated, 'radiant_win': False}
        actual = build([original, conflict])
        self.assertEqual(actual['features'], build([])['features'])
        self.assertEqual(actual['metadata']['historyCoverage']['excludedRows']['conflicting_available_revisions'], 2)


class ObservedAvailabilityTests(unittest.TestCase):
    def test_real_received_at_replaces_reconstructed_delay_and_is_strict(self):
        history = [match(1, receivedAt=START + 650)]  # end=600; observed before end+300
        equal = build(history, target(as_of=START + 650), START + 650)
        after = build(history, target(as_of=START + 651), START + 651)
        self.assertEqual(equal['metadata']['historyCoverage']['usedOutcomes'], 0)
        self.assertEqual(after['metadata']['historyCoverage']['usedOutcomes'], 1)
        self.assertEqual(after['metadata']['historyAvailability'], 'observed')
        self.assertEqual(after['metadata']['historyCoverage']['latestOutcomeAvailableAt'], START + 650)

    def test_invalid_explicit_received_at_never_falls_back(self):
        for value in (None, False, '', 'bad', float('nan'), START + 599,
                      datetime.fromtimestamp(START + 1000)):
            actual = build([match(1, receivedAt=value)])
            self.assertEqual(actual['metadata']['historyCoverage']['usedOutcomes'], 0, repr(value))
            self.assertEqual(actual['metadata']['historyCoverage']['reconstructedOutcomes'], 0)
        conflicting_alias = match(1, receivedAt=START + 1000, received_at=START + 1100)
        self.assertEqual(build([conflicting_alias])['metadata']['historyCoverage']['usedOutcomes'], 0)

    def test_archived_fallback_and_mixed_provenance_are_explicit(self):
        archive = match(1)
        actual = build([archive])
        self.assertEqual(actual['metadata']['historyAvailability'], 'reconstructed')
        self.assertEqual(actual['metadata']['historyCoverage']['latestOutcomeAvailableAt'], START + 900)
        self.assertEqual(actual['metadata']['historyCoverage']['historicalFeatureAvailability']['draft_reconstructed'], 1)
        mixed = build([archive, match(2, START + 100, receivedAt=START + 1100)])
        self.assertEqual(mixed['metadata']['historyAvailability'], 'mixed')
        self.assertEqual(mixed['metadata']['historyCoverage']['observedOutcomes'], 1)
        self.assertEqual(mixed['metadata']['historyCoverage']['reconstructedOutcomes'], 1)

    def test_future_arrival_and_revision_perturbations_cannot_change_features(self):
        first = match(1, receivedAt=START + 1000)
        future_revision = match(1, receivedAt=START + 3000, radiant_win=False, radiant_score=500)
        future_match = match(2, START + 10000, radiant_win=False)
        original = build([first])
        changed = build([future_revision, future_match, first])
        self.assertEqual(original['features'], changed['features'])
        self.assertEqual(changed['metadata']['historyCoverage']['usedOutcomes'], 1)

    def test_concurrent_unfinished_and_delayed_games_do_not_update_state(self):
        history = [match(1, duration=3000),
                   match(2, START + 100, receivedAt=START + 3000, radiant_win=False)]
        changed = deepcopy(history)
        changed[0]['radiant_win'], changed[0]['radiant_score'] = False, 999
        changed[1]['radiant_win'] = True
        self.assertEqual(build(history)['features'], build(changed)['features'])
        self.assertEqual(build(history)['metadata']['historyCoverage']['usedOutcomes'], 0)

    def test_received_order_not_start_order_controls_elo(self):
        early_long = match(1, duration=1000, receivedAt=START + 1800)
        later_short = match(2, START + 100, receivedAt=START + 1000, radiant_win=False)
        original = build([early_long, later_short])
        changed = build([{**early_long, 'receivedAt': START + 1200},
                         {**later_short, 'receivedAt': START + 1800}])
        self.assertNotEqual(original['features']['base'][0], changed['features']['base'][0])
        self.assertEqual(original, build([later_short, early_long]))

    def test_late_or_invalid_historical_enrichment_is_not_backdated(self):
        for known in (START + 950, None, 'bad'):
            actual = build([match(1, draftKnownAt=known)])  # archived outcome available=900
            self.assertEqual(actual['metadata']['historyCoverage']['usedOutcomes'], 1)
            self.assertGreater(actual['features']['base'][0], 0)
            index = len(BASE_NAMES) + DRAFT_NAMES.index('hero_history_min')
            self.assertEqual(actual['features']['draft'][index], 0)
            reasons = actual['metadata']['historyCoverage']['historicalFeatureAvailability']
            expected = 'draft_late_enrichment_omitted' if known == START + 950 else 'draft_invalid_known_at'
            self.assertEqual(reasons[expected], 1)


class TargetAvailabilityTests(unittest.TestCase):
    def test_target_draft_and_roster_require_valid_known_at(self):
        fixture = target()
        del fixture['draftKnownAt']
        self.assertEqual(build([], fixture)['availableViews'], ['base'])
        for value in (None, False, 'bad', START + 2001):
            actual = build([], target(draftKnownAt=value))
            self.assertEqual(actual['availableViews'], ['base'])
            self.assertIn('draft_unavailable', actual['unavailableReasons']['roster'])
        actual = build([], target(rosterKnownAt=START + 2001))
        self.assertEqual(actual['availableViews'], ['base', 'draft'])
        self.assertEqual(build([])['availableViews'], ['base', 'draft', 'roster'])

    def test_unknown_teams_block_and_unseen_positive_teams_have_explicit_zero_coverage(self):
        for value in (None, 0, False, '1', {}, []):
            actual = build([], target(radiant_team_id=value))
            self.assertEqual(actual['availableViews'], [])
        unseen = build([], target(radiant_team_id=999, dire_team_id=1000))
        self.assertEqual(unseen['features']['base'][1], .5)
        self.assertEqual(unseen['metadata']['historyCoverage']['teams']['radiant']['maps180d'], 0)
        self.assertEqual(build([], target(teamsKnownAt=START + 2001))['availableViews'], [])

    def test_incomplete_or_invalid_draft_accounts_do_not_crash_or_get_imputed(self):
        for picks in ([1, 2], [True, 2, 3, 4, 5], [[1], 2, 3, 4, 5], [1, 1, 3, 4, 5]):
            self.assertEqual(build([], target(radiant_picks=picks))['availableViews'], ['base'])
        for accounts in ([1, 2], [True, 102, 103, 104, 105], [{}, 102, 103, 104, 105], [101] * 5):
            self.assertEqual(build([], target(radiant_account_ids=accounts))['availableViews'], ['base', 'draft'])

    def test_series_boundary_uses_only_available_prior_maps_and_target_never_updates(self):
        fixture = target(series_id=7)
        history = [match(1, series_id=7), match(2, START + 1500, series_id=7), fixture]
        actual = build(history, fixture)
        x = dict(zip(BASE_NAMES, actual['features']['base']))
        self.assertEqual(x['series_map_index'], 1)
        self.assertEqual(x['series_score_diff'], 1)
        other = build(history, {**fixture, 'series_id': 8})
        self.assertEqual(other['features']['base'][BASE_NAMES.index('series_map_index')], 0)
        unknown = build(history, {**fixture, 'seriesKnownAt': START + 2001})
        self.assertEqual(unknown['features']['base'][BASE_NAMES.index('series_map_index')], 0)
        self.assertEqual(actual['metadata']['historyCoverage']['excludedRows']['target_match'], 1)

    def test_json_metadata_names_and_no_serving_flags(self):
        actual = build([match(1)])
        json.dumps(actual, allow_nan=False)
        for view, vector in actual['features'].items():
            self.assertEqual(len(vector), len(actual['featureNames'][view]))
        self.assertEqual([len(actual['features'][v]) for v in ('base', 'draft', 'roster')], [16, 22, 27])
        self.assertTrue(actual['metadata']['shadowOnly'])
        self.assertFalse(actual['metadata']['eligibleForServing'])
        self.assertFalse(actual['metadata']['eligibleForPromotion'])

    def test_timestamp_contract_and_bad_prediction_clock(self):
        iso = datetime.fromtimestamp(START, timezone.utc).isoformat()
        self.assertEqual(timestamp(iso), START)
        self.assertEqual(timestamp(datetime.fromtimestamp(START, timezone.utc)), START)
        for value in (False, 0, -1, float('inf'), 1e300, '2026-10-03T10:00:00'):
            self.assertIsNone(timestamp(value))
            with self.assertRaises(ValueError):
                build_prematch_snapshot([], target(), value)


if __name__ == '__main__':
    unittest.main()
