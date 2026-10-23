"""Scoring and candidate-persistence fixtures; no training or database calls."""
import base64
import argparse
import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

import numpy as np

from .evaluation import (bootstrap_delta, grouped_metrics, grouped_regression_metrics,
                         reliability)


class EvaluationTests(unittest.TestCase):
    def test_live_macro_does_not_overweight_repeated_map_frames(self):
        rows = [{"match_id": 1, "group": "s1"}] * 10 + [{"match_id": 2, "group": "s2"}]
        p, y = np.array([0.] * 10 + [0.]), np.array([0.] * 10 + [1.])
        result = grouped_metrics(p, y, rows)
        self.assertEqual(result["brier"], .5)
        self.assertEqual(result["accuracy"], .5)
        self.assertAlmostEqual(result["log_loss"], -np.log(1e-9) / 2, places=7)

    def test_bootstrap_equal_maps_within_series_and_reproducible(self):
        rows = ([{"match_id": 1, "group": "s1"}] * 10
                + [{"match_id": 2, "group": "s1"}, {"match_id": 3, "group": "s2"}])
        p, b, y = np.array([.6] * 10 + [0., .5]), np.full(12, .5), np.zeros(12)
        result = bootstrap_delta(p, b, y, rows)
        self.assertAlmostEqual(result["mean_series_delta_brier"], -.035)
        self.assertEqual(result, bootstrap_delta(p, b, y, rows))
        short_rows = [rows[0], rows[-2], rows[-1]]
        short = bootstrap_delta(np.array([.6, 0, .5]), np.full(3, .5), np.zeros(3), short_rows)
        for key in ("mean_series_delta_brier", "lower95", "upper95"):
            self.assertAlmostEqual(result[key], short[key])

    def test_reliability_uses_equal_map_weight(self):
        rows = [{"match_id": 1}] * 4 + [{"match_id": 2}]
        result = reliability(np.full(5, .5), np.array([0, 0, 0, 0, 1]), rows)
        self.assertEqual(result[0]["observed_rate"], .5)
        self.assertEqual(result[0]["weight"], 2)
        self.assertEqual(result[0]["matches"], 2)

    def test_regression_macro_has_natural_units_without_per_map_r2(self):
        rows = [{"match_id": 1}] * 4 + [{"match_id": 2}]
        p, y = np.log1p([1, 1, 1, 1, 3]), np.zeros(5)
        result = grouped_regression_metrics(p, y, rows, "log1p")
        self.assertAlmostEqual(result["natural_rmse"], np.sqrt(5))
        self.assertEqual(result["natural_mae"], 2)
        self.assertNotIn("r2", result)


class CandidateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Suppress the application's fallback token-file side effect on import.
        os.environ.setdefault("ML_SERVICE_TOKEN", "fixture-only-not-a-service-token")
        from . import run_audit_training
        cls.runner = run_audit_training

    def test_candidate_is_insert_only_and_explicitly_ineligible(self):
        response = SimpleNamespace(blob_b64=base64.b64encode(b"fixture").decode(),
            task_type="classification", feature_names=["x"],
            train_metrics=SimpleNamespace(accuracy=.5, n=80),
            test_metrics_calibrated=SimpleNamespace(accuracy=.5, brier=.25, n=20),
            model_dump=lambda **kwargs: {"task_type": "classification"})
        connection = Mock()
        connection.execute.return_value.fetchone.return_value = {"id": 101}
        result = self.runner.save_candidate(connection, response,
            {"source_revision": "fixture", "target_transform": "identity"},
            101, "prematch_winner", "base", "test")
        self.assertEqual(result, 101)
        connection.execute.assert_called_once()
        query, params = connection.execute.call_args.args
        self.assertTrue(query.lstrip().startswith("INSERT INTO model_versions"))
        self.assertRegex(query, r"%s,false\) RETURNING id")
        self.assertNotRegex(query.upper(), r"\b(UPDATE|DELETE|DROP|TRUNCATE)\b")
        metadata = params[-1].obj
        self.assertFalse(metadata["eligibleForServing"])
        self.assertFalse(metadata["eligibleForPromotion"])
        self.assertEqual(metadata["validationStatus"], "research_candidate")

    def test_loader_calls_strict_extractor_without_retaining_player_evidence(self):
        row = {"match_id": 1,
               "first_blood_objectives": [{"type": "CHAT_MESSAGE_FIRSTBLOOD", "player_slot": 128, "slot": 5, "time": -1}],
               "first_blood_players": [{"player_slot": 128, "kills_log": [{"time": -1}]}]}
        ordinary, stream = Mock(), Mock()
        ordinary.execute.return_value.fetchall.return_value = []
        stream.fetchmany.side_effect = [[row], []]
        connection = Mock()
        def cursor(**kwargs):
            context = Mock()
            context.__enter__ = Mock(return_value=stream if kwargs.get("name") else ordinary)
            context.__exit__ = Mock(return_value=False)
            return context
        connection.cursor.side_effect = cursor
        matches, snapshots, active = self.runner.load_data(connection)
        self.assertEqual(matches, [{"match_id": 1, "first_blood_label": 0}])
        self.assertEqual((snapshots, active), ([], []))
        self.assertEqual(stream.fetchmany.call_args.args, (256,))

    def test_explicit_live_calendar_boundaries_and_dataset_selection(self):
        from datetime import datetime, timezone
        result = self.runner.parse_live_boundaries("2026-05-21,2026-05-26,2026-05-29")
        self.assertEqual(result, [int(datetime(2026, 5, day, tzinfo=timezone.utc).timestamp()) for day in (21, 26, 29)])
        for value in ("2026-05-21,2026-05-21,2026-05-29", "2026-05-21,2026-05-26",
                      "2026-05-29,2026-05-26,2026-05-21", "2026-5-21,2026-05-26,2026-05-29",
                      "2026-05-21T12:00,2026-05-26,2026-05-29"):
            with self.assertRaises(argparse.ArgumentTypeError):
                self.runner.parse_live_boundaries(value)
        prematch, live = [object()], [object()]
        self.assertEqual(self.runner.requested_datasets("live", prematch, live), [("live", live)])
        self.assertEqual(self.runner.requested_datasets("prematch", prematch, live), [("prematch", prematch)])
        self.assertEqual(len(self.runner.requested_datasets("all", prematch, live)), 2)


if __name__ == "__main__":
    unittest.main()
