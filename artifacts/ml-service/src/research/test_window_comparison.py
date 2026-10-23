"""Fixtures only: no database, provider calls or model fitting."""
from copy import deepcopy
import unittest

import numpy as np

from .causal_dataset import DAY
from .run_window_comparison import (window_train, common_splits, assert_disjoint,
                                   select_windows, paired_intervals, research_flags)


def row(i, start, group=None, roster=True):
    return {"match_id": i, "group": group or f"series:{i}", "start": start,
            "label_available": start + 900, "latest_feature_outcome": start - 1,
            "base": [0, .5], "roster": [0, .5, 1] if roster else None, "winner": i % 2}


class WindowTests(unittest.TestCase):
    def test_lower_boundary_excludes_whole_series_even_if_old_map_has_no_roster(self):
        cutoff = 400 * DAY
        rows = [row(1, cutoff - 30 * DAY - 1, "cross", False),
                row(2, cutoff - 30 * DAY + 1000, "cross"),
                row(3, cutoff - 30 * DAY, "inside"), row(4, cutoff - 900, "late")]
        common = [r for r in rows if r["roster"] is not None]
        self.assertEqual([r["match_id"] for r in window_train(common, rows, cutoff, 30)], [3])
        self.assertEqual([r["match_id"] for r in window_train(common, rows, cutoff, 90)], [2, 3])

    def test_windows_are_nested_and_do_not_recompute_features(self):
        rows = [row(i, i * DAY) for i in range(1, 400)]
        selected = [window_train(rows, rows, 400 * DAY, days) for days in (30, 90, 180, 365)]
        for short, long in zip(selected, selected[1:]):
            self.assertLess({r["match_id"] for r in short}, {r["match_id"] for r in long})
        self.assertIs(selected[0][-1], rows[-1])

    def test_split_before_roster_filter_purges_crossing_group(self):
        rows = [row(i, i * DAY) for i in range(1, 41)]
        rows[9]["group"] = "cross"
        rows[10]["group"] = "cross"
        rows[10]["roster"] = None
        common, complete, manifest = common_splits(rows, [11 * DAY, 21 * DAY, 31 * DAY])
        self.assertIn("cross", manifest["purged_group_ids"])
        self.assertFalse(any(r["group"] == "cross" for data in common.values() for r in data))
        self.assertTrue(all(r["roster"] is not None for data in common.values() for r in data))

    def test_future_and_group_overlap_rejected(self):
        splits = {"train": [row(1, DAY)], "validation": [row(2, 3 * DAY)],
                  "calib": [row(3, 5 * DAY)], "test": [row(4, 7 * DAY)]}
        assert_disjoint(splits)
        bad = deepcopy(splits)
        bad["test"][0]["group"] = bad["train"][0]["group"]
        with self.assertRaises(ValueError):
            assert_disjoint(bad)
        bad = deepcopy(splits)
        bad["validation"][0]["latest_feature_outcome"] = bad["validation"][0]["start"]
        with self.assertRaises(ValueError):
            assert_disjoint(bad)

    def test_selection_uses_only_validation_and_fixed_tiebreaker(self):
        models = [{"view": view, "days": days, "validation": {"brier": brier, "log_loss": .6},
                   "test": {"brier": 0 if days == 365 else 1}}
                  for view in ("base", "roster") for days, brier in ((30, .2), (90, .2), (365, .3))]
        self.assertEqual(select_windows(models), {"base": 30, "roster": 30})
        altered = deepcopy(models)
        for model in altered:
            model["test"] = {"brier": 1000 * model["days"], "labels": [0, 1, 0]}
        self.assertEqual(select_windows(models), select_windows(altered))

    def test_paired_bootstrap_uses_map_estimand_with_unequal_series(self):
        rows = [row(1, DAY, "a"), row(2, 2 * DAY, "a"), row(3, 3 * DAY, "b")]
        p, b, y = np.array([.9, .9, .1]), np.full(3, .5), np.ones(3)
        result = paired_intervals(p, b, y, rows, replicates=100)
        self.assertAlmostEqual(result["brier"]["delta"], float(np.mean((p - y) ** 2 - (b - y) ** 2)))
        zero = paired_intervals(p, p, y, rows, replicates=100)
        for metric in ("brier", "log_loss", "accuracy"):
            self.assertEqual(zero[metric], {"delta": 0.0, "lower95": 0.0, "upper95": 0.0})

    def test_candidates_cannot_serve_or_promote(self):
        flags = research_flags()
        self.assertFalse(flags["active"])
        self.assertFalse(flags["eligibleForServing"])
        self.assertFalse(flags["eligibleForPromotion"])
        self.assertIn("prospective_confirmation_required", flags["blockers"])


if __name__ == "__main__":
    unittest.main()
