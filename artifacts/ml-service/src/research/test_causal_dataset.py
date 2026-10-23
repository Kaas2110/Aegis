"""Fixture-only research checks. No database, provider calls or model training."""
from copy import deepcopy
from datetime import datetime, timezone
import math
import unittest

from .causal_dataset import (DAY, BASE_NAMES, DRAFT_NAMES, LIVE_NAMES, UNSUPPORTED_LIVE_FEATURES,
                             first_blood, fingerprint,
                             live_rows, prematch_rows, split_rows, valid_picks)


START = 1_700_000_000


def match(match_id, start=START, **changes):
    result = {"match_id": match_id, "start_time": start, "duration": 600,
              "radiant_team_id": 1, "dire_team_id": 2, "radiant_win": True,
              "radiant_score": 25, "dire_score": 10, "series_id": match_id,
              "series_type": 1, "league_id": 1,
              "radiant_picks": list(range(1, 6)), "dire_picks": list(range(6, 11)),
              "radiant_account_ids": list(range(101, 106)), "dire_account_ids": list(range(106, 111))}
    result.update(changes)
    return result


def snapshot(snapshot_id, t, arrival, **changes):
    result = {"id": snapshot_id, "match_id": 1, "game_time_sec": t,
              "captured_at": datetime.fromtimestamp(START + arrival, timezone.utc),
              "source": "live", "radiant_lead": 1000, "radiant_score": 1,
              "dire_score": 0, "building_state": (1 << 22) - 1,
              "raw_payload": {"players": [{"team": int(h > 5), "hero_id": h} for h in range(1, 11)]}}
    result.update(changes)
    return result


class FirstBloodTests(unittest.TestCase):
    def evidence(self, slot=128, time=-15, **changes):
        event = {"type": "CHAT_MESSAGE_FIRSTBLOOD", "player_slot": slot,
                 "slot": slot if slot < 128 else slot - 123, "time": time}
        event.update(changes)
        return [event], [{"player_slot": slot, "kills_log": [{"time": time}]}]

    def test_negative_zero_and_side_not_match_winner(self):
        self.assertEqual(first_blood(*self.evidence(time=-15)), 0)
        self.assertEqual(first_blood(*self.evidence(slot=0, time=0)), 1)
        m = match(1, radiant_win=True, first_blood_label=first_blood(*self.evidence()))
        row = prematch_rows([m])[0]
        self.assertEqual((row["winner"], row["first_blood"]), (1, 0))

    def test_rejects_ambiguous_and_malformed_evidence(self):
        objectives, players = self.evidence()
        self.assertIsNone(first_blood(objectives * 2, players))
        self.assertIsNone(first_blood(objectives, players * 2))
        bad_slot, matching_players = self.evidence(slot=128, time=10)
        bad_slot[0]["slot"] = 0
        self.assertIsNone(first_blood(bad_slot, matching_players))
        for value in (None, {}, "not array", [None, 4, []]):
            self.assertIsNone(first_blood(value, players))
            self.assertIsNone(first_blood(objectives, value))
        for slot in (False, True, "128", 127, 133, .5, float("nan")):
            bad = deepcopy(objectives)
            bad[0]["player_slot"] = slot
            self.assertIsNone(first_blood(bad, players))
        for timestamp in (False, True, "-15", float("inf"), float("nan"), None):
            bad = deepcopy(objectives)
            bad[0]["time"] = timestamp
            self.assertIsNone(first_blood(bad, players))

    def test_requires_exact_corresponding_kill(self):
        objectives, players = self.evidence(slot=0, time=0)
        for logs in (None, {}, [{"time": False}], [{"time": "0"}], [{"time": .001}]):
            players[0]["kills_log"] = logs
            self.assertIsNone(first_blood(objectives, players))
        players[0]["kills_log"] = [None, {"time": 0.0}]
        self.assertEqual(first_blood(objectives, players), 1)


class AvailabilityTests(unittest.TestCase):
    def test_concurrent_outcomes_and_exact_availability_boundary(self):
        matches = [match(1), match(2, START + 400), match(3, START + 900), match(4, START + 901)]
        original = prematch_rows(matches)
        changed = deepcopy(matches)
        changed[0]["radiant_win"] = False
        changed[0]["radiant_score"] = 1
        perturbed = prematch_rows(changed)
        for i in (1, 2):
            self.assertEqual(original[i]["base"], perturbed[i]["base"])
            self.assertEqual(original[i]["draft"], perturbed[i]["draft"])
            self.assertEqual(original[i]["roster"], perturbed[i]["roster"])
        self.assertNotEqual(original[3]["base"], perturbed[3]["base"])
        for row in original:
            self.assertLess(row["latest_feature_outcome"], row["start"])

    def test_queue_is_ordered_by_availability_not_match_start(self):
        rows = prematch_rows([match(1, duration=3000), match(2, START + 100, radiant_win=False),
                              match(3, START + 1001)])
        self.assertEqual(rows[-1]["latest_feature_outcome"], START + 1000)
        self.assertLess(rows[-1]["base"][0], 0)  # only the short lost game is known

    def test_future_perturbation_does_not_change_earlier_features(self):
        matches = [match(i + 1, START + i * 4000) for i in range(5)]
        original = prematch_rows(matches)
        changed = deepcopy(matches)
        changed[-1].update(radiant_win=False, duration=4000, radiant_score=1,
                           radiant_picks=[20, 21, 22, 23, 24])
        self.assertEqual(fingerprint(original[:-1]), fingerprint(prematch_rows(changed)[:-1]))

    def test_unknown_negative_series_is_not_a_shared_series(self):
        rows = prematch_rows([match(1, series_id=-1), match(2, START + 1000, series_id=-1)])
        self.assertEqual(rows[1]["base"][BASE_NAMES.index("series_map_index")], 0)
        self.assertEqual(rows[1]["base"][BASE_NAMES.index("series_score_diff")], 0)

    def test_malformed_picks_are_not_a_crash_or_valid_draft(self):
        for picks in ([True, 2, 3, 4, 5], [[1], 2, 3, 4, 5], [1, 1, 3, 4, 5]):
            self.assertFalse(valid_picks(picks, list(range(6, 11))))


class SplitTests(unittest.TestCase):
    def rows(self):
        return [{"match_id": i, "group": f"series:{i}", "start": START + i * 3 * DAY,
                 "label_available": START + i * 3 * DAY + 1000} for i in range(40)]

    def test_group_boundary_purges_entire_series_from_all_four_splits(self):
        rows = self.rows()
        boundary = rows[26]["start"]
        rows.append({"match_id": 101, "group": "series:1", "start": boundary + 100,
                     "label_available": boundary + 1100})
        splits, manifest = split_rows(rows)
        self.assertIn("series:1", manifest["purged_group_ids"])
        assigned = [{r["group"] for r in values} for values in splits.values()]
        self.assertTrue(all("series:1" not in values for values in assigned))
        for i, groups in enumerate(assigned):
            for later in assigned[i + 1:]:
                self.assertTrue(groups.isdisjoint(later))
        values = list(splits.values())
        for earlier, later in zip(values, values[1:]):
            self.assertLess(max(r["label_available"] for r in earlier), min(r["start"] for r in later) - DAY)

    def test_exact_purge_edge_is_excluded(self):
        rows = self.rows()
        rows[25]["label_available"] = rows[26]["start"] - DAY
        _, manifest = split_rows(rows)
        self.assertIn("series:25", manifest["purged_group_ids"])

    def test_small_group_count_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "independent groups"):
            split_rows(self.rows()[:19])

    def test_fixed_boundaries_preserve_same_day_purge_and_group_isolation(self):
        rows = self.rows()
        boundaries = [rows[i]["start"] for i in (20, 27, 33)]
        rows.append({"match_id": 101, "group": "series:1", "start": boundaries[0] + 100,
                     "label_available": boundaries[0] + 1100})
        splits, manifest = split_rows(rows, boundaries=boundaries)
        self.assertEqual(manifest["boundaries_unix"], boundaries)
        self.assertEqual(manifest["purge_seconds"], DAY)
        self.assertEqual(manifest["boundary_selection"], "fixed_calendar_prespecified_from_coverage")
        self.assertIn("series:1", manifest["purged_group_ids"])
        for index, data in enumerate(splits.values()):
            if index < 3:
                self.assertTrue(all(r["label_available"] < boundaries[index] - DAY for r in data))
            if index > 0:
                self.assertTrue(all(r["start"] >= boundaries[index - 1] for r in data))
        for invalid in (boundaries[:2], list(reversed(boundaries)), [1, 1, 2], [1., 2., 3.]):
            with self.assertRaisesRegex(ValueError, "boundaries"):
                split_rows(rows, boundaries=invalid)


class LiveTests(unittest.TestCase):
    def prematches(self):
        return prematch_rows([match(1, duration=1800)])

    def test_arrival_order_stale_duplicate_invalid_and_synthetic_packets(self):
        snapshots = [snapshot(1, 120, 150), snapshot(2, 360, 400, radiant_lead=4000, radiant_score=4),
                     snapshot(8, 180, 410, radiant_lead=90000),
                     snapshot(9, 480, 500, radiant_lead=None),
                     snapshot(3, 540, 570, radiant_lead=7000, radiant_score=7),
                     snapshot(10, 540, 580, radiant_lead=80000),
                     snapshot(11, 720, 750, source="backfill"),
                     snapshot(12, 720, 760, raw_payload={"source": "backfill"}),
                     snapshot(13, 720, 770, raw_payload={"synthetic": True}),
                     snapshot(14, 720, 2100), snapshot(15, 720, 2200)]
        rows = live_rows(list(reversed(snapshots)), self.prematches())
        self.assertEqual([r["snapshot_id"] for r in rows], [1, 2, 3])
        self.assertEqual(fingerprint(rows), fingerprint(live_rows(snapshots, self.prematches())))
        self.assertAlmostEqual(rows[-1]["base"][len(BASE_NAMES) + LIVE_NAMES.index("gold_change_per_minute")], 1)
        self.assertTrue(all(r["captured"] < r["label_available"] for r in rows))

    def test_first_arrival_per_bucket_not_best_later_state(self):
        rows = live_rows([snapshot(1, 120, 150), snapshot(2, 140, 160, radiant_lead=9000)], self.prematches())
        self.assertEqual([r["snapshot_id"] for r in rows], [1])
        self.assertEqual(rows[0]["base"][len(BASE_NAMES) + 1], 1)

    def test_adding_future_arrivals_preserves_all_prior_features(self):
        first = [snapshot(1, 120, 150), snapshot(2, 360, 400)]
        original = live_rows(first, self.prematches())
        future = snapshot(3, 540, 700, radiant_lead=-90000, radiant_score=99)
        self.assertEqual(fingerprint(original), fingerprint(live_rows([future] + first, self.prematches())[:2]))

    def test_draft_needs_observed_matching_heroes(self):
        good = snapshot(1, 120, 150)
        mismatch = snapshot(2, 360, 400)
        mismatch["raw_payload"]["players"][0]["hero_id"] = 99
        absent = snapshot(3, 540, 570, raw_payload={})
        rows = live_rows([good, mismatch, absent], self.prematches())
        self.assertIsNotNone(rows[0]["draft"])
        self.assertIsNone(rows[1]["draft"])
        self.assertIsNone(rows[2]["draft"])
        self.assertTrue(math.isnan(rows[2]["base"][-1]))  # absent delay is not observed zero

    def test_v2_feature_names_dimensions_and_indices_exclude_unverified_towers(self):
        early = snapshot(1, 360, 400, radiant_lead=4000, radiant_score=4)
        later = snapshot(2, 540, 570, radiant_lead=7000, radiant_score=7)
        later["raw_payload"]["delay"] = 30
        row = live_rows([early, later], self.prematches())[-1]
        self.assertEqual(len(LIVE_NAMES), 10)
        self.assertEqual(len(row["base"]), len(BASE_NAMES) + len(LIVE_NAMES))
        self.assertEqual(len(row["draft"]), len(BASE_NAMES) + len(DRAFT_NAMES) + len(LIVE_NAMES))
        self.assertTrue(set(LIVE_NAMES).isdisjoint(UNSUPPORTED_LIVE_FEATURES))
        expected = {"game_minutes": 9, "gold_lead_k": 7, "kill_diff": 7, "total_kills": 7,
                    "kills_per_minute": 7 / 9, "gold_change_per_minute": 1,
                    "kill_change_per_minute": 1, "trajectory_gap_minutes": 3,
                    "draft_observed": 1, "provider_delay_seconds": 30}
        self.assertEqual(dict(zip(LIVE_NAMES, row["base"][len(BASE_NAMES):])), expected)
        later["building_state"] = 33490943
        self.assertEqual(fingerprint(row), fingerprint(live_rows([early, later], self.prematches())[-1]))


if __name__ == "__main__":
    unittest.main()
