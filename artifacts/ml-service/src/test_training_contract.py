import os
os.environ.setdefault("ML_SERVICE_TOKEN", "unit-test-token-not-for-runtime")
import unittest
import numpy as np
from fastapi import HTTPException
from .main import TrainRequest, TrainSample, train, _deserialize_bundle, _reg_metrics
import base64

class TrainingContractTests(unittest.TestCase):
    def request(self, **kwargs):
        rng = np.random.default_rng(3)
        samples = [TrainSample(features=[float(x)], label=int(x > 0)) for x in rng.normal(size=140)]
        return TrainRequest(label="unit", feature_names=["x"], train=samples[:80],
                            validation=samples[80:100], calib=samples[100:120], test=samples[120:],
                            n_estimators=20, min_data_in_leaf=5, **kwargs)

    def test_calibration_does_not_select_stopping_iteration(self):
        req = self.request()
        a = train(req)
        for row in req.calib:
            row.label = 1 - row.label
        b = train(req)
        ma = _deserialize_bundle(base64.b64decode(a.blob_b64))["model"]
        mb = _deserialize_bundle(base64.b64decode(b.blob_b64))["model"]
        self.assertEqual(ma.booster_.model_to_string(), mb.booster_.model_to_string())

    def test_small_calibration_is_identity_even_when_requested(self):
        response = train(self.request(calibration="isotonic"))
        self.assertIsNone(_deserialize_bundle(base64.b64decode(response.blob_b64))["calibrator"])

    def test_invalid_nontrain_dimensions_and_fractional_labels_rejected(self):
        req = self.request()
        req.test[0].features = [1, 2]
        with self.assertRaises(HTTPException): train(req)
        req = self.request()
        req.calib[0].label = .4
        with self.assertRaises(HTTPException): train(req)

    def test_regression_metrics_preserve_units_and_quantile_objective(self):
        result = _reg_metrics(np.log([10, 30]), np.log([20, 20]), "log", .25)
        self.assertAlmostEqual(result.natural_mae, 10)
        self.assertAlmostEqual(result.natural_rmse, 10)
        self.assertAlmostEqual(result.quantile_coverage, .5)
        self.assertGreater(result.pinball, 0)
        self.assertEqual(result.metric_type, "quantile")

if __name__ == "__main__":
    unittest.main()
